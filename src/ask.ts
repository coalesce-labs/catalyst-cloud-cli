// ask.ts — `ask raise|accept|answer|proxy|disown|list`: raise a decision through the contract's ask
// route (the cloud renders the body from its own template, so this passes fields, never headings),
// record an answer through ask-accept, record an owner's chat answer by proxy (CTC-6279) and let the
// owner switch that on, off or take one back, and list open asks ranked by the work each one holds.
import { flagBool, flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract, teamByKey } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient, type ApiClient } from "./transport.js";
import { fetchAllPages } from "./pagination.js";
import { fetchWorkflowStates, postAgent, resolveIssue } from "./write.js";

export async function cmdAsk(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub) throw new UsageError("ask needs a subcommand: raise | accept | answer | proxy | disown | list");
  if (sub === "raise" && !flagBool(args, "nothing-to-block") && flagList(args, "blocks").length === 0) {
    throw new UsageError("ask raise needs --blocks <ticket>... (what this decision holds) or --nothing-to-block");
  }
  // Everything these three would refuse is refused before the config is read or anything is sent.
  const proxyBody = sub === "answer" ? proxyAnswerBody(args, rest, ctx.now().getTime()) : undefined;
  const proxyAction = sub === "proxy" ? proxySettingAction(rest) : undefined;
  if (sub === "disown" && (!rest[0] || rest.length > 1)) throw new UsageError("ask disown needs exactly one <ask>");
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  // The two personal settings routes are not contract routes: they act as the logged-in person.
  if (proxyAction) return proxySetting(args, ctx, api, proxyAction);
  if (sub === "disown") return disown(args, ctx, api, rest[0]!);
  const { doc } = await loadContract(ctx, cfg);
  switch (sub) {
    case "raise":
      return raise(args, ctx, doc, api);
    case "accept":
      return accept(args, ctx, doc, api, rest);
    case "answer":
      return answerByProxy(args, ctx, doc, api, proxyBody!);
    case "list":
      return list(args, ctx, doc, api, cfg);
    default:
      throw new UsageError(`unknown ask subcommand: ${sub}`);
  }
}

async function raise(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient): Promise<number> {
  const teamKey = flagString(args, "team");
  const title = flagString(args, "title");
  if (!teamKey || !title) throw new UsageError("ask raise needs --team <key> and --title <question>");
  const team = teamByKey(doc, teamKey);
  const options = flagList(args, "option");
  if (options.length > doc.askTemplate.maxLetteredOptions) {
    throw new UsageError(`ask raise takes at most ${doc.askTemplate.maxLetteredOptions} options`);
  }
  const gates = askGates(args, options, doc);
  const blocks: string[] = [];
  for (const t of flagList(args, "blocks")) blocks.push((await resolveIssue(api, t)).id);
  const body: Record<string, unknown> = { title, teamId: team.id };
  if (flagString(args, "context")) body.context = flagString(args, "context");
  if (options.length) body.options = options;
  if (flagString(args, "default")) body.defaultIfSilent = flagString(args, "default");
  if (blocks.length) body.blocks = blocks;
  if (flagBool(args, "nothing-to-block")) body.nothingToBlock = true;
  if (flagString(args, "ask-key")) body.askKey = flagString(args, "ask-key");
  if (gates) body.gates = gates;
  const result = await postAgent<Record<string, unknown>>(api, doc, "ask", body);
  ctx.stdout(args.json ? JSON.stringify(result) : `ask raised: ${String(result.identifier ?? result.id ?? "ok")}${blocks.length ? ` (blocks ${blocks.length})` : ""}`);
  return 0;
}

/** The hold labels an answered ask may lift; the cloud's ask route refuses any other with a 400. */
const GATE_LABELS = ["hold", "hold:preview"] as const;
const OWNER_NAME = /^[^/\s]+\/[^/\s]+$/;

export interface AskGates {
  repo: string;
  pr: number | number[];
  labels: (typeof GATE_LABELS)[number][];
  releasedBy: string[];
}

/** CTC-5044 — the PR hold an answer releases. Absent unless --gates-pr is given, so an ask without it
 *  posts exactly the body it always did. Everything the route would refuse (a label outside
 *  {@link GATE_LABELS}, a letter that is not one of this ask's options) is refused here first, before
 *  any ticket is resolved or anything is posted. Options are lettered A, B, C in the order given. */
