import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_PATH_ENV } from "./update-plugin.js";

// The schedule that runs `catalyst runner update --auto` every 15 minutes (CTC-4646): a LaunchAgent
// on macOS, a systemd user timer on Linux. It runs as the person who set the runner up, with the
// docker command they use, and only ever calls this CLI. Turning it off removes exactly these files.

export const AUTO_UPDATE_LABEL = "dev.catalystcloud.runner-update";
export const AUTO_UPDATE_UNIT = "catalyst-runner-update";
export const AUTO_UPDATE_INTERVAL_SECONDS = 900;
/** The minutes past each hour the macOS schedule runs at: every 15 minutes. */
const CALENDAR_MINUTES = [0, 15, 30, 45] as const;

export type SchedulerRun = (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };

export interface AutoUpdateDeps {
  platform?: NodeJS.Platform;
  home: string;
  uid?: number;
  /** The `catalyst` executable the schedule runs. */
  cli: string;
  /** The node the schedule runs `cli` under; null runs `cli` by its own `#!/usr/bin/env node` line.
   *  Left out, macOS uses the node a thoughts custody was set up with, when there is one (CTC-7030). */
  node?: string | null;
  /** PATH for the scheduled run: it must find docker and node. */
  path: string;
  /** The `claude` command found at setup, recorded so the scheduled run can move the Claude plugin (CTC-6791). */
  claude?: string | null;
  run?: SchedulerRun;
}

/** What an installed schedule runs: the directory it updates, and whether that directory is a
 *  supervisor fleet's (compose.json) rather than a single runner's (CTC-6384). */
export interface ScheduleTarget {
  fleet: boolean;
  dir: string;
}

export type AutoUpdateStatus =
  /** `linger` is set on Linux only: whether the schedule keeps running after this person logs out.
   *  `lingerTurnedOn` says this call turned it on, so the person can be told how to undo it.
   *  `fleet` and `dir` are set when the installed schedule file could be read back. */
  | ({ state: "on"; detail: string; path: string; linger?: boolean; lingerTurnedOn?: boolean } & Partial<ScheduleTarget>)
  /** `linger` on a Linux `off`: lingering is left as it is, since it may have been on before setup. */
  | ({ state: "off"; detail: string; linger?: boolean } & Partial<ScheduleTarget>)
  | { state: "unsupported"; detail: string };

/** `su` and many ssh sessions leave XDG_RUNTIME_DIR unset, so `systemctl --user` cannot find a
 *  running user manager. Its socket is at /run/user/<uid>; use that when it exists. */
function schedulerEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  const runtime = uid === undefined ? undefined : `/run/user/${uid}`;
  return !process.env.XDG_RUNTIME_DIR && runtime && existsSync(runtime)
    ? { ...process.env, XDG_RUNTIME_DIR: runtime }
    : process.env;
}

/** Shared with the Codex attribution agent (codex-attribution.ts), which runs launchctl the same way. */
export const defaultRun: SchedulerRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, env: schedulerEnv() });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
};

export const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const unxml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** systemd's own quoting for one ExecStart/Environment word. */
const unitWord = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
/** systemd's quoted words, as systemdUnits writes them. */
export function unitWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1").replace(/%%/g, "%"));
}

/** The command the schedule runs. CTC-6384: a supervisor fleet's schedule adds --fleet, so each run
 *  updates the fleet's compose.json in `dir` instead of a single runner's .env. */
const updateArgs = (dir: string, fleet: boolean) => ["runner", "update", "--auto", ...(fleet ? ["--fleet"] : []), "--dir", dir];

