// replica.ts — the optional local replica: `replica start|stop|status|sql|schema`.
//
// `status` is the check every skill runs first and it needs no network and no SDK: the pidfile, the
// writer-lock heartbeat, and the `sync_meta.cursor` row (read through node:sqlite read-only). Exit
// 0 fresh, 1 present but stale, 2 not configured, 3 absent. `--probe` adds the one network call.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { flagBool, flagInt, flagString, positionals, type ParsedArgs } from "./args.js";
import { apiBase, loadConfig, readManifest, replicaDbPath, replicaOptedIn, type Ctx, type CustomerConfig } from "./config.js";
import { detachSelf } from "./detach.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";
import { authStrategyFor } from "./oauth.js";
import { loadSdk, type Sdk } from "./sdk.js";
import { createEventSync, type EventsSdk, type EventSyncHandle } from "./events.js";
import { BUN_MIN, FIX_COMMAND } from "./runtime.js";
import type { WebSocketFactory } from "@catalyst-cloud/sdk/node";

export const DEFAULT_STALE_MS = 15_000;

// CTC-2158: node:sqlite used to be a top-level static `import { DatabaseSync } from "node:sqlite"`.
// Because this module is in EVERY verb's module graph (cli.ts imports it for `ready`'s replica
// check), a runtime without node:sqlite aborted the WHOLE CLI during module loading — before
// main(), so before any of ready.ts's per-check try/catch could turn it into a fix line. Measured
// under bun 1.3.14: `bun bin/catalyst-skills.js ready` -> "catalyst-skills: failed to load:
// ResolveMessage: No such built-in module: node:sqlite", raw, with no fix and no who.
// `createRequire(...)("node:sqlite")` inside a try/catch is catchable on every runtime measured
// (Node 22/26, bun 1.3.14/1.4.2) and is synchronous, which replicaStatus and the sql/schema verbs
// need. It is loaded on first use, memoised per process.
type SqliteModule = typeof import("node:sqlite");
export type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;

let sqliteCache: SqliteModule | null = null;

/** Load `node:sqlite` on first use. Any failure (module absent on this runtime) becomes a named
 *  CliError pointing at the bun floor and the one fix command — never a raw ResolveMessage. */
export function loadSqlite(req: (id: string) => unknown = createRequire(import.meta.url)): SqliteModule {
  if (sqliteCache) return sqliteCache;
  try {
    sqliteCache = req("node:sqlite") as SqliteModule;
    return sqliteCache;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `node:sqlite is not available on this runtime (${detail}) — the replica needs it. ` +
        `Supported: Node 22.5+ has node:sqlite built in; bun needs ${BUN_MIN} or newer. ` +
        `One command fixes it without changing your default Node: ${FIX_COMMAND}`,
      "sqlite-unavailable",
    );
  }
}

/** Test seam: forget the cached module. */
export function resetSqliteCache(): void {
  sqliteCache = null;
}

export type ReplicaVerdict = "fresh" | "stale" | "not-configured" | "absent";

/** The writer's own bookkeeping, beside the pidfile and the lock. A sidecar rather than a row in the
 *  replica's sync_meta: `replicaStatus` answers "absent" before it ever opens the database, and a
 *  seed that fails mid-stream has already truncated that database (CTC-2499). */
export interface ReplicaWriterState {
  /** epoch ms of the last write */
  updatedAt: number;
  /** the writer process that wrote it */
  pid: number;
  /** consecutive failed snapshot pulls; zeroed by a snapshot that completes */
  consecutiveFailures: number;
  lastError: string | null;
  lastFailureAt: number | null;
  /** set only once the writer gave up; null while it is still retrying */
  stopped: { at: number; reason: string; restartWith: string } | null;
  /** The CLI version the writer runs, so a release check can tell an old detached writer from a
   *  current one (CTC-6708). Absent on a record written before it was kept. */
  version?: string;
}

