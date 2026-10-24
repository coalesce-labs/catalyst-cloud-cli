import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import { onboardStateRoot } from "./onboard.js";
import { darwinThoughtsInstallRefusal } from "./onboard-runner-custody.js";
import {
  dockerRunnerEngine,
  parseEnvText,
  persistedCustody,
  prepareRunnerImages,
  readEnvFile,
  runnerComposeArgs,
  spawnDocker,
  type RunnerEngine,
  type RunnerExec,
} from "./onboard-runner.js";

// `catalyst runner update`: move this machine's self-hosted runner to the release Catalyst approved
// (CTC-4646). The cloud names one approved runner, supervisor and watchdog by immutable digest with
// a monotonic generation (catalyst-cloud CTC-5926, GET /api/v1/hosts/desired-release, read with the
// host's own credential). This command reads it from inside a one-off supervisor container, so the
// host secret never leaves Docker, then moves only when every check passes:
//
//   - the release parses strictly: three digests from the three Catalyst repositories, never a
//     tag or `latest`, and a generation newer than the one this machine last applied;
//   - no phase container exists for this host, unless the update is in place (below);
//   - all three images are pulled by digest, natively for this engine, before anything changes;
//   - on a Mac with private thoughts storage, that storage is re-attested on the new supervisor;
//   - with the supervisor stopped, so it admits no new work, there is still no phase container.
//     If one started in between, the supervisor comes back as it was and the update waits.
//
// In place (CTC-6709): when the release names its supervisor's journal format and it equals the
// format of the supervisor a failure would go back to, as recorded when that supervisor was applied,
// running phases are not waited out. The supervisor is recreated and re-adopts them, and they finish
// on the image they were granted. A rollback lands on a supervisor that reads the same journal. A
// format that differs, or is unknown on either side, waits for an idle machine as above, because an
// older supervisor that meets a newer journal refuses to start.
//
// Then it rewrites the three image lines in `.env`, keeps the previous file beside it, and runs
// `docker compose up`. The release counts as applied only when the running containers are its
// images and the supervisor logged `host_ready` since it started; a `.env` that already names the
// release is reconciled the same way, never trusted. Otherwise it restores the previous file, the
// thoughts storage attestation and the previous images. The outcome is kept in
// `release-state.json` for `--check` and status readers.

export const RELEASE_STATE_FILE = "release-state.json";
export const PREVIOUS_ENV_FILE = ".env.release-previous";
const LOCK_FILE = "update.lock";
const PENDING_REMOVAL_KEPT = 20;
const READY_DEADLINE_MS = 5 * 60_000;
const READY_POLL_MS = 5_000;
const ATTEMPT_HOST_LABEL = "dev.catalystcloud.attempt.host-id";
const DESIRED_RELEASE_PATH = "/api/v1/hosts/desired-release";

export const RELEASE_COMPONENTS = ["runner", "supervisor", "watchdog"] as const;
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];
/** The only repositories a release may name, exactly as catalyst-cloud's HOST_RELEASE_REPOSITORIES. */
export const RELEASE_REPOSITORIES: Readonly<Record<ReleaseComponent, string>> = {
  runner: "ghcr.io/coalesce-labs/catalyst-runner",
  supervisor: "ghcr.io/coalesce-labs/catalyst-supervisor",
  watchdog: "ghcr.io/coalesce-labs/catalyst-deadline-watchdog",
};
export const RELEASE_ENV_KEYS: Readonly<Record<ReleaseComponent, string>> = {
  runner: "CATALYST_RUNNER_IMAGE",
  supervisor: "CATALYST_SUPERVISOR_IMAGE",
  watchdog: "CATALYST_WATCHDOG_IMAGE",
};

export interface DesiredRelease {
  releaseId: string;
  generation: number;
  approvedAtMs: number;
  images: Record<ReleaseComponent, { reference: string; sourceSha: string }>;
  /** The journal format the release's supervisor reads and writes; null when the release does not say. */
  journalFormat: number | null;
}

/** What one desired-release read returned, as the container saw it. */
export type DesiredReleaseRead =
  | { kind: "answered"; status: number; body: unknown; hostId: string }
  | { kind: "unreachable"; detail: string; hostId: string }
  | { kind: "no_credential" };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const posInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

/** A reference this machine may pull for `component`: its repository, at a digest, with no tag. */
export function releaseReference(component: ReleaseComponent, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const at = value.indexOf("@");
  if (at === -1 || value.slice(0, at) !== RELEASE_REPOSITORIES[component]) return null;
  return DIGEST.test(value.slice(at + 1)) ? value : null;
}

