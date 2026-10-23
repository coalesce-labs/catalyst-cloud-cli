// update-command.ts — `catalyst update [--check] [--json] [--project <path>] [--dir <path>]` and
// `catalyst update policy [<component> on|off] [--project <path>]` and
// `catalyst update sdk --project <path>` (CTC-6708). The release check is update.ts; the owner's
// settings are update-policy.ts. A policy change applies at once and keeps every other component's
// setting. `update sdk` is the owner's explicit say-so for one update of one project, and changes no
// setting.
import { isAbsolute } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { dockerRunnerUpdateEngine, runnerDir, type RunnerUpdateEngine } from "./runner-update.js";
import { policyLines, runUpdate, updateReportJson, updateReportLines } from "./update.js";
import { applySdkUpdate, type SdkExec } from "./update-sdk.js";
import {
  canonicalProject,
  effectivePolicy,
  isUpdateComponent,
  readUpdatePolicy,
  setComponentPolicy,
  setProjectSdkPolicy,
  UPDATE_COMPONENTS,
  type UpdateComponent,
} from "./update-policy.js";

export interface UpdateCommandDeps {
  engine?: RunnerUpdateEngine;
  sdkExec?: SdkExec;
}

const USAGE =
  "catalyst update [--check] [--project <absolute path>] [--dir <runner directory>] [--json] | update sdk --project <absolute path> | update policy [<component> on|off] | update policy sdk on|off --project <absolute path>";

/** How each component reads in a sentence. */
const SENTENCE_NAMES: Readonly<Record<UpdateComponent, string>> = {
  runner: "runner",
  supervisor: "supervisor",
  watchdog: "watchdog",
  cli: "CLI",
  "skills-cloud": "Cloud skills",
  "skills-dev": "Dev skills",
  replica: "local replica",
};

function absoluteFlag(args: ParsedArgs, name: string): string | undefined {
  const value = flagString(args, name);
  if (value !== undefined && !isAbsolute(value)) throw new UsageError(`--${name} must be an absolute path`);
  return value;
}

function cmdPolicy(parts: string[], args: ParsedArgs, ctx: Ctx): number {
  const project = absoluteFlag(args, "project");
  if (flagBool(args, "check") || args.flags.dir !== undefined) throw new UsageError("--check and --dir are not valid with update policy");
  if (parts.length === 1) {
    if (project !== undefined) throw new UsageError("update policy lists every setting; --project goes with update policy sdk on|off");
    const policy = readUpdatePolicy(ctx.home);
    if (args.json)
      ctx.stdout(
        JSON.stringify({
          components: UPDATE_COMPONENTS.map((id) => ({ id, ...effectivePolicy(policy, id) })),
          projects: policy.projects.map((p) => ({ path: p.path, sdk: p.sdk, source: p.source })),
        }),
      );
    else for (const line of policyLines(policy)) ctx.stdout(line);
    return 0;
  }
  const [, name, value] = parts;
  if (parts.length !== 3 || (value !== "on" && value !== "off") || name === undefined) throw new UsageError(USAGE);
  const enabled = value === "on";
  if (name === "sdk") {
    if (project === undefined) throw new UsageError("update policy sdk needs --project <absolute path>");
    const saved = setProjectSdkPolicy(ctx.home, project, enabled ? "auto" : "notify");
    const text = enabled
      ? `Automatic SDK updates are on for ${saved.path}. Release checks may update its package files.`
      : `Automatic SDK updates are off for ${saved.path}. Release checks will only report available updates.`;
    if (args.json) ctx.stdout(JSON.stringify({ project: saved.path, sdk: saved.sdk, source: saved.source }));
    else ctx.stdout(text);
    return 0;
  }
  if (project !== undefined) throw new UsageError("--project goes with update policy sdk on|off");
  if (!isUpdateComponent(name)) throw new UsageError(`unknown component: ${name}. Use one of ${UPDATE_COMPONENTS.join(", ")} or sdk`);
  setComponentPolicy(ctx.home, name, enabled);
  if (args.json) ctx.stdout(JSON.stringify({ id: name, enabled, source: "owner" }));
  else ctx.stdout(`Automatic ${SENTENCE_NAMES[name]} updates are ${value}. Other components keep their settings.`);
  return 0;
}

