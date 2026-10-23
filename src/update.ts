// update.ts — one release check for every component an install keeps (CTC-6708). It reads what is
// installed, reads the approved release once, and decides for each component on its own: current,
// behind, held by the owner's setting, newer than approved, absent, or unknown with a reason. A held
// or failed component never blocks the others, and nothing in a check changes the machine.
//
// The approved record comes from one read: the enrolled machine's desired-release answer when a
// runner is installed (its images and its `components` share one snapshot), else the signed-in
// member route. The runner, supervisor and watchdog move through runner-update.ts's engine with that
// same read, so the image half and the component half can never come from different approvals.
//
// This CLI applies the image components itself, moves the CLI to the approved version (installed
// beside the running one and selected through the person's own command: update-cli.ts), and then
// restarts a running local replica on it with its data (update-replica.ts). The Cloud skills pack
// moves to its own approved version from that version's package, even while the CLI is held
// (update-skills.ts). The Dev pack carries no version this CLI can read, so it is reported, never
// moved. A project's SDK is reported
// with its update command; an applying run changes a project's files only when its owner turned that
// project's SDK updates on, and a check never does.
import {
  compareVersions,
  hostApproval,
  readApprovalCache,
  readMemberApproval,
  supportedReleaseLine,
  writeApprovalCache,
  type ApprovalUnavailable,
  type ApprovedRead,
  type ApprovedRelease,
} from "./approved-release.js";
import { loadConfig, type Ctx } from "./config.js";
import { applyCliUpdate, type CliApplyResult } from "./update-cli.js";
import { readInventory, type Inventory } from "./update-inventory.js";
import { restartPending, restartReplica, type ReplicaRestartResult } from "./update-replica.js";
import { applyCloudPackUpdate, type PackApplyResult } from "./update-skills.js";
import { onboardStatePath, readOnboardJournal } from "./onboard.js";
import {
  effectivePolicy,
  projectIdentityHolds,
  readUpdatePolicy,
  UPDATE_COMPONENTS,
  withMigratedHolds,
  type PolicySource,
  type UpdateComponent,
  type UpdatePolicy,
} from "./update-policy.js";
import { applySdkUpdate, inspectSdkProject, type SdkApplyResult, type SdkExec, type SdkProject } from "./update-sdk.js";
import {
  decideRelease,
  isRecord,
  parseDesiredRelease,
  RELEASE_COMPONENTS,
  runRunnerUpdate,
  type DesiredRelease,
  type DesiredReleaseRead,
  type ReleaseComponent,
  type RunnerUpdateEngine,
  type UpdateResult,
} from "./runner-update.js";

export type ComponentStatus =
  | "current"
  | "update_available"
  | "held"
  | "not_installed"
  | "unknown"
  | "installed_newer"
  | "approval_unavailable"
  | "restart_after_cli"
  | "waiting_for_cli"
  | "stopped"
  | "cross_train"
  | "updated"
  | "pending"
  | "failed";

export interface ComponentReport {
  id: UpdateComponent;
  installed: string | null;
  approved: string | null;
  /** Images only: the full digest-pinned references behind the labels above. */
  installedReference?: string | null;
  approvedReference?: string | null;
  policy: "on" | "off";
  policySource: PolicySource;
  status: ComponentStatus;
  reason: string;
  /** A command the owner can run to move this component, when this CLI does not move it itself. */
  action: string | null;
}

export interface ProjectReport extends SdkProject {
  registered: boolean;
  /** `notify` unless the owner turned this project's SDK updates on. */
  policy: "notify" | "auto";
  /** What an applying run did to an opted-in project; null when it did nothing. */
  applied: Pick<SdkApplyResult, "outcome" | "detail" | "moved"> | null;
}