const shortDigest = (reference: string) => reference.slice(reference.indexOf("@sha256:") + 8).slice(0, 16);

/** The host-readable release, parsed as strictly as catalyst-cloud's parseHostDesiredRelease. */
export function parseDesiredRelease(input: unknown): DesiredRelease | null {
  if (!isRecord(input) || input.version !== 1) return null;
  if (typeof input.releaseId !== "string" || !posInt(input.generation) || !posInt(input.approvedAtMs)) return null;
  const images = {} as DesiredRelease["images"];
  for (const component of RELEASE_COMPONENTS) {
    const value = input[component];
    if (!isRecord(value)) return null;
    const reference = releaseReference(component, value.reference);
    if (!reference || value.digest !== reference.slice(reference.indexOf("@") + 1)) return null;
    if (typeof value.sourceSha !== "string" || !SHA40.test(value.sourceSha)) return null;
    const tag = `${RELEASE_REPOSITORIES[component]}:${value.sourceSha}${component === "runner" ? "-multiarch" : ""}`;
    if (value.tag !== tag) return null;
    images[component] = { reference, sourceSha: value.sourceSha };
  }
  // Only the supervisor carries a journal format, a positive integer, as catalyst-cloud's parser.
  const supervisor = input.supervisor as Record<string, unknown>;
  if (supervisor.journalFormat !== undefined && !posInt(supervisor.journalFormat)) return null;
  for (const component of ["runner", "watchdog"] as const)
    if ((input[component] as Record<string, unknown>).journalFormat !== undefined) return null;
  const journalFormat = supervisor.journalFormat === undefined ? null : supervisor.journalFormat;
  const id = `hr-${shortDigest(images.runner.reference)}-${shortDigest(images.supervisor.reference)}-${shortDigest(images.watchdog.reference)}`;
  if (input.releaseId !== id) return null;
  return { releaseId: id, generation: input.generation, approvedAtMs: input.approvedAtMs, images, journalFormat };
}

export type ReleaseDecision =
  | { action: "update"; release: DesiredRelease }
  /** The generation this machine last applied: still check that it runs those images, because a
   *  setup run (or a hand edit) can put other images back in `.env` without changing the record. */
  | { action: "verify"; release: DesiredRelease }
  | {
      action: "retain";
      reason: "no_credential" | "read_unreachable" | "release_unavailable" | "response_invalid" | "credential_refused" | "not_newer";
      /** True only for a revoked host: asking again cannot help. */
      terminal: boolean;
    };

/** Whether to move. Every answer except a valid, strictly newer generation keeps the current images. */
export function decideRelease(appliedGeneration: number | null, read: DesiredReleaseRead): ReleaseDecision {
  const retain = (reason: Extract<ReleaseDecision, { action: "retain" }>["reason"], terminal = false): ReleaseDecision =>
    ({ action: "retain", reason, terminal });
  if (read.kind === "no_credential") return retain("no_credential");
  if (read.kind === "unreachable") return retain("read_unreachable");
  if (read.status === 401 || read.status === 403)
    return retain("credential_refused", isRecord(read.body) && read.body.refusal === "host_revoked" && read.body.terminal === true);
  if (read.status !== 200) return retain("release_unavailable");
  const release = parseDesiredRelease(isRecord(read.body) && read.body.ok === true ? read.body.release : null);
  if (!release) return retain("response_invalid");
  if (appliedGeneration !== null && release.generation < appliedGeneration) return retain("not_newer");
  if (appliedGeneration !== null && release.generation === appliedGeneration) return { action: "verify", release };
  return { action: "update", release };
}

export interface ReleaseState {
  version: 1;
  /** The approved generation these images came from; null until the first one is applied. */
  generation: number | null;
  releaseId: string | null;
  appliedAtMs: number | null;
  /** The images before the last applied release, for a person who wants to go back. */
  previous: Record<ReleaseComponent, string> | null;
  /** The journal format of the supervisor image this machine last applied, when its release named one. */
  journal: { format: number; supervisor: string } | null;
  /** Replaced images that could not be removed yet; every later run tries again. */
  pendingRemoval: string[];
  /** The update window the schedule last settled (update-windows.ts); null before the first. */
  windowSettledMs: number | null;
  last: { atMs: number; outcome: UpdateOutcome; detail: string; generation: number | null } | null;
}

