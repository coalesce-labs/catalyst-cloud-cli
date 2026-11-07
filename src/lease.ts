// lease.ts — `catalyst lease` and `catalyst work available` (CTC-6400): a seat or one-shot session
// holds the ticket it works through a ticket lease, never a label, and sees what work is free.
//
//   lease take <TICKET> --agent <name> [--ttl <minutes>] [holder details]
//                                                             POST /api/v1/agent/ticket-lease/take
//   lease renew <TICKET> --commit|--artifact|--finding|--pr <ref> [--note <text>] [holder details]
//                                                             POST /api/v1/agent/ticket-lease/renew
//   lease release <TICKET>                                    POST /api/v1/agent/ticket-lease/release
//   lease show <TICKET>                                       GET  /api/v1/agent/ticket-lease?ticket=
//   lease list --team K [--state live|recent] [--limit N] [--cursor C]
//                                                             GET  /api/v1/agent/ticket-leases?team=
//   work available [--team K]                                 GET  /api/v1/work-eligibility?team=
//
// ⛔ THE KEY IS THE CREDENTIAL. The cloud mints no lease credential (CTC-6398): it derives the holder
// `seat:<keyId>:<agent>` from the login on every call. What this machine keeps per lease is only what
// the next call must name: the seat name and the generation the take returned, in a 0600 file under
// the config directory. Renew and release read it, so a seat names the ticket and its progress.
//
// ⭐ A REFUSAL IS A 200. The store answers `outcome: "refused"` with a reason (`no_new_progress`,
// `ticket_lease_held`, `not_holder`, …); this module prints it and exits 1, so a script can stop on
// it. A malformed request (400), a seat that does not reach the ticket's team (403) and an exhausted
// budget (429) exit 1 the same way, with the server's reason. `--json` prints the route's body as it
// came, refusals included (CTC-8873).
//
// CTC-8873 — a take or renew may declare who holds the lease (src/lease-holder.ts). The details are
// checked here before anything is sent, and a write that carries them first checks that the cloud
// serves contract 2.65.0, because an older cloud drops them without a word.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { CONFIG_MODE, configDirFor, requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract, readContractCache } from "./contract.js";
import { UsageError } from "./errors.js";
import {
  HOLDER_DETAILS_CONTRACT,
  HOLDER_FLAGS,
  HolderDetailError,
  checkSessionHost,
  detailLines,
  detailsDiffer,
  holderLabel,
  ownerLabel,
  resolveHolderDetails,
  returnedDetails,
  sanitize,
  shellWord,
  writeLabel,
  type HolderDetailsInput,
} from "./lease-holder.js";
import { semverOlder } from "./semver.js";
import { apiClient, type ApiClient } from "./transport.js";

const ROUTE = "/api/v1/agent/ticket-lease";
const LIST_ROUTE = "/api/v1/agent/ticket-leases";
const TICKET = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;
const AGENT = /^[a-z0-9-]{1,40}$/;
const TEAM = /^[A-Z][A-Z0-9]{0,15}$/;
const ACCEPT = [400, 403, 404, 409, 429];
/** The flags only `lease list` reads, and the flags it refuses. */
const LIST_FLAGS = ["team", "state", "limit", "cursor"];
const NOT_LIST_FLAGS = ["agent", "ttl", "commit", "artifact", "finding", "pr", "note", "generation", ...HOLDER_FLAGS];

/** What this machine keeps for one lease: the seat and the generation the next call names, and the
 *  kind the cloud recorded for it (absent in a file a CLI before CTC-8873 wrote). */
interface StoredLease {
  ticket: string;
  agent: string;
  generation: number;
  holder: string | null;
  kind?: string;
}

