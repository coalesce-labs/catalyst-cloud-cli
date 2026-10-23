import { execFileSync, spawnSync } from "node:child_process";
import { setComponentPolicy } from "../src/update-policy";
import { main } from "../src/cli";
import { configPathFor } from "../src/config";
import { runUpdate, updateReportJson, updateReportLines, type UpdateOptions } from "../src/update";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPackUpdate, withSkillUpdateLock } from "../src/update-skills";
import { contentDigest, skillTreeHash, stageSkillSource } from "../src/update-skill-source";
import { inspectSkillInstallation, writeSkillReceipt } from "../src/update-skill-state";
import { makeCtx, tempHome } from "./helpers";
import { approved, memberFetch, signIn, skillRepository } from "./update-fixtures";

const setup = (pack: "cloud" | "dev" = "cloud") => {
  const home = tempHome(), f = skillRepository(pack);
  const source = stageSkillSource(home, pack, f.target, { repositoryUrl: () => f.repo });
  if (!source.ok) throw new Error(source.detail);
  const dir = join(home, ".claude/skills");
  mkdirSync(dir, { recursive: true });
  cpSync(join(source.dir, "skills", f.name), join(dir, f.name), { recursive: true });
  writeFileSync(join(dir, f.name, "stale"), "delete me");
  const path = join(dir, f.name);
  writeSkillReceipt(home, { pack, ...f.target, commit: "3".repeat(40), kind: "legacy", dir, destinations: [{ name: f.name, path, links: [], digest: contentDigest(path), skillPath: `skills/${f.name}` }] });
  return { home, f, dir, pack };
};

describe("exact commit reconciliation", () => {
  it.each(["cloud", "dev"] as const)("reconciles %s to A, removes stale files, and stays there while the head is B", (pack) => {
    const { home, f, dir } = setup(pack);
    const result = applyPackUpdate(home, {}, pack, dir, f.target);
    expect(result).toMatchObject({ outcome: "updated", commit: f.target.commit });
    expect(readFileSync(join(dir, f.name, "SKILL.md"), "utf8")).toContain("approved A");
    expect(existsSync(join(dir, f.name, "stale"))).toBe(false);
    expect(inspectSkillInstallation(home, {}, pack, dir).commit).toBe(f.target.commit);
    expect(applyPackUpdate(home, {}, pack, dir, f.target)).toMatchObject({ outcome: "current", commit: f.target.commit });
  });
  it("does not add new names to a partial installation", () => {
    const { home, f, dir } = setup();
    mkdirSync(join(f.repo, "skills/new-skill")); writeFileSync(join(f.repo, "skills/new-skill/SKILL.md"), "new skill");
    execFileSync("git", ["add", "."], { cwd: f.repo }); execFileSync("git", ["commit", "-qm", "new skill"], { cwd: f.repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    expect(applyPackUpdate(home, {}, "cloud", dir, { ...f.target, commit }, { repositoryUrl: () => f.repo })).toMatchObject({ outcome: "updated", commit });
    expect(existsSync(join(dir, "new-skill"))).toBe(false);
  });
  it("preserves local edits and refuses competing updates", () => {
    const { home, f, dir } = setup();
    writeFileSync(join(dir, f.name, "SKILL.md"), "my edit");
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "failed", detail: "local_changes" });
    expect(readFileSync(join(dir, f.name, "SKILL.md"), "utf8")).toBe("my edit");
    writeFileSync(join(home, ".config/catalyst-cloud/.skill-update.lock"), JSON.stringify({ pid: process.pid }));
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "failed", detail: "update_in_progress" });
  });
});


