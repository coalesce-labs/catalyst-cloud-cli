// update-skill-refusals.test.ts — the refusals behind exact-commit skills (CTC-6742): a staged
// source is refused before any fetch when its record cannot be the approved one, and refused after
// the fetch when its manifests disagree; content digests refuse links, nested Git data and special
// files; and ownership discovery reports an interrupted update, an unreadable receipt, a doubtful
// global lock or contradictory stamps as unknown instead of adopting the installation.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDirFor } from "../src/config";
import type { CliExec } from "../src/update-cli";
import { contentDigest, stageSkillSource, verifiedSkillSource } from "../src/update-skill-source";
import { inspectSkillInstallation, writeSkillReceipt } from "../src/update-skill-state";
import { applyPackUpdate, withSkillUpdateLock } from "../src/update-skills";
import { tempHome } from "./helpers";
import { cloudPack, NEXT, OLD, skillRepository } from "./update-fixtures";

const CLOUD = "coalesce-labs/catalyst-cloud-skills";
const lockEntry = (name: string, over: Record<string, unknown> = {}) => ({
  source: CLOUD,
  sourceType: "github",
  skillPath: `skills/${name}/SKILL.md`,
  skillFolderHash: "a".repeat(40),
  ...over,
});

/** Commit `change` on the fixture repository and return the approved record for the new commit. */
function commitChange(f: ReturnType<typeof skillRepository>, change: (repo: string) => void) {
  change(f.repo);
  execFileSync("git", ["add", "-A"], { cwd: f.repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: f.repo });
  return { ...f.target, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim() };
}

describe("an approved skill source is refused before any fetch", () => {
  it("POSITIVE CONTROL: the approved record stages", () => {
    const f = skillRepository();
    expect(stageSkillSource(tempHome(), "cloud", f.target, { repositoryUrl: () => f.repo })).toMatchObject({ ok: true });
  });

  it("refuses another repository, a malformed commit or an inexact version, and runs no git", () => {
    const calls: string[][] = [];
    const exec: CliExec = (argv) => (calls.push(argv), { status: 0, stdout: "", stderr: "" });
    const good = { version: NEXT, repository: CLOUD, commit: "a".repeat(40) };
    const home = tempHome();
    for (const target of [{ ...good, repository: "someone/else" }, { ...good, commit: "A".repeat(40) }, { ...good, commit: "abc" }, { ...good, version: "0.16" }]) {
      expect(stageSkillSource(home, "cloud", target, { exec })).toEqual({ ok: false, detail: "source_mismatch" });
      expect(verifiedSkillSource(home, "cloud", target)).toBeNull();
    }
    expect(stageSkillSource(home, "dev", good, { exec })).toEqual({ ok: false, detail: "source_mismatch" });
    expect(calls).toEqual([]);
  });

  it("a cached checkout whose saved record is missing or names another version is not verified", () => {
    const f = skillRepository(), home = tempHome();
    const staged = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
    if (!staged.ok) throw new Error(staged.detail);
    const saved = `${staged.dir}.json`;
    const record = JSON.parse(readFileSync(saved, "utf8")) as Record<string, unknown>;
    writeFileSync(saved, JSON.stringify({ ...record, version: OLD }));
    expect(verifiedSkillSource(home, "cloud", f.target)).toBeNull();
    expect(stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo })).toEqual({ ok: false, detail: "local_changes" });
    rmSync(saved);
    expect(verifiedSkillSource(home, "cloud", f.target)).toBeNull();
  });
});

describe("a fetched source whose manifests disagree is refused", () => {
  it("a plugin manifest at another version", () => {
    const f = skillRepository();
    const target = commitChange(f, (repo) => writeFileSync(join(repo, ".claude-plugin/plugin.json"), JSON.stringify({ name: "catalyst", version: OLD })));
    expect(stageSkillSource(tempHome(), "cloud", target, { repositoryUrl: () => f.repo })).toEqual({ ok: false, detail: "source_mismatch" });
  });

  it("a package manifest that is not an object", () => {
    const f = skillRepository();
    const target = commitChange(f, (repo) => writeFileSync(join(repo, "package.json"), "[]"));
    expect(stageSkillSource(tempHome(), "cloud", target, { repositoryUrl: () => f.repo })).toEqual({ ok: false, detail: "source_mismatch" });
  });

  it("no skill directory with a SKILL.md", () => {
    const f = skillRepository();
    const target = commitChange(f, (repo) => {
      rmSync(join(repo, "skills", f.name, "SKILL.md"));
      writeFileSync(join(repo, "skills", f.name, "README.md"), "no skill here\n");
    });
    expect(stageSkillSource(tempHome(), "cloud", target, { repositoryUrl: () => f.repo })).toEqual({ ok: false, detail: "source_mismatch" });
  });

  it("a skill directory whose name is not a plain name", () => {
    const f = skillRepository();
    const target = commitChange(f, (repo) => {
      mkdirSync(join(repo, "skills", ".hidden"));
      writeFileSync(join(repo, "skills", ".hidden", "SKILL.md"), "hidden\n");
    });
    expect(stageSkillSource(tempHome(), "cloud", target, { repositoryUrl: () => f.repo })).toEqual({ ok: false, detail: "unsafe_path" });
  });

  it("a source with no plugin manifest stages", () => {
    const f = skillRepository();
    const target = commitChange(f, (repo) => rmSync(join(repo, ".claude-plugin/plugin.json")));
    expect(stageSkillSource(tempHome(), "cloud", target, { repositoryUrl: () => f.repo })).toMatchObject({ ok: true });
  });
});