export interface UpdateReport {
  schemaVersion: 1;
  mode: "check" | "apply";
  release: { id: string; generation: number; releaseLine: string; source: "network" | "host" } | null;
  /** Why no component record was usable, and the last one seen (never used to apply). */
  unavailable: { reason: ApprovalUnavailable; lastObserved: { id: string; generation: number; observedAtMs: number } | null } | null;
  /** The approved record is on another train: nothing moves automatically. */
  crossTrain: { supported: string; approved: string } | null;
  components: ComponentReport[];
  projects: ProjectReport[];
  /** The image engine's own result, when a runner is installed. */
  images: UpdateResult | null;
  /** The parsed approval this report was decided against (internal; not printed). */
  approved: ApprovedRelease | null;
  exitCode: number;
}

export interface UpdateOptions {
  mode: "check" | "apply";
  /** The runner installation to read and update. */
  imagesDir: string;
  /** Inspect this project's SDK too, without registering it. */
  project?: string;
  /** The image engine, built only when a runner is installed. */
  engine: () => RunnerUpdateEngine;
  /** The image result `runner update` already computed with the same engine, so it is not run twice. */
  imageResult?: UpdateResult;
  /** Runs a project's package manager; tests pass a fake. */
  sdkExec?: SdkExec;
  /** Moves the CLI to `target`; tests pass a fake. */
  cliApply?: (home: string, ownVersion: string, target: string) => CliApplyResult;
  /** Restarts a running replica on the selected CLI, expecting `target`; tests pass a fake. */
  replicaRestart?: (target: string) => Promise<ReplicaRestartResult>;
  /** Refreshes the Cloud skills pack in `skillsDir` to `target`; tests pass a fake. */
  packApply?: (home: string, skillsDir: string, target: string) => PackApplyResult;
}

export const COMPONENT_LABELS: Readonly<Record<UpdateComponent, string>> = {
  runner: "Runner",
  supervisor: "Supervisor",
  watchdog: "Watchdog",
  cli: "CLI",
  "skills-cloud": "Cloud skills",
  "skills-dev": "Dev skills",
  replica: "Local replica",
};

const SDK_LABELS: Readonly<Record<string, string>> = {
  "@catalyst-cloud/sdk": "SDK",
  "@catalyst-cloud/sdk-replica-node": "SDK replica (Node)",
  "@catalyst-cloud/sdk-replica-browser": "SDK replica (browser)",
};

/** Setup's record says the owner turned the installer's daily update off. Unreadable is no evidence. */
function dailyUpdateOff(ctx: Ctx): boolean {
  try {
    return readOnboardJournal(onboardStatePath(ctx.home, ctx.env))?.dailyUpdate?.state === "off";
  } catch {
    return false;
  }
}

/** The owner's saved settings, with the holds their setup choices carry (update-policy.ts). */
export function readEffectivePolicy(ctx: Ctx): UpdatePolicy {
  return withMigratedHolds(readUpdatePolicy(ctx.home), dailyUpdateOff(ctx));
}

/** An engine whose desired-release read happens once per pass, however many readers ask. */
export function sharedReleaseRead(engine: RunnerUpdateEngine): RunnerUpdateEngine & { read(dir: string): Promise<DesiredReleaseRead> } {
  const reads = new Map<string, Promise<DesiredReleaseRead>>();
  const read = (dir: string, signal?: AbortSignal) => {
    let pending = reads.get(dir);
    if (!pending) {
      pending = engine.desiredRelease(dir, signal);
      reads.set(dir, pending);
    }
    return pending;
  };
  return { ...engine, desiredRelease: read, read: (dir) => read(dir) };
}

function imageApproval(read: DesiredReleaseRead): { release: DesiredRelease | null; reason: string } {
  const decision = decideRelease(null, read);
  if (decision.action === "retain") return { release: null, reason: decision.reason };
  const body = read.kind === "answered" && isRecord(read.body) ? read.body.release : null;
  return { release: parseDesiredRelease(body), reason: "approved" };
}

const shortDigest = (reference: string) => reference.slice(reference.indexOf("@") + 1, reference.indexOf("@") + 20);