describe("pack transaction safety", () => {
  it.each(["activation", "receipt"])("rolls back %s failures and retries without a false current claim", (failure) => {
    const { home, f, dir } = setup();
    const old = contentDigest(join(dir, f.name));
    const result = applyPackUpdate(home, {}, "cloud", dir, f.target, {
      ...(failure === "activation" ? { rename: (from, to) => { if (String(from).endsWith(".catalyst-staged")) throw new Error("activate_failed"); renameSync(from, to); } } : {}),
      ...(failure === "receipt" ? { writeReceipt: () => { throw new Error("receipt_failed"); } } : {}),
    });
    expect(result.outcome).toBe("failed");
    expect(contentDigest(join(dir, f.name))).toBe(old);
    expect(inspectSkillInstallation(home, {}, "cloud", dir).commit).toBe("3".repeat(40));
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "updated", commit: f.target.commit });
  });
  it("does not report current or discard edits when verification fails after receipt publication", () => {
    const { home, f, dir } = setup();
    const result = applyPackUpdate(home, {}, "cloud", dir, f.target, { writeReceipt: (h, receipt) => { writeSkillReceipt(h, receipt); writeFileSync(join(dir, f.name, "extra"), "concurrent edit"); } });
    expect(result).toMatchObject({ outcome: "failed", detail: "rollback_failed" });
    expect(readFileSync(join(dir, f.name, "extra"), "utf8")).toBe("concurrent edit");
    expect(inspectSkillInstallation(home, {}, "cloud", dir).commit).toBeNull();
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "failed", detail: "recovery_failed" });
  });
  it("finishes interrupted committed cleanup without rolling back the installed release", () => {
    const { home, f, dir } = setup();
    const destination = inspectSkillInstallation(home, {}, "cloud", dir).destinations[0];
    if (!destination) throw new Error("missing fixture destination");
    const oldCopy = join(home, "old-copy"); cpSync(destination.path, oldCopy, { recursive: true });
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "updated" });
    const receiptAfter = readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8");
    const backup = `${destination.path}.catalyst-backup`, staged = `${destination.path}.catalyst-staged`;
    cpSync(oldCopy, backup, { recursive: true });
    writeFileSync(join(home, ".config/catalyst-cloud/.skill-transaction.json"), JSON.stringify({ pack: "cloud", dir, kind: "legacy", replacements: [{ destination, backup, staged, retired: false }], receiptBefore: null, lockBefore: null, committed: true, receiptAfter }));
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "current", commit: f.target.commit });
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8")).toBe(receiptAfter);
  });
  it("serializes stale-lock reclaimers and never releases another owner's lock", () => {
    const home = tempHome(), root = join(home, ".config/catalyst-cloud"); mkdirSync(root, { recursive: true });
    const lock = join(root, ".skill-update.lock"), reclaim = `${lock}.reclaim`;
    // A child that has exited supplies a real dead PID without assuming a PID ceiling.
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
    writeFileSync(lock, JSON.stringify({ pid: child.pid }));
    mkdirSync(reclaim);
    expect(withSkillUpdateLock(home, "busy", () => "entered")).toBe("busy");
    rmSync(reclaim, { recursive: true });
    expect(withSkillUpdateLock(home, "busy", () => {
      expect(withSkillUpdateLock(home, "busy", () => "overlap")).toBe("busy");
      writeFileSync(lock, "replacement-owner");
      return "entered";
    })).toBe("entered");
    expect(readFileSync(lock, "utf8")).toBe("replacement-owner");
  });
  it("recovers an interrupted replacement using its durable journal", () => {
    const { home, f, dir } = setup();
    const evidence = inspectSkillInstallation(home, {}, "cloud", dir);
    const destination = evidence.destinations[0];
    if (!destination) throw new Error("missing fixture destination");
    const receiptBefore = readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8");
    const backup = `${destination.path}.catalyst-backup`, staged = `${destination.path}.catalyst-staged`;
    renameSync(destination.path, backup);
    writeFileSync(join(home, ".config/catalyst-cloud/.skill-transaction.json"), JSON.stringify({ pack: "cloud", dir, kind: "legacy", replacements: [{ destination, backup, staged, retired: false }], receiptBefore, lockBefore: null }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ reason: "update_interrupted", candidate: true, commit: null });
    expect(applyPackUpdate(home, {}, "cloud", dir, f.target)).toMatchObject({ outcome: "updated", commit: f.target.commit });
    expect(existsSync(backup)).toBe(false);
  });
  it.each([false, true])("adopts global npx locks and keeps independent copies, XDG=%s", (xdg) => {
    const home = tempHome(), f = skillRepository();
    const source = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
    if (!source.ok) throw new Error(source.detail);
    const dir = join(home, ".claude/skills"), canonical = join(home, ".agents/skills", f.name);
    mkdirSync(dir, { recursive: true }); mkdirSync(join(home, ".agents/skills"), { recursive: true });
    cpSync(join(source.dir, "skills", f.name), canonical, { recursive: true });
    writeFileSync(join(canonical, "stale"), "old");
    symlinkSync(canonical, join(dir, f.name));
    const independent = join(home, ".codex/skills", f.name);
    mkdirSync(independent, { recursive: true }); writeFileSync(join(independent, "SKILL.md"), "independent");
    const env = xdg ? { XDG_STATE_HOME: join(home, "state") } : {};
    const lock = xdg ? join(home, "state/skills/.skill-lock.json") : join(home, ".agents/.skill-lock.json");
    mkdirSync(join(lock, ".."), { recursive: true });
    const foreign = { source: "someone/custom", custom: true };
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { custom: foreign, [f.name]: { source: f.target.repository, sourceType: "github", skillPath: `skills/${f.name}`, skillFolderHash: skillTreeHash(canonical) } } }));
    expect(applyPackUpdate(home, env, "cloud", dir, f.target)).toMatchObject({ outcome: "updated", commit: f.target.commit });
    expect(readFileSync(join(dir, f.name, "SKILL.md"), "utf8")).toContain("approved A");
    expect(readFileSync(join(independent, "SKILL.md"), "utf8")).toBe("independent");
    const after = JSON.parse(readFileSync(lock, "utf8"));
    expect(after.skills.custom).toEqual(foreign);
    expect(after.skills[f.name]).toMatchObject({ ref: f.target.commit, skillFolderHash: skillTreeHash(canonical) });
    expect(inspectSkillInstallation(home, env, "cloud", dir)).toMatchObject({ commit: f.target.commit });
    // A changed lock source cannot authorize a later replacement through the receipt.
    after.skills[f.name].source = "someone/else"; writeFileSync(lock, JSON.stringify(after));
    expect(inspectSkillInstallation(home, env, "cloud", dir)).toMatchObject({ candidate: false, reason: "source_mismatch" });
  });
});

