// update-sdk.ts — a project's Catalyst SDK against the approved release (CTC-6708). The SDK is a
// dependency in the customer's own project, pinned by their lockfile, so a release check only
// reads it: the declared range, the lockfile's resolution and the installed package are read
// separately (a manifest range is never reported as the installed version), and the owner is given
// the one command that moves the project to the approved versions. Reading writes nothing.
//
// The project's files change only through `applySdkUpdate`: when its owner runs
// `catalyst update sdk --project <path>`, or has turned automatic SDK updates on for that project.
// It runs the project's own package manager by argv (never a shell, never a full upgrade) with
// exact versions in the dependency group each package already sits in, holds a per-project lock,
// keeps the package files' bytes, puts them back if the install fails, and reads the result back
// before calling it updated.
//
// Only train members the project already declares are named. Each uses its own approved version:
// the SDK and its replica modules may sit on different patches of one train.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDirFor } from "./config.js";
import { compareVersions, exactVersion, type ApprovedRelease, type ReleaseMember } from "./approved-release.js";
import { isRecord } from "./runner-update.js";

export const SDK_PACKAGES: Readonly<Record<string, ReleaseMember>> = {
  "@catalyst-cloud/sdk": "sdk",
  "@catalyst-cloud/sdk-replica-node": "sdk-replica-node",
  "@catalyst-cloud/sdk-replica-browser": "sdk-replica-browser",
};

export type PackageManager = "npm" | "pnpm" | "bun" | "yarn";
const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  bun: ["bun.lock", "bun.lockb"],
  yarn: ["yarn.lock"],
};
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type DependencyGroup = (typeof GROUPS)[number];

export interface SdkPackage {
  name: string;
  group: DependencyGroup;
  /** The range or version package.json declares. */
  declared: string;
  /** The lockfile's resolution, when this CLI reads that lockfile format. */
  locked: string | null;
  /** node_modules/<name>/package.json's version, when installed. */
  installed: string | null;
  approved: string | null;
}

export type SdkProjectStatus = "current" | "update_available" | "installed_newer" | "approval_unavailable" | "no_sdk" | "unknown";

export interface SdkProject {
  path: string;
  /** null when the project names no manager and has no single lockfile. */
  packageManager: PackageManager | null;
  packages: SdkPackage[];
  status: SdkProjectStatus;
  reason: string;
  /** The one command that moves the project to the approved versions, or null. */
  command: string | null;
  /** The package manager invocation that command runs, for a person who prefers to run it directly. */
  packageManagerCommand: string | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The manager the project declares, else the single one whose lockfile is present. Two lockfiles
 *  and no declaration is ambiguous: the report says so instead of picking the first one found. */
export function detectPackageManager(dir: string, manifest: Record<string, unknown>): { manager: PackageManager | null; reason: string | null } {
  const present = (Object.keys(LOCKFILES) as PackageManager[]).filter((m) => LOCKFILES[m].some((f) => existsSync(join(dir, f))));
  if (typeof manifest.packageManager === "string") {
    const name = manifest.packageManager.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "bun" || name === "yarn") {
      if (present.length > 0 && !present.includes(name)) return { manager: null, reason: "lockfile_mismatch" };
      return { manager: name, reason: null };
    }
    return { manager: null, reason: "package_manager_unsupported" };
  }
  if (present.length === 1) return { manager: present[0] ?? null, reason: null };
  if (present.length > 1) return { manager: null, reason: "package_manager_ambiguous" };
  return { manager: "npm", reason: null };
}

function npmLocked(dir: string, name: string): string | null {
  for (const file of LOCKFILES.npm) {
    const lock = readJson(join(dir, file));
    if (!isRecord(lock) || !isRecord(lock.packages)) continue;
    const entry = lock.packages[`node_modules/${name}`];
    if (isRecord(entry)) return exactVersion(entry.version);
  }
  return null;
}

