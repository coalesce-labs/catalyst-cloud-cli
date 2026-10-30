import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readManifest } from "./config.js";
import { dockerRunnerEngine, prepareRunnerImages, spawnDocker, type RunnerEngine, type RunnerExec } from "./onboard-runner.js";
import { defaultRun, type SchedulerRun } from "./runner-auto-update.js";
import {
  decideRelease,
  DESIRED_RELEASE_SCRIPT,
  HOST_ID,
  isRecord,
  readReleaseState,
  releaseLock,
  takeLock,
  updateReport,
  writePrivateAtomic,
  writeReleaseState,
  type DesiredReleaseRead,
  type UpdateOutcome,
  type UpdateResult,
} from "./runner-update.js";

// `catalyst runner update --fleet <dir>`: the same approved release, applied to a multi-team
// supervisor fleet (CTC-6530). One supervisor container serves several scopes from a Compose file
// written as JSON (`compose.json`), under one operator enrollment, and every host credential on the
// machine reads the same release. The fleet differs from a single-team runner in three ways:
//
//   - the images live in `compose.json`, not `.env`: `services.supervisor.image` and its
//     `environment.CATALYST_RUNNER_IMAGE`. Only those two fields change, plus the log setting
//     when the file has none;
//   - phase containers are never waited out. The supervisor is recreated alone and re-adopts the
//     running ones, which keep the image they were granted. So there is no idle gate;
//   - the deadline watchdog is a separate Compose project and is left alone. The release's watchdog
//     image is not applied here.
//
// The release is read from a one-off container of the current supervisor image that mounts only the
// credential, read-only. Readiness is per scope: every scope that logged `supervisor_scope_qualified`
// in the minutes before the update must log it again from the new container, which must stay up with
// no restart and log no `host_not_ready` for those scopes. Otherwise the previous `compose.json` comes
// back and the supervisor is recreated on it. That scope set is saved before the recreate and removed
// once it qualifies or rolls back, so a run killed in between is finished by the next one.
//
// A busy host re-adopts its live sessions before it qualifies, which can take longer than four minutes
// (CTC-8163). Each recreated supervisor, the new release's or the restored previous one's, gets four
// minutes, extended to 150 seconds past each new step it logs: fleet tenure, then a saved scope
// re-adopted, then that scope ready. No supervisor gets more than seven minutes. A restart, another
// image or `host_not_ready` still ends the wait at the next poll. At the deadline each saved scope it
// has not qualified is reported, with the gate condition its latest log line shows failing.
//
// A team can stop being delegated while an update is in flight (CTC-7569): no supervisor, new or old,
// starts its scope again. The previous release, restored, is the control. When it misses exactly the
// scopes the new supervisor missed and qualifies the rest, those scopes are dropped from the saved set
// and the new release is applied again against what is left. A later run that finds a saved set beside
// the previous release's running supervisor drops the saved scopes that supervisor no longer qualifies.
// Either way the result names each dropped scope; the new release's own log never drops one.
//
// A release can qualify and then stop receiving work minutes later (CTC-6564). A successful apply
// arms a check on the host, outside the calling process, for 10 minutes later: it reads the supervisor's
// log since the roll began and, when the release was granted no work and the fleet's acquires got no
// answer, restores the saved previous `compose.json`. `runner update --fleet --post-roll-check` is
// that check; only the armed timer runs it.
// A check that is due while an update holds the lock judges nothing; that update arms it again
// for 5 minutes after it ends (CTC-7570).

export const FLEET_COMPOSE_FILE = "compose.json";
export const PREVIOUS_COMPOSE_FILE = "compose.release-previous.json";
const CANDIDATE_COMPOSE_FILE = "compose.release-candidate.json";
/** The scopes the supervisor served before a recreate, kept until that recreate is qualified or rolled
 *  back. A run that was killed in between finds it and qualifies against it, never against the new
 *  container's own log, which would read an unqualified supervisor as serving. Only the previous
 *  release's supervisor can take a scope out of it (CTC-7569). */
export const IN_FLIGHT_FILE = "fleet-update-in-flight.json";
/** How far back a qualification counts as current before the update. The supervisor repeats it
 *  on every loop while a scope is ready, so a ready scope logs it many times in this window. */
const QUALIFIED_LOOKBACK_MS = 5 * 60_000;
const QUALIFY_MIN_MS = 90_000;
/** How long a recreated supervisor that shows no progress has to qualify every saved scope. */
const QUALIFY_DEADLINE_MS = 240_000;
/** How long past each new step of progress a recreated supervisor has to qualify (CTC-8163). */
const QUALIFY_PROGRESS_MS = 150_000;
/** The most one recreated supervisor is given, however it progresses (CTC-8163). */
const QUALIFY_CEILING_MS = 420_000;
const QUALIFY_POLL_MS = 10_000;
const CHILD_NAME_PREFIX = "catalyst-pa_";
/** What a successful apply leaves for the check: the bytes it wrote and when the roll began. */
export const POST_ROLL_ARMED_FILE = "post-roll-armed.json";
/** The check's last verdict, beside `release-state.json`. */
export const POST_ROLL_RESULT_FILE = "post-roll-result.json";
export const POST_ROLL_DELAY_MS = 10 * 60_000;
/** How long after an update run lets go of the lock a check it kept from judging runs again (CTC-7570). */
export const POST_ROLL_RETRY_DELAY_MS = 5 * 60_000;
const POST_ROLL_UNIT = "catalyst-fleet-post-roll";
/** No-response acquire retries, with no grants, that count a release as failing. */
const POST_ROLL_MAX_NO_RESPONSE = 3;

type FleetImages = { runner: string; supervisor: string };

/** The supervisor container as the Engine reports it. */
export interface FleetSupervisor {
  id: string;
  image: string;
  runnerImage: string;
  running: boolean;
  restartCount: number;
  startedAt: string;
}