describe("approved pack command contract", () => {
  it("moves both 0.16.25 packs to approved 0.16.28 commits and repeated daily checks keep A", async () => {
    const home = tempHome(), dir = join(home, ".claude/skills");
    mkdirSync(dir, { recursive: true });
    const targets = { cloud: skillRepository("cloud", "0.16.28"), dev: skillRepository("dev", "0.16.28") };
    for (const pack of ["cloud", "dev"] as const) {
      const old = skillRepository(pack, "0.16.25");
      const staged = stageSkillSource(home, pack, old.target, { repositoryUrl: () => old.repo });
      if (!staged.ok) throw new Error(staged.detail);
      const path = join(dir, old.name);
      cpSync(join(staged.dir, "skills", old.name), path, { recursive: true });
      writeSkillReceipt(home, { pack, ...old.target, kind: "legacy", dir, destinations: [{ name: old.name, path, links: [], digest: contentDigest(path), skillPath: `skills/${old.name}` }] });
    }
    signIn(home, undefined, { skillsDir: dir, lastSkillBundleVersion: "0.16.25" });
    const approval = approved({ mutate: (r) => { r.members = { cli: "0.16.28", plugin: "0.16.28" }; r.skills = { cloud: targets.cloud.target, dev: targets.dev.target }; } });
    const ctx = () => makeCtx(home, { fetch: memberFetch(200, { ok: true, release: approval }) });
    const options: UpdateOptions = { mode: "apply", imagesDir: join(home, "absent"), engine: () => { throw new Error("no Docker"); }, packApply: (h, env, pack, d, target) => applyPackUpdate(h, env, pack, d, target, { repositoryUrl: () => targets[pack].repo }) };
    const first = await runUpdate(ctx(), options);
    expect(first.exitCode).toBe(0);
    for (const pack of ["cloud", "dev"] as const) {
      expect(first.components.find((c) => c.id === `skills-${pack}`)).toMatchObject({ installed: "0.16.28", installedCommit: targets[pack].target.commit, status: "updated" });
      expect(readFileSync(join(dir, targets[pack].name, "SKILL.md"), "utf8")).toContain("approved A");
    }
    expect(first.components.find((c) => c.id === "cli")).toMatchObject({ status: "installed_newer" });
    expect(await main(["capabilities", "--json"], ctx())).toBe(0);
    const configBefore = readFileSync(configPathFor(home), "utf8");
    const receiptBefore = readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8");
    for (let day = 0; day < 2; day++) {
      const report = await runUpdate(ctx(), { ...options, mode: "check" });
      const json = updateReportJson(report);
      // A daily consumer uses only usable approvals and enabled component rows.
      const selected = report.components.filter((c) => c.policy === "on" && c.approvedCommit !== null && (c.id === "skills-cloud" || c.id === "skills-dev")).map((c) => c.approvedCommit);
      expect(selected).toEqual([targets.cloud.target.commit, targets.dev.target.commit]);
      expect(json.approvedSkills).toEqual({ cloud: targets.cloud.target, dev: targets.dev.target });
      expect((await runUpdate(ctx(), options)).components.filter((c) => c.id.startsWith("skills-")).every((c) => c.status === "current")).toBe(true);
    }
    const checked = ctx();
    expect(await main(["update", "--check", "--json"], checked)).toBe(0);
    expect(readFileSync(configPathFor(home), "utf8")).toBe(configBefore);
    expect(readFileSync(join(home, ".config/catalyst-cloud/skill-installations.json"), "utf8")).toBe(receiptBefore);
    for (const pack of ["cloud", "dev"] as const) expect(readFileSync(join(dir, targets[pack].name, "SKILL.md"), "utf8")).toContain("approved A");
  });
  it("holds do not stage sources and a daily consumer skips absent or unusable approval", async () => {
    const { home, f, dir } = setup(); signIn(home, undefined, { skillsDir: dir });
    setComponentPolicy(home, "skills-cloud", false);
    const release = approved({ mutate: (r) => { r.members = { cli: "0.16.28" }; r.skills = { cloud: { ...f.target, commit: "a".repeat(40) } }; } });
    const report = await runUpdate(makeCtx(home, { fetch: memberFetch(200, { ok: true, release }) }), { mode: "apply", imagesDir: join(home, "absent"), engine: () => { throw new Error("no Docker"); }, packApply: () => { throw new Error("held pack staged"); } });
    expect(report.components.find((c) => c.id === "skills-cloud")).toMatchObject({ status: "held", policy: "off" });
    const consume = (result: typeof report) => result.approved && !result.crossTrain ? result.components.filter((row) => row.policy === "on" && row.status !== "not_installed" && row.approvedCommit).map((row) => row.approvedCommit) : [];
    expect(consume(report)).toEqual([]);
    const unavailable = await runUpdate(makeCtx(home, { fetch: memberFetch(503, {}) }), { mode: "check", imagesDir: join(home, "absent"), engine: () => { throw new Error("no Docker"); } });
    expect(updateReportJson(unavailable).approvedSkills).toBeNull();
    expect(consume(unavailable)).toEqual([]);
    expect(existsSync(join(home, ".config/catalyst-cloud/skill-releases/cloud", "a".repeat(40)))).toBe(false);
  });
  it("reports omitted Dev approval and local edits without floating install guidance", async () => {
    const { home, f, dir } = setup();
    mkdirSync(join(dir, "research-codebase")); writeFileSync(join(dir, "research-codebase/SKILL.md"), "keep Dev");
    writeFileSync(join(dir, f.name, "SKILL.md"), "local edit");
    signIn(home, undefined, { skillsDir: dir });
    const release = approved({ mutate: (r) => { r.members = { cli: "0.16.28" }; r.skills = { cloud: f.target }; } });
    const ctx = makeCtx(home, { fetch: memberFetch(200, { ok: true, release }) });
    const options = { imagesDir: join(home, "absent"), engine: () => { throw new Error("no Docker"); } };
    const check = await runUpdate(ctx, { ...options, mode: "check" });
    expect(check.components.find((c) => c.id === "skills-cloud")).toMatchObject({ status: "unknown", reason: "local_changes", installedCommit: null });
    expect(check.components.find((c) => c.id === "skills-dev")).toMatchObject({ status: "approval_unavailable", reason: "pack_not_approved", action: null, approvedCommit: null });
    expect(updateReportJson(check).approvedSkills).toEqual({ cloud: f.target });
    const apply = await runUpdate(ctx, { ...options, mode: "apply" });
    expect(apply.exitCode).toBe(1);
    expect(updateReportLines(apply)).toContain("Cloud skills: the approved commit was not installed (local_changes). Local changes were kept. Run catalyst update --check --json to inspect the result.");
    expect(updateReportLines(apply)).toContain("Dev skills: no approved pack was provided; the installed pack was kept.");
    expect(readFileSync(join(dir, "research-codebase/SKILL.md"), "utf8")).toBe("keep Dev");
  });
});