interface LeaseRow extends Record<string, unknown> {
  holder: string | null;
  generation: number;
  deadlineMs: number;
  lastHolder?: string | null;
  lastProgress?: string | null;
  holderDetails?: unknown;
  lastHolderDetails?: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function leaseRow(value: unknown): value is LeaseRow {
  return object(value) && typeof value.generation === "number" && typeof value.deadlineMs === "number";
}

function leaseDir(ctx: Ctx): string {
  return join(configDirFor(ctx.home), "leases");
}
function leasePath(ctx: Ctx, ticket: string, agent: string): string {
  return join(leaseDir(ctx), `${ticket}--${agent}.json`);
}
function saveLease(ctx: Ctx, lease: StoredLease): void {
  mkdirSync(leaseDir(ctx), { recursive: true });
  const path = leasePath(ctx, lease.ticket, lease.agent);
  writeFileSync(path, JSON.stringify(lease) + "\n", { mode: CONFIG_MODE });
  chmodSync(path, CONFIG_MODE);
}
function forgetLease(ctx: Ctx, ticket: string, agent: string): void {
  rmSync(leasePath(ctx, ticket, agent), { force: true });
}
/** Refusals that mean this seat's lease is gone: it lapsed, or a later take replaced it. */
const GONE = new Set(["expired", "not_holder", "stale_generation"]);
/** Forget a stored lease the cloud says this seat no longer holds, so a later seat on the same
 * ticket is not asked to name one with --agent. The exit stays 1: the renew or release did not happen. */
function forgetIfGone(ctx: Ctx, ticket: string, agent: string, body: unknown): void {
  if (!object(body) || !object(body.refusal) || !GONE.has(String(body.refusal.reason))) return;
  forgetLease(ctx, ticket, agent);
  ctx.stderr(`[catalyst] ${agent} no longer holds ${ticket}; forgot its stored lease`);
}
/** The leases this machine holds on a ticket, one per seat that took it. */
function storedLeases(ctx: Ctx, ticket: string): StoredLease[] {
  let names: string[];
  try {
    names = readdirSync(leaseDir(ctx));
  } catch {
    return [];
  }
  const found: StoredLease[] = [];
  for (const name of names.filter((n) => n.startsWith(`${ticket}--`) && n.endsWith(".json"))) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(leaseDir(ctx), name), "utf8"));
      if (object(value) && value.ticket === ticket && text(value.agent) && typeof value.generation === "number")
        found.push({
          ticket, agent: value.agent, generation: value.generation, holder: text(value.holder) ? value.holder : null,
          ...(text(value.kind) ? { kind: value.kind } : {}),
        });
    } catch {
      // An unreadable file is not a lease this machine can name; --agent and --generation still can.
    }
  }
  return found;
}

function parseTicket(raw: string | undefined, verb: string): string {
  if (!raw || !TICKET.test(raw)) throw new UsageError(`lease ${verb} needs one ticket such as ENG-123`);
  return raw.toUpperCase();
}
function parseAgent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!AGENT.test(raw)) throw new UsageError("--agent is the seat's name: 1 to 40 of a-z, 0-9 and -");
  return raw;
}

/** The seat and generation a renew or release names: the flags, else the one lease this machine
 *  stored for the ticket. Two stored seats need --agent to choose. The request carries only these
 *  two; `kind` is what this machine stored for that seat and generation, for a renew's link check. */