describe("content digests", () => {
  it("outside a checkout any link and any .git are refused; inside one, only the top .git is skipped", () => {
    const dir = tempHome();
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "f"), "x");
    const plain = contentDigest(dir);
    symlinkSync("f", join(dir, "a", "link"));
    expect(() => contentDigest(dir)).toThrow("unsafe_path");
    expect(contentDigest(dir, true)).not.toBe(plain);
    rmSync(join(dir, "a", "link"));
    mkdirSync(join(dir, ".git"));
    expect(() => contentDigest(dir)).toThrow("unsafe_path");
    expect(contentDigest(dir, true)).toBe(plain);
    mkdirSync(join(dir, "a", ".git"));
    expect(() => contentDigest(dir, true)).toThrow("unsafe_path");
  });

  it("the executable bit changes the digest, and a special file is refused", () => {
    const dir = tempHome();
    writeFileSync(join(dir, "run"), "#!/bin/sh\n");
    const regular = contentDigest(dir);
    chmodSync(join(dir, "run"), 0o755);
    expect(contentDigest(dir)).not.toBe(regular);
    execFileSync("mkfifo", [join(dir, "pipe")]);
    expect(() => contentDigest(dir)).toThrow("unsafe_path");
  });
});

describe("ownership discovery reports doubt as unknown", () => {
  const empty = () => tempHome();

  it("an interrupted update of this pack and directory is a candidate; of another, it is ignored; unreadable, it fails recovery", () => {
    const home = tempHome(), dir = empty();
    mkdirSync(configDirFor(home), { recursive: true });
    const transaction = join(configDirFor(home), ".skill-transaction.json");
    writeFileSync(transaction, JSON.stringify({ pack: "cloud", dir }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: true, candidate: true, reason: "update_interrupted" });
    writeFileSync(transaction, JSON.stringify({ pack: "dev", dir }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: false, candidate: false, reason: "installation_owner_unknown" });
    writeFileSync(transaction, "{");
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: true, candidate: false, reason: "recovery_failed" });
  });

  it("a receipt file of another shape, unreadable, or naming another repository reads source_mismatch", () => {
    const home = tempHome(), dir = empty();
    mkdirSync(configDirFor(home), { recursive: true });
    const receipts = join(configDirFor(home), "skill-installations.json");
    const bad = { pack: "cloud", repository: "someone/else", commit: "1".repeat(40), version: NEXT, kind: "legacy", dir, destinations: [] };
    for (const body of [JSON.stringify({ version: 2, packs: {} }), "{", JSON.stringify({ version: 1, packs: { cloud: bad } })]) {
      writeFileSync(receipts, body);
      expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ candidate: false, reason: "source_mismatch" });
    }
    writeFileSync(receipts, JSON.stringify({ version: 1, packs: { dev: { ...bad, pack: "dev" } } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: false, reason: "installation_owner_unknown" });
  });

  it("an empty receipt records an owned pack with nothing left installed", () => {
    const home = tempHome(), dir = empty();
    writeSkillReceipt(home, { pack: "cloud", repository: CLOUD, commit: "1".repeat(40), version: NEXT, kind: "legacy", dir, destinations: [] });
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: false, candidate: true, commit: "1".repeat(40), reason: "verified" });
  });

  it("writing a receipt keeps the other pack's, and refuses an unreadable receipt file", () => {
    const home = tempHome(), dir = empty();
    writeSkillReceipt(home, { pack: "dev", repository: "coalesce-labs/catalyst-dev-skills", commit: "2".repeat(40), version: NEXT, kind: "legacy", dir, destinations: [] });
    writeSkillReceipt(home, { pack: "cloud", repository: CLOUD, commit: "1".repeat(40), version: NEXT, kind: "legacy", dir, destinations: [] });
    const receipts = join(configDirFor(home), "skill-installations.json");
    expect(Object.keys((JSON.parse(readFileSync(receipts, "utf8")) as { packs: object }).packs).sort()).toEqual(["cloud", "dev"]);
    writeFileSync(receipts, JSON.stringify({ version: 2 }));
    expect(() => writeSkillReceipt(home, { pack: "cloud", repository: CLOUD, commit: "1".repeat(40), version: NEXT, kind: "legacy", dir, destinations: [] })).toThrow("receipt_invalid");
  });

  it("a global lock entry with a malformed tree hash, or a linked canonical skill, is unknown; a missing one is skipped", () => {
    const home = tempHome(), dir = empty(), name = "catalyst-onboard";
    const lock = join(home, ".agents/.skill-lock.json");
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { [name]: lockEntry(name) } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: false, candidate: true, kind: "npx", reason: "commit_unrecorded", destinations: [] });
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { [name]: lockEntry(name, { skillFolderHash: "nothex" }) } }));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: true, candidate: false, reason: "installation_owner_unknown" });
    writeFileSync(lock, JSON.stringify({ version: 3, skills: { [name]: lockEntry(name) } }));
    symlinkSync(empty(), join(home, ".agents/skills", name));
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ present: true, candidate: false, reason: "installation_owner_unknown" });
  });

  it("the global lock is read from XDG_STATE_HOME when that is set", () => {
    const home = tempHome(), dir = empty(), state = tempHome(), name = "catalyst-onboard";
    mkdirSync(join(state, "skills"), { recursive: true });
    writeFileSync(join(state, "skills/.skill-lock.json"), JSON.stringify({ version: 3, skills: { [name]: lockEntry(name) } }));
    expect(inspectSkillInstallation(home, { XDG_STATE_HOME: state }, "cloud", dir)).toMatchObject({ kind: "npx", lockPath: join(state, "skills/.skill-lock.json") });
    expect(inspectSkillInstallation(home, {}, "cloud", dir)).toMatchObject({ kind: "unknown" });
  });

  it("POSITIVE CONTROL: a copied pack stamped at one version is a legacy candidate at that version", () => {
    expect(inspectSkillInstallation(tempHome(), {}, "cloud", cloudPack(OLD))).toMatchObject({ kind: "legacy", candidate: true, version: OLD, reason: "commit_unrecorded" });
  });

  it("copied skills stamped at two versions, or a stamped skill the global lock also names, are unknown", () => {
    const mixed = cloudPack(OLD);
    writeFileSync(join(mixed, "unstick", "SKILL.md"), `---\nname: unstick\ndescription: fixture\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills@${NEXT} — fixture -->\n`);
    expect(inspectSkillInstallation(tempHome(), {}, "cloud", mixed)).toMatchObject({ present: true, candidate: false, reason: "installation_owner_unknown" });
    const home = tempHome();
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/.skill-lock.json"), JSON.stringify({ version: 3, skills: { "catalyst-onboard": lockEntry("catalyst-onboard", { source: "someone/else" }) } }));
    expect(inspectSkillInstallation(home, {}, "cloud", cloudPack(OLD))).toMatchObject({ present: true, candidate: false, reason: "installation_owner_unknown" });
  });

  it("a lock owner record without a usable process id, or an unreadable one, reads busy", () => {
    const home = tempHome();
    mkdirSync(configDirFor(home), { recursive: true });
    const lock = join(configDirFor(home), ".skill-update.lock");
    for (const body of [JSON.stringify({ pid: -1 }), JSON.stringify({ pid: "1" }), "{"]) {
      writeFileSync(lock, body);
      expect(withSkillUpdateLock(home, "busy", () => "entered")).toBe("busy");
      expect(readFileSync(lock, "utf8")).toBe(body);
    }
  });

  it("a missing directory is absent; a Dev pack is present only when its own skill is there", () => {
    const home = tempHome();
    expect(inspectSkillInstallation(home, {}, "cloud", join(home, "nowhere"))).toMatchObject({ present: false, candidate: false });
    const dev = empty();
    expect(inspectSkillInstallation(home, {}, "dev", dev)).toMatchObject({ present: false });
    mkdirSync(join(dev, "research-codebase"));
    writeFileSync(join(dev, "research-codebase", "SKILL.md"), "---\nname: research-codebase\n---\n");
    expect(inspectSkillInstallation(home, {}, "dev", dev)).toMatchObject({ present: true, candidate: false, kind: "unknown" });
  });
});