function askGates(args: ParsedArgs, options: string[], doc: TenantContract): AskGates | undefined {
  const prs = flagList(args, "gates-pr");
  if (prs.length === 0) {
    for (const f of ["released-by", "gates-label", "gates-repo"]) {
      if (flagList(args, f).length || flagString(args, f)) throw new UsageError(`ask raise takes --${f} only with --gates-pr <n>`);
    }
    return undefined;
  }
  const pr = [...new Set(prs.map((n) => {
    if (!/^[1-9]\d*$/.test(n)) throw new UsageError(`--gates-pr must be a PR number (got "${n}")`);
    return Number(n);
  }))];
  const labels = [...new Set(flagList(args, "gates-label"))];
  for (const l of labels) {
    if (!(GATE_LABELS as readonly string[]).includes(l)) throw new UsageError(`--gates-label ${l} is not a hold an answer can release; use one of: ${GATE_LABELS.join(", ")}`);
  }
  const released = [...new Set(flagList(args, "released-by").map((l) => l.trim().toUpperCase()))];
  if (released.length === 0) throw new UsageError("--gates-pr needs --released-by <letter>: the option whose answer releases the hold");
  const letters = options.map((_, i) => String.fromCharCode(65 + i));
  for (const l of released) {
    if (!letters.includes(l)) throw new UsageError(`--released-by ${l} is not one of this ask's options (${letters.length ? letters.join(", ") : "it has none; add --option"})`);
  }
  const registered = doc.merge.repositories.map((r) => `${r.owner}/${r.name}`);
  const named = flagString(args, "gates-repo");
  let repo: string;
  if (named !== undefined) {
    if (!OWNER_NAME.test(named)) throw new UsageError(`--gates-repo must be owner/name (got "${named}")`);
    const match = registered.find((r) => r.toLowerCase() === named.toLowerCase());
    if (registered.length && !match) throw new UsageError(`--gates-repo ${named} is not a repository this account registers (${registered.join(", ")})`);
    repo = match ?? named;
  } else if (registered.length === 1) {
    repo = registered[0]!;
  } else {
    throw new UsageError(`--gates-pr needs --gates-repo <owner/name>: this account registers ${registered.length ? registered.join(", ") : "no repository"}`);
  }
  return { repo, pr: pr.length === 1 ? pr[0]! : pr, labels: labels.length ? (labels as AskGates["labels"]) : ["hold"], releasedBy: released };
}

async function accept(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient, rest: string[]): Promise<number> {
  const askTicket = rest[0];
  const answer = flagString(args, "answer");
  const role = flagString(args, "role");
  if (!askTicket || !answer || !role) throw new UsageError("ask accept needs <askTicket> --answer <commentId> --role <role>");
  const ask = await resolveIssue(api, askTicket);
  const result = await postAgent<Record<string, unknown>>(api, doc, "ask-accept", {
    askIssueId: ask.id,
    answerCommentId: answer,
    acceptedByRole: role,
  });
  ctx.stdout(args.json ? JSON.stringify(result) : `ask ${ask.identifier}: answer ${answer} recorded by ${role}`);
  return 0;
}

/** The cloud's bounds on an answer by proxy, checked here first so a refusal never costs a write. */
const QUOTE_MAX = 4000;
const SAID_IN_MAX = 200;
const ROLE_MAX = 64;
const FUTURE_SKEW_MS = 5 * 60_000;
const SINGLE_LINE = /^[^\r\n]+$/;

export interface ProxyAnswerBody {
  askIssueId: string;
  ownerQuote: string;
  optionIndex?: number;
  saidIn: string;
  saidAtMs: number;
  acceptedByRole?: string;
}

/** CTC-6279 — `ask answer <ask> --proxy ...` → the ask-answer-proxy body. `--proxy` is required so the
 *  command can never be mistaken for the owner answering: an answer the owner posted on the ask is
 *  recorded with `ask accept`. The option letter maps A=0; no `--option` is a free-text answer, recorded
 *  as written. The quote is sent exactly as given, never trimmed. */
