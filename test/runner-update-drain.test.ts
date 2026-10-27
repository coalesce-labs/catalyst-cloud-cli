import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTODY_UNATTESTED_LINE, DRAIN_AFTER_MS, DRAIN_SOFT_LIMIT_MS, lastProblemLines, readReleaseState, RELEASE_STATE_FILE, releaseLock,
  releaseUpdateDrain, runRunnerUpdate, takeLock, updateResultLines, writeReleaseState, type UpdateResult } from "../src/runner-update";
import { main } from "../src/cli";
import { canonicalDarwinThoughtsJson } from "../vendor/self-host/darwin-thoughts-custody/verifier.mjs";
import { makeCtx, tempHome } from "./helpers";
import { answered, fakeDrainCloud, fakeEngine, imagesIn, install, OLD, ORIGINAL_ENV, release, TARGET, type FakeOptions, type Images } from "./runner-update-fixtures";

const A = 1_800_000_000_000;
const FIFTEEN_MINUTES = 15 * 60_000;
function machine() {
  const dir = install();
  writeReleaseState(dir, { ...readReleaseState(dir), generation: 102, journal: null });
  return dir;
}
/** A machine on 102 with Mac private thoughts storage installed where setup puts it. */
function custodyMachine(): { dir: string; authority: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "custody-")), "home", ".local", "runner");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  const authority = canonicalDarwinThoughtsJson({
    version: 1 as const, installationId: "a".repeat(64),
    publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    nativeUid: 501, nativeGid: 20, nativeHome: join(dir, "..", ".."), endpoint: "unix:///fixture/docker.sock", daemonId: "fixture-daemon",
    thoughtsRoot: join(dir, "thoughts"), locksRoot: join(dir, "locks"),
    requestsRoot: join(dir, "..", "darwin-thoughts-requests"), responsesRoot: join(dir, "..", "darwin-thoughts-responses"),
  });
  writeFileSync(join(dir, ".env"), `${ORIGINAL_ENV}CATALYST_THOUGHTS_CUSTODY_AUTHORITY='${authority}'\n` +
    `CATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR=${join(dir, "..", "darwin-thoughts-requests")}\n` +
    `CATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR=${join(dir, "..", "darwin-thoughts-responses")}\n`, { mode: 0o600 });
  writeReleaseState(dir, { ...readReleaseState(dir), generation: 102, journal: null });
  return { dir, authority };
}
/** Custody that holds the installed authority on the target images and refuses `refusal` on any other. */
const keepsAuthority = (refusal: string, authority: string) => (images: Images) =>
  images.supervisor === TARGET.supervisor ? authority : { refused: refusal };
function clock(start = A) {
  let time = start;
  return { now: () => time, sleep: async (ms: number) => { time += ms; }, advance: (ms: number) => { time += ms; } };
}
const offered = () => answered(release({ generation: 106 }));

