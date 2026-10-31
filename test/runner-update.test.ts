import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decideRelease,
  advanceDeferral,
  parseDrainAnswer,
  parseDesiredRelease,
  PREVIOUS_ENV_FILE,
  preparationStopOnly,
  updateResultLines,
  readReleaseState,
  RELEASE_STATE_FILE,
  writeReleaseState,
  rewriteEnvText,
  runRunnerUpdate,
  updateReport,
  lastProblem,
  lastProblemLines,
  type DesiredReleaseRead,
  type ReleaseComponent,
  type ReleaseState,
  type UpdateOutcome,
  type RunnerUpdateEngine,
} from "../src/runner-update";
import {
  autoUpdateStatus,
  disableAutoUpdate,
  enableAutoUpdate,
  launchAgentPath,
  launchAgentPlist,
  systemdUnitPaths,
  systemdUnits,
  type SchedulerRun,
} from "../src/runner-auto-update";
import { canonicalDarwinThoughtsJson } from "../vendor/self-host/darwin-thoughts-custody/verifier.mjs";
import { answered, fakeEngine, fastClock, hex, imagesIn, install, OLD, ORIGINAL_ENV, ref, release, REPO, sha, TARGET, type Images } from "./runner-update-fixtures";

function onGeneration(dir: string, generation: number) {
  writeReleaseState(dir, { ...readReleaseState(dir), generation });
}

describe("CTC-7749: a busy deferral reports both generations, its phase count and how long it has waited", () => {
  it("reports 106 offered to a machine on 102 during the busy run", async () => {
    const dir = install();
    onGeneration(dir, 102);
    const now = 1_800_000_000_000;
    const first = fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [2] });
    const result = await runRunnerUpdate(first.engine, { dir, now: () => now });
    expect(result).toMatchObject({ outcome: "deferred_busy", detail: "phases_running:2,deferred_for_ms:0", generation: 102, offeredGeneration: 106 });
    expect(first.reports).toHaveLength(2);
    expect(first.reports[0]).toBeUndefined();
    expect(JSON.parse(first.reports[1]!)).toMatchObject({ v: 1, outcome: "deferred_busy", detail: "phases_running:2,deferred_for_ms:0", applied: 102, offered: 106 });
    expect(readReleaseState(dir).deferral).toEqual({ sinceMs: now, offered: 106, offeredSinceMs: now });

    const second = fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [2] });
    const later = await runRunnerUpdate(second.engine, { dir, now: () => now + 900_000 });
    expect(later.detail).toBe("phases_running:2,deferred_for_ms:900000");
    expect(JSON.parse(second.reports[0]!)).toMatchObject({ outcome: "deferred_busy", offered: 106 });
    expect(JSON.parse(second.reports[1]!)).toMatchObject({ outcome: "deferred_busy", detail: later.detail, offered: 106 });
    expect(readReleaseState(dir).deferral?.sinceMs).toBe(now);
  });

  it("keeps the backlog clock across approvals and resets the offered clock", () => {
    const previous = { sinceMs: 100, offered: 106, offeredSinceMs: 200 };
    expect(advanceDeferral(previous, { generation: 106, approvedAtMs: 50 }, 400)).toEqual(previous);
    expect(advanceDeferral(previous, { generation: 107, approvedAtMs: 350 }, 400)).toEqual({ sinceMs: 100, offered: 107, offeredSinceMs: 400 });
    expect(advanceDeferral(null, { generation: 106, approvedAtMs: 50 }, 400)).toEqual({ sinceMs: 50, offered: 106, offeredSinceMs: 400 });
  });

  it("a look does not persist or report a deferral", async () => {
    const dir = install();
    onGeneration(dir, 102);
    const fake = fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [2] });
    expect(await runRunnerUpdate(fake.engine, { dir, check: true, now: () => 1_800_000_000_000 })).toMatchObject({ outcome: "planned" });
    expect(fake.reports).toEqual([undefined]);
    expect(readReleaseState(dir).deferral).toBeNull();
  });

  it("a malformed persisted clock or offered generation is discarded", () => {
    const dir = install();
    writeFileSync(join(dir, RELEASE_STATE_FILE), JSON.stringify({ version: 1, generation: 102, deferral: { sinceMs: 1.5, offered: "106", offeredSinceMs: 2 }, last: { atMs: 3, outcome: "deferred_busy", detail: "x", generation: 102, offered: "106" } }));
    expect(readReleaseState(dir)).toMatchObject({ deferral: null, last: { offered: null } });
  });

  it("applying and verifying clear the clock; a retained prepare error preserves it", async () => {
    const dir = install();
    onGeneration(dir, 102);
    const time = 1_800_000_000_000;
    await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [2] }).engine, { dir, now: () => time });
    expect(readReleaseState(dir).deferral).not.toBeNull();
    const refused = await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0], prepare: "runner_image_emulated" }).engine,
      { dir, now: () => time + 1_000 });
    expect(refused).toMatchObject({ outcome: "retained", detail: "runner_image_emulated" });
    expect(readReleaseState(dir).deferral?.sinceMs).toBe(time);
    expect(await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0, 0] }).engine,
      { dir, now: () => time + 2_000 })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(readReleaseState(dir).deferral).toBeNull();
    writeReleaseState(dir, { ...readReleaseState(dir), deferral: { sinceMs: time, offered: 106, offeredSinceMs: time } });
    expect(await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })) }).engine,
      { dir, now: () => time + 3_000 })).toMatchObject({ outcome: "current" });
    expect(readReleaseState(dir).deferral).toBeNull();
  });

  it("a rollback restarts the clock at this attempt rather than draining immediately again", async () => {
    const dir = install();
    onGeneration(dir, 102);
    const time = 1_800_000_000_000;
    await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [2] }).engine, { dir, now: () => time });
    let retryAt = time + 900_000;
    const rolled = await runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0, 0],
      ready: (image) => image === OLD.supervisor }).engine, { dir, now: () => retryAt, sleep: async (ms) => { retryAt += ms; }, readyDeadlineMs: 1 });
    expect(rolled.outcome).toBe("rolled_back");
    expect(readReleaseState(dir).deferral?.sinceMs).toBe(retryAt);
  });

  it("the report and last problem use the offered generation", () => {
    const dir = install();
    const state = { ...readReleaseState(dir), generation: 102, last: { atMs: 1_800_000_000_000, outcome: "failed" as const, detail: "x", generation: 102, offered: 106 } };
    expect(JSON.parse(updateReport(state, "0.1.0")!)).toMatchObject({ applied: 102, offered: 106 });
    expect(lastProblemLines(state)[0]).toContain("offered generation 106");
  });
});

describe("parseDrainAnswer (CTC-7749)", () => {
  const id = "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360";
  const active = { requestId: id, generation: 106, requestedAtMs: 1_800_000_000_000, admissionBlocked: true };
  const answer = (body: unknown, status = 200): DesiredReleaseRead => ({ kind: "answered", status, body, hostId: "host_abc" });

  it.each([
    { ok: true, revision: 0, drain: null, liveGenerations: 2 },
    { ok: true, revision: 1, drain: active, liveGenerations: 2 },
    { ok: true, revision: 2, drain: null, liveGenerations: 0 },
  ])("parses a valid cloud drain status", (body) => {
    expect(parseDrainAnswer(answer(body))).toEqual({ status: { revision: body.revision, drain: body.drain, liveGenerations: body.liveGenerations } });
  });

  it.each(["update_drain_conflict", "update_drain_invalid", "update_drain_unavailable", "managed_host_unsupported", "host_revoked"])("keeps the fixed refusal %s", (refusal) => {
    expect(parseDrainAnswer(answer({ ok: false, refusal }, 409))).toEqual({ refused: refusal });
  });

  it("handles an absent route and absent credential", () => {
    expect(parseDrainAnswer(answer("not JSON", 404))).toEqual({ refused: "http_404" });
    expect(parseDrainAnswer({ kind: "unreachable", detail: "TimeoutError", hostId: "host_abc" })).toEqual({ refused: "unreachable" });
    expect(parseDrainAnswer({ kind: "no_credential" })).toEqual({ refused: "no_credential" });
  });

  it.each([
    { ok: false, revision: 1, drain: null, liveGenerations: 0 },
    { ok: true, revision: -1, drain: null, liveGenerations: 0 },
    { ok: true, revision: 1.5, drain: null, liveGenerations: 0 },
    { ok: true, revision: 1, drain: null },
    { ok: true, revision: 1, drain: { ...active, generation: "106" }, liveGenerations: 0 },
    { ok: true, revision: 1, drain: { ...active, admissionBlocked: "true" }, liveGenerations: 0 },
    { ok: true, revision: 1, drain: { ...active, requestId: "x".repeat(60) }, liveGenerations: 0 },
  ])("rejects an invalid status", (body) => {
    expect(parseDrainAnswer(answer(body))).toEqual({ refused: "response_invalid" });
  });
  it("never returns a malformed refusal", () => {
    expect(parseDrainAnswer(answer({ refusal: "bad reason" }, 409))).toEqual({ refused: "http_409" });
  });
});