export function proxyAnswerBody(args: ParsedArgs, rest: string[], nowMs: number): ProxyAnswerBody {
  const usage = 'ask answer <ask> --proxy --quote "<owner\'s exact words>" [--option <letter>] --said-in <session or channel id> [--said-at <ISO-8601 time>] [--role <role>]';
  if (!flagBool(args, "proxy")) {
    throw new UsageError(`ask answer records only an answer the ask's owner gave you in chat, and needs --proxy: ${usage}. For an answer the owner posted on the ask themselves, use: catalyst ask accept <ask> --answer <commentId> --role <role>`);
  }
  const ask = rest[0];
  if (!ask || rest.length > 1) throw new UsageError(`ask answer needs exactly one <ask>: ${usage}`);
  const quote = flagString(args, "quote");
  if (quote === undefined || quote.trim() === "") throw new UsageError("ask answer --proxy needs --quote with the owner's exact words");
  if (quote.length > QUOTE_MAX) throw new UsageError(`--quote is ${quote.length} characters; the most an answer can carry is ${QUOTE_MAX}`);
  const saidIn = flagString(args, "said-in");
  if (saidIn === undefined || saidIn.trim() === "") throw new UsageError("ask answer --proxy needs --said-in <session or channel id>: where the owner said it");
  if (!SINGLE_LINE.test(saidIn) || saidIn.length > SAID_IN_MAX) throw new UsageError(`--said-in must be one line of at most ${SAID_IN_MAX} characters`);
  const role = flagString(args, "role");
  if (role !== undefined && (!SINGLE_LINE.test(role) || role.length > ROLE_MAX)) throw new UsageError(`--role must be one line of at most ${ROLE_MAX} characters`);
  const saidAtRaw = flagString(args, "said-at");
  let saidAtMs = nowMs;
  if (saidAtRaw !== undefined) {
    saidAtMs = Date.parse(saidAtRaw);
    if (!Number.isFinite(saidAtMs)) throw new UsageError(`--said-at must be an ISO-8601 time, such as 2026-10-20T14:05:00Z (got "${saidAtRaw}")`);
    if (saidAtMs > nowMs + FUTURE_SKEW_MS) throw new UsageError(`--said-at ${saidAtRaw} is in the future; give the time the owner said it`);
  }
  const options = flagList(args, "option");
  if (options.length > 1) throw new UsageError("ask answer takes one --option: the letter the owner chose");
  let optionIndex: number | undefined;
  if (options.length === 1) {
    const letter = options[0]!.trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) throw new UsageError(`--option must be one letter from A to Z (got "${options[0]}"); leave it out for a free-text answer`);
    optionIndex = letter.charCodeAt(0) - 65;
  }
  return {
    askIssueId: ask,
    ownerQuote: quote,
    ...(optionIndex !== undefined ? { optionIndex } : {}),
    saidIn,
    saidAtMs,
    ...(role !== undefined ? { acceptedByRole: role } : {}),
  };
}

const letterOf = (index: number): string => String.fromCharCode(65 + index);

/** One plain sentence per refusal reason the ask-answer-proxy route answers. */
function proxyRefusal(ask: string, reason: string, body: ProxyAnswerBody, optionCount: unknown): string {
  switch (reason) {
    case "not-an-ask":
      return `${ask} is not an ask, so there is no answer to record.`;
    case "issue-not-mirrored":
      return `Catalyst cannot see ${ask} yet. Check the identifier, or try again in a minute.`;
    case "already-resolved":
      return `${ask} already has an answer. Nothing was recorded.`;
    case "proxy-answer-already-recorded":
      return `An answer by proxy is already recorded on ${ask}. Nothing was recorded.`;
    case "readiness-needs-tap":
      return `${ask} must be answered by its owner in the app. An answer by proxy cannot settle it.`;
    case "ask-has-no-team":
      return `${ask} is not in a project Catalyst works, so it cannot be answered by proxy.`;
    case "ask-has-no-owner":
      return `${ask} has no owner, so nobody's chat answer can be recorded on it.`;
    case "proxy-caller-not-owner":
      return `${ask} belongs to someone else. Only an agent logged in as the ask's owner can record their answer.`;
    case "proxy-answering-off":
      return `${ask}'s owner has not turned on answers by proxy, so nothing was recorded. Only the owner can turn it on, by running: catalyst ask proxy on`;
    case "option-out-of-range": {
      const chosen = body.optionIndex !== undefined ? letterOf(body.optionIndex) : "that option";
      if (optionCount === 0) return `${ask} has no lettered options. Leave out --option to record the answer as written.`;
      if (typeof optionCount === "number" && optionCount > 0) return `${ask} has options A to ${letterOf(optionCount - 1)}; ${chosen} is not one of them.`;
      return `${ask} has no option ${chosen}.`;
    }
    case "already-in-flight":
      return `Another answer to ${ask} is being recorded right now. Check it again in a moment.`;
    default:
      return `${ask}: the answer was refused (${reason || "no reason given"}).`;
  }
}

