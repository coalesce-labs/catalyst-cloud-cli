import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import {
  autoUpdateStatus,
  custodyNode,
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
  lastProblem,
  lastProblemLines,
  drainLines,
  custodyUnattested,
  CUSTODY_UNATTESTED_LINE,
  releaseUpdateDrain,
  type RunnerUpdateEngine,
  type UpdateResult,
} from "./runner-update.js";
import {
  dockerFleetUpdateEngine,
  postRollLines,
  readPostRollResult,
  runFleetPostRollCheck,
  runFleetUpdate,
  type FleetUpdateEngine,
  type FleetUpdateOptions,
} from "./runner-update-fleet.js";
import { runUpdate, sharedReleaseRead, updateReportJson, updateReportLines, type UpdateOptions } from "./update.js";
import { effectivePolicy, readUpdatePolicy, setComponentPolicy } from "./update-policy.js";
import { resolveClaude } from "./update-plugin.js";
import { windowBounds } from "./update-windows.js";
import { cmdRunnerLifecycle, RUNNER_LIFECYCLE_ACTIONS, type RunnerLifecycleDeps } from "./runner.js";

// `catalyst runner update [--check] [--auto] [--dir <dir>] [--fleet]` and
// `catalyst runner auto-update [status|on|off]` (CTC-4646). `--fleet` updates a multi-team
// supervisor fleet's `compose.json` in `--dir` instead of a single runner's `.env` (CTC-6530), and
// `auto-update on --fleet` schedules that fleet update (CTC-6384).
// `catalyst runner [status] | stop | start | uninstall` go to runner.ts (CTC-5930).

export interface RunnerCommandDeps extends RunnerLifecycleDeps {
  engine?: RunnerUpdateEngine;
  fleetEngine?: FleetUpdateEngine;
  /** The fleet update's clock and wait between polls; tests pass a simulated one. */
  fleetClock?: Pick<FleetUpdateOptions, "now" | "sleep">;
  scheduler?: Partial<AutoUpdateDeps>;
  /** The scheduled run's component movers; tests pass fakes. */
  components?: Pick<UpdateOptions, "cliApply" | "replicaRestart" | "packApply" | "pluginApply" | "sdkExec">;
  /** How an update re-runs itself under its custody's node (CTC-7046); tests pass fakes. */
  custody?: CustodyRerunDeps;
}

export interface CustodyRerunDeps {
  platform?: NodeJS.Platform;
  /** The node running this process. */
  execPath?: string;
  /** This process's own command line: the script, then its arguments. */
  argv?: readonly string[];
  /** The custody's recorded node for a runner directory, or null. */
  node?: (dir: string) => string | null;
  /** Runs the command with inherited output and returns its exit code. */
  run?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => number;
}

/** Set on the re-run, so it never re-runs itself again. */
export const CUSTODY_RERUN_ENV = "CATALYST_CUSTODY_NODE_RERUN";

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** CTC-7046: a Mac's thoughts custody refuses any update run under another node than the one it was
 *  set up with. An update run under another node, by an agent written before 0.16.37 or by a person's
 *  shell, re-runs itself under the custody's node and answers with that run's exit code. This works
 *  whatever wrote the agent, and never reloads the agent mid-run. Null: carry on in this process. */
function custodyRerun(ctx: Ctx, deps: CustodyRerunDeps, dir: string): number | null {
  if ((deps.platform ?? process.platform) !== "darwin" || ctx.env[CUSTODY_RERUN_ENV] === "1") return null;
  const node = (deps.node ?? custodyNode)(dir);
  if (node === null || real(node) === real(deps.execPath ?? process.execPath)) return null;
  const [script, ...rest] = deps.argv ?? process.argv.slice(1);
  if (script === undefined) return null;
  const run = deps.run ?? ((command, args, env) => spawnSync(command, [...args], { stdio: "inherit", env }).status ?? 1);
  return run(node, [script, ...rest], { ...ctx.env, [CUSTODY_RERUN_ENV]: "1" });
}

const USAGE =
  "catalyst runner [status] | stop | start | uninstall [--yes] [--delete-checkouts] | runner update [--check] [--dir <runner directory>] [--fleet] | runner auto-update [status|on|off] [--fleet --dir <fleet directory>]";
const UPDATE_FLAGS = ["check", "auto", "dir", "fleet", "post-roll-check"] as const;