function versionStatus(installed: string, approved: string, enabled: boolean): { status: ComponentStatus; reason: string } {
  const order = compareVersions(installed, approved);
  if (order === 0) return { status: "current", reason: "current" };
  if (order > 0) return { status: "installed_newer", reason: "installed_newer" };
  return enabled ? { status: "update_available", reason: "behind_approved" } : { status: "held", reason: "owner_setting" };
}

function imageRows(
  inventory: Inventory,
  policy: UpdatePolicy,
  approval: { release: DesiredRelease | null; reason: string } | null,
): ComponentReport[] {
  return RELEASE_COMPONENTS.map((id: ReleaseComponent): ComponentReport => {
    const p = effectivePolicy(policy, id);
    const row = { id, policy: p.enabled ? ("on" as const) : ("off" as const), policySource: p.source, action: null };
    const images = inventory.images;
    if (!images.installed) return { ...row, installed: null, approved: null, status: "not_installed", reason: "not_installed" };
    const installedRef = images.references[id];
    const release = approval?.release ?? null;
    const approvedRef = release?.images[id].reference ?? null;
    const installedLabel =
      installedRef === null
        ? null
        : release && installedRef === approvedRef
          ? `generation ${release.generation}`
          : images.generation !== null
            ? `generation ${images.generation}`
            : shortDigest(installedRef);
    const base = {
      ...row,
      installed: installedLabel,
      approved: release ? `generation ${release.generation}` : null,
      installedReference: installedRef,
      approvedReference: approvedRef,
    };
    if (installedRef === null) return { ...base, status: "unknown", reason: "image_unreadable" };
    if (!release) return { ...base, status: "approval_unavailable", reason: approval?.reason ?? "approval_unavailable" };
    if (installedRef === approvedRef) return { ...base, status: "current", reason: "current" };
    if (images.generation !== null && images.generation > release.generation) return { ...base, status: "installed_newer", reason: "not_newer" };
    return p.enabled ? { ...base, status: "update_available", reason: "behind_approved" } : { ...base, status: "held", reason: "owner_setting" };
  });
}