async function answerByProxy(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient, body: ProxyAnswerBody): Promise<number> {
  const result = await postAgent<Record<string, unknown>>(api, doc, "ask-answer-proxy", body, { accept: [409, 502] });
  const outcome = result.outcome;
  if (args.json) ctx.stdout(JSON.stringify(result));
  const ask = typeof result.askIdentifier === "string" ? result.askIdentifier : body.askIssueId;
  if (outcome === "recorded") {
    if (!args.json) {
      const how = body.optionIndex !== undefined ? `${letterOf(body.optionIndex)} by proxy` : "by proxy, in the owner's words";
      ctx.stdout(`${ask} answered ${how}: "${body.ownerQuote}"`);
      const failed = Array.isArray(result.failedBlockedComments) ? result.failedBlockedComments.length : typeof result.failedBlockedComments === "number" ? result.failedBlockedComments : 0;
      if (failed > 0) ctx.stdout(`${failed} held ticket${failed === 1 ? "" : "s"} did not get the note naming this answer; the answer itself is recorded.`);
      ctx.stdout(`The owner can take it back with: catalyst ask disown ${ask}`);
    }
    return 0;
  }
  if (outcome === "refused") {
    if (!args.json) ctx.stdout(proxyRefusal(ask, typeof result.reason === "string" ? result.reason : "", body, result.optionCount));
    return 1;
  }
  if (outcome === "record-failed") {
    if (!args.json) ctx.stdout(`The answer to ${ask} was not recorded${typeof result.reason === "string" && result.reason ? ` (${result.reason})` : ""}. Nothing changed; run the same command again.`);
    return 2;
  }
  throw new CliError(`ask-answer-proxy answered an outcome this CLI does not know: ${JSON.stringify(outcome)}`, "shape");
}

const PROXY_SETTING_PATH = "/api/v1/me/ask-proxy-answering";
const ASK_DISOWN_PATH = "/api/v1/me/ask-disown";
type ProxyAction = "status" | "on" | "off";

function proxySettingAction(rest: string[]): ProxyAction {
  const action = rest[0] ?? "status";
  if (rest.length > 1 || !["status", "on", "off"].includes(action)) throw new UsageError("ask proxy takes: status | on | off");
  return action as ProxyAction;
}

/** The two refusals both personal routes share, in plain words: an account key (403) throws, an
 *  unmatched Linear identity (409) prints and exits 1. Returns undefined when the status was neither;
 *  --json has already printed the body, so it prints nothing more. */
function personalRefusal(args: ParsedArgs, ctx: Ctx, status: number, body: unknown, what: string): number | undefined {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (status === 403 && error === "personal_credential_required") {
    throw new CliError(`${what} needs your own login, not the workspace's shared key. Run catalyst login as yourself, then try again.`, "member-required", 2, 403);
  }
  if (status === 409 && error === "no_linear_identity") {
    if (!args.json) ctx.stdout("Your Linear identity is not matched yet, so Catalyst cannot tell which asks are yours. Match it with: catalyst identity linear options, then catalyst identity linear set <linearUserId>");
    return 1;
  }
  if (status === 403 || (status === 409 && error !== undefined)) {
    throw new CliError(`${what} was refused (${status}${typeof error === "string" ? `: ${error}` : ""})`, status === 403 ? "forbidden" : "http", 2, status);
  }
  return undefined;
}

function proxySettingLine(enabled: boolean, changed: boolean): string {
  return enabled
    ? `${changed ? "Turned on: " : "On: "}agents may record an answer you give them in chat on your asks. Turn it off with: catalyst ask proxy off`
    : `${changed ? "Turned off: " : "Off: "}agents may not record an answer you give them in chat; answer on the ask itself. Turn it on with: catalyst ask proxy on`;
}

async function proxySetting(args: ParsedArgs, ctx: Ctx, api: ApiClient, action: ProxyAction): Promise<number> {
  const res =
    action === "status"
      ? await api.getJson<{ enabled?: unknown }>(PROXY_SETTING_PATH, { accept: [403, 409], parseAccepted: true })
      : await api.putJson<{ enabled?: unknown }>(PROXY_SETTING_PATH, { enabled: action === "on" }, { accept: [403, 409] });
  if (args.json && res.status !== 403) ctx.stdout(JSON.stringify(res.body ?? {}));
  const refused = personalRefusal(args, ctx, res.status, res.body, "ask proxy");
  if (refused !== undefined) return refused;
  if (typeof res.body?.enabled !== "boolean") throw new CliError(`${PROXY_SETTING_PATH} answered without an enabled flag`, "shape");
  if (!args.json) ctx.stdout(proxySettingLine(res.body.enabled, action !== "status"));
  return 0;
}

