// Select the verified approved Cloud checkout through Claude's supported marketplace commands.
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { exactVersion, type ApprovedSkillPack } from "./approved-release.js";
import { spawnCliCommand, type CliExec } from "./update-cli.js";
import { contentDigest, record, repositoryFor, skillReleaseDir, stageSkillSource, verifiedSkillSource, type SkillSourceDeps } from "./update-skill-source.js";
import { plainDirectory } from "./update-skill-state.js";
import { withSkillUpdateLock } from "./update-skills.js";

export const CLOUD_MARKETPLACE = "catalyst-cloud";
export const CLOUD_PLUGIN_ID = `catalyst@${CLOUD_MARKETPLACE}`;
export const CLOUD_PLUGIN_COMMAND = "catalyst update";
interface PluginSource { kind: "git" | "directory"; argument: string; dir: string; commit: string | null; gitUrl?: string }
export type PluginInventory =
  | { state: "not_installed" }
  | { state: "installed"; version: string; scope: "user"; claude: string | null; commit: string | null; source: PluginSource }
  | { state: "unknown"; reason: string };
export interface PluginApplyResult {
  outcome: "updated" | "failed" | "no_claude";
  detail: string;
  version: string | null;
  commit?: string | null;
}
export interface PluginApplyDeps extends SkillSourceDeps {
  exec?: CliExec;
  claudePath?: string | null;
}
export function claudeConfigDir(home: string, env: NodeJS.ProcessEnv): string { return env.CLAUDE_CONFIG_DIR || join(home, ".claude"); }
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const cloudGitSource = (source: Record<string, unknown>): string | null => {
  if (source.source === "github" && source.repo === repositoryFor("cloud")) return `https://github.com/${repositoryFor("cloud")}.git`;
  if (source.source === "git" && (source.url === `https://github.com/${repositoryFor("cloud")}.git` || source.url === `https://github.com/${repositoryFor("cloud")}`)) return String(source.url);
  return null;
};

/** A project or managed declaration must not be redirected by a home-directory updater. */
function hasOverride(home: string, env: NodeJS.ProcessEnv, entries: unknown[]): boolean {
  if (entries.some((entry) => !record(entry) || entry.scope !== "user")) return true;
  const config = claudeConfigDir(home, env);
  const files = [join(config, "managed-settings.json"), join(config, "settings.local.json")];
  if (process.platform === "linux") files.push("/etc/claude-code/managed-settings.json");
  if (process.platform === "darwin") files.push("/Library/Application Support/ClaudeCode/managed-settings.json");
  if (process.platform === "win32" && env.ProgramFiles) files.push(join(env.ProgramFiles, "ClaudeCode/managed-settings.json"));
  // Claude records project identity even when another plugin owns that scope.
  const registry = readJson(join(config, "plugins/installed_plugins.json"));
  if (record(registry) && record(registry.plugins)) for (const values of Object.values(registry.plugins)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (record(value) && typeof value.projectPath === "string") {
      files.push(join(value.projectPath, ".claude/settings.json"), join(value.projectPath, ".claude/settings.local.json"));
    }
  }
  let cwd = resolve(env.PWD ?? home);
  while (true) {
    files.push(join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json"));
    const parent = dirname(cwd); if (parent === cwd) break; cwd = parent;
  }
  for (const path of new Set(files)) {
    if (path === join(config, "settings.json") || !existsSync(path)) continue;
    const value = readJson(path);
    if (record(value) && record(value.extraKnownMarketplaces) && value.extraKnownMarketplaces[CLOUD_MARKETPLACE] !== undefined) return true;
  }
  return false;
}

function pluginManifest(dir: string, version: string): boolean {
  try {
    const marketplace = readJson(join(dir, ".claude-plugin/marketplace.json"));
    const plugin = readJson(join(dir, ".claude-plugin/plugin.json"));
    if (!record(marketplace) || marketplace.name !== CLOUD_MARKETPLACE || !Array.isArray(marketplace.plugins)) return false;
    const entries = marketplace.plugins.filter((entry) => record(entry) && entry.name === "catalyst");
    if (entries.length !== 1 || !record(entries[0]) || entries[0].source !== "./") return false;
    if (!record(plugin) || plugin.name !== "catalyst" || plugin.version !== version) return false;
    const paths = typeof plugin.skills === "string" ? [plugin.skills] : plugin.skills;
    return Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && /^\.\/skills\/(?:[a-zA-Z0-9_-]+\/?)?$/.test(path) && plainDirectory(join(dir, path)));
  } catch { return false; }
}