describe("parse and decide: only a valid, strictly newer approved release moves a machine", () => {
  it("POSITIVE CONTROL: a well-formed release parses and a first one is an update", () => {
    expect(parseDesiredRelease(release())).toMatchObject({ generation: 1, images: { runner: { reference: ref("runner", "1") } } });
    expect(decideRelease(null, answered(release()))).toMatchObject({ action: "update" });
  });

  it.each([
    ["a tag instead of a digest", (b: Record<string, unknown>) => ((b.runner as Record<string, unknown>).reference = `${REPO.runner}:latest`)],
    ["another repository", (b: Record<string, unknown>) => ((b.supervisor as Record<string, unknown>).reference = `ghcr.io/evil/catalyst-supervisor@sha256:${hex("2")}`)],
    ["a digest that disagrees with the reference", (b: Record<string, unknown>) => ((b.watchdog as Record<string, unknown>).digest = `sha256:${hex("9")}`)],
    ["a release id that does not match the digests", (b: Record<string, unknown>) => (b.releaseId = "hr-0000000000000000-0000000000000000-0000000000000000")],
    ["a tag that does not match its source commit", (b: Record<string, unknown>) => ((b.runner as Record<string, unknown>).tag = `${REPO.runner}:${sha("a")}`)],
    ["another wire version", (b: Record<string, unknown>) => (b.version = 2)],
  ])("NEGATIVE: %s is refused and keeps the current images", (_label, mutate) => {
    const body = release({ mutate });
    expect(parseDesiredRelease(body)).toBeNull();
    expect(decideRelease(null, answered(body))).toEqual({ action: "retain", reason: "response_invalid", terminal: false });
  });

  it("an older generation is not newer; the applied one is verified, not trusted", () => {
    expect(decideRelease(3, answered(release({ generation: 3 })))).toMatchObject({ action: "verify", release: { generation: 3 } });
    expect(decideRelease(3, answered(release({ generation: 2 })))).toMatchObject({ action: "retain", reason: "not_newer" });
    expect(decideRelease(3, answered(release({ generation: 4 })))).toMatchObject({ action: "update" });
  });

  it("unavailable, unreachable and refused answers retain; only a revoked host is terminal", () => {
    expect(decideRelease(null, answered({ ok: false, refusal: "release_unavailable" }, 503))).toMatchObject({ reason: "release_unavailable" });
    expect(decideRelease(null, { kind: "unreachable", detail: "TimeoutError", hostId: "h" })).toMatchObject({ reason: "read_unreachable" });
    expect(decideRelease(null, answered({ ok: false, refusal: "host_revoked", terminal: true }, 401))).toEqual({ action: "retain", reason: "credential_refused", terminal: true });
    expect(decideRelease(null, answered({ ok: false, refusal: "credential_retired", terminal: false }, 401))).toMatchObject({ terminal: false });
    expect(decideRelease(null, { kind: "no_credential" })).toMatchObject({ reason: "no_credential" });
  });
});

describe("rewriteEnvText changes only the three image lines", () => {
  it("keeps comments, order and every other value", () => {
    const text = "# header\nCATALYST_SLOTS=1\nCATALYST_RUNNER_IMAGE=old\nCATALYST_SUPERVISOR_IMAGE=old2\n";
    expect(rewriteEnvText(text, { CATALYST_RUNNER_IMAGE: "new", CATALYST_SUPERVISOR_IMAGE: "new2", CATALYST_WATCHDOG_IMAGE: "w" }))
      .toBe("# header\nCATALYST_SLOTS=1\nCATALYST_RUNNER_IMAGE=new\nCATALYST_SUPERVISOR_IMAGE=new2\nCATALYST_WATCHDOG_IMAGE=w\n");
  });
});

