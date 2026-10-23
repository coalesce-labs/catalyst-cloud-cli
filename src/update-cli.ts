// update-cli.ts — the CLI moves itself to the approved version (CTC-6708). A release check never
// replaces the code under the process doing the update: it installs the approved CLI into its own
// directory under ~/.config/catalyst-cloud/cli-runtimes/cli-<version>, checks the package name,
// the version and that `--version` answers from it, and only then switches one small record
// (active.json) to it. The person's own `catalyst` command stays where it is: its launcher
// (bin/launch.js) reads that record and runs the selected version, so npm's bins, scheduled jobs and
// the saved launcher path never move.
//
// A failed install, a wrong package or a version that does not answer leaves the record as it was,
// so the CLI that was running stays the one that runs. Earlier versions' directories are kept: a
// replica still running on one keeps its code until it restarts.
//
// The launcher only ever moves forward. A record naming a version at or below the launcher's own
// (an owner who reinstalled a newer CLI by hand, say) is ignored, and so is any record whose
// directory is not this install's own runtime directory for that version.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configDirFor, PACKAGE_NAME } from "./config.js";

// bin/launch.js imports this module before dist/cli.js, on runtimes too old to load the rest of the
// CLI, so it imports only config.js and node built-ins. These three mirror approved-release.ts's.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactVersion = (v: unknown): string | null => (typeof v === "string" && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(v) ? v : null);
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Set to a bin's own path, that bin's launcher runs itself and never selects (the staged check). */
export const ACTIVE_RUNTIME_ENV = "CATALYST_CLI_ACTIVE_RUNTIME";

export function cliRuntimesDirFor(home: string): string {
  return join(configDirFor(home), "cli-runtimes");
}
export function activeRuntimePathFor(home: string): string {
  return join(cliRuntimesDirFor(home), "active.json");
}
/** The one directory a given version may live in: a record naming any other path is refused. */
export function runtimeRootFor(home: string, version: string): string {
  return join(cliRuntimesDirFor(home), `cli-${version}`);
}
const packageDir = (root: string) => join(root, "node_modules", ...PACKAGE_NAME.split("/"));

export interface ActiveRuntime {
  version: 1;
  cliVersion: string;
  root: string;
  activatedAtMs: number;
  previous: { cliVersion: string; root: string } | null;
}

export function readActiveRuntime(home: string): ActiveRuntime | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(activeRuntimePathFor(home), "utf8"));
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.root !== "string" || typeof raw.activatedAtMs !== "number") return null;
    const cliVersion = exactVersion(raw.cliVersion);
    if (cliVersion === null || raw.root !== runtimeRootFor(home, cliVersion)) return null;
    const prev = raw.previous;
    const previous =
      isRecord(prev) && typeof prev.root === "string" && exactVersion(prev.cliVersion) !== null
        ? { cliVersion: String(prev.cliVersion), root: prev.root }
        : null;
    return { version: 1, cliVersion, root: raw.root, activatedAtMs: raw.activatedAtMs, previous };
  } catch {
    return null;
  }
}

/** The installed CLI's version in `root`, when its package is the CLI and its directory is private. */
function runtimeVersionAt(root: string): string | null {
  try {
    // A directory others can write to could have its code swapped: never run from one.
    if ((statSync(root).mode & 0o022) !== 0) return null;
    const manifest: unknown = JSON.parse(readFileSync(join(packageDir(root), "package.json"), "utf8"));
    if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME) return null;
    return exactVersion(manifest.version);
  } catch {
    return null;
  }
}

/**
 * The bin the launcher should run instead of its own code, or null to run its own: no record, a
 * record outside this install's runtime directory, a version not newer than `ownVersion`, or a
 * directory whose package does not match the record.
 */
export function activeRuntimeBin(home: string, ownVersion: string, binFile = "catalyst.js"): string | null {
  const active = readActiveRuntime(home);
  const own = exactVersion(ownVersion);
  if (active === null || own === null || compareVersions(active.cliVersion, own) <= 0) return null;
  if (runtimeVersionAt(active.root) !== active.cliVersion) return null;
  // The same bin file the person ran (bin/launch.js passes its own name), so a deprecated name keeps its notice.
  const bin = join(packageDir(active.root), "bin", basename(binFile));
  return existsSync(bin) ? bin : null;
}

/** Runs one command by argv in `cwd`. Tests pass a fake for npm. */
export type CliExec = (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };

export const spawnCliCommand: CliExec = (argv, cwd, env) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return { status: 1, stdout: "", stderr: "no command" };
  const run = spawnSync(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10 * 60_000 });
  return { status: run.error ? 1 : run.status, stdout: run.stdout ?? "", stderr: run.error ? run.error.message : (run.stderr ?? "") };
};

export interface CliApplyResult {
  outcome: "updated" | "current" | "failed";
  /** What it did, or why it failed: `target_invalid`, `install_failed`, `package_mismatch`, `smoke_failed`, `activate_failed`. */
  detail: string;
  /** The version the stable `catalyst` command runs after this call. */
  version: string;
}

