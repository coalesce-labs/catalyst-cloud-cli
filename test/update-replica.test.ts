// update-replica.test.ts — a running replica comes back on the approved CLI with its data
// (CTC-6708). The old writer is a real child process, so the stop is a real signal and a real exit;
// the replica's status is the seam, so the test can see the lock released and the new writer's
// version. Never a second writer: a writer that does not exit is left alone.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { pendingRestartPathFor, pidAlive, pidfilePath, type ReplicaStatus } from "../src/replica";
import { replicaStartCommand, restartReplica } from "../src/update-replica";
import { makeCtx, tempHome } from "./helpers";
import { NEXT, OLD, signIn } from "./update-fixtures";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function oldWriter(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "replica", "start"], { stdio: "ignore" });
  children.push(child);
  if (typeof child.pid !== "number") throw new Error("no pid");
  return child.pid;
}

/** A replica database with synced bytes, and a status that follows the real old writer's process. */
function replica(oldPid: number) {
  const dir = mkdtempSync(join(tmpdir(), "update-replica-"));
  const dbPath = join(dir, "replica.db");
  writeFileSync(dbPath, "synced rows and cursor");
  let next: { pid: number; version: string } | null = null;
  const status = (): ReplicaStatus => {
    const writer = next ?? (pidAlive(oldPid) ? { pid: oldPid, version: OLD } : null);
    return {
      verdict: writer ? "fresh" : "stale",
      exitCode: writer ? 0 : 1,
      configured: true,
      dbPath,
      cursor: 7,
      heartbeatAgeMs: 0,
      lockPid: writer?.pid ?? null,
      pidfilePid: null,
      writerAlive: writer !== null,
      reasons: [],
      writer: writer ? { updatedAt: 1, pid: writer.pid, consecutiveFailures: 0, lastError: null, lastFailureAt: null, stopped: null, version: writer.version } : null,
    };
  };
  return { dbPath, status, answer: (pid: number, version: string) => (next = { pid, version }) };
}

const quick = { timeoutMs: 5_000, pollMs: 20 };

describe("restartReplica", () => {
  it("POSITIVE CONTROL: stops the old writer, waits for it to exit, starts one on the same database through the person's own command, and reads its version back", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const ctx = makeCtx(home, { env: { CATALYST_CLI_ACTIVE_RUNTIME: "/old/bin", CATALYST_CLI_LAUNCHER: "/usr/bin/catalyst", KEEP: "1" } });
    const pid = oldWriter();
    const r = replica(pid);
    const starts: { argv: readonly string[]; env: NodeJS.ProcessEnv; oldAlive: boolean }[] = [];
    const result = await restartReplica(ctx, cfg, NEXT, {
      ...quick,
      launcher: "/usr/bin/catalyst",
      status: r.status,
      start: (argv, env) => {
        starts.push({ argv, env, oldAlive: pidAlive(pid) });
        r.answer(4242, NEXT);
        return 4242;
      },
    });
    expect(result).toEqual({ outcome: "updated", detail: "restarted", version: NEXT });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.oldAlive).toBe(false);
    expect(starts[0]?.argv).toEqual(["/usr/bin/catalyst", "replica", "start", "--db", r.dbPath]);
    expect(starts[0]?.env).toMatchObject({ KEEP: "1" });
    expect(starts[0]?.env.CATALYST_CLI_ACTIVE_RUNTIME).toBeUndefined();
    expect(readFileSync(pidfilePath(r.dbPath), "utf8")).toBe("4242\n");
    expect(readFileSync(r.dbPath, "utf8")).toBe("synced rows and cursor");
  });

  it("NEGATIVE: a writer that does not exit in time is left running and no second writer starts", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const pid = oldWriter();
    const r = replica(pid);
    let started = 0;
    const result = await restartReplica(makeCtx(home), cfg, NEXT, {
      timeoutMs: 100,
      pollMs: 20,
      launcher: "/usr/bin/catalyst",
      status: r.status,
      signal: () => {},
      start: () => ++started,
    });
    expect(result).toMatchObject({ outcome: "failed", detail: "stop_timeout", version: OLD });
    expect(started).toBe(0);
    expect(pidAlive(pid)).toBe(true);
  });

  it("NEGATIVE: a live process left in a stale lock that is not a replica writer is never signalled", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(other);
    const r = replica(other.pid ?? -1);
    let signalled = 0;
    const result = await restartReplica(makeCtx(home), cfg, NEXT, { ...quick, launcher: "/usr/bin/catalyst", status: r.status, signal: () => signalled++, start: () => 1 });
    expect(result).toMatchObject({ outcome: "failed", detail: "writer_unidentified" });
    expect(signalled).toBe(0);
    expect(existsSync(pendingRestartPathFor(home))).toBe(false);
  });

  it("under a scheduled Linux run the new writer gets a systemd scope of its own, so the run ending does not stop it", () => {
    const argv = ["/usr/bin/catalyst", "replica", "start", "--db", "/x/replica.db"];
    expect(replicaStartCommand(argv, { INVOCATION_ID: "abc" }, "linux")).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--", process.execPath, ...argv]);
    expect(replicaStartCommand(argv, {}, "linux")).toEqual([process.execPath, ...argv]);
    expect(replicaStartCommand(argv, { INVOCATION_ID: "abc" }, "darwin")).toEqual([process.execPath, ...argv]);
  });

  it("a stopped replica stays stopped", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const r = replica(-1);
    let calls = 0;
    const result = await restartReplica(makeCtx(home), cfg, NEXT, { ...quick, launcher: "/usr/bin/catalyst", status: r.status, signal: () => calls++, start: () => ++calls });
    expect(result).toEqual({ outcome: "stopped", detail: "stopped", version: null });
    expect(calls).toBe(0);
  });

  it("a new writer that never reports the approved version is a failure, never reported as updated", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const pid = oldWriter();
    const r = replica(pid);
    const result = await restartReplica(makeCtx(home), cfg, NEXT, {
      timeoutMs: 200,
      pollMs: 20,
      launcher: "/usr/bin/catalyst",
      status: r.status,
      start: () => (r.answer(4343, OLD), 4343),
    });
    expect(result).toEqual({ outcome: "failed", detail: "restart_unconfirmed", version: OLD });
    expect(readFileSync(r.dbPath, "utf8")).toBe("synced rows and cursor");
  });
});

