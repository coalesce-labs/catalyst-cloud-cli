// Read-only ownership discovery. A stamp or npx lock is an adoption candidate, not proof.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { exactVersion } from "./approved-release.js";
import { configDirFor } from "./config.js";
import { installedBundleVersion } from "./skills.js";
import { contentDigest, record, repositoryFor, safeName, type SkillPack } from "./update-skill-source.js";

export interface SkillDestination {
  name: string;
  path: string;
  links: string[];
  digest: string;
  skillPath: string;
  lockHash?: string;
}
export interface SkillReceipt {
  pack: SkillPack;
  repository: string;
  commit: string;
  version: string;
  kind: "legacy" | "npx";
  dir: string;
  destinations: SkillDestination[];
  lockPath?: string;
}
export interface SkillInstallation {
  present: boolean;
  candidate: boolean;
  commit: string | null;
  version: string | null;
  kind: "legacy" | "npx" | "unknown";
  reason: string;
  destinations: SkillDestination[];
  receipt?: SkillReceipt;
  lockPath?: string;
}
const receiptsPath = (home: string) => join(configDirFor(home), "skill-installations.json");
export const skillLockPath = (home: string, env: NodeJS.ProcessEnv): string => env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "skills/.skill-lock.json") : join(home, ".agents/.skill-lock.json");
const canonicalDir = (home: string) => join(home, ".agents/skills");
const unknown = (present: boolean, reason = "installation_owner_unknown"): SkillInstallation => ({ present, candidate: false, commit: null, version: null, kind: "unknown", reason, destinations: [] });

/** Reject linked ancestors too, so a receipt cannot authorize writes through a changed root. */
export function plainDirectory(path: string): boolean {
  try { return isAbsolute(path) && realpathSync(path) === resolve(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); }
  catch { return false; }
}
export function destinationMatches(destination: SkillDestination): boolean {
  try {
    return plainDirectory(destination.path) && contentDigest(destination.path) === destination.digest && destination.links.every((link) => lstatSync(link).isSymbolicLink() && realpathSync(link) === destination.path);
  } catch { return false; }
}

function parseReceipt(value: unknown, home: string, pack: SkillPack, dir: string, env: NodeJS.ProcessEnv): SkillReceipt | null {
  if (!record(value) || value.pack !== pack || value.repository !== repositoryFor(pack) || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit) || exactVersion(value.version) === null || value.dir !== dir || (value.kind !== "legacy" && value.kind !== "npx") || !Array.isArray(value.destinations)) return null;
  if (value.kind === "npx" && value.lockPath !== skillLockPath(home, env)) return null;
  const destinations: SkillDestination[] = [];
  for (const d of value.destinations) {
    if (!record(d) || typeof d.name !== "string" || !safeName(d.name) || d.path !== join(value.kind === "npx" ? canonicalDir(home) : dir, d.name) || typeof d.digest !== "string" || !/^[a-f0-9]{64}$/.test(d.digest) || d.skillPath !== `skills/${d.name}` || !Array.isArray(d.links) || !d.links.every((link): link is string => typeof link === "string" && agentDirs(home, dir).some((root) => link === join(root, String(d.name))))) return null;
    if (destinations.some((old) => old.name === d.name)) return null;
    if (value.kind === "npx" && (typeof d.lockHash !== "string" || !/^[a-f0-9]{40}$/.test(d.lockHash))) return null;
    destinations.push({ name: d.name, path: String(d.path), digest: d.digest, skillPath: String(d.skillPath), links: d.links, ...(typeof d.lockHash === "string" ? { lockHash: d.lockHash } : {}) });
  }
  return { pack, repository: repositoryFor(pack), commit: value.commit, version: String(value.version), kind: value.kind, dir, destinations, ...(value.kind === "npx" ? { lockPath: String(value.lockPath) } : {}) };
}

function agentDirs(home: string, selected: string): string[] {
  return [...new Set([selected, ...[".claude", ".codex", ".cursor", ".opencode", ".config/opencode"].map((agent) => join(home, agent, "skills"))])];
}

export function readSkillLock(path: string): { version: 3; skills: Record<string, unknown>; [key: string]: unknown } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return record(raw) && raw.version === 3 && record(raw.skills) ? { ...raw, version: 3, skills: raw.skills } : null;
  } catch { return null; }
}

