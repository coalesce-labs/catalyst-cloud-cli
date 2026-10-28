import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { main } from "../src/cli";
import type { SchedulerRun } from "../src/runner-auto-update";
import type { RunnerUpdateEngine } from "../src/runner-update";
import type { FleetUpdateEngine } from "../src/runner-update-fleet";
import { effectivePolicy, readUpdatePolicy, setComponentPolicy } from "../src/update-policy";
import { makeCtx, tempHome } from "./helpers";
import { answered, countingEngine, hostRelease, ref, runnerInstall } from "./update-fixtures";

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
    desiredRelease: async () => ({ kind: "answered", status, body, hostId: "host_abc" }), updateDrain: unused,
    attemptContainers: unused, prepare: unused, custody: unused, services: unused,
    stopSupervisor: unused, composeUp: unused, supervisorReadySinceStart: unused, removeImages: unused,
  };
}

const savedDrain = {
  requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", generation: 106, revision: 1,
  acknowledgedAtMs: 1_793_156_409_402, softLimitReported: false,
};

function drainEngine({ active = true, fail = false }: { active?: boolean; fail?: boolean } = {}) {
  const requests: string[] = [];
  const base = engine(503);
  const drain = { requestId: savedDrain.requestId, generation: 106, requestedAtMs: 1_793_156_409_000, admissionBlocked: true };
  const updateDrain: RunnerUpdateEngine["updateDrain"] = async (_dir, request) => {
    requests.push(request?.action ?? "get");
    if (fail) return { kind: "answered", status: 503, body: { ok: false, refusal: "update_drain_unavailable" }, hostId: "host_abc" };
    if (request?.action === "release") active = false;
    return { kind: "answered", status: 200, body: { ok: true, revision: active ? 1 : 2, drain: active ? drain : null, liveGenerations: 0 }, hostId: "host_abc" };
  };
  return { engine: { ...base, updateDrain }, requests };
}