export interface CliApplyDeps {
  exec?: CliExec;
  /** The runtime that runs the installed CLI for its `--version` check. */
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Install exact `version` of the CLI into its own directory and check it, without selecting it:
 * its package name and version, and that its `--version` answers with that version. An already
 * checked directory is reused. The skills pack update reads its bundled skills from here too.
 */
export function stageCliRuntime(home: string, version: string, deps: CliApplyDeps = {}): { ok: true; root: string } | { ok: false; detail: string } {
  if (exactVersion(version) === null) return { ok: false, detail: "target_invalid" };
  const dir = cliRuntimesDirFor(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = runtimeRootFor(home, version);
  if (runtimeVersionAt(root) === version) return { ok: true, root };
  // One staging at a time: another release check could otherwise remove the directory this one just
  // put in place, while processes run from it.
  const lock = join(dir, ".staging.lock");
  if (!takeLock(lock)) return { ok: false, detail: "update_running" };
  try {
    return stageLocked(dir, root, version, deps);
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // released already
    }
  }
}

/** Longer than npm's own timeout, so a live staging's lock is never taken over. */
const STAGING_LOCK_STALE_MS = 15 * 60_000;

function takeLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      return true;
    } catch {
      // A run killed mid-install leaves its lock behind; past the stale age it is taken over.
      try {
        if (Date.now() - statSync(path).mtimeMs <= STAGING_LOCK_STALE_MS) return false;
        unlinkSync(path);
      } catch {
        // gone already: try again
      }
    }
  }
  return false;
}

function stageLocked(dir: string, root: string, version: string, deps: CliApplyDeps): { ok: true; root: string } | { ok: false; detail: string } {
  const exec = deps.exec ?? spawnCliCommand;
  const env = deps.env ?? process.env;
  // Another check may have finished it while this one waited for the lock.
  if (runtimeVersionAt(root) === version) return { ok: true, root };
  const staging = join(dir, `.staging-cli-${version}-${process.pid}-${Date.now()}`);
  const fail = (detail: string) => {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false as const, detail };
  };
  mkdirSync(staging, { mode: 0o700 });
  // An exact version of the one CLI package: never a tag or range, never a global install.
  const install = exec(["npm", "install", "--prefix", staging, "--no-save", "--no-audit", "--no-fund", "--omit=dev", `${PACKAGE_NAME}@${version}`], staging, env);
  if (install.status !== 0) return fail("install_failed");
  if (runtimeVersionAt(staging) !== version) return fail("package_mismatch");
  const stagedBin = join(packageDir(staging), "bin", "catalyst.js");
  const smoke = exec([deps.nodePath ?? process.execPath, stagedBin, "--version"], staging, { ...env, [ACTIVE_RUNTIME_ENV]: stagedBin });
  if (smoke.status !== 0 || !smoke.stdout.split(/\s+/).includes(version)) return fail("smoke_failed");
  try {
    rmSync(root, { recursive: true, force: true });
    renameSync(staging, root);
  } catch {
    return fail("activate_failed");
  }
  return { ok: true, root };
}

/** The skills a staged CLI package bundles. */
export const stagedSkillsDir = (root: string) => join(packageDir(root), "skills");

/** Install `target` of the CLI beside the running one, check it answers, then select it. */
export function applyCliUpdate(home: string, ownVersion: string, target: string, deps: CliApplyDeps = {}): CliApplyResult {
  const version = exactVersion(target);
  const before = readActiveRuntime(home);
  const running = before && activeRuntimeBin(home, ownVersion) !== null ? before.cliVersion : ownVersion;
  if (version === null) return { outcome: "failed", detail: "target_invalid", version: running };
  // Never a move down: a CLI already past the target keeps running.
  if (compareVersions(running, version) >= 0)
    return { outcome: "current", detail: compareVersions(running, version) === 0 ? "current" : "installed_newer", version: running };

  const staged = stageCliRuntime(home, version, deps);
  if (!staged.ok) return { outcome: "failed", detail: staged.detail, version: running };
  const root = staged.root;

  const record: ActiveRuntime = {
    version: 1,
    cliVersion: version,
    root,
    activatedAtMs: (deps.now ?? Date.now)(),
    previous: before ? { cliVersion: before.cliVersion, root: before.root } : null,
  };
  const path = activeRuntimePathFor(home);
  const priorBytes = existsSync(path) ? readFileSync(path) : null;
  const write = (bytes: string | Buffer) => {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch {
      rmSync(tmp, { force: true });
      return false;
    }
  };
  if (!write(`${JSON.stringify(record, null, 2)}\n`)) return { outcome: "failed", detail: "activate_failed", version: running };
  // Read back what the stable command will now run; put the earlier record back if it is not this one.
  if (compareVersions(version, ownVersion) > 0 && activeRuntimeBin(home, ownVersion) === null) {
    if (priorBytes === null) rmSync(path, { force: true });
    else write(priorBytes);
    return { outcome: "failed", detail: "activate_failed", version: running };
  }
  return { outcome: "updated", detail: "activated", version };
}
