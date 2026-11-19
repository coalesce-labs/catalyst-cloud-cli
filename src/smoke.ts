// smoke.ts — CTC-11083: `catalyst smoke readme --team <KEY> --repo <owner/name>`.
//
// Proves that a repository is onboarded by running one real ticket through the team's pipeline:
// the ticket asks for one README line, `Catalyst Cloud enabled`, and the verb watches it from the
// dispatch stage to a merge on the repository's default branch. Every fact comes from the cloud:
//   - the README check is the cloud's read-only marker route (it never reads a local checkout or a
//     local GitHub login), before the trial so a rerun never asks for a second line, and again
//     after the merge with the landed commit;
//   - the landed commit is the pull request detail's `merged_commit_sha`, never the branch head,
//     which is not on the base branch after a squash or rebase merge.
//
// The machine status separates a hold from a merge. Only `merged` exits 0, and only when the trial's
// own pull request, in the repository asked for, merged into the default branch, its landed commit
// is on that branch's history, and the marker reads present there. The verb never merges, closes or
// reverts anything. One trial per team and repository: a receipt on this computer holds the ticket,
// so a rerun resumes the existing trial before it checks the README again.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { configDirFor, requireConfig, type Ctx } from "./config.js";
import { findTeamByKey, loadContract, routePath } from "./contract.js";
import type { ContractTeam, TenantContract } from "./contract-types.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { gateFromContract, type TicketExecution } from "./execution.js";
import { apiClient } from "./transport.js";
import { postAgent } from "./write.js";

export const SMOKE_MARKER = "Catalyst Cloud enabled";
export const SMOKE_TITLE = "Catalyst Cloud smoke: add one README line";

/** The end states, each with its own exit code. Only `merged` is 0. */
export type SmokeStatus =
  | "merged"
  | "refused"
  | "waiting_on_owner"
  | "blocked"
  | "deadline_missed"
  | "merged_unverified";

export const SMOKE_EXIT: Record<SmokeStatus, number> = {
  merged: 0,
  refused: 3,
  waiting_on_owner: 4,
  blocked: 5,
  deadline_missed: 6,
  merged_unverified: 7,
};

/** The stage a deadline applies to: dispatch to the first phase, any phase, and ready to merged. */
export type SmokeStage = "launch" | "phase" | "merge";
export const DEFAULT_DEADLINES: Record<SmokeStage, number> = { launch: 15, phase: 45, merge: 60 };

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const TICKET = /^[A-Z][A-Z0-9]{0,7}-[0-9]{1,9}$/;
const ISSUE_FIELDS = "identifier,state,state_id,url,completed_at,canceled_at,labels,linked_pulls";

export interface MarkerAnswer {
  repository?: string;
  state: "present" | "absent" | "readme_missing" | "unavailable";
  reason?: string;
  defaultBranch: string | null;
  commitSha: string | null;
  mergeSha?: string;
  mergeShaOnDefaultBranch?: boolean | null;
}

export interface LinkedPull {
  repo_id?: string | null;
  number?: number | null;
  node_id?: string | null;
  state?: string | null;
  draft?: number | boolean | null;
  merged?: number | boolean | null;
}

export interface IssueRead {
  identifier?: string;
  state?: string | null;
  state_id?: string | null;
  url?: string | null;
  completed_at?: unknown;
  canceled_at?: unknown;
  labels?: { name?: string | null }[] | null;
  linked_pulls?: LinkedPull[] | null;
}

export interface PullRead {
  repo_id?: string | null;
  number?: number | null;
  state?: string | null;
  draft?: number | boolean | null;
  merged?: number | boolean | null;
  base_ref?: string | null;
  /** CTC-11086. Absent on an older cloud, which is not the same as null. */
  merged_commit_sha?: string | null;
}

/** Every cloud read and write the verb makes, so a test can script them. */
export interface SmokeApi {
  contract(): Promise<TenantContract>;
  /** null when the cloud answers 404: the repository is not registered to this workspace. */
  marker(repo: string, mergeSha?: string): Promise<MarkerAnswer | null>;
  create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  issue(ticket: string): Promise<IssueRead | null>;
  execution(ticket: string): Promise<TicketExecution | null>;
  pull(nodeId: string): Promise<PullRead | null>;
}

