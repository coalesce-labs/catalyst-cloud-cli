// update-sdk.ts — a project's Catalyst SDK against the approved release (CTC-6708). The SDK is a
// dependency in the customer's own project, pinned by their lockfile, so a release check only
// reads it: the declared range, the lockfile's resolution and the installed package are read
// separately (a manifest range is never reported as the installed version), and the owner is given
// the one package-manager command that moves the project to the approved versions. This module
// writes nothing; every file it opens is read-only.
//
// Only train members the project already declares are named. Each uses its own approved version:
// the SDK and its replica modules may sit on different patches of one train.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The exact-version add command for the declared packages, keeping each package's dependency group. */
export function sdkUpdateCommand(dir: string, manager: PackageManager, packages: readonly SdkPackage[]): string | null {
  const moves = packages.filter((p) => p.approved !== null);
  if (moves.length === 0) return null;
  const byGroup = new Map<DependencyGroup, string[]>();
  for (const p of moves) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), `${p.name}@${p.approved}`]);
  const commands = [...byGroup].map(([group, specs]) => {
    const flags: Record<PackageManager, string[]> = {
      npm: ["install", "--save-exact", ...(group === "devDependencies" ? ["--save-dev"] : group === "optionalDependencies" ? ["--save-optional"] : [])],
      pnpm: ["add", "--save-exact", ...(group === "devDependencies" ? ["--save-dev"] : group === "optionalDependencies" ? ["--save-optional"] : [])],
      bun: ["add", "--exact", ...(group === "devDependencies" ? ["--dev"] : group === "optionalDependencies" ? ["--optional"] : [])],
      yarn: ["add", "--exact", ...(group === "devDependencies" ? ["--dev"] : group === "optionalDependencies" ? ["--optional"] : [])],
    };
    return [manager, ...flags[manager], ...specs].join(" ");
  });
  return `cd ${quote(dir)} && ${commands.join(" && ")}`;
}

/** Read one project's SDK packages against `release` (null when no approved record is usable). */
export function inspectSdkProject(dir: string, release: ApprovedRelease | null): SdkProject {
  const base = { path: dir, packageManager: null, packages: [], command: null } satisfies Partial<SdkProject>;
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
    return { ...project, status: "update_available", reason: "behind_approved", command: sdkUpdateCommand(dir, detected.manager, packages) };
  if (pairs.some((v) => compareVersions(v.current, v.approved) > 0)) return { ...project, status: "installed_newer", reason: "installed_newer" };
  return { ...project, status: "current", reason: "current" };
}