function schedulerDeps(ctx: Ctx, deps: RunnerCommandDeps): AutoUpdateDeps {
  const cli = deps.scheduler?.cli ?? resolve(process.argv[1] ?? "catalyst");
  return {
    home: ctx.home,
    cli,
    path: scheduledPath(cli, process.execPath, ctx.env.PATH),
    claude: resolveClaude(ctx.home, ctx.env),
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

function autoLine(result: UpdateResult, at: Date): string {
  return `${at.toISOString()} ${result.outcome} ${result.detail} generation=${result.generation ?? "none"}`;
}

function drainReleaseLine(result: "released" | "none" | "pending" | "failed"): string | null {
  if (result === "released") return "Catalyst can send this machine new phases again: it had stopped sending them so the machine could update.";
  if (result === "pending") return "The update that was waiting for running phases ends within a few seconds, and Catalyst can then send this machine new phases again.";
  if (result === "failed") return "Catalyst may still be holding new phases back from this machine. Run catalyst runner auto-update off again to retry.";
  return null;
}

/** Why this machine's images must not move now: an owner's hold, or settings that cannot be read
 *  (which never count as "everything on"). Null when every image may move. */
function imageHold(ctx: Ctx): "owner_setting" | "update_policy_unreadable" | null {
  try {
    const policy = readUpdatePolicy(ctx.home);
    return RELEASE_COMPONENTS.some((id) => !effectivePolicy(policy, id).enabled) ? "owner_setting" : null;
  } catch {
    return "update_policy_unreadable";
  }
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
      throw new UsageError("--check, --auto, --dir, --fleet and --post-roll-check are only valid with runner update or auto-update");
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
    // The check a fleet update arms on the host 10 minutes after it applies (CTC-6564); only that timer passes it.
    if (flagBool(args, "post-roll-check")) {
      if (!fleet || dirFlag === undefined || check || auto) throw new UsageError("--post-roll-check is run by the timer a fleet update arms: runner update --fleet --dir <dir> --post-roll-check");
      const outcome = await runFleetPostRollCheck(deps.fleetEngine ?? dockerFleetUpdateEngine({ env: ctx.env }), { dir: dirFlag });
      if (args.json) ctx.stdout(JSON.stringify(outcome));
      else for (const line of outcome.result ? postRollLines(outcome.result) : [`Post-roll check: ${outcome.detail}.`]) ctx.stdout(line);
      return outcome.exitCode;
    }
    if (!fleet && !check) {
      const rerun = custodyRerun(ctx, deps.custody ?? {}, dir());
      if (rerun !== null) return rerun;
    }
    // One desired-release read serves the image check and the component report (CTC-6708).
    const engine = sharedReleaseRead(deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env }));
    // The 15-minute schedule runs `runner update --auto`. After the images it carries on with every
    // other component (the CLI, the Cloud pack, the replica, opted-in SDK projects), on the same
    // release read, so one schedule keeps the whole install on the approved release (CTC-6708). An
    // image hold keeps only the images. A check never applies; with --json the components join the
    // one JSON result, otherwise they get one line, and only when a release was read.
    const components = async (imageResult: UpdateResult | undefined) => {
      if (!auto || fleet || check) return null;
      const report = await runUpdate(ctx, { mode: "apply", imagesDir: dir(), engine: () => engine, ...(imageResult ? { imageResult } : {}), ...deps.components });
      if (report.approved === null) return null;
      const rows = report.components.filter((c) => !RELEASE_COMPONENTS.some((id) => id === c.id));
      return {
        rows,
        line: `${ctx.now().toISOString()} components ${rows.map((c) => `${c.id}=${c.status}${c.status === "failed" || c.status === "pending" ? `(${c.reason})` : ""}`).join(" ")}`,
        exitCode: rows.some((c) => c.status === "failed") || report.projects.some((p) => p.applied?.outcome === "failed") ? 1 : 0,
      };
    };
    const print = (result: UpdateResult, extra: Awaited<ReturnType<typeof components>>) => {
      if (args.json) ctx.stdout(JSON.stringify(extra ? { ...result, components: extra.rows } : result));
      else if (auto) {
        ctx.stdout(autoLine(result, ctx.now()));
        if (custodyUnattested(result)) ctx.stdout(CUSTODY_UNATTESTED_LINE);
        if (extra) ctx.stdout(extra.line);
      } else for (const line of updateResultLines(result)) ctx.stdout(line);
      return Math.max(result.exitCode, extra?.exitCode ?? 0);
    };
    // An owner's image hold stops this command's image work too, including the schedule's (CTC-6708).
    const hold = check ? null : imageHold(ctx);
    // The schedule's run takes a newer release at its next check, unless the owner saved update
    // windows; then only in a window. An owner's own run applies at once (CTC-7465, update-windows.ts).
    if (hold !== null) {
      const retained = { outcome: "retained" as const, detail: hold, generation: readReleaseState(dir()).generation, exitCode: hold === "owner_setting" ? 0 : 1 };
      if (hold === "owner_setting" && !fleet) {
        const released = await releaseUpdateDrain(engine, dir(), { cloud: false });
        if (released === "failed" && !auto && !args.json) ctx.stdout(drainReleaseLine(released)!);
      }
      // Unreadable settings move nothing; a hold leaves the other components to the release check.
      return print(retained, hold === "owner_setting" ? await components(undefined) : null);
    }
    const ownerWindows = auto && !check && !fleet ? readUpdatePolicy(ctx.home).windows : undefined;
    // A fleet supervisor that misses its qualification deadline names each scope it had not qualified,
    // and why, on stderr before the restore, so stdout keeps its one line or JSON object (CTC-8163).
    const result = fleet
      ? await runFleetUpdate(deps.fleetEngine ?? dockerFleetUpdateEngine({ env: ctx.env }), {
        dir: dir(), check, ...deps.fleetClock,
        onQualificationPending: (line) => ctx.stderr(`catalyst: ${line}`),
      })
      : await runRunnerUpdate(engine, {
        dir: dir(), check,
        ...(ownerWindows ? { window: windowBounds(ctx.now().getTime(), ownerWindows) } : {}),
        ...(auto && !check ? { drain: true, held: () => imageHold(ctx), ...(args.json ? {} : { onPass: (pass: UpdateResult) => ctx.stdout(autoLine(pass, ctx.now())) }) } : {}),
      });
    // `runner update --check` also lists every installed component against the approved release, as
    // `catalyst update --check` does. The image fields stay where scripts already read them.
    if (check && !fleet && !auto) {
      let report;
      try {
        report = await runUpdate(ctx, { mode: "check", imagesDir: dir(), engine: () => engine, imageResult: result });
      } catch (err) {
        // Unreadable update settings cost the component report only; the image result still prints.
        if (!(err instanceof CliError)) throw err;
        ctx.stderr(`catalyst: ${err.message}`);
        if (args.json) ctx.stdout(JSON.stringify(result));
        else for (const line of updateResultLines(result)) ctx.stdout(line);
        return result.exitCode;
      }
      // A check also names the last failed or rolled-back update, which a clean read would hide (CTC-6709).
      const state = readReleaseState(dir());
      if (args.json) {
        const { schemaVersion, release, components, projects } = updateReportJson(report);
        ctx.stdout(JSON.stringify({ ...result, schemaVersion, release, components, projects, lastProblem: lastProblem(state), drain: state.drain === null ? null : { generation: state.drain.generation, acknowledgedAtMs: state.drain.acknowledgedAtMs }, deferral: state.deferral }));
      } else for (const line of [...updateResultLines(result), ...lastProblemLines(state), ...drainLines(state), ...updateReportLines(report)]) ctx.stdout(line);
      return result.exitCode;
    }
    // A fleet check also names the last post-roll verdict (CTC-6564).
    if (check && fleet && !auto) {
      const verdict = readPostRollResult(dir());
      if (args.json) ctx.stdout(JSON.stringify({ ...result, lastPostRoll: verdict }));
      else for (const line of [...updateResultLines(result), ...postRollLines(verdict)]) ctx.stdout(line);
      return result.exitCode;
    }
    return print(result, await components(result));
  }

  if (action === "auto-update" && parts.length <= 2) {
    const mode = parts[1] ?? "status";
    const fleet = flagBool(args, "fleet");
    if (mode === "on" && fleet && dirFlag === undefined) throw new UsageError("--fleet needs --dir, the directory that holds compose.json");
    const scheduler = schedulerDeps(ctx, deps);
    let status: AutoUpdateStatus;
    if (mode === "on") status = enableAutoUpdate(scheduler, dir(), { fleet });
    else if (mode === "off") status = disableAutoUpdate(scheduler);
    else if (mode === "status") status = autoUpdateStatus(scheduler);
    else throw new UsageError(USAGE);
    // The owner's explicit on/off is also their setting for the three images, so a release check
    // reports them as held (CTC-6708). Setup's own call (enableRunnerAutoUpdate) never lifts a hold.
    if (mode === "off" || (mode === "on" && status.state === "on"))
      for (const id of RELEASE_COMPONENTS) setComponentPolicy(ctx.home, id, mode === "on");
    let updateDrain: "released" | "none" | "pending" | "failed" = "none";
    if (mode === "off" && !fleet) {
      let runner: string | null = null;
      try { runner = dir(); } catch { /* No runner directory to release. */ }
      if (runner !== null && existsSync(resolve(runner, ".env")) && existsSync(resolve(runner, "compose.yaml")))
        updateDrain = await releaseUpdateDrain(deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env }), runner, { cloud: true });
    }
    if (args.json) {
      const state = mode === "status" && dirFlag !== undefined ? readReleaseState(dirFlag) : undefined;
      ctx.stdout(JSON.stringify({ ...status, ...(state ? { release: state } : {}), ...(mode === "off" ? { updateDrain } : {}) }));
    } else {
      ctx.stdout(statusLine(status));
      const line = mode === "off" ? drainReleaseLine(updateDrain) : null;
      if (line !== null) ctx.stdout(line);
      // A single runner's schedule prints what it always has; a fleet's says so, and for which directory.
      if (status.state === "on" && status.fleet) ctx.stdout(`This is a supervisor fleet's schedule: it updates the compose.json in ${status.dir}.`);
    }
    return status.state === "on" || mode !== "on" ? 0 : 1;
  }

  throw new UsageError(USAGE);
}