describe("CTC-7749: a busy machine drains and takes an approved release", () => {
  it("waits a day, requests the drain, preserves phases, applies after both counts are zero, and releases", async () => {
    const dir = machine();
    const time = clock();
    const phaseEnd = A + DRAIN_AFTER_MS + 3 * 3_600_000;
    const cloud = fakeDrainCloud({ live: () => time.now() < phaseEnd + 5_000 ? 1 : 0, now: time.now });
    const phaseCount = () => time.now() < phaseEnd ? 2 : 0;
    const before = readFileSync(join(dir, ".env"), "utf8");
    const seen: UpdateResult[] = [];
    const phaseOne = fakeEngine(dir, { read: offered(), phases: phaseCount, drain: cloud.call });
    for (let step = 0; step < 96; step++) {
      const result = await runRunnerUpdate(phaseOne.engine, { dir, drain: true, now: time.now, sleep: time.sleep });
      expect(result.outcome).toBe("deferred_busy");
      time.advance(FIFTEEN_MINUTES);
    }
    expect(cloud.calls).toEqual([]);
    expect(phaseOne.calls).not.toContain("stop");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);

    const running = fakeEngine(dir, { read: offered(), phases: phaseCount, drain: cloud.call });
    const result = await runRunnerUpdate(running.engine, { dir, drain: true, now: time.now, sleep: time.sleep,
      onPass: (pass) => {
        seen.push(pass);
        expect(readReleaseState(dir).windowSettledMs).toBeNull();
        if (time.now() < phaseEnd) {
          expect(running.calls).not.toContain("stop");
          expect(running.calls).not.toContain("up");
          expect(cloud.calls).not.toContain("release");
          expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
        }
      } });
    expect(result).toMatchObject({ outcome: "updated", generation: 106, exitCode: 0 });
    expect(seen[0]?.outcome).toBe("draining_for_update");
    expect(seen[0]?.detail).toContain("draining_for_ms:0");
    expect(seen[1]?.detail).toContain("draining_for_ms:900000");
    expect(cloud.calls.slice(0, 2)).toEqual(["GET", "request:106"]);
    expect(cloud.calls.at(-1)).toBe("release");
    expect(cloud.status()).toMatchObject({ revision: 2, drain: null });
    expect(readReleaseState(dir)).toMatchObject({ generation: 106, drain: null, deferral: null });
    expect(imagesIn(readFileSync(join(dir, ".env"), "utf8"))).toEqual(TARGET);
    expect(running.calls.indexOf("stop")).toBeGreaterThan(running.calls.indexOf("request:106"));
    expect(running.calls.indexOf("up")).toBeGreaterThan(running.calls.indexOf("stop"));
    expect(running.reports.filter(Boolean).some((raw) => JSON.parse(raw!).outcome === "draining_for_update")).toBe(true);
  }, 15_000);

  it("approval age alone triggers the drain on the first busy look", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 2, now: time.now });
    const abort = new AbortController();
    const fake = fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: async () => { abort.abort(); }, signal: abort.signal });
    expect(result.outcome).toBe("draining_for_update");
    expect(cloud.calls.slice(0, 2)).toEqual(["GET", "request:106"]);
  });

  it("a newer approval cannot postpone a day's accumulated busy deferrals", async () => {
    const dir = machine();
    const time = clock(A);
    const cloud = fakeDrainCloud({ live: () => 2, now: time.now });
    const busy = () => 2;
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: busy, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, sleep: time.sleep });
    time.advance(20 * 3_600_000);
    const newer = () => answered(release({ generation: 107, digits: ["4", "5", "6"] }));
    const second = await runRunnerUpdate(fakeEngine(dir, { read: newer(), phases: busy, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, sleep: time.sleep });
    expect(second).toMatchObject({ outcome: "deferred_busy", offeredGeneration: 107 });
    expect(readReleaseState(dir).deferral).toMatchObject({ sinceMs: A, offered: 107, offeredSinceMs: A + 20 * 3_600_000 });
    time.advance(4 * 3_600_000);
    const abort = new AbortController();
    const final = await runRunnerUpdate(fakeEngine(dir, { read: newer(), phases: busy, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    expect(final).toMatchObject({ outcome: "draining_for_update", offeredGeneration: 107 });
    expect(cloud.calls).toContain("request:107");
  });

  it("below a day and on a person's run never asks the cloud for a drain", async () => {
    const dir = machine();
    const cloud = fakeDrainCloud({ live: () => 2 });
    const fake = fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: () => A + DRAIN_AFTER_MS - FIFTEEN_MINUTES })).toMatchObject({ outcome: "deferred_busy" });
    expect(cloud.calls).toEqual([]);
    expect(await runRunnerUpdate(fake.engine, { dir, now: () => A + DRAIN_AFTER_MS + 3_600_000 })).toMatchObject({ outcome: "deferred_busy" });
    expect(cloud.calls).toEqual([]);
  });

  it("a release with the applied journal format updates in place without a drain", async () => {
    const dir = machine();
    const withFormat = (generation: number, digits: [string, string, string]) => answered(release({ generation, digits,
      mutate: (body) => { (body.supervisor as Record<string, unknown>).journalFormat = 2; } }));
    expect(await runRunnerUpdate(fakeEngine(dir, { read: withFormat(102, ["1", "2", "3"]) }).engine,
      { dir, now: () => A })).toMatchObject({ outcome: "updated", generation: 102 });
    const cloud = fakeDrainCloud({ live: () => 2 });
    const fake = fakeEngine(dir, { read: withFormat(106, ["4", "5", "6"]), phases: () => 2, drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: () => A + DRAIN_AFTER_MS })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(fake.calls).not.toContain("attempts:host_abc");
    // The applied release reads the drain once (CTC-8077) and requests none.
    expect(cloud.calls).toEqual(["GET"]);
  });

  it.each([
    ["missing route", { kind: "answered", status: 404, body: null, hostId: "host_abc" }],
    ["service unavailable", { kind: "answered", status: 503, body: { ok: false, refusal: "update_drain_unavailable" }, hostId: "host_abc" }],
    ["unreachable route", { kind: "unreachable", detail: "TimeoutError", hostId: "host_abc" }],
  ] as const)("%s gives a recoverable drain_unavailable and keeps the images", async (_label, refusal) => {
    const dir = machine();
    const cloud = fakeDrainCloud({ live: () => 2, refuse: () => refusal });
    const fake = fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: () => A + DRAIN_AFTER_MS });
    expect(result).toMatchObject({ outcome: "drain_unavailable", exitCode: 0 });
    expect(result.detail).toContain("phases_running:2");
    expect(fake.calls).not.toContain("stop");
    expect(imagesIn(readFileSync(join(dir, ".env"), "utf8"))).toEqual(OLD);
    expect(readReleaseState(dir).drain).toBeNull();
    expect(readReleaseState(dir).windowSettledMs).toBeNull();
  });

  it("a request conflict leaves no local drain and never stops a phase", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 2, now: time.now,
      refuse: (request) => request?.action === "request"
        ? { kind: "answered", status: 409, body: { ok: false, refusal: "update_drain_conflict" }, hostId: "host_abc" } : null });
    const fake = fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep });
    expect(result).toMatchObject({ outcome: "drain_unavailable", exitCode: 0 });
    expect(result.detail).toContain("drain:update_drain_conflict");
    expect(readReleaseState(dir).drain).toBeNull();
    expect(fake.calls).not.toContain("stop");
  });

  it("a lost request answer keeps its pending id and adopts the cloud drain on retry", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 2, now: time.now });
    let requestCount = 0;
    const drain = async (request: Parameters<typeof cloud.call>[0]) => {
      const answer = await cloud.call(request);
      if (request?.action === "request" && ++requestCount === 1)
        return { kind: "unreachable" as const, detail: "TimeoutError", hostId: "host_abc" };
      return answer;
    };
    const first = fakeEngine(dir, { read: offered(), phases: () => 2, drain });
    expect(await runRunnerUpdate(first.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "drain_unavailable" });
    expect(readReleaseState(dir).drain).toMatchObject({ acknowledgedAtMs: null });
    const abort = new AbortController();
    const second = fakeEngine(dir, { read: offered(), phases: () => 2, drain });
    expect(await runRunnerUpdate(second.engine, { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() }))
      .toMatchObject({ outcome: "draining_for_update" });
    expect(requestCount).toBe(1);
    expect(readReleaseState(dir).drain?.requestId).toBe(cloud.drain?.requestId);
  });

  it.each(["no_credential", "response_invalid"] as const)("a committed request with %s keeps its pending id until an idle check releases the drain", async (lostAnswer) => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const drain = async (request: Parameters<typeof cloud.call>[0]) => {
      const answer = await cloud.call(request);
      if (request?.action !== "request") return answer;
      return lostAnswer === "no_credential"
        ? { kind: "no_credential" as const }
        : { kind: "answered" as const, status: 200, body: { ok: true }, hostId: "host_abc" };
    };
    const busy = fakeEngine(dir, { read: offered(), phases: () => 1, drain });
    expect(await runRunnerUpdate(busy.engine, { dir, drain: true, now: time.now, sleep: time.sleep }))
      .toMatchObject({ outcome: "drain_unavailable" });
    expect(readReleaseState(dir).drain).toMatchObject({ requestId: cloud.drain?.requestId, acknowledgedAtMs: null });
    const idle = fakeEngine(dir, { read: offered(), phases: () => 0, drain });
    expect(await runRunnerUpdate(idle.engine, { dir, drain: true, now: time.now, sleep: time.sleep }))
      .toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.calls).toEqual(["GET", "request:106", "GET", "GET", "release"]);
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });

  it.each([
    ["update_drain_unavailable", { status: 503, body: { ok: false, refusal: "update_drain_unavailable" } }],
    ["http_502", { status: 502, body: null }],
    ["a 500 with another refusal", { status: 500, body: { ok: false, refusal: "internal_error" } }],
  ] as const)("a committed request answered %s keeps its pending id until an idle check releases the drain", async (_label, lost) => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const drain = async (request: Parameters<typeof cloud.call>[0]) => {
      const answer = await cloud.call(request);
      return request?.action === "request" ? { kind: "answered" as const, ...lost, hostId: "host_abc" } : answer;
    };
    const busy = fakeEngine(dir, { read: offered(), phases: () => 1, drain });
    expect(await runRunnerUpdate(busy.engine, { dir, drain: true, now: time.now, sleep: time.sleep }))
      .toMatchObject({ outcome: "drain_unavailable" });
    expect(cloud.drain).not.toBeNull();
    expect(readReleaseState(dir).drain).toMatchObject({ requestId: cloud.drain?.requestId, acknowledgedAtMs: null });
    const idle = fakeEngine(dir, { read: offered(), phases: () => 0, drain });
    expect(await runRunnerUpdate(idle.engine, { dir, drain: true, now: time.now, sleep: time.sleep }))
      .toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });

  it("an owner hold never rewrites release-state.json while another update holds the lock", async () => {
    const dir = machine();
    const deferral = { sinceMs: A, offered: 106, offeredSinceMs: A };
    writeReleaseState(dir, { ...readReleaseState(dir), deferral });
    const fake = fakeEngine(dir, { read: offered() });
    const token = takeLock(dir, A);
    expect(token).not.toBeNull();
    try {
      expect(await releaseUpdateDrain(fake.engine, dir, { cloud: false })).toBe("pending");
      expect(readReleaseState(dir).deferral).toEqual(deferral);
    } finally { releaseLock(dir, token!); }
    expect(await releaseUpdateDrain(fake.engine, dir, { cloud: false })).toBe("none");
    expect(readReleaseState(dir).deferral).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("an active cloud drain is adopted without another request", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 1, now: time.now });
    cloud.setDrain({ requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", generation: 106, requestedAtMs: time.now(), admissionBlocked: true });
    const controller = new AbortController();
    const fake = fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: async () => controller.abort(), signal: controller.signal }))
      .toMatchObject({ outcome: "draining_for_update" });
    expect(cloud.calls).toContain("GET");
    expect(cloud.calls).not.toContain("request:106");
    expect(readReleaseState(dir).drain?.requestId).toBe(cloud.drain?.requestId);
  });

  it("does not stop while a grant is live after the local phase ends", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const phaseEnd = time.now() + 10_000;
    const grantEnd = phaseEnd + 10_000;
    const cloud = fakeDrainCloud({ live: () => time.now() < grantEnd ? 1 : 0, now: time.now });
    let stopAt = 0;
    const fake = fakeEngine(dir, { read: offered(), phases: () => time.now() < phaseEnd ? 1 : 0,
      drain: cloud.call, onStop: () => { stopAt = time.now(); expect(cloud.status().liveGenerations).toBe(0); } });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "updated" });
    expect(stopAt).toBeGreaterThanOrEqual(grantEnd);
  });

  it("resumes a drain after a process abort without posting another request", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const phaseEnd = time.now() + 20_000;
    const cloud = fakeDrainCloud({ live: () => time.now() < phaseEnd ? 1 : 0, now: time.now });
    const abort = new AbortController();
    const first = fakeEngine(dir, { read: offered(), phases: () => time.now() < phaseEnd ? 1 : 0, drain: cloud.call });
    expect(await runRunnerUpdate(first.engine, { dir, drain: true, now: time.now, signal: abort.signal,
      sleep: async (ms) => { await time.sleep(ms); abort.abort(); } })).toMatchObject({ outcome: "draining_for_update" });
    expect(readReleaseState(dir).drain).not.toBeNull();
    const second = fakeEngine(dir, { read: offered(), phases: () => time.now() < phaseEnd ? 1 : 0, drain: cloud.call });
    expect(await runRunnerUpdate(second.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.calls.filter((item) => item === "request:106")).toHaveLength(1);
    expect(cloud.drain).toBeNull();
  });

  it("a drain released elsewhere clears the local record and restarts the clock", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const abort = new AbortController();
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    expect(readReleaseState(dir).drain).not.toBeNull();
    cloud.setDrain(null);
    time.advance(10_000);
    const resumed = fakeEngine(dir, { read: offered(), phases: () => 0, drain: cloud.call });
    const result = await runRunnerUpdate(resumed.engine, { dir, drain: true, now: time.now, sleep: time.sleep });
    expect(result).toMatchObject({ outcome: "deferred_busy" });
    expect(resumed.calls).not.toContain("stop");
    expect(readReleaseState(dir).drain).toBeNull();
    expect(readReleaseState(dir).deferral?.sinceMs).toBe(time.now());
    expect(cloud.calls.filter((call) => call === "request:106")).toHaveLength(1);
  });

  it("a phase appearing after stop resumes the supervisor and waits under the same drain", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const fake = fakeEngine(dir, { read: offered(), busy: [1, 0, 0, 1, 0, 0, 0], drain: cloud.call });
    const passes: string[] = [];
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep,
      onPass: (pass) => passes.push(pass.outcome) });
    expect(result).toMatchObject({ outcome: "updated", generation: 106 });
    expect(passes).not.toContain("deferred_busy");
    expect(fake.calls.filter((call) => call === "stop")).toHaveLength(2);
    expect(fake.calls.filter((call) => call === "up")).toHaveLength(2);
    expect(cloud.calls.filter((call) => call === "request:106")).toHaveLength(1);
  });

  it("a person's run observes a held drain immediately and applies it when idle", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const abort = new AbortController();
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    const manualBusy = fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call });
    expect(await runRunnerUpdate(manualBusy.engine, { dir, now: time.now })).toMatchObject({ outcome: "draining_for_update" });
    expect(manualBusy.calls).not.toContain("stop");
    const manualIdle = fakeEngine(dir, { read: offered(), phases: () => 0, drain: cloud.call });
    expect(await runRunnerUpdate(manualIdle.engine, { dir, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.drain).toBeNull();
  });

  it("a resumed drain can finish outside its previously settled update window", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const abort = new AbortController();
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    const window = { lastOpenedMs: A + DRAIN_AFTER_MS - 3_600_000, nextOpensMs: A + DRAIN_AFTER_MS + 3_600_000 };
    writeReleaseState(dir, { ...readReleaseState(dir), windowSettledMs: window.lastOpenedMs });
    const fake = fakeEngine(dir, { read: offered(), phases: () => 0, drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep, window })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(fake.calls).toContain("stop");
  });

  it("a pending request the cloud never recorded still waits for the owner's update window", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now,
      refuse: (request) => request?.action === "request" ? { kind: "answered", status: 502, body: null, hostId: "host_abc" } : null });
    const busy = fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call });
    expect(await runRunnerUpdate(busy.engine, { dir, drain: true, now: time.now, sleep: time.sleep }))
      .toMatchObject({ outcome: "drain_unavailable" });
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toMatchObject({ acknowledgedAtMs: null });
    const window = { lastOpenedMs: A + DRAIN_AFTER_MS - 3_600_000, nextOpensMs: A + DRAIN_AFTER_MS + 3_600_000 };
    writeReleaseState(dir, { ...readReleaseState(dir), windowSettledMs: window.lastOpenedMs });
    const idle = fakeEngine(dir, { read: offered(), phases: () => 0, drain: cloud.call });
    expect(await runRunnerUpdate(idle.engine, { dir, drain: true, now: time.now, sleep: time.sleep, window }))
      .toMatchObject({ outcome: "waiting_window" });
    expect(idle.calls).not.toContain("stop");
  });

  it("a transient desired-release failure keeps the drain and waits a minute before retry", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 1, now: time.now });
    const abort = new AbortController();
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    let reads = 0;
    const fake = fakeEngine(dir, { read: () => (++reads === 1 ? { kind: "unreachable", detail: "TimeoutError", hostId: "host_abc" } : offered()),
      phases: () => 1, drain: cloud.call });
    const passTimes: number[] = [];
    const secondAbort = new AbortController();
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, signal: secondAbort.signal,
      sleep: time.sleep, onPass: (pass) => { passTimes.push(time.now()); if (passTimes.length === 2) secondAbort.abort(); } });
    expect(result.outcome).toBe("draining_for_update");
    expect(passTimes).toHaveLength(2);
    expect(passTimes[1]! - passTimes[0]!).toBeGreaterThanOrEqual(60_000);
    expect(readReleaseState(dir).drain).not.toBeNull();
  });

  it("an idle drained machine whose release read fails still waits a minute between passes", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const abort = new AbortController();
    await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() });
    const recovers = time.now() + 150_000;
    const unavailable = { kind: "answered", status: 503, body: { ok: false, refusal: "release_unavailable" }, hostId: "host_abc" } as const;
    const fake = fakeEngine(dir, { read: () => (time.now() < recovers ? unavailable : offered()), phases: () => 0, drain: cloud.call });
    const passTimes: number[] = [];
    const guard = new AbortController();
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep, signal: guard.signal,
      onPass: () => { passTimes.push(time.now()); if (passTimes.length >= 10) guard.abort(); } });
    expect(result).toMatchObject({ outcome: "updated", generation: 106 });
    expect(passTimes.length).toBeGreaterThan(1);
    for (let pass = 1; pass < passTimes.length; pass++)
      expect(passTimes[pass]! - passTimes[pass - 1]!).toBeGreaterThanOrEqual(60_000);
    expect(cloud.drain).toBeNull();
  });

  it("an owner hold during the wait releases the drain without stopping the supervisor", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 1, now: time.now });
    const fake = fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep,
      held: () => time.now() >= A + DRAIN_AFTER_MS + 3_600_000 ? "owner_setting" : null });
    expect(result).toMatchObject({ outcome: "retained", detail: "owner_setting" });
    expect(fake.calls).not.toContain("stop");
    expect(cloud.calls).toContain("release");
    expect(readReleaseState(dir)).toMatchObject({ deferral: null, drain: null });
  });

  it("a failed drain release remains pending and the next current check releases it", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    let refuseRelease = true;
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now,
      refuse: (request) => request?.action === "release" && refuseRelease
        ? { kind: "answered", status: 503, body: { ok: false, refusal: "update_drain_unavailable" }, hostId: "host_abc" } : null });
    const fake = fakeEngine(dir, { read: offered(), busy: [1, 0, 0], drain: cloud.call });
    const updated = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep });
    expect(updated).toMatchObject({ outcome: "updated", generation: 106 });
    expect(updated.detail).toContain(":drain_release_pending");
    expect(readReleaseState(dir).drain).not.toBeNull();
    refuseRelease = false;
    const next = fakeEngine(dir, { read: offered(), drain: cloud.call });
    expect(await runRunnerUpdate(next.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "current" });
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });

  it("a release conflict re-reads the cloud revision and releases the same drain", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    let conflict = true;
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now, refuse: (request) => {
      if (request?.action !== "release" || !conflict) return null;
      conflict = false;
      if (cloud.drain) cloud.setDrain(cloud.drain);
      return { kind: "answered", status: 409, body: { ok: false, refusal: "update_drain_conflict" }, hostId: "host_abc" };
    } });
    const fake = fakeEngine(dir, { read: offered(), busy: [1, 0, 0], drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "updated" });
    expect(cloud.calls.slice(-3)).toEqual(["release", "GET", "release"]);
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });

  it("a recorded release recovers and releases a cloud drain after local state was lost", async () => {
    const dir = install(ORIGINAL_ENV.replace(OLD.runner, TARGET.runner).replace(OLD.supervisor, TARGET.supervisor).replace(OLD.watchdog, TARGET.watchdog));
    writeReleaseState(dir, { ...readReleaseState(dir), generation: 102 });
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    cloud.setDrain({ requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", generation: 106,
      requestedAtMs: time.now(), admissionBlocked: true });
    const fake = fakeEngine(dir, { read: offered(), drain: cloud.call });
    expect(await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "recorded", generation: 106 });
    expect(cloud.calls).toEqual(["GET", "release"]);
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });

  it("a rollback releases the drain and restarts the backlog clock", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const fake = fakeEngine(dir, { read: offered(), busy: [1, 0, 0, 0], drain: cloud.call,
      ready: (image) => image === OLD.supervisor });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep, readyDeadlineMs: 20_000 });
    expect(result.outcome).toBe("rolled_back");
    expect(cloud.calls).toContain("release");
    expect(readReleaseState(dir).drain).toBeNull();
    expect(readReleaseState(dir).deferral?.sinceMs).toBe(time.now());
  });

  // CTC-8076, case B: private thoughts storage guards running phases, not only the update. A pass that
  // could not attest storage back onto the images the machine keeps holds the drain and tells the
  // owner (a report at once, and the CLI line). One that attested it back releases as before.
  type CustodyRow = { label: string; detail: string; outcome: "failed" | "retained"; releases: boolean; alerts: boolean; options: (authority: string) => FakeOptions };
  it.each<CustodyRow>([
    { label: "the rollback is not ready", detail: "rollback_not_ready", outcome: "failed", releases: false, alerts: false,
      options: () => ({ composeUp: [false, false] }) },
    { label: "storage is refused before any stop and is not attested back", detail: "custody_restore_failed:engine_authority_mismatch", outcome: "failed", releases: false, alerts: true,
      options: () => ({ custody: (images: Images) => ({ refused: images.supervisor === TARGET.supervisor ? "bootstrap_cleanup_unproved" : "engine_authority_mismatch" }) }) },
    { label: "the rollback is ready but storage is not attested back", detail: "custody_restore_failed:bootstrap_signed_receipt_unavailable", outcome: "failed", releases: false, alerts: true,
      options: (authority: string) => ({ custody: keepsAuthority("bootstrap_signed_receipt_unavailable", authority), ready: (image: string) => image === OLD.supervisor }) },
    { label: "the supervisor does not stop and storage is not attested back", detail: "custody_restore_failed:engine_binding_mismatch", outcome: "failed", releases: false, alerts: true,
      options: (authority: string) => ({ stop: false, custody: keepsAuthority("engine_binding_mismatch", authority) }) },
    { label: "a phase is found after the stop and storage is not attested back", detail: "custody_restore_failed:producer_config_unavailable", outcome: "failed", releases: false, alerts: true,
      options: (authority: string) => ({ busy: [1, 0, 0, 1], custody: keepsAuthority("producer_config_unavailable", authority) }) },
    { label: "the supervisor does not stop and storage is attested back", detail: "supervisor_stop_failed", outcome: "retained", releases: true, alerts: false,
      options: (authority: string) => ({ stop: false, custody: () => authority }) },
  ])("when $label the pass ends $detail; it keeps the drain unless storage is attested back", async ({ detail, outcome, releases, alerts, options }) => {
    const { dir, authority } = detail === "rollback_not_ready" ? { dir: machine(), authority: "" } : custodyMachine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const fake = fakeEngine(dir, { read: offered(), busy: [1, 0, 0, 0], drain: cloud.call, ...options(authority) });
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep, readyDeadlineMs: 20_000 });
    expect(result).toMatchObject({ outcome, detail, exitCode: outcome === "failed" ? 1 : 0 });
    // The drain was really held before this pass ended.
    expect(cloud.calls).toContain("request:106");
    expect(cloud.calls.includes("release")).toBe(releases);
    expect(cloud.drain === null).toBe(releases);
    expect(readReleaseState(dir).drain === null).toBe(releases);
    if (detail === "custody_restore_failed:engine_authority_mismatch") expect(fake.calls).not.toContain("stop");
    if (releases) expect(readReleaseState(dir).deferral?.sinceMs).toBe(time.now());
    // The owner hears of it: the outcome is reported at once, and the CLI says what to do.
    const reported = fake.reports.filter((raw): raw is string => raw !== undefined).map((raw) => JSON.parse(raw) as { outcome: string; detail: string });
    expect(reported.some((report) => report.outcome === "failed" && report.detail === detail)).toBe(alerts);
    expect(updateResultLines(result).includes(CUSTODY_UNATTESTED_LINE)).toBe(alerts);
    expect(lastProblemLines(readReleaseState(dir)).includes(CUSTODY_UNATTESTED_LINE)).toBe(alerts);
  });

  it("an applied release releases a cloud drain after release-state.json was deleted", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 0, now: time.now });
    const abort = new AbortController();
    expect(await runRunnerUpdate(fakeEngine(dir, { read: offered(), phases: () => 2, drain: cloud.call }).engine,
      { dir, drain: true, now: time.now, signal: abort.signal, sleep: async () => abort.abort() })).toMatchObject({ outcome: "draining_for_update" });
    expect(cloud.drain).not.toBeNull();
    rmSync(join(dir, RELEASE_STATE_FILE));
    expect(readReleaseState(dir).drain).toBeNull();
    cloud.calls.length = 0;
    const idle = fakeEngine(dir, { read: offered(), phases: () => 0, drain: cloud.call });
    expect(await runRunnerUpdate(idle.engine, { dir, drain: true, now: time.now, sleep: time.sleep })).toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.calls).toEqual(["GET", "release"]);
    expect(cloud.drain).toBeNull();
    expect(readReleaseState(dir).drain).toBeNull();
  });
});