function installedVersion(dir: string, name: string): string | null {
  const manifest = readJson(join(dir, "node_modules", ...name.split("/"), "package.json"));
  return isRecord(manifest) ? exactVersion(manifest.version) : null;
}

const quote = (value: string) => (/^[A-Za-z0-9_./@:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/** The exact-version add invocations for the declared packages, one per dependency group, so each
 *  package stays in the group it is already in. Every spec is a known package at an exact version. */
export function sdkUpdateArgv(manager: PackageManager, packages: readonly SdkPackage[]): string[][] {
  const byGroup = new Map<DependencyGroup, string[]>();
  for (const p of packages) if (p.approved !== null) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), `${p.name}@${p.approved}`]);
  return [...byGroup].map(([group, specs]) => {
    const flags: Record<PackageManager, string[]> = {
      npm: ["install", "--save-exact", ...(group === "devDependencies" ? ["--save-dev"] : group === "optionalDependencies" ? ["--save-optional"] : [])],
      pnpm: ["add", "--save-exact", ...(group === "devDependencies" ? ["--save-dev"] : group === "optionalDependencies" ? ["--save-optional"] : [])],
      bun: ["add", "--exact", ...(group === "devDependencies" ? ["--dev"] : group === "optionalDependencies" ? ["--optional"] : [])],
      yarn: ["add", "--exact", ...(group === "devDependencies" ? ["--dev"] : group === "optionalDependencies" ? ["--optional"] : [])],
    };
    return [manager, ...flags[manager], ...specs];
  });
}

/** The same move as one command a person can paste. */
export function sdkUpdateCommand(dir: string, manager: PackageManager, packages: readonly SdkPackage[]): string | null {
  const argv = sdkUpdateArgv(manager, packages);
  if (argv.length === 0) return null;
  return `cd ${quote(dir)} && ${argv.map((a) => a.map(quote).join(" ")).join(" && ")}`;
}

/** What `catalyst update sdk` tells the owner to run: this CLI's own explicit, one-project update. */
export function catalystSdkCommand(dir: string): string {
  return `catalyst update sdk --project ${quote(dir)}`;
}

/** Read one project's SDK packages against `release` (null when no approved record is usable). */
export function inspectSdkProject(dir: string, release: ApprovedRelease | null): SdkProject {
  const base = { path: dir, packageManager: null, packages: [], command: null, packageManagerCommand: null } satisfies Partial<SdkProject>;
  const manifest = readJson(join(dir, "package.json"));
  if (!isRecord(manifest)) return { ...base, status: "unknown", reason: "package_json_unreadable" };
  const packages: SdkPackage[] = [];
  for (const [name, member] of Object.entries(SDK_PACKAGES)) {
    for (const group of GROUPS) {
      const deps = manifest[group];
      if (!isRecord(deps) || typeof deps[name] !== "string") continue;
      packages.push({
        name,
        group,
        declared: deps[name],
        locked: null,
        installed: installedVersion(dir, name),
        approved: release?.members[member] ?? null,
      });
      break;
    }
  }
  if (packages.length === 0) return { ...base, status: "no_sdk", reason: "no_sdk" };
  const detected = detectPackageManager(dir, manifest);
  if (detected.manager === "npm") for (const p of packages) p.locked = npmLocked(dir, p.name);
  const project = { ...base, packageManager: detected.manager, packages };
  if (release === null) return { ...project, status: "approval_unavailable", reason: "approval_unavailable" };
  if (detected.manager === null) return { ...project, status: "unknown", reason: detected.reason ?? "package_manager_ambiguous" };
  // What runs is what node_modules holds; else what the lockfile resolves; else an exact declaration.
  const pairs: { current: string; approved: string }[] = [];
  for (const p of packages) {
    if (p.approved === null) return { ...project, status: "approval_unavailable", reason: "approval_unavailable" };
    const current = p.installed ?? p.locked ?? exactVersion(p.declared);
    if (current === null) return { ...project, status: "unknown", reason: "installed_version_unknown" };
    pairs.push({ current, approved: p.approved });
  }
  if (pairs.some((v) => compareVersions(v.current, v.approved) < 0))
    return {
      ...project,
      status: "update_available",
      reason: "behind_approved",
      command: catalystSdkCommand(dir),
      packageManagerCommand: sdkUpdateCommand(dir, detected.manager, packages),
    };
  if (pairs.some((v) => compareVersions(v.current, v.approved) > 0)) return { ...project, status: "installed_newer", reason: "installed_newer" };
  return { ...project, status: "current", reason: "current" };
}

