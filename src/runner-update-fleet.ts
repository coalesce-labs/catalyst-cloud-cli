import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { dockerRunnerEngine, prepareRunnerImages, spawnDocker, type RunnerEngine, type RunnerExec } from "./onboard-runner.js";
import {
  decideRelease,
  DESIRED_RELEASE_SCRIPT,
  HOST_ID,
  isRecord,
  readReleaseState,
  releaseLock,
  takeLock,
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
//     `environment.CATALYST_RUNNER_IMAGE`. Only those two fields change;
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

export const FLEET_COMPOSE_FILE = "compose.json";
export const PREVIOUS_COMPOSE_FILE = "compose.release-previous.json";
const CANDIDATE_COMPOSE_FILE = "compose.release-candidate.json";
/** The scopes the supervisor served before a recreate, kept until that recreate is qualified or rolled
 *  back. A run that was killed in between finds it and qualifies against it, never against the new
 *  container's own log, which would read an unqualified supervisor as serving. */
export const IN_FLIGHT_FILE = "fleet-update-in-flight.json";
/** How far back a qualification counts as current before the update. The supervisor repeats it
 *  on every loop while a scope is ready, so a ready scope logs it many times in this window. */
const QUALIFIED_LOOKBACK_MS = 5 * 60_000;
const QUALIFY_MIN_MS = 90_000;
const QUALIFY_DEADLINE_MS = 240_000;
const QUALIFY_POLL_MS = 10_000;
const CHILD_NAME_PREFIX = "catalyst-pa_";

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
  desiredRelease(dir: string, compose: Record<string, unknown>, signal?: AbortSignal): Promise<DesiredReleaseRead>;
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
}

export interface FleetUpdateOptions {
  dir: string;
  check?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  qualifyMinMs?: number;
  qualifyDeadlineMs?: number;
  signal?: AbortSignal;
}

/** The two image fields in a fleet `compose.json`, or null when the file is not a fleet layout. */
export function fleetImages(compose: unknown): FleetImages | null {
  const supervisor = isRecord(compose) && isRecord(compose.services) ? compose.services.supervisor : null;
  if (!isRecord(supervisor) || typeof supervisor.image !== "string" || !isRecord(supervisor.environment)) return null;
  const runner = supervisor.environment.CATALYST_RUNNER_IMAGE;
  return typeof runner === "string" ? { supervisor: supervisor.image, runner } : null;
}

