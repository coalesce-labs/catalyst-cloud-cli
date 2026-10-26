import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decideRelease,
  parseDesiredRelease,
  PREVIOUS_ENV_FILE,
  readReleaseState,
  RELEASE_STATE_FILE,
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

const hex = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);
const REPO = {
  runner: "ghcr.io/coalesce-labs/catalyst-runner",
  supervisor: "ghcr.io/coalesce-labs/catalyst-supervisor",
  watchdog: "ghcr.io/coalesce-labs/catalyst-deadline-watchdog",
} as const;
const ref = (component: ReleaseComponent, c: string) => `${REPO[component]}@sha256:${hex(c)}`;

function release(over: { generation?: number; digits?: [string, string, string]; mutate?: (r: Record<string, unknown>) => void } = {}) {
  const [r, s, w] = over.digits ?? ["1", "2", "3"];
  const image = (component: ReleaseComponent, c: string, src: string) => ({
    reference: ref(component, c),
    digest: `sha256:${hex(c)}`,
    tag: `${REPO[component]}:${sha(src)}${component === "runner" ? "-multiarch" : ""}`,
    sourceSha: sha(src),
  });
  const body: Record<string, unknown> = {
    version: 1,
    releaseId: `hr-${hex(r).slice(0, 16)}-${hex(s).slice(0, 16)}-${hex(w).slice(0, 16)}`,
    generation: over.generation ?? 1,
    approvedAtMs: 1_800_000_000_000,
    runner: image("runner", r, "a"),
    supervisor: image("supervisor", s, "b"),
    watchdog: image("watchdog", w, "b"),
  };
  over.mutate?.(body);
  return body;
}
const answered = (body: unknown, status = 200): DesiredReleaseRead =>
  ({ kind: "answered", status, body: status === 200 ? { ok: true, release: body } : body, hostId: "host_abc" });

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

const ORIGINAL_ENV = [
  "# setup wrote this",
  "CATALYST_HOST_FREE_FLOOR_GIB=25",
  `CATALYST_SUPERVISOR_IMAGE=${ref("supervisor", "a")}`,
  `CATALYST_WATCHDOG_IMAGE=${ref("watchdog", "b")}`,
  `CATALYST_RUNNER_IMAGE=${ref("runner", "c")}`,
  "",
].join("\n");

function install(env = ORIGINAL_ENV): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-update-"));
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  return dir;
}

type Images = Record<ReleaseComponent, string>;
const imagesIn = (text: string): Images => {
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "";
  return { runner: get("CATALYST_RUNNER_IMAGE"), supervisor: get("CATALYST_SUPERVISOR_IMAGE"), watchdog: get("CATALYST_WATCHDOG_IMAGE") };
};
const TARGET: Images = { runner: ref("runner", "1"), supervisor: ref("supervisor", "2"), watchdog: ref("watchdog", "3") };
const OLD: Images = { runner: ref("runner", "c"), supervisor: ref("supervisor", "a"), watchdog: ref("watchdog", "b") };

interface FakeOptions {
  read?: DesiredReleaseRead;
  /** Attempt counts, one per look (the first look, then the look after the supervisor stops). */
  busy?: (number | null)[];
  prepare?: string | null;
  composeUp?: boolean[];
  /** Whether a supervisor on this image reports host_ready. Default: always. */
  ready?: (supervisorImage: string) => boolean;
  /** The authority custody returns for these images, or `{ refused }`. Default: the installed one, unchanged. */
  custody?: (images: Images) => string | { refused: string };
  /** What is running before the update. Default: what `.env` names. */
  live?: Images;
  stop?: boolean;
  /** Images Docker refuses to remove, for example because a running phase still uses them. */
  inUse?: (image: string) => boolean;
}
/** A machine: what runs is what `.env` named at the last successful compose up. */
function fakeEngine(dir: string, options: FakeOptions = {}) {
  const calls: string[] = [];
  const reports: Array<string | undefined> = [];
  let live: Images = options.live ?? imagesIn(readFileSync(join(dir, ".env"), "utf8"));
  let stopped = false;
  let ups = 0;
  let looks = 0;
  const engine: RunnerUpdateEngine = {
    async desiredRelease(_d, _signal, report) { calls.push("read"); reports.push(report); return options.read ?? answered(release()); },
    async attemptContainers(_d, hostId) { calls.push(`attempts:${hostId}`); return options.busy ? (options.busy[looks++] ?? 0) : 0; },
    async prepare(images) { calls.push(`prepare:${images.length}`); return options.prepare ?? null; },
    async custody(_d, images) {
      calls.push(`custody:${images.supervisor}`);
      const answer = options.custody ? options.custody(images) : "AUTH";
      return typeof answer === "string" ? { authority: answer } : answer;
    },
    async services() {
      return {
        supervisor: { image: live.supervisor, running: !stopped, startedAtMs: 1 },
        watchdog: { image: live.watchdog, running: true, startedAtMs: 1 },
      };
    },
    async stopSupervisor() { calls.push("stop"); if (options.stop === false) return false; stopped = true; return true; },
    async composeUp() {
      calls.push("up");
      if (!(options.composeUp?.[ups++] ?? true)) return false;
      live = imagesIn(readFileSync(join(dir, ".env"), "utf8"));
      stopped = false;
      return true;
    },
    async supervisorReadySinceStart() { return options.ready ? options.ready(live.supervisor) : true; },
    async removeImages(images) { calls.push(`rm:${images.join(",")}`); return images.filter((image) => options.inUse?.(image) ?? false); },
  };
  return { engine, calls, reports, live: () => live };
}
const fastClock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

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
    expect(await runRunnerUpdate(engine, { dir, ...fastClock() })).toMatchObject({ outcome: "deferred_busy", detail: "attempt_containers:1" });
    expect(calls.slice(-3)).toEqual(["stop", "attempts:host_abc", "up"]);
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
    expect(calls).toEqual(["read"]);
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
    expect(await runRunnerUpdate(engine, { dir: d, ...fastClock() })).toMatchObject({ outcome: "deferred_busy", detail: "attempt_containers:1" });
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
    ({ version: 1, generation: 105, releaseId: null, appliedAtMs: null, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
      last: last === null ? null : { atMs: Date.UTC(2026, 9, 24, 4, 30), ...last } });

  it("POSITIVE CONTROL: a rolled-back update is named with its time, reason and offered generation", () => {
    expect(lastProblemLines(state({ outcome: "rolled_back", detail: "supervisor_not_ready", generation: 106 })))
      .toEqual(["The last update, at 2026-10-24T04:30:00.000Z, was rolled back (supervisor_not_ready; offered generation 106)."]);
  });

  it("a failed update with no offered generation says none", () => {
    expect(lastProblemLines(state({ outcome: "failed", detail: "compose_up_failed", generation: null })))
      .toEqual(["The last update, at 2026-10-24T04:30:00.000Z, failed (compose_up_failed; offered generation none)."]);
  });

  it.each([["updated"], ["current"], ["deferred_busy"], ["waiting_window"], ["retained"]] as const)(
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
    ({ version: 1, generation, releaseId: null, appliedAtMs: null, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null,
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