/** Runs one package-manager invocation in `cwd`, by argv. Tests pass a fake. */
export type SdkExec = (argv: readonly string[], cwd: string) => { status: number | null; stderr: string };

export const spawnPackageManager: SdkExec = (argv, cwd) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return { status: 1, stderr: "no command" };
  const run = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10 * 60_000 });
  return { status: run.error ? 1 : run.status, stderr: run.error ? run.error.message : (run.stderr ?? "") };
};

export interface SdkApplyResult {
  outcome: "updated" | "current" | "refused" | "failed";
  /** A reason code: why it was refused or failed, or what it did. */
  detail: string;
  /** Each moved package's version before and after. */
  moved: { name: string; from: string; to: string }[];
  project: SdkProject;
}

/** The package files a manager rewrites: the manifest and every lockfile present. */
function packageFiles(dir: string): string[] {
  return ["package.json", ...Object.values(LOCKFILES).flat()].filter((f) => existsSync(join(dir, f)));
}

function takeProjectLock(home: string, dir: string): string | null {
  const locks = join(configDirFor(home), "sdk-update-locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const path = join(locks, `${createHash("sha256").update(dir).digest("hex").slice(0, 32)}.lock`);
  try {
    closeSync(openSync(path, "wx", 0o600));
    return path;
  } catch {
    return null;
  }
}

/** Move one project's declared SDK packages to their approved versions with its own manager. */
export function applySdkUpdate(home: string, dir: string, release: ApprovedRelease, exec: SdkExec = spawnPackageManager): SdkApplyResult {
  const project = inspectSdkProject(dir, release);
  if (project.status === "current") return { outcome: "current", detail: "current", moved: [], project };
  if (project.status !== "update_available" || project.packageManager === null)
    return { outcome: "refused", detail: project.reason, moved: [], project };
  const manager = project.packageManager;
  const lock = takeProjectLock(home, dir);
  if (lock === null) return { outcome: "refused", detail: "update_running", moved: [], project };
  try {
    const kept = new Map(packageFiles(dir).map((f) => [f, readFileSync(join(dir, f))]));
    const failed = (detail: string): SdkApplyResult => {
      // Put back only files that still differ from what this run kept; nothing else is touched.
      for (const [file, bytes] of kept) {
        const path = join(dir, file);
        const now = existsSync(path) ? readFileSync(path) : null;
        if (now === null || !now.equals(bytes)) writeFileSync(path, bytes);
      }
      return { outcome: "failed", detail, moved: [], project: inspectSdkProject(dir, release) };
    };
    for (const argv of sdkUpdateArgv(manager, project.packages)) {
      const run = exec(argv, dir);
      if (run.status !== 0) return failed("package_manager_failed");
    }
    const after = inspectSdkProject(dir, release);
    const moved: SdkApplyResult["moved"] = [];
    for (const p of after.packages) {
      const before = project.packages.find((q) => q.name === p.name);
      const now = p.installed ?? p.locked;
      if (now === null || p.approved === null || compareVersions(now, p.approved) !== 0) return failed("verify_failed");
      moved.push({ name: p.name, from: before?.installed ?? before?.locked ?? before?.declared ?? "unknown", to: now });
    }
    return { outcome: "updated", detail: manager, moved, project: after };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // released already
    }
  }
}