function componentRows(inventory: Inventory, policy: UpdatePolicy, release: ApprovedRelease | null, unavailable: string, crossTrain: boolean): ComponentReport[] {
  const row = (id: UpdateComponent) => {
    const p = effectivePolicy(policy, id);
    return { id, policy: p.enabled ? ("on" as const) : ("off" as const), policySource: p.source, enabled: p.enabled };
  };
  const finish = (r: ReturnType<typeof row>, rest: Omit<ComponentReport, "id" | "policy" | "policySource">): ComponentReport => ({
    id: r.id,
    policy: r.policy,
    policySource: r.policySource,
    ...rest,
  });

  const cliTarget = release?.members.cli ?? null;
  const cli = row("cli");
  const cliRow = ((): ComponentReport => {
    const installed = inventory.cli.version;
    if (cliTarget === null) return finish(cli, { installed, approved: null, status: "approval_unavailable", reason: unavailable, action: null });
    if (crossTrain) return finish(cli, { installed, approved: cliTarget, status: "cross_train", reason: "cross_train", action: null });
    // An applying run moves the CLI itself: no command to hand the owner.
    return finish(cli, { installed, approved: cliTarget, ...versionStatus(installed, cliTarget, cli.enabled), action: null });
  })();

  const packRow = (id: "skills-cloud" | "skills-dev", pack: "cloud" | "dev"): ComponentReport => {
    const r = row(id);
    const target = release?.skills[pack] ?? null;
    const found = inventory.skills[pack];
    const approved = target?.version ?? null;
    if (found.state === "not_installed") return finish(r, { installed: null, approved, status: "not_installed", reason: "not_installed", action: null });
    if (found.state === "unknown") return finish(r, { installed: null, approved, status: "unknown", reason: found.reason, action: null });
    if (target === null) return finish(r, { installed: found.version, approved: null, status: "approval_unavailable", reason: unavailable, action: null });
    if (crossTrain) return finish(r, { installed: found.version, approved, status: "cross_train", reason: "cross_train", action: null });
    const decided = versionStatus(found.version, target.version, r.enabled);
    return finish(r, {
      installed: found.version,
      approved,
      ...decided,
      // An applying run moves the Cloud pack itself; the Dev pack's command is the owner's to run.
      action: decided.status === "update_available" && pack === "dev" ? `npx skills add https://github.com/${target.repository}/tree/${target.commit} --all -g` : null,
    });
  };

  const replica = row("replica");
  const replicaRow = ((): ComponentReport => {
    const found = inventory.replica;
    if (found.state === "not_installed") return finish(replica, { installed: null, approved: cliTarget, status: "not_installed", reason: "not_installed", action: null });
    if (found.state === "unknown") return finish(replica, { installed: null, approved: cliTarget, status: "unknown", reason: found.reason, action: null });
    if (found.state === "stopped") return finish(replica, { installed: null, approved: cliTarget, status: "stopped", reason: "stopped", action: null });
    if (cliTarget === null) return finish(replica, { installed: found.version, approved: null, status: "approval_unavailable", reason: unavailable, action: null });
    if (crossTrain) return finish(replica, { installed: found.version, approved: cliTarget, status: "cross_train", reason: "cross_train", action: null });
    // CTC-6743: a running writer that recorded no version started on a CLI from before writers
    // recorded one, so it is older than any approved CLI and restarts like any other old writer.
    const order = found.version === null ? -1 : compareVersions(found.version, cliTarget);
    const base = { installed: found.version, approved: cliTarget, action: null };
    if (order === 0) return finish(replica, { ...base, status: "current", reason: "current" });
    if (order > 0) return finish(replica, { ...base, status: "installed_newer", reason: "installed_newer" });
    if (!replica.enabled) return finish(replica, { ...base, status: "held", reason: "owner_setting" });
    // The replica runs on the installed CLI: it moves when the CLI does.
    if (compareVersions(inventory.cli.version, cliTarget) < 0)
      return cli.enabled
        ? finish(replica, { ...base, status: "restart_after_cli", reason: "cli_update_pending" })
        : finish(replica, { ...base, status: "waiting_for_cli", reason: "dependency_held" });
    return finish(replica, { ...base, status: "update_available", reason: "restart_needed" });
  })();

  return [cliRow, packRow("skills-cloud", "cloud"), packRow("skills-dev", "dev"), replicaRow];
}

function projectReports(policy: UpdatePolicy, release: ApprovedRelease | null, extra: string | undefined): ProjectReport[] {
  const reports: ProjectReport[] = [];
  for (const project of policy.projects) {
    if (!projectIdentityHolds(project)) {
      reports.push({
        path: project.path,
        packageManager: null,
        packages: [],
        status: "unknown",
        reason: "project_identity_changed",
        command: null,
        packageManagerCommand: null,
        registered: true,
        policy: project.sdk,
        applied: null,
      });
      continue;
    }
    reports.push({ ...inspectSdkProject(project.path, release), registered: true, policy: project.sdk, applied: null });
  }
  if (extra !== undefined && !reports.some((r) => r.path === extra))
    reports.push({ ...inspectSdkProject(extra, release), registered: false, policy: "notify", applied: null });
  return reports;
}

/** Map the image engine's result onto the three image rows it moved. */
function applyImageResult(rows: ComponentReport[], result: UpdateResult): void {
  for (const row of rows) {
    if (row.status === "not_installed") continue;
    if (result.outcome === "updated" || result.outcome === "recorded") {
      row.status = "updated";
      row.reason = result.outcome;
      row.installed = row.approved;
      row.installedReference = row.approvedReference ?? row.installedReference ?? null;
    } else if (result.outcome === "deferred_busy" || result.outcome === "retained") {
      if (row.status === "update_available") {
        row.status = "pending";
        row.reason = result.detail;
      }
    } else if (result.outcome === "failed" || result.outcome === "rolled_back") {
      if (row.status === "update_available") {
        row.status = "failed";
        row.reason = result.detail;
      }
    }
  }
}