describe("an interrupted update's journal is refused unless every part of it is the expected shape", () => {
  const setup = () => {
    const home = tempHome(), f = skillRepository();
    const source = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
    if (!source.ok) throw new Error(source.detail);
    const dir = join(home, ".claude/skills");
    mkdirSync(dir, { recursive: true });
    cpSync(join(source.dir, "skills", f.name), join(dir, f.name), { recursive: true });
    const path = join(dir, f.name);
    writeSkillReceipt(home, { pack: "cloud", ...f.target, commit: "3".repeat(40), kind: "legacy", dir, destinations: [{ name: f.name, path, links: [], digest: contentDigest(path), skillPath: `skills/${f.name}` }] });
    const destination = inspectSkillInstallation(home, {}, "cloud", dir).destinations[0];
    if (!destination) throw new Error("missing fixture destination");
    const receiptBefore = readFileSync(join(configDirFor(home), "skill-installations.json"), "utf8");
    const journal = { pack: "cloud", dir, kind: "legacy", replacements: [{ destination, backup: `${path}.catalyst-backup`, staged: `${path}.catalyst-staged`, retired: false }], receiptBefore, lockBefore: null };
    return { home, f, dir, path, destination, journal };
  };
  type Fixture = ReturnType<typeof setup>;
  const item = (x: Fixture, over: Record<string, unknown>) => ({ ...x.journal, replacements: [{ ...x.journal.replacements[0], ...over }] });
  const dest = (x: Fixture, over: Record<string, unknown>) => item(x, { destination: { ...x.destination, ...over } });

  it("POSITIVE CONTROL: the well-formed journal recovers and the update goes on", () => {
    const x = setup();
    writeFileSync(join(configDirFor(x.home), ".skill-transaction.json"), JSON.stringify(x.journal));
    expect(applyPackUpdate(x.home, {}, "cloud", x.dir, x.f.target)).toMatchObject({ outcome: "updated", commit: x.f.target.commit });
  });

  const cases: [string, (x: Fixture) => unknown][] = [
    ["another pack", (x) => ({ ...x.journal, pack: "dev" })],
    ["another directory", (x) => ({ ...x.journal, dir: join(x.home, "elsewhere") })],
    ["an unknown kind", (x) => ({ ...x.journal, kind: "copy" })],
    ["replacements that are not a list", (x) => ({ ...x.journal, replacements: {} })],
    ["a prior receipt that is not text", (x) => ({ ...x.journal, receiptBefore: 5 })],
    ["a prior lock that is not text", (x) => ({ ...x.journal, lockBefore: 5 })],
    ["a global install with no lock path", (x) => ({ ...x.journal, kind: "npx", lockBefore: "{}" })],
    ["a copied install that names a lock path", (x) => ({ ...x.journal, lockPath: join(x.home, "lock.json") })],
    ["a replacement that is not a record", (x) => ({ ...x.journal, replacements: ["x"] })],
    ["a skill name that is not a plain name", (x) => dest(x, { name: ".hidden" })],
    ["a skill path outside the directory", (x) => dest(x, { path: join(x.home, "elsewhere", x.destination.name) })],
    ["a digest that is not a digest", (x) => dest(x, { digest: "abc" })],
    ["a link outside the agent skill roots", (x) => dest(x, { links: [join(x.home, "elsewhere", x.destination.name)] })],
    ["a backup at another path", (x) => item(x, { backup: `${x.path}.old` })],
    ["a backup whose bytes are not the recorded ones", (x) => {
      mkdirSync(`${x.path}.catalyst-backup`);
      writeFileSync(join(`${x.path}.catalyst-backup`, "SKILL.md"), "not the recorded bytes");
      return x.journal;
    }],
    ["a link that is a plain directory", (x) => {
      const link = join(x.home, ".codex/skills", x.destination.name);
      mkdirSync(link, { recursive: true });
      return dest(x, { links: [link] });
    }],
    ["a committed journal whose receipt has since changed", (x) => ({ ...x.journal, committed: true, receiptAfter: "{}" })],
  ];
  it.each(cases)("%s fails recovery and changes nothing", (_label, journal) => {
    const x = setup();
    const path = join(configDirFor(x.home), ".skill-transaction.json");
    writeFileSync(path, JSON.stringify(journal(x)));
    const before = { journal: readFileSync(path, "utf8"), skill: contentDigest(x.path), receipt: readFileSync(join(configDirFor(x.home), "skill-installations.json"), "utf8") };
    expect(applyPackUpdate(x.home, {}, "cloud", x.dir, x.f.target)).toEqual({ outcome: "failed", detail: "recovery_failed", version: null, commit: null });
    expect({ journal: readFileSync(path, "utf8"), skill: contentDigest(x.path), receipt: readFileSync(join(configDirFor(x.home), "skill-installations.json"), "utf8") }).toEqual(before);
  });
});
