// ready-runner-installation.test.ts — CTC-5931: a catalyst-host runner on this machine that fails an
// installation proof makes `ready` NOT READY, naming the proof; it is never a note. A machine with no
// runner gets no line, and Docker that cannot list containers only counts where setup installed one.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_SKILLS, main } from "../src/cli";
import { defaultSkillsDirFor } from "../src/config";
import { dockerRunnerEngine, localRunnerInstallation, type RunnerEngine } from "../src/onboard-runner";
import { readyReport } from "../src/ready";
import { installSkills } from "../src/skills";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
});

async function report(runner: Awaited<ReturnType<typeof localRunnerInstallation>>) {
  await seedJoined(home, server);
  installSkills(defaultSkillsDirFor(home), {});
  return readyReport(ctx, { skillNames: CUSTOMER_SKILLS, offline: true, runnerInstallation: async () => runner });
}

describe("ready and this machine's runner installation", () => {
  test("a runner that fails an installation proof is NOT READY and names the proof", async () => {
    const r = await report({ refused: "file_safety" });
    const check = r.checks.find(c => c.id === "runner:installation");
    expect(check).toMatchObject({ ok: false, who: "you" });
    expect(check?.note).toBeUndefined();
    expect(check?.line).toBe("runner: setup could not verify this machine's catalyst-host installation: " +
      "its compose.yaml, .env or storage override has another owner or open permissions (file_safety)");
    expect(check?.fix).toContain("catalyst setup --runner");
    expect(r.ready).toBe(false);
  });

  test("the same machine is READY once its installation is verified", async () => {
    const r = await report({ verified: "/Users/person/.local/state/catalyst/runner" });
    expect(r.checks.find(c => c.id === "runner:installation")).toMatchObject({ ok: true,
      line: "runner: catalyst-host installation verified in /Users/person/.local/state/catalyst/runner" });
    expect(r.ready).toBe(true);
  });

  test("a machine without a runner gets no runner line", async () => {
    const r = await report(null);
    expect(r.checks.some(c => c.id === "runner:installation")).toBe(false);
    expect(r.ready).toBe(true);
  });

  test("the default path reads Docker, and a machine with no catalyst-host runner stays READY", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    // No seam: whatever Docker this test host has, a temporary home holds no setup-installed runner.
    const code = await main(["ready", "--offline"], ctx);
    const text = ctx.out.join("\n");
    expect(text).not.toMatch(/^FAIL {2}runner:/m);
    expect(code).toBe(0);
  });
});

describe("finding this machine's runner installation", () => {
  const engine = (answer: Awaited<ReturnType<NonNullable<RunnerEngine["installation"]>>> | Error) =>
    ({ installation: async () => { if (answer instanceof Error) throw answer; return answer; } });
  const setupInstalled = () => {
    const dir = join(home, "state", "runner");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), `CATALYST_SUPERVISOR_IMAGE=ghcr.io/x/supervisor@sha256:${"a".repeat(64)}\n`);
  };
  const local = (answer: Parameters<typeof engine>[0]) =>
    localRunnerInstallation({ home, env: { CATALYST_STATE_DIR: join(home, "state") } }, engine(answer));

  test("an adopted installation is verified, a missing one is no runner", async () => {
    expect(await local({ dir: "/r", hostName: "h", baseUrl: "https://x" })).toEqual({ verified: "/r" });
    expect(await local("missing")).toBeNull();
  });

  test("every named refusal is refused by that name", async () => {
    expect(await local("unverified:image")).toEqual({ refused: "image" });
    expect(await local("unverified:supervisor_ambiguous")).toEqual({ refused: "supervisor_ambiguous" });
    expect(await local("unverified")).toEqual({ refused: "engine_unreadable" });
  });

  test("Docker that cannot list containers counts only where setup installed a runner", async () => {
    expect(await local("unverified:engine_unavailable")).toBeNull();
    expect(await local(new Error("docker exploded"))).toBeNull();
    setupInstalled();
    expect(await local("unverified:engine_unavailable")).toEqual({ refused: "engine_unavailable" });
    expect(await local(new Error("docker exploded"))).toEqual({ refused: "engine_unavailable" });
  });

  test("a refusal stays a string, so a caller that reads any string as unverified still does", async () => {
    // CTC-5929's disk reader treats `typeof installed === "string"` as unverified; an object would
    // read as an installation with no folder.
    const twoSupervisors = dockerRunnerEngine({ exec: async args =>
      args[0] === "ps" ? { code: 0, stdout: "0123456789ab\nba9876543210" } : { code: 1, stdout: "" } });
    const refused = await twoSupervisors.installation!(home, `ghcr.io/x/supervisor@sha256:${"a".repeat(64)}`);
    expect(typeof refused).toBe("string");
    expect(refused).toBe("unverified:supervisor_ambiguous");
    const unlisted = dockerRunnerEngine({ exec: async () => ({ code: 1, stdout: "" }) });
    expect(await unlisted.installation!(home, `ghcr.io/x/supervisor@sha256:${"a".repeat(64)}`)).toBe("unverified:engine_unavailable");
  });
});
