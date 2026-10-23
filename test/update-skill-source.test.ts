import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnCliCommand } from "../src/update-cli";
import { stageSkillSource } from "../src/update-skill-source";
import { tempHome } from "./helpers";
import { skillRepository } from "./update-fixtures";

describe("approved skill sources", () => {
  it("fetches approved A even when the remote head B has the same version", () => {
    const f = skillRepository();
    const result = stageSkillSource(tempHome(), "cloud", f.target, { repositoryUrl: () => f.repo });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(readFileSync(join(result.dir, "skills/catalyst-onboard/SKILL.md"), "utf8")).toContain("approved A");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: result.dir, encoding: "utf8" }).trim()).toBe(f.target.commit);
  });
  it("refuses fetch failure and inconsistent manifests", () => {
    const f = skillRepository();
    expect(stageSkillSource(tempHome(), "cloud", { ...f.target, commit: "f".repeat(40) }, { repositoryUrl: () => f.repo })).toMatchObject({ ok: false });
    expect(stageSkillSource(tempHome(), "cloud", { ...f.target, version: "0.16.99" }, { repositoryUrl: () => f.repo })).toMatchObject({ ok: false, detail: "source_mismatch" });
  });
  it("refuses a transport that resolves a different commit", () => {
    const f = skillRepository();
    expect(stageSkillSource(tempHome(), "cloud", f.target, { repositoryUrl: () => f.repo, exec: (argv, cwd, env) => argv.includes("rev-parse") ? { status: 0, stdout: "0".repeat(40), stderr: "" } : spawnCliCommand(argv, cwd, env) })).toMatchObject({ ok: false, detail: "source_mismatch" });
  });
  it("rejects symlink escapes and modified cached checkouts", () => {
    const f = skillRepository();
    symlinkSync("/etc/passwd", join(f.repo, "skills/catalyst-onboard/escape"));
    execFileSync("git", ["add", "."], { cwd: f.repo });
    execFileSync("git", ["commit", "-qm", "unsafe"], { cwd: f.repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    expect(stageSkillSource(tempHome(), "cloud", { ...f.target, commit }, { repositoryUrl: () => f.repo })).toMatchObject({ ok: false });
    const home = tempHome();
    const result = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
    if (!result.ok) throw new Error(result.detail);
    writeFileSync(join(result.dir, "extra"), "edit");
    expect(stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo })).toMatchObject({ ok: false, detail: "local_changes" });
  });
});
