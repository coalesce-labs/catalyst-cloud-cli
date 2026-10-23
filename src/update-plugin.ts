// update-plugin.ts — the Claude plugin form of the Cloud skills pack moves with the release check
// (CTC-6791). Claude Code installs the plugin from its own marketplace checkout of this repository,
// which serves the repository's head, so the release check moves it only when that checkout carries
// exactly the approved version: it refreshes the marketplace, reads the plugin version the checkout
// now serves, and asks Claude Code to update the plugin only when that version is the approved one.
// Claude Code has no way to install a plugin at a pinned version, so a marketplace ahead of the
// approval leaves the plugin where it is. The 15-minute schedule finds `claude` at the absolute path
// recorded when it was set up, then on PATH, then in Claude Code's usual install locations; only when
// none has it is nothing changed, and the report names the command.
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { exactVersion } from "./approved-release.js";
import { spawnCliCommand, type CliExec } from "./update-cli.js";

export const CLOUD_MARKETPLACE = "catalyst-cloud";
export const CLOUD_PLUGIN_ID = `catalyst@${CLOUD_MARKETPLACE}`;
/** The one command that moves the plugin, for an owner whose release check cannot run Claude Code. */
export const CLOUD_PLUGIN_COMMAND = `claude plugin marketplace update ${CLOUD_MARKETPLACE} && claude plugin update ${CLOUD_PLUGIN_ID}`;

export type PluginInventory =
  | { state: "not_installed" }
  /** `claude` is the command that can move it, or null when none was found. */
  | { state: "installed"; version: string; scope: string; claude: string | null }
  | { state: "unknown"; reason: string };

export interface PluginApplyResult {
  /** `no_claude`: no `claude` command was found, so nothing ran. `waiting`: the marketplace does not serve the approved version. */
  outcome: "updated" | "failed" | "waiting" | "no_claude";
  /** `updated`, or why not: `marketplace_update_failed`, `marketplace_not_approved`, `update_failed`, `verify_failed`. */
  detail: string;
  /** The plugin version Claude Code records after this call, when one reads. */
  version: string | null;
}

export interface PluginApplyDeps {
  exec?: CliExec;
  /** The `claude` command to run; resolved with `resolveClaude` when absent. */
  claudePath?: string | null;
}

export function claudeConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The Cloud plugin as Claude Code records it: its user-scope install when there is one, else the first. */
export function cloudPluginInventory(home: string, env: NodeJS.ProcessEnv): PluginInventory {
  let registry: unknown;
  try {
    registry = readJson(join(claudeConfigDir(home, env), "plugins", "installed_plugins.json"));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { state: "not_installed" } : { state: "unknown", reason: "plugin_registry_unreadable" };
  }
  const entries = isRecord(registry) && isRecord(registry.plugins) ? registry.plugins[CLOUD_PLUGIN_ID] : undefined;
  if (!Array.isArray(entries) || entries.length === 0) return { state: "not_installed" };
  const entry = entries.find((e) => isRecord(e) && e.scope === "user") ?? entries[0];
  const version = isRecord(entry) ? exactVersion(entry.version) : null;
  if (version === null) return { state: "unknown", reason: "version_unreadable" };
  return { state: "installed", version, scope: isRecord(entry) && typeof entry.scope === "string" ? entry.scope : "user", claude: resolveClaude(home, env) };
}

/** The plugin version the marketplace checkout serves now, or null when it cannot be read. */
function servedPluginVersion(home: string, env: NodeJS.ProcessEnv): string | null {
  const plugins = join(claudeConfigDir(home, env), "plugins");
  let dir = join(plugins, "marketplaces", CLOUD_MARKETPLACE);
  try {
    const known = readJson(join(plugins, "known_marketplaces.json"));
    const entry = isRecord(known) ? known[CLOUD_MARKETPLACE] : undefined;
    if (isRecord(entry) && typeof entry.installLocation === "string") dir = entry.installLocation;
  } catch {
    // No record of where it lives: Claude Code's default checkout directory.
  }
  try {
    const manifest = readJson(join(dir, ".claude-plugin", "plugin.json"));
    return isRecord(manifest) ? exactVersion(manifest.version) : null;
  } catch {
    return null;
  }
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

/** Move the Cloud plugin to exact version `target` through Claude Code, when its marketplace serves it. */
export function applyCloudPluginUpdate(home: string, env: NodeJS.ProcessEnv, target: string, scope: string, deps: PluginApplyDeps = {}): PluginApplyResult {
  const claude = deps.claudePath === undefined ? resolveClaude(home, env) : deps.claudePath;
  if (claude === null) return { outcome: "no_claude", detail: "claude_not_found", version: null };
  const exec = deps.exec ?? spawnCliCommand;
  if (exec([claude, "plugin", "marketplace", "update", CLOUD_MARKETPLACE], home, env).status !== 0)
    return { outcome: "failed", detail: "marketplace_update_failed", version: null };
  if (servedPluginVersion(home, env) !== target) return { outcome: "waiting", detail: "marketplace_not_approved", version: null };
  const updated = exec([claude, "plugin", "update", CLOUD_PLUGIN_ID, "--scope", scope], home, env).status === 0;
  const now = cloudPluginInventory(home, env);
  const version = now.state === "installed" ? now.version : null;
  if (!updated) return { outcome: "failed", detail: "update_failed", version };
  return version === target ? { outcome: "updated", detail: "updated", version } : { outcome: "failed", detail: "verify_failed", version };
}
