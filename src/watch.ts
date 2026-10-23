// watch.ts — `watch [--team K] [--ticket T]... [--project P] [--exec CMD] [--cursor-file] [--from]`:
// one JSON line per in-scope change frame, cursor advanced after the reaction, over the SDK's live
// stream. Scope is filtered on the client from the frame's entity and row; a project scope resolves
// an issue reference to its project through GET /api/v1/issues/:ref, cached in memory.
import { spawn } from "node:child_process";
import type { ChangeFrame, WebSocketFactory } from "@catalyst-cloud/sdk";
import { flagList, flagString, type ParsedArgs } from "./args.js";
import { apiBase, requireConfig, readManifest, watchCursorPathFor, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract } from "./contract.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";
import { authStrategyFor, bearerFor } from "./oauth.js";
import { loadLiveSdk, type LiveSdk } from "./sdk.js";
import { createLiveEventsClient, type LiveEventsHandle } from "./watch/consumer.js";
import { CursorFileError } from "./watch/cursor-file.js";

export interface WatchScope {
  teamId?: string;
  teamKey?: string;
  tickets?: string[];
  projectId?: string;
}

export interface IssueRef {
  id: string | null;
  identifier: string | null;
  projectId: string | null;
  teamId: string | null;
}

export type IssueResolver = (ref: string) => Promise<IssueRef | null>;

const ROW_ISSUE_REFS = ["identifier", "linear_issue_identifier", "issue_identifier", "issue_id", "linear_issue_id"] as const;

/** Decide whether one frame falls inside the scope. An empty scope admits everything. Rows that only
 *  carry an issue reference (comments, sessions, PRs) resolve it through `resolve` for project scope. */
export async function inScope(frame: ChangeFrame, scope: WatchScope, resolve: IssueResolver): Promise<boolean> {
  const hasScope = Boolean(scope.teamId || scope.teamKey || (scope.tickets && scope.tickets.length) || scope.projectId);
  if (!hasScope) return true;
  const row = frame.row ?? {};
  const refs = ROW_ISSUE_REFS.map((k) => row[k]).filter((v): v is string => typeof v === "string" && v !== "");
  const upperTickets = (scope.tickets ?? []).map((t) => t.toUpperCase());

  if (upperTickets.length > 0) {
    if (refs.some((r) => upperTickets.includes(r.toUpperCase()))) return true;
    for (const r of refs) {
      const info = await resolve(r);
      if (info?.identifier && upperTickets.includes(info.identifier.toUpperCase())) return true;
    }
  }
  if (scope.projectId) {
    if (row.project_id === scope.projectId || row.id === scope.projectId) return true;
    for (const r of refs) {
      const info = await resolve(r);
      if (info?.projectId === scope.projectId) return true;
    }
  }
  if (scope.teamId || scope.teamKey) {
    if (scope.teamId && (row.team_id === scope.teamId || row.teamId === scope.teamId)) return true;
    if (scope.teamKey && refs.some((r) => /^[A-Za-z]+-\d+$/.test(r) && r.toUpperCase().startsWith(`${scope.teamKey!.toUpperCase()}-`))) return true;
    for (const r of refs) {
      const info = await resolve(r);
      if (info && scope.teamId && info.teamId === scope.teamId) return true;
      if (info?.identifier && scope.teamKey && info.identifier.toUpperCase().startsWith(`${scope.teamKey.toUpperCase()}-`)) return true;
    }
  }
  return false;
}

/** Resolve issue references through the API, cached per process. */
export function apiIssueResolver(cfg: CustomerConfig, ctx: Ctx): IssueResolver {
  const api = apiClient(cfg, ctx);
  const cache = new Map<string, IssueRef | null>();
  return async (ref) => {
    if (cache.has(ref)) return cache.get(ref)!;
    let out: IssueRef | null = null;
    try {
      const res = await api.getJson<Record<string, unknown>>(`/api/v1/issues/${encodeURIComponent(ref)}`, { accept: [404] });
      if (res.status !== 404 && res.body) {
        out = {
          id: typeof res.body.id === "string" ? res.body.id : null,
          identifier: typeof res.body.identifier === "string" ? res.body.identifier : null,
          projectId: typeof res.body.project_id === "string" ? res.body.project_id : null,
          teamId: typeof res.body.team_id === "string" ? res.body.team_id : null,
        };
      }
    } catch {
      out = null;
    }
    cache.set(ref, out);
    return out;
  };
}