describe("runRunnerUpdate", () => {
  let dir: string;
  beforeEach(() => { dir = install(); });

  it("POSITIVE CONTROL: idle machine, newer release → pulls, stops the supervisor, looks again, rewrites three lines, starts, waits for host_ready, records", async () => {
    const { engine, calls, live } = fakeEngine(dir);
    const result = await runRunnerUpdate(engine, { dir, ...fastClock() });
    expect(result).toMatchObject({ outcome: "updated", generation: 1, exitCode: 0 });
    expect(calls).toEqual(["read", "attempts:host_abc", "prepare:3", "stop", "attempts:host_abc", "up",
      `rm:${OLD.runner},${OLD.supervisor},${OLD.watchdog}`]);
    expect(live()).toEqual(TARGET);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(imagesIn(env)).toEqual(TARGET);
    expect(env).toContain("CATALYST_HOST_FREE_FLOOR_GIB=25\n");
    expect(env.startsWith("# setup wrote this\n")).toBe(true);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, PREVIOUS_ENV_FILE), "utf8")).toBe(ORIGINAL_ENV);
    expect(readReleaseState(dir)).toMatchObject({ generation: 1, previous: OLD, last: { outcome: "updated" } });
    expect(existsSync(join(dir, "update.lock"))).toBe(false);
  });

  it("the next run with the same generation changes nothing", async () => {
    const first = fakeEngine(dir);
    await runRunnerUpdate(first.engine, { dir, ...fastClock() });
    const second = fakeEngine(dir);
    expect(await runRunnerUpdate(second.engine, { dir, ...fastClock() })).toMatchObject({ outcome: "current", generation: 1 });
    expect(second.calls).toEqual(["read"]);
  });

  it("CTC-6924: the first run reports nothing; the next run reports the first run's outcome on its read", async () => {
    const first = fakeEngine(dir);
    await runRunnerUpdate(first.engine, { dir, ...fastClock() });
    expect(first.reports).toEqual([undefined]);
    const second = fakeEngine(dir);
    await runRunnerUpdate(second.engine, { dir, ...fastClock() });
    expect(JSON.parse(second.reports[0]!)).toMatchObject({
      v: 1, outcome: "updated", detail: "updated:runner,supervisor,watchdog", applied: 1, offered: 1,
    });
  });

  it("CTC-6924: --check sends no report, so a look never counts as a run", async () => {
    await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock() });
    const look = fakeEngine(dir);
    await runRunnerUpdate(look.engine, { dir, check: true, ...fastClock() });
    expect(look.reports).toEqual([undefined]);
  });

  it("a setup run that puts the old images back after an update is moved back to the applied release", async () => {
    // Seen on a fresh Linux install, 2026-10-17: setup started the machine on its default pins, the
    // schedule moved it to the approved release, then running setup again wrote the default pins
    // back into .env and restarted on them while release-state still said that release.
    await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock() });
    expect(readReleaseState(dir).generation).toBe(1);
    writeFileSync(join(dir, ".env"), ORIGINAL_ENV, { mode: 0o600 });
    const after = fakeEngine(dir); // now running what .env names: the old images
    const result = await runRunnerUpdate(after.engine, { dir, ...fastClock() });
    expect(result).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor,watchdog", generation: 1 });
    expect(after.live()).toEqual(TARGET);
    expect(imagesIn(readFileSync(join(dir, ".env"), "utf8"))).toEqual(TARGET);
  });

  it("the applied release with .env right but the old supervisor still running is moved too", async () => {
    await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock() });
    const stale = fakeEngine(dir, { live: { ...TARGET, supervisor: OLD.supervisor } });
    expect(await runRunnerUpdate(stale.engine, { dir, ...fastClock() })).toMatchObject({ generation: 1 });
    expect(stale.calls).toContain("up");
    expect(stale.live()).toEqual(TARGET);
  });

  it("a phase container on this host at the first look defers, and nothing is stopped or written", async () => {
    const { engine, calls } = fakeEngine(dir, { busy: [1] });
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "deferred_busy", exitCode: 0 });
    expect(calls).not.toContain("stop");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
    expect(readReleaseState(dir).generation).toBeNull();
  });

  it("a phase that started while images were pulled: the supervisor comes back on its old images and the update waits", async () => {
    const { engine, calls, live } = fakeEngine(dir, { busy: [0, 1] });
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "deferred_busy", detail: "phases_running:1,deferred_for_ms:0" });
    expect(calls.slice(-4)).toEqual(["stop", "attempts:host_abc", "up", "read"]);
    expect(live()).toEqual(OLD);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
  });

  it("an image that cannot be pulled natively keeps the current images", async () => {
    const { engine, calls } = fakeEngine(dir, { prepare: "runner_image_emulated" });
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "retained", detail: "runner_image_emulated" });
    expect(calls).not.toContain("stop");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
  });

  it("a new supervisor that never reports host_ready is rolled back to the previous images", async () => {
    const { engine, calls, live } = fakeEngine(dir, { ready: (image) => image === OLD.supervisor });
    const result = await runRunnerUpdate(engine, { dir, ...fastClock(), readyDeadlineMs: 20_000 });
    expect(result).toMatchObject({ outcome: "rolled_back", exitCode: 1, generation: null });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
    expect(calls.filter((c) => c === "up")).toHaveLength(2);
    expect(live()).toEqual(OLD);
    // The images it would go back to are kept.
    expect(calls.some((c) => c.startsWith("rm:"))).toBe(false);
    // Not recorded as applied, so the next check tries the same release again.
    expect(readReleaseState(dir)).toMatchObject({ generation: null, last: { outcome: "rolled_back" } });
  });

  describe("CTC-8745: a release that comes up inside a preparation stop", () => {
    const stopOnNew = { ready: (image: string) => image === OLD.supervisor, preparationStop: (image: string) => image !== OLD.supervisor };

    it("is kept and not recorded as applied, and the previous images and file stay", async () => {
      const { engine, calls, live } = fakeEngine(dir, stopOnNew);
      const result = await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(result).toMatchObject({ outcome: "retained", detail: "waiting_preparation_stop", exitCode: 0, generation: null });
      expect(live()).not.toEqual(OLD);
      expect(calls.filter((c) => c === "up")).toHaveLength(1);
      expect(calls.some((c) => c.startsWith("rm:"))).toBe(false);
      expect(readFileSync(join(dir, PREVIOUS_ENV_FILE), "utf8")).toBe(ORIGINAL_ENV);
      expect(readReleaseState(dir)).toMatchObject({ generation: null, last: { outcome: "retained", detail: "waiting_preparation_stop" } });
      expect(updateResultLines(result)[0]).toContain("The new release is running.");
    });

    it("does not restart anything on later runs while the stop holds", async () => {
      const { engine, calls } = fakeEngine(dir, stopOnNew);
      await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      const before = calls.length;
      const again = await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(again).toMatchObject({ outcome: "retained", detail: "waiting_preparation_stop", exitCode: 0 });
      expect(calls.slice(before).filter((c) => c === "stop" || c === "up")).toEqual([]);
    });

    it("records it once the stop lifts and it is ready, and removes what it replaced", async () => {
      let lifted = false;
      const { engine, calls } = fakeEngine(dir, {
        ready: (image) => image === OLD.supervisor || lifted,
        preparationStop: (image) => image !== OLD.supervisor && !lifted,
      });
      await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      lifted = true;
      const applied = await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(applied).toMatchObject({ outcome: "recorded", detail: "kept_through_preparation_stop", exitCode: 0 });
      expect(applied.generation).toBe(readReleaseState(dir).generation);
      expect(readReleaseState(dir).generation).not.toBeNull();
      expect(readReleaseState(dir).previous).toEqual(OLD);
      expect(calls.filter((c) => c === "up")).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith("rm:")).join()).toContain(OLD.supervisor);
    });

    it("rolls back on a later run when the stop has lifted and it is still not ready", async () => {
      let lifted = false;
      const { engine, live } = fakeEngine(dir, {
        ready: (image) => image === OLD.supervisor,
        preparationStop: (image) => image !== OLD.supervisor && !lifted,
      });
      await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      lifted = true;
      const result = await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(result).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_ready", exitCode: 1 });
      expect(live()).toEqual(OLD);
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
    });

    const NEWER = { digits: ["7", "8", "9"] as [string, string, string], generation: 2 };
    const newerSupervisor = ref("supervisor", "8");
    const firstSupervisor = TARGET.supervisor;
    const clocked = () => {
      const clock = fastClock();
      let extra = 0;
      return { now: () => clock.now() + extra, sleep: clock.sleep, pass: (ms: number) => { extra += ms; } };
    };

    it("keeps its deadline from the first wait, and goes back at 45 minutes while the stop still holds", async () => {
      const { engine, calls, live } = fakeEngine(dir, stopOnNew);
      const { pass, now, sleep } = clocked();
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      await run();
      const since = readReleaseState(dir).kept?.sinceMs;
      expect(since).toBeTypeOf("number");
      pass(44 * 60_000);
      const before = calls.length;
      expect(await run()).toMatchObject({ outcome: "retained", detail: "waiting_preparation_stop" });
      expect(calls.slice(before).filter((c) => c === "stop" || c === "up")).toEqual([]);
      expect(readReleaseState(dir).kept?.sinceMs).toBe(since);
      pass(2 * 60_000);
      const result = await run();
      expect(result).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_ready", exitCode: 1 });
      expect(live()).toEqual(OLD);
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
      expect(readReleaseState(dir).kept).toBeNull();
    });

    it("waits the whole 45 minutes, and not one more", async () => {
      const { engine } = fakeEngine(dir, stopOnNew);
      const { pass, now, sleep } = clocked();
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      await run();
      const since = readReleaseState(dir).kept!.sinceMs;
      pass(since + 45 * 60_000 - 1 - now());
      expect((await run()).outcome).toBe("retained");
      pass(1);
      expect((await run()).outcome).toBe("rolled_back");
    });

    it("records a kept release that comes up ready on its restart at the deadline", async () => {
      let restarted = false;
      const { engine, live } = fakeEngine(dir, {
        ready: (image) => image === OLD.supervisor || restarted,
        preparationStop: (image) => image !== OLD.supervisor && !restarted,
        onStop: () => { restarted = true; },
      });
      const { pass, now, sleep } = clocked();
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      const first = fakeEngine(dir, stopOnNew);
      await runRunnerUpdate(first.engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      pass(46 * 60_000);
      expect(await run()).toMatchObject({ outcome: "updated", detail: "reconciled" });
      expect(live()).toEqual(TARGET);
      expect(readReleaseState(dir).kept).toBeNull();
      expect(readReleaseState(dir).previous).toEqual(OLD);
    });

    it("goes back past a kept release when a newer offer is broken", async () => {
      let read = release();
      const { engine, live } = fakeEngine(dir, {
        read: () => answered(read),
        ready: (image) => image === OLD.supervisor,
        preparationStop: (image) => image === firstSupervisor,
      });
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect((await run()).detail).toBe("waiting_preparation_stop");
      read = release(NEWER);
      expect(await run()).toMatchObject({ outcome: "rolled_back", exitCode: 1 });
      expect(live()).toEqual(OLD);
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
      expect(readFileSync(join(dir, PREVIOUS_ENV_FILE), "utf8")).toBe(ORIGINAL_ENV);
      expect(readReleaseState(dir).kept).toBeNull();
    });

    it("holds the proven release in the rollback file through a newer offer that is kept too, with its own deadline", async () => {
      let read = release();
      const { engine, calls } = fakeEngine(dir, { read: () => answered(read), ready: (image) => image === OLD.supervisor, preparationStop: (image) => image !== OLD.supervisor });
      const { pass, now, sleep } = clocked();
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      await run();
      pass(40 * 60_000);
      read = release(NEWER);
      expect((await run()).detail).toBe("waiting_preparation_stop");
      expect(readFileSync(join(dir, PREVIOUS_ENV_FILE), "utf8")).toBe(ORIGINAL_ENV);
      expect(readReleaseState(dir).kept?.generation).toBe(2);
      pass(40 * 60_000);
      expect((await run()).detail).toBe("waiting_preparation_stop");
      expect(calls.some((c) => c.startsWith("rm:"))).toBe(false);
    });

    it("gives a newer offer its own wait even after the kept release's deadline has passed", async () => {
      let read = release();
      const { engine } = fakeEngine(dir, { read: () => answered(read), ready: (image) => image === OLD.supervisor, preparationStop: (image) => image !== OLD.supervisor });
      const { pass, now, sleep } = clocked();
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, now, sleep, readyDeadlineMs: 20_000 });
      await run();
      pass(46 * 60_000);
      read = release(NEWER);
      expect(await run()).toMatchObject({ outcome: "retained", detail: "waiting_preparation_stop" });
      expect(readReleaseState(dir).kept?.generation).toBe(2);
    });

    it("removes the proven images too when a newer offer comes up ready, and keeps them as previous", async () => {
      let read = release();
      const { engine, calls, live } = fakeEngine(dir, {
        read: () => answered(read),
        ready: (image) => image === OLD.supervisor || image === newerSupervisor,
        preparationStop: (image) => image === firstSupervisor,
      });
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      await run();
      read = release(NEWER);
      expect(await run()).toMatchObject({ outcome: "updated", exitCode: 0 });
      expect(live().supervisor).toBe(newerSupervisor);
      const removed = calls.filter((c) => c.startsWith("rm:")).join();
      expect(removed).toContain(OLD.supervisor);
      expect(removed).toContain(firstSupervisor);
      expect(readReleaseState(dir).previous).toEqual(OLD);
      expect(readReleaseState(dir).kept).toBeNull();
    });

    it("leaves a proven image the newer release still uses", async () => {
      let read = release();
      const { engine, calls } = fakeEngine(dir, {
        read: () => answered(read),
        ready: (image) => image === OLD.supervisor || image === newerSupervisor,
        preparationStop: (image) => image === firstSupervisor,
      });
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      await run();
      read = release({ ...NEWER, digits: ["c", "8", "9"] });
      expect((await run()).outcome).toBe("updated");
      const removed = calls.filter((c) => c.startsWith("rm:")).join();
      expect(removed).toContain(OLD.supervisor);
      expect(removed).not.toContain(OLD.runner);
    });

    it("still finishes the cleanup after another outcome overwrote the last result", async () => {
      let reachable = true;
      let lifted = false;
      const { engine, calls } = fakeEngine(dir, {
        read: () => (reachable ? answered(release()) : { kind: "unreachable", detail: "TimeoutError", hostId: "host_abc" }),
        ready: (image) => image === OLD.supervisor || lifted,
        preparationStop: (image) => image !== OLD.supervisor && !lifted,
      });
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      await run();
      reachable = false;
      await run();
      expect(readReleaseState(dir).last?.detail).not.toBe("waiting_preparation_stop");
      reachable = true;
      lifted = true;
      expect(await run()).toMatchObject({ outcome: "recorded", detail: "kept_through_preparation_stop" });
      expect(calls.filter((c) => c.startsWith("rm:")).join()).toContain(OLD.supervisor);
    });

    it("does not count a stop while the new watchdog is down or on another image", async () => {
      const down = fakeEngine(dir, { ...stopOnNew, up: { watchdog: (images) => images.supervisor === OLD.supervisor } });
      expect((await runRunnerUpdate(down.engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 })).outcome).toBe("rolled_back");
      const other = install(ORIGINAL_ENV);
      const stale = fakeEngine(other, stopOnNew);
      const services = stale.engine.services.bind(stale.engine);
      stale.engine.services = async (d, signal) => {
        const live = await services(d, signal);
        return live && live.supervisor?.image === TARGET.supervisor ? { ...live, watchdog: { image: OLD.watchdog, running: true, startedAtMs: 1 } } : live;
      };
      expect((await runRunnerUpdate(stale.engine, { scheduled: true, dir: other, ...fastClock(), readyDeadlineMs: 20_000 })).outcome).toBe("rolled_back");
    });

    it("does not count a stop while the new supervisor is down or on another image", async () => {
      const { engine } = fakeEngine(dir, { ...stopOnNew, up: { supervisor: (images) => images.supervisor === OLD.supervisor } });
      expect((await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 })).outcome).toBe("rolled_back");
      const other = install(ORIGINAL_ENV);
      const stale = fakeEngine(other, stopOnNew);
      const services = stale.engine.services.bind(stale.engine);
      stale.engine.services = async (d, signal) => {
        const live = await services(d, signal);
        return live && live.watchdog?.image === TARGET.watchdog ? { ...live, supervisor: { image: OLD.supervisor, running: true, startedAtMs: 1 } } : live;
      };
      expect((await runRunnerUpdate(stale.engine, { scheduled: true, dir: other, ...fastClock(), readyDeadlineMs: 20_000 })).outcome).toBe("rolled_back");
    });

    it("goes back at the normal deadline on a run no schedule follows, and keeps no wait open", async () => {
      const { engine, live } = fakeEngine(dir, stopOnNew);
      const result = await runRunnerUpdate(engine, { dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(result).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_ready", exitCode: 1 });
      expect(live()).toEqual(OLD);
      expect(readReleaseState(dir).kept).toBeNull();
    });

    it("ends a kept release on an owner's own run, whatever time is left", async () => {
      const { engine, live } = fakeEngine(dir, stopOnNew);
      expect((await runRunnerUpdate(engine, { dir, scheduled: true, ...fastClock(), readyDeadlineMs: 20_000 })).detail).toBe("waiting_preparation_stop");
      expect(await runRunnerUpdate(engine, { dir, ...fastClock(), readyDeadlineMs: 20_000 })).toMatchObject({ outcome: "rolled_back", exitCode: 1 });
      expect(live()).toEqual(OLD);
    });

    it("reads a rollback a stop also holds as a rollback, not a failure", async () => {
      const { engine, live } = fakeEngine(dir, { ready: () => false, preparationStop: () => true });
      const result = await runRunnerUpdate(engine, { dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(result).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_ready", exitCode: 1 });
      expect(live()).toEqual(OLD);
    });

    it("leaves an image the kept release shares with what it replaced", async () => {
      const onlyWatchdog = install(ORIGINAL_ENV.replace(OLD.supervisor, TARGET.supervisor).replace(OLD.runner, TARGET.runner));
      let lifted = false;
      const { engine, calls } = fakeEngine(onlyWatchdog, {
        ready: () => lifted,
        preparationStop: (image) => image === TARGET.supervisor && !lifted,
      });
      const run = () => runRunnerUpdate(engine, { scheduled: true, dir: onlyWatchdog, ...fastClock(), readyDeadlineMs: 20_000 });
      expect((await run()).detail).toBe("waiting_preparation_stop");
      lifted = true;
      expect(await run()).toMatchObject({ outcome: "recorded", detail: "kept_through_preparation_stop" });
      expect(calls.filter((c) => c.startsWith("rm:"))).toEqual([`rm:${OLD.watchdog}`]);
    });

    it("does not count a stop the running images do not show", async () => {
      const { engine, live } = fakeEngine(dir, { ready: (image) => image === OLD.supervisor, preparationStop: () => true, composeUp: [false] });
      const result = await runRunnerUpdate(engine, { scheduled: true, dir, ...fastClock(), readyDeadlineMs: 20_000 });
      expect(result.outcome).toBe("rolled_back");
      expect(live()).toEqual(OLD);
    });
  });

  describe("CTC-8745: what counts as only a preparation stop", () => {
    const stop = { id: "host.preparation-failed", reason: "failed", remedy: "workspace_unavailable" };
    const notReady = (...failing: unknown[]) => JSON.stringify({ event: "host_not_ready", linePerChange: true, failing });
    const ready = JSON.stringify({ event: "host_ready", freeSlots: 1 });

    it.each([
      ["the stop alone", [notReady(stop)], true],
      ["the stop alone, from a supervisor that writes one line per flip", [JSON.stringify({ event: "host_not_ready", failing: [stop] })], false],
      ["the stop alone, with the field anything but true", [JSON.stringify({ event: "host_not_ready", linePerChange: "true", failing: [stop] })], false],
      ["the stop alone, after other log lines", ['{"event":"supervisor_started"}', notReady(stop), "plain text", '{"event":"host_capability_retry"}'], true],
      ["the latest line, when an earlier one named more", [notReady(stop, { id: "host.docker-socket-gid", reason: "failed" }), notReady(stop)], true],
      ["the stop and another prerequisite", [notReady(stop, { id: "host.docker-socket-gid", reason: "failed" })], false],
      ["a later line that added a prerequisite", [notReady(stop), notReady(stop, { id: "host.docker-socket-gid", reason: "failed" })], false],
      ["another prerequisite alone", [notReady({ id: "host.docker-socket-gid", reason: "failed" })], false],
      ["the stop unreported rather than failed", [notReady({ id: "host.preparation-failed", reason: "not_reported" })], false],
      ["a ready line after the stop", [notReady(stop), ready], false],
      ["no readiness line", ['{"event":"supervisor_started"}'], false],
      ["no failing list", ['{"event":"host_not_ready"}'], false],
      ["an empty failing list", [notReady()], false],
      ["an empty log", [""], false],
      ["a broken line", ['{"event":"host_not_ready","failing":['], false],
    ])("%s", (_name, lines, expected) => {
      expect(preparationStopOnly(lines.join("\n"))).toBe(expected);
    });
  });

  it("a failed compose up is rolled back too", async () => {
    const { engine } = fakeEngine(dir, { composeUp: [false, true] });
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "rolled_back" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
  });

  it("a watchdog-only release is applied: the stopped supervisor restarts and reports ready again", async () => {
    const onlyWatchdog = install(ORIGINAL_ENV.replace(OLD.supervisor, TARGET.supervisor).replace(OLD.runner, TARGET.runner));
    const { engine, live, calls } = fakeEngine(onlyWatchdog);
    expect(await runRunnerUpdate(engine, { dir: onlyWatchdog, ...fastClock() })).toMatchObject({ outcome: "updated", detail: "updated:watchdog" });
    expect(live()).toEqual(TARGET);
    // Only the replaced image is removed; the runner and supervisor it still runs are untouched.
    expect(calls.filter((c) => c.startsWith("rm:"))).toEqual([`rm:${OLD.watchdog}`]);
  });

  it("a machine already running the release, ready, records the generation without restarting anything", async () => {
    const same = install(ORIGINAL_ENV.replace(OLD.supervisor, TARGET.supervisor).replace(OLD.watchdog, TARGET.watchdog).replace(OLD.runner, TARGET.runner));
    const { engine, calls } = fakeEngine(same);
    expect(await runRunnerUpdate(engine, { dir: same, ...fastClock() })).toMatchObject({ outcome: "recorded", generation: 1 });
    expect(calls).toEqual(["read", "GET"]);
  });

  describe("an earlier run that stopped after writing .env is reconciled, never trusted", () => {
    const halfApplied = () => {
      const d = install(ORIGINAL_ENV.replace(OLD.supervisor, TARGET.supervisor).replace(OLD.watchdog, TARGET.watchdog).replace(OLD.runner, TARGET.runner));
      writeFileSync(join(d, PREVIOUS_ENV_FILE), ORIGINAL_ENV, { mode: 0o600 });
      return d;
    };

    it("old containers still running: it starts the release, waits for ready, then records", async () => {
      const d = halfApplied();
      const { engine, calls, live } = fakeEngine(d, { live: OLD });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "updated", detail: "reconciled", generation: 1 });
      expect(calls).toContain("up");
      expect(live()).toEqual(TARGET);
    });

    it("CTC-8745: old containers in a preparation stop are not the release waiting: it starts the release", async () => {
      const d = halfApplied();
      const { engine, calls, live } = fakeEngine(d, { live: OLD, preparationStop: (image) => image === OLD.supervisor });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "updated", detail: "reconciled" });
      expect(calls).toContain("up");
      expect(live()).toEqual(TARGET);
    });

    it("the release never becomes ready: it goes back to the file saved before it", async () => {
      const d = halfApplied();
      const { engine, live } = fakeEngine(d, { live: OLD, ready: (image) => image === OLD.supervisor });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock(), readyDeadlineMs: 20_000 })).toMatchObject({ outcome: "rolled_back", generation: null });
      expect(readFileSync(join(d, ".env"), "utf8")).toBe(ORIGINAL_ENV);
      expect(live()).toEqual(OLD);
    });
  });

  it("--check reads and plans, and writes nothing", async () => {
    const { engine, calls } = fakeEngine(dir);
    expect(await runRunnerUpdate(engine, { dir, check: true, ...fastClock() })).toMatchObject({ outcome: "planned", detail: "would_update:runner,supervisor,watchdog" });
    expect(calls).toEqual(["read"]);
    expect(existsSync(join(dir, RELEASE_STATE_FILE))).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
  });

  it("a revoked host retains and asks a person to look", async () => {
    const { engine } = fakeEngine(dir, { read: answered({ ok: false, refusal: "host_revoked", terminal: true }, 401) });
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "retained", detail: "credential_refused", exitCode: 1 });
  });

  describe("the lock", () => {
    it("a live owner keeps it, however old", async () => {
      writeFileSync(join(dir, "update.lock"), `${process.pid} 1\n`);
      const { engine, calls } = fakeEngine(dir);
      expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "retained", detail: "update_running" });
      expect(calls).toEqual([]);
    });

    it("a dead owner's lock is taken over", async () => {
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
      writeFileSync(join(dir, "update.lock"), `${dead} 1\n`);
      const { engine } = fakeEngine(dir);
      expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "updated" });
      expect(existsSync(join(dir, "update.lock"))).toBe(false);
    });
  });

  describe("Mac private thoughts storage", () => {
    function custodyInstall(): { dir: string; envAuthority: string } {
      // A runner directory where setup puts it, so the authority's native home is a real home.
      const base = mkdtempSync(join(tmpdir(), "custody-"));
      const d = join(base, "home", ".local", "runner");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "compose.yaml"), "name: catalyst-host\n");
      const authority = {
        version: 1 as const, installationId: "a".repeat(64),
        publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        nativeUid: 501, nativeGid: 20, nativeHome: join(d, "..", ".."), endpoint: "unix:///fixture/docker.sock", daemonId: "fixture-daemon",
        thoughtsRoot: join(d, "thoughts"), locksRoot: join(d, "locks"),
        requestsRoot: join(d, "..", "darwin-thoughts-requests"), responsesRoot: join(d, "..", "darwin-thoughts-responses"),
      };
      const envAuthority = canonicalDarwinThoughtsJson(authority);
      writeFileSync(join(d, ".env"), `${ORIGINAL_ENV}CATALYST_THOUGHTS_CUSTODY_AUTHORITY='${envAuthority}'\nCATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR=${authority.requestsRoot}\nCATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR=${authority.responsesRoot}\n`, { mode: 0o600 });
      return { dir: d, envAuthority };
    }
    const custodyCalls = (calls: string[]) => calls.filter((c) => c.startsWith("custody:"));

    it("POSITIVE CONTROL: installed storage is re-attested on the new supervisor before the supervisor stops, and the authority line is kept", async () => {
      const { dir: d, envAuthority } = custodyInstall();
      const { engine, calls } = fakeEngine(d, { custody: () => envAuthority });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "updated" });
      expect(custodyCalls(calls)).toEqual([`custody:${TARGET.supervisor}`]);
      expect(calls.indexOf(`custody:${TARGET.supervisor}`)).toBeLessThan(calls.indexOf("stop"));
      expect(readFileSync(join(d, ".env"), "utf8")).toContain(`CATALYST_THOUGHTS_CUSTODY_AUTHORITY='${envAuthority}'`);
    });

    it.each([
      ["is refused", { refused: "bootstrap_proof_refused:deadline" }, "custody_reattest_failed:bootstrap_proof_refused:deadline"],
      ["returns a different authority", "{}", "custody_reattest_failed:authority_changed"],
    ] as const)("NEGATIVE: when re-attestation %s, storage is attested back on the old supervisor, nothing else changes, and the detail says why", async (_label, answer, detail) => {
      const { dir: d, envAuthority } = custodyInstall();
      const before = readFileSync(join(d, ".env"), "utf8");
      const { engine, calls } = fakeEngine(d, { custody: (images) => (images.supervisor === TARGET.supervisor ? answer : envAuthority) });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "retained", detail });
      expect(readReleaseState(d).last).toMatchObject({ outcome: "retained", detail });
      expect(custodyCalls(calls)).toEqual([`custody:${TARGET.supervisor}`, `custody:${OLD.supervisor}`]);
      expect(calls).not.toContain("stop");
      expect(readFileSync(join(d, ".env"), "utf8")).toBe(before);
    });

    it("NEGATIVE: if storage cannot be attested back either, the run fails and asks a person to look", async () => {
      const { dir: d } = custodyInstall();
      const { engine } = fakeEngine(d, { custody: (images) => ({ refused: images.supervisor === TARGET.supervisor ? "bootstrap_cleanup_unproved" : "engine_authority_mismatch" }) });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "failed", detail: "custody_restore_failed:engine_authority_mismatch", exitCode: 1 });
    });

    it("NEGATIVE: a rollback whose storage cannot be attested back names the restore's reason", async () => {
      const { dir: d, envAuthority } = custodyInstall();
      const { engine } = fakeEngine(d, {
        custody: (images) => (images.supervisor === TARGET.supervisor ? envAuthority : { refused: "bootstrap_signed_receipt_unavailable" }),
        ready: (image) => image === OLD.supervisor,
      });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock(), readyDeadlineMs: 20_000 }))
        .toMatchObject({ outcome: "failed", detail: "custody_restore_failed:bootstrap_signed_receipt_unavailable", exitCode: 1 });
    });

    it("a rollback attests storage back on the old supervisor too", async () => {
      const { dir: d, envAuthority } = custodyInstall();
      const { engine, calls } = fakeEngine(d, { custody: () => envAuthority, ready: (image) => image === OLD.supervisor });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock(), readyDeadlineMs: 20_000 })).toMatchObject({ outcome: "rolled_back" });
      expect(custodyCalls(calls)).toEqual([`custody:${TARGET.supervisor}`, `custody:${OLD.supervisor}`]);
    });

    it("a phase that started during preparation also attests storage back", async () => {
      const { dir: d, envAuthority } = custodyInstall();
      const { engine, calls } = fakeEngine(d, { custody: () => envAuthority, busy: [0, 1] });
      expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "deferred_busy" });
      expect(custodyCalls(calls)).toEqual([`custody:${TARGET.supervisor}`, `custody:${OLD.supervisor}`]);
    });

    it("without custody there is no re-attestation", async () => {
      const { engine, calls } = fakeEngine(dir);
      await runRunnerUpdate(engine, { dir, ...fastClock() });
      expect(custodyCalls(calls)).toEqual([]);
    });
  });
});