function aggregateExit(report: Omit<UpdateReport, "exitCode">): number {
  if (report.components.some((c) => c.status === "failed")) return 1;
  if (report.projects.some((p) => p.applied?.outcome === "failed")) return 1;
  if (report.images && report.images.exitCode !== 0) return 1;
  // No usable approval for anything: the check could not answer.
  const imagesAnswered = report.components.some((c) => RELEASE_COMPONENTS.some((id) => id === c.id) && c.approved !== null);
  if (report.unavailable && !imagesAnswered) return 1;
  // Applying: an enabled component that is behind and that this CLI does not move needs the owner.
  if (report.mode === "apply" && report.components.some((c) => c.status === "update_available" && c.action !== null)) return 1;
  return 0;
}

/** One release check. Check mode reads only: no lock, no cache, no settings and no install change. */
export async function runUpdate(ctx: Ctx, options: UpdateOptions): Promise<UpdateReport> {
  const policy = readEffectivePolicy(ctx);
  const inventory = readInventory(ctx, options.imagesDir);

  let engine: ReturnType<typeof sharedReleaseRead> | null = null;
  let approval: ApprovedRead;
  let images: { release: DesiredRelease | null; reason: string } | null = null;
  if (inventory.images.installed) {
    engine = sharedReleaseRead(options.engine());
    const read = await engine.read(options.imagesDir);
    images = imageApproval(read);
    approval = hostApproval(read);
    // The runner's own read failed (Docker stopped, say): a signed-in CLI can still ask the member
    // route. Its answer names the components; the images keep the host's verdict.
    if (approval.kind === "unavailable" && (approval.reason === "host_unreadable" || approval.reason === "unreachable")) {
      const member = await readMemberApproval(ctx);
      if (member.kind === "approved" || member.reason !== "signed_out") approval = member;
    }
  } else {
    approval = await readMemberApproval(ctx);
  }

  const release = approval.kind === "approved" ? approval.release : null;
  const supported = supportedReleaseLine();
  const crossTrain = release !== null && release.releaseLine !== supported ? { supported, approved: release.releaseLine } : null;
  const unavailableReason = approval.kind === "unavailable" ? approval.reason : "approval_unavailable";
  const cached = approval.kind === "unavailable" ? readApprovalCache(ctx.home) : null;

  const imageList = imageRows(inventory, policy, crossTrain ? { release: null, reason: "cross_train" } : images);
  const components = [...imageList, ...componentRows(inventory, policy, release, unavailableReason, crossTrain !== null)];
  // A writer an earlier restart stopped is not one its owner stopped: it is started again.
  const stoppedRow = components.find((c) => c.id === "replica" && c.status === "stopped");
  if (stoppedRow && inventory.replica.state === "stopped" && restartPending(ctx.home, inventory.replica.dbPath))
    Object.assign(stoppedRow, { status: "pending", reason: "restart_interrupted" });
  const projects = projectReports(policy, crossTrain ? null : release, options.project);

  let imageResult: UpdateResult | null = options.imageResult ?? null;
  if (options.mode === "apply" && engine !== null && imageResult === null && crossTrain === null) {
    // Re-read the owner's settings just before anything moves: a hold set during the read wins.
    const current = readEffectivePolicy(ctx);
    const held = RELEASE_COMPONENTS.filter((id) => !effectivePolicy(current, id).enabled);
    if (held.length === 0) {
      imageResult = await runRunnerUpdate(engine, { dir: options.imagesDir });
      applyImageResult(imageList, imageResult);
    } else {
      // The image engine moves all three together; one held image holds its peers until it is lifted.
      for (const row of imageList)
        if (row.status === "update_available") {
          row.status = "held";
          row.reason = "peer_image_held";
        }
    }
  }
  if (options.mode === "apply" && release !== null && crossTrain === null) {
    // Re-read the owner's settings just before the CLI and replica move: a hold set during the read wins.
    const current = readEffectivePolicy(ctx);
    const cliRow = components.find((c) => c.id === "cli");
    const replicaRow = components.find((c) => c.id === "replica");
    if (cliRow && cliRow.status === "update_available" && cliRow.approved !== null) {
      if (!effectivePolicy(current, "cli").enabled) Object.assign(cliRow, { status: "held", reason: "owner_setting" });
      else {
        const moved = (options.cliApply ?? applyCliUpdate)(ctx.home, inventory.cli.version, cliRow.approved);
        if (moved.outcome === "failed") Object.assign(cliRow, { status: "failed", reason: moved.detail });
        else if (moved.outcome === "current")
          // Already selected (or newer): the person's own command runs `moved.version`.
          Object.assign(cliRow, { status: moved.detail === "installed_newer" ? "installed_newer" : "current", reason: moved.detail, installed: moved.version });
        else Object.assign(cliRow, { status: "updated", reason: moved.detail, installed: moved.version });
      }
    }
    const packRow = components.find((c) => c.id === "skills-cloud");
    const pack = inventory.skills.cloud;
    if (packRow && packRow.status === "update_available" && packRow.approved !== null && pack.state === "installed") {
      if (!effectivePolicy(current, "skills-cloud").enabled) Object.assign(packRow, { status: "held", reason: "owner_setting" });
      else {
        const moved = (options.packApply ?? applyCloudPackUpdate)(ctx.home, pack.dir, packRow.approved);
        if (moved.outcome === "updated") Object.assign(packRow, { status: "updated", reason: moved.detail, installed: moved.version });
        else if (moved.outcome === "linked") Object.assign(packRow, { status: "unknown", reason: moved.detail });
        else Object.assign(packRow, { status: "failed", reason: moved.detail, installed: moved.version ?? packRow.installed });
      }
    }
    if (replicaRow && replicaRow.approved !== null) {
      const cliRuns = cliRow?.status === "updated" || cliRow?.status === "current" || cliRow?.status === "installed_newer";
      const due =
        (replicaRow.status === "restart_after_cli" && cliRuns) ||
        (replicaRow.status === "update_available" && replicaRow.reason === "restart_needed") ||
        (replicaRow.status === "pending" && replicaRow.reason === "restart_interrupted");
      if (replicaRow.status === "restart_after_cli" && cliRow?.status === "failed")
        Object.assign(replicaRow, { status: "pending", reason: "cli_update_failed" });
      else if (due && !effectivePolicy(current, "replica").enabled) Object.assign(replicaRow, { status: "held", reason: "owner_setting" });
      else if (due) {
        const restart =
          options.replicaRestart ??
          (async (target: string): Promise<ReplicaRestartResult> => {
            const cfg = loadConfig(ctx.home);
            // The person's own `catalyst`: it loads the selected version itself (bin/launch.js).
            const launcher = process.argv[1];
            if (!cfg || launcher === undefined) return { outcome: "failed", detail: "writer_unidentified", version: null };
            return restartReplica(ctx, cfg, target, { launcher });
          });
        // The version the person's own command runs now, which the new writer must report.
        const target = cliRuns ? (cliRow?.installed ?? replicaRow.approved) : inventory.cli.version;
        const restarted = await restart(target);
        if (restarted.outcome === "updated") Object.assign(replicaRow, { status: "updated", reason: restarted.detail, installed: restarted.version });
        else if (restarted.outcome === "stopped") Object.assign(replicaRow, { status: "stopped", reason: "stopped", installed: null });
        else Object.assign(replicaRow, { status: "failed", reason: restarted.detail, installed: restarted.version ?? replicaRow.installed });
      }
    }

    // Only a project whose owner turned its SDK updates on, still the directory they registered.
    for (const project of projects)
      if (project.registered && project.policy === "auto" && project.status === "update_available") {
        const result = applySdkUpdate(ctx.home, project.path, release, options.sdkExec);
        Object.assign(project, result.project, { applied: { outcome: result.outcome, detail: result.detail, moved: result.moved } });
      }
  }
  if (options.mode === "apply" && release !== null) writeApprovalCache(ctx.home, { observedAtMs: ctx.now().getTime(), release });

  const report: Omit<UpdateReport, "exitCode"> = {
    schemaVersion: 1,
    mode: options.mode,
    release: release ? { id: release.approvalId, generation: release.generation, releaseLine: release.releaseLine, source: approval.kind === "approved" ? approval.source : "network" } : null,
    unavailable:
      approval.kind === "unavailable"
        ? {
            reason: approval.reason,
            lastObserved: cached ? { id: cached.release.approvalId, generation: cached.release.generation, observedAtMs: cached.observedAtMs } : null,
          }
        : null,
    crossTrain,
    components,
    projects,
    images: imageResult,
    approved: release,
  };
  return { ...report, exitCode: aggregateExit(report) };
}