export function readReleaseState(dir: string): ReleaseState {
  const empty: ReleaseState = { version: 1, generation: null, releaseId: null, appliedAtMs: null, previous: null, journal: null, pendingRemoval: [], windowSettledMs: null, last: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, RELEASE_STATE_FILE), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) return empty;
    return {
      ...empty,
      generation: posInt(parsed.generation) ? parsed.generation : null,
      releaseId: typeof parsed.releaseId === "string" ? parsed.releaseId : null,
      appliedAtMs: posInt(parsed.appliedAtMs) ? parsed.appliedAtMs : null,
      previous: isRecord(parsed.previous) ? (parsed.previous as ReleaseState["previous"]) : null,
      journal: isRecord(parsed.journal) && posInt(parsed.journal.format) && typeof parsed.journal.supervisor === "string"
        ? { format: parsed.journal.format, supervisor: parsed.journal.supervisor }
        : null,
      pendingRemoval: Array.isArray(parsed.pendingRemoval)
        ? parsed.pendingRemoval.filter((ref): ref is string => typeof ref === "string").slice(0, PENDING_REMOVAL_KEPT)
        : [],
      windowSettledMs: posInt(parsed.windowSettledMs) ? parsed.windowSettledMs : null,
      last: isRecord(parsed.last) ? (parsed.last as ReleaseState["last"]) : null,
    };
  } catch {
    return empty;
  }
}

/** Write a private file by rename, so a reader never sees half of it. */
export function writePrivateAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

export function writeReleaseState(dir: string, state: ReleaseState): void {
  writePrivateAtomic(join(dir, RELEASE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** `.env` with each `KEY=` line for `values` replaced in place (or appended), every other line kept. */
export function rewriteEnvText(text: string, values: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(values));
  const lines = text.split("\n").map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const [key, value] of pending) lines.push(`${key}=${value}`);
    lines.push("");
  }
  return lines.join("\n");
}

export type UpdateOutcome =
  | "current"
  | "recorded"
  | "updated"
  | "planned"
  | "deferred_busy"
  | "waiting_window"
  | "retained"
  | "rolled_back"
  | "failed";

export interface UpdateResult {
  outcome: UpdateOutcome;
  detail: string;
  generation: number | null;
  releaseId?: string;
  /** Exit code: 0 for every outcome a later run can improve on its own, 1 when a person should look. */
  exitCode: number;
}

/** One Compose service as the Engine reports it. */
export interface ServiceState {
  image: string;
  running: boolean;
  startedAtMs: number;
}

/** A custody attestation: the authority it now holds, or the installer's fixed refusal reason (CTC-6914). */
export type CustodyAttestation = { authority: string } | { refused: string };

/** Everything the update touches outside its own files. The docker one is below; tests use fakes. */
export interface RunnerUpdateEngine {
  /** `report` is the previous run's outcome (`updateReport`), sent on the read so the cloud sees it. */
  desiredRelease(dir: string, signal?: AbortSignal, report?: string): Promise<DesiredReleaseRead>;
  /** Attempt containers for this host in any state, or null when Docker could not be read. */
  attemptContainers(dir: string, hostId: string, signal?: AbortSignal): Promise<number | null>;
  /** Pull and verify each image natively for this engine. Null when ready, else why not. */
  prepare(images: string[], signal?: AbortSignal): Promise<string | null>;
  /** Attest Mac private thoughts storage on these images: the authority it holds, or why it refused. */
  custody(dir: string, images: Record<ReleaseComponent, string>, signal?: AbortSignal): Promise<CustodyAttestation>;
  /** The supervisor and watchdog containers, or null when Docker could not be read. */
  services(dir: string, signal?: AbortSignal): Promise<{ supervisor: ServiceState | null; watchdog: ServiceState | null } | null>;
  /** Stop the supervisor so it takes no new work. Phase containers are left running (re-adopted on start). */
  stopSupervisor(dir: string, signal?: AbortSignal): Promise<boolean>;
  composeUp(dir: string, signal?: AbortSignal): Promise<boolean>;
  /** True once the supervisor container has logged `host_ready` since it last started. */
  supervisorReadySinceStart(dir: string, signal?: AbortSignal): Promise<boolean>;
  /** Remove these local images. Returns the ones still present: the engine refuses an image a
   *  container still uses, such as a runner image under phases an in-place update left running. */
  removeImages(images: string[], signal?: AbortSignal): Promise<string[]>;
}

export interface RunnerUpdateOptions {
  dir: string;
  /** Plan only: read and decide, change nothing. */
  check?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyDeadlineMs?: number;
  signal?: AbortSignal;
  /** The schedule's run: a newer release waits until a window opens that no run has settled yet. */
  window?: { lastOpenedMs: number; nextOpensMs: number };
}

/** Outcomes that settle a window: nothing was pending, or the machine restarted onto (or tried) a
 *  release. A busy deferral or a passing refusal leaves the window open for the next check. */
