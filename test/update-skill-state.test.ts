import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectSkillInstallation, writeSkillReceipt } from "../src/update-skill-state";
import { contentDigest, skillTreeHash, stageSkillSource } from "../src/update-skill-source";
import { tempHome } from "./helpers";
import { skillRepository } from "./update-fixtures";

const fixture = () => {
  const home = tempHome(), f = skillRepository();
  const source = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
  if (!source.ok) throw new Error(source.detail);
  const dir = join(home, ".claude/skills");
  mkdirSync(dir, { recursive: true });
  cpSync(join(source.dir, "skills", f.name), join(dir, f.name), { recursive: true });
  return { home, dir, f, source };
};

describe("skill installation evidence", () => {
  it.each(["edit", "extra", "missing", "link"])("invalidates a receipt after %s without writing during inventory", (change) => {
    const { home, dir, f } = fixture();
    const path = join(dir, f.name);
    writeSkillReceipt(home, { pack: "cloud", ...f.target, kind: "legacy", dir, destinations: [{ name: f.name, path, links: [], digest: contentDigest(path), skillPath: `skills/${f.name}` }] });
    expect(inspectSkillInstallation(home, {}, "cloud", dir).commit).toBe(f.target.commit);
    if (change === "edit") writeFileSync(join(path, "SKILL.md"), "edited");
    if (change === "extra") writeFileSync(join(path, "ignored-extra"), "extra");
    if (change === "missing") rmSync(join(path, "SKILL.md"));
    if (change === "link") { rmSync(path, { recursive: true }); symlinkSync(join(f.repo, "skills", f.name), path); }
    const before = readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8");
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ commit: null, reason: "local_changes" });
    expect(readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8")).toBe(before);
  });
  it.each(["", "/SKILL.md"])("recognizes supported global lock paths ending in '%s' and existing canonical links", (suffix) => {
    const { home, dir, f, source } = fixture();
    const canonical = join(home, ".agents/skills", f.name);
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    cpSync(join(source.dir, "skills", f.name), canonical, { recursive: true });
    rmSync(join(dir, f.name), { recursive: true }); symlinkSync(canonical, join(dir, f.name));
    const lock = join(home, ".agents/.skill-lock.json");
    const entry = { source: f.target.repository, sourceType: "github", skillPath: `skills/${f.name}${suffix}`, skillFolderHash: skillTreeHash(canonical) };
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { [f.name]: entry } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ kind: "npx", candidate: true, commit: null });
    for (const skillPath of [null, `skills/../skills/${f.name}/SKILL.md`, `/skills/${f.name}/SKILL.md`, `skills/${f.name}/other.md`]) {
      writeFileSync(lock, JSON.stringify({ version: 3, skills: { [f.name]: { ...entry, skillPath } } }));
      expect(inspectSkillInstallation(home, {}, "cloud", dir).candidate).toBe(false);
    }
    writeFileSync(lock, JSON.stringify({ version: 4, skills: { [f.name]: entry } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir).candidate).toBe(false);
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { [f.name]: { ...entry, source: "someone/else" } } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir).candidate).toBe(false);
  });
  it("matches an independently committed Git tree hash", () => {
    const { source, f } = fixture();
    const expected = execFileSync("git", ["rev-parse", `HEAD:skills/${f.name}`], { cwd: source.dir, encoding: "utf8" }).trim();
    expect(skillTreeHash(join(source.dir, "skills", f.name))).toBe(expected);
  });
  it("Git tree hashes include executable bits and ignored extras", () => {
    const { dir, f } = fixture();
    const path = join(dir, f.name);
    const before = skillTreeHash(path);
    chmodSync(join(path, "SKILL.md"), 0o755);
    expect(skillTreeHash(path)).not.toBe(before);
    const executable = skillTreeHash(path);
    writeFileSync(join(path, ".gitignore"), "secret\n");
    const ignored = skillTreeHash(path);
    writeFileSync(join(path, "secret"), "extra");
    expect(skillTreeHash(path)).not.toBe(ignored);
    expect(ignored).not.toBe(executable);
  });
});
