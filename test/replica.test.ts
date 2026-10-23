// replica.test.ts — `replica status` exit codes (2 no config, 3 no file, 1 stale, 0 fresh) and its
// --json shape; engineFor's fallback to node:sqlite with exactly one stderr line; sql refuses a
// non-SELECT; schema lists every mirrorSchema table; start --detach spawns and writes the pidfile.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { defaultReplicaDbFor } from "../src/config";
import {
  assertSingleSelect,
  backoffDelayMs,
  classifyStartError,
  clearWriterState,
  engineFor,
  loadSqlite,
  pidfilePath,
  readWriterState,
  replicaStatus,
  resetSqliteCache,
  SNAPSHOT_IDLE_TIMEOUT_MS,
  writerStatePath,
} from "../src/replica";
import { BUN_MIN, FIX_COMMAND } from "../src/runtime";
import { CliError } from "../src/errors";
import { loadSdk } from "../src/sdk";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedReplica, seedWriterState, tempHome, waitFor, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
});

describe("replica status", () => {
  test("exit 2 with no config", async () => {
    expect(await main(["replica", "status"], ctx)).toBe(2);
    expect(ctx.out.join("\n")).toMatch(/not configured/);
  });
  test("exit 3 with no db file on a machine that opted in, which --json marks configured", async () => {
    await seedJoined(home, server);
    const optedIn = makeCtx(home, { env: { ...ctx.env, CATALYST_REPLICA_DB: defaultReplicaDbFor(home) } });
    expect(await main(["replica", "status"], optedIn)).toBe(3);
    expect(optedIn.out.join("\n")).toMatch(/absent/);
    expect(optedIn.out.join("\n")).toContain("replica start --detach");
    expect(await main(["replica", "status", "--json"], optedIn)).toBe(3);
    expect(JSON.parse(optedIn.out.at(-1)!)).toMatchObject({ verdict: "absent", configured: true });
  });
  test("exit 3 with no db file on a machine that never opted in says cloud reads, and --json marks it unconfigured (CTC-4508)", async () => {
    await seedJoined(home, server);
    expect(await main(["replica", "status"], ctx)).toBe(3);
    expect(ctx.out.join("\n")).toBe("replica: not configured (cloud reads; local sync is opt-in)");
    expect(await main(["replica", "status", "--json"], ctx)).toBe(3);
    expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ verdict: "absent", configured: false });
  });
  test("exit 1 with a lock heartbeat older than staleMs", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/stale/);
    expect(ctx.out.join("\n")).toMatch(/heartbeat 6\d{4}ms old/);
  });
  test("exit 1 with a fresh heartbeat but no cursor", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: null, heartbeatAgeMs: 0 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/no cursor/);
  });
  test("exit 0 with a live pid and fresh heartbeat; --json carries verdict, cursor, heartbeatAgeMs", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 100 });
    expect(await main(["replica", "status", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { verdict: string; cursor: number; heartbeatAgeMs: number; writerAlive: boolean };
    expect(j.verdict).toBe("fresh");
    expect(j.cursor).toBe(41);
    expect(j.heartbeatAgeMs).toBeGreaterThanOrEqual(100);
    expect(j.heartbeatAgeMs).toBeLessThan(15_000);
    expect(j.writerAlive).toBe(true);
  });
  test("a dead lock pid without a pidfile is stale even with a fresh heartbeat", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, lockPid: 2_147_483_000 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/no live writer process/);
  });
  test("--probe adds the cloud head and the lag", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 7, heartbeatAgeMs: 0 });
    server.headCursor = 12;
    expect(await main(["replica", "status", "--probe", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { head: number; lag: number };
    expect(j.head).toBe(12);
    expect(j.lag).toBe(5);
    const c2 = makeCtx(home);
    await main(["replica", "status", "--probe"], c2);
    expect(c2.out.join("\n")).toContain("5 behind head 12");
  });
  test("replicaStatus in-process reads the same config", async () => {
    const cfg = await seedJoined(home, server);
    await seedReplica(home, { cursor: 3, heartbeatAgeMs: 0 });
    expect(replicaStatus(ctx, cfg).verdict).toBe("fresh");
    expect(replicaStatus(ctx, null).verdict).toBe("not-configured");
  });
});