export interface SmokeDeps {
  api?: SmokeApi;
  sleep?: (ms: number) => Promise<void>;
}

export interface SmokeOptions {
  team: string;
  repo: string;
  deadlines: Record<SmokeStage, number>;
  intervalSeconds: number;
}

export interface SmokeResult {
  status: SmokeStatus;
  reason: string;
  team: string;
  repository: string;
  /** What happens next, and who does it. */
  next: string;
  ticket?: string;
  url?: string;
  resumed?: boolean;
  stage?: SmokeStage;
  pullRequest?: { number: number | null; state: string | null; mergedCommitSha?: string | null };
  marker?: MarkerAnswer;
  elapsedSeconds: number;
}

interface SmokeReceipt {
  version: 1;
  team: string;
  repo: string;
  idempotencyId: string;
  createdAt: string;
  baseCommit?: string | null;
  ticket?: string;
  url?: string;
}

const truthy = (v: unknown) => v === true || v === 1;

export function smokeReceiptPath(home: string, account: string, team: string, repo: string): string {
  const [owner, name] = repo.split("/");
  return join(configDirFor(home), "smoke", account, `${team}-${owner}-${name}.json`);
}

function readReceipt(path: string): SmokeReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SmokeReceipt;
    return parsed?.version === 1 && typeof parsed.idempotencyId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeReceipt(path: string, receipt: SmokeReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export function smokeDescription(repo: string): string {
  return [
    `Add the line \`${SMOKE_MARKER}\` as the last line of README.md in ${repo}. Change nothing else.`,
    "",
    `If README.md already has a line that reads exactly \`${SMOKE_MARKER}\`, change nothing and say so.`,
    "",
    "`catalyst smoke readme` created this ticket to check that this repository runs through Catalyst from start to merge.",
  ].join("\n");
}

/** The trial's pull request: the newest one linked to the ticket in the repository asked for. */
function trialPull(issue: IssueRead | null, repo: string): LinkedPull | null {
  const rows = (issue?.linked_pulls ?? []).filter(
    (row) => typeof row.repo_id === "string" && row.repo_id.toLowerCase() === repo.toLowerCase() && row.node_id,
  );
  rows.sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0));
  return rows[0] ?? null;
}

/** A governor that holds the ticket until someone acts. A live lease is a phase at work, and a park
 *  the cloud releases by itself is a wait, not a block. */
function blockingGovernor(exec: TicketExecution | null) {
  return (exec?.governors ?? []).find(
    (g) => g.kind !== "live_lease" && !(g.kind === "phase_park" && exec?.park?.selfReleases === true),
  );
}

function phaseSummary(exec: TicketExecution | null): string {
  const phases = exec?.phases ?? [];
  return phases.length === 0 ? "none yet" : phases.map((p) => `${p.phase} ${p.status ?? "?"}`).join(", ");
}

type Verdict = { final: true; result: Omit<SmokeResult, "elapsedSeconds" | "team" | "repository"> } | { final: false; reason: string };

const OWNER_CONTROL =
  "This command never merges, closes or reverts. To undo the trial, close its pull request, or remove the line in a new commit.";