export function launchAgentPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${AUTO_UPDATE_LABEL}.plist`);
}
export function systemdUnitPaths(home: string): { service: string; timer: string } {
  const base = join(home, ".config", "systemd", "user");
  return { service: join(base, `${AUTO_UPDATE_UNIT}.service`), timer: join(base, `${AUTO_UPDATE_UNIT}.timer`) };
}

export function launchAgentPlist(deps: Pick<AutoUpdateDeps, "cli" | "node" | "path" | "home" | "claude">, dir: string, fleet = false): string {
  const args = [...(deps.node ? [deps.node] : []), deps.cli, ...updateArgs(dir, fleet)];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${AUTO_UPDATE_LABEL}</string>`,
    `<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(deps.path)}</string><key>HOME</key><string>${xml(deps.home)}</string>${deps.claude ? `<key>${CLAUDE_PATH_ENV}</key><string>${xml(deps.claude)}</string>` : ""}</dict>`,
    // A calendar schedule, not StartInterval: on a busy Mac launchd held a StartInterval job as
    // "pended nondemand spawn" for hours (mini-2, 2026-10-17), and RunAtLoad was pended the same
    // way. The calendar entries fired on time on that same machine.
    `<key>StartCalendarInterval</key><array>${CALENDAR_MINUTES.map((m) => `<dict><key>Minute</key><integer>${m}</integer></dict>`).join("")}</array>`,
    "<key>ProcessType</key><string>Standard</string>",
    `<key>StandardOutPath</key><string>${xml(join(dir, "update.log"))}</string>`,
    `<key>StandardErrorPath</key><string>${xml(join(dir, "update.log"))}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

export function systemdUnits(deps: Pick<AutoUpdateDeps, "cli" | "path" | "claude">, dir: string, fleet = false): { service: string; timer: string } {
  return {
    service: [
      "[Unit]",
      "Description=Catalyst runner update",
      "",
      "[Service]",
      "Type=oneshot",
      `Environment=${unitWord(`PATH=${deps.path}`)}`,
      ...(deps.claude ? [`Environment=${unitWord(`${CLAUDE_PATH_ENV}=${deps.claude}`)}`] : []),
      `ExecStart=${[deps.cli, ...updateArgs(dir, fleet)].map(unitWord).join(" ")}`,
      "",
    ].join("\n"),
    timer: [
      "[Unit]",
      "Description=Check for an approved Catalyst runner release every 15 minutes",
      "",
      "[Timer]",
      // Wall-clock, not OnBootSec/OnUnitActiveSec: those are relative to boot and to the last run in
      // THIS user manager, so a manager that restarts without a reboot (enabling linger, a logout and
      // login) left the timer "elapsed" with no next run, forever (fresh Ubuntu 24.04, 2026-10-17).
      `OnCalendar=*:0/${AUTO_UPDATE_INTERVAL_SECONDS / 60}`,
      "RandomizedDelaySec=60",
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
}

/** A user timer runs only while this person's systemd user manager does, and without lingering that
 *  manager stops when they log out of a headless machine. */
function lingering(run: SchedulerRun, uid: number): boolean {
  return /Linger=yes/.test(run("loginctl", ["show-user", String(uid), "--property=Linger"]).stdout);
}

/** Turn lingering on for this person when it is off. On most distributions polkit lets a user in an
 *  active session, SSH included, do this without sudo (CTC-6264). --no-ask-password: a refusal must
 *  come back as an answer, never as a prompt. Returns the state read back afterwards. */
function ensureLingering(run: SchedulerRun, uid: number): { linger: boolean; turnedOn: boolean } {
  if (lingering(run, uid)) return { linger: true, turnedOn: false };
  run("loginctl", ["--no-ask-password", "enable-linger"]);
  const linger = lingering(run, uid);
  return { linger, turnedOn: linger };
}

/** Shared with the Codex attribution agent's plist (codex-attribution.ts). */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, path);
}

/** The installed schedule's own command, read back from the file this CLI wrote. Null when the file
 *  is missing or names no update directory. */
function installedTarget(platform: NodeJS.Platform, home: string): ScheduleTarget | null {
  let args: string[];
  try {
    if (platform === "darwin") {
      const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(launchAgentPath(home), "utf8"))?.[1];
      args = array === undefined ? [] : [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1] ?? ""));
    } else {
      const exec = readFileSync(systemdUnitPaths(home).service, "utf8").split("\n").find((l) => l.startsWith("ExecStart="));
      args = exec === undefined ? [] : unitWords(exec);
    }
  } catch {
    return null;
  }
  const at = args.indexOf("--dir");
  const dir = at === -1 ? undefined : args[at + 1];
  if (!args.includes("update") || dir === undefined || !dir.startsWith("/")) return null;
  return { fleet: args.includes("--fleet"), dir };
}

export function autoUpdateStatus(deps: AutoUpdateDeps): AutoUpdateStatus {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  const target = () => installedTarget(platform, deps.home) ?? {};
  if (platform === "darwin") {
    const path = launchAgentPath(deps.home);
    if (!existsSync(path)) return { state: "off", detail: "no_launch_agent" };
    const loaded = run("launchctl", ["print", `gui/${deps.uid ?? process.getuid?.() ?? 0}/${AUTO_UPDATE_LABEL}`]).status === 0;
    return loaded
      ? { state: "on", detail: "launch_agent_loaded", path, ...target() }
      : { state: "off", detail: "launch_agent_not_loaded", ...target() };
  }
  if (platform === "linux") {
    const { timer } = systemdUnitPaths(deps.home);
    if (!existsSync(timer)) return { state: "off", detail: "no_timer" };
    const enabled = run("systemctl", ["--user", "is-enabled", `${AUTO_UPDATE_UNIT}.timer`]);
    if (enabled.status !== 0) return { state: "off", detail: "timer_not_enabled", ...target() };
    const linger = lingering(run, deps.uid ?? process.getuid?.() ?? 0);
    return { state: "on", detail: linger ? "timer_enabled" : "timer_enabled_without_linger", path: timer, linger, ...target() };
  }
  return { state: "unsupported", detail: `platform_${platform}` };
}

/** CTC-7030: the node a Mac's thoughts custody was set up with, when that node is still there. The
 *  custody records it by path and hash beside the runner directory, and every update re-attests the
 *  custody under the node that runs it, refusing any other. A CLI installed under a different node
 *  (the daily job's own prefix) must therefore still run under this one. */
export function custodyNode(dir: string): string | null {
  try {
    const runtime = JSON.parse(readFileSync(join(dirname(dir), "darwin-thoughts-custody", "runtime.json"), "utf8")) as { nodeExecutable?: unknown };
    const node = runtime.nodeExecutable;
    if (typeof node !== "string" || !node.startsWith("/")) return null;
    accessSync(node, constants.X_OK);
    return node;
  } catch {
    return null;
  }
}

/** Install and start the schedule. Rewrites the files every time, so a moved CLI or PATH is picked up.
 *  `fleet` schedules a supervisor fleet's update of the compose.json in `dir` (CTC-6384). */
export function enableAutoUpdate(deps: AutoUpdateDeps, dir: string, { fleet = false }: { fleet?: boolean } = {}): AutoUpdateStatus {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  const target: ScheduleTarget = { fleet, dir };
  if (platform === "darwin") {
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    const path = launchAgentPath(deps.home);
    const text = launchAgentPlist({ ...deps, node: deps.node === undefined ? custodyNode(dir) : deps.node }, dir, fleet);
    const unchanged = existsSync(path) && readFileSync(path, "utf8") === text;
    const domain = `gui/${uid}`;
    const loaded = run("launchctl", ["print", `${domain}/${AUTO_UPDATE_LABEL}`]).status === 0;
    if (unchanged && loaded) return { state: "on", detail: "launch_agent_loaded", path, ...target };
    if (loaded) run("launchctl", ["bootout", `${domain}/${AUTO_UPDATE_LABEL}`]);
    writeFileAtomic(path, text);
    const boot = run("launchctl", ["bootstrap", domain, path]);
    return boot.status === 0
      ? { state: "on", detail: "launch_agent_loaded", path, ...target }
      : { state: "off", detail: `launchctl_bootstrap_failed:${boot.stderr.trim().slice(0, 160)}` };
  }
  if (platform === "linux") {
    if (run("systemctl", ["--user", "show-environment"]).status !== 0)
      return { state: "unsupported", detail: "no_systemd_user_manager" };
    const paths = systemdUnitPaths(deps.home);
    const units = systemdUnits(deps, dir, fleet);
    writeFileAtomic(paths.service, units.service);
    writeFileAtomic(paths.timer, units.timer);
    run("systemctl", ["--user", "daemon-reload"]);
    const enabled = run("systemctl", ["--user", "enable", "--now", `${AUTO_UPDATE_UNIT}.timer`]);
    if (enabled.status !== 0)
      return { state: "off", detail: `systemctl_enable_failed:${enabled.stderr.trim().slice(0, 160)}` };
    const { linger, turnedOn } = ensureLingering(run, deps.uid ?? process.getuid?.() ?? 0);
    return { state: "on", detail: linger ? "timer_enabled" : "timer_enabled_without_linger", path: paths.timer, linger,
      ...(turnedOn ? { lingerTurnedOn: true } : {}), ...target };
  }
  return { state: "unsupported", detail: `platform_${platform}` };
}

/** Stop and remove the schedule's own files. Nothing else: on Linux it reports lingering but leaves it
 *  as it is, because it may have been on before setup turned it on. */
export function disableAutoUpdate(deps: AutoUpdateDeps): AutoUpdateStatus {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  if (platform === "darwin") {
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}/${AUTO_UPDATE_LABEL}`]);
    const path = launchAgentPath(deps.home);
    if (existsSync(path)) unlinkSync(path);
    return { state: "off", detail: "launch_agent_removed" };
  }
  if (platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", `${AUTO_UPDATE_UNIT}.timer`]);
    const paths = systemdUnitPaths(deps.home);
    for (const path of [paths.timer, paths.service]) if (existsSync(path)) unlinkSync(path);
    run("systemctl", ["--user", "daemon-reload"]);
    return { state: "off", detail: "timer_removed", linger: lingering(run, deps.uid ?? process.getuid?.() ?? 0) };
  }
  return { state: "unsupported", detail: `platform_${platform}` };
}

/** PATH for the scheduled run: the CLI's and node's directories first, then the usual docker homes. */
export function scheduledPath(cli: string, nodeExecutable: string, current: string | undefined): string {
  const dirs = [dirname(cli), dirname(nodeExecutable), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ...(current ?? "").split(":")];
  return [...new Set(dirs.filter((d) => d.startsWith("/")))].join(":");
}
