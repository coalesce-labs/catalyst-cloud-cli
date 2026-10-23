// update-replica.ts — a running local replica comes back on the approved CLI with its data
// (CTC-6708). A detached writer keeps the code it started with, so after the CLI moves, a release
// check stops the writer it can identify, waits until that process has exited and released the
// writer lock, then starts a new writer through the person's own `catalyst` command (which runs the
// selected version) on the same database file. Nothing here deletes, moves or reseeds the database:
// the new writer resumes from the rows and cursor the old one left.
//
// It never starts a second writer: when the old one does not exit inside the deadline, or cannot be
// identified, the restart stops there with a reason and the next check tries again. Before it stops
// a writer it records that restart (replica-restart.json), and clears the record only once the new
// writer reports its version, so a writer that exits after the deadline is started by the next check
// instead of being taken for one its owner stopped. A replica that was stopped stays stopped.
// Success is read back from the new writer's own record of the CLI version it runs.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { configDirFor, type Ctx, type CustomerConfig } from "./config.js";
import { pendingRestart, pendingRestartPathFor, pidAlive, pidfilePath, replicaStatus, writerIsRunning, type ReplicaStatus } from "./replica.js";
import { ACTIVE_RUNTIME_ENV } from "./update-cli.js";

export interface ReplicaRestartResult {
  outcome: "updated" | "stopped" | "failed";
  /** `restarted`, `stopped` (left as it was), `writer_unidentified`, `stop_timeout`, `start_failed`, `restart_unconfirmed`. */
  detail: string;
  /** The CLI version the writer reports running after this call, when it reports one. */
  version: string | null;
}

export interface ReplicaRestartDeps {
  /** The person's own `catalyst` command. */
  launcher: string;
  signal?: (pid: number) => void;
  alive?: (pid: number) => boolean;
  /** Whether `pid` is a replica writer; a pid left in a stale lock may now be another program. */
  identify?: (pid: number) => boolean;
  /** Start `catalyst replica start --db <path>` detached; returns its pid. */
  start?: (argv: readonly string[], env: NodeJS.ProcessEnv) => number;
  sleep?: (ms: number) => Promise<void>;
  status?: () => ReplicaStatus;
  /** How long the old writer gets to exit, and the new one to report its version. */
  timeoutMs?: number;
  pollMs?: number;
}

/** Whether a restart this CLI began for `dbPath` has not finished: the writer was stopped by it. */
export function restartPending(home: string, dbPath: string): boolean {
  return pendingRestart(home, dbPath) !== null;
}

/** A writer's command line runs `replica start` (bin/launch.js keeps it in one process). */
export function isReplicaWriter(pid: number): boolean {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 5_000 });
  return ps.status === 0 && /\sreplica\s+start(\s|$)/.test(ps.stdout);
}

/**
 * The command that starts the new writer. A scheduled run on Linux is a systemd oneshot service, and
 * when it ends systemd stops every process left in its control group, a detached one included; a
 * transient scope of the writer's own keeps it running after the release check ends.
 */
export function replicaStartCommand(argv: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const node = [process.execPath, ...argv];
  return platform === "linux" && env.INVOCATION_ID ? ["systemd-run", "--user", "--scope", "--quiet", "--", ...node] : node;
}

const startDetached = (argv: readonly string[], env: NodeJS.ProcessEnv): number => {
  const run = (command: readonly string[]) => {
    const [cmd, ...args] = command;
    if (cmd === undefined) return undefined;
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", env });
    child.on("error", () => {});
    child.unref();
    return child.pid;
  };
  // No systemd-run on PATH: start it directly, as `replica start --detach` does.
  const pid = run(replicaStartCommand(argv, env)) ?? run([process.execPath, ...argv]);
  if (typeof pid !== "number") throw new Error("detached spawn returned no pid");
  return pid;
};

/** Restart a running replica writer on the CLI the stable command now selects, expecting `target`. */
export async function restartReplica(ctx: Ctx, cfg: CustomerConfig, target: string, deps: ReplicaRestartDeps): Promise<ReplicaRestartResult> {
  const status = deps.status ?? (() => replicaStatus(ctx, cfg));
  const alive = deps.alive ?? pidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const pollMs = deps.pollMs ?? 250;
  const waitFor = async (done: () => boolean): Promise<boolean> => {
    for (let waited = 0; ; waited += pollMs) {
      if (done()) return true;
      if (waited >= timeoutMs) return false;
      await sleep(pollMs);
    }
  };

  const before = status();
  if (before.dbPath === null) return { outcome: "stopped", detail: "stopped", version: null };
  const dbPath = before.dbPath;
  // Stopped: by its owner (it stays stopped), or by an earlier restart that did not finish (it starts).
  if (!writerIsRunning(before) && !restartPending(ctx.home, dbPath)) return { outcome: "stopped", detail: "stopped", version: null };
  if (writerIsRunning(before)) {
    // The writer is the process holding the lock (or recorded in its own state, or the pidfile).
    const pid = before.lockPid ?? before.writer?.pid ?? before.pidfilePid;
    if (pid === null || !alive(pid) || !(deps.identify ?? isReplicaWriter)(pid))
      return { outcome: "failed", detail: "writer_unidentified", version: before.writer?.version ?? null };
    try {
      mkdirSync(configDirFor(ctx.home), { recursive: true, mode: 0o700 });
      writeFileSync(pendingRestartPathFor(ctx.home), `${JSON.stringify({ dbPath, target })}\n`, { mode: 0o600 });
    } catch {
      // Without the record a late exit would read as an owner's stop: do not stop the writer.
      return { outcome: "failed", detail: "start_failed", version: before.writer?.version ?? null };
    }
    try {
      (deps.signal ?? ((p: number) => process.kill(p, "SIGTERM")))(pid);
    } catch {
      rmSync(pendingRestartPathFor(ctx.home), { force: true });
      return { outcome: "failed", detail: "writer_unidentified", version: before.writer?.version ?? null };
    }
    const exited = await waitFor(() => !alive(pid) && !writerIsRunning(status()));
    if (!exited) return { outcome: "failed", detail: "stop_timeout", version: before.writer?.version ?? null };
  }

  // Without a staged check's marker, so the person's own command selects the version to run.
  const env = { ...ctx.env };
  delete env[ACTIVE_RUNTIME_ENV];
  let started: number;
  try {
    started = (deps.start ?? startDetached)([deps.launcher, "replica", "start", "--db", dbPath], env);
    writeFileSync(pidfilePath(dbPath), `${started}\n`);
  } catch {
    return { outcome: "failed", detail: "start_failed", version: null };
  }
  let now: ReplicaStatus = status();
  const confirmed = await waitFor(() => {
    now = status();
    return writerIsRunning(now) && now.writer?.version === target;
  });
  if (!confirmed) return { outcome: "failed", detail: "restart_unconfirmed", version: now.writer?.version ?? null };
  rmSync(pendingRestartPathFor(ctx.home), { force: true });
  return { outcome: "updated", detail: "restarted", version: target };
}