const SETTLES_WINDOW: ReadonlySet<UpdateOutcome> = new Set(["current", "recorded", "updated", "rolled_back", "failed"]);

/** One serialized update run. A second concurrent run returns `retained` with `update_running`. */
export async function runRunnerUpdate(engine: RunnerUpdateEngine, options: RunnerUpdateOptions): Promise<UpdateResult> {
  const { dir } = options;
  const now = options.now ?? Date.now;
  const envPath = join(dir, ".env");
  if (!existsSync(envPath) || !existsSync(join(dir, "compose.yaml")))
    return { outcome: "failed", detail: "runner_not_installed", generation: null, exitCode: 1 };
  const lock = options.check ? null : takeLock(dir, now());
  if (!options.check && lock === null)
    return { outcome: "retained", detail: "update_running", generation: readReleaseState(dir).generation, exitCode: 0 };
  try {
    if (!options.check) await retryPendingRemoval(engine, dir, options.signal);
    const result = await update(engine, options, now);
    if (!options.check) {
      const state = readReleaseState(dir);
      const windowSettledMs = options.window && SETTLES_WINDOW.has(result.outcome) ? options.window.lastOpenedMs : state.windowSettledMs;
      writeReleaseState(dir, { ...state, windowSettledMs, last: { atMs: now(), outcome: result.outcome, detail: result.detail, generation: result.generation } });
    }
    return result;
  } finally {
    if (lock !== null) releaseLock(dir, lock);
  }
}

/** Try again to remove images an earlier update replaced but could not remove, never one `.env`
 *  names now (a setup run or a person may have put it back). */
async function retryPendingRemoval(engine: RunnerUpdateEngine, dir: string, signal?: AbortSignal): Promise<void> {
  const state = readReleaseState(dir);
  if (state.pendingRemoval.length === 0) return;
  const inUse = new Set(Object.values(imagesOf(readEnvFile(join(dir, ".env")) ?? {})));
  const removable = state.pendingRemoval.filter((ref) => !inUse.has(ref));
  if (removable.length === 0) return;
  const kept = await engine.removeImages(removable, signal);
  writeReleaseState(dir, { ...state, pendingRemoval: [...new Set([...state.pendingRemoval.filter((ref) => inUse.has(ref)), ...kept])] });
}

type Images = Record<ReleaseComponent, string>;
const imagesOf = (env: Record<string, string>): Images =>
  Object.fromEntries(RELEASE_COMPONENTS.map((c) => [c, env[RELEASE_ENV_KEYS[c]] ?? ""])) as Images;

/** The running containers are these images, and the supervisor reported ready since it started. */
async function running(engine: RunnerUpdateEngine, dir: string, images: Images, signal?: AbortSignal): Promise<boolean> {
  const live = await engine.services(dir, signal);
  if (!live?.supervisor?.running || live.supervisor.image !== images.supervisor) return false;
  if (!live.watchdog?.running || live.watchdog.image !== images.watchdog) return false;
  return engine.supervisorReadySinceStart(dir, signal);
}

const REPORT_DETAIL = /[^a-z0-9_:,.-]/g;

/** The previous run's outcome as the release read reports it (CTC-6924), or undefined before the
 *  first run. Only the fixed outcome vocabulary leaves the machine: anything outside the cloud's
 *  detail characters becomes `_`, so an image reference cannot make the cloud drop the report. */
export function updateReport(state: ReleaseState, cliVersion: string): string | undefined {
  if (state.last === null) return undefined;
  return JSON.stringify({
    v: 1,
    outcome: state.last.outcome,
    detail: state.last.detail.toLowerCase().replace(REPORT_DETAIL, "_").slice(0, 160),
    applied: state.generation,
    offered: state.last.generation,
    atMs: state.last.atMs,
    cli: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(cliVersion) ? cliVersion : null,
  });
}