describe("the replica writer state file", () => {
  test("names the sidecar beside the db, like the pidfile and the lock", () => {
    expect(writerStatePath("/x/replica.db")).toBe("/x/replica.db.writer.state");
  });
  test("a missing, corrupt, or wrong-shaped file all read as no record, never a throw", () => {
    const dbPath = `${home}/nope.db`;
    expect(readWriterState(dbPath)).toBeNull();
    writeFileSync(writerStatePath(dbPath), "{corrupt");
    expect(readWriterState(dbPath)).toBeNull();
    writeFileSync(writerStatePath(dbPath), JSON.stringify({ consecutiveFailures: "five" }));
    expect(readWriterState(dbPath)).toBeNull();
  });
  test("a well-formed record round-trips, and clearWriterState removes it (idempotently)", () => {
    const dbPath = seedWriterState(home, { consecutiveFailures: 3, lastError: "/snapshot 503", lastFailureAt: 1_700_000_000_000, stopped: null });
    expect(readWriterState(dbPath)).toMatchObject({ consecutiveFailures: 3, lastError: "/snapshot 503", stopped: null });
    clearWriterState(dbPath);
    expect(readWriterState(dbPath)).toBeNull();
    expect(() => clearWriterState(dbPath)).not.toThrow();
  });
  test("replica status --json exposes the writer's record; the human line names it retrying or stopped", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 100 });
    seedWriterState(home, { consecutiveFailures: 2, lastError: "/snapshot 503" });
    expect(await main(["replica", "status", "--json"], ctx)).toBe(0); // verdict logic untouched (Decision 3)
    const j = JSON.parse(ctx.out.join("\n")) as { verdict: string; writer: { consecutiveFailures: number; lastError: string; stopped: unknown } };
    expect(j.verdict).toBe("fresh");
    expect(j.writer).toMatchObject({ consecutiveFailures: 2, lastError: "/snapshot 503", stopped: null });

    const c2 = makeCtx(home);
    seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: { at: 1_700_000_000_000, reason: "5 consecutive snapshot failures", restartWith: "catalyst replica start --detach" },
    });
    expect(await main(["replica", "status"], c2)).toBe(0);
    const text = c2.out.join("\n");
    expect(text).toContain("stopped");
    expect(text).toContain("5 consecutive snapshot failures");
    expect(text).toContain("/snapshot 503");
    expect(text).toContain("catalyst replica start --detach");
  });
});

describe("backoffDelayMs", () => {
  test("full jitter: exponential growth, capped, deterministic with a fixed random draw", () => {
    const opts = { baseMs: 30_000, maxMs: 900_000, random: () => 0.5 };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, opts))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 450_000, 450_000, 450_000]);
  });
  test("for any RNG draw in [0,1) the delay never exceeds its own bound or the cap", () => {
    for (const r of [0, 0.01, 0.37, 0.5, 0.99]) {
      for (let n = 1; n <= 12; n++) {
        const bound = Math.min(30_000 * 2 ** (n - 1), 900_000);
        const d = backoffDelayMs(n, { baseMs: 30_000, maxMs: 900_000, random: () => r });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(bound);
        expect(d).toBeLessThanOrEqual(900_000);
      }
    }
  });
});