export interface ReplicaStatus {
  verdict: ReplicaVerdict;
  exitCode: 0 | 1 | 2 | 3;
  /** This machine opted in to local sync (CATALYST_REPLICA_DB, or replicaDb in the machine paths
   *  file). False reads apart from a writer that is down: the machine reads the cloud (CTC-4508). */
  configured: boolean;
  dbPath: string | null;
  cursor: number | null;
  heartbeatAgeMs: number | null;
  lockPid: number | null;
  pidfilePid: number | null;
  writerAlive: boolean;
  reasons: string[];
  head?: number;
  lag?: number;
  writer: ReplicaWriterState | null;
}

export function pidfilePath(dbPath: string): string {
  return `${dbPath}.pid`;
}
export function lockPath(dbPath: string): string {
  return `${dbPath}.writer.lock`;
}
export function writerStatePath(dbPath: string): string {
  return `${dbPath}.writer.state`;
}

/** Read the writer's state sidecar. A missing file, unparseable JSON, or a record with the wrong
 *  shape (a hand-edited or truncated file) all read as "no record", never a throw — readLock's
 *  contract, followed here. */
export function readWriterState(dbPath: string): ReplicaWriterState | null {
  try {
    const rec = JSON.parse(readFileSync(writerStatePath(dbPath), "utf8")) as Partial<ReplicaWriterState>;
    const stoppedOk =
      rec.stopped === null ||
      (typeof rec.stopped === "object" &&
        rec.stopped !== null &&
        typeof rec.stopped.at === "number" &&
        typeof rec.stopped.reason === "string" &&
        typeof rec.stopped.restartWith === "string");
    if (
      typeof rec.updatedAt !== "number" ||
      typeof rec.pid !== "number" ||
      typeof rec.consecutiveFailures !== "number" ||
      !(rec.lastError === null || typeof rec.lastError === "string") ||
      !(rec.lastFailureAt === null || typeof rec.lastFailureAt === "number") ||
      !stoppedOk ||
      !(rec.version === undefined || typeof rec.version === "string")
    ) {
      return null;
    }
    return rec as ReplicaWriterState;
  } catch {
    return null;
  }
}

export function writeWriterState(dbPath: string, s: Omit<ReplicaWriterState, "updatedAt" | "version">, nowMs: number): void {
  writeFileSync(writerStatePath(dbPath), JSON.stringify({ ...s, version: readManifest().version, updatedAt: nowMs }));
}

/** Remove the writer state sidecar; a no-op (never throws) when it is already gone. */
export function clearWriterState(dbPath: string): void {
  try {
    unlinkSync(writerStatePath(dbPath));
  } catch {
    // already gone
  }
}

export function pidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export function readPidfile(dbPath: string): number | null {
  const p = pidfilePath(dbPath);
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isInteger(n) ? n : null;
}

function readLock(dbPath: string): { pid: number; heartbeat: number } | null {
  try {
    const rec = JSON.parse(readFileSync(lockPath(dbPath), "utf8")) as { pid?: unknown; heartbeat?: unknown };
    if (typeof rec.pid === "number" && typeof rec.heartbeat === "number") return { pid: rec.pid, heartbeat: rec.heartbeat };
    return null;
  } catch {
    return null;
  }
}