function heldLease(args: ParsedArgs, ctx: Ctx, ticket: string): { request: { agent: string; generation: number }; kind: string | null } {
  const agent = parseAgent(flagString(args, "agent"));
  const rawGeneration = flagString(args, "generation");
  let generation: number | undefined;
  if (rawGeneration !== undefined) {
    generation = Number(rawGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new UsageError("--generation is the positive integer the take printed");
  }
  const stored = storedLeases(ctx, ticket).filter((s) => agent === undefined || s.agent === agent);
  const held = (request: { agent: string; generation: number }) => {
    const match = stored.find((s) => s.agent === request.agent && s.generation === request.generation);
    return { request, kind: match?.kind ?? null };
  };
  if (agent !== undefined && generation !== undefined) return held({ agent, generation });
  if (stored.length === 1) return held({ agent: stored[0]!.agent, generation: generation ?? stored[0]!.generation });
  if (stored.length > 1)
    throw new UsageError(`this machine holds ${ticket} for ${stored.map((s) => s.agent).join(", ")}; name one with --agent`);
  throw new UsageError(`this machine holds no lease on ${ticket}${agent ? ` for ${agent}` : ""}; take it first, or pass --agent and --generation`);
}

/** The one progress fact a renewal asserts, from exactly one of the four flags. */
function parseProgress(args: ParsedArgs): { kind: string; ref: string; note?: string } {
  const given = (["commit", "artifact", "finding", "pr"] as const)
    .map((kind) => ({ kind, ref: flagString(args, kind) }))
    .filter((p): p is { kind: "commit" | "artifact" | "finding" | "pr"; ref: string } => p.ref !== undefined);
  if (given.length !== 1)
    throw new UsageError("lease renew needs exactly one of --commit <sha>, --artifact <path or id>, --finding <id> or --pr <number>");
  const { kind } = given[0]!;
  const ref = given[0]!.ref.trim();
  if (kind === "commit" && !/^[0-9a-f]{40}$/.test(ref)) throw new UsageError("--commit is the full 40-character lowercase sha");
  if (kind === "pr" && !/^[1-9][0-9]{0,9}$/.test(ref)) throw new UsageError("--pr is the pull request's number");
  if ((kind === "artifact" || kind === "finding") && (ref === "" || /\s/.test(ref)))
    throw new UsageError(`--${kind} is one token with no spaces`);
  const note = flagString(args, "note");
  return { kind, ref, ...(note !== undefined && note.trim() !== "" ? { note } : {}) };
}

function parseTtlMs(args: ParsedArgs): { ttlMs?: number } {
  const raw = flagString(args, "ttl");
  if (raw === undefined) return {};
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new UsageError("--ttl is a number of minutes (the cloud keeps it between 5 and 60)");
  return { ttlMs: Math.round(minutes * 60_000) };
}

/** Each named flag given to an action that does not read it is a usage error. */
function refuseFlags(args: ParsedArgs, action: string, flags: readonly string[]): void {
  for (const flag of flags)
    if (args.flags[flag] !== undefined) throw new UsageError(`--${flag} is not an option of lease ${action}`);
}

/** A write that declares holder details needs a cloud that records them: one on contract 2.65.0
 *  or later. The contract read follows its own cache policy; a failed read throws, so no write. */
async function requireHolderContract(ctx: Ctx, cfg: CustomerConfig): Promise<void> {
  const loaded = await loadContract(ctx, cfg);
  const version = readContractCache(ctx.home)?.contractVersion ?? loaded.doc.contractVersion;
  if (semverOlder(version, HOLDER_DETAILS_CONTRACT))
    throw new HolderDetailError(`this cloud does not record holder details yet (needs contract ${HOLDER_DETAILS_CONTRACT})`);
}

function when(ms: number): string {
  return new Date(ms).toISOString();
}
function detail(body: unknown): string {
  if (!object(body)) return "";
  const parts = [body.reason, body.error, body.message].filter(text);
  return parts.length ? `: ${sanitize([...new Set(parts)].join(": "))}` : "";
}

/** Print a refusal or an HTTP failure and return the exit code 1. `--json` prints the body as it came. */
function refuse(args: ParsedArgs, ctx: Ctx, status: number, body: unknown, verb: string): number {
  if (args.json) {
    ctx.stdout(JSON.stringify(body ?? null));
    return 1;
  }
  if (status === 200 && object(body) && object(body.refusal)) {
    const r = body.refusal;
    const current = leaseRow(r.current) ? r.current : null;
    const parts = [`refused: ${text(r.reason) ? sanitize(r.reason) : "unknown"}`];
    if (current?.holder) parts.push(`held by ${writeLabel(current.holderDetails, current.holder)} until ${when(current.deadlineMs)}`);
    if (typeof r.retryAtMs === "number") parts.push(`retry at ${when(r.retryAtMs)}`);
    ctx.stdout(parts.join("; "));
    return 1;
  }
  const meaning =
    status === 404 ? `this Catalyst Cloud does not serve lease ${verb} yet (needs a newer cloud)`
    : status === 403 ? "your login does not reach this ticket's team"
    : status === 429 ? "your write budget is spent for now"
    : `lease ${verb} failed`;
  ctx.stdout(`refused (${status}): ${meaning}${detail(body)}`);
  return 1;
}

/** The lines a take or renew prints: the holder (today's seat label when the kind is unspecified),
 *  the deadline, the generation and the last progress. */
function printLease(ctx: Ctx, ticket: string, lease: LeaseRow): void {
  ctx.stdout(`${ticket}: held by ${writeLabel(lease.holderDetails, lease.holder)} until ${when(lease.deadlineMs)}, generation ${lease.generation}`);
  if (text(lease.lastProgress)) ctx.stdout(`  last progress: ${sanitize(lease.lastProgress)}`);
}

/** The holder a row names and the details paired with it: a free row names its last holder (else
 *  its holder), a live row its holder. Details always come from the same side as the name. */
function shownHolder(lease: LeaseRow): { seat: string | null; details: unknown } {
  if (lease.live === false && text(lease.lastHolder)) return { seat: lease.lastHolder, details: lease.lastHolderDetails };
  return { seat: lease.holder, details: lease.holderDetails };
}

/** The running stage that refuses a take while no ticket lease is live. A cloud that predates it
 *  sends none, and the read says what it always said. */
interface LiveStage {
  phase: string;
  kind: unknown;
  untilMs: number;
}
function liveStage(value: unknown): LiveStage | null {
  if (!object(value) || !text(value.phase) || typeof value.untilMs !== "number") return null;
  return { phase: sanitize(value.phase), kind: value.kind, untilMs: value.untilMs };
}
function stageLine(ticket: string, stage: LiveStage): string {
  return stage.kind === "reservation"
    ? `${ticket}: the ${stage.phase} phase is starting, reserved until ${when(stage.untilMs)}; a take is refused until then`
    : `${ticket}: the ${stage.phase} phase holds it until ${when(stage.untilMs)}; a take by anyone else is refused until then`;
}

/** `lease show`: the holder, then last progress, owner, session, external id, contact and, on a
 *  live row, the previous holder. */
function printShown(ctx: Ctx, ticket: string, lease: LeaseRow, stage: LiveStage | null): void {
  const shown = shownHolder(lease);
  const label = holderLabel(shown.details, shown.seat);
  if (lease.live === false && stage !== null) {
    ctx.stdout(stageLine(ticket, stage));
    ctx.stdout(`  last held by ${label}, generation ${lease.generation}`);
  } else if (lease.live === false) ctx.stdout(`${ticket}: free; last held by ${label}, generation ${lease.generation}`);
  else ctx.stdout(`${ticket}: held by ${label} until ${when(lease.deadlineMs)}, generation ${lease.generation}`);
  if (text(lease.lastProgress)) ctx.stdout(`  last progress: ${sanitize(lease.lastProgress)}`);
  for (const line of detailLines(shown.details)) ctx.stdout(line);
  if (lease.live !== false && (returnedDetails(lease.lastHolderDetails) !== null || text(lease.lastHolder)))
    ctx.stdout(`  previous holder: ${holderLabel(lease.lastHolderDetails, lease.lastHolder)}`);
}

/** One `lease list` row. */
function listLine(ticket: string, lease: LeaseRow): string {
  const shown = shownHolder(lease);
  const label = holderLabel(shown.details, shown.seat);
  if (lease.live === false) return `  ${ticket}: free; last held by ${label}, generation ${lease.generation}`;
  const owner = ownerLabel(returnedDetails(shown.details)?.owner);
  return `  ${ticket}: ${label}${owner === null ? "" : `, owner ${owner}`}, until ${when(lease.deadlineMs)}, generation ${lease.generation}`;
}

/** `lease list --team K`: one page of a team's leases, and the command for the next page. */
async function listLeases(args: ParsedArgs, ctx: Ctx, extra: readonly string[]): Promise<number> {
  if (extra.length) throw new UsageError("lease list takes no ticket; name the team with --team");
  refuseFlags(args, "list", NOT_LIST_FLAGS);
  const rawTeam = flagString(args, "team");
  if (rawTeam === undefined) throw new UsageError("lease list needs --team <key>, such as --team CTC");
  const team = rawTeam.toUpperCase();
  if (!TEAM.test(team)) throw new UsageError("--team is a team's key, such as CTC");
  const state = flagString(args, "state");
  if (state !== undefined && state !== "live" && state !== "recent") throw new UsageError("--state is live or recent");
  const limit = flagString(args, "limit");
  if (limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/.test(limit)) throw new UsageError("--limit is a whole number from 1 to 200");
  const cursor = flagString(args, "cursor");
  if (cursor !== undefined && cursor === "") throw new UsageError("--cursor is the token a previous page printed");
  const query: Record<string, string> = { team };
  if (state !== undefined) query.state = state;
  if (limit !== undefined) query.limit = limit;
  if (cursor !== undefined) query.cursor = cursor;

  const client = apiClient(requireConfig(ctx), ctx);
  const res = await client.getJson(LIST_ROUTE, { query, accept: ACCEPT, parseAccepted: true });
  if (res.status >= 400) return refuse(args, ctx, res.status, res.body, "list");
  if (args.json) {
    ctx.stdout(JSON.stringify(res.body ?? null));
    return 0;
  }
  const body = object(res.body) ? res.body : {};
  const rows = (Array.isArray(body.leases) ? body.leases : []).filter(
    (row): row is LeaseRow & { ticket: string } => leaseRow(row) && text(row.ticket),
  );
  const shownState = state ?? (body.state === "recent" ? "recent" : "live");
  ctx.stdout(`${team}: ${rows.length} ${shownState} ${rows.length === 1 ? "lease" : "leases"}`);
  for (const row of rows) ctx.stdout(listLine(sanitize(row.ticket), row));
  if (text(body.nextCursor)) {
    const next = ["catalyst lease list --team", team];
    if (state !== undefined) next.push("--state", state);
    if (limit !== undefined) next.push("--limit", limit);
    next.push("--cursor", shellWord(body.nextCursor));
    ctx.stdout(`  more: ${next.join(" ")}`);
  }
  return 0;
}

/** A renew's session link is checked against the kind the lease holds. This machine stored it on
 *  the take; when it did not (an older CLI took the lease, or another generation), the lease is read
 *  once, without sending the link, and its kind used when it is this seat's lease at this
 *  generation. With no kind to check against, the link is refused. */
async function checkRenewLink(
  client: ApiClient,
  ticket: string,
  held: ReturnType<typeof heldLease>,
  link: { host: string; label: string },
): Promise<void> {
  let kind = held.kind;
  if (kind === null) {
    const res = await client.getJson(ROUTE, { query: { ticket }, accept: ACCEPT, parseAccepted: true });
    const lease = res.status === 200 && object(res.body) && leaseRow(res.body.lease) ? res.body.lease : null;
    const details = lease === null ? null : returnedDetails(lease.holderDetails);
    if (
      lease !== null && details !== null && lease.live !== false && lease.generation === held.request.generation &&
      text(lease.holder) && lease.holder.endsWith(`:${held.request.agent}`)
    )
      kind = details.kind;
  }
  if (kind === null)
    throw new HolderDetailError(`${link.label} needs the current holder kind; take this lease with this CLI before setting its session link`);
  checkSessionHost(link.label, kind, link.host);
}

/** `lease`: a holder detail refused here prints its one line to stderr and exits 1, with no usage
 *  text, because the command was well formed and only a value was refused. */
export async function cmdLease(args: ParsedArgs, ctx: Ctx): Promise<number> {
  try {
    return await runLease(args, ctx);
  } catch (err) {
    if (!(err instanceof HolderDetailError)) throw err;
    ctx.stderr(err.message);
    return 1;
  }
}

async function runLease(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [action, rawTicket, ...extra] = positionals(args);
  if (action === "list") return listLeases(args, ctx, positionals(args).slice(1));
  if (action !== "take" && action !== "renew" && action !== "release" && action !== "show")
    throw new UsageError("lease needs take, renew, release, show or list");
  if (extra.length) throw new UsageError(`lease ${action} takes one ticket`);
  const ticket = parseTicket(rawTicket, action);
  refuseFlags(args, action, LIST_FLAGS);
  if (action === "show" || action === "release") refuseFlags(args, action, HOLDER_FLAGS);
  const cfg = requireConfig(ctx);
  const client = apiClient(cfg, ctx);

  if (action === "show") {
    const res = await client.getJson(ROUTE, { query: { ticket }, accept: ACCEPT, parseAccepted: true });
    if (res.status >= 400) return refuse(args, ctx, res.status, res.body, action);
    if (args.json) {
      ctx.stdout(JSON.stringify(res.body ?? null));
      return 0;
    }
    const lease = object(res.body) && leaseRow(res.body.lease) ? res.body.lease : null;
    const stage = object(res.body) ? liveStage(res.body.liveStage) : null;
    if (lease === null) ctx.stdout(stage === null ? `${ticket}: no ticket lease` : stageLine(ticket, stage));
    else printShown(ctx, ticket, lease, stage);
    return 0;
  }

  if (action === "take") {
    const agent = parseAgent(flagString(args, "agent"));
    if (agent === undefined) throw new UsageError("lease take needs --agent <seat name>");
    const ttl = parseTtlMs(args);
    const declared = resolveHolderDetails(args, ctx.env, "take");
    if (declared !== null) await requireHolderContract(ctx, cfg);
    const body = { ticket, agent, ...ttl, ...(declared === null ? {} : { holderDetails: declared.details }) };
    const res = await client.postJson(`${ROUTE}/take`, body, { accept: ACCEPT });
    if (res.status !== 200 || !object(res.body) || res.body.outcome !== "taken" || !leaseRow(res.body.lease))
      return refuse(args, ctx, res.status, res.body, action);
    const lease = res.body.lease;
    const kept = returnedDetails(lease.holderDetails);
    saveLease(ctx, { ticket, agent, generation: lease.generation, holder: lease.holder, ...(kept === null ? {} : { kind: kept.kind }) });
    if (declared !== null && res.body.minted === false && detailsDiffer(declared.details, lease.holderDetails))
      ctx.stderr(`${ticket}: this seat already holds the ticket; its recorded holder details were kept`);
    if (args.json) ctx.stdout(JSON.stringify(res.body));
    else printLease(ctx, ticket, lease);
    return 0;
  }

  if (action === "renew") {
    const progress = parseProgress(args);
    const held = heldLease(args, ctx, ticket);
    const ttl = parseTtlMs(args);
    const declared = resolveHolderDetails(args, ctx.env, "renew");
    // A link the stored kind refuses is refused here, before any request, the contract read included.
    if (declared?.link && held.kind !== null) checkSessionHost(declared.link.label, held.kind, declared.link.host);
    if (declared !== null) await requireHolderContract(ctx, cfg);
    const details: HolderDetailsInput | null = declared?.details ?? null;
    if (declared?.link) await checkRenewLink(client, ticket, held, declared.link);
    const body = { ticket, ...held.request, progress, ...ttl, ...(details === null ? {} : { holderDetails: details }) };
    const res = await client.postJson(`${ROUTE}/renew`, body, { accept: ACCEPT });
    if (res.status !== 200 || !object(res.body) || res.body.outcome !== "renewed" || !leaseRow(res.body.lease)) {
      forgetIfGone(ctx, ticket, held.request.agent, res.body);
      return refuse(args, ctx, res.status, res.body, action);
    }
    if (args.json) ctx.stdout(JSON.stringify(res.body));
    else printLease(ctx, ticket, res.body.lease);
    return 0;
  }

  const held = heldLease(args, ctx, ticket).request;
  const res = await client.postJson(`${ROUTE}/release`, { ticket, ...held }, { accept: ACCEPT });
  if (res.status !== 200 || !object(res.body) || res.body.outcome !== "released") {
    forgetIfGone(ctx, ticket, held.agent, res.body);
    return refuse(args, ctx, res.status, res.body, action);
  }
  forgetLease(ctx, ticket, held.agent);
  if (args.json) ctx.stdout(JSON.stringify(res.body));
  else ctx.stdout(`${ticket}: released by ${held.agent}`);
  return 0;
}

interface EligibilityRow extends Record<string, unknown> {
  ticket?: string;
  status?: string;
  holder?: string;
  lastHolder?: string;
  lastProgress?: string;
}
interface OpenPull extends Record<string, unknown> {
  number: number;
  title?: string | null;
  draft?: boolean;
  ticket?: string | null;
  owner?: string;
}

/** The free tickets in one team's rows: offered, or offered with no capable runner (a seat can still
 *  take it), with no live holder named on them. */
function freeTickets(rows: readonly EligibilityRow[]): EligibilityRow[] {
  return rows.filter((r) => text(r.ticket) && (r.status === "offered" || r.status === "capability_mismatch") && !text(r.holder));
}

/** `work available`: per team, the tickets nobody holds (with the last holder and progress when a
 *  lease lapsed) and the open pull requests no live lease covers, drafts included. */
export async function cmdWork(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [action, ...extra] = positionals(args);
  if (action !== "available" || extra.length) throw new UsageError("work needs available");
  const cfg = requireConfig(ctx);
  const client = apiClient(cfg, ctx);
  const named = flagString(args, "team");
  let teams: string[];
  if (named !== undefined) teams = [named.toUpperCase()];
  else {
    const { doc } = await loadContract(ctx, cfg);
    teams = doc.teams.map((t) => t.key).filter((k): k is string => typeof k === "string" && k !== "");
    if (teams.length === 0) throw new UsageError("work available needs --team: the workspace contract names no team");
  }
  const results: Record<string, { tickets: EligibilityRow[]; unownedPulls: OpenPull[] }> = {};
  for (const team of teams) {
    const res = await client.getJson<{ eligibility?: { rows?: EligibilityRow[] }; openPulls?: OpenPull[] | null }>(
      "/api/v1/work-eligibility", { query: { team } },
    );
    const rows = Array.isArray(res.body.eligibility?.rows) ? res.body.eligibility.rows : [];
    const pulls = Array.isArray(res.body.openPulls) ? res.body.openPulls : [];
    results[team] = {
      tickets: freeTickets(rows),
      unownedPulls: pulls.filter((p) => object(p) && typeof p.number === "number" && p.owner === "unowned"),
    };
  }
  if (args.json) {
    ctx.stdout(JSON.stringify(named !== undefined ? results[teams[0]!] : results));
    return 0;
  }
  for (const team of teams) {
    const { tickets, unownedPulls } = results[team]!;
    ctx.stdout(`${team}: ${tickets.length} free ${tickets.length === 1 ? "ticket" : "tickets"}, ${unownedPulls.length} unowned open ${unownedPulls.length === 1 ? "pull request" : "pull requests"}`);
    for (const row of tickets) {
      const last = text(row.lastHolder) ? `; last held by ${row.lastHolder}${text(row.lastProgress) ? `, last progress ${row.lastProgress}` : ""}` : "";
      ctx.stdout(`  ${row.ticket}${last}`);
    }
    for (const pull of unownedPulls)
      ctx.stdout(`  #${pull.number}${pull.draft ? " (draft)" : ""}${text(pull.ticket) ? ` ${pull.ticket}` : ""}: unowned${text(pull.title) ? `, ${pull.title}` : ""}`);
  }
  return 0;
}