/** Grade a merged trial pull request. Pending verdicts are evidence the cloud has not caught up on. */
async function verifyMerged(api: SmokeApi, repo: string, ticket: string, pull: PullRead): Promise<Verdict> {
  const pr = { number: pull.number ?? null, state: pull.state ?? null };
  const unverified = (reason: string, next: string, marker?: MarkerAnswer): Verdict => ({
    final: true,
    result: {
      status: "merged_unverified",
      reason,
      next,
      ticket,
      pullRequest: { ...pr, mergedCommitSha: pull.merged_commit_sha ?? null },
      ...(marker ? { marker } : {}),
    },
  });
  if (!("merged_commit_sha" in pull)) {
    return unverified(
      "cloud_omits_merged_commit",
      "This cloud does not name the commit a pull request landed as yet, so the merge cannot be verified. Run this again after the cloud updates.",
    );
  }
  const sha = pull.merged_commit_sha;
  if (typeof sha !== "string") return { final: false, reason: "merged_commit_unknown" };
  const marker = await api.marker(repo, sha);
  if (marker === null) {
    return unverified("repository_not_registered", `${repo} is no longer registered to this workspace.`);
  }
  if (marker.state === "unavailable") return { final: false, reason: `marker_unavailable:${marker.reason ?? "unknown"}` };
  if (marker.defaultBranch && pull.base_ref && pull.base_ref !== marker.defaultBranch) {
    return unverified(
      "merged_into_other_branch",
      `The trial pull request merged into ${pull.base_ref}, not the default branch ${marker.defaultBranch}.`,
      marker,
    );
  }
  if (marker.mergeShaOnDefaultBranch === false) {
    return unverified(
      "merged_commit_not_on_default_branch",
      `Commit ${sha} is not on ${marker.defaultBranch ?? "the default branch"} at ${marker.commitSha ?? "its head"}.`,
      marker,
    );
  }
  if (marker.mergeShaOnDefaultBranch !== true) return { final: false, reason: "ancestry_unknown" };
  if (marker.state !== "present") {
    return unverified(
      "merged_without_marker",
      `The trial merged, but README.md on ${marker.defaultBranch} at ${marker.commitSha} reads ${marker.state}.`,
      marker,
    );
  }
  return {
    final: true,
    result: {
      status: "merged",
      reason: "marker_on_default_branch",
      next: OWNER_CONTROL,
      ticket,
      pullRequest: { ...pr, mergedCommitSha: sha },
      marker,
    },
  };
}

/** A transient read failure keeps the watch going; a refusal (401, 403) stops it. */
function transient(error: unknown): boolean {
  if (error instanceof MeError) return error.kind === "network";
  if (error instanceof CliError) return error.status === undefined || error.status >= 500 || error.status === 429;
  return false;
}

