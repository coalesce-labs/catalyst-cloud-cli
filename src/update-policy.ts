// update-policy.ts — which installed components update by themselves (CTC-6708). Every component
// updates by default; an owner turns one off only with an explicit setting, kept in
// ~/.config/catalyst-cloud/updates.json (mode 0600, apart from the sign-in record). An absent entry
// means on, so only explicit or migrated choices are stored.
//
// A project's SDK is the one exception: Catalyst never edits a customer's repository unasked, so a
// registered project is notify-only until its owner turns its SDK updates on. Project paths are kept
// by their real path and the root's device and inode, so a later symlink or moved directory cannot
// redirect an opt-in to a different repository.
//
// Writes take a short exclusive lock and replace the file by rename, so two setting changes at once
// never lose one of them and a reader never sees half a file.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configDirFor } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { isRecord, writePrivateAtomic } from "./runner-update.js";
import { isTimeZone, normalizeWindowTimes, type UpdateWindows } from "./update-windows.js";

export const UPDATE_POLICY_FILE = "updates.json";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

/** The installed components a release check keeps current. The SDK is per project, not here. */
export const UPDATE_COMPONENTS = ["runner", "supervisor", "watchdog", "cli", "skills-cloud", "skills-dev", "replica"] as const;
export type UpdateComponent = (typeof UPDATE_COMPONENTS)[number];

export type PolicySource = "default" | "owner" | "migrated";

export interface ComponentPolicy {
  enabled: boolean;
  source: Exclude<PolicySource, "default">;
}

export interface ProjectPolicy {
  /** The project's real path. */
  path: string;
  /** `notify` reports and offers the command; `auto` lets release checks update its package files. */
  sdk: "notify" | "auto";
  source: Exclude<PolicySource, "default">;
  /** The root's identity when it was registered; a different directory at the path is refused. */
  dev: number;
  ino: number;
}

export interface UpdatePolicy {
  version: 1;
  components: Partial<Record<UpdateComponent, ComponentPolicy>>;
  projects: ProjectPolicy[];
  /** The owner's update windows; absent means the defaults (update-windows.ts). */
  windows?: UpdateWindows;
}

export interface EffectivePolicy {
  enabled: boolean;
  source: PolicySource;
}

export function updatePolicyPathFor(home: string): string {
  return join(configDirFor(home), UPDATE_POLICY_FILE);
}

const emptyPolicy = (): UpdatePolicy => ({ version: 1, components: {}, projects: [] });

export function isUpdateComponent(value: string): value is UpdateComponent {
  return (UPDATE_COMPONENTS as readonly string[]).includes(value);
}

/** Read the saved preferences. A missing file is the default (everything on). A file that is not a
 *  valid record is an error, never silently "everything on": that would undo an owner's hold. */
export function readUpdatePolicy(home: string): UpdatePolicy {
  const path = updatePolicyPathFor(home);
  if (!existsSync(path)) return emptyPolicy();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`update settings at ${path} are not valid JSON; fix or remove the file`, "update-policy-corrupt", 1);
  }
  const policy = parsePolicy(parsed);
  if (!policy) throw new CliError(`update settings at ${path} are not a settings record this CLI can read; fix or remove the file`, "update-policy-corrupt", 1);
  return policy;
}

function parsePolicy(input: unknown): UpdatePolicy | null {
  if (!isRecord(input) || input.version !== 1) return null;
  const policy = emptyPolicy();
  if (input.components !== undefined) {
    if (!isRecord(input.components)) return null;
    for (const [name, value] of Object.entries(input.components)) {
      if (!isUpdateComponent(name)) return null;
      if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
      if (value.source !== "owner" && value.source !== "migrated") return null;
      policy.components[name] = { enabled: value.enabled, source: value.source };
    }
  }
  if (input.projects !== undefined) {
    if (!Array.isArray(input.projects)) return null;
    for (const value of input.projects) {
      if (!isRecord(value) || typeof value.path !== "string" || !isAbsolute(value.path)) return null;
      if (value.sdk !== "notify" && value.sdk !== "auto") return null;
      if (value.source !== "owner" && value.source !== "migrated") return null;
      if (typeof value.dev !== "number" || typeof value.ino !== "number") return null;
      policy.projects.push({ path: value.path, sdk: value.sdk, source: value.source, dev: value.dev, ino: value.ino });
    }
  }
  if (input.windows !== undefined) {
    if (!isRecord(input.windows) || !Array.isArray(input.windows.times)) return null;
    const times = input.windows.times.every((t): t is string => typeof t === "string") ? normalizeWindowTimes(input.windows.times) : null;
    const zone = input.windows.timeZone;
    if (times === null || !(zone === null || (typeof zone === "string" && isTimeZone(zone)))) return null;
    policy.windows = { times, timeZone: zone };
  }
  return policy;
}