/** Read `sync_meta.cursor` read-only through node:sqlite; null when the table or row is absent. */
export function readCursor(dbPath: string): number | null {
  let db: DatabaseSync | null = null;
  try {
    db = new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta'").get();
    if (!table) return null;
    const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'cursor'").get() as { value?: unknown } | undefined;
    if (!row || row.value === null || row.value === undefined || row.value === "") return null;
    const n = Number(row.value);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const NOT_CONNECTED = "not connected";
const CLOUD_READS_LINE = "replica: not configured (cloud reads; local sync is opt-in)";

export interface StatusOptions {
  staleMs?: number;
  nowMs?: number;
  dbPath?: string;
}

/** The in-process status logic `query` and `ready` reuse. */
export function replicaStatus(ctx: Ctx, cfg: CustomerConfig | null, opts: StatusOptions = {}): ReplicaStatus {
  const base: ReplicaStatus = {
    verdict: "not-configured",
    exitCode: 2,
    configured: false,
    dbPath: null,
    cursor: null,
    heartbeatAgeMs: null,
    lockPid: null,
    pidfilePid: null,
    writerAlive: false,
    reasons: [],
    writer: null,
  };
  if (!cfg) return { ...base, reasons: [NOT_CONNECTED] };
  let dbPath: string;
  try {
    dbPath = opts.dbPath ?? replicaDbPath(cfg, ctx.home, ctx.env);
  } catch (error) {
    if (error instanceof CliError && error.code === "replica-not-configured") return { ...base, reasons: [error.message] };
    throw error;
  }
  const configured = replicaOptedIn(ctx.home, ctx.env);
  const writer = readWriterState(dbPath);
  if (!existsSync(dbPath)) return { ...base, verdict: "absent", exitCode: 3, configured, dbPath, reasons: ["no replica file"], writer };
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = opts.nowMs ?? ctx.now().getTime();
  const lock = readLock(dbPath);
  const pidfilePid = readPidfile(dbPath);
  const heartbeatAgeMs = lock ? Math.max(0, nowMs - lock.heartbeat) : null;
  const writerAlive = pidAlive(lock?.pid ?? null) || pidAlive(pidfilePid);
  const cursor = readCursor(dbPath);
  const reasons: string[] = [];
  if (!lock) reasons.push("no writer lock");
  else if (heartbeatAgeMs !== null && heartbeatAgeMs >= staleMs) reasons.push(`heartbeat ${heartbeatAgeMs}ms old (stale after ${staleMs}ms)`);
  if (cursor === null) reasons.push("no cursor");
  if (!writerAlive) reasons.push("no live writer process");
  const fresh = reasons.length === 0;
  return {
    verdict: fresh ? "fresh" : "stale",
    exitCode: fresh ? 0 : 1,
    configured,
    dbPath,
    cursor,
    heartbeatAgeMs,
    lockPid: lock?.pid ?? null,
    pidfilePid,
    writerAlive,
    reasons,
    writer,
  };
}

function baseStatusLine(s: ReplicaStatus): string {
  switch (s.verdict) {
    case "not-configured":
      return s.reasons[0] === NOT_CONNECTED ? `replica: not configured (${s.reasons.join("; ")})` : CLOUD_READS_LINE;
    case "absent":
      if (!s.configured) return CLOUD_READS_LINE;
      return `replica: absent at ${s.dbPath} — start it with: catalyst replica start --detach`;
    case "fresh":
      return `replica: fresh at ${s.dbPath} (cursor ${s.cursor}, heartbeat ${s.heartbeatAgeMs}ms ago${s.lag !== undefined ? `, ${s.lag} behind head ${s.head}` : ""})`;
    case "stale":
      return `replica: stale at ${s.dbPath} (${s.reasons.join("; ")}${s.cursor !== null ? `; cursor ${s.cursor}` : ""}) — reads fall back to the API`;
  }
}

/** Is a process that could still be writing this replica alive? The lock/pidfile liveness
 *  `replicaStatus` already computed, or the pid the writer stamped on its own record. Both renderers
 *  ask before describing that record in the present tense: the sidecar outlives a SIGKILL, a crash
 *  and a reboot, and "is backing off" about a dead process sends a customer off to wait for a retry
 *  that will never come (CTC-2499). */
export function writerIsRunning(s: ReplicaStatus): boolean {
  return s.writerAlive || pidAlive(s.writer?.pid ?? null);
}

export function statusLine(s: ReplicaStatus): string {
  const base = baseStatusLine(s);
  const w = s.writer;
  if (w?.stopped) {
    return (
      `${base} — the writer stopped ${new Date(w.stopped.at).toISOString()}: ${w.stopped.reason} ` +
      `(last error: ${w.lastError}); restart it with: ${w.stopped.restartWith}`
    );
  }
  if (w && w.consecutiveFailures > 0) {
    if (!writerIsRunning(s)) {
      return (
        `${base} — the writer recorded ${w.consecutiveFailures} failed snapshot pulls and is no longer running ` +
        `(last error: ${w.lastError}); restart it with: ${REPLICA_RESTART_COMMAND}`
      );
    }
    return `${base} — the writer has failed ${w.consecutiveFailures} snapshot pulls in a row and is backing off (last error: ${w.lastError})`;
  }
  return base;
}

// ── engines ──────────────────────────────────────────────────────────────────────────────────────

export interface EngineDeps {
  /** Resolve the better-sqlite3 driver; the default is a real require. Injectable for tests. */
  requireDriver?: () => unknown;
  readonly?: boolean;
}

/** better-sqlite3 when it resolves and constructs, else node:sqlite — with exactly one stderr line
 *  on the fallback so the choice is visible. */
export async function engineFor(sdk: Sdk, dbPath: string, ctx: Pick<Ctx, "stderr"> & { env?: NodeJS.ProcessEnv }, deps: EngineDeps = {}) {
  const requireDriver = deps.requireDriver ?? (() => createRequire(import.meta.url)("better-sqlite3"));
  try {
    const mod = requireDriver() as { default?: unknown } | undefined;
    const driver = (mod && typeof mod === "object" && "default" in mod ? mod.default : mod) as Parameters<Sdk["betterSqlite3Engine"]>[0];
    if (typeof driver !== "function") throw new Error("better-sqlite3 resolved to a non-constructor");
    return deps.readonly ? sdk.betterSqlite3ReadonlyEngine(driver, dbPath) : sdk.betterSqlite3Engine(driver, dbPath);
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    // node:sqlite is the supported path (CTC-4272): say nothing when it works, except under CATALYST_DEBUG.
    if (ctx.env?.CATALYST_DEBUG === "1") ctx.stderr(`[catalyst] better-sqlite3 unavailable (${why}); using node:sqlite`);
    return deps.readonly ? sdk.nodeSqliteReadonlyEngine(dbPath) : sdk.nodeSqliteEngine(dbPath);
  }
}

// ── the verb ─────────────────────────────────────────────────────────────────────────────────────

export interface ReplicaDeps {
  detach?: typeof detachSelf;
  /** Injectable socket factory for `start` (tests); defaults to the runtime WebSocket. */
  wsFactory?: WebSocketFactory;
  /** For `start`: resolve when the process should shut down (tests); default waits for SIGINT/SIGTERM. */
  waitForStop?: () => Promise<void>;
  argv?: string[];
  engineDeps?: EngineDeps;
  loadEventsSdk?: () => Promise<EventsSdk>;
  /** Injected so tests never wait on the wall clock (the same seam as oauth.ts's RefreshDeps). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can pin the jitter exactly. Defaults to Math.random. */
  random?: () => number;
  /** Test-only tuning of the supervisor; production uses the module constants below. */
  snapshotRetry?: { baseBackoffMs?: number; maxBackoffMs?: number; maxFailures?: number; liveStableMs?: number };
  /** Test-only: the SDK's snapshot no-progress bound; production uses SNAPSHOT_IDLE_TIMEOUT_MS. */
  snapshotIdleTimeoutMs?: number;
  /** Test-only: the SDK `start` builds its replica from, so a test can read the options it passes. */
  loadSdk?: () => Promise<Sdk>;
}

/** How long a snapshot pull may go with no progress before the SDK aborts it (CTC-6569). The mirror
 *  can spend up to 120 s preparing a large workspace's snapshot before its first byte, and the SDK's
 *  old 30 s default aborted nearly every such pull, so the replica never synced. host-sync and the web
 *  app pass the same 150 s. Still an idle bound: it re-arms on every chunk. */
export const SNAPSHOT_IDLE_TIMEOUT_MS = 150_000;

export const SNAPSHOT_BASE_BACKOFF_MS = 30_000;
export const SNAPSHOT_MAX_BACKOFF_MS = 900_000; // 15 minutes
export const SNAPSHOT_MAX_FAILURES = 5;
/** How long a live session must hold before the supervisor calls the writer recovered. A warm boot
 *  emits no "resyncing", so a writer that recovered WITHOUT a re-seed has no transition to reset its
 *  count on; staying live is that signal. The failing warm loop never reaches it — its resync demand
 *  fails and tears the attempt down first (CTC-2499). */
export const SNAPSHOT_LIVE_STABLE_MS = 60_000;
export const REPLICA_RESTART_COMMAND = "catalyst replica start --detach";

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function defaultWaitForStop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

/** Full jitter (AWS "Exponential Backoff and Jitter"): a uniform draw from [0, bound), where the
 *  bound doubles per consecutive failure and is clamped at the cap. */
export function backoffDelayMs(consecutiveFailures: number, opts: { baseMs: number; maxMs: number; random: () => number }): number {
  const bound = Math.min(opts.baseMs * 2 ** Math.max(0, consecutiveFailures - 1), opts.maxMs);
  return Math.floor(opts.random() * bound);
}

function releaseOwnPidfile(dbPath: string): void {
  try {
    if (readPidfile(dbPath) === process.pid) unlinkSync(pidfilePath(dbPath));
  } catch {
    // pidfile already gone
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A rejection the SDK raises so the CALLER stops — not a snapshot that failed. `recordable` says
 *  whether this process earned the right to write the writer record: the single-writer lock and the
 *  CTC-582 account fence both fire against a replica a DIFFERENT process or tenant owns, and
 *  "refuses loudly and writes NOTHING" covers our sidecar too (CTC-2499). */
export interface NonRetryableStart {
  reason: string;
  recordable: boolean;
}

/** Classify a `start()` rejection: null when it is an ordinary failed snapshot pull and the
 *  supervisor should count it, back off and retry. */
export function classifyStartError(err: unknown): NonRetryableStart | null {
  const reason = messageOf(err);
  if ((err as { name?: unknown } | null)?.name === "ReplicaAccountMismatchError") return { reason, recordable: false };
  if (reason.includes("another writer owns this replica")) return { reason, recordable: false };
  // start()'s own lifecycle guards: a caller bug, never a tenant-side failure.
  if (reason.includes("start() already called") || reason.includes("start() after close()")) return { reason, recordable: false };
  return null;
}

export async function cmdReplica(args: ParsedArgs, ctx: Ctx, deps: ReplicaDeps = {}): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub) throw new UsageError("replica needs a subcommand: start | stop | status | sql | schema");
  if (sub === "status") return cmdStatus(args, ctx);
  const cfg = loadConfig(ctx.home);
  if (!cfg) throw new CliError("not connected yet — run login first", "not-configured");
  const dbPath = flagString(args, "db") ?? replicaDbPath(cfg, ctx.home, ctx.env);
  switch (sub) {
    case "start":
      return cmdStart(args, ctx, cfg, dbPath, deps);
    case "stop":
      return cmdStop(ctx, dbPath);
    case "sql":
      return cmdSql(args, ctx, dbPath, rest.join(" "), deps);
    case "schema":
      return cmdSchema(args, ctx, dbPath, rest[0]);
    default:
      throw new UsageError(`unknown replica subcommand: ${sub}`);
  }
}

async function cmdStatus(args: ParsedArgs, ctx: Ctx): Promise<number> {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    cfg = null;
  }
  const status = replicaStatus(ctx, cfg, {
    staleMs: flagInt(args, "stale-ms", DEFAULT_STALE_MS),
    dbPath: flagString(args, "db"),
  });
  if (flagBool(args, "probe") && cfg && status.verdict !== "not-configured") {
    const head = await apiClient(cfg, ctx).getJson<{ cursor?: number }>("/api/v1/snapshot", { query: { head: 1 } });
    if (typeof head.body.cursor === "number") {
      status.head = head.body.cursor;
      status.lag = status.cursor === null ? head.body.cursor : head.body.cursor - status.cursor;
    }
  }
  ctx.stdout(args.json ? JSON.stringify(status) : statusLine(status));
  return status.exitCode;
}

async function cmdStart(args: ParsedArgs, ctx: Ctx, cfg: CustomerConfig, dbPath: string, deps: ReplicaDeps): Promise<number> {
  if (flagBool(args, "detach")) {
    const argv = (deps.argv ?? process.argv.slice(1)).filter((a) => a !== "--detach");
    const { pid } = (deps.detach ?? detachSelf)(argv, ctx.env);
    writeFileSync(pidfilePath(dbPath), `${pid}\n`);
    ctx.stdout(`replica writer started in the background (pid ${pid}, db ${dbPath}); check with: catalyst replica status`);
    return 0;
  }
  const sdk = await (deps.loadSdk ?? loadSdk)();

  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const baseMs = deps.snapshotRetry?.baseBackoffMs ?? SNAPSHOT_BASE_BACKOFF_MS;
  const maxMs = deps.snapshotRetry?.maxBackoffMs ?? SNAPSHOT_MAX_BACKOFF_MS;
  const maxFailures = deps.snapshotRetry?.maxFailures ?? SNAPSHOT_MAX_FAILURES;
  const liveStableMs = deps.snapshotRetry?.liveStableMs ?? SNAPSHOT_LIVE_STABLE_MS;

  // Registered ONCE, not per attempt, so a supervised run does not pile up signal handlers.
  let stopRequested = false;
  const stopSignal = (deps.waitForStop ?? defaultWaitForStop)().then(() => {
    stopRequested = true;
  });

  let eventSync: EventSyncHandle | null = null;
  let failures = 0;

  /** A new run never inherits an old run's verdict — but it discards it only once it OWNS the
   *  replica. `start()` claims the writer lock before it does anything else, so an attempt that gets
   *  past that lock is ours; clearing up front deleted a LIVE writer's record whenever a second
   *  `replica start` lost the lock race (CTC-2499). */
  let recordOwned = false;
  const takeOwnershipOfRecord = (): void => {
    if (recordOwned) return;
    recordOwned = true;
    clearWriterState(dbPath);
  };
  const resetFailures = (): void => {
    if (failures === 0) return;
    failures = 0;
    writeWriterState(dbPath, { pid: process.pid, consecutiveFailures: 0, lastError: null, lastFailureAt: null, stopped: null }, ctx.now().getTime());
  };

  for (;;) {
    const engine = await engineFor(sdk, dbPath, ctx, deps.engineDeps);
    let seedInFlight = false; // a /snapshot pull is running RIGHT NOW
    let seedCompleted = false; // ...and the last one finished; what follows belongs to the socket
    let attemptError: string | null = null;
    // A box rather than a `let`: TypeScript narrows a captured `let` initialised to null down to
    // `never`, and the supervisor below has to read what these callbacks wrote.
    const fatal: { stop: NonRetryableStart | null } = { stop: null };
    let signalFailure!: () => void;
    const failed = new Promise<void>((res) => (signalFailure = res));

    const replica = new sdk.CatalystReplica({
      baseUrl: apiBase(cfg),
      account: cfg.account,
      accountSource: "declared",
      auth: authStrategyFor(ctx, cfg),
      dbPath,
      engine,
      fetchImpl: ctx.fetch,
      wsFactory: deps.wsFactory,
      snapshotIdleTimeoutMs: deps.snapshotIdleTimeoutMs ?? SNAPSHOT_IDLE_TIMEOUT_MS,
      log: (level, msg, extra) => ctx.stderr(`[replica ${level}] ${msg}${extra ? ` ${safeJson(extra)}` : ""}`),
      onStatus: (s) => {
        ctx.stderr(`[replica] status=${s}`);
        // A "live" that does NOT follow a re-seed is just the socket coming up — the warm failing
        // loop passes through it every cycle, so it must not reset the count (CTC-2499).
        if (s === "resyncing") {
          seedInFlight = true;
          seedCompleted = false;
          return;
        }
        // openSocket() runs only after the seed has committed its cursor, so "connecting" is the
        // SDK's one observable "the snapshot completed" edge. Everything after it is socket work: a
        // blocked WebSocket upgrade is not a failed snapshot pull (CTC-2499).
        if (s === "connecting") {
          if (seedInFlight) {
            seedInFlight = false;
            seedCompleted = true;
          }
          return;
        }
        if (s === "live") {
          if (seedCompleted) {
            seedCompleted = false;
            resetFailures();
          }
          return;
        }
        if ((s === "reconnecting" || s === "error") && seedInFlight && attemptError === null) {
          seedInFlight = false;
          attemptError = "the snapshot pull failed or ended early";
          // SYNCHRONOUS inside onStatus: LiveSyncClient.stop() sets `stopped = true` as its first
          // statement, and scheduleReconnect() — the very next statement in runResync() — returns
          // early on it. This is what keeps the SDK from re-entering its own loop.
          void replica.close().catch(() => {});
          signalFailure();
          return;
        }
        if (s === "auth-required" && attemptError === null) {
          // A refused credential is not something to retry against the tenant at all: it is stopped
          // and recorded, not counted towards maxFailures (CTC-2499).
          seedInFlight = false;
          seedCompleted = false;
          attemptError = "the tenant refused this machine's credential on /snapshot";
          fatal.stop = { reason: attemptError, recordable: true };
          void replica.close().catch(() => {});
          signalFailure();
        }
      },
    });

    // Always give start() a handler, so a rejection that loses the race is never unhandled.
    const started = replica.start().then(
      () => "started" as const,
      (err) => {
        fatal.stop ??= classifyStartError(err);
        attemptError ??= messageOf(err);
        return "failed" as const;
      },
    );

    const outcome = await Promise.race([started, failed.then(() => "failed" as const), stopSignal.then(() => "stop" as const)]);

    // Something the SDK raised so the caller would STOP: retrying it is a hot loop against a wall,
    // and two of the three fire while another process or another tenant owns this replica — so the
    // record is left exactly as its owner wrote it (CTC-2499).
    const stopNow = fatal.stop;
    if (outcome === "failed" && stopNow !== null) {
      await replica.close().catch(() => {});
      await eventSync?.stop();
      releaseOwnPidfile(dbPath);
      if (stopNow.recordable) {
        takeOwnershipOfRecord();
        const nowMs = ctx.now().getTime();
        writeWriterState(
          dbPath,
          { pid: process.pid, consecutiveFailures: failures, lastError: stopNow.reason, lastFailureAt: nowMs, stopped: { at: nowMs, reason: stopNow.reason, restartWith: REPLICA_RESTART_COMMAND } },
          nowMs,
        );
      }
      ctx.stderr(`[replica] stopping without a retry: ${stopNow.reason}`);
      ctx.stdout(
        `replica writer stopped without retrying: ${stopNow.reason} ` +
          `The replica is optional — every read still works through the API.`,
      );
      return 1;
    }

    // Past the writer lock, so this run owns the replica and may discard a previous run's verdict.
    // A "stop" outcome proves nothing — it can race the lock claim — so it takes no ownership.
    if (outcome !== "stop") takeOwnershipOfRecord();

    if (outcome === "started") {
      // The event cache is started once for the whole supervised run, not per attempt.
      if (eventSync === null) {
        eventSync = await createEventSync(ctx, { loadSdk: deps.loadEventsSdk });
        void eventSync.start().catch((error) => ctx.stderr(`[events] sync failed: ${messageOf(error)}; replica remains live`));
      }
      ctx.stdout(`replica live at ${dbPath} (cursor ${replica.cursor ?? "none"}); event cache active — Ctrl-C to stop`);
      // A warm boot never emits "resyncing", so a writer that recovered without a re-seed has no
      // transition to reset its count on, and its stale count would both mis-report a healthy writer
      // and accumulate NON-consecutive failures up to the stop threshold. A live session that holds
      // for liveStableMs is that missing signal (CTC-2499).
      if (failures > 0) {
        const settled = await Promise.race([
          failed.then(() => "failed" as const),
          stopSignal.then(() => "stop" as const),
          sleep(liveStableMs).then(() => "stable" as const),
        ]);
        if (settled === "stable") resetFailures();
      }
      // start() resolves at the FIRST "live", which is the socket, not the seed — keep watching.
      await Promise.race([failed, stopSignal]);
    }

    await replica.close().catch(() => {});
    if (stopRequested) break;

    failures += 1;
    const lastError = attemptError ?? "the snapshot pull failed";
    const nowMs = ctx.now().getTime();
    const stopped =
      failures >= maxFailures
        ? { at: nowMs, reason: `${failures} consecutive snapshot failures`, restartWith: "catalyst replica start --detach" }
        : null;
    writeWriterState(dbPath, { pid: process.pid, consecutiveFailures: failures, lastError, lastFailureAt: nowMs, stopped }, nowMs);

    if (stopped) {
      await eventSync?.stop();
      releaseOwnPidfile(dbPath);
      ctx.stderr(`[replica] stopping: ${stopped.reason}; last error: ${lastError}`);
      ctx.stdout(
        `replica writer stopped after ${failures} consecutive snapshot failures (last error: ${lastError}). ` +
          `The replica is optional — every read still works through the API. ` +
          `Restart it with: ${stopped.restartWith}`,
      );
      return 1;
    }

    const delay = backoffDelayMs(failures, { baseMs, maxMs, random });
    ctx.stderr(`[replica] snapshot failure ${failures} of ${maxFailures}: ${lastError}; retrying in ${delay}ms`);
    await Promise.race([sleep(delay), stopSignal]);
    if (stopRequested) break;
  }

  await eventSync?.stop();
  releaseOwnPidfile(dbPath);
  if (recordOwned) clearWriterState(dbPath); // never a record this run had no right to
  ctx.stdout("replica stopped");
  return 0;
}

function cmdStop(ctx: Ctx, dbPath: string): number {
  const pid = readPidfile(dbPath);
  if (pid === null) {
    ctx.stdout(`no pidfile at ${pidfilePath(dbPath)} — nothing to stop (a foreground writer is stopped with Ctrl-C)`);
    return 1;
  }
  if (!pidAlive(pid)) {
    unlinkSync(pidfilePath(dbPath));
    ctx.stdout(`pid ${pid} is not running; removed the stale pidfile`);
    return 1;
  }
  process.kill(pid, "SIGTERM");
  try {
    unlinkSync(pidfilePath(dbPath));
  } catch {
    // already removed by the writer
  }
  ctx.stdout(`sent SIGTERM to replica writer pid ${pid}`);
  return 0;
}

const SELECT_ONLY = /^\s*(select|with)\b/i;

export function assertSingleSelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new UsageError('replica sql needs a query: replica sql "select ..."');
  if (!SELECT_ONLY.test(trimmed) || trimmed.includes(";")) {
    throw new UsageError("replica sql runs exactly one SELECT (or WITH ... SELECT); nothing else is accepted on a read-only handle");
  }
  return trimmed;
}