/** Everything the fleet update touches outside its own files. The docker one is below; tests use fakes. */
export interface FleetUpdateEngine {
  /** `report` carries the previous run's outcome on the release read. */
  desiredRelease(dir: string, compose: Record<string, unknown>, signal?: AbortSignal, report?: string): Promise<DesiredReleaseRead>;
  /** The project's supervisor container, null when there is none, undefined when Docker could not be read. */
  supervisor(dir: string, project: string, signal?: AbortSignal): Promise<FleetSupervisor | null | undefined>;
  /** The container's log since an RFC 3339 time or a Docker duration, or null when it could not be read. */
  logs(id: string, since: string, signal?: AbortSignal): Promise<string | null>;
  /** Phase containers by id, each with a fingerprint that changes if it restarts, or null. */
  children(signal?: AbortSignal): Promise<Record<string, { running: boolean; fingerprint: string }> | null>;
  prepare(images: string[], signal?: AbortSignal): Promise<string | null>;
  /** `docker compose config --quiet` on a candidate file. */
  configValid(dir: string, project: string, file: string, signal?: AbortSignal): Promise<boolean>;
  /** Recreate only the supervisor service from `compose.json`; dependencies and children stay. */
  recreate(dir: string, project: string, signal?: AbortSignal): Promise<boolean>;
  removeImages(images: string[], signal?: AbortSignal): Promise<void>;
  /** Schedule `runner update --fleet --dir <dir> --post-roll-check` on this host after `delayMs`, outside
   *  this process. False when it could not be scheduled. */
  armPostRollCheck(dir: string, delayMs: number, signal?: AbortSignal): Promise<boolean>;
}

export interface FleetUpdateOptions {
  dir: string;
  check?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  qualifyMinMs?: number;
  qualifyDeadlineMs?: number;
  signal?: AbortSignal;
  /** Called at a qualification deadline, before any restore, with one line per saved scope the
   *  recreated supervisor had not qualified (CTC-8163). The command writes them to stderr. */
  onQualificationPending?: (line: string) => void;
}

/** The two image fields in a fleet `compose.json`, or null when the file is not a fleet layout. */
export function fleetImages(compose: unknown): FleetImages | null {
  const supervisor = isRecord(compose) && isRecord(compose.services) ? compose.services.supervisor : null;
  if (!isRecord(supervisor) || typeof supervisor.image !== "string" || !isRecord(supervisor.environment)) return null;
  const runner = supervisor.environment.CATALYST_RUNNER_IMAGE;
  return typeof runner === "string" ? { supervisor: supervisor.image, runner } : null;
}

/** `compose` with the two image fields replaced, and the log setting added when it has none
 *  (CTC-8674). A value the owner set is kept, whatever it is. */
export function withFleetImages(compose: Record<string, unknown>, images: FleetImages): Record<string, unknown> {
  const next = structuredClone(compose) as { services: { supervisor: { image: string; environment: Record<string, unknown> } } };
  next.services.supervisor.image = images.supervisor;
  next.services.supervisor.environment.CATALYST_RUNNER_IMAGE = images.runner;
  next.services.supervisor.environment.CATALYST_NODE_LOG_SHIPPING ??= "on";
  return next;
}

