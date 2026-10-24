import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import type { SchedulerRun } from "../src/runner-auto-update";
import type { RunnerUpdateEngine } from "../src/runner-update";
import { effectivePolicy, readUpdatePolicy } from "../src/update-policy";
import { makeCtx, tempHome } from "./helpers";

// `catalyst runner update` and `catalyst runner auto-update` through the real dispatcher, with the
// Docker engine and the scheduler injected, so the command's own output and exit codes are checked.

function install(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-cmd-"));
  writeFileSync(join(dir, ".env"), "CATALYST_SLOTS=1\n", { mode: 0o600 });
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  return dir;
}

/** An engine whose release read answers `status`; nothing else is reached for a retain. */
function engine(status: number, body: unknown = { ok: false, refusal: "release_unavailable" }): RunnerUpdateEngine {
  const unused = async (): Promise<never> => { throw new Error("not reached for a retain"); };
  return {
    desiredRelease: async () => ({ kind: "answered", status, body, hostId: "host_abc" }),
    attemptContainers: unused, prepare: unused, custody: unused, services: unused,
    stopSupervisor: unused, composeUp: unused, supervisorReadySinceStart: unused, removeImages: unused,
  };
}

describe("catalyst runner update", () => {
  it("POSITIVE CONTROL: --check says what it found in plain words and exits 0", async () => {
    const ctx = makeCtx(tempHome());
    const dir = install();
    expect(await main(["runner", "update", "--check", "--dir", dir], ctx, { runner: { engine: engine(503) } })).toBe(0);
    // The image result stays first; since CTC-6708 the component report follows from the same read.
    expect(ctx.out).toEqual([
      "Kept the current images.",
      "Release: none, generation none (release_unavailable).",
      "Approved release unavailable: this workspace does not yet provide component versions.",
      "Nothing was changed.",
    ]);
  });

  it("--check names a rolled-back last update between the image result and the component report (CTC-6709)", async () => {
    const ctx = makeCtx(tempHome());
    const dir = install();
    writeFileSync(join(dir, "release-state.json"), JSON.stringify({
      version: 1, generation: 105, releaseId: "hr-105", appliedAtMs: 1, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      last: { atMs: Date.UTC(2026, 9, 24, 4, 30), outcome: "rolled_back", detail: "supervisor_not_ready", generation: 106 },
    }));
    expect(await main(["runner", "update", "--check", "--dir", dir], ctx, { runner: { engine: engine(503) } })).toBe(0);
    // The release line reads the saved generation (105 here), so only its prefix is pinned.
    expect(ctx.out[0]).toBe("Kept the current images.");
    expect(ctx.out[1]).toMatch(/^Release: .*\(release_unavailable\)\.$/);
    expect(ctx.out[2]).toBe("The last update, at 2026-10-24T04:30:00.000Z, was rolled back (supervisor_not_ready; offered generation 106).");
  });

  it("--check --json carries the rolled-back last update as lastProblem, and null after a clean one", async () => {
    const write = (dir: string, outcome: string) => writeFileSync(join(dir, "release-state.json"), JSON.stringify({
      version: 1, generation: 105, releaseId: "hr-105", appliedAtMs: 1, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      last: { atMs: 1_800_000_000_000, outcome, detail: "supervisor_not_ready", generation: 106 },
    }));
    const bad = install();
    write(bad, "rolled_back");
    const ctx = makeCtx(tempHome());
    await main(["runner", "update", "--check", "--json", "--dir", bad], ctx, { runner: { engine: engine(503) } });
    expect(JSON.parse(ctx.out[0]!).lastProblem).toEqual({ atMs: 1_800_000_000_000, outcome: "rolled_back", detail: "supervisor_not_ready", generation: 106 });
    const good = install();
    write(good, "updated");
    const clean = makeCtx(tempHome());
    await main(["runner", "update", "--check", "--json", "--dir", good], clean, { runner: { engine: engine(503) } });
    expect(JSON.parse(clean.out[0]!).lastProblem).toBeNull();
  });

  it("--json prints the result object, and a revoked machine exits 1", async () => {
    const ctx = makeCtx(tempHome());
    const revoked = engine(401, { ok: false, refusal: "host_revoked", terminal: true });
    expect(await main(["runner", "update", "--json", "--dir", install()], ctx, { runner: { engine: revoked } })).toBe(1);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ outcome: "retained", detail: "credential_refused", exitCode: 1 });
  });

  it("--auto prints one timestamped line for the schedule's log", async () => {
    const ctx = makeCtx(tempHome(), { now: () => new Date("2026-10-17T13:30:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--dir", install()], ctx, { runner: { engine: engine(503) } })).toBe(0);
    expect(ctx.out).toEqual(["2026-10-17T13:30:00.000Z retained release_unavailable generation=none"]);
  });

  it("the schedule's run sends the previous run's outcome on its one release read, and --check sends none (CTC-6999)", async () => {
    const reports: Array<string | undefined> = [];
    const recording = (): RunnerUpdateEngine => {
      const base = engine(503);
      return { ...base, desiredRelease: async (dir, signal, report) => (reports.push(report), base.desiredRelease(dir, signal, report)) };
    };
    const dir = install();
    writeFileSync(join(dir, "release-state.json"), JSON.stringify({
      version: 1, generation: 112, releaseId: "hr-112", appliedAtMs: 1, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      last: { atMs: 1_800_000_000_000, outcome: "current", detail: "not_newer", generation: 112 },
    }));
    expect(await main(["runner", "update", "--auto", "--dir", dir], makeCtx(tempHome()), { runner: { engine: recording() } })).toBe(0);
    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0] ?? "")).toMatchObject({ v: 1, outcome: "current", detail: "not_newer", applied: 112, offered: 112, atMs: 1_800_000_000_000 });
    reports.length = 0;
    expect(await main(["runner", "update", "--check", "--dir", dir], makeCtx(tempHome()), { runner: { engine: recording() } })).toBe(0);
    expect(reports).toEqual([undefined]);
  });

  it("a machine with no runner installed fails and says so", async () => {
    const ctx = makeCtx(tempHome());
    const empty = mkdtempSync(join(tmpdir(), "runner-none-"));
    expect(await main(["runner", "update", "--dir", empty], ctx, { runner: { engine: engine(503) } })).toBe(1);
    expect(ctx.out[1]).toContain("runner_not_installed");
  });

  it.each([
    [["runner", "update", "--dir", "relative/path"]],
    [["runner", "rollback"]],
    [["runner", "update", "extra"]],
    [["runner", "stop", "--check"]],
    [["runner", "status", "--dir", "/tmp/runner"]],
    [["runner", "update", "--yes"]],
    [["runner", "auto-update", "off", "--delete-checkouts"]],
  ])("NEGATIVE: %j is a usage error", async (argv) => {
    const ctx = makeCtx(tempHome());
    expect(await main(argv, ctx, { runner: { engine: engine(503) } })).not.toBe(0);
  });
});