/**
 * Run `--exec CMD` once with the frame on stdin; a non-zero exit is a failed reaction.
 *
 * The child's EXIT CODE is the whole contract, and a broken pipe is not a failure on its own. A
 * handler that exits before reading the frame is ordinary and often correct — `grep -q`, `head -1`,
 * a script that fails fast — and so is one that simply died. In every one of those cases the write
 * lands on a pipe with nothing at the other end and raises EPIPE asynchronously. Node delivers that
 * as an `error` event on the child's stdin, and a stream with no `error` listener rethrows it as an
 * unhandled error, which takes down the whole watch: one misbehaving handler and the customer stops
 * receiving their tenant's events. So the pipe is allowed to break, and the exit code still decides.
 */
export function execReaction(cmd: string, env: NodeJS.ProcessEnv): (frame: ChangeFrame) => Promise<void> {
  return (frame) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "inherit", "inherit"], env });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`--exec exited ${code}`))));
      // Listen before writing: attaching afterwards races the synchronous part of `end()`.
      child.stdin.on("error", () => {});
      try {
        if (child.stdin.writable) child.stdin.end(`${JSON.stringify(frame)}\n`);
      } catch {
        // A stdin already destroyed throws here rather than emitting; same verdict, wait for close.
      }
    });
}

export interface WatchDeps {
  wsFactory?: WebSocketFactory;
  resolver?: IssueResolver;
  /** Resolve to stop the watch (tests); the default waits for SIGINT/SIGTERM. */
  waitForStop?: () => Promise<void>;
  sdk?: LiveSdk;
  /** Observe the handle once built (tests). */
  onHandle?: (handle: LiveEventsHandle) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface WatchOptions {
  scope: WatchScope;
  exec?: string;
  cursorFile?: string;
  fromHead?: boolean;
}

export async function runWatch(ctx: Ctx, cfg: CustomerConfig, opts: WatchOptions, deps: WatchDeps = {}): Promise<number> {
  const sdk = deps.sdk ?? (await loadLiveSdk());
  const resolve = deps.resolver ?? apiIssueResolver(cfg, ctx);
  const react = opts.exec ? execReaction(opts.exec, ctx.env) : undefined;
  let handle: LiveEventsHandle;
  try {
    handle = buildHandle();
  } catch (err) {
    if (err instanceof CursorFileError) throw new CliError(`${err.message} (${err.path})`, "cursor-file");
    throw err;
  }
  deps.onHandle?.(handle);
  const stopped =
    deps.waitForStop ??
    (() =>
      new Promise<void>((done) => {
        process.once("SIGINT", () => done());
        process.once("SIGTERM", () => done());
      }));
  const running = handle.client.start();
  await stopped();
  handle.client.stop();
  await running;
  return 0;

  function buildHandle(): LiveEventsHandle {
    return createLiveEventsClient(sdk, {
    baseUrl: apiBase(cfg),
    accountId: cfg.account,
    cliVersion: readManifest().version,
    auth: authStrategyFor(ctx, cfg),
    getToken: () => bearerFor(ctx, cfg),
    cursorFile: opts.cursorFile ?? watchCursorPathFor(ctx.home),
    fromHead: opts.fromHead,
    fetchImpl: ctx.fetch,
    wsFactory: deps.wsFactory,
    backoffMs: deps.backoffMs,
    maxBackoffMs: deps.maxBackoffMs,
    log: (level, msg) => ctx.stderr(`[watch ${level}] ${msg}`),
    onStatus: (s) => ctx.stderr(`[watch] status=${s}`),
    onReseed: (cursor) => ctx.stderr(`[watch] resync: cursor moved to head ${cursor}`),
      onEvent: async (frame) => {
        if (!(await inScope(frame, opts.scope, resolve))) return;
        ctx.stdout(JSON.stringify(frame));
        if (react) await react(frame);
      },
    });
  }
}

export async function cmdWatch(args: ParsedArgs, ctx: Ctx, deps: WatchDeps = {}): Promise<number> {
  const cfg = requireConfig(ctx);
  const from = flagString(args, "from") ?? "cursor";
  if (from !== "cursor" && from !== "head") throw new UsageError("--from must be cursor or head");
  const scope: WatchScope = { tickets: flagList(args, "ticket"), projectId: flagString(args, "project") };
  const teamKey = flagString(args, "team");
  if (teamKey) {
    const { doc } = await loadContract(ctx, cfg);
    const team = doc.teams.find((t) => (t.key ?? "").toUpperCase() === teamKey.toUpperCase());
    scope.teamKey = teamKey;
    if (team) scope.teamId = team.id;
  }
  return runWatch(ctx, cfg, { scope, exec: flagString(args, "exec"), cursorFile: flagString(args, "cursor-file"), fromHead: from === "head" }, deps);
}
