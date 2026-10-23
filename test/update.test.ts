// update.test.ts — one release check for every installed component (CTC-6708), through the
// coordinator with a fake image engine and real files: one approval read, every component decided
// on its own, holds that keep only their component, a check that changes nothing, and an apply
// that moves the images while naming the command for the rest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalCachePathFor } from "../src/approved-release";
import { readReleaseState, type RunnerUpdateEngine } from "../src/runner-update";
import { runUpdate, updateReportJson, updateReportLines, type UpdateOptions } from "../src/update";
import { setComponentPolicy, updatePolicyPathFor } from "../src/update-policy";
import { makeCtx, seedReplica, seedWriterState, tempHome } from "./helpers";
import {
  answered,
  approved,
  CLI_VERSION,
  cloudPack,
  countingEngine,
  hostRelease,
  memberFetch,
  NEXT,
  OLD,
  ref,
  runnerInstall,
  sdkProject,
  signIn,
  TRAIN,
} from "./update-fixtures";

const noDocker = (): RunnerUpdateEngine => {
  throw new Error("a machine with no runner installation must not reach Docker");
};

function hostCase(over: { components?: unknown } = {}) {
  const home = tempHome();
  const dir = runnerInstall();
  const engine = countingEngine(answered(hostRelease({ components: "components" in over ? over.components : approved() })), {
    supervisor: ref("supervisor", "8"),
    watchdog: ref("watchdog", "9"),
  });
  const skills = cloudPack(OLD);
  const ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", CATALYST_SKILLS_CLAUDE_DIR: skills } });
  const options = (mode: UpdateOptions["mode"], extra: Partial<UpdateOptions> = {}): UpdateOptions => ({ mode, imagesDir: dir, engine: () => engine, ...extra });
  return { home, dir, engine, ctx, options };
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

describe("the release check lists every component against the approved release", () => {
  it("POSITIVE CONTROL: one host read reports images, CLI, packs, replica and a project's SDK, and changes nothing", async () => {
    const { home, dir, engine, ctx, options } = hostCase();
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const project = sdkProject(OLD);
    const before = { runner: snapshot(dir), project: snapshot(project) };

    const report = await runUpdate(ctx, options("check", { project }));

    expect(engine.calls).toEqual({ desiredRelease: 1 });
    // Columns are 19, 16 and 16 wide; a longer value keeps one space after it.
    const col = (text: string, width: number) => (text.length >= width ? `${text} ` : text.padEnd(width));
    const pad = (a: string, b: string, c: string, d: string) => `${col(a, 19)}${col(b, 16)}${col(c, 16)}${d}`;
    expect(updateReportLines(report)).toEqual([
      `Approved release: example-89, generation 89, train ${TRAIN}`,
      pad("Component", "Installed", "Approved", "Status"),
      pad("Runner", "generation 88", "generation 89", "update available"),
      pad("Supervisor", "generation 88", "generation 89", "update available"),
      pad("Watchdog", "generation 88", "generation 89", "update available"),
      pad("CLI", CLI_VERSION, NEXT, "update available"),
      pad("Cloud skills", OLD, NEXT, "update available"),
      pad("Dev skills", "-", NEXT, "not installed"),
      pad("Local replica", OLD, NEXT, "restart after CLI update"),
      pad(`SDK ${project}`, OLD, NEXT, "notification only"),
      `CLI: this CLI does not install ${NEXT} by itself yet. Run: npm install -g @catalyst-cloud/cli@${NEXT}`,
      `Cloud skills: this CLI does not install ${NEXT} by itself yet. Run: npx skills add https://github.com/coalesce-labs/catalyst-cloud-skills/tree/${"1".repeat(40)} --all -g`,
      `Update this project's SDK: cd ${project} && npm install --save-exact @catalyst-cloud/sdk@${NEXT}`,
      "Checked the approved release; nothing was changed.",
    ]);
    expect(report.exitCode).toBe(0);
    // A check writes no settings, no cache, no runner file and no project file.
    expect(existsSync(updatePolicyPathFor(home))).toBe(false);
    expect(existsSync(approvalCachePathFor(home))).toBe(false);
    expect(snapshot(dir)).toEqual(before.runner);
    expect(snapshot(project)).toEqual(before.project);
  });

  it("--json carries full digests, every component, and the project with its command", async () => {
    const { ctx, options } = hostCase();
    const json = updateReportJson(await runUpdate(ctx, options("check")));
    expect(json).toMatchObject({ schemaVersion: 1, mode: "check", release: { id: "example-89", generation: 89, releaseLine: TRAIN, source: "host" }, projects: [] });
    const components = json.components as { id: string; installedReference?: string; approvedReference?: string; status: string }[];
    expect(components.map((c) => c.id)).toEqual(["runner", "supervisor", "watchdog", "cli", "skills-cloud", "skills-dev", "replica"]);
    expect(components[1]).toMatchObject({ installedReference: ref("supervisor", "8"), approvedReference: ref("supervisor", "2") });
    expect(components[6]).toMatchObject({ status: "not_installed", reason: "not_installed" });
  });

  it("a CLI-only install reads the member route once and never reaches Docker", async () => {
    const home = tempHome();
    signIn(home);
    const fetchImpl = memberFetch(200, { ok: true, release: approved() });
    const ctx = makeCtx(home, { fetch: fetchImpl });
    const report = await runUpdate(ctx, { mode: "check", imagesDir: join(home, "no-runner"), engine: noDocker });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(report.components.slice(0, 3).map((c) => c.status)).toEqual(["not_installed", "not_installed", "not_installed"]);
    expect(report.components[3]).toMatchObject({ id: "cli", installed: CLI_VERSION, approved: NEXT, status: "update_available" });
    expect(updateReportLines(report)).toContain("SDK projects: none registered");
  });
});

describe("an owner's hold keeps only its own component", () => {
  it("a CLI hold: the CLI row says held, the replica waits for that CLI, images and packs still move", async () => {
    const { home, ctx, options, engine } = hostCase();
    setComponentPolicy(home, "cli", false);
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const report = await runUpdate(ctx, options("apply"));
    const byId = Object.fromEntries(report.components.map((c) => [c.id, c]));
    expect(byId.cli).toMatchObject({ installed: CLI_VERSION, approved: NEXT, policy: "off", policySource: "owner", status: "held", reason: "owner_setting", action: null });
    expect(byId.replica).toMatchObject({ status: "waiting_for_cli", reason: "dependency_held" });
    expect(byId.runner).toMatchObject({ status: "updated", installed: "generation 89" });
    expect(byId["skills-cloud"]).toMatchObject({ status: "update_available", policy: "on" });
    expect(engine.calls.composeUp).toBeGreaterThan(0);
    const lines = updateReportLines(report);
    expect(lines.find((l) => l.startsWith("CLI "))).toContain("held by owner's setting");
    expect(lines.find((l) => l.startsWith("Local replica"))).toContain(`waiting for CLI ${NEXT}`);
  });

  it("a held supervisor keeps all three images, and lifting it converges at the same generation", async () => {
    const { home, dir, ctx, options, engine } = hostCase();
    setComponentPolicy(home, "supervisor", false);
    const held = await runUpdate(ctx, options("apply"));
    expect(held.components.slice(0, 3).map((c) => [c.id, c.status, c.reason])).toEqual([
      ["runner", "held", "peer_image_held"],
      ["supervisor", "held", "owner_setting"],
      ["watchdog", "held", "peer_image_held"],
    ]);
    expect(engine.calls.composeUp).toBeUndefined();
    expect(readReleaseState(dir).generation).toBe(88);

    setComponentPolicy(home, "supervisor", true);
    const lifted = await runUpdate(ctx, options("apply"));
    expect(lifted.components.slice(0, 3).map((c) => c.status)).toEqual(["updated", "updated", "updated"]);
    expect(readReleaseState(dir).generation).toBe(89);
    // The same generation again: verified, current, nothing pending.
    const again = await runUpdate(ctx, options("check"));
    expect(again.components.slice(0, 3).map((c) => c.status)).toEqual(["current", "current", "current"]);
  });

  it("an applying run records the approval for diagnostics; a check never does", async () => {
    const { home, ctx, options } = hostCase();
    await runUpdate(ctx, options("check"));
    expect(existsSync(approvalCachePathFor(home))).toBe(false);
    await runUpdate(ctx, options("apply"));
    expect(existsSync(approvalCachePathFor(home))).toBe(true);
  });
});

describe("when the approval cannot be used, nothing moves", () => {
  it("signed out, CLI only: says to sign in and exits 1", async () => {
    const report = await runUpdate(makeCtx(tempHome()), { mode: "check", imagesDir: "/nonexistent-runner", engine: noDocker });
    expect(updateReportLines(report)).toEqual(["Approved release unavailable: sign in with catalyst login.", "Nothing was changed."]);
    expect(report.exitCode).toBe(1);
  });

  it("unreachable: names the last observed release and that it was not used", async () => {
    const { home, ctx, options } = hostCase();
    await runUpdate(ctx, options("apply"));
    signIn(home);
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const report = await runUpdate(makeCtx(home, { fetch: down }), { mode: "check", imagesDir: "/nonexistent-runner", engine: noDocker });
    expect(updateReportLines(report)).toEqual([
      "Approved release unavailable: the service could not be reached.",
      "Last observed release: example-89, generation 89. It was not used to apply updates.",
      "Nothing was changed.",
    ]);
    expect(report.exitCode).toBe(1);
  });

  it("a legacy host answer still checks the images, and every other target is unavailable", async () => {
    const { ctx, options } = hostCase({ components: undefined });
    const report = await runUpdate(ctx, options("check"));
    expect(report.components.slice(0, 3).map((c) => c.status)).toEqual(["update_available", "update_available", "update_available"]);
    expect(report.components.find((c) => c.id === "cli")).toMatchObject({ status: "approval_unavailable", reason: "not_provided", approved: null });
    expect(updateReportLines(report)[0]).toBe("Approved release unavailable: this workspace does not yet provide component versions.");
    expect(report.exitCode).toBe(0);
  });

  it("a release on another train is reported and nothing is applied", async () => {
    const other = approved({
      mutate: (r) => {
        r.releaseLine = "9.1";
        r.members = { cli: "9.1.0" };
        r.skills = {};
      },
    });
    const { ctx, options, engine } = hostCase({ components: other });
    const report = await runUpdate(ctx, options("apply"));
    expect(updateReportLines(report)).toContain(`Automatic updates stay on train ${TRAIN}. The approved release is on train 9.1; no components were changed.`);
    expect(report.components.find((c) => c.id === "cli")?.status).toBe("cross_train");
    expect(engine.calls.prepare).toBeUndefined();
    expect(engine.calls.composeUp).toBeUndefined();
  });

  it("an approved version older than the installed one is kept, never a downgrade", async () => {
    const older = approved({ mutate: (r) => ((r.members as Record<string, unknown>).cli = OLD) });
    const { ctx, options } = hostCase({ components: older });
    const report = await runUpdate(ctx, options("check"));
    expect(report.components.find((c) => c.id === "cli")).toMatchObject({ status: "installed_newer", action: null });
  });
});