function writeDrain(dir: string): void {
  writeFileSync(join(dir, "release-state.json"), JSON.stringify({
    version: 1, generation: 102, releaseId: "hr-102", appliedAtMs: 1,
    previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
    drain: savedDrain, deferral: { sinceMs: 1_793_070_000_000, offered: 106, offeredSinceMs: 1_793_070_004_112 }, last: null,
  }));
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
    expect(JSON.parse(ctx.out[0]!).lastProblem).toMatchObject({ atMs: 1_800_000_000_000, outcome: "rolled_back", detail: "supervisor_not_ready", generation: 106 });
    const good = install();
    write(good, "updated");
    const clean = makeCtx(tempHome());
    await main(["runner", "update", "--check", "--json", "--dir", good], clean, { runner: { engine: engine(503) } });
    expect(JSON.parse(clean.out[0]!).lastProblem).toBeNull();
  });

  it("--check names an acknowledged drain, and --check --json carries the drain and deferral without changing them", async () => {
    const dir = install();
    writeDrain(dir);
    const before = readFileSync(join(dir, "release-state.json"), "utf8");
    const plain = makeCtx(tempHome());
    expect(await main(["runner", "update", "--check", "--dir", dir], plain, { runner: { engine: engine(503) } })).toBe(0);
    expect(plain.out.some((line) => line.includes("no new phases since") && line.includes("generation 106"))).toBe(true);
    const json = makeCtx(tempHome());
    expect(await main(["runner", "update", "--check", "--json", "--dir", dir], json, { runner: { engine: engine(503) } })).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({
      drain: { generation: 106, acknowledgedAtMs: savedDrain.acknowledgedAtMs },
      deferral: { offered: 106, offeredSinceMs: 1_793_070_004_112 },
    });
    expect(readFileSync(join(dir, "release-state.json"), "utf8")).toBe(before);
    const empty = makeCtx(tempHome());
    await main(["runner", "update", "--check", "--json", "--dir", install()], empty, { runner: { engine: engine(503) } });
    expect(JSON.parse(empty.out[0]!).drain).toBeNull();
  });

  it("an owner's image hold releases an existing drain before the automatic retained result", async () => {
    const home = tempHome();
    const dir = install();
    writeDrain(dir);
    setComponentPolicy(home, "runner", false);
    const fake = drainEngine();
    const ctx = makeCtx(home, { now: () => new Date("2026-10-28T03:00:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--dir", dir], ctx, { runner: { engine: fake.engine } })).toBe(0);
    expect(fake.requests).toContain("release");
    expect(ctx.out[0]).toBe("2026-10-28T03:00:00.000Z retained owner_setting generation=102");
    const noRecord = drainEngine();
    const noDrain = install();
    writeFileSync(join(noDrain, "release-state.json"), JSON.stringify({
      version: 1, generation: 102, releaseId: "hr-102", appliedAtMs: 1, previous: null,
      journal: null, pendingRemoval: [], windowSettledMs: null, drain: null,
      deferral: { sinceMs: 1_793_070_000_000, offered: 106, offeredSinceMs: 1_793_070_004_112 }, last: null,
    }));
    await main(["runner", "update", "--auto", "--dir", noDrain], makeCtx(home), { runner: { engine: noRecord.engine } });
    expect(noRecord.requests).toEqual([]);
    expect(JSON.parse(readFileSync(join(noDrain, "release-state.json"), "utf8")).deferral).toBeNull();
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

  it("--auto requests a drain after a day of busy deferrals, prints the waiting pass, then the final update", async () => {
    // The fake drain below was requested at a fixed instant, so the update's clock is pinned one second
    // after it. On the real clock the drain aged past DRAIN_SOFT_LIMIT_MS and reported drain_soft_limit (CTC-8259).
    const pinnedMs = 1_793_156_410_000;
    vi.useFakeTimers({ toFake: ["Date"], now: pinnedMs });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const dir = runnerInstall(["7", "8", "9"], 102);
    const approved = hostRelease({ generation: 106 });
    const base = countingEngine(answered(approved), { supervisor: ref("supervisor", "8"), watchdog: ref("watchdog", "9") });
    let active = false;
    let count = 0;
    let revision = 0;
    const requests: string[] = [];
    const fake: RunnerUpdateEngine = {
      ...base,
      attemptContainers: async () => (count++ === 0 ? 1 : 0),
      updateDrain: async (_dir, request) => {
        requests.push(request?.action ?? "get");
        if (request?.action === "request") { active = true; revision++; }
        if (request?.action === "release") { active = false; revision++; }
        return { kind: "answered", status: 200, body: {
          ok: true, revision, liveGenerations: 0,
          drain: active ? { requestId: savedDrain.requestId, generation: 106, requestedAtMs: 1_793_156_409_000, admissionBlocked: true } : null,
        }, hostId: "host_abc" };
      },
    };
    // The prior checks deferred for 25 hours, so the next automatic look has passed the 24-hour mark.
    writeFileSync(join(dir, "release-state.json"), JSON.stringify({
      version: 1, generation: 102, releaseId: "hr-102", appliedAtMs: 1, previous: null,
      journal: null, pendingRemoval: [], windowSettledMs: null, last: null,
      deferral: { sinceMs: pinnedMs - 25 * 3_600_000, offered: 106, offeredSinceMs: pinnedMs - 25 * 3_600_000 },
    }));
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--auto", "--dir", dir], ctx, { runner: { engine: fake } })).toBe(0);
    expect(requests).toContain("request");
    expect(requests).toContain("release");
    expect(ctx.out.some((line) => line.includes("draining_for_update"))).toBe(true);
    expect(ctx.out.some((line) => line.includes("updated") && line.includes("generation=106"))).toBe(true);
  });

  it("a person's update never requests a drain while phases run", async () => {
    const dir = runnerInstall(["7", "8", "9"], 102);
    const base = countingEngine(answered(hostRelease({ generation: 106 })));
    const requests: string[] = [];
    const fake: RunnerUpdateEngine = {
      ...base, attemptContainers: async () => 1,
      updateDrain: async (_dir, request) => {
        requests.push(request?.action ?? "get");
        return { kind: "answered", status: 200, body: { ok: true, revision: 0, drain: null, liveGenerations: 1 }, hostId: "host_abc" };
      },
    };
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--dir", dir], ctx, { runner: { engine: fake } })).toBe(0);
    expect(requests).not.toContain("request");
    expect(ctx.out[0]).toContain("waits for the next check");
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
    [["runner", "stop", "--fleet"]],
    [["runner", "status", "--fleet", "--dir", "/srv/catalyst/supervisor-fleet-config"]],
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

  it("off reads and releases a cloud drain even when release-state.json was lost", async () => {
    const dir = install();
    const fake = drainEngine();
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=no\n" : "", stderr: "" });
    expect(await main(["runner", "auto-update", "off", "--dir", dir, "--json"], ctx,
      { runner: { scheduler: scheduler("linux", run), engine: fake.engine } })).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ state: "off", updateDrain: "released" });
    expect(fake.requests).toContain("get");
    expect(fake.requests).toContain("release");
    const plain = makeCtx(tempHome());
    const another = drainEngine();
    expect(await main(["runner", "auto-update", "off", "--dir", dir], plain,
      { runner: { scheduler: scheduler("linux", run), engine: another.engine } })).toBe(0);
    expect(plain.out[1]).toContain("can send this machine new phases again");
  });

  it("off reports that a failed drain release can be retried", async () => {
    const dir = install();
    const fake = drainEngine({ fail: true });
    const ctx = makeCtx(tempHome());
    const run: SchedulerRun = () => ({ status: 0, stdout: "", stderr: "" });
    expect(await main(["runner", "auto-update", "off", "--dir", dir], ctx,
      { runner: { scheduler: scheduler("linux", run), engine: fake.engine } })).toBe(0);
    expect(ctx.out[1]).toContain("Run catalyst runner auto-update off again to retry");
    expect(fake.requests).toContain("get");
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

  // CTC-6384: a supervisor fleet host schedules `runner update --auto --fleet --dir <the directory that holds compose.json>`.
  const fleetDir = "/srv/catalyst/supervisor-fleet-config";
  const lingers: SchedulerRun = (cmd) => ({ status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" });
  const service = (home: string) => join(home, ".config", "systemd", "user", "catalyst-runner-update.service");
  const onLine = "Automatic runner updates are on: this machine checks for an approved release every 15 minutes, and keeps checking after you log out.";

  it("on --fleet --dir schedules the fleet update, and status names the fleet and its directory, as text and JSON (CTC-6384)", async () => {
    const home = tempHome();
    const on = makeCtx(home);
    expect(await main(["runner", "auto-update", "on", "--fleet", "--dir", fleetDir], on, { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    expect(readFileSync(service(home), "utf8")).toContain(`ExecStart="/usr/local/bin/catalyst" "runner" "update" "--auto" "--fleet" "--dir" "${fleetDir}"`);
    expect(on.out).toEqual([onLine, `This is a supervisor fleet's schedule: it updates the compose.json in ${fleetDir}.`]);
    const text = makeCtx(home);
    expect(await main(["runner", "auto-update", "status"], text, { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    expect(text.out).toEqual([onLine, `This is a supervisor fleet's schedule: it updates the compose.json in ${fleetDir}.`]);
    const json = makeCtx(home);
    expect(await main(["runner", "auto-update", "status", "--json"], json, { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ state: "on", detail: "timer_enabled", linger: true, fleet: true, dir: fleetDir });
  });

  it("POSITIVE CONTROL: on without --fleet keeps the single runner's schedule, and status prints only its one line (CTC-6384)", async () => {
    const home = tempHome();
    const dir = install();
    expect(await main(["runner", "auto-update", "on", "--dir", dir], makeCtx(home), { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    const unit = readFileSync(service(home), "utf8");
    expect(unit).toContain(`ExecStart="/usr/local/bin/catalyst" "runner" "update" "--auto" "--dir" "${dir}"`);
    expect(unit).not.toContain("--fleet");
    const text = makeCtx(home);
    expect(await main(["runner", "auto-update", "status"], text, { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    expect(text.out).toEqual([onLine]);
    const json = makeCtx(home);
    expect(await main(["runner", "auto-update", "status", "--json"], json, { runner: { scheduler: scheduler("linux", lingers) } })).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ state: "on", detail: "timer_enabled", fleet: false, dir });
  });

  it("NEGATIVE: on --fleet without --dir is a usage error that names --dir, and touches no scheduler (CTC-6384)", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; };
    expect(await main(["runner", "auto-update", "on", "--fleet"], ctx, { runner: { scheduler: scheduler("linux", run) } })).not.toBe(0);
    expect(ctx.err.join("\n")).toContain("--fleet needs --dir, the directory that holds compose.json");
    expect(calls).toEqual([]);
    expect(existsSync(service(home))).toBe(false);
  });
});

// CTC-7046: a Mac's thoughts custody refuses an update run under another node than it recorded. An
// update run under another node re-runs itself under the custody's node, whatever wrote the agent.
describe("catalyst runner update under another node than its custody's", () => {
  /** An engine any image work would fail on: a re-run never reaches it in this process. */
  const untouched = (): RunnerUpdateEngine => {
    const no = async (): Promise<never> => { throw new Error("this process must not update"); };
    return { desiredRelease: no, updateDrain: no, attemptContainers: no, prepare: no, custody: no, services: no, stopSupervisor: no, composeUp: no, supervisorReadySinceStart: no, removeImages: no };
  };
  const rerunner = () => {
    const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    return { calls, run: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => { calls.push({ command, args, env }); return 7; } };
  };

  it("POSITIVE: re-runs itself under the custody's node with the same command line, and answers with that run's exit code", async () => {
    const ctx = makeCtx(tempHome());
    const dir = install();
    const r = rerunner();
    const argv = ["/opt/catalyst/bin/catalyst.js", "runner", "update", "--auto", "--dir", dir];
    const custody = { platform: "darwin" as const, execPath: "/home/node/bin/node", argv, node: () => "/brew/node/bin/node", run: r.run };
    expect(await main(["runner", "update", "--auto", "--dir", dir], ctx, { runner: { engine: untouched(), custody } })).toBe(7);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.command).toBe("/brew/node/bin/node");
    expect(r.calls[0]?.args).toEqual(argv);
    expect(r.calls[0]?.env.CATALYST_CUSTODY_NODE_RERUN).toBe("1");
    expect(r.calls[0]?.env.CATALYST_SKILLS_OFFLINE).toBe("1");
  });

  it.each([
    ["already runs under the custody's node", { execPath: "/brew/node/bin/node" }, {}],
    ["is itself the re-run", {}, { CATALYST_CUSTODY_NODE_RERUN: "1" }],
    ["is on Linux", { platform: "linux" as const }, {}],
    ["has no custody node", { node: () => null }, {}],
  ])("NEGATIVE: an update that %s runs in this process", async (_label, over, env) => {
    const ctx = makeCtx(tempHome(), { env: { CATALYST_SKILLS_OFFLINE: "1", ...env } });
    const dir = install();
    const r = rerunner();
    const custody = { platform: "darwin" as const, execPath: "/home/node/bin/node", argv: ["/opt/catalyst/bin/catalyst.js", "runner", "update", "--dir", dir], node: () => "/brew/node/bin/node", run: r.run, ...over };
    expect(await main(["runner", "update", "--dir", dir], ctx, { runner: { engine: engine(503), custody } })).toBe(0);
    expect(r.calls).toEqual([]);
    expect(ctx.out[0]).toBe("Kept the current images.");
  });

  it("NEGATIVE: a custody node that is a link to the running node counts as the same node", async () => {
    const ctx = makeCtx(tempHome());
    const dir = install();
    const r = rerunner();
    const link = join(mkdtempSync(join(tmpdir(), "custody-node-")), "node");
    symlinkSync(process.execPath, link);
    const custody = { platform: "darwin" as const, execPath: process.execPath, argv: ["/x", "runner", "update", "--dir", dir], node: () => link, run: r.run };
    expect(await main(["runner", "update", "--dir", dir], ctx, { runner: { engine: engine(503), custody } })).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("NEGATIVE: --check never re-runs, since it attests nothing", async () => {
    const ctx = makeCtx(tempHome());
    const dir = install();
    const r = rerunner();
    const custody = { platform: "darwin" as const, execPath: "/home/node/bin/node", argv: ["/x"], node: () => "/brew/node/bin/node", run: r.run };
    expect(await main(["runner", "update", "--check", "--dir", dir], ctx, { runner: { engine: engine(503), custody } })).toBe(0);
    expect(r.calls).toEqual([]);
  });
});

// CTC-8163: a fleet supervisor that misses its qualification deadline names each saved scope it had not
// qualified, and the gate condition failing, on stderr before the restore. stdout keeps the schedule's
// one line, or the one JSON object.
describe("catalyst runner update --fleet: a qualification deadline is explained on stderr", () => {
  const OLD_IMAGES = { runner: ref("runner", "8"), supervisor: ref("supervisor", "9") };
  const NEW_IMAGES = { runner: ref("runner", "1"), supervisor: ref("supervisor", "2") };
  const scopeLine = (event: string, team: string, fields: Record<string, unknown> = {}) => JSON.stringify({ event, tenant: "tenant-0", team, ...fields });
  const SERVING = [scopeLine("supervisor_scope_qualified", "CTC"), scopeLine("supervisor_scope_qualified", "WID")].join("\n");
  const CTC_NOT_READOPTED = [
    scopeLine("supervisor_scope_qualified", "WID"),
    scopeLine("supervisor_scope_qualification_state", "CTC", { resourcesReady: true, scopeEligible: true, readyUntilValid: true, sessionsReadopted: false }),
  ].join("\n");
  const PENDING = "catalyst: fleet qualification pending: roll=candidate scope=tenant-0/CTC failed=sessions_readopted";

  /** A fleet on OLD_IMAGES offered NEW_IMAGES, whose supervisor logs `candidateLog`; the previous one serves both scopes. */
  function fleet(candidateLog: string) {
    const dir = mkdtempSync(join(tmpdir(), "runner-cmd-fleet-"));
    const composeFor = (images: typeof OLD_IMAGES) =>
      `${JSON.stringify({ name: "catalyst-fleet", services: { supervisor: { image: images.supervisor, environment: { CATALYST_RUNNER_IMAGE: images.runner } } } }, null, 2)}\n`;
    writeFileSync(join(dir, "compose.json"), composeFor(OLD_IMAGES), { mode: 0o600 });
    const running = () => JSON.parse(readFileSync(join(dir, "compose.json"), "utf8")).services.supervisor as { image: string; environment: { CATALYST_RUNNER_IMAGE: string } };
    let recreates = 0;
    let log = SERVING;
    let t = Date.parse("2026-10-27T16:00:00Z");
    const fleetEngine: FleetUpdateEngine = {
      desiredRelease: async () => answered(hostRelease()),
      supervisor: async () => ({
        id: String(recreates).repeat(64), image: running().image, runnerImage: running().environment.CATALYST_RUNNER_IMAGE,
        running: true, restartCount: 0, startedAt: "2026-10-27T16:00:00Z",
      }),
      logs: async () => log,
      children: async () => ({}),
      prepare: async () => null,
      configValid: async () => true,
      recreate: async () => {
        recreates++;
        log = running().image === NEW_IMAGES.supervisor ? candidateLog : SERVING;
        return true;
      },
      removeImages: async () => undefined,
      armPostRollCheck: async () => true,
    };
    return { dir, deps: { fleetEngine, fleetClock: { now: () => t, sleep: async (ms: number) => void (t += ms) } } };
  }

  it("RED: the schedule's run writes the scope and its failed condition to stderr, and stdout keeps its one line", async () => {
    const { dir, deps } = fleet(CTC_NOT_READOPTED);
    const ctx = makeCtx(tempHome(), { now: () => new Date("2026-10-27T16:10:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--fleet", "--dir", dir], ctx, { runner: deps })).toBe(1);
    expect(ctx.out).toEqual(["2026-10-27T16:10:00.000Z rolled_back new_supervisor_not_qualified generation=none"]);
    expect(ctx.err).toEqual([PENDING]);
  });

  it("RED: --json keeps stdout to the one JSON result, with the same detail", async () => {
    const { dir, deps } = fleet(CTC_NOT_READOPTED);
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet", "--json", "--dir", dir], ctx, { runner: deps })).toBe(1);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({
      outcome: "rolled_back", detail: "new_supervisor_not_qualified", generation: null, exitCode: 1, releaseId: hostRelease().releaseId,
    });
    expect(ctx.err).toEqual([PENDING]);
  });

  it("POSITIVE CONTROL: a supervisor that qualifies every scope writes nothing to stderr", async () => {
    const { dir, deps } = fleet(SERVING);
    const ctx = makeCtx(tempHome(), { now: () => new Date("2026-10-27T16:10:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--fleet", "--dir", dir], ctx, { runner: deps })).toBe(0);
    expect(ctx.out).toEqual(["2026-10-27T16:10:00.000Z updated updated:runner,supervisor generation=89"]);
    expect(ctx.err).toEqual([]);
  });
});