export async function runSmokeReadme(
  ctx: Ctx,
  opts: SmokeOptions,
  account: string,
  api: SmokeApi,
  sleep: (ms: number) => Promise<void>,
  emit: (line: string) => void,
): Promise<SmokeResult> {
  const startedMs = ctx.now().getTime();
  const elapsed = () => Math.round((ctx.now().getTime() - startedMs) / 1000);
  const base = { team: opts.team, repository: opts.repo };
  const done = (r: Omit<SmokeResult, "elapsedSeconds" | "team" | "repository">): SmokeResult => ({
    ...base,
    ...r,
    elapsedSeconds: elapsed(),
  });
  const refused = (reason: string, next: string, extra: Partial<SmokeResult> = {}) =>
    done({ status: "refused", reason, next, ...extra });

  const doc = await api.contract();
  if (!doc.routes.some((r) => r.path.split("/").filter(Boolean).at(-1) === "repo-readme-marker")) {
    throw new CliError(
      "this cloud does not serve the README marker read yet, so a smoke trial cannot be graded; update the cloud first",
      "smoke-unsupported",
      2,
    );
  }
  const team: ContractTeam | null = findTeamByKey(doc, opts.team);
  if (!team?.key) return refused("team_unknown", `No project is mapped for Linear team ${opts.team}. Map it first: catalyst team adopt ${opts.team}.`);
  const gate = gateFromContract(team.dispatchGate);
  if (gate) {
    return refused(`dispatch_gate:${gate.cause}`, gate.remedy ?? `Team ${team.key} cannot dispatch tickets (${gate.cause}); a workspace admin fixes its stage mapping.`);
  }
  const dispatch = team.stages.dispatch;
  if (!dispatch?.stateStillExists) {
    return refused("dispatch_stage_unmapped", `Team ${team.key} has no dispatch stage that still exists in Linear. Run catalyst team check ${team.key}.`);
  }
  const repos = team.repositories;
  const registered = repos?.registered.find((r) => r.toLowerCase() === opts.repo.toLowerCase());
  if (!registered) {
    return refused("repository_not_registered", `${opts.repo} is not registered to team ${team.key}. Connect it to the project, then run this again.`);
  }
  const repo = registered;
  base.repository = repo;
  // The trial binds its repository before dispatch unless it is the team's default.
  const needsRepoLabel = (repos?.default ?? "").toLowerCase() !== repo.toLowerCase();

  const receiptPath = smokeReceiptPath(ctx.home, account, team.key, repo);
  let receipt = readReceipt(receiptPath);
  let ticket: string | undefined;
  let url: string | undefined;
  let resumed = false;

  // Resume an existing trial before reading the README again: after a merge the line is present
  // because of this very trial.
  if (receipt?.ticket) {
    const prior = await api.issue(receipt.ticket);
    if (prior && !prior.canceled_at) {
      ticket = receipt.ticket;
      url = receipt.url ?? prior.url ?? undefined;
      resumed = true;
      emit(`Resuming trial ${ticket}${url ? ` (${url})` : ""}.`);
    } else {
      const archived = receiptPath.replace(/\.json$/, `.closed-${ctx.now().toISOString().replace(/[:.]/g, "-")}.json`);
      renameSync(receiptPath, archived);
      emit(`The earlier trial ${receipt.ticket} is ${prior ? "canceled" : "gone"}; its receipt moved to ${archived}.`);
      receipt = null;
    }
  }

  if (!ticket) {
    const marker = await api.marker(repo);
    if (marker === null) {
      return refused("repository_not_registered", `The cloud does not know ${repo} in this workspace. Connect it, then run this again.`);
    }
    if (marker.state === "present") {
      return refused(
        "already_present",
        `README.md on ${marker.defaultBranch} at ${marker.commitSha} already has the line "${SMOKE_MARKER}", so a trial would prove nothing. Remove the line, or run this again to re-read an earlier trial.`,
        { marker },
      );
    }
    if (marker.state === "readme_missing") {
      return refused("readme_missing", `${repo} has no README.md on ${marker.defaultBranch}. Add one, then run this again.`, { marker });
    }
    if (marker.state === "unavailable") {
      return refused(
        `marker_unavailable:${marker.reason ?? "unknown"}`,
        `Catalyst could not read ${repo} (${marker.reason ?? "no reason given"}). Check that the Catalyst GitHub App can read it, then run this again.`,
        { marker },
      );
    }
    // Saved before the write, so a create that lands but loses its answer is resent with the same
    // key and answers with the first ticket.
    receipt ??= {
      version: 1,
      team: team.key,
      repo,
      idempotencyId: `smoke-readme:${randomUUID()}`,
      createdAt: ctx.now().toISOString(),
    };
    receipt.baseCommit = marker.commitSha;
    writeReceipt(receiptPath, receipt);
    const created = await api.create({
      teamId: team.id,
      title: SMOKE_TITLE,
      description: smokeDescription(repo),
      stateId: dispatch.stateId,
      idempotencyId: receipt.idempotencyId,
      ...(needsRepoLabel ? { labelNames: [`repo:${repo}`] } : {}),
    });
    const identifier = created.identifier;
    if (typeof identifier !== "string" || !TICKET.test(identifier)) {
      throw new CliError("the cloud created the trial but did not name its ticket; run this again to resend the same create", "smoke-create-unverified", 2);
    }
    ticket = identifier;
    url = typeof created.url === "string" ? created.url : undefined;
    receipt.ticket = ticket;
    if (url) receipt.url = url;
    writeReceipt(receiptPath, receipt);
    emit(`Created ${ticket} in ${dispatch.name ?? "the dispatch stage"} of team ${team.key}${url ? `: ${url}` : ""}.`);
  }

  const holdNames = new Set(team.labels.hold.map((l) => l.name.toLowerCase()));
  let signature = "";
  let stage: SmokeStage = "launch";
  let stageSinceMs = ctx.now().getTime();
  let pending: string | undefined;
  for (;;) {
    let issue: IssueRead | null = null;
    let exec: TicketExecution | null = null;
    let pull: PullRead | null = null;
    try {
      issue = await api.issue(ticket);
      exec = await api.execution(ticket);
      const linked = trialPull(issue, repo);
      pull = linked?.node_id ? await api.pull(linked.node_id) : null;
    } catch (error) {
      if (!transient(error)) throw error;
      emit(`  (read failed, retrying: ${error instanceof Error ? error.message : String(error)})`);
    }
    const ready = pull !== null && pull.state === "open" && !truthy(pull.draft);
    const nextStage: SmokeStage = ready || truthy(pull?.merged) ? "merge" : (exec?.phases?.length ?? 0) > 0 ? "phase" : "launch";
    const prText = pull ? `PR #${pull.number ?? "?"} ${truthy(pull.merged) ? "merged" : `${pull.state ?? "?"}${truthy(pull.draft) ? " draft" : ""}`}` : "no PR yet";
    const now = ctx.now().getTime();
    const next = [issue?.state ?? "?", phaseSummary(exec), prText].join(" | ");
    if (next !== signature || nextStage !== stage) {
      signature = next;
      stage = nextStage;
      stageSinceMs = now;
      emit(`${String(elapsed()).padStart(5)}s  ${ticket}: ${issue?.state ?? "not readable yet"}; phases: ${phaseSummary(exec)}; ${prText}`);
    }
    const common = { ticket, ...(url ? { url } : {}), resumed, stage };
    const prOut = pull ? { number: pull.number ?? null, state: pull.state ?? null } : undefined;

    if (issue?.canceled_at) {
      return done({ status: "blocked", reason: "ticket_canceled", next: `${ticket} was canceled. Run this again to start a new trial.`, ...common });
    }
    if (pull && truthy(pull.merged)) {
      const verdict = await verifyMerged(api, repo, ticket, pull);
      if (verdict.final) return done({ ...common, ...verdict.result });
      pending = verdict.reason;
    } else if (pull && pull.state === "closed") {
      return done({
        status: "blocked",
        reason: "pull_request_closed",
        next: `The trial pull request #${pull.number ?? "?"} was closed without merging. Reopen it, or run catalyst explain ${ticket}.`,
        ...common,
        ...(prOut ? { pullRequest: prOut } : {}),
      });
    } else if (ready) {
      const hold = (issue?.labels ?? []).find((l) => typeof l.name === "string" && holdNames.has(l.name.toLowerCase()));
      const owned = (exec?.governors ?? []).find((g) => g.kind === "human_owned_pr");
      if (hold || owned) {
        return done({
          status: "waiting_on_owner",
          reason: hold ? `hold_label:${hold.name}` : "human_owned_pr",
          next: `The trial pull request is ready and its owner keeps merge control. Merge it or remove the hold, then run this again to verify the merge. ${OWNER_CONTROL}`,
          ...common,
          ...(prOut ? { pullRequest: prOut } : {}),
        });
      }
    }
    const governor = blockingGovernor(exec);
    if (governor) {
      return done({
        status: "blocked",
        reason: `${governor.kind}${governor.sentinel ? `:${governor.sentinel}` : ""}`,
        next: governor.release ?? `Run catalyst explain ${ticket} to see what holds it.`,
        ...common,
        ...(prOut ? { pullRequest: prOut } : {}),
      });
    }
    if (now - stageSinceMs >= opts.deadlines[stage] * 60_000) {
      if (pull && truthy(pull.merged)) {
        return done({
          status: "merged_unverified",
          reason: pending ?? "merged_commit_unknown",
          next: `The trial merged, but the cloud could not verify it within ${opts.deadlines.merge} min. Run this again to resume the same trial.`,
          ...common,
          pullRequest: { number: pull.number ?? null, state: pull.state ?? null, mergedCommitSha: pull.merged_commit_sha ?? null },
        });
      }
      if (ready) {
        return done({
          status: "waiting_on_owner",
          reason: "ready_not_merged",
          next: `The trial pull request has been ready for ${opts.deadlines.merge} min and nothing merged it. Its owner merges it; run this again afterwards to verify. ${OWNER_CONTROL}`,
          ...common,
          ...(prOut ? { pullRequest: prOut } : {}),
        });
      }
      return done({
        status: "deadline_missed",
        reason: `${stage}_deadline`,
        next: `Nothing moved for ${opts.deadlines[stage]} min (last seen: ${signature}). Run catalyst explain ${ticket}, and run this again to keep watching the same trial.`,
        ...common,
        ...(prOut ? { pullRequest: prOut } : {}),
      });
    }
    await sleep(opts.intervalSeconds * 1000);
  }
}