describe("catalyst runner auto-update", () => {
  const scheduler = (platform: NodeJS.Platform, run: SchedulerRun) => ({ platform, run, cli: "/usr/local/bin/catalyst", path: "/usr/bin:/bin" });

  it("status on a machine with no schedule says it is off and how to turn it on", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = () => ({ status: 1, stdout: "", stderr: "" });
    expect(await main(["runner", "auto-update", "status", "--dir", install()], ctx, { runner: { scheduler: scheduler("darwin", run) } })).toBe(0);
    expect(ctx.out[0]).toContain("catalyst runner auto-update on");
  });

  it("on, on Linux without a user manager, names the one fix and exits 1", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus" });
    expect(await main(["runner", "auto-update", "on", "--dir", install()], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(1);
    expect(ctx.out[0]).toContain("sudo loginctl enable-linger $USER");
  });

  it("on, on Linux where lingering could be turned on, says updates keep running after logout and names no sudo step", async () => {
    const ctx = makeCtx(tempHome());
    let linger = false;
    const run: SchedulerRun = (cmd, args) => {
      if (cmd === "loginctl" && args.includes("enable-linger")) linger = true;
      return { status: 0, stdout: cmd === "loginctl" ? `Linger=${linger ? "yes" : "no"}\n` : "", stderr: "" };
    };
    expect(await main(["runner", "auto-update", "on", "--dir", install()], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(ctx.out[0]).toContain("keeps checking after you log out");
    expect(ctx.out[0]).toContain("setup turned on lingering for you");
    expect(ctx.out[0]).toContain("loginctl disable-linger $USER");
    expect(ctx.out[0]).not.toContain("sudo");
  });

  it("on, on Linux where lingering was already on, says nothing about undoing it", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" });
    expect(await main(["runner", "auto-update", "on", "--dir", install()], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(ctx.out[0]).toContain("keeps checking after you log out");
    expect(ctx.out[0]).not.toContain("linger");
  });

  it("off, on Linux with lingering on, names the undo command and leaves lingering alone", async () => {
    const ctx = makeCtx(tempHome());
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" }; };
    expect(await main(["runner", "auto-update", "off"], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(ctx.out[0]).toContain("Lingering is still on for you");
    expect(ctx.out[0]).toContain("loginctl disable-linger $USER");
    expect(calls.some((c) => c.includes("disable-linger"))).toBe(false);
  });

  it("on, on Linux where lingering is refused, names the one sudo command and says updates stop at logout", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=no\n" : "", stderr: "" });
    expect(await main(["runner", "auto-update", "on", "--dir", install()], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(ctx.out[0]).toContain("stop when you log out");
    expect(ctx.out[0]!.match(/sudo loginctl enable-linger \$USER/g)).toHaveLength(1);
  });

  it("status on Linux carries the linger state in JSON", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" });
    await main(["runner", "auto-update", "on", "--dir", install()], makeCtx(ctx.home), { runner: { scheduler: scheduler("linux", run) } });
    expect(await main(["runner", "auto-update", "status", "--json"], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ state: "on", linger: true });
  });

  it("an unsupported platform says to run the update by hand, as JSON too", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = () => ({ status: 0, stdout: "", stderr: "" });
    expect(await main(["runner", "auto-update", "--json", "--dir", install()], ctx, { runner: { scheduler: scheduler("win32", run) } })).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ state: "unsupported", detail: "platform_win32", release: { version: 1, generation: null } });
  });

  it("off removes the schedule and exits 0", async () => {
    const ctx = makeCtx(tempHome());
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; };
    expect(await main(["runner", "auto-update", "off"], ctx, { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    expect(calls).toContain("systemctl --user disable --now catalyst-runner-update.timer");
  });

  it("an unknown mode is a usage error", async () => {
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = () => ({ status: 0, stdout: "", stderr: "" });
    expect(await main(["runner", "auto-update", "sometimes"], ctx, { runner: { scheduler: scheduler("linux", run) } })).not.toBe(0);
  });
  it("off holds the three images in the owner's update settings, on lifts them, and setup's call never does (CTC-6708)", async () => {
    const home = tempHome();
    const run: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" });
    expect(await main(["runner", "auto-update", "off"], makeCtx(home), { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    const held = readUpdatePolicy(home);
    for (const id of ["runner", "supervisor", "watchdog"] as const) expect(effectivePolicy(held, id)).toEqual({ enabled: false, source: "owner" });
    expect(effectivePolicy(held, "cli")).toEqual({ enabled: true, source: "default" });
    expect(await main(["runner", "auto-update", "on", "--dir", install()], makeCtx(home), { runner: { scheduler: scheduler("linux", run) } })).toBe(0);
    for (const id of ["runner", "supervisor", "watchdog"] as const) expect(effectivePolicy(readUpdatePolicy(home), id).enabled).toBe(true);
  });
});