// CTC-6709: a release whose supervisor reads the same journal as the one a failure goes back to is
// taken with phases running; any other release still waits for an idle machine.
describe("the schedule takes a newer release only in an update window (CTC-6709)", () => {
  let dir: string;
  beforeEach(() => { dir = install(); });
  const window = (lastOpenedMs: number) => ({ lastOpenedMs, nextOpensMs: lastOpenedMs + 5 * 3_600_000 });
  const GEN2 = answered(release({ generation: 2, digits: ["4", "5", "6"] }));
  const W1 = 1_800_000_000_000;
  const W2 = W1 + 5 * 3_600_000;
  /** Apply generation 1 on the schedule in window W1, which settles it. */
  const settleW1 = async () => {
    expect(await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock(), window: window(W1) })).toMatchObject({ outcome: "updated", generation: 1 });
    expect(readReleaseState(dir).windowSettledMs).toBe(W1);
  };

  it("POSITIVE CONTROL: a newer release seen later in a settled window waits for the next one, then applies there", async () => {
    await settleW1();
    const waiting = fakeEngine(dir, { read: GEN2 });
    const result = await runRunnerUpdate(waiting.engine, { dir, ...fastClock(), window: window(W1) });
    expect(result).toMatchObject({ outcome: "waiting_window", detail: `next_window:${new Date(W2).toISOString()}`, generation: 1, exitCode: 0 });
    expect(waiting.calls).toEqual(["read"]);
    expect(imagesIn(readFileSync(join(dir, ".env"), "utf8"))).toEqual(TARGET);
    expect(readReleaseState(dir)).toMatchObject({ generation: 1, windowSettledMs: W1, last: { outcome: "waiting_window" } });

    const next = fakeEngine(dir, { read: GEN2 });
    expect(await runRunnerUpdate(next.engine, { dir, ...fastClock(), window: window(W2) })).toMatchObject({ outcome: "updated", generation: 2 });
    expect(readReleaseState(dir).windowSettledMs).toBe(W2);
  });

  it("a check that finds nothing pending settles the window, so a release approved after it waits", async () => {
    await settleW1();
    expect(await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock(), window: window(W2) })).toMatchObject({ outcome: "current" });
    expect(readReleaseState(dir).windowSettledMs).toBe(W2);
    expect(await runRunnerUpdate(fakeEngine(dir, { read: GEN2 }).engine, { dir, ...fastClock(), window: window(W2) }))
      .toMatchObject({ outcome: "waiting_window" });
  });

  it("an owner's own run (no window) applies the waiting release at once", async () => {
    await settleW1();
    expect(await runRunnerUpdate(fakeEngine(dir, { read: GEN2 }).engine, { dir, ...fastClock() })).toMatchObject({ outcome: "updated", generation: 2 });
    // The owner's run settles no window.
    expect(readReleaseState(dir).windowSettledMs).toBe(W1);
  });

  it("a machine with no settled window yet takes a release on its first scheduled run", async () => {
    expect(readReleaseState(dir).windowSettledMs).toBeNull();
    await settleW1();
  });

  it("a busy deferral leaves the window open, so the next check in it tries again", async () => {
    await settleW1();
    expect(await runRunnerUpdate(fakeEngine(dir, { read: GEN2, busy: [1] }).engine, { dir, ...fastClock(), window: window(W2) }))
      .toMatchObject({ outcome: "deferred_busy" });
    expect(readReleaseState(dir).windowSettledMs).toBe(W1);
    expect(await runRunnerUpdate(fakeEngine(dir, { read: GEN2 }).engine, { dir, ...fastClock(), window: window(W2) }))
      .toMatchObject({ outcome: "updated", generation: 2 });
  });

  it("a rolled-back update settles the window, so the supervisor is not restarted again until the next one", async () => {
    await settleW1();
    const failing = fakeEngine(dir, { read: GEN2, ready: (image) => image !== ref("supervisor", "5") });
    expect(await runRunnerUpdate(failing.engine, { dir, ...fastClock(), readyDeadlineMs: 20_000, window: window(W2) }))
      .toMatchObject({ outcome: "rolled_back" });
    expect(readReleaseState(dir).windowSettledMs).toBe(W2);
    const again = fakeEngine(dir, { read: GEN2 });
    expect(await runRunnerUpdate(again.engine, { dir, ...fastClock(), window: window(W2) })).toMatchObject({ outcome: "waiting_window" });
    expect(again.calls).not.toContain("stop");
  });

  it("drift on the applied generation is put right between windows", async () => {
    await settleW1();
    writeFileSync(join(dir, ".env"), ORIGINAL_ENV, { mode: 0o600 });
    expect(await runRunnerUpdate(fakeEngine(dir).engine, { dir, ...fastClock(), window: window(W1) })).toMatchObject({ outcome: "updated", generation: 1 });
    expect(imagesIn(readFileSync(join(dir, ".env"), "utf8"))).toEqual(TARGET);
  });
});

