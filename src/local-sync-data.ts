import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { configPathFor, defaultReplicaDbFor, replicaDbPath, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import { loadMachinePaths } from "../vendor/paths/node.js";

export interface LocalSyncFile {
  kind: "data";
  name: string;
  path: string;
  localSync: true;
  size: number;
  dev: number;
  ino: number;
}

function json(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
  catch { return {}; }
}

/** Read only known replica leaves and SDK event-cache segments, never a shared directory. */
export async function findLocalSyncData(ctx: Ctx): Promise<LocalSyncFile[]> {
  const cfg = json(configPathFor(ctx.home));
  const env = { ...ctx.env, HOME: ctx.home };
  const machine = await loadMachinePaths({ env });
  const databases = new Set([
    defaultReplicaDbFor(ctx.home),
    join(ctx.home, ".config", "catalyst", "replica.db"),
  ]);
  if (typeof cfg.replicaDb === "string") {
    if (!isAbsolute(cfg.replicaDb)) throw new CliError("the saved replica path is not absolute; local data kept", "local-sync-path-invalid");
    databases.add(cfg.replicaDb);
  }
  try {
    databases.add(replicaDbPath({ replicaDb: typeof cfg.replicaDb === "string" ? cfg.replicaDb : undefined }, ctx.home, ctx.env));
  } catch (error) {
    if (!(error instanceof CliError && error.code === "replica-not-configured")) throw error;
  }
  const paths = new Set<string>();
  for (const db of databases) {
    if (/^(customer|contract|settings|config|paths)\.(json|toml)$/.test(db.split("/").at(-1) ?? ""))
      throw new CliError(`local sync cleanup cannot delete login, contract or settings: ${db}`, "local-sync-path-protected");
    for (const suffix of ["", "-wal", "-shm", ".pid", ".writer.lock", ".writer.state"])
      paths.add(`${db}${suffix}`);
  }
  const roots = new Set([
    join(ctx.env.XDG_STATE_HOME ?? join(ctx.home, ".local", "state"), "catalyst", "events"),
    ...(ctx.env.CATALYST_EVENTS_DIR ? [ctx.env.CATALYST_EVENTS_DIR] : []),
    ...(machine?.paths.events ? [machine.paths.events] : []),
  ]);
  const entries = (dir: string): string[] => {
    try {
      if (!lstatSync(dir).isDirectory()) return [];
      return readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const cacheFiles = (dir: string) => {
    for (const name of entries(dir))
      if (/^\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/.test(name) || ["cursor.json", ".sync.writer.lock"].includes(name))
        paths.add(join(dir, name));
  };
  for (const root of roots) {
    cacheFiles(root);
    for (const account of entries(root)) {
      const dir = join(root, account);
      if (lstatSync(dir).isDirectory()) cacheFiles(join(dir, "backbone"));
    }
  }
  const files: LocalSyncFile[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`local sync cleanup requires a regular file: ${path}`);
    files.push({ kind: "data", name: path, path, localSync: true, size: stat.size, dev: stat.dev, ino: stat.ino });
  }
  return files;
}

export function localSyncInventory(files: readonly LocalSyncFile[]): string[] {
  return files.map((file) => `${file.path} (${file.size} bytes)`);
}

/** Stop the replica writer a pidfile or lock names. A pid that is gone, belongs to another user
 *  (EPERM: a writer this person started runs as them) or runs another command is a stale record
 *  left by a crash or reboot: no signal is sent, and cleanup goes on. */
async function stopWriter(pid: number): Promise<void> {
  if (pid === process.pid) throw new Error("refusing to stop the cleanup process as a replica writer");
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "EPERM") return false;
      throw error;
    }
  };
  if (!alive()) return;
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1000 });
  if (command.status !== 0 || !/(?:^|[/\s])catalyst(?:-skills)?(?:\.js)?\s+replica\s+start\b|(?:^|[/\s])catalyst-replica-sync(?:\s|$)/.test(command.stdout))
    return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (alive()) {
    if (Date.now() >= deadline) throw new Error(`replica writer ${pid} did not stop; local data kept`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Internal test seam for the production writer stop, without a process override. */
export const stopReplicaWriterForTest = stopWriter;

/** Wait for every detached writer before unlinking. Refuse a replacement file after approval. */
export async function removeLocalSyncData(
  files: readonly LocalSyncFile[],
  stop: (pid: number) => Promise<void> = stopWriter,
): Promise<void> {
  const pids = new Set<number>();
  const present = (file: LocalSyncFile) => {
    let current;
    try { current = lstatSync(file.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!current.isFile() || current.dev !== file.dev || current.ino !== file.ino)
      throw new Error(`local sync file changed after confirmation; kept: ${file.path}`);
    return true;
  };
  // Check the whole approved inventory before reading ownership evidence or sending a signal.
  for (const file of files) present(file);
  for (const file of files) {
    if (!present(file)) continue;
    let pid: unknown;
    if (file.path.endsWith(".pid")) pid = Number(readFileSync(file.path, "utf8").trim());
    else if (file.path.endsWith(".writer.lock")) pid = json(file.path).pid;
    if (Number.isSafeInteger(pid) && Number(pid) > 0) pids.add(Number(pid));
  }
  for (const pid of pids) await stop(pid);
  for (const file of files) present(file);
  for (const file of files) if (present(file)) unlinkSync(file.path);
}