describe("replica start backs off and stops after repeated snapshot failures", () => {
  function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
    const delays: number[] = [];
    return { delays, sleep: async (ms) => void delays.push(ms) };
  }
  const stubEventsSdk = () => ({
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${home}/events`,
    readCachedEvents: async () => [],
    async *tailCachedEvents() {},
  });

  test("an always-failing snapshot backs off with full jitter, stops after maxFailures, and issues no further requests however far the clock advances", async () => {
    await seedJoined(home, server);
    server.snapshotStatus = 503;
    const before = server.requests.length; // `server` is shared across this file's tests (beforeAll)
    const { sleep, delays } = fakeSleep();
    const code = await main(["replica", "start"], ctx, {
      replica: {
        waitForStop: () => new Promise<void>(() => {}), // the user never asks it to stop
        sleep,
        random: () => 0.5,
        snapshotRetry: { baseBackoffMs: 30_000, maxBackoffMs: 900_000, maxFailures: 5 },
      },
    });
    expect(code).toBe(1); // it gave up
    const pulls = server.requests.slice(before).filter((r) => r.path.startsWith("/api/v1/snapshot"));
    expect(pulls).toHaveLength(5); // exactly maxFailures, no more
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000]); // exactly maxFailures - 1 sleeps, growing
    expect(Math.max(...delays)).toBeLessThanOrEqual(900_000);

    const after = server.requests.length;
    await new Promise((r) => setTimeout(r, 300)); // real wall-clock time, unbounded by the fake clock
    expect(server.requests.length).toBe(after); // nothing further fired

    const dbPath = defaultReplicaDbFor(home);
    const st = readWriterState(dbPath)!;
    expect(st.stopped).not.toBeNull();
    expect(st.consecutiveFailures).toBe(5);
    expect(st.lastError).toContain("503");
    expect(st.stopped!.restartWith).toBe("catalyst replica start --detach");
    expect(existsSync(pidfilePath(dbPath))).toBe(false);
    const out = ctx.out.join("\n");
    expect(out).toContain("catalyst replica start --detach");
    expect(out).toContain("optional");
  });

  test("the snapshot no-progress bound the CLI passes reaches the SDK: a pull slower than it fails with the SDK's idle error (CTC-6569)", async () => {
    await seedJoined(home, server);
    server.snapshotDelayMs = 300; // the mirror is still preparing the snapshot
    try {
      const { sleep } = fakeSleep();
      const code = await main(["replica", "start"], ctx, {
        replica: {
          waitForStop: () => new Promise<void>(() => {}),
          sleep,
          random: () => 0.5,
          snapshotRetry: { maxFailures: 1 },
          snapshotIdleTimeoutMs: 100,
        },
      });
      expect(code).toBe(1);
      expect(readWriterState(defaultReplicaDbFor(home))!.lastError).toContain("no progress for 100ms");
    } finally {
      server.snapshotDelayMs = undefined;
    }
  });

  test("the production snapshot no-progress bound outlasts the mirror's 120 s snapshot preparation (CTC-6569)", () => {
    // A 30 s bound aborted nearly every first sync of a large workspace; host-sync and web pass 150 s.
    expect(SNAPSHOT_IDLE_TIMEOUT_MS).toBe(150_000);
    expect(SNAPSHOT_IDLE_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  test("a success resets the failure count; a clean stop afterwards clears the record entirely", async () => {
    await seedJoined(home, server);
    server.snapshotStatus = 503;
    let n = 0;
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
      n += 1;
      if (n === 2) server.snapshotStatus = undefined; // heal the endpoint before the run gives up
    };
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const sockets: { onopen: ((ev: unknown) => void) | null }[] = [];
    const run = main(["replica", "start"], ctx, {
      replica: {
        loadEventsSdk: async () => stubEventsSdk(),
        waitForStop: () => stopped,
        sleep,
        random: () => 0.5,
        snapshotRetry: { baseBackoffMs: 30_000, maxBackoffMs: 900_000, maxFailures: 10 },
        // The seed succeeds partway through this test (see `sleep` above); once it does, the writer
        // moves on to opening the live socket, which needs a fake — the fixture serves no real WS.
        wsFactory: () => {
          const ws = {
            onopen: null as ((ev: unknown) => void) | null,
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            onclose: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            send() {},
            close() {
              queueMicrotask(() => ws.onclose?.({}));
            },
          };
          sockets.push(ws);
          queueMicrotask(() => ws.onopen?.({}));
          return ws;
        },
      },
    });
    const { waitFor } = await import("./helpers");
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    const dbPath = defaultReplicaDbFor(home);
    const st = readWriterState(dbPath);
    expect(st?.consecutiveFailures).toBe(0); // the completed snapshot zeroed it
    expect(st?.stopped).toBeNull();
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(delays.length).toBeLessThan(10);
    stop();
    expect(await run).toBe(0); // exits 0 on the user's stop, not 1
    expect(readWriterState(dbPath)).toBeNull(); // a clean stop clears the record entirely
  });

  test("a stale stopped record from a previous run does not survive a new start", async () => {
    await seedJoined(home, server);
    const dbPath = seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: { at: 1, reason: "5 consecutive snapshot failures", restartWith: "catalyst replica start --detach" },
    });
    server.headCursor = 21;
    const sockets: { onopen: ((ev: unknown) => void) | null }[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, {
      replica: {
        loadEventsSdk: async () => stubEventsSdk(),
        waitForStop: () => stopped,
        wsFactory: () => {
          const ws = {
            onopen: null as ((ev: unknown) => void) | null,
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            onclose: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            send() {},
            close() {
              queueMicrotask(() => ws.onclose?.({}));
            },
          };
          sockets.push(ws);
          return ws;
        },
      },
    });
    const { waitFor } = await import("./helpers");
    await waitFor(() => sockets.length === 1, 10_000);
    sockets[0]!.onopen?.({});
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    expect(readWriterState(dbPath)).toBeNull();
    stop();
    expect(await run).toBe(0);
    expect(readWriterState(dbPath)).toBeNull();
  });
});

describe("the supervisor separates a stopped replica from a failed snapshot (CTC-2499 remediation)", () => {
  interface FakeSocket {
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    send(): void;
    close(): void;
  }
  function makeSocket(): FakeSocket {
    const ws: FakeSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {
        queueMicrotask(() => ws.onclose?.({}));
      },
    };
    return ws;
  }
  const stubEventsSdk = () => ({
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${home}/events`,
    readCachedEvents: async () => [],
    async *tailCachedEvents() {},
  });

  test("classifyStartError: the SDK's stop-now rejections are never counted, and two of them may not be recorded", () => {
    const mismatch = Object.assign(new Error("refusing to open /x.db"), { name: "ReplicaAccountMismatchError" });
    expect(classifyStartError(mismatch)).toEqual({ reason: "refusing to open /x.db", recordable: false });
    expect(classifyStartError(new Error("CatalystReplica: another writer owns this replica at /x.db (pid=4)"))).toMatchObject({ recordable: false });
    expect(classifyStartError(new Error("CatalystReplica: start() already called"))).toMatchObject({ recordable: false });
    expect(classifyStartError(new Error("CatalystReplica: start() after close()"))).toMatchObject({ recordable: false });
    expect(classifyStartError(new Error("/snapshot 503"))).toBeNull(); // an ordinary failed pull: retry it
  });

  test("a second start against a LIVE writer stops at once and leaves that writer's record untouched", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 }); // a live writer holds the lock
    const dbPath = seedWriterState(home, { consecutiveFailures: 0, lastError: null, stopped: null });
    const before = server.requests.length;
    const delays: number[] = [];
    const code = await main(["replica", "start"], ctx, {
      replica: {
        waitForStop: () => new Promise<void>(() => {}),
        sleep: async (ms) => void delays.push(ms),
        random: () => 0.5,
        snapshotRetry: { baseBackoffMs: 30_000, maxBackoffMs: 900_000, maxFailures: 5 },
      },
    });
    expect(code).toBe(1);
    expect(delays).toEqual([]); // a lock conflict is not retried at all
    expect(server.requests.slice(before).filter((r) => r.path.startsWith("/api/v1/snapshot"))).toHaveLength(0);
    const st = readWriterState(dbPath);
    expect(st).not.toBeNull(); // the running writer's record survived this process entirely
    expect(st!.stopped).toBeNull();
    expect(st!.consecutiveFailures).toBe(0);
    expect(ctx.out.join("\n")).toContain("another writer owns this replica");
  });

  test("a socket failure after a completed seed is not a snapshot failure", async () => {
    await seedJoined(home, server); // no replica file yet: a cold seed, and /snapshot is healthy
    const dbPath = defaultReplicaDbFor(home);
    const before = server.requests.length;
    const delays: number[] = [];
    const sockets: FakeSocket[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, {
      replica: {
        loadEventsSdk: async () => stubEventsSdk(),
        waitForStop: () => stopped,
        sleep: async (ms) => void delays.push(ms),
        random: () => 0.5,
        snapshotRetry: { baseBackoffMs: 30_000, maxBackoffMs: 900_000, maxFailures: 5 },
        wsFactory: () => {
          const ws = makeSocket();
          sockets.push(ws);
          // The first upgrade is blocked (a corporate proxy that permits the GET but not the socket);
          // the SDK's own reconnect opens the second.
          if (sockets.length === 1) queueMicrotask(() => ws.onerror?.(new Error("upgrade blocked")));
          return ws;
        },
      },
    });
    await waitFor(() => sockets.length === 2, 10_000);
    sockets[1]!.onopen?.({});
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    expect(delays).toEqual([]); // the snapshot worked, so there is nothing to back off from
    expect(readWriterState(dbPath)?.consecutiveFailures ?? 0).toBe(0);
    expect(readWriterState(dbPath)?.stopped ?? null).toBeNull();
    expect(server.requests.slice(before).filter((r) => r.path.startsWith("/api/v1/snapshot") && !r.path.includes("head=1"))).toHaveLength(1);
    stop();
    expect(await run).toBe(0);
  });

  test("a WARM writer that recovers without a re-seed clears its failure count", async () => {
    await seedJoined(home, server);
    const dbPath = await seedReplica(home, { cursor: 41 }); // warm, and nothing else owns it
    server.snapshotStatus = 503;
    const LIVE_STABLE_MS = 77_000;
    const delays: number[] = [];
    let releaseStable!: () => void;
    const stable = new Promise<void>((r) => (releaseStable = r));
    const sleep = async (ms: number): Promise<void> => {
      if (ms === LIVE_STABLE_MS) return stable; // the "has this live session held?" wait, driven by the test
      delays.push(ms); // a backoff
    };
    const sockets: FakeSocket[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, {
      replica: {
        loadEventsSdk: async () => stubEventsSdk(),
        waitForStop: () => stopped,
        sleep,
        random: () => 0.5,
        snapshotRetry: { baseBackoffMs: 30_000, maxBackoffMs: 900_000, maxFailures: 5, liveStableMs: LIVE_STABLE_MS },
        wsFactory: () => {
          const ws = makeSocket();
          sockets.push(ws);
          return ws;
        },
      },
    });
    await waitFor(() => sockets.length === 1, 10_000);
    sockets[0]!.onopen?.({}); // a warm boot goes live WITHOUT ever emitting "resyncing"
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "resync" }) }); // the mirror demands a re-seed
    await waitFor(() => readWriterState(dbPath)?.consecutiveFailures === 1, 10_000); // /snapshot 503
    server.snapshotStatus = undefined; // the mirror recovers; ordinary deltas catch the writer up
    await waitFor(() => sockets.length === 2, 10_000);
    sockets[1]!.onopen?.({});
    releaseStable(); // and this live session holds
    await waitFor(() => readWriterState(dbPath)?.consecutiveFailures === 0, 10_000);
    expect(readWriterState(dbPath)?.stopped ?? null).toBeNull();
    expect(delays).toEqual([15_000]); // exactly the one backoff, not a second failure
    stop();
    expect(await run).toBe(0);
  });

  test("replica status does not describe a writer that is no longer running as backing off", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41 }); // no lock, no live writer: it was killed mid-backoff
    seedWriterState(home, { pid: 4_194_303, consecutiveFailures: 2, lastError: "/snapshot 503", lastFailureAt: 1_700_000_000_000 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toContain("no longer running");
    expect(text).not.toContain("backing off");
    expect(text).toContain("/snapshot 503");
  });
});