async function update(engine: RunnerUpdateEngine, options: RunnerUpdateOptions, now: () => number): Promise<UpdateResult> {
  const { dir, signal } = options;
  const envPath = join(dir, ".env");
  const state = readReleaseState(dir);
  const done = (outcome: UpdateOutcome, detail: string, extra: Partial<UpdateResult> = {}): UpdateResult =>
    ({ outcome, detail, generation: state.generation, exitCode: 0, ...extra });

  const read = await engine.desiredRelease(dir, signal, options.check ? undefined : updateReport(state, readManifest().version));
  const decision = decideRelease(state.generation, read);
  if (decision.action === "retain")
    return decision.reason === "not_newer"
      ? done("current", "not_newer")
      : done("retained", decision.reason, { exitCode: decision.reason === "credential_refused" || decision.reason === "no_credential" ? 1 : 0 });
  const { release } = decision;
  const tagged = { releaseId: release.releaseId };
  // A newer release on the schedule waits for a window no run has settled. A machine that has
  // settled none yet (its first run on this CLI) takes it now, and drift on the applied generation
  // is put right at once, as before.
  const { window } = options;
  if (window && !options.check && decision.action === "update" && state.windowSettledMs !== null && window.lastOpenedMs <= state.windowSettledMs)
    return done("waiting_window", `next_window:${new Date(window.nextOpensMs).toISOString()}`, tagged);
  const target = Object.fromEntries(RELEASE_COMPONENTS.map((c) => [c, release.images[c].reference])) as Images;
  const envText = readFileSync(envPath, "utf8");
  const env = readEnvFile(envPath) ?? {};
  const current = imagesOf(env);
  const changed = RELEASE_COMPONENTS.filter((c) => current[c] !== target[c]);
  // Already on this generation: cheap check that `.env` and the running containers are its images
  // (no log read). A match is current; any drift is moved back below like any other update.
  if (decision.action === "verify" && changed.length === 0) {
    const live = await engine.services(dir, signal);
    if (live?.supervisor?.running && live.supervisor.image === target.supervisor && live.watchdog?.image === target.watchdog) {
      // A CLI before 0.16.31 applied this release without recording its journal format. Its
      // supervisor is the one running, so record the format now: the next release can then go in
      // place instead of waiting for one more applied generation.
      if (!options.check && state.journal === null && release.journalFormat !== null)
        writeReleaseState(dir, { ...state, journal: { format: release.journalFormat, supervisor: target.supervisor } });
      return done("current", "not_newer");
    }
  }
  const record = (outcome: UpdateOutcome, detail: string, previous: Images | null, unremoved: string[] = []): UpdateResult => {
    const journal = release.journalFormat === null ? null : { format: release.journalFormat, supervisor: target.supervisor };
    const pendingRemoval = [...new Set([...state.pendingRemoval, ...unremoved])].slice(-PENDING_REMOVAL_KEPT);
    writeReleaseState(dir, { ...state, generation: release.generation, releaseId: release.releaseId, appliedAtMs: now(), previous, journal, pendingRemoval });
    return { outcome, detail, generation: release.generation, exitCode: 0, ...tagged };
  };

  if (options.check)
    return done("planned", changed.length > 0 ? `would_update:${changed.join(",")}` : "already_configured", { ...tagged, generation: release.generation });
  // `.env` naming the release proves nothing on its own: an earlier run may have stopped after writing
  // it. Only the running containers, ready, prove the release is applied.
  if (changed.length === 0 && (await running(engine, dir, target, signal)))
    return record("recorded", "already_running_release", state.previous);

  // What a failure goes back to: today's file, or for a half-applied file the one saved before it.
  let rollbackText: string | null = envText;
  if (changed.length === 0) {
    try {
      rollbackText = readFileSync(join(dir, PREVIOUS_ENV_FILE), "utf8");
    } catch {
      rollbackText = null;
    }
  }
  const rollbackImages = rollbackText === null ? null : imagesOf(parseEnvText(rollbackText));
  // In place only when the supervisor a failure goes back to reads the release's journal format.
  const inPlace = release.journalFormat !== null && state.journal !== null && rollbackImages !== null
    && state.journal.format === release.journalFormat && state.journal.supervisor === rollbackImages.supervisor;

  const hostId = read.kind === "answered" ? read.hostId : "";
  if (!inPlace) {
    const busy = await engine.attemptContainers(dir, hostId, signal);
    if (busy === null) return done("retained", "docker_unavailable");
    if (busy > 0) return done("deferred_busy", `attempt_containers:${busy}`, tagged);
  }

  const unprepared = await engine.prepare(RELEASE_COMPONENTS.map((c) => target[c]), signal);
  if (unprepared !== null) return done("retained", unprepared, tagged);

  // Mac private thoughts storage records the supervisor image its helper runs. Every path that does
  // not end on the new release attests it back onto the images the machine keeps.
  const custodyInstalled = persistedCustody(dir, env) === "installed";
  // Null when storage holds the installed authority on these images, else why not. Re-attestation
  // keeps the installed authority; a different one would need setup, not an update.
  const attestCustody = async (images: Images): Promise<string | null> => {
    const attested = await engine.custody(dir, images, signal);
    if ("refused" in attested) return attested.refused;
    return attested.authority === env.CATALYST_THOUGHTS_CUSTODY_AUTHORITY ? null : "authority_changed";
  };
  const restoreCustody = async (images: Images | null): Promise<string | null> =>
    !custodyInstalled || images === null ? null : attestCustody(images);
  if (custodyInstalled) {
    const refused = await attestCustody(target);
    if (refused !== null) {
      const restoreRefused = await restoreCustody(rollbackImages ?? current);
      return restoreRefused === null
        ? done("retained", `custody_reattest_failed:${refused}`, tagged)
        : done("failed", `custody_restore_failed:${restoreRefused}`, { ...tagged, exitCode: 1 });
    }
  }

  // The boundary between phases: stop the supervisor so it admits nothing, then look again. A phase
  // that started since the first look keeps running, the supervisor comes back, and the update waits.
  if (!(await engine.stopSupervisor(dir, signal))) {
    await engine.composeUp(dir, signal);
    await restoreCustody(rollbackImages ?? current);
    return done("retained", "supervisor_stop_failed", tagged);
  }
  const busyAfterStop = inPlace ? 0 : await engine.attemptContainers(dir, hostId, signal);
  if (busyAfterStop !== 0) {
    await engine.composeUp(dir, signal);
    await restoreCustody(rollbackImages ?? current);
    return busyAfterStop === null
      ? done("retained", "docker_unavailable", tagged)
      : done("deferred_busy", `attempt_containers:${busyAfterStop}`, tagged);
  }

  // From here the machine changes. The previous file is the rollback.
  if (changed.length > 0) writePrivateAtomic(join(dir, PREVIOUS_ENV_FILE), envText);
  writePrivateAtomic(envPath, rewriteEnvText(envText,
    Object.fromEntries(RELEASE_COMPONENTS.map((c) => [RELEASE_ENV_KEYS[c], target[c]]))));
  if ((await engine.composeUp(dir, signal)) && (await waitReady(engine, dir, target, options, now))) {
    // Only once the new release is running and ready: the replaced images free their disk (a runner
    // image is several GB, against a free-space floor that decides whether the machine takes work).
    // A rollback or failure never reaches here, so the previous images stay for it.
    // An image still in use, such as the runner image under phases left running, is kept for a later run.
    const unremoved = changed.length > 0
      ? await engine.removeImages(changed.map((c) => current[c]).filter((ref) => ref !== ""), signal)
      : [];
    const applied = changed.length > 0 ? `updated:${changed.join(",")}` : "reconciled";
    return record("updated", inPlace ? `${applied}:in_place` : applied, changed.length > 0 ? current : state.previous, unremoved);
  }

  if (rollbackText === null || rollbackImages === null)
    return done("failed", "new_supervisor_not_ready_no_previous", { ...tagged, exitCode: 1 });
  writePrivateAtomic(envPath, rollbackText);
  const custodyRefused = await restoreCustody(rollbackImages);
  const restored = (await engine.composeUp(dir, signal)) && (await waitReady(engine, dir, rollbackImages, options, now));
  return done(restored && custodyRefused === null ? "rolled_back" : "failed",
    !restored ? "rollback_not_ready" : custodyRefused === null ? "new_supervisor_not_ready" : `custody_restore_failed:${custodyRefused}`,
    { ...tagged, exitCode: 1 });
}

