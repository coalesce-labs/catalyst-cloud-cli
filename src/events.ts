import type { CachedEventWaitOptions, EventScopeFilterInput, EventWaitOptions, EventWaitResult } from "@catalyst-cloud/sdk/events";
import { flagInt, flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { authStrategyFor } from "./oauth.js";
import { eventCacheStatus } from "./event-status.js";
import { cloudEventHead, queryCloudEvents, unreachableError, unreachableKind } from "./events-cloud.js";
import { eventMatches, tailCloudEvents, waitForCloudEvent, type CloudTailDeps, type NdjsonSink } from "./events-cloud-tail.js";

export interface CachedEvent {
  tenantId: string;
  sequence: number;
  eventId: string;
  type: string;
  recordedAt: string;
  payload: unknown;
  /** The domain entity the event is about; a ticket event names it here. */
  entity?: { type: string; id: string };
  /** The event or lease that caused it, e.g. `lease:CTC-42/implement#3`. */
  causationId?: string;
}

export interface EventSyncHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EventsSdk {
  CatalystEventSync: new (options: {
    baseUrl: string;
    auth:
      | { kind: "token"; token: string }
      | { kind: "bearer"; getToken: () => Promise<string> };
    tenantId: string;
    fetch?: typeof fetch;
  }) => EventSyncHandle;
  defaultEventCacheDirectory(tenantId: string): string;
  readCachedEvents(options: {
    tenantId: string;
    directory?: string;
    after?: number;
  }): Promise<CachedEvent[]>;
  tailCachedEvents(options: {
    tenantId: string;
    directory?: string;
    after?: number;
    signal: AbortSignal;
  }): AsyncGenerator<CachedEvent>;
  /** SDK 0.16.19: a filtered wait on one connection (CTC-5520). */
  waitForEvents?: (options: EventWaitOptions) => Promise<EventWaitResult>;
  waitForCachedEvents?: (options: CachedEventWaitOptions) => Promise<EventWaitResult>;
}

const eventsModule = "@catalyst-cloud/sdk/events";
export const loadEventsSdk = (): Promise<EventsSdk> =>
  import(eventsModule) as Promise<EventsSdk>;

export interface EventDeps {
  loadSdk?: () => Promise<EventsSdk>;
  signal?: AbortSignal;
  /** Where cloud `tail` and `wait-for` write NDJSON; defaults to the process stdout stream. */
  out?: NdjsonSink;
  /** Test seam for the cloud reader. */
  cloud?: CloudTailDeps;
  /** Registers an interrupt handler and returns its remover; defaults to SIGINT and SIGTERM. */
  onInterrupt?: (handler: () => void) => () => void;
}

/** Consecutive failed attempts after which `wait-for` reports an outage rather than waiting on. */
const OUTAGE_ATTEMPTS = 5;
/** How long the cloud may be unreachable before `tail` says so on stderr. */
const TAIL_WARN_AFTER_MS = 60_000;

function processInterrupts(handler: () => void): () => void {
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export async function createEventSync(
  ctx: Ctx,
  deps: EventDeps = {},
): Promise<EventSyncHandle> {
  const cfg = requireConfig(ctx);
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const auth = authStrategyFor(ctx, cfg);
  if (auth.kind === "cookie")
    throw new CliError(
      "event sync requires a token or OAuth session",
      "events-auth",
    );
  return new sdk.CatalystEventSync({
    // Events SDK adds /api/v1/events/backbone itself; unlike the replica it takes an origin.
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    auth,
    tenantId: cfg.account,
    fetch: ctx.fetch,
  });
}

export async function cmdEvents(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EventDeps = {},
): Promise<number> {
  const [sub] = positionals(args);
  if (!sub)
    throw new UsageError(
      "events needs a subcommand: tail | wait-for | query | status",
    );
  if (!(["tail", "wait-for", "query", "status"] as string[]).includes(sub))
    throw new UsageError(`unknown events subcommand: ${sub}`);
  // CTC-6650 — a scope key or a type family runs on the SDK's wait; the --type/--ticket path is unchanged.
  const scope = scopeFilter(args);
  if (scope) {
    if (sub !== "wait-for")
      throw new UsageError("--repo, --ref, --pr, --session, --to and a type family such as pr.* work with wait-for only");
    return cmdScopedWait(args, ctx, deps, scope);
  }
  // CTC-4554 — the cloud is the default source; the local event file is the opt-in.
  if (args.flags["from-cache"] !== true) {
    if (flagString(args, "directory") !== undefined)
      throw new UsageError("--directory names the local event cache; add --from-cache to read it");
    return cmdCloudEvents(sub, args, ctx, deps);
  }
  const cfg = requireConfig(ctx);
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const directory =
    flagString(args, "directory") ??
    sdk.defaultEventCacheDirectory(cfg.account);
  if (sub === "status") {
    const status = await eventCacheStatus(
      ctx,
      directory,
      args.flags.probe === true,
    );
    ctx.stdout(
      args.json
        ? JSON.stringify({ source: "cache", ...status })
        : `events: local cache ${status.verdict} at ${directory}${status.reasons.length ? ` (${status.reasons.join("; ")})` : ` (cursor ${status.cursor}, cloud head ${status.head})`}`,
    );
    return status.verdict === "current"
      ? 0
      : status.verdict === "stale"
        ? 1
        : status.verdict === "absent"
          ? 3
          : 2;
  }
  const after = startingCursor(args);
  const matches = eventMatches(eventFilter(args));

  if (sub === "query") {
    const events = (
      await sdk.readCachedEvents({ tenantId: cfg.account, directory, after })
    )
      .filter(matches)
      .slice(-flagInt(args, "limit", 50));
    for (const event of events) ctx.stdout(JSON.stringify(event));
    return 0;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    sub === "wait-for"
      ? setTimeout(
          () => controller.abort(new Error("event wait timed out")),
          flagInt(args, "timeout", 300) * 1_000,
        )
      : undefined;
  try {
    for await (const event of sdk.tailCachedEvents({
      tenantId: cfg.account,
      directory,
      after,
      signal: controller.signal,
    })) {
      if (!matches(event)) continue;
      ctx.stdout(JSON.stringify(event));
      if (sub === "wait-for") return 0;
    }
    return sub === "wait-for" ? 1 : 0;
  } catch (error) {
    if (controller.signal.aborted) return sub === "wait-for" ? 1 : 0;
    if ((error as { code?: string }).code === "ENOENT")
      throw new CliError(
        `event cache is absent at ${directory}: it is written only where local sync runs. Start the local writer with: catalyst replica start --detach, or drop --from-cache to read from the cloud`,
        "events-absent",
        3,
      );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

function startingCursor(args: ParsedArgs, name = "after"): number | undefined {
  const requested = flagString(args, name);
  if (requested === undefined) return undefined;
  const parsed = Number(requested);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new UsageError(`--${name} must be a non-negative event sequence`);
  return parsed;
}

const SCOPE_KEYS = ["repo", "ref", "pr", "session"] as const;

/** The SDK filter when the wait names a scope key or a type family, or null for the original path. */
function scopeFilter(args: ParsedArgs): EventScopeFilterInput | null {
  const filter: { -readonly [K in keyof EventScopeFilterInput]: EventScopeFilterInput[K] } = {};
  for (const key of SCOPE_KEYS) {
    const values = flagList(args, key);
    if (values.length) filter[key] = values;
  }
  const to = flagString(args, "to");
  if (to !== undefined) {
    if (to !== "me") throw new UsageError("--to accepts only me");
    filter.to = "me";
  }
  const type = flagString(args, "type");
  if (Object.keys(filter).length === 0 && !type?.endsWith(".*")) return null;
  const ticket = flagString(args, "ticket");
  return { ...filter, ...(type ? { type } : {}), ...(ticket ? { ticket } : {}) };
}

/** Counts consecutive failed requests, so a wait that cannot reach the cloud ends as an outage. */
function outageFetch(base: typeof fetch, signal: AbortSignal, onOutage: (failures: number, sinceMs: number) => void, now: () => number): typeof fetch {
  let failures = 0;
  let sinceMs = 0;
  const trouble = () => {
    if (failures === 0) sinceMs = now();
    failures += 1;
    if (failures >= OUTAGE_ATTEMPTS) onOutage(failures, sinceMs);
  };
  return async (input, init) => {
    try {
      const response = await base(input, init);
      if (response.status >= 500) trouble();
      else failures = 0;
      return response;
    } catch (error) {
      // A request the SDK timed out counts; one cancelled because this wait ended does not.
      if (!signal.aborted) trouble();
      throw error;
    }
  };
}

/** `wait-for` with scope keys: the SDK's wait, under the CLI's documented exit codes. */
async function cmdScopedWait(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EventDeps,
  filter: EventScopeFilterInput,
): Promise<number> {
  const cfg = requireConfig(ctx);
  const timeout = flagInt(args, "timeout", 300);
  if (timeout < 0) throw new UsageError("--timeout must be zero or more seconds");
  const after = startingCursor(args);
  const fromCache = args.flags["from-cache"] === true;
  if (!fromCache && flagString(args, "directory") !== undefined)
    throw new UsageError("--directory names the local event cache; add --from-cache to read it");
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const { waitForEvents, waitForCachedEvents } = sdk;
  if (!waitForEvents || !waitForCachedEvents)
    throw new CliError("the installed SDK cannot wait on scope keys; upgrade the catalyst CLI", "sdk-upgrade-required");
  const controller = new AbortController();
  const abort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  let interrupted = false;
  let outage: { failures: number; sinceMs: number } | undefined;
  const removeInterrupt = (deps.onInterrupt ?? processInterrupts)(() => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  });
  try {
    let result: EventWaitResult;
    if (fromCache) {
      result = await waitForCachedEvents({
        tenantId: cfg.account,
        directory: flagString(args, "directory") ?? sdk.defaultEventCacheDirectory(cfg.account),
        filter,
        after,
        timeoutMs: timeout * 1_000,
        signal: controller.signal,
      });
    } else {
      const auth = authStrategyFor(ctx, cfg);
      if (auth.kind === "cookie") throw new CliError("event waits require a token or OAuth session", "events-auth");
      result = await waitForEvents({
        baseUrl: normalizeBaseUrl(cfg.baseUrl),
        auth,
        tenantId: cfg.account,
        filter,
        after,
        timeoutMs: timeout * 1_000,
        signal: controller.signal,
        fetch: outageFetch(ctx.fetch, controller.signal, (failures, sinceMs) => {
          if (outage) return;
          outage = { failures, sinceMs };
          controller.abort(new Error("cloud unreachable"));
        }, () => ctx.now().getTime()),
      });
    }
    const resume = (cursor: number | null | undefined) => (cursor === null || cursor === undefined ? "" : `; resume with --after ${cursor}`);
    switch (result.outcome) {
      case "matched":
        for (const event of result.events) ctx.stdout(JSON.stringify(event));
        return 0;
      case "timeout":
        ctx.stderr(`events: no matching event within ${timeout} s${resume(result.cursor)}`);
        return 1;
      case "aborted":
        if (interrupted) return 130;
        if (outage) {
          ctx.stderr(`events: the cloud event service was unreachable for ${outage.failures} attempts over ${Math.round((ctx.now().getTime() - outage.sinceMs) / 1_000)} s; this is an outage, not a timeout${resume(result.cursor)}`);
          return 4;
        }
        return 1;
      case "refused":
        throw new CliError(
          `events: ${result.source === "filter" ? "the filter was refused" : `the cloud refused the wait${result.status === null ? "" : ` (${result.status})`}`}${result.key ? ` on --${result.key}${result.value === null ? "" : ` ${result.value}`}` : ""}: ${result.reason}`,
          "events-refused",
        );
      case "failed":
        if (result.code === "cache-missing" || result.code === "cache-writer-stopped")
          throw new CliError(
            `events: ${result.reason}. Start the local writer with: catalyst replica start --detach, or drop --from-cache to read from the cloud`,
            "events-absent",
            3,
          );
        throw new CliError(`events: the wait failed (${result.code}): ${result.reason}${resume(result.resumeFrom ?? result.cursor)}`, "events-failed");
    }
  } finally {
    removeInterrupt();
    deps.signal?.removeEventListener("abort", abort);
  }
}

function eventFilter(args: ParsedArgs): { type?: string; ticket?: string } {
  const type = flagString(args, "type");
  const ticket = flagString(args, "ticket")?.toUpperCase();
  return { ...(type ? { type } : {}), ...(ticket ? { ticket } : {}) };
}

/** A sink over `ctx.stdout` for contexts without a stream (tests): one call per line. */
function lineSink(ctx: Ctx): NdjsonSink {
  return {
    write(chunk, callback) {
      try {
        ctx.stdout(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
      return true;
    },
    on: () => undefined,
    off: () => undefined,
  };
}

const QUERY_MAX_LIMIT = 200;
const LOCAL_SYNC_HINT =
  "several agents on one machine are cheaper sharing one local cache: opt in to local sync (catalyst onboard --local-sync), then read it with --from-cache";

/** CTC-4554 — `events tail | wait-for | query | status` against the cloud, with no local file. */
async function cmdCloudEvents(
  sub: string,
  args: ParsedArgs,
  ctx: Ctx,
  deps: EventDeps,
): Promise<number> {
  requireConfig(ctx);
  const filter = eventFilter(args);
  if (sub === "status") {
    let head: number;
    try {
      head = await cloudEventHead(ctx);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const failure = unreachableError(error);
      if (args.json) ctx.stdout(JSON.stringify({ source: "cloud", reachable: false, error: unreachableKind(error) }));
      else ctx.stderr(`catalyst: ${failure.message}`);
      return failure.exitCode;
    }
    // A cloud stream has no local cursor to fall behind. Filtered reads come from the event index,
    // which trails the head while it fills; that lag is measured, not assumed.
    let indexedToSeq: number | null = null;
    try {
      indexedToSeq = (await queryCloudEvents(ctx, { limit: 1, order: "desc" })).coverage.indexedToSeq;
    } catch {
      indexedToSeq = null;
    }
    const indexLag = indexedToSeq === null ? null : Math.max(0, head - indexedToSeq);
    const status = { source: "cloud", reachable: true, head, behind: null, indexedToSeq, indexLag, note: LOCAL_SYNC_HINT };
    ctx.stdout(
      args.json
        ? JSON.stringify(status)
        : `events: cloud stream at head ${head}; ${indexLag === null ? "the filtered index could not be read" : `filtered reads (--ticket, --type) trail it by ${indexLag}`} (every read goes to the cloud; ${LOCAL_SYNC_HINT})`,
    );
    return 0;
  }
  if (sub === "query") {
    const limit = flagInt(args, "limit", 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT)
      throw new UsageError(`--limit must be between 1 and ${QUERY_MAX_LIMIT} for a cloud query`);
    const order = flagString(args, "order") ?? "desc";
    if (order !== "asc" && order !== "desc") throw new UsageError("--order must be asc or desc");
    const page = await queryCloudEvents(ctx, {
      ...filter,
      limit,
      order,
      afterSeq: startingCursor(args, "after"),
      beforeSeq: startingCursor(args, "before"),
    });
    for (const event of page.events) ctx.stdout(JSON.stringify(event));
    if (page.next)
      ctx.stderr(`more: re-run with --${page.next.param === "beforeSeq" ? "before" : "after"} ${page.next.value}`);
    if (page.events.length === 0) {
      const { indexedFromSeq: from, indexedToSeq: to } = page.coverage;
      ctx.stderr(
        from === null || to === null
          ? "no match; the cloud index holds no events yet"
          : `no match; the cloud index holds sequences ${from} to ${to}, so an earlier event may exist unindexed`,
      );
    }
    return 0;
  }

  const out = deps.out ?? ctx.stdoutStream ?? lineSink(ctx);
  const controller = new AbortController();
  const abort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  let interrupted = false;
  const removeInterrupt = (deps.onInterrupt ?? processInterrupts)(() => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  });
  let outage: { failures: number; sinceMs: number } | undefined;
  let warned = false;
  const seconds = (sinceMs: number) => Math.round((ctx.now().getTime() - sinceMs) / 1_000);
  const cloud: CloudTailDeps = {
    ...deps.cloud,
    onTrouble: (state) => {
      deps.cloud?.onTrouble?.(state);
      if (sub === "wait-for" && state.failures >= OUTAGE_ATTEMPTS && !outage) {
        outage = state;
        controller.abort(new Error("cloud unreachable"));
      }
      if (sub === "tail" && !warned && ctx.now().getTime() - state.sinceMs > TAIL_WARN_AFTER_MS) {
        warned = true;
        ctx.stderr(`events: the cloud has been unreachable for ${seconds(state.sinceMs)} s (${state.failures} attempts); still retrying`);
      }
    },
    onHealthy: () => {
      deps.cloud?.onHealthy?.();
      if (warned) ctx.stderr("events: the cloud is reachable again");
      warned = false;
    },
  };
  try {
    const after = startingCursor(args);
    if (sub === "wait-for") {
      const timeout = flagInt(args, "timeout", 300);
      const result = await waitForCloudEvent(ctx, { after, filter, timeoutMs: timeout * 1_000, out, signal: controller.signal }, cloud);
      if (interrupted) return 130;
      if (outage) {
        ctx.stderr(`events: the cloud event service was unreachable for ${outage.failures} attempts over ${seconds(outage.sinceMs)} s; this is an outage, not a timeout`);
        return 4;
      }
      if (result.outcome === "matched" || result.outcome === "closed") return 0;
      if (result.outcome === "timeout") ctx.stderr(`events: no matching event within ${timeout} s`);
      return 1;
    }
    const result = await tailCloudEvents(ctx, { after, filter, out, signal: controller.signal }, cloud);
    if (result.outcome !== "closed" && result.cursor !== undefined)
      ctx.stderr(`events: stopped at sequence ${result.cursor}; resume with --after ${result.cursor}`);
    return interrupted ? 130 : 0;
  } finally {
    removeInterrupt();
    deps.signal?.removeEventListener("abort", abort);
  }
}