describe("an update in place, decided by the supervisor's journal format", () => {
  const withFormat = (format: unknown, component: ReleaseComponent = "supervisor") =>
    (b: Record<string, unknown>) => { (b[component] as Record<string, unknown>).journalFormat = format; };
  const NEXT: Images = { runner: ref("runner", "4"), supervisor: ref("supervisor", "5"), watchdog: ref("watchdog", "6") };
  const next = (format?: number) =>
    answered(release({ generation: 2, digits: ["4", "5", "6"], mutate: format === undefined ? undefined : withFormat(format) }));
  /** A machine that applied generation 1, whose release named `format` (or none). */
  const applied = async (format?: number) => {
    const d = install();
    const read = answered(release({ mutate: format === undefined ? undefined : withFormat(format) }));
    expect(await runRunnerUpdate(fakeEngine(d, { read }).engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "updated", generation: 1 });
    return d;
  };

  it("the supervisor's format is parsed; a malformed one, or one on another image, refuses the release", () => {
    expect(parseDesiredRelease(release({ mutate: withFormat(2) }))).toMatchObject({ journalFormat: 2 });
    expect(parseDesiredRelease(release())).toMatchObject({ journalFormat: null });
    for (const bad of [0, -1, 1.5, "2", null]) expect(parseDesiredRelease(release({ mutate: withFormat(bad) }))).toBeNull();
    expect(parseDesiredRelease(release({ mutate: withFormat(2, "runner") }))).toBeNull();
    expect(parseDesiredRelease(release({ mutate: withFormat(2, "watchdog") }))).toBeNull();
  });

  it("an applied release records its supervisor's format; one that names none records nothing", async () => {
    expect(readReleaseState(await applied(2)).journal).toEqual({ format: 2, supervisor: TARGET.supervisor });
    expect(readReleaseState(await applied()).journal).toBeNull();
  });

  it("a release an older CLI applied without a format gets it recorded once its supervisor is seen running", async () => {
    const d = await applied(2);
    const state = JSON.parse(readFileSync(join(d, RELEASE_STATE_FILE), "utf8"));
    writeFileSync(join(d, RELEASE_STATE_FILE), JSON.stringify({ ...state, journal: null }));
    const read = answered(release({ mutate: withFormat(2) }));
    // --check never writes.
    expect(await runRunnerUpdate(fakeEngine(d, { read }).engine, { dir: d, check: true })).toMatchObject({ outcome: "current" });
    expect(readReleaseState(d).journal).toBeNull();
    const seen = fakeEngine(d, { read });
    expect(await runRunnerUpdate(seen.engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "current", detail: "not_newer" });
    expect(seen.calls).toEqual(["read"]);
    expect(readReleaseState(d).journal).toEqual({ format: 2, supervisor: TARGET.supervisor });
    // So the next release with the same format goes in place, with phases running.
    expect(await runRunnerUpdate(fakeEngine(d, { read: next(2), busy: [2, 2] }).engine, { dir: d, ...fastClock() }))
      .toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor,watchdog:in_place" });
  });

  it("POSITIVE CONTROL: the same format with phases running updates in place and never looks for phases", async () => {
    const d = await applied(2);
    const { engine, calls, live } = fakeEngine(d, { read: next(2), busy: [2, 2] });
    const result = await runRunnerUpdate(engine, { dir: d, ...fastClock() });
    expect(result).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor,watchdog:in_place", generation: 2 });
    expect(calls.some((c) => c.startsWith("attempts:"))).toBe(false);
    expect(calls).toEqual(["read", "prepare:3", "stop", "up", `rm:${TARGET.runner},${TARGET.supervisor},${TARGET.watchdog}`]);
    expect(live()).toEqual(NEXT);
    expect(readReleaseState(d).journal).toEqual({ format: 2, supervisor: NEXT.supervisor });
  });

  it("the runner image under phases left running is kept and removed by a later run once they finish", async () => {
    const d = await applied(2);
    const busy = fakeEngine(d, { read: next(2), inUse: (image) => image === TARGET.runner });
    expect(await runRunnerUpdate(busy.engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "updated", generation: 2 });
    expect(readReleaseState(d).pendingRemoval).toEqual([TARGET.runner]);
    // Still running at the next check: kept again.
    const stillBusy = fakeEngine(d, { read: next(2), inUse: (image) => image === TARGET.runner });
    expect(await runRunnerUpdate(stillBusy.engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "current" });
    expect(stillBusy.calls).toEqual([`rm:${TARGET.runner}`, "read"]);
    expect(readReleaseState(d).pendingRemoval).toEqual([TARGET.runner]);
    // The phases finished: the next check frees it.
    const idle = fakeEngine(d, { read: next(2) });
    expect(await runRunnerUpdate(idle.engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "current" });
    expect(idle.calls).toEqual([`rm:${TARGET.runner}`, "read"]);
    expect(readReleaseState(d).pendingRemoval).toEqual([]);
  });

  it("a pending image that .env names again is never removed and stays pending", async () => {
    const d = await applied(2);
    await runRunnerUpdate(fakeEngine(d, { read: next(2), inUse: (image) => image === TARGET.runner }).engine, { dir: d, ...fastClock() });
    writeFileSync(join(d, ".env"), rewriteEnvText(readFileSync(join(d, ".env"), "utf8"), { CATALYST_RUNNER_IMAGE: TARGET.runner }), { mode: 0o600 });
    const after = fakeEngine(d, { read: { kind: "unreachable", detail: "TimeoutError", hostId: "host_abc" } });
    expect(await runRunnerUpdate(after.engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "retained" });
    expect(after.calls).toEqual(["read"]);
    expect(readReleaseState(d).pendingRemoval).toEqual([TARGET.runner]);
  });

  it.each([
    ["a newer format", 2, 3],
    ["a release that names no format", 2, undefined],
    ["a machine whose applied release named none", undefined, 2],
  ])("NEGATIVE: %s waits for an idle machine", async (_label, before, after) => {
    const d = await applied(before);
    const { engine, calls } = fakeEngine(d, { read: next(after), busy: [1] });
    expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "deferred_busy", detail: "phases_running:1,deferred_for_ms:0" });
    expect(calls).not.toContain("stop");
  });

  it("NEGATIVE: a supervisor in .env other than the recorded one waits, since a failure would go back to it", async () => {
    const d = await applied(2);
    writeFileSync(join(d, ".env"), rewriteEnvText(readFileSync(join(d, ".env"), "utf8"), { CATALYST_SUPERVISOR_IMAGE: OLD.supervisor }), { mode: 0o600 });
    const { engine } = fakeEngine(d, { read: next(2), busy: [1] });
    expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "deferred_busy" });
  });

  it("an in-place update whose supervisor never reports ready goes back to the previous release, still without looking for phases", async () => {
    const d = await applied(2);
    const { engine, calls, live } = fakeEngine(d, { read: next(2), busy: [1, 1], ready: (image) => image !== NEXT.supervisor });
    expect(await runRunnerUpdate(engine, { dir: d, ...fastClock(), readyDeadlineMs: 20_000 })).toMatchObject({ outcome: "rolled_back", exitCode: 1 });
    expect(calls.some((c) => c.startsWith("attempts:"))).toBe(false);
    expect(live()).toEqual(TARGET);
    expect(readReleaseState(d)).toMatchObject({ generation: 1, journal: { format: 2, supervisor: TARGET.supervisor } });
  });
});

