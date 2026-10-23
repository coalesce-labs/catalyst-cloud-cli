import { randomUUID } from "node:crypto";
// Reconcile owned filesystem packs to an approved Git commit, publishing the receipt last.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApprovedSkillPack } from "./approved-release.js";
import { configDirFor } from "./config.js";
import { stageCliRuntime, stagedSkillsDir, type CliApplyDeps } from "./update-cli.js";
import { contentDigest, record, safeName, skillTreeHash, stageSkillSource, type SkillPack, type SkillSourceDeps } from "./update-skill-source.js";
import { destinationMatches, inspectSkillInstallation, plainDirectory, readSkillLock, skillLockPath, writeSkillReceipt, type SkillDestination, type SkillReceipt } from "./update-skill-state.js";

export interface PackApplyResult {
  outcome: "updated" | "current" | "failed" | "linked";
  detail: string;
  version: string | null;
  commit?: string | null;
}
export interface PackApplyDeps extends SkillSourceDeps {
  baseline?: CliApplyDeps;
  /** Fault injection at the filesystem boundary; production uses renameSync. */
  rename?: typeof renameSync;
  writeReceipt?: typeof writeSkillReceipt;
}

/** One writer for receipts, adopted locks and plugin source selection. Dead owners are retryable. */
export function withSkillUpdateLock<T>(home: string, busy: T, run: () => T): T {
  const root = configDirFor(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".skill-update.lock");
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try { writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); }
  catch {
    // Only one reclaimer can inspect and remove a dead owner's lock. A process interrupted
    // inside this short section leaves the guard in place and fails closed, never admits peers.
    const reclaim = `${lock}.reclaim`;
    try { mkdirSync(reclaim, { mode: 0o700 }); } catch { return busy; }
    try {
      const saved: unknown = JSON.parse(readFileSync(lock, "utf8"));
      if (!record(saved) || typeof saved.pid !== "number" || !Number.isSafeInteger(saved.pid) || saved.pid <= 0) return busy;
      try { process.kill(saved.pid, 0); return busy; }
      catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return busy; }
      rmSync(lock);
      writeFileSync(lock, owner, { flag: "wx", mode: 0o600 });
    } catch { return busy; }
    finally { rmSync(reclaim, { recursive: true, force: true }); }
  }
  try { return run(); }
  finally {
    try { if (readFileSync(lock, "utf8") === owner) rmSync(lock); } catch { /* Another owner is never unlocked here. */ }
  }
}

interface Replacement { destination: SkillDestination; backup: string; staged: string; retired: boolean; nextDigest: string | null }