export function inspectSkillInstallation(home: string, env: NodeJS.ProcessEnv, pack: SkillPack, dir: string): SkillInstallation {
  const transaction = join(configDirFor(home), ".skill-transaction.json");
  if (existsSync(transaction)) {
    try {
      const pending: unknown = JSON.parse(readFileSync(transaction, "utf8"));
      if (record(pending) && pending.pack === pack && pending.dir === dir)
        return { ...unknown(true, "update_interrupted"), candidate: true };
    } catch { return unknown(true, "recovery_failed"); }
  }
  const receiptPath = receiptsPath(home);
  if (existsSync(receiptPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (!record(raw) || raw.version !== 1 || !record(raw.packs)) return unknown(true, "source_mismatch");
      if (raw.packs[pack] !== undefined) {
        const receipt = parseReceipt(raw.packs[pack], home, pack, dir, env);
        if (!receipt) return unknown(true, "source_mismatch");
        if (receipt.lockPath) {
          const lock = readSkillLock(receipt.lockPath);
          if (!lock || !receipt.destinations.every((destination) => {
            const entry = lock.skills[destination.name];
            return record(entry) && entry.source === receipt.repository && entry.sourceType === "github" && entry.skillPath === destination.skillPath && entry.ref === receipt.commit && entry.skillFolderHash === destination.lockHash;
          })) return { ...unknown(true, "source_mismatch"), receipt, destinations: receipt.destinations, lockPath: receipt.lockPath };
        }
        const valid = receipt.destinations.every(destinationMatches);
        // An empty receipt records removal of the last owned, retired name.
        return { present: receipt.destinations.length > 0, candidate: valid, commit: valid ? receipt.commit : null, version: receipt.version, kind: receipt.kind, reason: valid ? "verified" : "local_changes", destinations: receipt.destinations, receipt, lockPath: receipt.lockPath };
      }
    } catch { return unknown(true, "source_mismatch"); }
  }
  const lockPath = skillLockPath(home, env);
  const lock = readSkillLock(lockPath);
  const owned = Object.entries(lock?.skills ?? {}).filter(([, entry]) => record(entry) && entry.source === repositoryFor(pack));
  if (owned.length > 0) {
    const destinations: SkillDestination[] = [];
    for (const [name, entry] of owned) {
      if (!safeName(name) || !record(entry) || entry.sourceType !== "github" || entry.skillPath !== `skills/${name}` || typeof entry.skillFolderHash !== "string" || !/^[a-f0-9]{40}$/.test(entry.skillFolderHash)) return unknown(true);
      const path = join(canonicalDir(home), name);
      if (!existsSync(path)) continue;
      if (!plainDirectory(path)) return unknown(true);
      try {
        const links = agentDirs(home, dir).map((root) => join(root, name)).filter((link) => {
          try { return lstatSync(link).isSymbolicLink() && realpathSync(link) === path; } catch { return false; }
        });
        destinations.push({ name, path, links, digest: contentDigest(path), skillPath: `skills/${name}`, lockHash: entry.skillFolderHash });
      } catch { return unknown(true, "local_changes"); }
    }
    return { present: destinations.length > 0, candidate: true, commit: null, version: null, kind: "npx", reason: "commit_unrecorded", destinations, lockPath };
  }
  let names: string[] = [];
  try { names = readdirSync(dir).filter(safeName); } catch { return unknown(false); }
  const legacy: SkillDestination[] = [];
  let version: string | null = null;
  if (pack === "cloud") {
    for (const name of names) {
      const found = installedBundleVersion(dir, [name]);
      if (found.version === null && found.unstamped.length === 0) continue;
      // Contradictory global evidence must not fall back to a provenance stamp.
      if (lock?.skills[name] !== undefined || !plainDirectory(join(dir, name)) || found.version === null) return unknown(true);
      if (version !== null && version !== found.version) return unknown(true);
      version = found.version;
      try { legacy.push({ name, path: join(dir, name), links: [], digest: contentDigest(join(dir, name)), skillPath: `skills/${name}` }); }
      catch { return unknown(true, "local_changes"); }
    }
  }
  if (legacy.length > 0) return { present: true, candidate: true, commit: null, version, kind: "legacy", reason: "commit_unrecorded", destinations: legacy };
  return unknown(pack === "dev" && existsSync(join(dir, "research-codebase/SKILL.md")));
}

/** Caller holds the installation lock. Publish last, preserving the other pack's receipt. */
export function writeSkillReceipt(home: string, receipt: SkillReceipt): void {
  const path = receiptsPath(home);
  let packs: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(raw) || raw.version !== 1 || !record(raw.packs)) throw new Error("receipt_invalid");
    packs = raw.packs;
  }
  mkdirSync(configDirFor(home), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, packs: { ...packs, [receipt.pack]: receipt } }), { mode: 0o600 });
  renameSync(temporary, path);
}