describe("the update schedule", () => {
  const recorder = () => {
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "" };
      if (cmd === "loginctl") return { status: 0, stdout: "Linger=no\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  };

  it("macOS: a LaunchAgent every 15 minutes that runs only this CLI's update, with docker on PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { calls, run } = recorder();
    const status = enableAutoUpdate({ platform: "darwin", home, uid: 501, cli: "/opt/homebrew/bin/catalyst", path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", run }, "/Users/x/.local/state/catalyst/runner");
    expect(status).toMatchObject({ state: "on" });
    const plist = readFileSync(launchAgentPath(home), "utf8");
    expect(plist).toBe(launchAgentPlist({ cli: "/opt/homebrew/bin/catalyst", path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", home }, "/Users/x/.local/state/catalyst/runner"));
    expect(plist).toContain("<string>/opt/homebrew/bin/catalyst</string><string>runner</string><string>update</string><string>--auto</string><string>--dir</string>");
    expect(plist).toContain("<key>StartCalendarInterval</key><array><dict><key>Minute</key><integer>0</integer></dict><dict><key>Minute</key><integer>15</integer></dict><dict><key>Minute</key><integer>30</integer></dict><dict><key>Minute</key><integer>45</integer></dict></array>");
    expect(plist).not.toContain("StartInterval</key><integer>");
    expect(plist).toContain("<key>ProcessType</key><string>Standard</string>");
    expect(calls).toContain(`launchctl bootstrap gui/501 ${launchAgentPath(home)}`);
    disableAutoUpdate({ platform: "darwin", home, uid: 501, cli: "x", path: "x", run });
    expect(existsSync(launchAgentPath(home))).toBe(false);
    expect(calls).toContain("launchctl bootout gui/501/dev.catalystcloud.runner-update");
  });

  it("Linux: a systemd user timer, and it says when lingering is off", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { calls, run } = recorder();
    const status = enableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "/usr/local/bin/catalyst", path: "/usr/local/bin:/usr/bin:/bin", run }, "/home/x/.local/state/catalyst/runner");
    expect(status).toMatchObject({ state: "on", detail: "timer_enabled_without_linger", linger: false });
    // It tried to turn lingering on itself, without sudo and without a password prompt.
    expect(calls).toContain("loginctl --no-ask-password enable-linger");
    const units = systemdUnits({ cli: "/usr/local/bin/catalyst", path: "/usr/local/bin:/usr/bin:/bin" }, "/home/x/.local/state/catalyst/runner");
    expect(readFileSync(systemdUnitPaths(home).service, "utf8")).toBe(units.service);
    expect(units.service).toContain('ExecStart="/usr/local/bin/catalyst" "runner" "update" "--auto" "--dir" "/home/x/.local/state/catalyst/runner"');
    expect(units.timer).toContain("OnCalendar=*:0/15");
    // Never a monotonic trigger: it stops firing when the user manager restarts without a reboot.
    expect(units.timer).not.toMatch(/OnBootSec|OnUnitActiveSec|OnStartupSec/);
    expect(calls).toContain("systemctl --user enable --now catalyst-runner-update.timer");
    disableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "x", path: "x", run });
    expect(existsSync(systemdUnitPaths(home).timer)).toBe(false);
  });

  it("Linux: setup turns lingering on itself when the machine allows it (CTC-6264)", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const calls: string[] = [];
    let linger = false;
    const run: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "loginctl" && args.includes("enable-linger")) linger = true;
      if (cmd === "loginctl" && args[0] === "show-user") return { status: 0, stdout: `Linger=${linger ? "yes" : "no"}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const status = enableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "c", path: "/bin", run }, "/d");
    expect(status).toMatchObject({ state: "on", detail: "timer_enabled", linger: true, lingerTurnedOn: true });
    expect(calls.filter((c) => c.includes("enable-linger"))).toEqual(["loginctl --no-ask-password enable-linger"]);
    expect(calls.indexOf("loginctl --no-ask-password enable-linger")).toBeGreaterThan(calls.indexOf("systemctl --user enable --now catalyst-runner-update.timer"));
  });

  it("Linux: lingering already on is left alone", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" };
    };
    const status = enableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "c", path: "/bin", run }, "/d");
    expect(status).toMatchObject({ state: "on", linger: true });
    expect(status).not.toHaveProperty("lingerTurnedOn");
    expect(calls.some((c) => c.includes("enable-linger"))).toBe(false);
  });

  it("Linux off reports lingering and leaves it as it is", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const calls: string[] = [];
    const run: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { status: 0, stdout: cmd === "loginctl" ? "Linger=yes\n" : "", stderr: "" };
    };
    expect(disableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "c", path: "/bin", run })).toMatchObject({ state: "off", detail: "timer_removed", linger: true });
    expect(calls.some((c) => c.includes("disable-linger") || c.includes("enable-linger"))).toBe(false);
  });

  it("Linux status reads lingering and never changes it", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { calls, run } = recorder();
    enableAutoUpdate({ platform: "linux", home, uid: 1000, cli: "c", path: "/bin", run }, "/d");
    calls.length = 0;
    expect(autoUpdateStatus({ platform: "linux", home, uid: 1000, cli: "c", path: "/bin", run })).toMatchObject({ state: "on", detail: "timer_enabled_without_linger", linger: false });
    expect(calls).toContain("loginctl show-user 1000 --property=Linger");
    expect(calls.some((c) => c.includes("enable-linger"))).toBe(false);
  });

  it("Linux without a user manager is unsupported, and writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const run: SchedulerRun = () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus" });
    expect(enableAutoUpdate({ platform: "linux", home, cli: "c", path: "/bin", run }, "/d")).toMatchObject({ state: "unsupported" });
    expect(existsSync(systemdUnitPaths(home).timer)).toBe(false);
  });

  // CTC-6384: a supervisor fleet host's schedule runs the fleet update on the directory that holds compose.json.
  const FLEET_DIR = "/srv/catalyst/supervisor-fleet-config";

  it("a supervisor fleet's schedule runs the fleet update, in the plist and in the systemd service (CTC-6384)", () => {
    const plist = launchAgentPlist({ cli: "/opt/homebrew/bin/catalyst", path: "/usr/bin:/bin", home: "/Users/x" }, FLEET_DIR, true);
    expect(plist).toContain(`<array><string>/opt/homebrew/bin/catalyst</string><string>runner</string><string>update</string><string>--auto</string><string>--fleet</string><string>--dir</string><string>${FLEET_DIR}</string></array>`);
    const deps = { cli: "/usr/local/bin/catalyst", path: "/usr/bin:/bin" };
    const units = systemdUnits(deps, FLEET_DIR, true);
    expect(units.service).toContain(`\nExecStart="/usr/local/bin/catalyst" "runner" "update" "--auto" "--fleet" "--dir" "${FLEET_DIR}"\n`);
    // Only the command changes: the timer is the single runner's.
    expect(units.timer).toBe(systemdUnits(deps, FLEET_DIR).timer);
  });

  it("a single runner's schedule is byte for byte what it was before the fleet flag (CTC-6384)", () => {
    const deps = { cli: "/usr/local/bin/catalyst", path: "/usr/local/bin:/usr/bin:/bin" };
    const dir = "/home/x/.local/state/catalyst/runner";
    const units = systemdUnits(deps, dir);
    expect(units.service).toBe([
      "[Unit]",
      "Description=Catalyst runner update",
      "",
      "[Service]",
      "Type=oneshot",
      'Environment="PATH=/usr/local/bin:/usr/bin:/bin"',
      'ExecStart="/usr/local/bin/catalyst" "runner" "update" "--auto" "--dir" "/home/x/.local/state/catalyst/runner"',
      "",
    ].join("\n"));
    expect(units.timer).toBe([
      "[Unit]",
      "Description=Check for an approved Catalyst runner release every 15 minutes",
      "",
      "[Timer]",
      "OnCalendar=*:0/15",
      "RandomizedDelaySec=60",
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"));
    expect(systemdUnits(deps, dir, false)).toEqual(units);
    const mac = { cli: "/opt/homebrew/bin/catalyst", path: "/opt/homebrew/bin:/usr/bin:/bin", home: "/Users/x" };
    const macDir = "/Users/x/.local/state/catalyst/runner";
    expect(launchAgentPlist(mac, macDir)).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>Label</key><string>dev.catalystcloud.runner-update</string>",
      "<key>ProgramArguments</key><array><string>/opt/homebrew/bin/catalyst</string><string>runner</string><string>update</string><string>--auto</string><string>--dir</string><string>/Users/x/.local/state/catalyst/runner</string></array>",
      "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>HOME</key><string>/Users/x</string></dict>",
      "<key>StartCalendarInterval</key><array><dict><key>Minute</key><integer>0</integer></dict><dict><key>Minute</key><integer>15</integer></dict><dict><key>Minute</key><integer>30</integer></dict><dict><key>Minute</key><integer>45</integer></dict></array>",
      "<key>ProcessType</key><string>Standard</string>",
      "<key>StandardOutPath</key><string>/Users/x/.local/state/catalyst/runner/update.log</string>",
      "<key>StandardErrorPath</key><string>/Users/x/.local/state/catalyst/runner/update.log</string>",
      "</dict></plist>",
      "",
    ].join("\n"));
    expect(launchAgentPlist(mac, macDir, false)).toBe(launchAgentPlist(mac, macDir));
  });

  it("Linux: on with fleet writes the fleet service, and status reads the fleet and its directory back (CTC-6384)", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { run } = recorder();
    const deps = { platform: "linux" as const, home, uid: 1000, cli: "/usr/local/bin/catalyst", path: "/usr/bin:/bin", run };
    expect(enableAutoUpdate(deps, FLEET_DIR, { fleet: true })).toMatchObject({ state: "on", fleet: true, dir: FLEET_DIR });
    expect(readFileSync(systemdUnitPaths(home).service, "utf8")).toBe(systemdUnits(deps, FLEET_DIR, true).service);
    expect(autoUpdateStatus(deps)).toMatchObject({ state: "on", detail: "timer_enabled_without_linger", fleet: true, dir: FLEET_DIR });
    // POSITIVE CONTROL: the same home turned back to a single runner's schedule reads back as no fleet.
    expect(enableAutoUpdate(deps, "/d")).toMatchObject({ state: "on", fleet: false, dir: "/d" });
    expect(autoUpdateStatus(deps)).toMatchObject({ state: "on", fleet: false, dir: "/d" });
  });

  it("macOS: on with fleet loads the fleet plist, and status reads the fleet and its directory back (CTC-6384)", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    let loaded = false;
    const run: SchedulerRun = (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootstrap") loaded = true;
      return { status: cmd === "launchctl" && args[0] === "print" && !loaded ? 113 : 0, stdout: "", stderr: "" };
    };
    const deps = { platform: "darwin" as const, home, uid: 501, cli: "/opt/homebrew/bin/catalyst", node: null, path: "/usr/bin:/bin", run };
    expect(enableAutoUpdate(deps, FLEET_DIR, { fleet: true })).toMatchObject({ state: "on", fleet: true, dir: FLEET_DIR });
    expect(readFileSync(launchAgentPath(home), "utf8")).toBe(launchAgentPlist(deps, FLEET_DIR, true));
    expect(autoUpdateStatus(deps)).toMatchObject({ state: "on", detail: "launch_agent_loaded", fleet: true, dir: FLEET_DIR });
  });
});

describe("lastProblemLines (CTC-6709)", () => {
  const state = (last: { outcome: UpdateOutcome; detail: string; generation: number | null } | null): ReleaseState =>
    ({ version: 1, kept: null, generation: 105, releaseId: null, appliedAtMs: null, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      deferral: null, drain: null,
      last: last === null ? null : { atMs: Date.UTC(2026, 9, 24, 4, 30), ...last } });

  it("POSITIVE CONTROL: a rolled-back update is named with its time, reason and offered generation", () => {
    expect(lastProblemLines(state({ outcome: "rolled_back", detail: "supervisor_not_ready", generation: 106 })))
      .toEqual(["The last update, at 2026-10-24T04:30:00.000Z, was rolled back (supervisor_not_ready; offered generation 106)."]);
  });

  it("a failed update with no offered generation says none", () => {
    expect(lastProblemLines(state({ outcome: "failed", detail: "compose_up_failed", generation: null })))
      .toEqual(["The last update, at 2026-10-24T04:30:00.000Z, failed (compose_up_failed; offered generation none)."]);
  });

  it.each([["updated"], ["current"], ["deferred_busy"], ["draining_for_update"], ["drain_soft_limit"], ["drain_unavailable"], ["waiting_window"], ["retained"]] as const)(
    "NEGATIVE: a last run that %s is no problem to name",
    (outcome) => {
      expect(lastProblem(state({ outcome, detail: "x", generation: 106 }))).toBeNull();
      expect(lastProblemLines(state({ outcome, detail: "x", generation: 106 }))).toEqual([]);
    },
  );

  it("NEGATIVE: a machine that never ran an update has nothing to name", () => {
    expect(lastProblemLines(state(null))).toEqual([]);
  });
});

describe("updateReport (CTC-6924)", () => {
  const state = (last: { outcome: UpdateOutcome; detail: string; generation: number | null } | null, generation: number | null = 105): ReleaseState =>
    ({ version: 1, kept: null, generation, releaseId: null, appliedAtMs: null, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      deferral: null, drain: null,
      last: last === null ? null : { atMs: 1_800_000_000_000, ...last } });

  it("before any run there is nothing to report", () => {
    expect(updateReport(state(null), "0.16.34")).toBeUndefined();
  });

  it("POSITIVE CONTROL: a refused custody check reports its reason, both generations and the CLI version", () => {
    expect(JSON.parse(updateReport(state({ outcome: "retained", detail: "custody_reattest_failed:bootstrap_proof_refused:deadline", generation: 106 }), "0.16.34")!))
      .toEqual({ v: 1, outcome: "retained", detail: "custody_reattest_failed:bootstrap_proof_refused:deadline", applied: 105, offered: 106, atMs: 1_800_000_000_000, cli: "0.16.34" });
  });

  it("characters the cloud would refuse become _, so an image reference cannot cost the report", () => {
    const report = JSON.parse(updateReport(state({ outcome: "retained", detail: "image_unverified:ghcr.io/coalesce-labs/catalyst-runner@sha256:AB", generation: 106 }), "0.16.34")!);
    expect(report.detail).toBe("image_unverified:ghcr.io_coalesce-labs_catalyst-runner_sha256:ab");
    expect(report.detail).toMatch(/^[a-z0-9_:,.-]{0,160}$/);
  });

  it("a long detail is cut to 160 characters, and a version that is not one reports null", () => {
    const report = JSON.parse(updateReport(state({ outcome: "failed", detail: "x".repeat(300), generation: null }, null), "dev")!);
    expect(report.detail).toHaveLength(160);
    expect(report).toMatchObject({ applied: null, offered: null, cli: null });
  });
});
