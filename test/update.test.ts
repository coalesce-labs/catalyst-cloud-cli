// update.test.ts — one release check for every installed component (CTC-6708), through the
// coordinator with a fake image engine and real files: one approval read, every component decided
// on its own, holds that keep only their component, a check that changes nothing, and an apply
// that moves the images, the CLI and the replica while naming the command for the skills packs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalCachePathFor } from "../src/approved-release";
import { onboardStatePath } from "../src/onboard";
import { pendingRestartPathFor } from "../src/replica";
import { readReleaseState, type RunnerUpdateEngine } from "../src/runner-update";
import { runUpdate, updateReportJson, updateReportLines, type UpdateOptions } from "../src/update";
import { setComponentPolicy, setProjectSdkPolicy, updatePolicyPathFor } from "../src/update-policy";
import { makeCtx, seedReplica, seedWriterState, tempHome } from "./helpers";
import {
  answered,
  approved,
  CLI_VERSION,
  cloudPack,
  countingEngine,
  fakeCliApply,
  fakeNpm,
  fakePackApply,
  fakeReplicaRestart,
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
  // The CLI move and the replica restart have their own suites; here they only record their calls.
  const cliCalls: string[] = [];
  const replicaCalls: string[] = [];
  const packCalls: string[] = [];
  const options = (mode: UpdateOptions["mode"], extra: Partial<UpdateOptions> = {}): UpdateOptions => ({
    mode,
    imagesDir: dir,
    engine: () => engine,
    cliApply: fakeCliApply(cliCalls),
    replicaRestart: fakeReplicaRestart(replicaCalls),
    packApply: fakePackApply(packCalls),
    ...extra,
  });
  return { home, dir, engine, ctx, options, cliCalls, replicaCalls, packCalls };
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
      `Update this project's SDK: catalyst update sdk --project ${project}`,
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

describe("one applying release check moves the CLI, the Cloud pack and then the replica on that CLI", () => {
  it("POSITIVE CONTROL: the images, the CLI, the Cloud pack and a running replica all reach the approved release", async () => {
    const { home, ctx, options, engine, cliCalls, replicaCalls, packCalls } = hostCase();
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const report = await runUpdate(ctx, options("apply"));
    const byId = Object.fromEntries(report.components.map((c) => [c.id, c]));
    expect(byId.runner).toMatchObject({ status: "updated", installed: "generation 89" });
    expect(byId.cli).toMatchObject({ status: "updated", installed: NEXT, reason: "activated", action: null });
    expect(byId.replica).toMatchObject({ status: "updated", installed: NEXT, reason: "restarted" });
    expect(byId["skills-cloud"]).toMatchObject({ status: "updated", installed: NEXT, action: null });
    expect(report.exitCode).toBe(0);
    expect(packCalls).toEqual([NEXT]);
    expect(cliCalls).toEqual([NEXT]);
    expect(replicaCalls).toEqual([NEXT]);
    expect(engine.calls.composeUp).toBeGreaterThan(0);
    const lines = updateReportLines(report);
    expect(lines.some((l) => l.startsWith("CLI:"))).toBe(false);
    expect(lines.find((l) => l.startsWith("Local replica"))).toContain("updated");
  });

  it("a failed CLI move fails the run and leaves the replica on its code, waiting", async () => {
    const { home, ctx, options, replicaCalls } = hostCase();
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const report = await runUpdate(ctx, options("apply", { cliApply: fakeCliApply([], "failed") }));
    const byId = Object.fromEntries(report.components.map((c) => [c.id, c]));
    expect(byId.cli).toMatchObject({ status: "failed", reason: "install_failed", installed: CLI_VERSION });
    expect(byId.replica).toMatchObject({ status: "pending", reason: "cli_update_failed" });
    expect(replicaCalls).toEqual([]);
    expect(report.exitCode).toBe(1);
    expect(updateReportLines(report)).toContain(
      `CLI: the update to ${NEXT} failed (install_failed). You keep running ${CLI_VERSION}. The next release check tries again: within 15 minutes when automatic updates are on, or run catalyst update.`,
    );
  });

  it("a held replica keeps its code while the CLI moves; a check moves neither", async () => {
    const { home, ctx, options, cliCalls, replicaCalls } = hostCase();
    setComponentPolicy(home, "replica", false);
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    await runUpdate(ctx, options("check"));
    expect([cliCalls, replicaCalls]).toEqual([[], []]);
    const report = await runUpdate(ctx, options("apply"));
    expect(report.components.find((c) => c.id === "cli")).toMatchObject({ status: "updated" });
    expect(report.components.find((c) => c.id === "replica")).toMatchObject({ status: "held", reason: "owner_setting", installed: OLD });
    expect(replicaCalls).toEqual([]);
  });

  it("a replica an unfinished restart stopped is reported and started again; one its owner stopped stays stopped", async () => {
    const { home, ctx, options, replicaCalls } = hostCase();
    signIn(home);
    const dbPath = await seedReplica(home);
    seedWriterState(home, { version: OLD, pid: 2 ** 22 + 17 });
    const owners = await runUpdate(ctx, options("apply"));
    expect(owners.components.find((c) => c.id === "replica")).toMatchObject({ status: "stopped" });
    expect(replicaCalls).toEqual([]);
    writeFileSync(pendingRestartPathFor(home), JSON.stringify({ dbPath }));
    const check = await runUpdate(ctx, options("check"));
    expect(check.components.find((c) => c.id === "replica")).toMatchObject({ status: "pending", reason: "restart_interrupted" });
    expect(replicaCalls).toEqual([]);
    const report = await runUpdate(ctx, options("apply"));
    expect(report.components.find((c) => c.id === "replica")).toMatchObject({ status: "updated", installed: NEXT });
    expect(replicaCalls).toEqual([NEXT]);
  });

  it("a CLI already selected past the approved version is kept, and the replica is expected on the version that runs", async () => {
    const { home, ctx, options, replicaCalls } = hostCase();
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const newer = `${TRAIN}.99`;
    const cliApply = () => ({ outcome: "current" as const, detail: "installed_newer", version: newer });
    const report = await runUpdate(ctx, options("apply", { cliApply }));
    expect(report.components.find((c) => c.id === "cli")).toMatchObject({ status: "installed_newer", installed: newer });
    expect(replicaCalls).toEqual([newer]);
  });

  it("a Cloud pack an installer linked in is reported as owned elsewhere and does not fail the run", async () => {
    const { ctx, options } = hostCase();
    const report = await runUpdate(ctx, options("apply", { packApply: () => ({ outcome: "linked", detail: "installation_owner_unknown", version: null }) }));
    expect(report.components.find((c) => c.id === "skills-cloud")).toMatchObject({ status: "unknown", reason: "installation_owner_unknown" });
    expect(report.exitCode).toBe(0);
  });

  it("a replica that did not come back fails the run, so the next check tries again", async () => {
    const { home, ctx, options } = hostCase();
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const report = await runUpdate(ctx, options("apply", { replicaRestart: fakeReplicaRestart([], "failed") }));
    expect(report.components.find((c) => c.id === "replica")).toMatchObject({ status: "failed", reason: "stop_timeout", installed: OLD });
    expect(report.exitCode).toBe(1);
  });
});

describe("setup's daily update choice carries over as holds (migration)", () => {
  const journal = (home: string, dailyUpdate: unknown) => {
    mkdirSync(join(onboardStatePath(home), ".."), { recursive: true });
    writeFileSync(
      onboardStatePath(home),
      JSON.stringify({ schema: 1, runId: "saved", installer: null, cli: "0.14.0", tenant: "acct_fixture", account: "acct_fixture", membershipId: "m_1", baseUrl: "https://cloud.example.test", exit: null, changes: [], steps: [], dailyUpdate }),
    );
  };

  it("an owner who turned the daily update off keeps the CLI and both packs, and the images still move", async () => {
    const { home, ctx, options, cliCalls, packCalls } = hostCase();
    journal(home, { state: "off" });
    const report = await runUpdate(ctx, options("apply"));
    const byId = Object.fromEntries(report.components.map((c) => [c.id, c]));
    expect(byId.cli).toMatchObject({ status: "held", reason: "owner_setting", policy: "off", policySource: "migrated" });
    expect(byId["skills-cloud"]).toMatchObject({ status: "held", policySource: "migrated" });
    expect(byId.runner).toMatchObject({ status: "updated" });
    expect([cliCalls, packCalls]).toEqual([[], []]);
    // Nothing was written for it: the hold is read, never saved.
    expect(existsSync(updatePolicyPathFor(home))).toBe(false);
  });

  it("a setting the owner saved wins over it, and a daily update left on holds nothing", async () => {
    const { home, ctx, options, cliCalls } = hostCase();
    journal(home, { state: "off" });
    setComponentPolicy(home, "cli", true);
    expect((await runUpdate(ctx, options("apply"))).components.find((c) => c.id === "cli")).toMatchObject({ status: "updated", policySource: "owner" });
    expect(cliCalls).toEqual([NEXT]);
    const other = hostCase();
    journal(other.home, { state: "on" });
    expect((await runUpdate(other.ctx, other.options("check"))).components.find((c) => c.id === "cli")).toMatchObject({ status: "update_available", policySource: "default" });
  });
});

describe("an owner's hold keeps only its own component", () => {
  it("a CLI hold: the CLI row says held, the replica waits for that CLI, the images and the Cloud pack still move", async () => {
    const { home, ctx, options, engine, cliCalls, replicaCalls, packCalls } = hostCase();
    setComponentPolicy(home, "cli", false);
    signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    const report = await runUpdate(ctx, options("apply"));
    const byId = Object.fromEntries(report.components.map((c) => [c.id, c]));
    expect(byId.cli).toMatchObject({ installed: CLI_VERSION, approved: NEXT, policy: "off", policySource: "owner", status: "held", reason: "owner_setting", action: null });
    expect(byId.replica).toMatchObject({ status: "waiting_for_cli", reason: "dependency_held" });
    expect(byId.runner).toMatchObject({ status: "updated", installed: "generation 89" });
    expect(byId["skills-cloud"]).toMatchObject({ status: "updated", installed: NEXT, policy: "on" });
    expect(packCalls).toEqual([NEXT]);
    expect(engine.calls.composeUp).toBeGreaterThan(0);
    expect(cliCalls).toEqual([]);
    expect(replicaCalls).toEqual([]);
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

describe("a project's SDK changes only with its owner's say-so", () => {
  it("POSITIVE CONTROL: an applying run leaves a notify-only project's bytes alone and updates an opted-in one", async () => {
    const { home, ctx, options } = hostCase();
    const notify = sdkProject(OLD);
    const auto = sdkProject(OLD);
    setProjectSdkPolicy(home, notify, "notify");
    const registered = setProjectSdkPolicy(home, auto, "auto");
    const before = snapshot(notify);
    const calls: string[][] = [];

    const report = await runUpdate(ctx, options("apply", { sdkExec: fakeNpm(calls) }));

    expect(snapshot(notify)).toEqual(before);
    expect(calls).toEqual([["npm", "install", "--save-exact", `@catalyst-cloud/sdk@${NEXT}`]]);
    const byPath = Object.fromEntries(report.projects.map((p) => [p.path, p]));
    expect(byPath[registered.path]).toMatchObject({ status: "current", applied: { outcome: "updated", moved: [{ from: OLD, to: NEXT }] } });
    const lines = updateReportLines(report);
    expect(lines.filter((l) => l.startsWith("Update this project's SDK:"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith(`SDK ${registered.path}`))).toContain("updated");
  });

  it("a check never runs the package manager, even for an opted-in project", async () => {
    const { home, ctx, options } = hostCase();
    const auto = sdkProject(OLD);
    setProjectSdkPolicy(home, auto, "auto");
    const calls: string[][] = [];
    const report = await runUpdate(ctx, options("check", { sdkExec: fakeNpm(calls) }));
    expect(calls).toEqual([]);
    expect(report.projects[0]).toMatchObject({ status: "update_available", applied: null });
  });
});

describe("a runner that cannot read its release (review fix)", () => {
  it("falls back to the signed-in member route instead of saying to sign in", async () => {
    const home = tempHome();
    signIn(home);
    const fetchImpl = memberFetch(200, { ok: true, release: approved() });
    const engine = countingEngine({ kind: "no_credential" });
    const report = await runUpdate(makeCtx(home, { fetch: fetchImpl }), { mode: "check", imagesDir: runnerInstall(), engine: () => engine });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(report.release).toMatchObject({ id: "example-89", source: "network" });
    expect(report.components.find((c) => c.id === "cli")).toMatchObject({ approved: NEXT, status: "update_available" });
    expect(report.components[0]).toMatchObject({ status: "approval_unavailable" });
  });

  it("signed out too, it names the runner's read, not sign-in", async () => {
    const engine = countingEngine({ kind: "no_credential" });
    const report = await runUpdate(makeCtx(tempHome()), { mode: "check", imagesDir: runnerInstall(), engine: () => engine });
    expect(updateReportLines(report)[0]).toBe("Approved release unavailable: this machine's runner could not read it; check that Docker is running.");
  });
});