const logEvents = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((line) => {
    const start = line.indexOf("{");
    if (start === -1) return [];
    try {
      const parsed: unknown = JSON.parse(line.slice(start));
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
const scopeKey = (event: Record<string, unknown>): string | null =>
  typeof event.tenant === "string" && typeof event.team === "string" ? `${event.tenant}/${event.team}` : null;

/** The scopes (`tenant/team`) that logged `supervisor_scope_qualified` in this log text. */
export function qualifiedScopes(text: string): Set<string> {
  const scopes = new Set<string>();
  for (const event of logEvents(text)) {
    const key = event.event === "supervisor_scope_qualified" ? scopeKey(event) : null;
    if (key) scopes.add(key);
  }
  return scopes;
}

/** A `host_not_ready` line for one of `scopes`, or one that names no scope. Other scopes may be
 *  unready for their own reasons (a team with no repository yet) and do not stop an update. */
export function notReadyScope(text: string, scopes: ReadonlySet<string>): string | null {
  return readSupervisorLog(text, scopes).notReady;
}

/** The four conditions of the supervisor's per-scope qualification gate, from its latest valid
 *  `supervisor_scope_qualification_state` line for that scope (CTC-8163). */
interface GateSnapshot {
  resourcesReady: boolean;
  scopeEligible: boolean;
  readyUntilValid: boolean;
  sessionsReadopted: boolean;
}
const GATE_CODES: readonly (readonly [keyof GateSnapshot, string])[] = [
  ["resourcesReady", "resources_ready"],
  ["scopeEligible", "scope_eligible"],
  ["readyUntilValid", "ready_until"],
  ["sessionsReadopted", "sessions_readopted"],
];

/** What qualify() reads from one read of a recreated supervisor's log, kept only for `scopes`. */
interface SupervisorLog {
  /** The first `host_not_ready` for one of `scopes`, "unscoped" for one naming no scope, or null. */
  notReady: string | null;
  qualified: Set<string>;
  /** The supervisor logged `supervisor_fleet_tenure`. */
  tenure: boolean;
  readopted: Set<string>;
  ready: Set<string>;
  gates: Map<string, GateSnapshot>;
}

/** One pass over the log text for everything qualify() reads. Lines for other scopes, and lines that
 *  are not JSON or lack a field, are skipped. */
function readSupervisorLog(text: string, scopes: ReadonlySet<string>): SupervisorLog {
  const log: SupervisorLog = { notReady: null, qualified: new Set(), tenure: false, readopted: new Set(), ready: new Set(), gates: new Map() };
  for (const event of logEvents(text)) {
    const key = scopeKey(event);
    if (event.event === "host_not_ready" && log.notReady === null && (key === null || scopes.has(key))) log.notReady = key ?? "unscoped";
    if (event.event === "supervisor_fleet_tenure") log.tenure = true;
    if (key === null || !scopes.has(key)) continue;
    if (event.event === "supervisor_scope_qualified") log.qualified.add(key);
    else if (event.event === "supervisor_readopted") log.readopted.add(key);
    else if (event.event === "host_ready") log.ready.add(key);
    else if (event.event === "supervisor_scope_qualification_state") {
      const { resourcesReady, scopeEligible, readyUntilValid, sessionsReadopted } = event;
      if (typeof resourcesReady === "boolean" && typeof scopeEligible === "boolean" && typeof readyUntilValid === "boolean" && typeof sessionsReadopted === "boolean")
        log.gates.set(key, { resourcesReady, scopeEligible, readyUntilValid, sessionsReadopted });
    }
  }
  return log;
}

/** A recreated supervisor's qualification deadline, and the steps of progress it has counted for that
 *  container (CTC-8163). The sets only ever hold required scopes. */
interface QualifyBudget {
  deadline: number;
  readonly ceiling: number;
  tenure: boolean;
  readonly readopted: Set<string>;
  readonly ready: Set<string>;
}

/** Count the steps `log` shows that `budget` has not counted yet: fleet tenure, a scope re-adopted, and
 *  a re-adopted scope ready. A scope ready before its re-adoption shows counts once that does. Any new
 *  step moves the deadline to `QUALIFY_PROGRESS_MS` past `atMs`, never earlier and never past the ceiling. */
function countProgress(budget: QualifyBudget, log: SupervisorLog, atMs: number): void {
  let progressed = false;
  if (log.tenure && !budget.tenure) {
    budget.tenure = true;
    progressed = true;
  }
  for (const scope of log.readopted) {
    if (budget.readopted.has(scope)) continue;
    budget.readopted.add(scope);
    progressed = true;
  }
  for (const scope of log.ready) {
    if (!budget.readopted.has(scope) || budget.ready.has(scope)) continue;
    budget.ready.add(scope);
    progressed = true;
  }
  if (progressed) budget.deadline = Math.min(budget.ceiling, Math.max(budget.deadline, atMs + QUALIFY_PROGRESS_MS));
}

/** The longest one recreated supervisor is given to qualify, however it progresses. */
const qualifyCeilingMs = (options: FleetUpdateOptions): number => Math.max(QUALIFY_CEILING_MS, options.qualifyDeadlineMs ?? QUALIFY_DEADLINE_MS);

/** A scope as printed: anything outside printable ASCII, and the backslash that starts an escape,
 *  escaped as `\uXXXX`, and at most 120 characters. */
const printableScope = (scope: string): string => {
  const escaped = scope.replace(/[^\x21-\x5b\x5d-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length > 120 ? `${escaped.slice(0, 120)}...` : escaped;
};

/** The gate conditions a missing scope's snapshot shows failing, sorted; `diagnostic_unavailable`
 *  without one, and `qualification_event_missing` when every condition held. */
function failedGates(snapshot: GateSnapshot | undefined): string[] {
  if (snapshot === undefined) return ["diagnostic_unavailable"];
  const failed = GATE_CODES.filter(([field]) => !snapshot[field]).map(([, code]) => code).sort();
  return failed.length > 0 ? failed : ["qualification_event_missing"];
}

/** One line per scope in `missing`, sorted by scope. `gates` null: the log could not be read. */
function qualificationPendingLines(roll: Roll, missing: ReadonlySet<string>, gates: ReadonlyMap<string, GateSnapshot> | null): string[] {
  return [...missing].sort().map((scope) =>
    `fleet qualification pending: roll=${roll} scope=${printableScope(scope)} failed=${failedGates(gates?.get(scope)).join(",")}`);
}

function readInFlight(dir: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, IN_FLIGHT_FILE), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.scopes)) return null;
    const scopes = parsed.scopes.filter((scope): scope is string => typeof scope === "string");
    return scopes.length > 0 ? new Set(scopes) : null;
  } catch {
    return null;
  }
}

/** Save the scopes the next recreate has to qualify, replacing any saved before. */
function saveInFlight(dir: string, scopes: ReadonlySet<string>, atMs: number): void {
  writePrivateAtomic(join(dir, IN_FLIGHT_FILE), `${JSON.stringify({ version: 1, scopes: [...scopes].sort(), atMs })}\n`);
}

function clearInFlight(dir: string): void {
  try {
    unlinkSync(join(dir, IN_FLIGHT_FILE));
  } catch {
    // Already gone.
  }
}

/** The images a saved `compose.json` names, or null when there is none or it is not a fleet layout. */
function savedImages(path: string): FleetImages | null {
  try {
    return fleetImages(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** The detail token naming scopes dropped from the requirement, sorted; empty when there are none. */
const droppedDetail = (scopes: readonly string[]): string =>
  scopes.length > 0 ? `;dropped_scope:${[...scopes].sort().join(",")}` : "";

const removeFile = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** What the apply recorded for the check. */
export interface PostRollArmed {
  version: 1;
  /** When the roll began; the check reads the supervisor's log from here. */
  sinceMs: number;
  /** sha256 of the `compose.json` bytes the apply wrote. */
  composeSha256: string;
  generation: number | null;
  releaseId: string | null;
  /** The generation the fleet was on before this release. */
  fromGeneration: number | null;
  armedAtMs: number;
}

export type PostRollVerdict = "PASS" | "STANDS_IDLE" | "ROLLED_BACK" | "ROLLBACK_REFUSED" | "ROLLBACK_FAILED";
const POST_ROLL_VERDICTS: readonly string[] = ["PASS", "STANDS_IDLE", "ROLLED_BACK", "ROLLBACK_REFUSED", "ROLLBACK_FAILED"];

export interface PostRollResult {
  version: 1;
  at: string;
  since: string;
  granted: number;
  noResponse: number;
  answered: number;
  verdict: PostRollVerdict;
  /** The release the check judged. */
  generation: number | null;
  releaseId: string | null;
  /** A rollback: the generation it left and the one it went back to (null before any was recorded). */
  rolledBackFrom?: number | null;
  rolledBackTo?: number | null;
  reason?: string;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

function readPostRollArmed(dir: string): PostRollArmed | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, POST_ROLL_ARMED_FILE), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    const sinceMs = numberOrNull(parsed.sinceMs);
    if (sinceMs === null || typeof parsed.composeSha256 !== "string") return null;
    return {
      version: 1,
      sinceMs,
      composeSha256: parsed.composeSha256,
      generation: numberOrNull(parsed.generation),
      releaseId: stringOrNull(parsed.releaseId),
      fromGeneration: numberOrNull(parsed.fromGeneration),
      armedAtMs: numberOrNull(parsed.armedAtMs) ?? sinceMs,
    };
  } catch {
    return null;
  }
}

/** The last post-roll check's record, or null when there is none. */
export function readPostRollResult(dir: string): PostRollResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, POST_ROLL_RESULT_FILE), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.verdict !== "string" || !POST_ROLL_VERDICTS.includes(parsed.verdict)) return null;
    if (typeof parsed.at !== "string" || typeof parsed.since !== "string") return null;
    return {
      version: 1,
      at: parsed.at,
      since: parsed.since,
      granted: numberOrNull(parsed.granted) ?? 0,
      noResponse: numberOrNull(parsed.noResponse) ?? 0,
      answered: numberOrNull(parsed.answered) ?? 0,
      verdict: parsed.verdict as PostRollVerdict,
      generation: numberOrNull(parsed.generation),
      releaseId: stringOrNull(parsed.releaseId),
      ...(parsed.rolledBackFrom !== undefined ? { rolledBackFrom: numberOrNull(parsed.rolledBackFrom) } : {}),
      ...(parsed.rolledBackTo !== undefined ? { rolledBackTo: numberOrNull(parsed.rolledBackTo) } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

const VERDICT_TEXT: Record<PostRollVerdict, string> = {
  PASS: "passed: the release was granted work",
  STANDS_IDLE: "left the release in place: no work was granted and nothing showed a failure",
  ROLLED_BACK: "rolled the release back: it was granted no work or its supervisor was not running",
  ROLLBACK_REFUSED: "found no work granted and did not roll back",
  ROLLBACK_FAILED: "tried to roll back and could not confirm the supervisor",
};

/** One line naming the last post-roll verdict, for `runner update --check --fleet`. */
export function postRollLines(result: PostRollResult | null): string[] {
  if (result === null) return [];
  const detail = [
    ...(result.verdict === "ROLLED_BACK" ? [`back to generation ${result.rolledBackTo ?? "none"}`] : result.reason ? [result.reason] : []),
    `generation ${result.generation ?? "none"}`,
    `since ${result.since}: ${result.granted} granted, ${result.noResponse} no response, ${result.answered} answered`,
  ];
  return [`The last post-roll check, at ${result.at}, ${VERDICT_TEXT[result.verdict]} (${detail.join("; ")}).`];
}

const eventLines = (text: string, event: string): string[] =>
  text.split("\n").filter((line) => new RegExp(`"event"\\s*:\\s*"${event}"`).test(line));

/** The counts the post-roll rule reads from the supervisor's log since the roll began. `answered` is
 *  informational: an idle supervisor whose acquire gets an empty queue may log nothing at all. */
export function postRollCounts(text: string): { granted: number; noResponse: number; answered: number } {
  const granted = eventLines(text, "work_granted").length;
  const refused = eventLines(text, "acquire_refused").length;
  const none = eventLines(text, "acquire_none").length;
  const noResponse = text.split("\n").filter((line) => line.includes("acquire_retry") && line.includes("(no response)")).length;
  return { granted, noResponse, answered: granted + refused + none };
}

/** Whether a release with these counts stopped receiving work: nothing granted since the roll began and
 *  at least three acquire retries that got no response. Silence alone is not a failure, because a healthy
 *  idle host logs nothing; a supervisor that is not running is judged separately, from the container. */
export const postRollFailing = (counts: { granted: number; noResponse: number }): boolean =>
  counts.granted === 0 && counts.noResponse >= POST_ROLL_MAX_NO_RESPONSE;

/** Record what the apply wrote and ask the engine for the check. The note joins the result's detail
 *  when the check could not be armed; the apply itself still succeeded. */
async function armPostRollCheck(engine: FleetUpdateEngine, dir: string, armed: PostRollArmed, signal?: AbortSignal): Promise<string> {
  try {
    writePrivateAtomic(join(dir, POST_ROLL_ARMED_FILE), `${JSON.stringify(armed, null, 2)}\n`);
    // The verdict on an earlier release says nothing about this one.
    removeFile(join(dir, POST_ROLL_RESULT_FILE));
    return (await engine.armPostRollCheck(dir, POST_ROLL_DELAY_MS, signal)) ? "" : ";post_roll_check_not_armed";
  } catch {
    return ";post_roll_check_not_armed";
  }
}

/** The armed check runs once, from a one-shot timer. When it was due while an update held the lock, or
 *  Docker could not be read, it judged nothing and left the armed file; a reboot loses the timer the same
 *  way (CTC-7570). The update holding the lock arms it again for a few minutes later, before it lets go:
 *  while the lock is held no check is part-way through a judgment, so the arm's stop of the check's unit
 *  interrupts nothing. The check cannot arm itself: that stop would end its own unit. A check this run
 *  armed is not due yet and is left alone. */
async function rearmOverdueCheck(engine: FleetUpdateEngine, dir: string, now: () => number, signal?: AbortSignal): Promise<void> {
  const armed = readPostRollArmed(dir);
  if (armed === null || now() < armed.armedAtMs + POST_ROLL_DELAY_MS) return;
  try {
    await engine.armPostRollCheck(dir, POST_ROLL_RETRY_DELAY_MS, signal);
  } catch {
    // The next run tries again.
  }
}

export async function runFleetUpdate(engine: FleetUpdateEngine, options: FleetUpdateOptions): Promise<UpdateResult> {
  const { dir } = options;
  const now = options.now ?? Date.now;
  if (!existsSync(join(dir, FLEET_COMPOSE_FILE)))
    return { outcome: "failed", detail: "fleet_not_installed", generation: null, exitCode: 1 };
  const lock = options.check ? null : takeLock(dir, now());
  if (!options.check && lock === null)
    return { outcome: "retained", detail: "update_running", generation: readReleaseState(dir).generation, exitCode: 0 };
  try {
    const result = await update(engine, options, now);
    if (!options.check) {
      const state = readReleaseState(dir);
      writeReleaseState(dir, { ...state, last: { atMs: now(), outcome: result.outcome, detail: result.detail, generation: result.generation } });
    }
    return result;
  } finally {
    if (lock !== null) {
      await rearmOverdueCheck(engine, dir, now, options.signal);
      releaseLock(dir, lock);
    }
  }
}

async function update(engine: FleetUpdateEngine, options: FleetUpdateOptions, now: () => number): Promise<UpdateResult> {
  const { dir, signal } = options;
  const composePath = join(dir, FLEET_COMPOSE_FILE);
  const state = readReleaseState(dir);
  const done = (outcome: UpdateOutcome, detail: string, extra: Partial<UpdateResult> = {}): UpdateResult =>
    ({ outcome, detail, generation: state.generation, exitCode: 0, ...extra });

  const composeText = readFileSync(composePath, "utf8");
  let compose: unknown;
  try {
    compose = JSON.parse(composeText);
  } catch {
    compose = null;
  }
  const current = fleetImages(compose);
  const project = isRecord(compose) && typeof compose.name === "string" ? compose.name : "";
  if (!isRecord(compose) || current === null || !/^[a-z0-9][a-z0-9_-]*$/.test(project))
    return done("failed", "fleet_compose_unrecognized", { exitCode: 1 });

  const read = await engine.desiredRelease(dir, compose, signal, options.check ? undefined : updateReport(state, readManifest().version));
  const decision = decideRelease(state.generation, read);
  if (decision.action === "retain")
    return decision.reason === "not_newer"
      ? done("current", "not_newer")
      : done("retained", decision.reason, { exitCode: decision.reason === "credential_refused" || decision.reason === "no_credential" ? 1 : 0 });
  const { release } = decision;
  const target: FleetImages = { runner: release.images.runner.reference, supervisor: release.images.supervisor.reference };
  const changed = (["runner", "supervisor"] as const).filter((c) => current[c] !== target[c]);
  const tagged = { releaseId: release.releaseId };
  // A release the post-roll check rolled back stays rolled back while it is the approved one; a newer
  // generation is applied normally (CTC-6564).
  const rolled = readPostRollResult(dir);
  if (changed.length > 0 && rolled?.verdict === "ROLLED_BACK" && rolled.releaseId === release.releaseId && rolled.generation === release.generation)
    return done("rolled_back", `post_roll_rolled_back:granted=${rolled.granted},no_response=${rolled.noResponse},answered=${rolled.answered}`,
      { ...tagged, generation: release.generation, exitCode: 1 });
  const live = await engine.supervisor(dir, project, signal);
  if (live === undefined) return done("retained", "docker_unavailable", tagged);
  const runs = (images: FleetImages) =>
    !!live?.running && live.image === images.supervisor && live.runnerImage === images.runner;
  const inFlight = readInFlight(dir);
  if (inFlight === null && decision.action === "verify" && changed.length === 0 && runs(target)) return done("current", "not_newer");
  if (options.check)
    return done("planned", changed.length > 0 ? `would_update:${changed.join(",")}` : "already_configured", { ...tagged, generation: release.generation });

  // The scopes the running supervisor qualifies are what the new one has to qualify again, unless an
  // earlier run stopped mid-recreate: then the scopes it saved are the baseline.
  let scopes = inFlight;
  /** Saved scopes the previous release's supervisor no longer qualifies, named in the result (CTC-7569). */
  let dropped: string[] = [];
  if (scopes === null) {
    if (!live?.running) return done("retained", "supervisor_not_running", { ...tagged, exitCode: 1 });
    const recent = await engine.logs(live.id, new Date(now() - QUALIFIED_LOOKBACK_MS).toISOString(), signal);
    if (recent === null) return done("retained", "docker_unavailable", tagged);
    scopes = qualifiedScopes(recent);
    if (scopes.size === 0) return done("retained", "no_qualified_scope", { ...tagged, exitCode: 1 });
  } else {
    // An earlier run that ended back on the previous release, its rollback unqualified, left its scopes
    // saved. Only when compose.json and the running supervisor are that previous release, up long enough
    // to have qualified every scope it serves, does its log trim the saved set: a saved scope it no
    // longer qualifies stopped being delegated. A `host_not_ready` for a saved scope is a scope still
    // started, not one dropped. Anything less keeps the saved set whole. Long enough is the most any
    // recreated supervisor is given, since this run cannot see how it progressed (CTC-8163).
    const previous = savedImages(join(dir, PREVIOUS_COMPOSE_FILE));
    const onPrevious = previous !== null && current.runner === previous.runner && current.supervisor === previous.supervisor && runs(previous);
    if (live && onPrevious && now() - Date.parse(live.startedAt) >= qualifyCeilingMs(options)) {
      const recent = await engine.logs(live.id, new Date(now() - QUALIFIED_LOOKBACK_MS).toISOString(), signal);
      const serving = recent === null || notReadyScope(recent, scopes) !== null ? new Set<string>() : qualifiedScopes(recent);
      const kept = [...scopes].filter((scope) => serving.has(scope));
      if (kept.length > 0 && kept.length < scopes.size) {
        dropped = [...scopes].filter((scope) => !serving.has(scope));
        scopes = new Set(kept);
      }
    }
  }

  const record = (outcome: UpdateOutcome, detail: string, previous: FleetImages | null, exitCode = 0): UpdateResult => {
    writeReleaseState(dir, {
      ...state,
      generation: release.generation,
      releaseId: release.releaseId,
      appliedAtMs: now(),
      // The watchdog is not this updater's to move, so it records none.
      previous: previous ? { ...previous, watchdog: "" } : state.previous,
    });
    return { outcome, detail, generation: release.generation, exitCode, ...tagged };
  };
  if (inFlight === null && changed.length === 0 && runs(target)) return record("recorded", "already_running_release", null);

  // What a failure goes back to: today's file, or for a half-applied file the one saved before it.
  let rollbackText: string | null = composeText;
  if (changed.length === 0) {
    try {
      rollbackText = readFileSync(join(dir, PREVIOUS_COMPOSE_FILE), "utf8");
    } catch {
      rollbackText = null;
    }
  }
  let rollbackImages: FleetImages | null = null;
  try {
    rollbackImages = rollbackText === null ? null : fleetImages(JSON.parse(rollbackText));
  } catch {
    rollbackImages = null;
  }

  const unprepared = await engine.prepare([target.runner, target.supervisor], signal);
  if (unprepared !== null) return done("retained", unprepared, tagged);

  const candidateText = `${JSON.stringify(withFleetImages(compose, target), null, 2)}\n`;
  const candidatePath = join(dir, CANDIDATE_COMPOSE_FILE);
  writePrivateAtomic(candidatePath, candidateText);
  const valid = await engine.configValid(dir, project, candidatePath, signal);
  try {
    unlinkSync(candidatePath);
  } catch {
    // Already gone.
  }
  if (!valid) return done("retained", "compose_config_invalid", { ...tagged, exitCode: 1 });
  const childrenBefore = await engine.children(signal);
  if (childrenBefore === null) return done("retained", "docker_unavailable", tagged);

  // From here the machine changes. The previous file is the rollback.
  const rollStartMs = now();
  if (changed.length > 0) writePrivateAtomic(join(dir, PREVIOUS_COMPOSE_FILE), composeText);
  saveInFlight(dir, scopes, now());
  /** Write `text` as compose.json, recreate the supervisor alone on it and qualify it against `required`. */
  const roll = async (which: Roll, text: string, images: FleetImages, required: ReadonlySet<string>): Promise<Qualification> => {
    writePrivateAtomic(composePath, text);
    if (!(await engine.recreate(dir, project, signal))) return { ok: false, reason: "recreate_failed" };
    return qualify(engine, dir, project, images, required, options, now, which);
  };
  const succeed = async (droppedScopes: readonly string[]): Promise<UpdateResult> => {
    clearInFlight(dir);
    if (changed.length > 0) await engine.removeImages(changed.map((c) => current[c]), signal);
    // The recreate must leave every running phase container as it was: it is re-adopted, not restarted.
    const childrenAfter = await engine.children(signal);
    const disturbed = childrenAfter === null
      ? -1
      : Object.entries(childrenBefore).filter(([id, before]) => {
          const after = childrenAfter[id];
          return before.running && after?.running === true && after.fingerprint !== before.fingerprint;
        }).length;
    const armed: PostRollArmed = {
      version: 1, sinceMs: rollStartMs, composeSha256: sha256(candidateText), generation: release.generation,
      releaseId: release.releaseId, fromGeneration: state.generation, armedAtMs: now(),
    };
    const detail = (changed.length > 0 ? `updated:${changed.join(",")}` : "reconciled") + droppedDetail(droppedScopes) +
      await armPostRollCheck(engine, dir, armed, signal);
    const previous = changed.length > 0 ? current : null;
    return disturbed === 0
      ? record("updated", detail, previous)
      : record("updated", `${detail};${disturbed < 0 ? "children_unreadable" : `children_changed:${disturbed}`}`, previous, 1);
  };

  const candidate = await roll("candidate", candidateText, target, scopes);
  if (candidate.ok) return succeed(dropped);
  if (rollbackText === null || rollbackImages === null)
    return done("failed", `new_supervisor_not_qualified_no_previous${droppedDetail(dropped)}`, { ...tagged, exitCode: 1 });
  let restored = await roll("rollback", rollbackText, rollbackImages, scopes);
  // The previous release is the control (CTC-7569). Missing exactly the scopes the candidate missed while
  // qualifying the rest, it shows those scopes stopped being delegated, not that the candidate broke them:
  // the candidate is applied again without them, and recorded only once it qualifies what is left.
  const gone = lostDelegation(candidate, restored, scopes);
  if (gone !== null) {
    const kept = new Set([...scopes].filter((scope) => !gone.has(scope)));
    saveInFlight(dir, kept, now());
    if ((await roll("candidate", candidateText, target, kept)).ok) return succeed([...dropped, ...gone]);
    restored = await roll("rollback", rollbackText, rollbackImages, kept);
  }
  // A rollback that did not qualify keeps the baseline for the next run.
  if (restored.ok) clearInFlight(dir);
  return done(restored.ok ? "rolled_back" : "failed",
    `${restored.ok ? "new_supervisor_not_qualified" : "rollback_not_qualified"}${droppedDetail(dropped)}`, { ...tagged, exitCode: 1 });
}

/** Put `text` back as `compose.json` and recreate the supervisor alone on it. */
async function restoreCompose(engine: FleetUpdateEngine, dir: string, project: string, text: string, signal?: AbortSignal): Promise<boolean> {
  writePrivateAtomic(join(dir, FLEET_COMPOSE_FILE), text);
  return engine.recreate(dir, project, signal);
}

export interface PostRollCheckOptions {
  dir: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PostRollCheckOutcome {
  /** `PASS`, `ROLLED_BACK` and the other verdicts, or why the check could not judge. */
  detail: string;
  /** The recorded verdict; null when the check judged nothing; the armed file stays, and the next update run arms the check again. */
  result: PostRollResult | null;
  exitCode: number;
}

/** The check a successful apply armed, run on the host 10 minutes later (CTC-6564). A release whose
 *  supervisor is not running, or that was granted no work while three acquire retries got no response,
 *  goes back to the saved previous `compose.json`, but only if `compose.json` still holds the bytes the
 *  apply wrote. A running supervisor with no grants and fewer no-response retries stands. */
export async function runFleetPostRollCheck(engine: FleetUpdateEngine, options: PostRollCheckOptions): Promise<PostRollCheckOutcome> {
  const { dir, signal } = options;
  const now = options.now ?? Date.now;
  const stay = (detail: string, exitCode = 0): PostRollCheckOutcome => ({ detail, result: null, exitCode });
  if (!existsSync(join(dir, FLEET_COMPOSE_FILE))) return stay("fleet_not_installed", 1);
  const armed = readPostRollArmed(dir);
  if (armed === null) return stay("no_post_roll_check_armed");
  const lock = takeLock(dir, now());
  if (lock === null) return stay("update_running");
  try {
    const composeText = readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8");
    let compose: unknown;
    try {
      compose = JSON.parse(composeText);
    } catch {
      compose = null;
    }
    const project = isRecord(compose) && typeof compose.name === "string" ? compose.name : "";
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) return stay("fleet_compose_unrecognized", 1);
    const live = await engine.supervisor(dir, project, signal);
    if (live === undefined) return stay("docker_unavailable", 1);
    const since = new Date(armed.sinceMs).toISOString();
    // A missing or stopped supervisor is a failure on its own; its log is not read.
    const notRunning = live === null || !live.running;
    let counts = { granted: 0, noResponse: 0, answered: 0 };
    if (!notRunning) {
      const text = await engine.logs(live.id, since, signal);
      if (text === null) return stay("docker_unavailable", 1);
      counts = postRollCounts(text);
    }

    const finish = (verdict: PostRollVerdict, extra: Partial<Pick<PostRollResult, "reason" | "rolledBackFrom" | "rolledBackTo">> = {}, exitCode = 0): PostRollCheckOutcome => {
      const result: PostRollResult = {
        version: 1, at: new Date(now()).toISOString(), since, ...counts, verdict,
        generation: armed.generation, releaseId: armed.releaseId, ...extra,
      };
      writePrivateAtomic(join(dir, POST_ROLL_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
      removeFile(join(dir, POST_ROLL_ARMED_FILE));
      return { detail: verdict, result, exitCode };
    };
    if (!notRunning) {
      if (counts.granted > 0) return finish("PASS");
      if (!postRollFailing(counts)) return finish("STANDS_IDLE");
    }

    const refuse = (reason: string) => finish("ROLLBACK_REFUSED", { reason }, 1);
    if (sha256(composeText) !== armed.composeSha256) return refuse("compose_changed_since_roll");
    let previousText: string;
    let previous: FleetImages | null;
    try {
      previousText = readFileSync(join(dir, PREVIOUS_COMPOSE_FILE), "utf8");
      previous = fleetImages(JSON.parse(previousText));
    } catch {
      return refuse("no_previous_compose");
    }
    if (previous === null) return refuse("no_previous_compose");
    // An update that started from this release and did not finish saved this release's own file as the
    // previous one (CTC-7570). Restoring it would move nothing and record a rollback that never happened.
    const current = fleetImages(compose);
    if (current !== null && previous.runner === current.runner && previous.supervisor === current.supervisor)
      return refuse("previous_compose_is_this_release");
    // The apply removed the images it replaced, so the previous ones may need pulling again.
    const unprepared = await engine.prepare([previous.runner, previous.supervisor], signal);
    if (unprepared !== null) return finish("ROLLBACK_FAILED", { reason: unprepared }, 1);
    const restored = await restoreCompose(engine, dir, project, previousText, signal);
    const after = restored ? await engine.supervisor(dir, project, signal) : null;
    const running = !!after && after.running && after.image === previous.supervisor && after.runnerImage === previous.runner;
    const moved = { rolledBackFrom: armed.generation, rolledBackTo: armed.fromGeneration };
    return running
      ? finish("ROLLED_BACK", { ...moved, reason: notRunning ? "supervisor_not_running" : "no_work_granted" }, 1)
      : finish("ROLLBACK_FAILED", { ...moved, reason: restored ? "supervisor_not_running" : "recreate_failed" }, 1);
  } finally {
    releaseLock(dir, lock);
  }
}

/** How a recreated supervisor fared. Only `missing` names scopes: the supervisor stayed up on the right
 *  images, logged no `host_not_ready` for a required scope, and its log, read at the deadline, never
 *  qualified these. That is the one failure a scope's lost delegation can explain (CTC-7569). */
type Qualification =
  | { ok: true }
  | { ok: false; reason: "aborted" | "recreate_failed" | "restarted" | "wrong_image" | "host_not_ready" | "deadline" }
  | { ok: false; reason: "missing"; missing: ReadonlySet<string> };

/** Which supervisor a recreate puts up: the release's, or the previous one restored. */
type Roll = "candidate" | "rollback";

/** The recreated supervisor runs `images`, stays up with no restart, logs no `host_not_ready` for a
 *  scope it must serve, and qualifies every one of `scopes`, held for the minimum window. Its deadline
 *  moves with the progress it logs (CTC-8163); the restart, image and `host_not_ready` exits come first. */
async function qualify(
  engine: FleetUpdateEngine,
  dir: string,
  project: string,
  images: FleetImages,
  scopes: ReadonlySet<string>,
  options: FleetUpdateOptions,
  now: () => number,
  roll: Roll,
): Promise<Qualification> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  const budget: QualifyBudget = {
    deadline: start + (options.qualifyDeadlineMs ?? QUALIFY_DEADLINE_MS),
    ceiling: start + qualifyCeilingMs(options),
    tenure: false,
    readopted: new Set(),
    ready: new Set(),
  };
  const minimum = start + (options.qualifyMinMs ?? QUALIFY_MIN_MS);
  let id: string | null = null;
  for (;;) {
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };
    const live = await engine.supervisor(dir, project, options.signal);
    // What this poll's log has not qualified yet, and its gate lines; null when the supervisor or its
    // log could not be read.
    let missing: Set<string> | null = null;
    let gates: ReadonlyMap<string, GateSnapshot> | null = null;
    if (live) {
      id ??= live.id;
      if (live.id !== id || !live.running || live.restartCount !== 0) return { ok: false, reason: "restarted" };
      if (live.image !== images.supervisor || live.runnerImage !== images.runner) return { ok: false, reason: "wrong_image" };
      const text = await engine.logs(live.id, live.startedAt, options.signal);
      if (text !== null) {
        const log = readSupervisorLog(text, scopes);
        if (log.notReady !== null) return { ok: false, reason: "host_not_ready" };
        missing = new Set([...scopes].filter((scope) => !log.qualified.has(scope)));
        if (now() >= minimum && missing.size === 0) return { ok: true };
        countProgress(budget, log, now());
        gates = log.gates;
      }
    }
    if (now() >= budget.deadline) {
      for (const line of qualificationPendingLines(roll, missing ?? scopes, gates)) {
        try {
          options.onQualificationPending?.(line);
        } catch {
          // A line that could not be written never holds up the other lines or the restore.
        }
      }
      return missing !== null && missing.size > 0 ? { ok: false, reason: "missing", missing } : { ok: false, reason: "deadline" };
    }
    await sleep(QUALIFY_POLL_MS);
  }
}

/** The scopes to drop when the candidate and the previous release, its control, both failed only by
 *  missing scopes, the same ones, and the control qualified at least one other `required` scope. Null
 *  otherwise: then the candidate is what failed, or nothing shows which. */
function lostDelegation(candidate: Qualification, control: Qualification, required: ReadonlySet<string>): ReadonlySet<string> | null {
  if (candidate.ok || control.ok || candidate.reason !== "missing" || control.reason !== "missing") return null;
  const same = candidate.missing.size === control.missing.size && [...candidate.missing].every((scope) => control.missing.has(scope));
  return same && control.missing.size < required.size ? control.missing : null;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/** The one volume or bind in `service.volumes` that holds `file`, as a read-only `--mount` value. */
export function credentialMount(compose: Record<string, unknown>, service: Record<string, unknown>, file: string): string | null {
  const project = typeof compose.name === "string" ? compose.name : "";
  const topLevel = isRecord(compose.volumes) ? compose.volumes : {};
  let best: { target: string; mount: string | null } | null = null;
  for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
    let source: unknown;
    let target: unknown;
    let type: unknown;
    if (typeof entry === "string") {
      [source, target] = entry.split(":");
      type = typeof source === "string" && source.startsWith("/") ? "bind" : "volume";
    } else if (isRecord(entry)) {
      ({ source, target, type } = entry);
    }
    if (typeof source !== "string" || typeof target !== "string" || source === "") continue;
    if (file !== target && !file.startsWith(`${target.replace(/\/$/, "")}/`)) continue;
    // The deepest mount holding the file is the one the container reads it from.
    if (best !== null && best.target.length >= target.length) continue;
    const declared = topLevel[source];
    const name = isRecord(declared) && typeof declared.name === "string" ? declared.name
      : isRecord(declared) && declared.external === true ? source : `${project}_${source}`;
    const mount = type === "bind" ? `type=bind,src=${source},dst=${target},readonly`
      : type === "volume" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? `type=volume,src=${name},dst=${target},readonly` : null;
    best = { target, mount };
  }
  return best?.mount ?? null;
}

/** The real engine: the docker CLI, and the setup engine's own pull. */
export function dockerFleetUpdateEngine(
  deps: {
    exec?: RunnerExec;
    env?: NodeJS.ProcessEnv;
    setup?: RunnerEngine;
    /** How the post-roll check is scheduled: a transient systemd timer on Linux. Tests pass fakes. */
    timer?: { platform?: NodeJS.Platform; uid?: number; command?: readonly string[]; run?: SchedulerRun };
  } = {},
): FleetUpdateEngine {
  const exec = deps.exec ?? spawnDocker;
  const env = Object.fromEntries(Object.entries(deps.env ?? process.env)
    .filter(([key]) => !key.startsWith("CATALYST_") && !key.startsWith("DOCKER_SOCKET_")));
  const setup = deps.setup ?? dockerRunnerEngine({ exec, env: deps.env });
  const docker = async (args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}) => {
    try {
      return await exec(args, { env, ...options });
    } catch {
      return { code: 1, stdout: "", stderr: "" };
    }
  };
  const compose = (dir: string, project: string, file = join(dir, FLEET_COMPOSE_FILE)) =>
    ["compose", "--project-name", project, "--file", file];
  return {
    // Not `compose run`: that would mount the Docker socket and every scope's state. This container
    // gets the credential alone, read-only, the script's configuration and an optional update report.
    async desiredRelease(_dir, file, signal, report) {
      const service = isRecord(file.services) && isRecord(file.services.supervisor) ? file.services.supervisor : null;
      const environment = service && isRecord(service.environment) ? service.environment : null;
      const credential = environment?.CATALYST_HOST_CREDENTIAL_FILE;
      const mirror = environment?.CATALYST_MIRROR_URL;
      if (!service || typeof service.image !== "string" || typeof credential !== "string" || typeof mirror !== "string")
        return { kind: "no_credential" };
      const mount = credentialMount(file, service, credential);
      if (!mount) return { kind: "no_credential" };
      const user = typeof service.user === "string" && /^[0-9]+(:[0-9]+)?$/.test(service.user) ? ["--user", service.user] : [];
      const reportEnv = report ? ["--env", `CATALYST_UPDATE_REPORT=${report}`] : [];
      const read = await docker(["run", "--rm", "--network", "bridge", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", ...user, "--mount", mount,
        "--env", `CATALYST_HOST_CREDENTIAL_FILE=${credential}`, "--env", `CATALYST_MIRROR_URL=${mirror}`, ...reportEnv,
        "--entrypoint", "bun", service.image, "-e", DESIRED_RELEASE_SCRIPT], { signal, timeoutMs: 120_000 });
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
    async supervisor(dir, project, signal) {
      const listed = await docker([...compose(dir, project), "ps", "--all", "--quiet", "supervisor"], { cwd: dir, signal });
      if (listed.code !== 0) return undefined;
      const id = listed.stdout.trim();
      if (id === "") return null;
      if (!CONTAINER_ID.test(id)) return undefined;
      const inspected = await docker(["inspect", id], { signal });
      try {
        const [c] = JSON.parse(inspected.stdout) as { Id: string; RestartCount: number; State: { Running: boolean; StartedAt: string }; Config: { Image: string; Env: string[] } }[];
        const runner = c!.Config.Env.find((line) => line.startsWith("CATALYST_RUNNER_IMAGE="));
        return {
          id: c!.Id,
          image: c!.Config.Image,
          runnerImage: runner ? runner.slice("CATALYST_RUNNER_IMAGE=".length) : "",
          running: c!.State.Running,
          restartCount: c!.RestartCount,
          startedAt: c!.State.StartedAt,
        };
      } catch {
        return undefined;
      }
    },
    async logs(id, since, signal) {
      if (!CONTAINER_ID.test(id)) return null;
      const read = await docker(["logs", "--since", since, id], { signal, timeoutMs: 30_000 });
      return read.code === 0 ? `${read.stdout}\n${read.stderr ?? ""}` : null;
    },
    async children(signal) {
      const listed = await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=${CHILD_NAME_PREFIX}`], { signal });
      if (listed.code !== 0) return null;
      const ids = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => CONTAINER_ID.test(line));
      if (ids.length === 0) return {};
      const inspected = await docker(["inspect", ...ids], { signal });
      try {
        const containers = JSON.parse(inspected.stdout) as { Id: string; Image: string; RestartCount: number; State: { Running: boolean; Pid: number; StartedAt: string } }[];
        return Object.fromEntries(containers.map((c) => [c.Id, {
          running: c.State.Running,
          fingerprint: `${c.State.StartedAt}|${c.State.Pid}|${c.Image}|${c.RestartCount}`,
        }]));
      } catch {
        return null;
      }
    },
    async prepare(images, signal) {
      const info = await setup.info(signal);
      if (!info) return "docker_unavailable";
      const refused = await prepareRunnerImages(setup, images, info.arch, signal);
      return refused === null ? null : `${refused.reason}${refused.image ? `:${refused.image}` : ""}`;
    },
    async configValid(dir, project, file, signal) {
      return (await docker([...compose(dir, project, file), "config", "--quiet"], { cwd: dirname(file), signal })).code === 0;
    },
    async recreate(dir, project, signal) {
      return (await docker([...compose(dir, project), "up", "--detach", "--no-deps", "--force-recreate", "supervisor"],
        { cwd: dir, signal, timeoutMs: 120_000 })).code === 0;
    },
    async removeImages(images, signal) {
      for (const ref of images) await docker(["image", "rm", ref], { signal, timeoutMs: 120_000 });
    },
    // A transient systemd timer outlives this process and the operator's session. Root's runs under the
    // system manager; anyone else's runs under their user manager, which needs lingering to outlive a logout.
    async armPostRollCheck(dir, delayMs) {
      const timer = deps.timer ?? {};
      if ((timer.platform ?? process.platform) !== "linux") return false;
      const command = timer.command ?? (process.argv[1] ? [process.execPath, resolve(process.argv[1])] : null);
      if (command === null) return false;
      const run = timer.run ?? defaultRun;
      const manager = (timer.uid ?? process.getuid?.()) === 0 ? [] : ["--user"];
      const source = deps.env ?? process.env;
      const carried = (["PATH", "HOME"] as const).flatMap((key) => (source[key] ? [`--setenv=${key}=${source[key]}`] : []));
      try {
        // A timer armed by an earlier apply is replaced, not duplicated.
        run("systemctl", [...manager, "stop", `${POST_ROLL_UNIT}.timer`, `${POST_ROLL_UNIT}.service`]);
        return run("systemd-run", [...manager, "--quiet", "--collect", `--unit=${POST_ROLL_UNIT}`, `--on-active=${Math.ceil(delayMs / 1000)}s`,
          "--description=Catalyst fleet post-roll check", ...carried, "--", ...command, "runner", "update", "--fleet", "--dir", dir, "--post-roll-check"]).status === 0;
      } catch {
        return false;
      }
    },
  };
}
