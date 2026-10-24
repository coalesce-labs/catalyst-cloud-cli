// agent-repoint.ts — CTC-6975. A machine set up before 0.16.33 runs its runner update agent from a CLI
// that can never move itself: those CLIs read no approved component release on a self-hosted machine,
// so the agent's own copy stays where it was installed, while the daily job installs the newest CLI
// into its own global prefix. npm runs this from that install (bin/postinstall.js) and points an older
// agent at the copy updates do move.
//
// It only ever moves the agent forward, touches only this CLI's own agent, keeps the agent's runner
// directory and PATH, and never fails the install. The agent file it replaces is kept beside it, named
// `<file>.before-<version>`, which neither launchd nor systemd loads: that copy is the rollback.
// Removing the stale CLI copy is the installer's job.
import { accessSync, appendFileSync, constants, copyFileSync, existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, exactVersion } from "./approved-release.js";
import { LEGACY_PACKAGE_NAME, readManifest } from "./config.js";
import {
  AUTO_UPDATE_LABEL,
  defaultRun,
  enableAutoUpdate,
  launchAgentPath,
  scheduledPath,
  systemdUnitPaths,
  writeFileAtomic,
  type AutoUpdateStatus,
  type SchedulerRun,
} from "./runner-auto-update.js";
import { CLAUDE_PATH_ENV, resolveClaude } from "./update-plugin.js";

export interface RepointDeps {
  platform?: NodeJS.Platform;
  home: string;
  uid?: number;
  /** The `catalyst` command this install put on PATH. */
  self: string;
  /** This install's version. */
  version: string;
  /** The node running this install, so the agent's PATH finds it. */
  nodeExecutable: string;
  env: NodeJS.ProcessEnv;
  run?: SchedulerRun;
  /** Whether this person may change a file or create one in a directory; tests pass a fake. */
  canWrite?: (path: string) => boolean;
  /** Blocks for `ms`; tests pass a fake clock. */
  sleep?: (ms: number) => void;
  /** How long to wait for a running macOS agent to finish before leaving it alone. */
  busyWaitMs?: number;
}

/** Long enough for an in-place update (under a minute on a Mac measured 2026-10-24), well inside the
 *  installer's 600-second budget for the whole npm install. */
export const BUSY_WAIT_MS = 240_000;
const BUSY_POLL_MS = 5_000;

const blockingSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type RepointResult =
  | { action: "skipped"; reason: "unsupported_platform" | "no_agent" | "agent_unrecognized" | "already_current" | "agent_cli_unrecognized" | "agent_cli_not_older" }
  /** A unit installed for this person by someone else (root, a package): only its owner may change it. */
  | { action: "skipped"; reason: "agent_not_writable"; agent: string }
  /** Reloading a macOS agent stops a run in progress, so a busy agent is left for the next install. */
  | { action: "skipped"; reason: "agent_busy" }
  | { action: "repointed"; from: string; fromVersion: string | null; to: string; backup: string }
  | { action: "failed"; detail: string };

interface AgentProgram {
  cli: string;
  dir: string;
  path: string | null;
  claude: string | null;
}

const unxml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The agent's command, from a plist this CLI wrote (launchAgentPlist). Anything else is unrecognized. */
function plistProgram(text: string): AgentProgram | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (array === undefined) return null;
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1] ?? ""));
  const env = (key: string) => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(text);
    return m ? unxml(m[1] ?? "") : null;
  };
  return programOf(args, env("PATH"), env(CLAUDE_PATH_ENV));
}

/** systemd's quoted words, as systemdUnits writes them. */
function unitWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1").replace(/%%/g, "%"));
}

function unitProgram(text: string): AgentProgram | null {
  const lines = text.split("\n");
  const exec = lines.find((l) => l.startsWith("ExecStart="));
  if (exec === undefined) return null;
  const envs = lines.filter((l) => l.startsWith("Environment=")).flatMap((l) => unitWords(l));
  const env = (key: string) => envs.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  return programOf(unitWords(exec), env("PATH"), env(CLAUDE_PATH_ENV));
}