function parseDeadlines(values: string[]): Record<SmokeStage, number> {
  const out = { ...DEFAULT_DEADLINES };
  for (const value of values) {
    const m = /^(launch|phase|merge)=([0-9]{1,4})$/.exec(value);
    if (!m || Number(m[2]) < 1) throw new UsageError(`--deadline takes launch|phase|merge=<minutes>, at least 1 (got "${value}")`);
    out[m[1] as SmokeStage] = Number(m[2]);
  }
  return out;
}

function liveApi(ctx: Ctx, cfg: ReturnType<typeof requireConfig>): SmokeApi {
  const api = apiClient(cfg, ctx);
  let doc: TenantContract | undefined;
  const contract = () => {
    if (!doc) throw new CliError("the contract was not read first", "smoke-internal", 2);
    return doc;
  };
  const read = async <T>(path: string, query?: Record<string, string | undefined>): Promise<T | null> => {
    const res = await api.getJson<T>(path, { query, accept: [404] });
    return res.status === 404 ? null : res.body;
  };
  return {
    contract: async () => (doc = (await loadContract(ctx, cfg, { refresh: true })).doc),
    marker: (repo, mergeSha) => read<MarkerAnswer>(routePath(contract(), "repo-readme-marker"), { repo, mergeSha }),
    create: (body) => postAgent<Record<string, unknown>>(api, contract(), "issue-create", body),
    issue: (t) => read<IssueRead>(`/api/v1/issues/${encodeURIComponent(t)}`, { fields: ISSUE_FIELDS }),
    execution: (t) => read<TicketExecution>(`/api/v1/issues/${encodeURIComponent(t)}/execution`),
    pull: (id) => read<PullRead>(`/api/v1/pulls/${encodeURIComponent(id)}`),
  };
}

