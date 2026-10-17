import { isAbsolute, resolve } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import {
  autoUpdateStatus,
  disableAutoUpdate,
  enableAutoUpdate,
  scheduledPath,
  type AutoUpdateDeps,
  type AutoUpdateStatus,
} from "./runner-auto-update.js";
import {
  dockerRunnerUpdateEngine,
  readReleaseState,
  runnerDir,
  runRunnerUpdate,
  updateResultLines,
  type RunnerUpdateEngine,
} from "./runner-update.js";

// `catalyst runner update [--check] [--auto] [--dir <dir>]` and
// `catalyst runner auto-update [status|on|off]` (CTC-4646).

export interface RunnerCommandDeps {
  engine?: RunnerUpdateEngine;
  scheduler?: Partial<AutoUpdateDeps>;
}

const USAGE =
  "catalyst runner update [--check] [--dir <runner directory>] | runner auto-update [status|on|off]";

function schedulerDeps(ctx: Ctx, deps: RunnerCommandDeps): AutoUpdateDeps {
  const cli = deps.scheduler?.cli ?? resolve(process.argv[1] ?? "catalyst");
  return {
    home: ctx.home,
    cli,
    path: scheduledPath(cli, process.execPath, ctx.env.PATH),
    ...deps.scheduler,
  };
}

function statusLine(status: AutoUpdateStatus): string {
  if (status.state === "on")
    return status.detail === "timer_enabled_without_linger"
      ? "Automatic runner updates are on, every 15 minutes while you are logged in. To keep them running after you log out, run: sudo loginctl enable-linger $USER"
      : "Automatic runner updates are on: this machine checks for an approved release every 15 minutes.";
  if (status.state === "off") return `Automatic runner updates are off (${status.detail}). Turn them on with: catalyst runner auto-update on`;
  if (status.detail === "no_systemd_user_manager")
    return "Automatic runner updates need your systemd user manager, which is not running for you. Run: sudo loginctl enable-linger $USER, then catalyst runner auto-update on";
  return `Automatic runner updates are not available on this machine (${status.detail}). Run catalyst runner update yourself.`;
}

/** Setup's call: turn the schedule on for `dir` and say what happened in one line. */
export function enableRunnerAutoUpdate(ctx: Ctx, dir: string): string {
  return statusLine(enableAutoUpdate(schedulerDeps(ctx, {}), dir));
}

export async function cmdRunner(args: ParsedArgs, ctx: Ctx, deps: RunnerCommandDeps = {}): Promise<number> {
  const parts = positionals(args);
  const action = parts[0];
  const dirFlag = flagString(args, "dir");
  if (dirFlag !== undefined && !isAbsolute(dirFlag)) throw new UsageError("--dir must be an absolute path");
  const dir = () => dirFlag ?? runnerDir(ctx);

  if (action === "update" && parts.length === 1) {
    const check = flagBool(args, "check");
    const auto = flagBool(args, "auto");
    const engine = deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env });
    const result = await runRunnerUpdate(engine, { dir: dir(), check });
    if (args.json) ctx.stdout(JSON.stringify(result));
    else if (auto) ctx.stdout(`${ctx.now().toISOString()} ${result.outcome} ${result.detail} generation=${result.generation ?? "none"}`);
    else for (const line of updateResultLines(result)) ctx.stdout(line);
    return result.exitCode;
  }

  if (action === "auto-update" && parts.length <= 2) {
    const mode = parts[1] ?? "status";
    const scheduler = schedulerDeps(ctx, deps);
    let status: AutoUpdateStatus;
    if (mode === "on") status = enableAutoUpdate(scheduler, dir());
    else if (mode === "off") status = disableAutoUpdate(scheduler);
    else if (mode === "status") status = autoUpdateStatus(scheduler);
    else throw new UsageError(USAGE);
    if (args.json) {
      const state = mode === "status" && dirFlag !== undefined ? readReleaseState(dirFlag) : undefined;
      ctx.stdout(JSON.stringify({ ...status, ...(state ? { release: state } : {}) }));
    } else ctx.stdout(statusLine(status));
    return status.state === "on" || mode !== "on" ? 0 : 1;
  }

  throw new UsageError(USAGE);
}
