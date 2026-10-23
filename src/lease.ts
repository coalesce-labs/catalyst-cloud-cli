// lease.ts — `catalyst lease` and `catalyst work available` (CTC-6400): a seat or one-shot session
// holds the ticket it works through a ticket lease, never a label, and sees what work is free.
//
//   lease take <TICKET> --agent <name> [--ttl <minutes>]     POST /api/v1/agent/ticket-lease/take
//   lease renew <TICKET> --commit|--artifact|--finding|--pr <ref> [--note <text>]
//                                                             POST /api/v1/agent/ticket-lease/renew
//   lease release <TICKET>                                    POST /api/v1/agent/ticket-lease/release
//   lease show <TICKET>                                       GET  /api/v1/agent/ticket-lease?ticket=
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
// budget (429) exit 1 the same way, with the server's reason.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { CONFIG_MODE, configDirFor, requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import { UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

const ROUTE = "/api/v1/agent/ticket-lease";
const TICKET = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;
const AGENT = /^[a-z0-9-]{1,40}$/;
const ACCEPT = [400, 403, 404, 409, 429];

/** What this machine keeps for one lease: the seat and the generation the next call names. */
interface StoredLease {
  ticket: string;
  agent: string;
  generation: number;
  holder: string | null;
}

interface LeaseRow extends Record<string, unknown> {
  holder: string | null;
  generation: number;
  deadlineMs: number;
  lastHolder?: string | null;
  lastProgress?: string | null;
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
        found.push({ ticket, agent: value.agent, generation: value.generation, holder: text(value.holder) ? value.holder : null });
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
 *  stored for the ticket. Two stored seats need --agent to choose. */
function heldLease(args: ParsedArgs, ctx: Ctx, ticket: string): { agent: string; generation: number } {
  const agent = parseAgent(flagString(args, "agent"));
  const rawGeneration = flagString(args, "generation");
  let generation: number | undefined;
  if (rawGeneration !== undefined) {
    generation = Number(rawGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new UsageError("--generation is the positive integer the take printed");
  }
  const stored = storedLeases(ctx, ticket).filter((s) => agent === undefined || s.agent === agent);
  if (agent !== undefined && generation !== undefined) return { agent, generation };
  if (stored.length === 1) return { agent: stored[0]!.agent, generation: generation ?? stored[0]!.generation };
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

function when(ms: number): string {
  return new Date(ms).toISOString();
}
function detail(body: unknown): string {
  if (!object(body)) return "";
  const parts = [body.reason, body.error, body.message].filter(text);
  return parts.length ? `: ${[...new Set(parts)].join(": ")}` : "";
}

/** Print a refusal or an HTTP failure and return the exit code 1. */
function refuse(args: ParsedArgs, ctx: Ctx, status: number, body: unknown, verb: string): number {
  if (args.json) {
    ctx.stdout(JSON.stringify(object(body) ? { status, ...body } : { status }));
    return 1;
  }
  if (status === 200 && object(body) && object(body.refusal)) {
    const r = body.refusal;
    const current = leaseRow(r.current) ? r.current : null;
    const parts = [`refused: ${text(r.reason) ? r.reason : "unknown"}`];
    if (current?.holder) parts.push(`held by ${current.holder} until ${when(current.deadlineMs)}`);
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

function printLease(ctx: Ctx, ticket: string, lease: LeaseRow): void {
  ctx.stdout(`${ticket}: held by ${lease.holder ?? "nobody"} until ${when(lease.deadlineMs)}, generation ${lease.generation}`);
  if (text(lease.lastProgress)) ctx.stdout(`  last progress: ${lease.lastProgress}`);
}

export async function cmdLease(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [action, rawTicket, ...extra] = positionals(args);
  if (action !== "take" && action !== "renew" && action !== "release" && action !== "show")
    throw new UsageError("lease needs take, renew, release or show");
  if (extra.length) throw new UsageError(`lease ${action} takes one ticket`);
  const ticket = parseTicket(rawTicket, action);
  const client = apiClient(requireConfig(ctx), ctx);

  if (action === "show") {
    const res = await client.getJson(ROUTE, { query: { ticket }, accept: ACCEPT, parseAccepted: true });
    if (res.status >= 400) return refuse(args, ctx, res.status, res.body, action);
    if (args.json) {
      ctx.stdout(JSON.stringify(res.body));
      return 0;
    }
    const lease = object(res.body) && leaseRow(res.body.lease) ? res.body.lease : null;
    if (lease === null) ctx.stdout(`${ticket}: no ticket lease`);
    else if (lease.live === false) {
      ctx.stdout(`${ticket}: free; last held by ${lease.lastHolder ?? lease.holder ?? "nobody"}, generation ${lease.generation}`);
      if (text(lease.lastProgress)) ctx.stdout(`  last progress: ${lease.lastProgress}`);
    } else printLease(ctx, ticket, lease);
    return 0;
  }

  if (action === "take") {
    const agent = parseAgent(flagString(args, "agent"));
    if (agent === undefined) throw new UsageError("lease take needs --agent <seat name>");
    const res = await client.postJson(`${ROUTE}/take`, { ticket, agent, ...parseTtlMs(args) }, { accept: ACCEPT });
    if (res.status !== 200 || !object(res.body) || res.body.outcome !== "taken" || !leaseRow(res.body.lease))
      return refuse(args, ctx, res.status, res.body, action);
    const lease = res.body.lease;
    saveLease(ctx, { ticket, agent, generation: lease.generation, holder: lease.holder });
    if (args.json) ctx.stdout(JSON.stringify(res.body));
    else printLease(ctx, ticket, lease);
    return 0;
  }

  if (action === "renew") {
    const progress = parseProgress(args);
    const held = heldLease(args, ctx, ticket);
    const res = await client.postJson(`${ROUTE}/renew`, { ticket, ...held, progress, ...parseTtlMs(args) }, { accept: ACCEPT });
    if (res.status !== 200 || !object(res.body) || res.body.outcome !== "renewed" || !leaseRow(res.body.lease)) {
      forgetIfGone(ctx, ticket, held.agent, res.body);
      return refuse(args, ctx, res.status, res.body, action);
    }
    if (args.json) ctx.stdout(JSON.stringify(res.body));
    else printLease(ctx, ticket, res.body.lease);
    return 0;
  }

  const held = heldLease(args, ctx, ticket);
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
