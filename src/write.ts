// write.ts — writes to Linear as the app actor through the agent proxy. Every route path comes from
// the contract's route table (never a literal); every stage id from `teams[].stages` by slot; every
// label id from `teams[].labels`; the bookkeeping marker from `vocabulary`. `delegate` is never offered.
// A label goes by its name in `labelNames` unless the value itself is a UUID (CTC-5871).
import { readFileSync } from "node:fs";
import { flagBool, flagInt, flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { bookkeepingPrefix, labelId, loadContract, routePath, stageIdForSlot, teamByKey, teamForTicket } from "./contract.js";
import type { ContractTeam, TenantContract } from "./contract-types.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { apiClient, type ApiClient } from "./transport.js";

export interface WriteDeps {
  readStdin?: () => Promise<string>;
}

export interface ResolvedIssue {
  id: string;
  identifier: string;
  teamId: string | null;
  projectId: string | null;
}

/** A ticket identifier → its Linear id (and team/project) through GET /api/v1/issues/:identifier. */
export async function resolveIssue(api: ApiClient, ticket: string): Promise<ResolvedIssue> {
  const res = await api.getJson<Record<string, unknown>>(`/api/v1/issues/${encodeURIComponent(ticket)}`, { accept: [404] });
  if (res.status === 404 || !res.body || typeof res.body.id !== "string") {
    throw new CliError(`ticket ${ticket} is not in the mirror — check the identifier`, "ticket-unknown");
  }
  return {
    id: res.body.id,
    identifier: typeof res.body.identifier === "string" ? res.body.identifier : ticket,
    teamId: typeof res.body.team_id === "string" ? res.body.team_id : null,
    projectId: typeof res.body.project_id === "string" ? res.body.project_id : null,
  };
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  teamId: string | null;
}

/** GET /api/v1/workflow-stages, read tolerantly: `{teams:[{teamId|id|key, states|stages:[...]}]}`,
 *  `{stages:[...]}` or a bare array of states each carrying `team_id|teamId`. */
export async function fetchWorkflowStates(api: ApiClient): Promise<WorkflowState[]> {
  const res = await api.getJson<unknown>("/api/v1/workflow-stages");
  const out: WorkflowState[] = [];
  const push = (s: Record<string, unknown>, teamId: string | null) => {
    if (typeof s.id !== "string") return;
    out.push({
      id: s.id,
      name: String(s.name ?? ""),
      type: String(s.type ?? ""),
      teamId: (typeof s.team_id === "string" ? s.team_id : typeof s.teamId === "string" ? s.teamId : teamId) ?? null,
    });
  };
  const body = res.body as Record<string, unknown> | unknown[];
  if (Array.isArray(body)) {
    for (const s of body) push(s as Record<string, unknown>, null);
  } else if (body && typeof body === "object") {
    const teams = (body as Record<string, unknown>).teams;
    if (Array.isArray(teams)) {
      for (const t of teams as Record<string, unknown>[]) {
        const teamId = typeof t.teamId === "string" ? t.teamId : typeof t.id === "string" ? t.id : typeof t.team_id === "string" ? t.team_id : null;
        const states = (t.states ?? t.stages) as unknown;
        if (Array.isArray(states)) for (const s of states) push(s as Record<string, unknown>, teamId);
      }
    }
    const stages = (body as Record<string, unknown>).stages ?? (body as Record<string, unknown>).states;
    if (Array.isArray(stages)) for (const s of stages) push(s as Record<string, unknown>, null);
  }
  return out;
}

/** The first state of `type` on `teamId`, in the order the route lists them. */
export function firstStateOfType(states: WorkflowState[], teamId: string, type: string): WorkflowState {
  const hit = states.find((s) => s.teamId === teamId && s.type.toLowerCase() === type.toLowerCase());
  if (!hit) {
    const seen = [...new Set(states.filter((s) => s.teamId === teamId).map((s) => s.type))].join(", ") || "none";
    throw new CliError(`team ${teamId} has no state of type "${type}" (types seen: ${seen})`, "state-type-unknown");
  }
  return hit;
}

// The shape the mirror refuses in `labelIds` (CTC-5566): Linear label ids are UUIDs.
const LABEL_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CTC-5871 — `--label`/`--add`/`--remove` values split for the route: a UUID goes in labelIds and every
 *  other value, a contract-known name included, goes in labelNames for the mirror to resolve. A Catalyst
 *  label the contract lists as absent from the workspace still refuses before any write. */
export function labelFields(team: ContractTeam, values: string[]): { labelIds?: string[]; labelNames?: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  for (const value of values) {
    if (LABEL_ID_SHAPE.test(value)) {
      ids.push(value);
      continue;
    }
    labelId(team, value); // throws label-absent for a Catalyst label this workspace lacks
    names.push(value);
  }
  return { ...(ids.length ? { labelIds: ids } : {}), ...(names.length ? { labelNames: names } : {}) };
}

/** Post to a contract route by name; a budget refusal names the contract's daily budget. A 2xx whose body
 *  says the write failed (issue-label answers a batch of failed items with 200) is a failure too. */
export async function postAgent<T = { id?: string }>(api: ApiClient, doc: TenantContract, routeName: string, body: unknown): Promise<T> {
  try {
    const res = await api.postJson<T>(routePath(doc, routeName), body);
    const outcome = res.body && typeof res.body === "object" ? (res.body as { outcome?: unknown }).outcome : undefined;
    if (outcome === "failed" || outcome === "rejected" || outcome === "exhausted") {
      const reason = (res.body as { reason?: unknown }).reason;
      throw new CliError(
        `POST ${routePath(doc, routeName)} answered ${res.status} with outcome "${outcome}"${typeof reason === "string" && reason ? `: ${reason}` : ""}`,
        "write-failed",
        2,
        res.status,
      );
    }
    return res.body;
  } catch (err) {
    if (err instanceof CliError && err.code === "budget") {
      throw new CliError(
        `${err.message} — the contract's thresholds.hostDailyWriteBudget is ${doc.thresholds.hostDailyWriteBudget} writes per host per day`,
        "budget",
        2,
        429,
      );
    }
    throw err;
  }
}

export async function cmdWrite(args: ParsedArgs, ctx: Ctx, deps: WriteDeps = {}): Promise<number> {
  try {
    return await runWrite(args, ctx, deps);
  } catch (err) {
    // CTC-5871 — a script reading --json stdout learns the write failed; the dispatcher still prints
    // the reason on stderr and returns the error's exit code.
    if (args.json && (err instanceof CliError || err instanceof MeError)) {
      ctx.stdout(
        JSON.stringify({
          ok: false,
          command: `write ${positionals(args)[0] ?? ""}`.trim(),
          error: { code: err instanceof CliError ? err.code : err.kind, message: err.message, ...(err.status !== undefined ? { status: err.status } : {}) },
        }),
      );
    }
    throw err;
  }
}

async function runWrite(args: ParsedArgs, ctx: Ctx, deps: WriteDeps): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub) throw new UsageError("write needs a subcommand: comment | state | label | create | reaction | attachment | session");
  const cfg = requireConfig(ctx);
  const { doc } = await loadContract(ctx, cfg);
  const api = apiClient(cfg, ctx);
  const asUser = flagBool(args, "as-user");
  let result: unknown;
  switch (sub) {
    case "comment": {
      const ticket = needTicket(rest, "comment <ticket>");
      let body = flagString(args, "body");
      if (flagBool(args, "stdin")) body = (await (deps.readStdin ?? readStdin)()).trimEnd();
      if (!body) throw new UsageError("write comment needs --body <text> or --stdin");
      if (flagBool(args, "bookkeeping")) body = `${bookkeepingPrefix(doc)} ${body}`;
      const issue = await resolveIssue(api, ticket);
      result = await postAgent(api, doc, "issue-comment", {
        issueId: issue.id,
        body,
        ...(flagString(args, "parent") ? { parentId: flagString(args, "parent") } : {}),
        ...(asUser ? { createAsUser: true } : {}),
      });
      break;
    }
    case "state": {
      const ticket = needTicket(rest, "state <ticket>");
      const issue = await resolveIssue(api, ticket);
      const slot = flagString(args, "slot");
      const stateId = flagString(args, "state-id");
      const stateType = flagString(args, "state-type");
      let target: string;
      if (stateId) target = stateId;
      else if (slot) target = stageIdForSlot(teamForTicket(doc, issue.identifier), slot);
      else if (stateType) {
        const team = teamForTicket(doc, issue.identifier);
        target = firstStateOfType(await fetchWorkflowStates(api), issue.teamId ?? team.id, stateType).id;
      } else throw new UsageError("write state needs --slot <slot>, --state-id <id> or --state-type <type>");
      result = await postAgent(api, doc, "issue-state", { issueId: issue.id, stateId: target });
      break;
    }
    case "label": {
      const ticket = needTicket(rest, "label <ticket>");
      const add = flagList(args, "add");
      const remove = flagList(args, "remove");
      if (add.length === 0 && remove.length === 0) throw new UsageError("write label needs --add <name|id> and/or --remove <name|id>");
      const issue = await resolveIssue(api, ticket);
      const team = teamForTicket(doc, issue.identifier);
      const results: unknown[] = [];
      if (add.length) results.push(await postAgent(api, doc, "issue-label", { issueId: issue.id, ...labelFields(team, add), mode: "add" }));
      if (remove.length) results.push(await postAgent(api, doc, "issue-label", { issueId: issue.id, ...labelFields(team, remove), mode: "remove" }));
      result = results.length === 1 ? results[0] : results;
      break;
    }
    case "create": {
      const teamKey = flagString(args, "team");
      const title = flagString(args, "title");
      if (!teamKey || !title) throw new UsageError("write create needs --team <key> and --title <text>");
      let description = flagString(args, "description");
      if (flagBool(args, "stdin")) {
        if (description !== undefined) throw new UsageError("write create takes --description <text> or --stdin, not both");
        description = (await (deps.readStdin ?? readStdin)()).trimEnd();
        if (!description) throw new UsageError("write create --stdin read an empty description");
      }
      const team = teamByKey(doc, teamKey);
      const labels = labelFields(team, flagList(args, "label"));
      const priority = flagString(args, "priority") !== undefined ? flagInt(args, "priority", 0) : undefined;
      result = await postAgent(api, doc, "issue-create", {
        teamId: team.id,
        title,
        ...(description ? { description } : {}),
        ...labels,
        ...(priority !== undefined ? { priority } : {}),
        ...(asUser ? { createAsUser: true } : {}),
      });
      break;
    }
    case "reaction": {
      const emoji = flagString(args, "emoji");
      if (!emoji) throw new UsageError("write reaction needs --emoji <e>");
      const commentId = flagString(args, "comment");
      const body: Record<string, unknown> = { emoji, ...(asUser ? { createAsUser: true } : {}) };
      if (commentId) body.commentId = commentId;
      else body.issueId = (await resolveIssue(api, needTicket(rest, "reaction <ticket>|--comment <id>"))).id;
      result = await postAgent(api, doc, "reaction", body);
      break;
    }
    case "attachment": {
      const ticket = needTicket(rest, "attachment <ticket>");
      const title = flagString(args, "title");
      const url = flagString(args, "url");
      if (!title || !url) throw new UsageError("write attachment needs --title <t> and --url <u>");
      const issue = await resolveIssue(api, ticket);
      result = await postAgent(api, doc, "attachment", { issueId: issue.id, title, url, metadata: {} });
      break;
    }
    case "session": {
      const ticket = needTicket(rest, "session <ticket>");
      const issue = await resolveIssue(api, ticket);
      const planFile = flagString(args, "plan-file");
      const plan = planFile ? (JSON.parse(readFileSync(planFile, "utf8")) as unknown) : undefined;
      result = await postAgent(api, doc, "session", {
        issueId: issue.id,
        ...(flagString(args, "title") ? { title: flagString(args, "title") } : {}),
        ...(plan !== undefined ? { plan } : {}),
        ...(flagString(args, "activity") ? { activity: flagString(args, "activity") } : {}),
        ...(flagString(args, "url") ? { url: flagString(args, "url") } : {}),
      });
      break;
    }
    case "delegate":
      throw new UsageError("write delegate is not offered: delegation is an operator action, not a tenant write");
    default:
      throw new UsageError(`unknown write subcommand: ${sub}`);
  }
  ctx.stdout(args.json ? JSON.stringify(result ?? {}) : describeWrite(sub, result));
  return 0;
}

function needTicket(rest: string[], usage: string): string {
  const t = rest[0];
  if (!t) throw new UsageError(`write ${usage}`);
  return t;
}

function describeWrite(sub: string, result: unknown): string {
  const id = result && typeof result === "object" ? (result as { id?: unknown; commentId?: unknown; issueId?: unknown }).id ?? (result as { commentId?: unknown }).commentId ?? (result as { issueId?: unknown }).issueId : undefined;
  return `${sub}: ok${id ? ` (${String(id)})` : ""}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export type { CustomerConfig };