describe("CTC-8076: the schedule's log tells the owner when storage is not attested back", () => {
  it("runner update --auto prints the owner's line after its timestamped result, and exits 1", async () => {
    const { dir, authority } = custodyMachine();
    const fake = fakeEngine(dir, { read: offered(), stop: false, custody: keepsAuthority("engine_binding_mismatch", authority) });
    const ctx = makeCtx(tempHome(), { now: () => new Date("2026-10-27T09:00:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--dir", dir], ctx, { runner: { engine: fake.engine, custody: { platform: "linux" } } })).toBe(1);
    expect(ctx.out[0]).toBe("2026-10-27T09:00:00.000Z failed custody_restore_failed:engine_binding_mismatch generation=102");
    expect(ctx.out[1]).toBe(CUSTODY_UNATTESTED_LINE);
  });

  it("a report that cannot be sent at once does not throw out of the update", async () => {
    const { dir, authority } = custodyMachine();
    let reads = 0;
    const read = () => {
      if (reads++ > 0) throw new Error("the report read failed");
      return offered();
    };
    const fake = fakeEngine(dir, { read, stop: false, custody: keepsAuthority("engine_binding_mismatch", authority) });
    await expect(runRunnerUpdate(fake.engine, { dir })).resolves.toMatchObject({ outcome: "failed", detail: "custody_restore_failed:engine_binding_mismatch" });
    expect(reads).toBe(2);
  });
});