describe("engineFor", () => {
  test("falls back to node:sqlite when better-sqlite3 is absent, and says nothing (CTC-4272)", async () => {
    const sdk = await loadSdk();
    const dbPath = `${home}/x.db`;
    const engine = await engineFor(sdk, dbPath, ctx, {
      requireDriver: () => {
        throw new Error("Cannot find module 'better-sqlite3'");
      },
    });
    expect(ctx.err).toHaveLength(0);
    engine.exec("CREATE TABLE t (x)");
    engine.close();
    expect(existsSync(dbPath)).toBe(true);
  });
  test("falls back when the driver constructor throws (an ABI mismatch), and says nothing (CTC-4272)", async () => {
    const sdk = await loadSdk();
    const engine = await engineFor(sdk, `${home}/y.db`, ctx, {
      requireDriver: () =>
        function Broken() {
          throw new Error("NODE_MODULE_VERSION 115 mismatch");
        },
    });
    expect(ctx.err).toHaveLength(0);
    engine.close();
  });
});

describe("replica sql / schema", () => {
  test("sql refuses a non-SELECT and a second statement", async () => {
    expect(() => assertSingleSelect("delete from issues")).toThrow(/exactly one SELECT/);
    expect(() => assertSingleSelect("select 1; drop table issues")).toThrow(/exactly one SELECT/);
    expect(assertSingleSelect("  select 1;  ")).toBe("select 1");
    await seedJoined(home, server);
    expect(await main(["replica", "sql", "update issues set title = 'x'"], ctx)).toBe(1);
  });
  test("sql runs a SELECT through the read-only replica", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 1, issues: [{ id: "lin-1", identifier: "ENG-1", title: "one", state: "Todo", team_id: "team-eng" }] });
    expect(await main(["replica", "sql", "select identifier, title from issues", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual([{ identifier: "ENG-1", title: "one" }]);
  });
  test("schema lists every mirrorSchema table with its columns", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 1 });
    const sdk = await loadSdk();
    const expected = Object.values(sdk.mirrorSchema).map((t) => (t as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]);
    expect(expected.length).toBeGreaterThan(30);
    expect(await main(["replica", "schema", "--json"], ctx)).toBe(0);
    const out = JSON.parse(ctx.out.join("\n")) as Record<string, { name: string }[]>;
    for (const name of expected) expect(Object.keys(out), `schema must list ${name}`).toContain(name);
    expect(out.issues!.map((c) => c.name)).toContain("identifier");
    const c2 = makeCtx(home);
    expect(await main(["replica", "schema", "issues"], c2)).toBe(0);
    expect(c2.out).toHaveLength(1);
    expect(c2.out[0]).toMatch(/^issues: id TEXT PK/);
    const c3 = makeCtx(home);
    expect(await main(["replica", "schema", "nope"], c3)).toBe(2);
  });
  test("schema and sql exit 3 when the replica file is absent", async () => {
    await seedJoined(home, server);
    expect(await main(["replica", "schema"], ctx)).toBe(3);
    expect(await main(["replica", "sql", "select 1"], makeCtx(home))).toBe(3);
  });
});