const STATUS_TEXT: Record<ComponentStatus, (c: ComponentReport) => string> = {
  current: () => "current",
  update_available: () => "update available",
  held: (c) => (c.reason === "peer_image_held" ? "held with a held image" : "held by owner's setting"),
  not_installed: () => "not installed",
  unknown: (c) => `unknown (${c.reason})`,
  installed_newer: () => "newer than approved; kept",
  approval_unavailable: () => "no approved version",
  restart_after_cli: () => "restart after CLI update",
  waiting_for_cli: (c) => `waiting for CLI ${c.approved ?? "update"}`,
  stopped: () => "stopped; stays stopped",
  cross_train: () => "kept on this train",
  updated: () => "updated",
  pending: (c) => `waiting (${c.reason})`,
  failed: (c) => `failed (${c.reason})`,
};

const UNAVAILABLE_TEXT: Record<ApprovalUnavailable, string> = {
  signed_out: "sign in with catalyst login.",
  host_unreadable: "this machine's runner could not read it; check that Docker is running.",
  credential_refused: "sign in with catalyst login.",
  unreachable: "the service could not be reached.",
  not_provided: "this workspace does not yet provide component versions.",
  response_invalid: "the service sent a release this CLI cannot read.",
  envelope_mismatch: "the image and component approvals name different releases.",
};

