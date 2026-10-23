// update-newest.test.ts — the CLI's "newest version" answer is the approved release once this install
// has read one (CTC-6708): `ready` and the update notice name the approved version and
// `catalyst update`, with no npm request. An install that has never read an approved release keeps
// the npm lookup, labelled as the latest published version.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeApprovalCache, parseApprovedRelease } from "../src/approved-release";
import { CUSTOMER_SKILLS } from "../src/cli";
import { maybePrintPublishedUpdateNotice } from "../src/cli-update-notice";
import { defaultSkillsDirFor } from "../src/config";
import { newestCliVersion, REGISTRY_DIST_TAGS_URL } from "../src/published";
import { readyReport } from "../src/ready";
import { installSkills } from "../src/skills";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome } from "./helpers";
import { approved, CLI_VERSION, NEXT, OLD } from "./update-fixtures";

function recordApproval(home: string, mutate?: (r: Record<string, unknown>) => void): void {
  const parsed = parseApprovedRelease(approved({ ...(mutate ? { mutate } : {}) }));
  if (!parsed.ok) throw new Error("fixture must parse");
  writeApprovalCache(home, { observedAtMs: 1, release: parsed.release });
}

/** Real fetch for the fixture server; the npm registry is refused and counted. */
function noRegistry(): typeof fetch & { registryCalls: number } {
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === REGISTRY_DIST_TAGS_URL) {
      impl.registryCalls++;
      throw new Error("the npm registry must not be asked");
    }
    return fetch(input, init);
  };
  impl.registryCalls = 0;
  return impl as typeof fetch & { registryCalls: number };
}

describe("newestCliVersion", () => {
  it("POSITIVE CONTROL: an approved release this install read is the answer, with no npm request", async () => {
    const home = tempHome();
    recordApproval(home);
    const fetchImpl = noRegistry();
    expect(await newestCliVersion(makeCtx(home, { env: {}, fetch: fetchImpl }))).toEqual({ latest: NEXT, reason: null, source: "approved", skills: NEXT });
    expect(fetchImpl.registryCalls).toBe(0);
  });

  it("an install that never read an approved release keeps the npm lookup", async () => {
    const home = tempHome();
    const fetchImpl = (async () => new Response(JSON.stringify({ latest: "9.9.9" }), { status: 200 })) as typeof fetch;
    expect(await newestCliVersion(makeCtx(home, { env: {}, fetch: fetchImpl }))).toMatchObject({ latest: "9.9.9", source: "network" });
  });

  it("an approved release on another train is not the answer: the npm lookup is", async () => {
    const home = tempHome();
    recordApproval(home, (r) => {
      r.releaseLine = "9.1";
      r.members = { cli: "9.1.0" };
      r.skills = {};
    });
    const fetchImpl = (async () => new Response(JSON.stringify({ latest: "9.9.9" }), { status: 200 })) as typeof fetch;
    expect(await newestCliVersion(makeCtx(home, { env: {}, fetch: fetchImpl }))).toMatchObject({ latest: "9.9.9", source: "network" });
  });
});

describe("the update notice", () => {
  it("names the approved version and catalyst update, never npm latest", async () => {
    const home = tempHome();
    recordApproval(home);
    const ctx = makeCtx(home, { env: {}, fetch: noRegistry() });
    await maybePrintPublishedUpdateNotice(ctx, { interactive: true, json: false, command: "status", version: OLD });
    expect(ctx.err).toEqual([`Catalyst ${NEXT} is approved for this workspace. Update with: catalyst update`]);
  });

  it("never names catalyst update for an approved release on another train", async () => {
    const home = tempHome();
    recordApproval(home, (r) => {
      r.releaseLine = "9.1";
      r.members = { cli: "9.1.0" };
      r.skills = {};
    });
    const ctx = makeCtx(home, { env: {}, fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    await maybePrintPublishedUpdateNotice(ctx, { interactive: true, json: false, command: "status", version: OLD });
    expect(ctx.err.join("\n")).not.toContain("catalyst update");
  });
});

describe("ready", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startMeFixture();
  });
  afterAll(async () => {
    await server.close();
  });

  it("compares the CLI and the skills with the approved release and says to run catalyst update", async () => {
    const home = tempHome();
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    recordApproval(home);
    const fetchImpl = noRegistry();
    const report = await readyReport(makeCtx(home, { env: {}, fetch: fetchImpl }), { skillNames: CUSTOMER_SKILLS });
    const cli = report.checks.find((c) => c.id === "cliRelease");
    expect(cli?.line).toBe(`cliRelease: ${CLI_VERSION} installed is older than the approved ${NEXT} — update: catalyst update`);
    expect(report.checks.find((c) => c.id === "skillsRelease")?.line).toContain(`while the approved bundle is ${NEXT} — update: catalyst update`);
    expect(fetchImpl.registryCalls).toBe(0);
    expect(report.ready).toBe(true);
  });
});