describe("replica start --detach / stop", () => {
  test("start --detach spawns the writer without --detach and writes the pidfile; stop signals it", async () => {
    await seedJoined(home, server);
    const spawned: string[][] = [];
    const code = await main(["replica", "start", "--detach"], ctx, {
      replica: {
        detach: (argv) => {
          spawned.push(argv);
          return { pid: process.pid };
        },
        argv: ["/x/bin/catalyst-skills.js", "replica", "start", "--detach"],
      },
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([["/x/bin/catalyst-skills.js", "replica", "start"]]);
    const dbPath = defaultReplicaDbFor(home);
    expect(readFileSync(pidfilePath(dbPath), "utf8").trim()).toBe(String(process.pid));
    expect(ctx.out.join("\n")).toContain(`pid ${process.pid}`);
    // stop on a pid that is not running removes the stale pidfile and exits 1
    writeFileSync(pidfilePath(dbPath), "2147483000\n");
    const c2 = makeCtx(home);
    expect(await main(["replica", "stop"], c2)).toBe(1);
    expect(existsSync(pidfilePath(dbPath))).toBe(false);
    const c3 = makeCtx(home);
    expect(await main(["replica", "stop"], c3)).toBe(1);
    expect(c3.out.join("\n")).toContain("nothing to stop");
  });
  test("a missing subcommand is a usage error", async () => {
    expect(await main(["replica"], ctx)).toBe(1);
  });
});

describe("replica start (foreground, in-process against the fixture)", () => {
  test("seeds from the fixture snapshot, opens the socket, reports live, and stops on request", async () => {
    await seedJoined(home, server);
    server.headCursor = 21;
    const sockets: { onopen: ((ev: unknown) => void) | null; onclose: ((ev: unknown) => void) | null }[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, {
      replica: {
        loadEventsSdk: async () => ({
          CatalystEventSync: class {
            async start() {
              throw new Error("history gap");
            }
            async stop() {}
          },
          defaultEventCacheDirectory: () => `${home}/events`,
          readCachedEvents: async () => [],
          async *tailCachedEvents() {},
        }),
        waitForStop: () => stopped,
        wsFactory: () => {
          const ws = {
            sent: [] as string[],
            onopen: null as ((ev: unknown) => void) | null,
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            onclose: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            send(d: string) {
              ws.sent.push(d);
            },
            close() {
              queueMicrotask(() => ws.onclose?.({}));
            },
          };
          sockets.push(ws);
          return ws;
        },
      },
    });
    const { waitFor } = await import("./helpers");
    await waitFor(() => sockets.length === 1, 10_000);
    sockets[0]!.onopen?.({});
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    await waitFor(() => ctx.err.some((l) => l.includes("sync failed: history gap; replica remains live")), 10_000);
    expect(ctx.out.find((l) => l.startsWith("replica live at"))).toContain("(cursor 21)");
    const status = makeCtx(home);
    expect(await main(["replica", "status"], status)).toBe(0);
    expect(status.out[0]).toContain("cursor 21");
    stop();
    expect(await run).toBe(0);
    expect(ctx.out.at(-1)).toBe("replica stopped");
    const after = makeCtx(home);
    expect(await main(["replica", "sql", "select identifier from issues order by identifier", "--json"], after)).toBe(0);
    expect(JSON.parse(after.out.join("\n"))).toEqual([{ identifier: "ENG-1" }, { identifier: "ENG-2" }]);
  }, 30_000);

  test("stop signals a live pid and removes the pidfile", async () => {
    await seedJoined(home, server);
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(pidfilePath(defaultReplicaDbFor(home)), `${child.pid}\n`);
      expect(await main(["replica", "stop"], ctx)).toBe(0);
      expect(ctx.out.join("\n")).toContain(`sent SIGTERM to replica writer pid ${child.pid}`);
      expect(existsSync(pidfilePath(defaultReplicaDbFor(home)))).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("engineFor's default resolver falls back when better-sqlite3 is not installed; status tolerates a corrupt config and honours --db", async () => {
    const sdk = await loadSdk();
    const engine = await engineFor(sdk, `${home}/z.db`, ctx);
    engine.close();
    // CTC-4272: node:sqlite is the supported path, so a working fallback prints nothing...
    expect(ctx.err).toHaveLength(0);
    // ...and CATALYST_DEBUG=1 still names it (the positive control that the fallback ran).
    const dbg = { ...makeCtx(home), env: { ...makeCtx(home).env, CATALYST_DEBUG: "1" } };
    (await engineFor(sdk, `${home}/z2.db`, dbg)).close();
    expect(dbg.err).toHaveLength(1);
    expect(dbg.err[0]).toMatch(/better-sqlite3 unavailable .*using node:sqlite/);
    writeFileSync(`${home}/../nothing`, "");
    const c2 = makeCtx(home);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${home}/.config/catalyst-cloud`, { recursive: true });
    writeFileSync(`${home}/.config/catalyst-cloud/customer.json`, "{corrupt");
    expect(await main(["replica", "status"], c2)).toBe(2);
    await seedJoined(home, server);
    const other = await seedReplica(home, { dbPath: `${home}/other.db`, cursor: 9, heartbeatAgeMs: 0 });
    const c3 = makeCtx(home);
    expect(await main(["replica", "status", "--db", other, "--json"], c3)).toBe(0);
    expect(JSON.parse(c3.out.join("\n")).cursor).toBe(9);
    writeFileSync(pidfilePath(other), "not-a-pid\n");
    writeFileSync(`${other}.writer.lock`, "{garbage");
    const c4 = makeCtx(home);
    expect(await main(["replica", "status", "--db", other], c4)).toBe(1);
    expect(c4.out[0]).toContain("no writer lock");
    const c5 = makeCtx(home);
    expect(await main(["replica", "sql", "", "--db", other], c5)).toBe(1);
    const c6 = makeCtx(home);
    expect(await main(["replica", "wat"], c6)).toBe(1);
  });
});

describe("loadSqlite — CTC-2158: node:sqlite is loaded on first use, not at module load", () => {
  beforeEach(() => resetSqliteCache());

  test("a runtime that has node:sqlite loads it, and caches the module", () => {
    const mod = loadSqlite();
    expect(typeof mod.DatabaseSync).toBe("function");
    expect(loadSqlite()).toBe(mod);
  });

  test("a runtime without node:sqlite raises a named CliError, never a raw ResolveMessage", () => {
    resetSqliteCache();
    let caught: unknown;
    try {
      loadSqlite(() => {
        throw new Error("No such built-in module: node:sqlite");
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    const message = (caught as CliError).message;
    expect(message).toContain("node:sqlite");
    expect(message).toContain(BUN_MIN);
    expect(message).toContain(FIX_COMMAND);
    expect(message).not.toContain("ResolveMessage");
  });
});
