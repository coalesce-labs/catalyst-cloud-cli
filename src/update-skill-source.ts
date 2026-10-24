// Exact approved Git checkouts. No lifecycle scripts or floating branches are executed.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { exactVersion, SKILL_PACK_REPOSITORIES, type SkillPack, type ApprovedSkillPack } from "./approved-release.js";
import { configDirFor } from "./config.js";
import { spawnCliCommand, type CliExec } from "./update-cli.js";

export type { SkillPack } from "./approved-release.js";
export interface SkillSourceDeps {
  exec?: CliExec;
  env?: NodeJS.ProcessEnv;
  /** Test transport only; production always uses the allowlisted GitHub repository. */
  repositoryUrl?: (repository: string) => string;
}
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const safeName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
export const repositoryFor = (pack: SkillPack): string => SKILL_PACK_REPOSITORIES[pack];
export const skillReleaseDir = (home: string, pack: SkillPack, commit: string): string => join(configDirFor(home), "skill-releases", pack, commit);

/** Hash all bytes, names and executable modes, including ignored and untracked files.
 * Hash checkout metadata links without following them. Skill trees and manifests
 * still refuse symlinks, and special files are refused everywhere. */
export function contentDigest(dir: string, checkout = false): string {
  const hash = createHash("sha256");
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (!checkout || relative === "" || ["skills", "package.json", ".claude-plugin"].some((root) => relative === root || relative.startsWith(`${root}/`))) throw new Error("unsafe_path");
      const target = readlinkSync(path);
      const resolved = resolve(dirname(path), target);
      if (isAbsolute(target) || resolved !== resolve(dir) && !resolved.startsWith(`${resolve(dir)}${sep}`)) throw new Error("unsafe_path");
      hash.update(`symlink\0${relative}\0${target}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${relative}\0`);
      for (const name of readdirSync(path).sort()) {
        if (checkout && relative === "" && name === ".git") continue;
        if (name === ".git") throw new Error("unsafe_path");
        visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      hash.update(`file\0${relative}\0${stat.mode & 0o111 ? "executable" : "regular"}\0${bytes.length}\0`);
      hash.update(bytes);
    } else throw new Error("unsafe_path");
  };
  visit(dir, "");
  return hash.digest("hex");
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...clean, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

/** Git's tree identity for global skills-lock v3, with a private index and forced ignored files. */
export function skillTreeHash(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  contentDigest(dir);
  const temporary = mkdtempSync(join(tmpdir(), "catalyst-skill-index-"));
  const run = (args: string[]) => {
    const result = spawnCliCommand(["git", "-c", "core.hooksPath=/dev/null", ...args], temporary, gitEnv(env));
    if (result.status !== 0) throw new Error("tree_hash_failed");
    return result.stdout.trim();
  };
  try {
    run(["init", "--bare", "--quiet"]);
    const prefix = [`--git-dir=${temporary}`, `--work-tree=${dir}`, "-c", "core.fileMode=true", "-c", "core.autocrlf=false"];
    run([...prefix, "add", "--force", "--all", "--", "."]);
    return run([...prefix, "write-tree"]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export type SkillSourceResult = { ok: true; dir: string; digest: string } | { ok: false; detail: string };

function verifyManifest(dir: string, target: ApprovedSkillPack): void {
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!record(manifest) || manifest.version !== target.version) throw new Error("source_mismatch");
  if (!readdirSync(join(dir, "skills")).some((name) => safeName(name) && existsSync(join(dir, "skills", name, "SKILL.md")))) throw new Error("source_mismatch");
  for (const name of readdirSync(join(dir, "skills"))) if (!safeName(name)) throw new Error("unsafe_path");
  const plugin = join(dir, ".claude-plugin", "plugin.json");
  if (existsSync(plugin)) {
    const value: unknown = JSON.parse(readFileSync(plugin, "utf8"));
    if (!record(value) || value.version !== target.version) throw new Error("source_mismatch");
  }
}

/** Read-only cache verification also used by plugin inventory. */
export function verifiedSkillSource(home: string, pack: SkillPack, target: ApprovedSkillPack): { dir: string; digest: string } | null {
  try {
    if (target.repository !== repositoryFor(pack) || !/^[a-f0-9]{40}$/.test(target.commit) || exactVersion(target.version) === null) return null;
    const dir = skillReleaseDir(home, pack, target.commit);
    const saved: unknown = JSON.parse(readFileSync(`${dir}.json`, "utf8"));
    if (!record(saved) || saved.commit !== target.commit || saved.version !== target.version || saved.repository !== target.repository) return null;
    verifyManifest(dir, target);
    const digest = contentDigest(dir, true);
    return digest === saved.digest ? { dir, digest } : null;
  } catch { return null; }
}

export function stageSkillSource(home: string, pack: SkillPack, target: ApprovedSkillPack, deps: SkillSourceDeps = {}): SkillSourceResult {
  if (target.repository !== repositoryFor(pack) || !/^[a-f0-9]{40}$/.test(target.commit) || exactVersion(target.version) === null) return { ok: false, detail: "source_mismatch" };
  const final = skillReleaseDir(home, pack, target.commit);
  if (existsSync(final)) {
    const verified = verifiedSkillSource(home, pack, target);
    return verified ? { ok: true, ...verified } : { ok: false, detail: "local_changes" };
  }
  const parent = join(configDirFor(home), "skill-releases", pack);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, ".staging-"));
  const exec = deps.exec ?? spawnCliCommand;
  const env = gitEnv(deps.env ?? process.env);
  const run = (...args: string[]) => {
    const result = exec(["git", "-c", "core.hooksPath=/dev/null", ...args], staging, env);
    if (result.status !== 0) throw new Error("fetch_failed");
    return result.stdout.trim();
  };
  try {
    run("init", "--quiet");
    run("fetch", "--depth=1", "--no-tags", "--", deps.repositoryUrl?.(target.repository) ?? `https://github.com/${target.repository}.git`, target.commit);
    run("-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD");
    if (run("rev-parse", "HEAD") !== target.commit) throw new Error("source_mismatch");
    const digest = contentDigest(staging, true);
    verifyManifest(staging, target);
    writeFileSync(`${final}.json`, JSON.stringify({ ...target, digest }), { mode: 0o600 });
    renameSync(staging, final);
    return { ok: true, dir: final, digest };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "fetch_failed" };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
