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
  RELEASE_COMPONENTS,
  runnerDir,
  runRunnerUpdate,
  updateResultLines,
  type RunnerUpdateEngine,
} from "./runner-update.js";
import { dockerFleetUpdateEngine, runFleetUpdate, type FleetUpdateEngine } from "./runner-update-fleet.js";
import { runUpdate, sharedReleaseRead, updateReportJson, updateReportLines } from "./update.js";
import { setComponentPolicy } from "./update-policy.js";
import { cmdRunnerLifecycle, RUNNER_LIFECYCLE_ACTIONS, type RunnerLifecycleDeps } from "./runner.js";

// `catalyst runner update [--check] [--auto] [--dir <dir>] [--fleet]` and
// `catalyst runner auto-update [status|on|off]` (CTC-4646). `--fleet` updates a multi-team
// supervisor fleet's `compose.json` in `--dir` instead of a single runner's `.env` (CTC-6530).
// `catalyst runner [status] | stop | start | uninstall` go to runner.ts (CTC-5930).

export interface RunnerCommandDeps extends RunnerLifecycleDeps {
  engine?: RunnerUpdateEngine;
  fleetEngine?: FleetUpdateEngine;
  scheduler?: Partial<AutoUpdateDeps>;
}

const USAGE =
  "catalyst runner [status] | stop | start | uninstall [--yes] [--delete-checkouts] | runner update [--check] [--dir <runner directory>] [--fleet] | runner auto-update [status|on|off]";
const UPDATE_FLAGS = ["check", "auto", "dir", "fleet"] as const;

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
  if (status.state === "on") {
    if (status.linger === false)
      return "Automatic runner updates are on, but they stop when you log out: this machine did not let you keep your user services running. Run this once to keep them running: sudo loginctl enable-linger $USER";
    if (status.lingerTurnedOn)
      return "Automatic runner updates are on: this machine checks for an approved release every 15 minutes, and keeps checking after you log out. To do that, setup turned on lingering for you, which keeps your user services running after logout. To undo it: loginctl disable-linger $USER";
    return status.linger
      ? "Automatic runner updates are on: this machine checks for an approved release every 15 minutes, and keeps checking after you log out."
      : "Automatic runner updates are on: this machine checks for an approved release every 15 minutes.";
  }
  if (status.state === "off") {
    const off = `Automatic runner updates are off (${status.detail}). Turn them on with: catalyst runner auto-update on`;
    return status.linger
      ? `${off}. Lingering is still on for you, which keeps your user services running after logout. If nothing else needs it: loginctl disable-linger $USER`
      : off;
  }
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
  if (action === undefined || RUNNER_LIFECYCLE_ACTIONS.includes(action)) {
    if (UPDATE_FLAGS.some(flag => args.flags[flag] !== undefined))
      throw new UsageError("--check, --auto, --dir and --fleet are only valid with runner update or auto-update");
    return cmdRunnerLifecycle(args, ctx, deps);
  }
  if (args.flags.yes !== undefined || args.flags["delete-checkouts"] !== undefined)
    throw new UsageError("--yes and --delete-checkouts are only valid with runner uninstall");
  const dirFlag = flagString(args, "dir");
  if (dirFlag !== undefined && !isAbsolute(dirFlag)) throw new UsageError("--dir must be an absolute path");
  const dir = () => dirFlag ?? runnerDir(ctx);

  if (action === "update" && parts.length === 1) {
    const check = flagBool(args, "check");
    const auto = flagBool(args, "auto");
    const fleet = flagBool(args, "fleet");
    if (fleet && dirFlag === undefined) throw new UsageError("--fleet needs --dir, the directory that holds compose.json");
    // One desired-release read serves the image check and the component report (CTC-6708).
    const engine = sharedReleaseRead(deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env }));
    const result = fleet
      ? await runFleetUpdate(deps.fleetEngine ?? dockerFleetUpdateEngine({ env: ctx.env }), { dir: dir(), check })
      : await runRunnerUpdate(engine, { dir: dir(), check });
    // `runner update --check` also lists every installed component against the approved release, as
    // `catalyst update --check` does. The image fields stay where scripts already read them.
    if (check && !fleet && !auto) {
      const report = await runUpdate(ctx, { mode: "check", imagesDir: dir(), engine: () => engine, imageResult: result });
      if (args.json) {
        const { schemaVersion, release, components, projects } = updateReportJson(report);
        ctx.stdout(JSON.stringify({ ...result, schemaVersion, release, components, projects }));
      } else for (const line of [...updateResultLines(result), ...updateReportLines(report)]) ctx.stdout(line);
      return result.exitCode;
    }
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
    // The owner's explicit on/off is also their setting for the three images, so a release check
    // reports them as held (CTC-6708). Setup's own call (enableRunnerAutoUpdate) never lifts a hold.
    if (mode === "off" || (mode === "on" && status.state === "on"))
      for (const id of RELEASE_COMPONENTS) setComponentPolicy(ctx.home, id, mode === "on");
    if (args.json) {
      const state = mode === "status" && dirFlag !== undefined ? readReleaseState(dirFlag) : undefined;
      ctx.stdout(JSON.stringify({ ...status, ...(state ? { release: state } : {}) }));
    } else ctx.stdout(statusLine(status));
    return status.state === "on" || mode !== "on" ? 0 : 1;
  }

  throw new UsageError(USAGE);
}