/** One plain sentence per refusal reason the ask-disown route answers. */
function disownRefusal(ask: string, reason: string): string {
  switch (reason) {
    case "not-owner":
      return `${ask} is not your ask, so you cannot take back its answer.`;
    case "not-proxy-answered":
      return `${ask} was not answered by proxy, so there is nothing to take back.`;
    case "already-disowned":
      return `You already took back the answer on ${ask}.`;
    case "already-in-flight":
      return `A change to ${ask} is being recorded right now. Check it again in a moment.`;
    default:
      return `${ask}: taking back the answer was refused (${reason || "no reason given"}).`;
  }
}

async function disown(args: ParsedArgs, ctx: Ctx, api: ApiClient, askTicket: string): Promise<number> {
  const ask = await resolveIssue(api, askTicket);
  const res = await api.postJson<Record<string, unknown>>(ASK_DISOWN_PATH, { issueId: ask.id }, { accept: [403, 409, 502] });
  const body = res.body ?? {};
  if (args.json && res.status !== 403) ctx.stdout(JSON.stringify(body));
  const refused = personalRefusal(args, ctx, res.status, body, "ask disown");
  if (refused !== undefined) return refused;
  const name = typeof body.askIdentifier === "string" ? body.askIdentifier : ask.identifier;
  switch (body.outcome) {
    case "disowned": {
      if (args.json) return 0;
      ctx.stdout(`${name} is open again: the answer recorded by proxy is taken back.`);
      const tickets = Array.isArray(body.tickets) ? (body.tickets as { ticket?: unknown; phase?: unknown; status?: unknown }[]) : [];
      for (const t of tickets) ctx.stdout(`  ${String(t.ticket ?? "?")}: ${String(t.phase ?? "?")} ${String(t.status ?? "")}`.trimEnd());
      return 0;
    }
    case "refused":
      if (!args.json) ctx.stdout(disownRefusal(name, typeof body.reason === "string" ? body.reason : ""));
      return 1;
    case "disown-failed":
      if (!args.json) ctx.stdout(`The answer on ${name} was not taken back${typeof body.reason === "string" && body.reason ? ` (${body.reason})` : ""}. Nothing changed; run the same command again.`);
      return 2;
    default:
      throw new CliError(`${ASK_DISOWN_PATH} answered an outcome this CLI does not know: ${JSON.stringify(body.outcome)}`, "shape");
  }
}

export interface RankedAsk {
  identifier: string;
  title: string;
  state: string;
  blocks: string[];
  score: number;
  /** The Linear user id the ask is assigned to, when the row carries one. */
  assigneeId: string | null;
}

/** The three answers to "whose asks?" — the CLI names which one it gave, so an empty list is never
 *  mistaken for "nothing needs anyone". */
export type InboxScope =
  | { kind: "mine"; linearUserId: string; label: string }
  | { kind: "anyone" }
  | { kind: "unmatched"; label: string }
  | { kind: "no-person" };

/** Decide the inbox scope from the connected identity and the `--anyone` flag. A personal key with a
 *  matched Linear identity reads "mine" by default; `--anyone` widens; an unmatched identity or a
 *  host key cannot mean "me" and says so rather than filtering to nothing. */
export function inboxScope(cfg: { user?: { label: string; linearUserId: string | null } }, anyone: boolean): InboxScope {
  if (anyone) return { kind: "anyone" };
  if (!cfg.user) return { kind: "no-person" };
  if (!cfg.user.linearUserId) return { kind: "unmatched", label: cfg.user.label };
  return { kind: "mine", linearUserId: cfg.user.linearUserId, label: cfg.user.label };
}

/** Rank open asks the way the cloud's own Waiting-on-me feed does: the most open tickets blocked
 *  first, then the oldest ask first, then the identifier. `score` is the count of open tickets the
 *  ask blocks. Priority is not a weight here, and age only breaks a tie. */