const cell = (text: string, width: number) => (text.length >= width ? `${text} ` : text.padEnd(width));

function sdkRows(project: ProjectReport): { label: string; installed: string; approved: string; status: string }[] {
  if (project.packages.length === 0)
    return [{ label: `SDK ${project.path}`, installed: "-", approved: "-", status: project.status === "no_sdk" ? "no SDK declared" : `unknown (${project.reason})` }];
  const status = project.applied
    ? project.applied.outcome === "updated"
      ? "updated"
      : project.applied.outcome === "failed"
        ? `failed (${project.applied.detail}); package files put back`
        : `not changed (${project.applied.detail})`
    : project.status === "update_available"
      ? project.policy === "notify"
        ? "notification only"
        : "update available"
      : project.status === "unknown"
        ? `unknown (${project.reason})`
        : project.status === "approval_unavailable"
          ? "no approved version"
          : project.status === "installed_newer"
            ? "newer than approved; kept"
            : "current";
  return project.packages.map((p) => ({
    label: `${SDK_LABELS[p.name] ?? p.name} ${project.path}`,
    installed: p.installed ?? p.locked ?? p.declared,
    approved: p.approved ?? "-",
    status,
  }));
}

/** The person-readable report: a header, one row per component and SDK package, then what to run. */
export function updateReportLines(report: UpdateReport): string[] {
  const lines: string[] = [];
  const unchanged = report.mode === "check" ? "Nothing was changed." : null;
  if (report.release) {
    lines.push(`Approved release: ${report.release.id}, generation ${report.release.generation}, train ${report.release.releaseLine}`);
  } else if (report.unavailable) {
    lines.push(`Approved release unavailable: ${UNAVAILABLE_TEXT[report.unavailable.reason]}`);
    if (report.unavailable.lastObserved)
      lines.push(`Last observed release: ${report.unavailable.lastObserved.id}, generation ${report.unavailable.lastObserved.generation}. It was not used to apply updates.`);
    const anyImage = report.components.some((c) => c.approved !== null);
    if (!anyImage) {
      lines.push(report.mode === "check" ? "Nothing was changed." : "No components were changed.");
      return lines;
    }
  }
  if (report.crossTrain)
    lines.push(`Automatic updates stay on train ${report.crossTrain.supported}. The approved release is on train ${report.crossTrain.approved}; no components were changed.`);

  lines.push(`${cell("Component", 19)}${cell("Installed", 16)}${cell("Approved", 16)}Status`);
  for (const c of report.components)
    lines.push(`${cell(COMPONENT_LABELS[c.id], 19)}${cell(c.installed ?? "-", 16)}${cell(c.approved ?? "-", 16)}${STATUS_TEXT[c.status](c)}`);
  for (const project of report.projects)
    for (const r of sdkRows(project)) lines.push(`${cell(r.label, 19)}${cell(r.installed, 16)}${cell(r.approved, 16)}${r.status}`);
  if (report.projects.length === 0) lines.push("SDK projects: none registered");

  for (const c of report.components)
    if (c.action !== null && (c.status === "update_available" || c.status === "pending"))
      lines.push(`${COMPONENT_LABELS[c.id]}: this CLI does not install ${c.approved ?? "it"} by itself yet. Run: ${c.action}`);
  for (const project of report.projects)
    if (project.command !== null && project.applied?.outcome !== "updated") lines.push(`Update this project's SDK: ${project.command}`);
  // CTC-6741: a failed CLI move leaves the running version in place; say so, and when it is tried again.
  const cli = report.components.find((c) => c.id === "cli");
  if (cli?.status === "failed")
    lines.push(
      `CLI: the update to ${cli.approved ?? "the approved version"} failed (${cli.reason}). You keep running ${cli.installed ?? "the installed version"}. The next release check tries again: within 15 minutes when automatic updates are on, or run catalyst update.`,
    );

  if (unchanged) lines.push("Checked the approved release; nothing was changed.");
  else {
    const held = report.components.some((c) => c.status === "held" || c.status === "waiting_for_cli");
    lines.push(
      report.exitCode !== 0
        ? "Release check finished with components that need attention."
        : held
          ? "Release check finished with held components."
          : "Release check finished.",
    );
  }
  return lines;
}