function renderResult(r: SmokeResult): string[] {
  const lines = [`Smoke ${r.status}${r.ticket ? ` for ${r.ticket}` : ""} (${r.reason}) after ${r.elapsedSeconds}s.`];
  if (r.pullRequest) {
    lines.push(`Pull request #${r.pullRequest.number ?? "?"}: ${r.pullRequest.state ?? "?"}${r.pullRequest.mergedCommitSha ? `, landed as ${r.pullRequest.mergedCommitSha}` : ""}`);
  }
  if (r.marker?.commitSha) {
    lines.push(`README.md on ${r.marker.defaultBranch} at ${r.marker.commitSha}: ${r.marker.state}`);
  }
  lines.push(`Next: ${r.next}`);
  return lines;
}

/** `catalyst smoke readme --team <KEY> --repo <owner/name> [--deadline stage=min]... [--interval s] [--json]` */
export async function cmdSmoke(args: ParsedArgs, ctx: Ctx, deps: SmokeDeps = {}): Promise<number> {
  const [what] = positionals(args);
  if (what !== "readme") throw new UsageError("smoke needs a check: smoke readme --team <KEY> --repo <owner/name>");
  const team = flagString(args, "team")?.trim().toUpperCase();
  const repo = flagString(args, "repo")?.trim();
  if (!team) throw new UsageError("smoke readme needs --team <KEY>");
  const named = REPO.exec(repo ?? "");
  if (!repo || !named || [named[1], named[2]].some((part) => part === "." || part === "..")) {
    throw new UsageError("smoke readme needs --repo <owner/name>");
  }
  const intervalText = flagString(args, "interval");
  const intervalSeconds = intervalText === undefined ? 30 : Number(intervalText);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 600) {
    throw new UsageError("--interval takes whole seconds from 5 to 600");
  }
  const opts: SmokeOptions = { team, repo, deadlines: parseDeadlines(flagList(args, "deadline")), intervalSeconds };
  const cfg = requireConfig(ctx);
  const api = deps.api ?? liveApi(ctx, cfg);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emit = args.json ? ctx.stderr : ctx.stdout;
  const result = await runSmokeReadme(ctx, opts, cfg.account, api, sleep, emit);
  if (args.json) ctx.stdout(JSON.stringify(result));
  else for (const line of renderResult(result)) ctx.stdout(line);
  return SMOKE_EXIT[result.status];
}