export function rankAsks(issues: Record<string, unknown>[], doc: TenantContract, openState: (issue: Record<string, unknown>) => boolean): RankedAsk[] {
  const askIds = new Set<string>();
  for (const team of doc.teams) for (const l of team.labels.ask) for (const id of [l.unscopedId, l.teamScopedId, l.preferredId]) if (id) askIds.add(id);
  const isAsk = (issue: Record<string, unknown>): boolean => {
    const labels = Array.isArray(issue.labels) ? (issue.labels as { id?: unknown; name?: unknown }[]) : [];
    return labels.some((l) => (typeof l.id === "string" && askIds.has(l.id)) || (typeof l.name === "string" && (l.name === doc.vocabulary.askMarkerLabel || l.name.startsWith(doc.vocabulary.askLabelPrefix))));
  };
  const byIdentifier = new Map<string, Record<string, unknown>>();
  for (const i of issues) if (typeof i.identifier === "string") byIdentifier.set(i.identifier, i);
  // The cloud's age key: created, else updated; an ask with neither sorts after every dated one.
  const ageKey = (issue: Record<string, unknown>): number => {
    for (const k of ["created_at", "updated_at"]) {
      const v = issue[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && Number.isFinite(Date.parse(v))) return Date.parse(v);
    }
    return Number.POSITIVE_INFINITY;
  };
  const ranked: { ask: RankedAsk; age: number }[] = [];
  for (const issue of issues) {
    if (!isAsk(issue) || !openState(issue)) continue;
    const relations = Array.isArray(issue.relations) ? (issue.relations as { type?: unknown; issue_identifier?: unknown; related_identifier?: unknown }[]) : [];
    const blocked = relations
      .filter((r) => r.type === "blocks" && r.issue_identifier === issue.identifier && typeof r.related_identifier === "string")
      .map((r) => r.related_identifier as string)
      .filter((id) => {
        const t = byIdentifier.get(id);
        return !t || openState(t);
      });
    ranked.push({
      age: ageKey(issue),
      ask: {
        identifier: String(issue.identifier),
        title: String(issue.title ?? ""),
        state: String(issue.state ?? ""),
        blocks: blocked,
        score: blocked.length,
        assigneeId: typeof issue.assignee_id === "string" && issue.assignee_id !== "" ? issue.assignee_id : null,
      },
    });
  }
  ranked.sort((a, b) => b.ask.score - a.ask.score || (a.age === b.age ? 0 : a.age < b.age ? -1 : 1) || a.ask.identifier.localeCompare(b.ask.identifier));
  return ranked.map((r) => r.ask);
}

async function list(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient, cfg: CustomerConfig): Promise<number> {
  // ⛔ THE INBOX IS THE WHOLE SCOPE, NOT A PAGE. The mirror caps every page at 500 rows regardless of
  // the requested limit, so a single `limit: 500` read drops every ask past the cap — and, worse,
  // scores the asks it does show against a partial view of what they block (rankAsks below).
  const [inbox, states] = await Promise.all([fetchAllPages(api, "/api/v1/issues", {}), fetchWorkflowStates(api)]);
  const issues = inbox.rows;
  const terminal = new Set(states.filter((s) => ["completed", "canceled", "cancelled"].includes(s.type.toLowerCase())).map((s) => s.name.toLowerCase()));
  const openState = (issue: Record<string, unknown>) => !terminal.has(String(issue.state ?? "").toLowerCase());
  const all = rankAsks(issues, doc, openState);
  const scope = inboxScope(cfg, flagBool(args, "anyone"));
  const ranked = scope.kind === "mine" ? all.filter((a) => a.assigneeId === scope.linearUserId) : all;
  if (args.json) {
    ctx.stdout(JSON.stringify({ scope, asks: ranked }));
    return 0;
  }
  if (scope.kind === "unmatched") {
    ctx.stderr(`[catalyst] your Linear identity is not matched yet (match it with: catalyst identity linear options, then catalyst identity linear set <linearUserId>), so this is every open ask, not only yours`);
  } else if (scope.kind === "no-person") {
    ctx.stderr(`[catalyst] connected with your cloud account's shared key, which names no person — this is every open ask; log in with your personal key to see only yours`);
  }
  if (ranked.length === 0) {
    ctx.stdout(scope.kind === "mine" ? `no open asks assigned to ${scope.label} (${all.length} open in your cloud account — add --anyone to see them)` : "no open asks");
    return 0;
  }
  for (const a of ranked) ctx.stdout(`${a.identifier}  holds ${a.blocks.length} ticket${a.blocks.length === 1 ? "" : "s"}${a.blocks.length ? `: ${a.blocks.join(", ")}` : ""}  ${a.title}`);
  return 0;
}