async function cmdSdk(parts: string[], args: ParsedArgs, ctx: Ctx, deps: UpdateCommandDeps): Promise<number> {
  if (parts.length !== 1) throw new UsageError(USAGE);
  if (flagBool(args, "check")) throw new UsageError("update sdk updates the project; to only look, run catalyst update --check --project <path>");
  const flag = absoluteFlag(args, "project");
  if (flag === undefined) throw new UsageError("update sdk needs --project <absolute path>");
  const project = canonicalProject(flag).path;
  const dirFlag = absoluteFlag(args, "dir");
  const report = await runUpdate(ctx, {
    mode: "check",
    imagesDir: dirFlag ?? runnerDir(ctx),
    project,
    engine: () => deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env }),
  });
  if (report.approved === null || report.crossTrain !== null) {
    const lines = report.crossTrain
      ? [`The approved release is on train ${report.crossTrain.approved}; SDK updates stay on train ${report.crossTrain.supported}.`, "Nothing was changed."]
      : updateReportLines(report).filter((line) => line.startsWith("Approved release unavailable") || line === "Nothing was changed.");
    if (args.json) ctx.stdout(JSON.stringify({ project, outcome: "refused", detail: report.crossTrain ? "cross_train" : (report.unavailable?.reason ?? "approval_unavailable"), moved: [] }));
    else for (const line of lines) ctx.stdout(line);
    return report.crossTrain ? 0 : 1;
  }
  const result = applySdkUpdate(ctx.home, project, report.approved, deps.sdkExec);
  const registered = readUpdatePolicy(ctx.home).projects.find((p) => p.path === project);
  if (args.json) {
    ctx.stdout(JSON.stringify({ project, outcome: result.outcome, detail: result.detail, moved: result.moved }));
  } else {
    const manager = result.project.packageManager ?? "its package manager";
    if (result.outcome === "updated")
      for (const move of result.moved) ctx.stdout(`${move.name} in ${project}: updated from ${move.from} to ${move.to} with ${manager}.`);
    else if (result.outcome === "current") ctx.stdout(`SDK ${project}: already on the approved version.`);
    else if (result.outcome === "refused") ctx.stdout(`SDK ${project}: not changed (${result.detail}).`);
    else
      ctx.stdout(`SDK ${project}: the update failed (${result.detail}), and its package files were put back. If ${manager} left a partial install, run ${manager} install there.`);
    ctx.stdout(`Automatic SDK updates remain ${registered?.sdk === "auto" ? "on" : "off"} for ${project}.`);
  }
  return result.outcome === "updated" || result.outcome === "current" ? 0 : 1;
}

export async function cmdUpdate(args: ParsedArgs, ctx: Ctx, deps: UpdateCommandDeps = {}): Promise<number> {
  const parts = positionals(args);
  if (parts[0] === "policy") return cmdPolicy(parts, args, ctx);
  if (parts[0] === "sdk") return cmdSdk(parts, args, ctx, deps);
  if (parts.length > 0) throw new UsageError(USAGE);
  const dirFlag = absoluteFlag(args, "dir");
  const project = absoluteFlag(args, "project");
  const report = await runUpdate(ctx, {
    mode: flagBool(args, "check") ? "check" : "apply",
    imagesDir: dirFlag ?? runnerDir(ctx),
    // Read the project where it really is; an inspection never registers it.
    ...(project !== undefined ? { project: canonicalProject(project).path } : {}),
    engine: () => deps.engine ?? dockerRunnerUpdateEngine({ env: ctx.env }),
    ...(deps.sdkExec ? { sdkExec: deps.sdkExec } : {}),
  });
  if (args.json) ctx.stdout(JSON.stringify(updateReportJson(report)));
  else for (const line of updateReportLines(report)) ctx.stdout(line);
  return report.exitCode;
}
