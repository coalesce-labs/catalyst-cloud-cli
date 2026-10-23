// watch/consumer.ts — the EVENTS-ONLY consumer of the Catalyst Cloud SDK's live push, ported whole
// from the cloud's tested host-sync implementation. It materializes no replica:
//
//   • reseed    → GET <base>/snapshot?head=1: move the cursor to the tenant's current head, apply nothing.
//   • onChange  → react to the frame (the same turn), THEN advance the cursor file. The order is the
//                 at-least-once contract: a reaction that throws or rejects leaves the cursor at the
//                 last good frame and forces one reconnect so the SDK's replay re-offers the frame.
//   • getCursor → the cursor file's position, loaded once and kept in memory.
//
// Everything else (the socket, the replay in seq order, the watchdog, gap detection, the resync frame)
// is the SDK's LiveSyncClient. This module is deliberately thin.
import type { AuthStrategy, ChangeFrame, LiveSyncClient, LiveSyncStatus, WebSocketFactory, WebSocketLike } from "@catalyst-cloud/sdk";
import type { LiveSdk } from "../sdk.js";
import { readCursorFile, writeCursorFile, type CursorFileState } from "./cursor-file.js";

export const LOG_PREFIX = "[live-events]";

export interface LiveEventsOptions {
  /** Worker origin INCLUDING the `/api/v1` prefix. */
  baseUrl: string;
  accountId: string;
  /** Installed parent CLI release, distinct from the SDK or guest process version. */
  cliVersion?: string;
  /** How the socket authorizes: a static token (key rail) or a fresh-per-connect bearer (OAuth). */
  auth: AuthStrategy;
  /** The current bearer for the head-only `/snapshot` fetch — resolved FRESH each call so an OAuth
   *  session refreshes underneath a long-lived watch (CTC-2112). */
  getToken: () => Promise<string>;
  cursorFile: string;
  /** Start from the tenant head instead of the cursor file (`--from head`). */
  fromHead?: boolean;
  onEvent?: (frame: ChangeFrame) => void | Promise<void>;
  onStatus?: (status: LiveSyncStatus) => void;
  /** Called after a head-only reseed with the new cursor (the `resync` line). */
  onReseed?: (cursor: number) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  wsFactory?: WebSocketFactory;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export interface LiveEventsHandle {
  client: LiveSyncClient;
  cursor(): number | null;
  reseedHead(signal?: AbortSignal): Promise<number>;
}

function defaultWsFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error("global WebSocket unavailable; pass wsFactory (Node >= 22 exposes one)");
  return new Ctor(url);
}

export function printFrame(frame: ChangeFrame): void {
  console.log(`${LOG_PREFIX} frame ${JSON.stringify(frame)}`);
}

async function fetchHeadCursor(opts: LiveEventsOptions, signal?: AbortSignal): Promise<number> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/snapshot?head=1`;
  const res = await (opts.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${await opts.getToken()}` }, signal });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`head-only snapshot fetch failed: ${res.status} ${res.statusText} at ${url} — ${body}`);
  }
  const head = (await res.json()) as { accountId?: string; cursor?: number };
  if (head.accountId !== opts.accountId) {
    throw new Error(
      `head-only snapshot is for account ${JSON.stringify(head.accountId)} but this session is for ${JSON.stringify(opts.accountId)} — the key and the configured account disagree`,
    );
  }
  if (typeof head.cursor !== "number" || !Number.isInteger(head.cursor) || head.cursor < 0) {
    throw new Error(`head-only snapshot returned a non-integer cursor: ${JSON.stringify(head.cursor)}`);
  }
  return head.cursor;
}

/**
 * Build the events-only client. Construction reads the cursor file ONCE (throwing on a corrupt file
 * or a cross-account reuse); the position is then kept in memory and persisted after every
 * SUCCESSFUL reaction. React first, persist second: an async reaction is awaited before its cursor
 * persists and later frames queue behind it in seq order; a failed reaction halts the stream and
 * closes the socket so the SDK's reconnect replays from the last good cursor.
 */
export function createLiveEventsClient(sdk: LiveSdk, opts: LiveEventsOptions): LiveEventsHandle {
  let state: CursorFileState | null = opts.fromHead ? null : readCursorFile(opts.cursorFile, opts.accountId);
  const log =
    opts.log ??
    ((level, msg, extra) => console[level === "error" ? "error" : "log"](`${LOG_PREFIX} ${msg}`, extra ?? ""));

  const persist = (next: CursorFileState): void => {
    state = next;
    writeCursorFile(opts.cursorFile, next);
  };

  const reseedHead = async (signal?: AbortSignal): Promise<number> => {
    const cursor = await fetchHeadCursor(opts, signal);
    persist({ account: opts.accountId, cursor });
    log("info", `cursor re-seeded to tenant head ${cursor} (head-only; no rows applied)`);
    opts.onReseed?.(cursor);
    return cursor;
  };

  const react = opts.onEvent ?? printFrame;
  let socket: WebSocketLike | null = null;
  let halted = false;
  let inFlight: Promise<void> | null = null;
  const queued: ChangeFrame[] = [];

  const advance = (frame: ChangeFrame): void => {
    if (state && state.cursor >= frame.seq) return;
    persist({ account: frame.accountId, cursor: frame.seq });
  };

  const fail = (frame: ChangeFrame, err: unknown): void => {
    halted = true;
    queued.length = 0;
    inFlight = null;
    log(
      "error",
      `reaction failed for ${frame.entity} seq=${frame.seq}; cursor left at ${state?.cursor ?? "none"} — reconnecting so the replay re-offers it`,
      err,
    );
    const ws = socket;
    socket = null;
    try {
      ws?.close();
    } catch {
      // already closing/closed
    }
  };

  const settle = (frame: ChangeFrame): void => {
    advance(frame);
    inFlight = null;
    const next = queued.shift();
    if (next) run(next);
  };

  const run = (frame: ChangeFrame): void => {
    let result: void | Promise<void>;
    try {
      result = react(frame);
    } catch (err) {
      fail(frame, err);
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      const p = (result as Promise<void>).then(
        () => {
          if (inFlight === p) settle(frame);
        },
        (err: unknown) => {
          if (inFlight === p) fail(frame, err);
        },
      );
      inFlight = p;
      return;
    }
    advance(frame);
  };

  const wrappedFactory: WebSocketFactory = (url) => {
    const ws = (opts.wsFactory ?? defaultWsFactory)(url);
    socket = ws;
    halted = false;
    queued.length = 0;
    inFlight = null;
    return ws;
  };

  const client = new sdk.LiveSyncClient({
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    auth: opts.auth,
    connectParams: () => opts.cliVersion ? { cli_version: opts.cliVersion } : undefined,
    reseed: reseedHead,
    getCursor: () => state?.cursor ?? null,
    onChange: (frame) => {
      if (frame.accountId !== opts.accountId) {
        const msg = `refusing frame for account ${JSON.stringify(frame.accountId)} — this session is for ${JSON.stringify(opts.accountId)} (cursor left at ${state?.cursor ?? "none"})`;
        log("error", msg);
        throw new Error(msg);
      }
      if (halted) return;
      if (inFlight) {
        queued.push(frame);
        return;
      }
      run(frame);
    },
    onStatus:
      opts.onStatus ??
      ((status) => {
        log("info", `status=${status}`);
      }),
    backoffMs: opts.backoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    wsFactory: wrappedFactory,
    log,
  });

  return { client, cursor: () => state?.cursor ?? null, reseedHead };
}