function programOf(args: string[], path: string | null, claude: string | null): AgentProgram | null {
  const [cli, ...rest] = args;
  if (cli === undefined || !cli.startsWith("/") || rest.length !== 5) return null;
  const [a, b, c, d, dir] = rest;
  if (a !== "runner" || b !== "update" || c !== "--auto" || d !== "--dir" || dir === undefined || !dir.startsWith("/")) return null;
  return { cli, dir, path, claude };
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** The version of the catalyst package a command belongs to, or null when it is not one. */
export function cliVersionAt(command: string): string | null {
  const resolved = real(command);
  if (resolved === null) return null;
  let dir = dirname(resolved);
  for (let i = 0; i < 4; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@catalyst-cloud/cli" || pkg.name === LEGACY_PACKAGE_NAME) return exactVersion(pkg.version);
      } catch {
        return null;
      }
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}

/** Whether the macOS agent is idle, waiting up to the budget for a running update to finish. */
function waitIdle(deps: RepointDeps): boolean {
  const run = deps.run ?? defaultRun;
  const sleep = deps.sleep ?? blockingSleep;
  const target = `gui/${deps.uid ?? process.getuid?.() ?? 0}/${AUTO_UPDATE_LABEL}`;
  for (let waited = 0; ; waited += BUSY_POLL_MS) {
    if (!/^\s*state = running\s*$/m.test(run("launchctl", ["print", target]).stdout)) return true;
    if (waited >= (deps.busyWaitMs ?? BUSY_WAIT_MS)) return false;
    sleep(BUSY_POLL_MS);
  }
}

/** Put the agent file back and load it again, best effort, then drop the backup. */
function restore(deps: RepointDeps, platform: NodeJS.Platform, agent: string, original: Buffer, backup: string): void {
  if (!existsSync(agent) || !readFileSync(agent).equals(original)) {
    writeFileAtomic(agent, original.toString("utf8"));
    const run = deps.run ?? defaultRun;
    try {
      if (platform === "darwin") run("launchctl", ["bootstrap", `gui/${deps.uid ?? process.getuid?.() ?? 0}`, agent]);
      else run("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // the file is back; the scheduler picks it up at the next login or reload
    }
  }
  unlinkSync(backup);
}

/** Point an older runner update agent at this install. Never throws. */
export function repointAgent(deps: RepointDeps): RepointResult {
  try {
    const platform = deps.platform ?? process.platform;
    let program: AgentProgram | null;
    let agent: string;
    if (platform === "darwin") {
      agent = launchAgentPath(deps.home);
      if (!existsSync(agent)) return { action: "skipped", reason: "no_agent" };
      program = plistProgram(readFileSync(agent, "utf8"));
    } else if (platform === "linux") {
      agent = systemdUnitPaths(deps.home).service;
      if (!existsSync(agent)) return { action: "skipped", reason: "no_agent" };
      program = unitProgram(readFileSync(agent, "utf8"));
    } else {
      return { action: "skipped", reason: "unsupported_platform" };
    }
    if (program === null) return { action: "skipped", reason: "agent_unrecognized" };

    const from = real(program.cli);
    if (from !== null && from === real(deps.self)) return { action: "skipped", reason: "already_current" };
    // A program that no longer exists runs nothing, so any working copy is better. One that exists
    // moves only when it is a catalyst CLI older than this one.
    let fromVersion: string | null = null;
    if (from !== null) {
      fromVersion = cliVersionAt(program.cli);
      if (fromVersion === null) return { action: "skipped", reason: "agent_cli_unrecognized" };
      if (compareVersions(fromVersion, deps.version) >= 0) return { action: "skipped", reason: "agent_cli_not_older" };
    }
    const canWrite = deps.canWrite ?? writable;
    const files = platform === "linux" ? [agent, systemdUnitPaths(deps.home).timer].filter((f) => existsSync(f)) : [agent];
    if (![...files, dirname(agent)].every(canWrite)) return { action: "skipped", reason: "agent_not_writable", agent };
    // launchctl bootout stops a running job, and the daily job starts on the same quarter hour as the
    // agent does: wait for an update in progress to finish rather than cut it off.
    if (platform === "darwin" && !waitIdle(deps)) return { action: "skipped", reason: "agent_busy" };
    const original = readFileSync(agent);
    const backup = `${agent}.before-${deps.version}`;
    copyFileSync(agent, backup);
    let status: AutoUpdateStatus | undefined;
    try {
      status = enableAutoUpdate(
        {
          platform,
          home: deps.home,
          uid: deps.uid,
          cli: deps.self,
          path: scheduledPath(deps.self, deps.nodeExecutable, program.path ?? deps.env.PATH),
          claude: program.claude ?? resolveClaude(deps.home, deps.env),
          run: deps.run,
        },
        program.dir,
      );
    } finally {
      // A repoint that did not take puts the agent back exactly as it was, and leaves no backup.
      if (status?.state !== "on") restore(deps, platform, agent, original, backup);
    }
    if (status.state !== "on") return { action: "failed", detail: status.detail };
    const result: RepointResult = { action: "repointed", from: program.cli, fromVersion, to: deps.self, backup };
    try {
      appendFileSync(join(program.dir, "update.log"), `${new Date().toISOString()} ${repointLine(result, deps.version)}\n`);
    } catch {
      // the agent's log is a courtesy; the agent itself is already moved
    }
    return result;
  } catch (err) {
    return { action: "failed", detail: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}

/** One line for the person, or null when there is nothing to say. */
export function repointLine(result: RepointResult, version: string): string | null {
  if (result.action === "repointed")
    return `catalyst: the runner update agent now runs ${result.to} (${version}) instead of ${result.from} (${result.fromVersion ?? "missing"}). The previous agent file is kept at ${result.backup}.`;
  if (result.action === "skipped" && result.reason === "agent_not_writable")
    return `catalyst: the runner update agent at ${result.agent} runs an older catalyst, and this install cannot change it. Ask whoever installed it to run: catalyst runner auto-update on`;
  if (result.action === "skipped" && result.reason === "agent_busy")
    return "catalyst: the runner update agent was busy updating, so it keeps its current catalyst until the next install. Or run: catalyst runner auto-update on";
  if (result.action === "failed")
    return `catalyst: could not point the runner update agent at this install (${result.detail}). Run: catalyst runner auto-update on`;
  return null;
}

/** npm's postinstall, for a global install: this install's own command, version and node. */
export function postinstallRepoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const version = readManifest().version;
  const linked = env.npm_config_prefix ? join(env.npm_config_prefix, "bin", "catalyst") : null;
  const self = linked !== null && existsSync(linked) ? linked : fileURLToPath(new URL("../bin/catalyst.js", import.meta.url));
  const home = env.HOME;
  if (!home) return null;
  return repointLine(repointAgent({ home, self, version, nodeExecutable: process.execPath, env }), version);
}