/** `compose` with only the two image fields replaced. */
export function withFleetImages(compose: Record<string, unknown>, images: FleetImages): Record<string, unknown> {
  const next = structuredClone(compose) as { services: { supervisor: { image: string; environment: Record<string, unknown> } } };
  next.services.supervisor.image = images.supervisor;
  next.services.supervisor.environment.CATALYST_RUNNER_IMAGE = images.runner;
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
  for (const event of logEvents(text)) {
    if (event.event !== "host_not_ready") continue;
    const key = scopeKey(event);
    if (key === null || scopes.has(key)) return key ?? "unscoped";
  }
  return null;
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

function clearInFlight(dir: string): void {
  try {
    unlinkSync(join(dir, IN_FLIGHT_FILE));
  } catch {
    // Already gone.
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
    if (lock !== null) releaseLock(dir, lock);
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

  const read = await engine.desiredRelease(dir, compose, signal);
  const decision = decideRelease(state.generation, read);
  if (decision.action === "retain")
    return decision.reason === "not_newer"
      ? done("current", "not_newer")
      : done("retained", decision.reason, { exitCode: decision.reason === "credential_refused" || decision.reason === "no_credential" ? 1 : 0 });
  const { release } = decision;
  const target: FleetImages = { runner: release.images.runner.reference, supervisor: release.images.supervisor.reference };
  const changed = (["runner", "supervisor"] as const).filter((c) => current[c] !== target[c]);
  const tagged = { releaseId: release.releaseId };
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
  if (scopes === null) {
    if (!live?.running) return done("retained", "supervisor_not_running", { ...tagged, exitCode: 1 });
    const recent = await engine.logs(live.id, new Date(now() - QUALIFIED_LOOKBACK_MS).toISOString(), signal);
    if (recent === null) return done("retained", "docker_unavailable", tagged);
    scopes = qualifiedScopes(recent);
    if (scopes.size === 0) return done("retained", "no_qualified_scope", { ...tagged, exitCode: 1 });
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
  if (changed.length > 0) writePrivateAtomic(join(dir, PREVIOUS_COMPOSE_FILE), composeText);
  writePrivateAtomic(join(dir, IN_FLIGHT_FILE), `${JSON.stringify({ version: 1, scopes: [...scopes].sort(), atMs: now() })}\n`);
  writePrivateAtomic(composePath, candidateText);
  if ((await engine.recreate(dir, project, signal)) && (await qualify(engine, dir, project, target, scopes, options, now))) {
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
    const detail = changed.length > 0 ? `updated:${changed.join(",")}` : "reconciled";
    const previous = changed.length > 0 ? current : null;
    return disturbed === 0
      ? record("updated", detail, previous)
      : record("updated", `${detail};${disturbed < 0 ? "children_unreadable" : `children_changed:${disturbed}`}`, previous, 1);
  }

  if (rollbackText === null || rollbackImages === null)
    return done("failed", "new_supervisor_not_qualified_no_previous", { ...tagged, exitCode: 1 });
  writePrivateAtomic(composePath, rollbackText);
  const restored = (await engine.recreate(dir, project, signal)) &&
    (await qualify(engine, dir, project, rollbackImages, scopes, options, now));
  // A rollback that did not qualify keeps the baseline for the next run.
  if (restored) clearInFlight(dir);
  return done(restored ? "rolled_back" : "failed", restored ? "new_supervisor_not_qualified" : "rollback_not_qualified",
    { ...tagged, exitCode: 1 });
}

/** The recreated supervisor runs `images`, stays up with no restart, logs no `host_not_ready` for a
 *  scope it must serve, and qualifies every one of `scopes`, held for the minimum window. */
async function qualify(
  engine: FleetUpdateEngine,
  dir: string,
  project: string,
  images: FleetImages,
  scopes: ReadonlySet<string>,
  options: FleetUpdateOptions,
  now: () => number,
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  const deadline = start + (options.qualifyDeadlineMs ?? QUALIFY_DEADLINE_MS);
  const minimum = start + (options.qualifyMinMs ?? QUALIFY_MIN_MS);
  let id: string | null = null;
  for (;;) {
    if (options.signal?.aborted) return false;
    const live = await engine.supervisor(dir, project, options.signal);
    if (live) {
      id ??= live.id;
      if (live.id !== id || !live.running || live.restartCount !== 0) return false;
      if (live.image !== images.supervisor || live.runnerImage !== images.runner) return false;
      const text = await engine.logs(live.id, live.startedAt, options.signal);
      if (text !== null) {
        if (notReadyScope(text, scopes) !== null) return false;
        const seen = qualifiedScopes(text);
        if (now() >= minimum && [...scopes].every((scope) => seen.has(scope))) return true;
      }
    }
    if (now() >= deadline) return false;
    await sleep(QUALIFY_POLL_MS);
  }
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
  deps: { exec?: RunnerExec; env?: NodeJS.ProcessEnv; setup?: RunnerEngine } = {},
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
    // gets the credential alone, read-only, and the two variables the script reads.
    async desiredRelease(_dir, file, signal) {
      const service = isRecord(file.services) && isRecord(file.services.supervisor) ? file.services.supervisor : null;
      const environment = service && isRecord(service.environment) ? service.environment : null;
      const credential = environment?.CATALYST_HOST_CREDENTIAL_FILE;
      const mirror = environment?.CATALYST_MIRROR_URL;
      if (!service || typeof service.image !== "string" || typeof credential !== "string" || typeof mirror !== "string")
        return { kind: "no_credential" };
      const mount = credentialMount(file, service, credential);
      if (!mount) return { kind: "no_credential" };
      const user = typeof service.user === "string" && /^[0-9]+(:[0-9]+)?$/.test(service.user) ? ["--user", service.user] : [];
      const read = await docker(["run", "--rm", "--network", "bridge", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", ...user, "--mount", mount,
        "--env", `CATALYST_HOST_CREDENTIAL_FILE=${credential}`, "--env", `CATALYST_MIRROR_URL=${mirror}`,
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
  };
}