/** The report as `--json` prints it: the decision model, without internal engine detail. */
export function updateReportJson(report: UpdateReport): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    release: report.release,
    unavailable: report.unavailable,
    crossTrain: report.crossTrain,
    components: report.components,
    projects: report.projects.map((p) => ({
      path: p.path,
      registered: p.registered,
      policy: p.policy,
      packageManager: p.packageManager,
      packages: p.packages,
      status: p.status,
      reason: p.reason,
      command: p.command,
      packageManagerCommand: p.packageManagerCommand,
      applied: p.applied,
    })),
    exitCode: report.exitCode,
  };
}

/** Every component's effective setting, for `catalyst update policy`. */
export function policyLines(policy: UpdatePolicy): string[] {
  const lines = ["Automatic updates:"];
  for (const id of UPDATE_COMPONENTS) {
    const p = effectivePolicy(policy, id);
    lines.push(`${cell(COMPONENT_LABELS[id], 19)}${cell(p.enabled ? "on" : "off", 5)}(${p.source})`);
  }
  if (policy.projects.length === 0) lines.push("SDK projects: none registered");
  for (const project of policy.projects)
    lines.push(`${cell(`SDK ${project.path}`, 19)}${cell(project.sdk === "auto" ? "on" : "off", 5)}(${project.source}${project.sdk === "notify" ? ", notify only" : ""})`);
  return lines;
}