async function cmdSql(args: ParsedArgs, ctx: Ctx, dbPath: string, sql: string, deps: ReplicaDeps): Promise<number> {
  const query = assertSingleSelect(sql);
  if (!existsSync(dbPath)) throw new CliError(`no replica at ${dbPath} — start it with: catalyst replica start --detach`, "replica-absent", 3);
  const sdk = await loadSdk();
  const engine = await engineFor(sdk, dbPath, ctx, { ...deps.engineDeps, readonly: true });
  const replica = await sdk.CatalystReplica.openReadOnly({ dbPath, engine, log: () => {} });
  try {
    const rows = replica.sql.exec(query).toArray();
    ctx.stdout(JSON.stringify(rows, null, args.json ? 0 : 2));
    return 0;
  } finally {
    await replica.close();
  }
}

async function cmdSchema(args: ParsedArgs, ctx: Ctx, dbPath: string, table: string | undefined): Promise<number> {
  if (!existsSync(dbPath)) throw new CliError(`no replica at ${dbPath} — the schema is what the file holds; start it with: catalyst replica start --detach`, "replica-absent", 3);
  const db = new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const wanted = table ? tables.filter((t) => t === table) : tables;
    if (table && wanted.length === 0) throw new CliError(`no table "${table}" in the replica (tables: ${tables.join(", ")})`, "table-unknown");
    const out: Record<string, { name: string; type: string; notnull: number; pk: number }[]> = {};
    for (const t of wanted) {
      out[t] = (db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        pk: c.pk,
      }));
    }
    if (args.json) ctx.stdout(JSON.stringify(out));
    else for (const [t, cols] of Object.entries(out)) ctx.stdout(`${t}: ${cols.map((c) => `${c.name} ${c.type || "ANY"}${c.pk ? " PK" : ""}`).join(", ")}`);
    return 0;
  } finally {
    db.close();
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
