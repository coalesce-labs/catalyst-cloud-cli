// env-status.ts — CTC-10325. `catalyst env status` says which revision of a repository's environment
// is in effect for new phases, and that reaching the default branch approved it, naming the full
// commit and, when the cloud found one, the merged pull request (CTC-5625, decision B on CTC-10276).
// It reads `GET /api/v1/agent/repo-environments?repo=<owner>/<name>` and prints the same lines as
// catalyst-cloud's private `catalyst-env env status`, which words them with
// `@catalyst-cloud/environment/revision-approval`. That package is not published, so the sentences
// are restated here; test/env-status.test.ts pins each one to the private CLI's exact text.
//
// ⛔ THE ROUTE COMES FROM `routes[]`. A cloud whose contract has no GET row for it is older than this
// read: the command says so and calls nothing.
// ⛔ NO LINE CARRIES THE KEY or the origin remote's URL.
//
// Exit codes: 0 the answer printed (a revision, nothing in effect, or one still applying); 1 usage,
// or the repository could not be named or is not in the workspace; 2 the cloud does not publish
// this read or answered an unusable body.
import { resolve } from "node:path";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import { UsageError } from "./errors.js";
import { readLocalRepositoryName } from "./onboard-settings-context.js";
import { apiClient } from "./transport.js";

const ROUTE_SUFFIX = "/agent/repo-environments";
const REPOSITORY_ARG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface EnvStatusDeps {
  /** The repository the checkout's origin remote names, lower-cased; null when it names none. */
  originRepository?: (root: string) => Promise<string | null>;
}

interface StatusBody {
  repository: string;
  defaultBranch: string | null;
  inEffect: { revision: number; approval: Record<string, unknown> } | null;
  applying: { revision: number; commitSha: string | null; restoreHeld: boolean } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The body the route answers, or null when it is not that shape. */
export function readStatusBody(raw: unknown): StatusBody | null {
  if (!isRecord(raw) || typeof raw.repository !== "string") return null;
  let inEffect: StatusBody["inEffect"] = null;
  if (raw.inEffect !== null) {
    const live = raw.inEffect;
    if (!isRecord(live) || !isPositiveInteger(live.revision) || !isRecord(live.approval)) return null;
    inEffect = { revision: live.revision, approval: live.approval };
  }
  let applying: StatusBody["applying"] = null;
  if (raw.applying !== null) {
    const next = raw.applying;
    if (!isRecord(next) || !isPositiveInteger(next.revision)) return null;
    applying = { revision: next.revision, commitSha: stringOrNull(next.commitSha), restoreHeld: next.restoreHeld === true };
  }
  return { repository: raw.repository, defaultBranch: stringOrNull(raw.defaultBranch), inEffect, applying };
}

/** The two sentences for a revision the default branch approved, in the private CLI's words. */
export function defaultBranchApprovalSentences(approval: Record<string, unknown>): string[] {
  const rawBranch = approval.branch;
  const branch =
    typeof rawBranch === "string" && rawBranch.length > 0 && rawBranch.length <= 256 ? rawBranch : "the default branch";
  const note = `A merge or push to ${branch} approves the settings file, so there is nothing to approve in Catalyst.`;
  const commit = typeof approval.commitSha === "string" && COMMIT_SHA.test(approval.commitSha) ? approval.commitSha : null;
  if (commit === null) return [`Approved automatically when this revision reached ${branch}.`, note];
  const pull = isRecord(approval.pullRequest) && isPositiveInteger(approval.pullRequest.number) ? approval.pullRequest.number : null;
  if (pull !== null) return [`Approved automatically when pull request #${pull} merged as commit ${commit} into ${branch}.`, note];
  return [`Approved automatically when commit ${commit} reached ${branch}.`, note];
}

/** The lines the revision in effect and any revision still applying say. */
export function statusLines(body: StatusBody): string[] {
  const onBranch = body.defaultBranch !== null ? ` on ${body.defaultBranch}` : "";
  const lines: string[] = [];
  const live = body.inEffect;
  if (live === null) {
    lines.push(`${body.repository}: no declaration is in effect for new phases.`);
  } else {
    lines.push(`${body.repository}: revision ${live.revision} is in effect for new phases.`);
    if (live.approval.kind === "default-branch") {
      lines.push(...defaultBranchApprovalSentences(live.approval));
    } else if (live.approval.kind === "restore" && isPositiveInteger(live.approval.sourceRevision)) {
      lines.push(`Revision ${live.revision} was restored from revision ${live.approval.sourceRevision} by an admin or owner.`);
    }
  }
  const next = body.applying;
  if (next !== null) {
    const branch = body.defaultBranch ?? "the default branch";
    if (next.commitSha === null) {
      lines.push(`Revision ${next.revision} is not in effect: it did not come from .catalyst/catalyst.toml on ${branch}.`);
    } else if (next.restoreHeld && live !== null) {
      lines.push(
        `Revision ${next.revision} from commit ${next.commitSha}${onBranch} is not in effect: revision ${live.revision} was restored, and it stays in effect until [environment] changes on ${branch}.`,
      );
    } else {
      lines.push(
        `Catalyst is applying revision ${next.revision} from commit ${next.commitSha}${onBranch}.${
          live !== null ? ` New phases use revision ${live.revision} until it is applied.` : ""
        }`,
      );
    }
  }
  return lines;
}

export async function cmdEnvStatus(args: ParsedArgs, ctx: Ctx, deps: EnvStatusDeps = {}): Promise<number> {
  if (positionals(args).length > 1) throw new UsageError("env status takes no positional arguments; use --repo OWNER/NAME");
  let repo = flagString(args, "repo");
  if (repo !== undefined) {
    if (!REPOSITORY_ARG.test(repo)) throw new UsageError("name the repository as --repo OWNER/NAME");
  } else {
    const root = resolve(flagString(args, "root") ?? ".");
    const named = await (deps.originRepository ?? readLocalRepositoryName)(root);
    if (named === null) {
      ctx.stderr("env status: this checkout's origin remote does not name a GitHub repository; pass --repo OWNER/NAME");
      return 1;
    }
    repo = named;
  }

  const cfg = requireConfig(ctx);
  const loaded = await loadContract(ctx, cfg);
  const route = loaded.doc.routes.find((row) => row.method === "GET" && row.path.endsWith(ROUTE_SUFFIX));
  if (route === undefined) {
    ctx.stderr(
      `env status: this cloud does not publish the repository environment read yet (contract ${loaded.doc.contractVersion}); run it again after the cloud is updated`,
    );
    return 2;
  }

  const res = await apiClient(cfg, ctx).getJson<unknown>(route.path, { query: { repo }, accept: [404], parseAccepted: false });
  if (res.status === 404) {
    ctx.stderr(`${repo} is not a repository in this workspace`);
    return 1;
  }
  const body = readStatusBody(res.body);
  if (body === null) {
    ctx.stderr(`env status: GET ${route.path} answered an unusable body`);
    return 2;
  }
  if (args.json) {
    ctx.stdout(JSON.stringify(res.body, null, 2));
    return 0;
  }
  for (const line of statusLines(body)) ctx.stdout(line);
  return 0;
}