describe("a restart that did not finish (review of the interval promise)", () => {
  it("a writer that exits after the deadline is started by the next check, and the record is cleared once it reports", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    const pid = oldWriter();
    const r = replica(pid);
    const first = await restartReplica(makeCtx(home), cfg, NEXT, { timeoutMs: 60, pollMs: 20, launcher: "/usr/bin/catalyst", status: r.status, signal: () => {}, start: () => 1 });
    expect(first).toMatchObject({ outcome: "failed", detail: "stop_timeout" });
    expect(JSON.parse(readFileSync(pendingRestartPathFor(home), "utf8"))).toEqual({ dbPath: r.dbPath, target: NEXT });
    // The old writer exits late; the replica now reads as stopped.
    process.kill(pid, "SIGKILL");
    while (pidAlive(pid)) await new Promise((done) => setTimeout(done, 10));
    const starts: (readonly string[])[] = [];
    const second = await restartReplica(makeCtx(home), cfg, NEXT, {
      ...quick,
      launcher: "/usr/bin/catalyst",
      status: r.status,
      signal: () => {
        throw new Error("there is no writer left to stop");
      },
      start: (argv) => (starts.push(argv), r.answer(4545, NEXT), 4545),
    });
    expect(second).toEqual({ outcome: "updated", detail: "restarted", version: NEXT });
    expect(starts).toHaveLength(1);
    expect(existsSync(pendingRestartPathFor(home))).toBe(false);
  });

  it("replica status says a writer a release check restarted is down for that reason, and its data is kept", async () => {
    const home = tempHome();
    signIn(home);
    const dbPath = join(mkdtempSync(join(tmpdir(), "update-replica-status-")), "replica.db");
    writeFileSync(pendingRestartPathFor(home), JSON.stringify({ dbPath, target: NEXT }));
    const ctx = makeCtx(home);
    await main(["replica", "status", "--db", dbPath], ctx);
    expect(ctx.out.at(-1)).toBe(
      `  a release check restarted it on CLI ${NEXT} and the new writer is not running; its synced data is kept at ${dbPath}, and the next release check starts it again`,
    );
    const json = makeCtx(home);
    await main(["replica", "status", "--db", dbPath, "--json"], json);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ dbPath, pendingRestart: { dbPath, target: NEXT } });
  });

  it("the owner's own replica stop clears it, so their stop is never undone", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    writeFileSync(pendingRestartPathFor(home), JSON.stringify({ dbPath: "/x/replica.db" }));
    const dbPath = join(mkdtempSync(join(tmpdir(), "update-replica-stop-")), "replica.db");
    await main(["replica", "stop", "--db", dbPath], makeCtx(home));
    expect(existsSync(pendingRestartPathFor(home))).toBe(false);
    const r = replica(-1);
    expect(await restartReplica(makeCtx(home), cfg, NEXT, { ...quick, launcher: "/usr/bin/catalyst", status: r.status, start: () => 1 })).toMatchObject({ outcome: "stopped" });
  });
});