describe("CTC-7749: a drain's soft limit never ends a running phase", () => {
  it("reports once at two hours, preserves the phase for three hours, then applies", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const end = time.now() + 3 * 3_600_000;
    const cloud = fakeDrainCloud({ live: () => time.now() < end + 5_000 ? 1 : 0, now: time.now });
    const fake = fakeEngine(dir, { read: offered(), phases: () => time.now() < end ? 1 : 0, drain: cloud.call });
    const initialEnv = readFileSync(join(dir, ".env"), "utf8");
    const passes: Array<{ at: number; result: UpdateResult }> = [];
    const result = await runRunnerUpdate(fake.engine, { dir, drain: true, now: time.now, sleep: time.sleep,
      onPass: (pass) => {
        passes.push({ at: time.now(), result: pass });
        expect(readReleaseState(dir).windowSettledMs).toBeNull();
        if (time.now() < end) {
          expect(fake.calls).not.toContain("stop");
          expect(fake.calls).not.toContain("up");
          expect(cloud.calls).not.toContain("release");
          expect(readFileSync(join(dir, ".env"), "utf8")).toBe(initialEnv);
          if (time.now() >= A + DRAIN_AFTER_MS + DRAIN_SOFT_LIMIT_MS)
            expect(readReleaseState(dir).drain?.softLimitReported).toBe(true);
        }
      } });
    expect(passes.filter(({ result: pass }) => pass.outcome === "drain_soft_limit")).toHaveLength(1);
    const soft = passes.find(({ result: pass }) => pass.outcome === "drain_soft_limit")!;
    expect(soft.at).toBe(A + DRAIN_AFTER_MS + DRAIN_SOFT_LIMIT_MS);
    expect(soft.result.detail).toContain("phases_running:1");
    expect(soft.result.detail).toContain("draining_for_ms:7200000");
    expect(fake.reports.some((raw) => raw && JSON.parse(raw).outcome === "drain_soft_limit")).toBe(true);
    expect(result).toMatchObject({ outcome: "updated", generation: 106 });
    expect(cloud.drain).toBeNull();
    expect(fake.calls).toContain("stop");
    expect(fake.calls).toContain("up");
  }, 15_000);

  it("a restarted process does not report the two-hour soft limit again", async () => {
    const dir = machine();
    const time = clock(A + DRAIN_AFTER_MS);
    const cloud = fakeDrainCloud({ live: () => 1, now: time.now });
    const firstAbort = new AbortController();
    const first = fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call });
    const firstOutcomes: string[] = [];
    const result = await runRunnerUpdate(first.engine, { dir, drain: true, now: time.now, sleep: time.sleep, signal: firstAbort.signal,
      onPass: (pass) => { firstOutcomes.push(pass.outcome); if (pass.outcome === "drain_soft_limit") firstAbort.abort(); } });
    expect(result.outcome).toBe("drain_soft_limit");
    expect(firstOutcomes.filter((outcome) => outcome === "drain_soft_limit")).toHaveLength(1);
    expect(readReleaseState(dir).drain?.softLimitReported).toBe(true);
    const secondAbort = new AbortController();
    const second = fakeEngine(dir, { read: offered(), phases: () => 1, drain: cloud.call });
    const resumed = await runRunnerUpdate(second.engine, { dir, drain: true, now: time.now, sleep: async () => secondAbort.abort(), signal: secondAbort.signal });
    expect(resumed.outcome).toBe("draining_for_update");
  });
});