/** Recover a durable transaction after a dead writer, validating every destination before writes. */
function recover(home: string, env: NodeJS.ProcessEnv, pack: SkillPack, dir: string): boolean {
  const journal = join(configDirFor(home), ".skill-transaction.json");
  if (!existsSync(journal)) return true;
  try {
    const raw: unknown = JSON.parse(readFileSync(journal, "utf8"));
    if (!record(raw) || raw.pack !== pack || raw.dir !== dir || (raw.kind !== "legacy" && raw.kind !== "npx") || !Array.isArray(raw.replacements) || typeof raw.receiptBefore !== "string" && raw.receiptBefore !== null || typeof raw.lockBefore !== "string" && raw.lockBefore !== null) return false;
    if (raw.kind === "npx" && (raw.lockPath !== skillLockPath(home, env) || typeof raw.lockBefore !== "string")) return false;
    if (raw.kind === "legacy" && raw.lockPath !== undefined) return false;
    const roots = [...new Set([dir, ...[".claude", ".codex", ".cursor", ".opencode", ".config/opencode"].map((agent) => join(home, agent, "skills"))])];
    const entries: { destination: SkillDestination; backup: string; staged: string }[] = [];
    for (const item of raw.replacements) {
      if (!record(item) || !record(item.destination)) return false;
      const d = item.destination;
      if (typeof d.name !== "string" || !safeName(d.name) || d.path !== join(raw.kind === "npx" ? join(home, ".agents/skills") : dir, d.name) || typeof d.digest !== "string" || !/^[a-f0-9]{64}$/.test(d.digest) || !Array.isArray(d.links) || !d.links.every((link): link is string => typeof link === "string" && roots.some((root) => link === join(root, String(d.name))))) return false;
      const destination: SkillDestination = { name: d.name, path: String(d.path), digest: d.digest, links: d.links, skillPath: `skills/${d.name}` };
      if (item.backup !== `${destination.path}.catalyst-backup` || item.staged !== `${destination.path}.catalyst-staged` || !plainDirectory(dirname(destination.path))) return false;
      if (existsSync(item.backup)) {
        if (!plainDirectory(item.backup) || contentDigest(item.backup) !== destination.digest) return false;
        // Someone may have edited the selected files after a crash. Never discard those bytes.
        if (raw.committed !== true && existsSync(destination.path) && (!plainDirectory(destination.path) || contentDigest(destination.path) !== item.nextDigest)) return false;
      }
      for (const link of destination.links) {
        try {
          if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== destination.path) return false;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
        }
      }
      entries.push({ destination, backup: item.backup, staged: item.staged });
    }
    if (raw.committed === true) {
      const receipt = readFileSync(join(configDirFor(home), "skill-installations.json"), "utf8");
      if (receipt !== raw.receiptAfter) return false;
      // The transaction already committed. Finish only its backup cleanup; selected files stay.
      for (const item of entries) {
        rmSync(item.backup, { recursive: true, force: true });
        rmSync(item.staged, { recursive: true, force: true });
      }
      rmSync(journal);
      return true;
    }
    for (const item of entries.reverse()) {
      if (existsSync(item.backup)) {
        rmSync(item.destination.path, { recursive: true, force: true });
        renameSync(item.backup, item.destination.path);
      }
      for (const link of item.destination.links) {
        try { lstatSync(link); } catch { symlinkSync(item.destination.path, link); }
      }
      rmSync(item.staged, { recursive: true, force: true });
    }
    if (typeof raw.lockPath === "string" && typeof raw.lockBefore === "string") {
      const previous: unknown = JSON.parse(raw.lockBefore);
      const lock = readSkillLock(raw.lockPath);
      if (!record(previous) || !record(previous.skills) || !lock) return false;
      for (const { destination } of entries) lock.skills[destination.name] = previous.skills[destination.name];
      writeFileSync(raw.lockPath, JSON.stringify(lock), { mode: 0o600 });
    }
    const receiptPath = join(configDirFor(home), "skill-installations.json");
    if (raw.receiptBefore === null) rmSync(receiptPath, { force: true });
    else writeFileSync(receiptPath, raw.receiptBefore, { mode: 0o600 });
    if (!entries.every((entry) => destinationMatches(entry.destination))) return false;
    rmSync(journal);
    return true;
  } catch { return false; }
}