/** The components an installer's daily update kept current: the CLI and both skills packs. */
export const DAILY_UPDATE_COMPONENTS = ["cli", "skills-cloud", "skills-dev"] as const satisfies readonly UpdateComponent[];

/**
 * An owner who turned the installer's daily update off chose not to have the CLI and the skills
 * packs moved for them. Until they save a setting of their own for one of those, it reads as held,
 * with source `migrated`. A saved setting always wins, and nothing is written, so a check stays
 * read-only and a later `update policy … on` lifts it. A missing record is no evidence: no hold.
 */
export function withMigratedHolds(policy: UpdatePolicy, dailyUpdateOff: boolean): UpdatePolicy {
  if (!dailyUpdateOff) return policy;
  const components = { ...policy.components };
  for (const id of DAILY_UPDATE_COMPONENTS) components[id] ??= { enabled: false, source: "migrated" };
  return { ...policy, components };
}

export function effectivePolicy(policy: UpdatePolicy, component: UpdateComponent): EffectivePolicy {
  const saved = policy.components[component];
  return saved ? { enabled: saved.enabled, source: saved.source } : { enabled: true, source: "default" };
}

/** A project path as the policy stores it: absolute, real, and a directory. */
export function canonicalProject(path: string): { path: string; dev: number; ino: number } {
  if (!isAbsolute(path)) throw new UsageError("--project must be an absolute path");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new CliError(`no project at ${path}`, "project-missing", 1);
  }
  const stat = statSync(real);
  if (!stat.isDirectory()) throw new CliError(`${path} is not a directory`, "project-missing", 1);
  return { path: real, dev: stat.dev, ino: stat.ino };
}

/** Whether a registered project is still the directory its owner registered. */
export function projectIdentityHolds(project: ProjectPolicy): boolean {
  try {
    if (realpathSync(project.path) !== project.path) return false;
    const stat = statSync(project.path);
    return stat.isDirectory() && stat.dev === project.dev && stat.ino === project.ino;
  } catch {
    return false;
  }
}

function takePolicyLock(lockPath: string, nowMs: () => number): void {
  const deadline = nowMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    try {
      if (nowMs() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
    } catch {
      // gone already: try again
    }
    if (nowMs() > deadline) throw new CliError("another command is changing the update settings; try again", "update-policy-busy", 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/** Change the saved preferences under the lock: read the current file, apply `change`, replace it. */
export function updateUpdatePolicy(home: string, change: (policy: UpdatePolicy) => void, nowMs: () => number = Date.now): UpdatePolicy {
  const dir = configDirFor(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = updatePolicyPathFor(home);
  const lockPath = `${path}.lock`;
  takePolicyLock(lockPath, nowMs);
  try {
    const policy = readUpdatePolicy(home);
    change(policy);
    writePrivateAtomic(path, `${JSON.stringify(policy, null, 2)}\n`);
    return policy;
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already released
    }
  }
}

export function setComponentPolicy(home: string, component: UpdateComponent, enabled: boolean): UpdatePolicy {
  return updateUpdatePolicy(home, (policy) => {
    policy.components[component] = { enabled, source: "owner" };
  });
}

/** Register a project (or change its SDK setting). The stored path is the real path. */
export function setProjectSdkPolicy(home: string, path: string, sdk: ProjectPolicy["sdk"]): ProjectPolicy {
  const project = canonicalProject(path);
  let saved: ProjectPolicy | null = null;
  updateUpdatePolicy(home, (policy) => {
    const entry: ProjectPolicy = { ...project, sdk, source: "owner" };
    const at = policy.projects.findIndex((p) => p.path === project.path);
    if (at === -1) policy.projects.push(entry);
    else policy.projects[at] = entry;
    saved = entry;
  });
  return saved ?? { ...project, sdk, source: "owner" };
}

/** Save the owner's update windows, or go back to the defaults with null. */
export function setWindowPolicy(home: string, windows: UpdateWindows | null): UpdatePolicy {
  return updateUpdatePolicy(home, (policy) => {
    if (windows === null) delete policy.windows;
    else policy.windows = windows;
  });
}
