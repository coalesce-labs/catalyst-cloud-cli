// update-skills.ts — the Cloud skills pack moves to its approved version (CTC-6708). The pack
// ships inside the CLI package of the same version, so a release check installs that exact CLI
// package into its own directory (update-cli.ts's stageCliRuntime, which checks it and selects
// nothing), checks that its bundled skills carry the approved version's stamp, and refreshes the
// copies of those skills this install already made. That works while the CLI itself is held: the
// pack comes from the staged package, never from the older CLI's own bundle.
//
// It changes only what installSkills already treats as its own: a skill folder stamped by this
// package. A person's own skill of the same name, a symlinked entry (a plugin or the installer's
// link) and any skill not installed yet are left as they are. Success is read back from the stamps
// on disk.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installedBundleVersion, installSkills } from "./skills.js";
import { stageCliRuntime, stagedSkillsDir, type CliApplyDeps } from "./update-cli.js";

export interface PackApplyResult {
  /** `linked`: an installer linked the pack's skills in, so the pack is that installer's to update. */
  outcome: "updated" | "failed" | "linked";
  /** `refreshed`, or why not: the staging reasons, `pack_mismatch`, `install_failed`, `verify_failed`, `installation_owner_unknown`. */
  detail: string;
  /** The version the pack's stamps read after this call, when one reads. */
  version: string | null;
}

const skillNames = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);

/** Stamped Cloud skills that are links: installSkills never writes through one, so copying cannot move them. */
function linkedPackEntries(skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      return lstatSync(join(skillsDir, name)).isSymbolicLink() && installedBundleVersion(skillsDir, [name]).version !== null;
    } catch {
      return false;
    }
  });
}

/** Refresh the Cloud pack's installed skills in `skillsDir` to exact version `target`. */
export function applyCloudPackUpdate(home: string, skillsDir: string, target: string, deps: CliApplyDeps = {}): PackApplyResult {
  // Checked before any download, so a linked pack is not fetched again on every run.
  if (linkedPackEntries(skillsDir).length > 0) return { outcome: "linked", detail: "installation_owner_unknown", version: null };
  const staged = stageCliRuntime(home, target, deps);
  if (!staged.ok) return { outcome: "failed", detail: staged.detail, version: null };
  const source = stagedSkillsDir(staged.root);
  let names: string[];
  try {
    names = skillNames(source);
  } catch {
    return { outcome: "failed", detail: "pack_mismatch", version: null };
  }
  // The staged package must carry exactly the approved pack, or nothing is copied.
  if (names.length === 0 || installedBundleVersion(source, names).version !== target) return { outcome: "failed", detail: "pack_mismatch", version: null };
  try {
    installSkills(skillsDir, { onlyExisting: true }, source, target);
  } catch {
    return { outcome: "failed", detail: "install_failed", version: installedBundleVersion(skillsDir, names).version };
  }
  const now = installedBundleVersion(skillsDir, names).version;
  return now === target ? { outcome: "updated", detail: "refreshed", version: now } : { outcome: "failed", detail: "verify_failed", version: now };
}