export function applyPackUpdate(home: string, env: NodeJS.ProcessEnv, pack: SkillPack, dir: string, target: ApprovedSkillPack, deps: PackApplyDeps = {}): PackApplyResult {
  const failed = (detail: string): PackApplyResult => ({ outcome: "failed", detail, version: null, commit: null });
  return withSkillUpdateLock(home, failed("update_in_progress"), () => {
    if (!recover(home, env, pack, dir)) return failed("recovery_failed");
    const evidence = inspectSkillInstallation(home, env, pack, dir);
    if (evidence.reason === "local_changes") return failed("local_changes");
    if (!evidence.present || !evidence.candidate) return { outcome: "linked", detail: "installation_owner_unknown", version: evidence.version, commit: null };
    if (evidence.commit === target.commit && evidence.version === target.version) return { outcome: "current", detail: "current", version: evidence.version, commit: evidence.commit };
    try {
      if (!evidence.receipt) {
        if (evidence.kind === "npx") {
          if (!evidence.destinations.every((d) => skillTreeHash(d.path, env) === d.lockHash)) return failed("local_changes");
        } else {
          if (evidence.version === null) return failed("installation_owner_unknown");
          const baseline = stageCliRuntime(home, evidence.version, { ...deps.baseline, env });
          if (!baseline.ok) return { outcome: "linked", detail: "installation_owner_unknown", version: evidence.version };
          if (!evidence.destinations.every((d) => contentDigest(join(stagedSkillsDir(baseline.root), d.name)) === d.digest)) return failed("local_changes");
        }
      }
      const source = stageSkillSource(home, pack, target, { ...deps, env });
      if (!source.ok) return failed(source.detail);
      const replacements: Replacement[] = [];
      const after: SkillDestination[] = [];
      for (const destination of evidence.destinations) {
        const backup = `${destination.path}.catalyst-backup`, staged = `${destination.path}.catalyst-staged`;
        if (existsSync(backup) || existsSync(staged) || !plainDirectory(dirname(destination.path))) return failed("activation_conflict");
        const next = join(source.dir, destination.skillPath);
        const retired = !existsSync(join(next, "SKILL.md"));
        replacements.push({ destination, backup, staged, retired, nextDigest: retired ? null : contentDigest(next) });
        if (!retired) after.push({ ...destination, digest: contentDigest(next), lockHash: skillTreeHash(next, env) });
      }
      const receiptPath = join(configDirFor(home), "skill-installations.json");
      const receiptBefore = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null;
      const lockBefore = evidence.lockPath ? readFileSync(evidence.lockPath, "utf8") : null;
      const journal = join(configDirFor(home), ".skill-transaction.json");
      writeFileSync(journal, JSON.stringify({ pack, dir, kind: evidence.kind, replacements, receiptBefore, lockBefore, lockPath: evidence.lockPath }), { mode: 0o600 });
      try {
        for (const item of replacements) if (!item.retired) cpSync(join(source.dir, item.destination.skillPath), item.staged, { recursive: true, dereference: false });
        if (!evidence.destinations.every(destinationMatches)) throw new Error("local_changes");
        const rename = deps.rename ?? renameSync;
        for (const item of replacements) {
          rename(item.destination.path, item.backup);
          if (!item.retired) rename(item.staged, item.destination.path);
          else for (const link of item.destination.links) rmSync(link);
        }
        if (evidence.lockPath) {
          if (readFileSync(evidence.lockPath, "utf8") !== lockBefore) throw new Error("lock_changed");
          const lock = readSkillLock(evidence.lockPath);
          if (!lock) throw new Error("source_mismatch");
          for (const d of evidence.destinations) {
            const next = after.find((item) => item.name === d.name);
            if (!next) delete lock.skills[d.name];
            else {
              const old = lock.skills[d.name];
              if (!record(old)) throw new Error("source_mismatch");
              lock.skills[d.name] = { ...old, ref: target.commit, skillFolderHash: next.lockHash };
            }
          }
          const temporary = `${evidence.lockPath}.${process.pid}.tmp`;
          writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 });
          renameSync(temporary, evidence.lockPath);
        }
        if (!after.every(destinationMatches)) throw new Error("verify_failed");
        const receipt: SkillReceipt = { pack, ...target, kind: evidence.kind === "npx" ? "npx" : "legacy", dir, destinations: after, ...(evidence.lockPath ? { lockPath: evidence.lockPath } : {}) };
        (deps.writeReceipt ?? writeSkillReceipt)(home, receipt);
        const saved: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
        if (!record(saved) || !record(saved.packs) || JSON.stringify(saved.packs[pack]) !== JSON.stringify(receipt) || !after.every(destinationMatches)) throw new Error("verify_failed");
        // Keep a durable committed marker until fixed-name backups are all removed.
        const committed = `${journal}.tmp`;
        writeFileSync(committed, JSON.stringify({ pack, dir, kind: evidence.kind, replacements, receiptBefore, lockBefore, lockPath: evidence.lockPath, committed: true, receiptAfter: readFileSync(receiptPath, "utf8") }), { mode: 0o600 });
        renameSync(committed, journal);
        for (const item of replacements) rmSync(item.backup, { recursive: true, force: true });
        rmSync(journal);
        return { outcome: "updated", detail: "approved_commit_installed", version: target.version, commit: target.commit };
      } catch (error) {
        const restored = recover(home, env, pack, dir);
        return failed(restored ? error instanceof Error ? error.message : "activate_failed" : "rollback_failed");
      }
    } catch (error) { return failed(error instanceof Error ? error.message : "install_failed"); }
  });
}