async function waitReady(
  engine: RunnerUpdateEngine,
  dir: string,
  images: Images,
  options: RunnerUpdateOptions,
  now: () => number,
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.readyDeadlineMs ?? READY_DEADLINE_MS);
  for (;;) {
    if (options.signal?.aborted) return false;
    if (await running(engine, dir, images, options.signal)) return true;
    if (now() >= deadline) return false;
    await sleep(READY_POLL_MS);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An exclusive lock file holding the owner's pid. It is taken over only when that process is gone,
 *  never by age: one run can legitimately take longer than any fixed limit (three image pulls). */
export function takeLock(dir: string, nowMs: number): string | null {
  const path = join(dir, LOCK_FILE);
  const token = `${process.pid} ${nowMs}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, token);
      closeSync(fd);
      return token;
    } catch {
      try {
        const owner = Number(readFileSync(path, "utf8").split(" ")[0]);
        if (Number.isSafeInteger(owner) && owner > 0 && alive(owner)) return null;
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function releaseLock(dir: string, token: string): void {
  const path = join(dir, LOCK_FILE);
  try {
    if (readFileSync(path, "utf8") === token) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Runs inside the supervisor image with its own environment. Prints one JSON object, never the
 *  secret: the bearer is built and sent from inside the container. */
export const DESIRED_RELEASE_SCRIPT = `(async () => {
  const out = (v) => process.stdout.write(JSON.stringify(v));
  let state;
  try { state = JSON.parse(require("node:fs").readFileSync(process.env.CATALYST_HOST_CREDENTIAL_FILE, "utf8")); }
  catch { return out({ kind: "no_credential" }); }
  const e = state && state.enrollment;
  const base = process.env.CATALYST_MIRROR_URL;
  if (!state || state.version !== 1 || typeof state.secret !== "string" || !e ||
      typeof e.tenant !== "string" || typeof e.hostId !== "string" || !base) return out({ kind: "no_credential" });
  const tenant = Buffer.from(e.tenant, "utf8").toString("base64url");
  const report = (process.env.CATALYST_UPDATE_REPORT || "").length <= 512 ? process.env.CATALYST_UPDATE_REPORT : "";
  try {
    const response = await fetch(new URL(${JSON.stringify(DESIRED_RELEASE_PATH)}, base).href, {
      redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: "Bearer ctc_host_" + tenant + "." + e.hostId + "." + state.secret, accept: "application/json",
        ...(report ? { "x-catalyst-update-report": report } : {}) },
    });
    let body = null;
    try { body = await response.json(); } catch {}
    out({ kind: "answered", status: response.status, body, hostId: e.hostId });
  } catch (error) {
    out({ kind: "unreachable", detail: String((error && error.name) || "fetch failed"), hostId: e.hostId });
  }
})();`;

export const HOST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The real engine: the docker CLI and the setup engine's own pull, custody and Compose steps. */
export function dockerRunnerUpdateEngine(
  deps: { exec?: RunnerExec; env?: NodeJS.ProcessEnv; setup?: RunnerEngine } = {},
): RunnerUpdateEngine {
  const exec = deps.exec ?? spawnDocker;
  const env = Object.fromEntries(Object.entries(deps.env ?? process.env)
    .filter(([key]) => !key.startsWith("CATALYST_") && !key.startsWith("DOCKER_SOCKET_")));
  const setup = deps.setup ?? dockerRunnerEngine({ exec, env: deps.env });
  const docker = async (args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}) => {
    try {
      return await exec(args, { env, ...options });
    } catch {
      return { code: 1, stdout: "" };
    }
  };
  return {
    async desiredRelease(dir, signal, report) {
      const compose = runnerComposeArgs(dir);
      if (!compose) return { kind: "no_credential" };
      const reportEnv = report ? ["-e", `CATALYST_UPDATE_REPORT=${report}`] : [];
      const read = await docker([...compose, "run", "--rm", "-T", "--no-deps", ...reportEnv, "--entrypoint", "bun", "supervisor", "-e", DESIRED_RELEASE_SCRIPT],
        { cwd: dir, signal, timeoutMs: 120_000 });
      if (read.code !== 0) return { kind: "no_credential" };
      try {
        const parsed: unknown = JSON.parse(read.stdout);
        if (!isRecord(parsed)) return { kind: "no_credential" };
        const hostId = typeof parsed.hostId === "string" && HOST_ID.test(parsed.hostId) ? parsed.hostId : null;
        if (parsed.kind === "answered" && hostId && typeof parsed.status === "number")
          return { kind: "answered", status: parsed.status, body: parsed.body ?? null, hostId };
        if (parsed.kind === "unreachable" && hostId)
          return { kind: "unreachable", detail: String(parsed.detail ?? "fetch failed").slice(0, 80), hostId };
        return { kind: "no_credential" };
      } catch {
        return { kind: "no_credential" };
      }
    },
    async attemptContainers(_dir, hostId, signal) {
      if (!HOST_ID.test(hostId)) return null;
      const listed = await docker(["ps", "--all", "--quiet", "--filter", `label=${ATTEMPT_HOST_LABEL}=${hostId}`], { signal });
      return listed.code === 0 ? listed.stdout.split("\n").filter((line) => line.trim() !== "").length : null;
    },
    async prepare(images, signal) {
      const info = await setup.info(signal);
      if (!info) return "docker_unavailable";
      const refused = await prepareRunnerImages(setup, images, info.arch, signal);
      return refused === null ? null : `${refused.reason}${refused.image ? `:${refused.image}` : ""}`;
    },
    async custody(dir, images, signal) {
      if (!setup.nativeThoughtsCustody) return { refused: "capability_missing" };
      try {
        const result = await setup.nativeThoughtsCustody({ dir, supervisorImage: images.supervisor, runnerImage: images.runner }, signal);
        return { authority: result.envAuthority };
      } catch (error) {
        // Only the installer's fixed reasons are recorded; other exception text can carry credentials.
        return { refused: darwinThoughtsInstallRefusal(error) ?? "unclassified" };
      }
    },
    async services(dir, signal) {
      const compose = runnerComposeArgs(dir);
      if (!compose) return null;
      const service = async (name: string): Promise<ServiceState | null | undefined> => {
        const listed = await docker([...compose, "ps", "--all", "--quiet", name], { cwd: dir, signal });
        if (listed.code !== 0) return undefined;
        const id = listed.stdout.trim();
        if (id === "") return null;
        if (!/^[0-9a-f]{12,64}$/.test(id)) return undefined;
        const inspected = await docker(["inspect", "--format", "{{.State.Running}}|{{.Config.Image}}|{{.State.StartedAt}}", id], { signal });
        const [isRunning, image, started] = inspected.stdout.trim().split("|");
        const startedAtMs = Date.parse(started ?? "");
        return inspected.code === 0 && image && Number.isFinite(startedAtMs)
          ? { running: isRunning === "true", image, startedAtMs } : undefined;
      };
      const [supervisor, watchdog] = [await service("supervisor"), await service("deadline-watchdog")];
      return supervisor === undefined || watchdog === undefined ? null : { supervisor, watchdog };
    },
    async stopSupervisor(dir, signal) {
      const compose = runnerComposeArgs(dir);
      if (!compose) return false;
      return (await docker([...compose, "stop", "supervisor"], { cwd: dir, signal, timeoutMs: 120_000 })).code === 0;
    },
    async composeUp(dir, signal) {
      return (await setup.composeUp(dir, signal)).ok;
    },
    async removeImages(images, signal) {
      const kept: string[] = [];
      for (const ref of images) {
        if ((await docker(["image", "rm", ref], { signal, timeoutMs: 120_000 })).code === 0) continue;
        // Only Docker saying the image does not exist counts as removed. A refusal, or a daemon that
        // did not answer, keeps it for the next run.
        const inspect = await docker(["image", "inspect", "--format", "{{.Id}}", ref], { signal });
        if (inspect.code === 0 || !/No such image/i.test(inspect.stderr ?? "")) kept.push(ref);
      }
      return kept;
    },
    async supervisorReadySinceStart(dir, signal) {
      const compose = runnerComposeArgs(dir);
      if (!compose) return false;
      const id = (await docker([...compose, "ps", "--quiet", "supervisor"], { cwd: dir, signal })).stdout.trim();
      if (!/^[0-9a-f]{12,64}$/.test(id)) return false;
      const started = (await docker(["inspect", "--format", "{{.State.StartedAt}}", id], { signal })).stdout.trim();
      if (!Number.isFinite(Date.parse(started))) return false;
      const logs = await docker(["logs", "--since", started, id], { signal, timeoutMs: 30_000 });
      return `${logs.stdout}\n${logs.stderr ?? ""}`.includes('"event":"host_ready"');
    },
  };
}

/** The runner directory setup uses. */
export function runnerDir(ctx: Pick<Ctx, "home" | "env">): string {
  try {
    return join(onboardStateRoot(ctx.home, ctx.env), "runner");
  } catch {
    throw new CliError("The runner directory could not be found. Run catalyst setup --runner first.", "runner_directory_unavailable", 1);
  }
}

const OUTCOME_TEXT: Record<UpdateOutcome, string> = {
  current: "The runner is on the approved release.",
  recorded: "The runner was already on the approved release; recorded it.",
  updated: "The runner moved to the approved release.",
  planned: "Checked the approved release; nothing was changed.",
  deferred_busy: "A phase is running here, so the update waits for the next check.",
  waiting_window: "An approved release waits for this machine's next update window.",
  retained: "Kept the current images.",
  rolled_back: "The new supervisor did not become ready, so the previous images were restored.",
  failed: "The update could not finish. Look at the runner with docker compose ps.",
};

/** The last run's record when it ended badly: a failed or rolled-back update a person should know
 *  about even after a later check reads clean (CTC-6709). Null otherwise. */
export function lastProblem(state: ReleaseState): NonNullable<ReleaseState["last"]> | null {
  const last = state.last;
  return last !== null && (last.outcome === "failed" || last.outcome === "rolled_back") ? last : null;
}

/** One line naming the last failed or rolled-back update, for `runner update --check`. */
export function lastProblemLines(state: ReleaseState): string[] {
  const last = lastProblem(state);
  if (last === null) return [];
  const what = last.outcome === "rolled_back" ? "was rolled back" : "failed";
  return [`The last update, at ${new Date(last.atMs).toISOString()}, ${what} (${last.detail}; offered generation ${last.generation ?? "none"}).`];
}

export function updateResultLines(result: UpdateResult): string[] {
  return [
    OUTCOME_TEXT[result.outcome],
    `Release: ${result.releaseId ?? "none"}, generation ${result.generation ?? "none"} (${result.detail}).`,
  ];
}
