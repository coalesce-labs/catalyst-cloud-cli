import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import type { SchedulerRun } from "../src/runner-auto-update";
import type { RunnerUpdateEngine } from "../src/runner-update";
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
    expect(ctx.out).toEqual(["Kept the current images.", "Release: none, generation none (release_unavailable)."]);
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
    expect(ctx.out[0]).not.toContain("sudo");
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
});