export function cloudPluginInventory(home: string, env: NodeJS.ProcessEnv): PluginInventory {
  const config = claudeConfigDir(home, env);
  let registry: unknown;
  try { registry = readJson(join(config, "plugins/installed_plugins.json")); }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT" ? { state: "not_installed" } : { state: "unknown", reason: "plugin_registry_unreadable" }; }
  const entries = record(registry) && record(registry.plugins) ? registry.plugins[CLOUD_PLUGIN_ID] : undefined;
  if (!Array.isArray(entries) || entries.length === 0) return { state: "not_installed" };
  try {
    if (hasOverride(home, env, entries)) return { state: "unknown", reason: "plugin_scope_unsupported" };
    const entry = entries[0];
    const version = record(entry) ? exactVersion(entry.version) : null;
    if (version === null) return { state: "unknown", reason: "version_unreadable" };
    const known = readJson(join(config, "plugins/known_marketplaces.json"));
    const marketplace = record(known) ? known[CLOUD_MARKETPLACE] : null;
    const settings = readJson(join(config, "settings.json"));
    const declared = record(settings) && record(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces[CLOUD_MARKETPLACE] : null;
    if (!record(marketplace) || !record(marketplace.source) || typeof marketplace.installLocation !== "string" || !record(declared) || !record(declared.source) || marketplace.scope !== undefined && marketplace.scope !== "user") return { state: "unknown", reason: "installation_owner_unknown" };
    const source = marketplace.source;
    const dir = marketplace.installLocation;
    if (!plainDirectory(dir)) return { state: "unknown", reason: "installation_owner_unknown" };
    const git = cloudGitSource(source);
    if (git) {
      if (cloudGitSource(declared.source) !== git || source.ref !== declared.source.ref || source.ref !== undefined && (typeof source.ref !== "string" || source.ref.length === 0 || /[#\r\n]/.test(source.ref))) return { state: "unknown", reason: "source_mismatch" };
      return { state: "installed", version, scope: "user", claude: resolveClaude(home, env), commit: null, source: { kind: "git", argument: `${source.source === "github" ? repositoryFor("cloud") : git.replace(/\.git$/, "") + ".git"}${typeof source.ref === "string" ? `#${source.ref}` : ""}`, gitUrl: git, dir, commit: null } };
    }
    if (source.source !== "directory" || source.path !== dir || declared.source.source !== "directory" || declared.source.path !== dir) return { state: "unknown", reason: "source_mismatch" };
    const manifest = readJson(join(dir, "package.json"));
    const commit = dir.slice(dir.lastIndexOf("/") + 1);
    if (dir !== skillReleaseDir(home, "cloud", commit) || !/^[a-f0-9]{40}$/.test(commit) || !record(manifest) || exactVersion(manifest.version) === null) return { state: "unknown", reason: "installation_owner_unknown" };
    const target = { repository: repositoryFor("cloud"), version: String(manifest.version), commit };
    if (!verifiedSkillSource(home, "cloud", target)) return { state: "unknown", reason: "local_changes" };
    if (!pluginManifest(dir, version)) return { state: "unknown", reason: "source_mismatch" };
    return { state: "installed", version, scope: "user", claude: resolveClaude(home, env), commit, source: { kind: "directory", argument: dir, dir, commit } };
  } catch { return { state: "unknown", reason: "installation_owner_unknown" }; }
}
/** The schedule's record of the `claude` command found when it was set up. */
export const CLAUDE_PATH_ENV = "CATALYST_CLAUDE_PATH";

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The `claude` command: the schedule's recorded path, then PATH, then Claude Code's usual install locations. */
export function resolveClaude(home: string, env: NodeJS.ProcessEnv): string | null {
  const recorded = env[CLAUDE_PATH_ENV];
  const onPath = (env.PATH ?? "").split(delimiter).filter((d) => d.startsWith("/")).map((d) => join(d, "claude"));
  // Homebrew, /usr/local/bin and node's own directory are already on the schedule's PATH (scheduledPath).
  const usual = [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  return [...(recorded?.startsWith("/") ? [recorded] : []), ...onPath, ...usual].find(executable) ?? null;
}


export function applyCloudPluginUpdate(home: string, env: NodeJS.ProcessEnv, target: ApprovedSkillPack, pluginVersion: string, scope: string, deps: PluginApplyDeps = {}): PluginApplyResult {
  const failed = (detail: string): PluginApplyResult => ({ outcome: "failed", detail, version: null, commit: null });
  if (scope !== "user") return failed("plugin_scope_unsupported");
  const claude = deps.claudePath === undefined ? resolveClaude(home, env) : deps.claudePath;
  if (claude === null) return { outcome: "no_claude", detail: "claude_not_found", version: null };
  return withSkillUpdateLock(home, failed("update_in_progress"), () => {
    const before = cloudPluginInventory(home, env);
    if (before.state !== "installed") return failed(before.state === "unknown" ? before.reason : "not_installed");
    const exec = deps.exec ?? spawnCliCommand;
    const childEnv = { ...env, HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir(home, env), PWD: home };
    if (before.source.kind === "git") {
      // Only an unmodified, correctly sourced Git checkout can be adopted.
      const origin = spawnCliCommand(["git", "-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin"], before.source.dir, childEnv);
      const clean = spawnCliCommand(["git", "-c", "core.hooksPath=/dev/null", "status", "--porcelain", "--untracked-files=all", "--ignored"], before.source.dir, childEnv);
      if (origin.status !== 0 || origin.stdout.trim().replace(/\.git$/, "") !== before.source.gitUrl?.replace(/\.git$/, "")) return failed("source_mismatch");
      if (clean.status !== 0 || clean.stdout.trim() !== "") return failed("local_changes");
    }
    let beforeDigest: string;
    try { beforeDigest = contentDigest(before.source.dir, true); }
    catch { return failed("local_changes"); }
    const source = stageSkillSource(home, "cloud", target, { ...deps, env });
    if (!source.ok) return failed(source.detail);
    if (!pluginManifest(source.dir, pluginVersion)) return failed("source_mismatch");
    const unchanged = cloudPluginInventory(home, env);
    if (unchanged.state !== "installed" || unchanged.source.dir !== before.source.dir || unchanged.version !== before.version || contentDigest(before.source.dir, true) !== beforeDigest) return failed("source_mismatch");
    const select = (argument: string) => exec([claude, "plugin", "marketplace", "add", argument, "--scope", "user"], home, childEnv).status === 0;
    const update = () => exec([claude, "plugin", "update", CLOUD_PLUGIN_ID, "--scope", "user"], home, childEnv).status === 0;
    let failure: string;
    try {
      if (!select(source.dir)) failure = "marketplace_update_failed";
      else if (!update()) failure = "update_failed";
      else {
        const after = cloudPluginInventory(home, env);
        if (after.state === "installed" && after.source.dir === source.dir && after.commit === target.commit && after.version === pluginVersion && contentDigest(source.dir, true) === source.digest)
          return { outcome: "updated", detail: "approved_commit_installed", version: after.version, commit: after.commit };
        failure = "verify_failed";
      }
    } catch { failure = "update_failed"; }
    // Never remove the marketplace or hand-edit Claude's registries. Restore through the same API.
    try {
      const restored = select(before.source.argument);
      let now = cloudPluginInventory(home, env);
      if (restored && (now.state !== "installed" || now.version !== before.version)) {
        if (!update()) return failed("rollback_failed");
        now = cloudPluginInventory(home, env);
      }
      if (!restored || now.state !== "installed" || now.source.dir !== before.source.dir || now.version !== before.version || now.source.argument !== before.source.argument || contentDigest(now.source.dir, true) !== beforeDigest) return failed("rollback_failed");
    } catch { return failed("rollback_failed"); }
    return failed(failure);
  });
}
