// execution.ts — what Catalyst is doing: `explain <ticket>`, `running`, `queue`, `accounts`.
// `explain` turns one work-eligibility row into a paragraph a human can act on, translating every
// exclusion reason and unknown the cloud names; an unlisted reason prints its raw string, never nothing.
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { findTeamByKey, loadContract } from "./contract.js";
import type { ContractDispatchGate } from "./contract-types.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

/** Every exclusion reason the eligibility evaluator names, in plain English. */
export const EXCLUSION_REASONS: Record<string, string> = {
  ticket_terminal: "the ticket is in a done or canceled state, so there is nothing left to run",
  pipeline_complete: "every relay phase has already completed",
  not_at_dispatch_stage: "the card is not in the team's dispatch column, so nothing is offered until it is moved there",
  not_at_pr_stage: "merge is next but the card is not in the PR column",
  blocked: "a live blocking relation holds it — the blocker has to close first",
  cooling_down: "the offered phase is parked; a callback or an operator releases it, not a clock",
  lease_held: "a live container already holds the lease for the offered phase",
  intake_lease_held: "a later phase is offered while an intake container still holds this ticket",
  ask_ticket: "it carries an ask label, and a question is never work",
  ask_shape_suspected: "its own text reads as a decision request; a human releases it with the not-an-ask label",
  externally_claimed: "a worker outside the cloud has claimed it",
  environment_check_required: "the repository's environment check has not been run",
  environment_check_running: "the repository's environment check is in flight",
  environment_check_failed: "the repository's environment check failed",
  environment_check_expired: "the repository's environment check verdict aged out",
  environment_check_hash_mismatch: "the environment changed since its recorded verdict",
  scope_overlap: "its declared file scope intersects a ticket already in flight",
  waiting_on: "a merge-gate failure with no remediable cause holds the card at PR",
  branch_missing: "the ticket branch has never been seen, so a branch-dependent phase has nothing to clone",
  branch_gone: "the ticket branch was deleted after it existed",
  pr_merged: "its PR has merged and no other PR is open — nothing is left to clone or re-merge",
  no_change_hold: "a remediate round changed nothing; a human comment or a new push releases it",
  validate_class_spent: "this validate failure already spent its one repair round in this episode",
  stale_failure_episode: "the ladder advanced after the recorded failure, so the round would repair a phase already passed",
  runner_image_breaker: "fleet-wide: the live runner image is failing every phase at startup; dispatch resumes when the pin moves",
  no_branch_to_remediate: "a remediate round is queued on a ticket with no recorded branch",
  retry_backoff: "the failed phase is retrying in place and waiting out its backoff",
  routing_unavailable: "the unit was claimed and refused at kickoff (no route, no eligible AI account, or the provider is unavailable)",
  repo_paused: "an operator paused the repository",
  remediate_parked: "the remediate phase is parked, so the failing phase has nowhere to be repaired; `catalyst release <ticket>` releases the park once its cause is fixed",
  phase_parked: "the offered phase is parked after repeated failures or the repair-round cap; `catalyst release <ticket>` releases it once its cause is fixed",
  later_phase_lease_held: "an earlier phase is offered while a live container still holds a later phase of this ticket",
  human_owned_pr: "a person's own pull request holds this ticket; it releases itself when that PR closes or merges",
  review_not_converging: "review and repair kept finding new problems without converging; a person reads the findings and comments on the ticket to resume",
  round_threshold: "the ticket spent its lifetime repair budget; answering its ask or pushing a fix buys one more cycle",
  claim_storm: "this unit was claimed too many times in the last hour, so it waits out the hour; nothing to release",
  repo_at_capacity: "the repository's runner seats are all in use; it starts when one frees",
  wip_limit: "the project is at its WIP limit (tickets in progress, counting blocked, parked and waiting ones); this new start waits until one of them finishes, and the tickets in progress keep running",
};

/** Every fail-closed unknown the evaluator names. */
export const UNKNOWN_REASONS: Record<string, string> = {
  ordering_never_published: "the dispatch order has never been published for this team — usually because the team has no saved stage mapping, which does not clear by itself",
  ordering_stale: "the dispatch order is stale",
  workflow_mapping_unknown: "the team has no saved stage mapping for dispatch, pr, done and canceled (or a mapped stage was deleted); it does not clear by itself; a workspace owner or admin runs catalyst team map <KEY>, or catalyst team adopt <KEY> to create Catalyst's stages",
  ticket_unknown: "the ticket is not in the mirror",
  dependency_snapshot_unknown: "the dependency snapshot has never completed",
  blocker_unknown: "a blocking relation could not be resolved",
  label_snapshot_unknown: "the labels poll has never completed, so ask labels cannot be read",
  prior_artifact_unknown: "a prior phase artifact could not be read",
  scope_unknown: "the ticket declared no scope, or the declaration was truncated",
  scope_occupancy_unknown: "an in-flight ticket's state could not be resolved",
  branch_snapshot_unknown: "the pull-request poll has never completed, so branch evidence cannot be read",
};

export const ADVISORIES: Record<string, string> = {
  human_addressed_unlabeled_ask_suspect: "assigned to a human with no delegate: this may be an unlabelled ask",
};

export interface EligibilityRow {
  position?: number;
  ticket?: string;
  status?: string;
  reason?: string;
  phase?: string;
  unknown?: string;
  advisories?: string[];
  detail?: string;
  marker?: string;
  release?: string;
  nextPhase?: string;
  failure?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export function describeReason(reason: string | undefined): string {
  if (!reason) return "no reason was given";
  return EXCLUSION_REASONS[reason] ?? UNKNOWN_REASONS[reason] ?? `reason "${reason}" (not in this bundle's table; read it as the cloud spelled it)`;
}

/**
 * The team-level reason nothing in a team can start, sent by the cloud beside the eligibility rows when
 * the team's dispatch/pr/done/canceled stages are not mapped to live Linear stages. Absent when the
 * team's gate is open, and on an older cloud eligibility response — but a cloud at contract 1.6.0+
 * carries the same fact on the cached tenant contract too (`ContractTeam.dispatchGate`), which
 * `cmdExplain` reads as a fallback when the live eligibility read is unavailable or silent (CTC-2208).
 */
export interface DispatchGate {
  cause: string;
  missingSlots?: readonly string[];
  remedy?: string | null;
  /** Which read produced it: the live eligibility response, or the cached tenant contract. */
  source?: "live" | "contract";
}

/** The contract spells the same concept `status`; normalize onto the `cause` the renderer uses.
 *  `"open"` and an absent/shapeless gate both mean "nothing to report" — null. An unrecognized
 *  status is passed through as `cause`, never swallowed (D2/D3 — CTC-2208). */
export function gateFromContract(g: ContractDispatchGate | undefined): DispatchGate | null {
  if (!g || typeof g.status !== "string") return null;
  if (g.status === "open") return null;
  return { cause: g.status, missingSlots: g.missingSlots, remedy: g.remedy, source: "contract" };
}

/** True when the live eligibility read failed in a way a cached gate may stand in for: the read was
 *  UNAVAILABLE (network/timeout/non-JSON, or a 404/5xx). A cloud that ANSWERED — 401/403/400 — is
 *  refusing, not silent, and a cached gate must never hide that refusal behind an unrelated mapping
 *  story (D4 — CTC-2208). */
export function liveReadMayFallBack(err: unknown): boolean {
  if (err instanceof MeError) return true;
  if (err instanceof CliError) return err.status === undefined || err.status === 404 || err.status >= 500;
  return false;
}

export function renderDispatchGate(ticket: string, team: string, gate: DispatchGate): string {
  const slots = (gate.missingSlots ?? []).join(", ");
  const why =
    gate.cause === "mapping_state_unresolved"
      ? `the stage team ${team} mapped for ${slots} no longer exists in Linear.`
      : gate.cause === "mapping_missing"
        ? `team ${team} has no saved stage mapping for ${slots}.`
        : `team ${team} cannot be dispatched (${gate.cause}).`;
  return [`${ticket} cannot start: ${why}`, gate.remedy].filter(Boolean).join(" ");
}

export function renderExplain(
  ticket: string,
  row: EligibilityRow | null,
  team: string,
  knownState?: string | null,
  gate?: DispatchGate | null,
): string {
  // An unmapped team has no queue and so no rows; its gate is the whole answer, and it outranks the
  // Backlog probe below, which would otherwise call the team's own Todo "not a dispatch state".
  if (gate) return renderDispatchGate(ticket, team, gate);
  if (!row) {
    // A null dispatch row is not proof the ticket does not exist — the explainer is a dispatch scan. When
    // `knownState` is set (the mirror answered GET /issues/:id) the ticket is real; it just sits outside a
    // dispatch column. Only a 404 (knownState null/absent) is truly unknown to the mirror.
    if (knownState) return `${ticket}: known to the mirror; state ${knownState} is not a dispatch state.`;
    return `${ticket}: not in the ${team} eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.`;
  }
  const parts: string[] = [];
  const pos = typeof row.position === "number" ? `position ${row.position}` : "no queue position";
  const status = row.status ?? "unknown";
  if (status === "offered" || status === "eligible") {
    parts.push(`${ticket} is ${status} (${pos})${row.phase ? ` for phase ${row.phase}` : ""}.`);
  } else if (status === "unknown") {
    parts.push(`${ticket} cannot be judged (${pos}): ${describeReason(row.unknown ?? row.reason)}.`);
  } else {
    parts.push(`${ticket} is ${status} (${pos}): ${describeReason(row.reason)}.`);
  }
  if (row.detail) parts.push(`Detail: ${row.detail}.`);
  if (row.marker) parts.push(`Marker: ${row.marker}.`);
  if (row.nextPhase) parts.push(`Next phase would be ${row.nextPhase}.`);
  if (row.release) parts.push(`Release: ${row.release}.`);
  if (row.failure && typeof row.failure === "object") {
    const f = row.failure;
    const bits = ["phase", "class", "attempts", "consecutive", "lastFailedAt", "message", "summary"]
      .filter((k) => f[k] !== undefined && f[k] !== null)
      .map((k) => `${k}=${typeof f[k] === "string" ? f[k] : JSON.stringify(f[k])}`);
    parts.push(`Last failure: ${bits.length ? bits.join(", ") : JSON.stringify(f)}.`);
  }
  if (row.advisories && row.advisories.length > 0) {
    parts.push(`Advisories: ${row.advisories.map((a) => ADVISORIES[a] ?? a).join("; ")}.`);
  }
  return parts.join(" ");
}

export async function cmdExplain(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [ticket] = positionals(args);
  if (!ticket) throw new UsageError("explain needs a ticket: explain <ticket>");
  const cfg = requireConfig(ctx);
  // `explain --history` is the same read as `history <ticket>`; both go to CTC-1954's route.
  if (flagBool(args, "history")) return await cmdHistory(args, ctx, ticket);
  const { doc } = await loadContract(ctx, cfg);
  const dash = ticket.indexOf("-");
  if (dash <= 0) throw new UsageError(`"${ticket}" is not a ticket identifier (expected KEY-123)`);
  const team = ticket.slice(0, dash).toUpperCase();
  const api = apiClient(cfg, ctx);
  // The cached contract's own gate for this team. Read BEFORE the live call so it can stand in when
  // that call cannot be made at all. A team absent from the contract simply has none.
  const cachedGate = gateFromContract(findTeamByKey(doc, team)?.dispatchGate);

  let row: EligibilityRow | null = null;
  let knownState: string | null = null;
  let liveGate: DispatchGate | null = null;
  let liveFailure: Error | null = null;
  let liveGateRaw: DispatchGate | null = null;
  // This `try` wraps the eligibility read ALONE. It used to span the mirror probe below as well,
  // which broke both reads at once: a probe outage was reported as "the live eligibility read was
  // unavailable", and an eligibility outage skipped the probe entirely so `knownState` stayed null
  // and a mistyped id inherited the team-wide gate — the very bug 4defc34 was written to fix.
  try {
    const res = await api.getJson<{
      eligibility?: { rows?: EligibilityRow[]; dispatchGate?: DispatchGate };
      rows?: EligibilityRow[];
    }>("/api/v1/work-eligibility", { query: { team, capabilities: doc.ladder.phases.join(",") } });
    const rows = res.body.eligibility?.rows ?? res.body.rows ?? [];
    row = rows.find((r) => String(r.ticket ?? "").toUpperCase() === ticket.toUpperCase()) ?? null;
    liveGateRaw = res.body.eligibility?.dispatchGate ?? null;
  } catch (err) {
    // A cached gate is an answer the live read cannot give right now — but ONLY for a failure that
    // means "unavailable". A 401/403/400 is the cloud answering, and must still refuse (CTC-2208 D4).
    if (!cachedGate || !liveReadMayFallBack(err)) throw err;
    liveFailure = err instanceof Error ? err : new Error(String(err));
  }

  // No dispatch row is not proof of non-existence: probe the mirror so a Backlog ticket reads as
  // known. The mirror compares identifiers exactly, so normalize as the row lookup above does —
  // otherwise `explain eng-7` probes a lowercase id, 404s, and reports an existing ENG-7 unknown.
  // Deliberately OUTSIDE the `try`: the probe is the ONLY read that can prove this id exists, so it
  // must still run when the eligibility read was unavailable, and its own failure must surface as
  // itself — a refusal naming the /issues/ read — never as a gate paragraph or as an eligibility
  // failure. That is the pre-4defc34 behaviour for this call and it is restored unchanged.
  if (!row) {
    const probe = await api.getJson<{ state?: unknown }>(`/api/v1/issues/${encodeURIComponent(ticket.toUpperCase())}`, { accept: [404] });
    if (probe.status !== 404) knownState = typeof probe.body?.state === "string" ? probe.body.state : "unknown";
  }
  // The gate is TEAM-wide: it can say why a real ticket in that team cannot start, never that this
  // id exists. Applied only when the probe found the ticket; a 404 keeps the unknown wording.
  liveGate = !row && knownState && liveGateRaw ? { ...liveGateRaw, source: "live" } : null;

  // The cached gate is team-wide too, so it answers on exactly the same condition as the live one:
  // the mirror found the ticket and no row explains it. An unavailable eligibility read licenses the
  // FALLBACK, never the claim that this id exists.
  const usingCached = !liveGate && !row && knownState !== null;
  const gate = liveGate ?? (usingCached ? cachedGate : null);
  // Both sides spoke and disagreed: the live read wins, and the paragraph says the cache disagreed.
  // Computed together with its sentence so the "live is non-null here" fact never needs re-asserting.
  let overridden: DispatchGate | null = null;
  let overriddenNote: string | null = null;
  if (liveGate && cachedGate && liveGate.cause !== cachedGate.cause) {
    overridden = cachedGate;
    overriddenNote = `The cached tenant contract says ${cachedGate.cause}; this live eligibility read says ${liveGate.cause} and wins.`;
  }
  // A live read that produced a row contradicts a cached "nothing in this team can start".
  const contradictedByRow = !liveFailure && row && cachedGate ? cachedGate : null;

  const parts = [renderExplain(ticket, row, team, knownState, gate)];
  if (gate && gate === cachedGate) {
    parts.push(
      liveFailure
        ? `Read from the cached tenant contract: the live eligibility read was unavailable (${liveFailure.message}).`
        : "Read from the cached tenant contract: this cloud's eligibility read sent no dispatch gate.",
    );
  }
  if (overriddenNote) parts.push(overriddenNote);
  // The mirror answered and the eligibility read did not: say so, rather than let a network outage
  // read as a confident verdict from an explainer this run never actually reached.
  if (liveFailure && gate !== cachedGate) {
    parts.push(`The live eligibility read was unavailable (${liveFailure.message}); only the mirror answered.`);
  }
  if (contradictedByRow) {
    parts.push(`The cached tenant contract says ${contradictedByRow.cause} for team ${team}; this live eligibility read has a row for ${ticket} and wins.`);
  }
  const explanation = parts.join(" ");

  if (args.json) {
    ctx.stdout(
      JSON.stringify({
        ticket,
        row,
        ...(gate ? { dispatchGate: gate } : {}),
        ...(overridden || contradictedByRow ? { dispatchGateOverridden: overridden ?? contradictedByRow } : {}),
        ...(liveFailure ? { liveReadFailed: liveFailure.message } : {}),
        explanation,
      }),
    );
  } else {
    ctx.stdout(explanation);
  }
  return 0;
}

/**
 * `running` — the fleet-wide "what is Catalyst doing right now?".
 *
 * ⛔ `/api/v1/lease/attributions` IS NOT A FLEET-WIDE ROUTE. It answers "who wrote this transition,
 * holding which lease?" for ONE (ticket, phase) pair and 400s `invalid_field` without both — 0.2.0
 * called it bare on every `running`, so the headline verb (and `whats-running.mjs`, and
 * `snapshot.mjs`) failed for every tenant. The tenant-wide question is answered by
 * `/fleet-activity/current` (what is executing) and `/agent-roster/current` (who is coordinating),
 * neither of which takes coordinates. Lease attributions stay available, behind the coordinates the
 * route requires.
 */
export async function cmdRunning(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const ticket = flagString(args, "ticket");
  const phase = flagString(args, "phase");
  if ((ticket === undefined) !== (phase === undefined)) {
    throw new UsageError(
      "running: --ticket and --phase go together — lease attributions are recorded per (ticket, phase), and the route refuses either one alone",
    );
  }
  const api = apiClient(cfg, ctx);
  const [activity, roster] = await Promise.all([
    api.getJson<unknown>("/api/v1/fleet-activity/current"),
    api.getJson<unknown>("/api/v1/agent-roster/current"),
  ]);
  const out: Record<string, unknown> = { fleetActivity: activity.body, agentRoster: roster.body };
  if (ticket !== undefined && phase !== undefined) {
    const leases = await api.getJson<unknown>("/api/v1/lease/attributions", { query: { ticket, phase } });
    out.leaseAttributions = leases.body;
  }
  if (args.json) {
    ctx.stdout(JSON.stringify(out));
    return 0;
  }
  ctx.stdout(`fleet activity: ${JSON.stringify(out.fleetActivity)}`);
  ctx.stdout(`agent roster: ${JSON.stringify(out.agentRoster)}`);
  if (out.leaseAttributions !== undefined) {
    ctx.stdout(`lease attributions (${ticket} ${phase}): ${JSON.stringify(out.leaseAttributions)}`);
  }
  return 0;
}

/**
 * `queue` — the dispatch order. The route is per-team and REQUIRES `?team=` ("bad team", 400), but
 * a customer asking "what is next?" rarely means one team, so an omitted `--team` reads every team
 * the tenant contract names rather than sending a call the route will refuse.
 */
export async function cmdQueue(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  const named = flagString(args, "team");
  let teams: string[];
  if (named !== undefined) {
    teams = [named];
  } else {
    const { doc } = await loadContract(ctx, cfg);
    teams = doc.teams.map((t) => t.key).filter((k): k is string => typeof k === "string" && k !== "");
    if (teams.length === 0) {
      throw new UsageError("queue needs --team: the tenant contract names no team to read a queue for");
    }
  }
  const bodies = await Promise.all(
    teams.map(async (team) => [team, (await api.getJson<unknown>("/api/v1/dispatch-queue/current", { query: { team } })).body] as const),
  );
  // One team asked for → its envelope, unwrapped, exactly as before. Several → keyed by team, so a
  // caller can tell whose queue a row belongs to.
  const out = bodies.length === 1 && named !== undefined ? bodies[0]![1] : Object.fromEntries(bodies);
  ctx.stdout(args.json ? JSON.stringify(out) : JSON.stringify(out, null, 2));
  return 0;
}

/** The status words `/api/v1/coding-accounts` reports, in the words a customer reads. */
export const ACCOUNT_STATUS: Record<string, string> = {
  "expired-or-revoked": "credential expired or missing — replace its credential on the AI accounts page (Settings → AI accounts → the account → Replace credential) before it can take work",
  // CTC-6204: revoked and ended accounts share one history-only end state (Ryan, 2026-10-19).
  ended: "removed — kept for history, takes no work",
  "out-of-rotation": "paused — its owner took it out of rotation",
  walled: "walled — the provider's usage limit is spent for now",
  active: "active — observed working",
  attested: "attested — healthy at last check, no work observed since",
  unobserved: "unobserved — enrolled, but nothing has been seen from it yet",
};

export interface CodingAccount {
  accountSlot?: string;
  provider?: string;
  harness?: string | null;
  label?: string | null;
  status?: string;
  walled?: boolean;
  quarantined?: boolean;
  quarantineReason?: string | null;
  renewalStatus?: string | null;
  revokedAtMs?: number | null;
  email?: string | null;
  displayName?: string;
  bindingWindow?: string | null;
  bindingUsedPercent?: number | null;
  bindingResetsAtMs?: number | null;
  liveHoldsCount?: number;
  liveHolds?: { ticket: string; phase: string; leaseDeadlineMs: number }[];
  /** CTC-6848: SHA-256 hex of the Codex login's account id, on the caller's own Codex accounts; else null. */
  loginSha256?: string | null;
  [k: string]: unknown;
}

/** The name a person or agent calls an account by: its label, else its email, else its slot id. */
export function accountDisplayName(a: CodingAccount): string {
  for (const v of [a.label, a.email]) if (typeof v === "string" && v.trim() !== "") return v.trim();
  return a.accountSlot ?? "?";
}

/** CTC-6204: a revoked account, or one whose paid access ended, can never take work again and takes
 *  no new credential. It is kept for history only. An older cloud still calls a revoked account
 *  `expired-or-revoked`, so `revokedAtMs` decides as well as the status word. */
export function historyOnly(a: CodingAccount): boolean {
  return typeof a.revokedAtMs === "number" || a.status === "ended";
}

/** One slot as a line a human reads: who it is, what state it is in, and what it is spending on. */
export function renderAccount(a: CodingAccount): string {
  const display = accountDisplayName(a);
  const name = display === (a.accountSlot ?? "?") ? display : `${display} (${a.accountSlot ?? "?"})`;
  const harness = a.harness ? `/${a.harness}` : "";
  const status = historyOnly(a) ? ACCOUNT_STATUS.ended! : a.status ? (ACCOUNT_STATUS[a.status] ?? a.status) : "status unknown";
  const bits = [`${name}  ${a.provider ?? "?"}${harness}  ${status}`];
  // CTC-4199: a cancelled subscription is kept for reporting and not used; never re-credential it (Ryan, 2026-09-29).
  if (a.renewalStatus === "canceled") bits.push("subscription canceled — kept for reporting, not used");
  if (typeof a.bindingUsedPercent === "number") {
    const resets = typeof a.bindingResetsAtMs === "number" ? `, resets ${new Date(a.bindingResetsAtMs).toISOString()}` : "";
    bits.push(`usage ${a.bindingUsedPercent}% of the ${a.bindingWindow ?? "binding"} window${resets}`);
  }
  if (a.quarantined) bits.push(`quarantined${a.quarantineReason ? `: ${a.quarantineReason}` : ""}`);
  const holds = a.liveHolds ?? [];
  if (holds.length > 0) bits.push(`holding ${holds.map((h) => `${h.ticket}/${h.phase}`).join(", ")}`);
  else if (a.liveHoldsCount) bits.push(`${a.liveHoldsCount} live hold(s)`);
  return bits.join("  ·  ");
}

/**
 * ⛔ A ROUTE THIS TENANT'S CLOUD DOES NOT SERVE IS SAID OUT LOUD, never rendered as an empty success.
 * `GET /api/v1/coding-accounts` (CTC-1953) and `GET /api/v1/issues/:id/execution` (CTC-1954) ship
 * ahead of some tenants' deployed mirror; a 404 there means "your cloud is older than this bundle",
 * which is a different fact from "you have no coding accounts" and must never print as the latter.
 */
export function needsNewerCloud(what: string, cfg: { baseUrl: string }): CliError {
  return new CliError(
    `${what} needs a newer Catalyst Cloud than ${normalizeBaseUrl(cfg.baseUrl)} is running — the route answered 404. Nothing is wrong with your tenant; ask your operator when the mirror last deployed.`,
    "route-not-deployed",
    3,
    404,
  );
}

export async function cmdAccounts(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  const res = await api.getJson<{ accounts?: CodingAccount[] } | CodingAccount[]>("/api/v1/coding-accounts", {
    accept: [404],
  });
  if (res.status === 404) throw needsNewerCloud("AI account status", cfg);
  const accounts = Array.isArray(res.body) ? res.body : (res.body?.accounts ?? []);
  // CTC-6204: removed accounts are history, so they are left out unless --all asks for them. Listed,
  // they read as accounts to repair, and agents kept trying to revive them.
  const shown = flagBool(args, "all") ? accounts : accounts.filter((a) => !historyOnly(a));
  const hidden = accounts.length - shown.length;
  if (args.json) {
    const named = shown.map((a) => ({ ...a, displayName: accountDisplayName(a), removed: historyOnly(a) }));
    ctx.stdout(JSON.stringify(Array.isArray(res.body) ? named : { ...res.body, accounts: named, removedHidden: hidden }));
    return 0;
  }
  const addAt = `${normalizeBaseUrl(cfg.baseUrl)}/settings/coding-accounts`;
  const hiddenLine = `${hidden} removed account${hidden === 1 ? " is" : "s are"} kept for history and take no work; catalyst accounts --all lists ${hidden === 1 ? "it" : "them"}.`;
  if (accounts.length === 0) {
    ctx.stdout(`No AI accounts are enrolled in this workspace. A workspace owner or admin adds one at ${addAt}; there is no command for that yet.`);
    return 0;
  }
  if (shown.length === 0) {
    ctx.stdout(`No AI account in this workspace can take work. A workspace owner or admin adds one at ${addAt}. ${hiddenLine}`);
    return 0;
  }
  for (const a of shown) ctx.stdout(renderAccount(a));
  if (hidden > 0) ctx.stdout(hiddenLine);
  return 0;
}

/**
 * `history <ticket>` (and `explain --history`) — the ticket's execution history: per-phase attempts
 * and outcomes, remediate rounds against the cap, the park sentinel and what releases it, the live
 * lease, the last advance. Reads `GET /api/v1/issues/:identifier/execution` (CTC-1954).
 */
export async function cmdHistory(args: ParsedArgs, ctx: Ctx, ticketArg?: string): Promise<number> {
  const ticket = ticketArg ?? positionals(args)[0];
  if (!ticket) throw new UsageError("history needs a ticket: history <ticket>");
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  const res = await api.getJson<TicketExecution>(`/api/v1/issues/${encodeURIComponent(ticket)}/execution`, {
    accept: [404],
  });
  if (res.status === 404) throw needsNewerCloud(`execution history for ${ticket}`, cfg);
  if (args.json) {
    ctx.stdout(JSON.stringify(res.body));
    return 0;
  }
  for (const line of renderHistory(ticket, res.body)) ctx.stdout(line);
  return 0;
}

export interface TicketExecution {
  ticket?: string;
  hasLadderHistory?: boolean;
  note?: string;
  attemptHistory?: string;
  phases?: { phase: string; attempt?: number; status?: string; lastFailureClass?: string | null; consecutiveFailures?: number | null }[] | null;
  failure?: { phase: string; failureMode: string; failureDetail?: string | null; summary?: string | null; attempt?: number } | null;
  remediate?: { roundsDispatched?: number; cap?: number } | null;
  park?: { sentinel: string; selfReleases: boolean; releasedBy: string; phase?: string } | null;
  /** Every governor holding the ticket, each with what releases it; `null` is unreadable, never "none". */
  governors?: { kind: string; phase?: string | null; sentinel?: string; release?: string }[] | null;
  /** The release audit, newest first; `null` is unreadable. */
  releases?: {
    atMs: number;
    outcome: string;
    because: string;
    actor: { kind: string; id: string };
    released?: { op: string; phase: string | null }[];
    refused?: { code: string }[];
  }[] | null;
  lease?: { phase: string; holder: string | null; deadlineMs: number }[] | null;
  lastAdvance?: { phase: string; toSlot?: string | null; landed?: boolean } | null;
  unreadable?: { table: string; error: string }[];
  [k: string]: unknown;
}

/** ⛔ `null` is UNREADABLE, never "nothing happened" — the report's own contract, kept in the prose. */
export function renderHistory(ticket: string, doc: TicketExecution): string[] {
  const lines: string[] = [];
  if (doc.hasLadderHistory === false) {
    lines.push(`${ticket}: no ladder history recorded${doc.note ? ` — ${doc.note}` : ""}.`);
  }
  const phases = doc.phases;
  if (phases === null || phases === undefined) {
    lines.push(`${ticket}: the per-phase table could not be read (unreadable, not empty).`);
  } else {
    lines.push(`${ticket} phases (${doc.attemptHistory ?? "latest-per-phase"}):`);
    for (const p of phases) {
      const fail = p.lastFailureClass ? `, last failure ${p.lastFailureClass}${p.consecutiveFailures ? ` ×${p.consecutiveFailures}` : ""}` : "";
      lines.push(`  ${p.phase}: ${p.status ?? "?"} (attempt ${p.attempt ?? "?"})${fail}`);
    }
  }
  if (doc.failure) {
    const f = doc.failure;
    lines.push(`Last failure: ${f.phase} — ${f.failureMode}${f.failureDetail ? ` (${f.failureDetail})` : ""}${f.summary ? `: ${f.summary}` : ""}`);
  }
  if (doc.remediate && typeof doc.remediate.roundsDispatched === "number") {
    lines.push(`Remediate rounds dispatched: ${doc.remediate.roundsDispatched}${typeof doc.remediate.cap === "number" ? ` (cap ${doc.remediate.cap})` : ""}`);
  }
  if (doc.park) {
    lines.push(`Parked at ${doc.park.phase ?? "?"} (${doc.park.sentinel}): ${doc.park.selfReleases ? "releases itself" : "does not release itself"} — ${doc.park.releasedBy}`);
  }
  // Absent (an older cloud) prints nothing; `null` is a table that could not be read.
  if (doc.governors === null) {
    lines.push("Held by: could not be read (unreadable, not empty)");
  } else if (doc.governors !== undefined && doc.governors.length > 0) {
    lines.push("Held by:");
    for (const g of doc.governors) {
      lines.push(`  ${g.kind}${g.phase ? ` at ${g.phase}` : ""}${g.sentinel ? ` (${g.sentinel})` : ""} — ${g.release ?? "no release named"}`);
    }
  }
  if (doc.releases === null) {
    lines.push("Releases: could not be read (unreadable, not empty)");
  } else if (doc.releases !== undefined && doc.releases.length > 0) {
    lines.push("Releases (newest first):");
    for (const r of doc.releases) {
      const what =
        r.outcome === "released"
          ? `released: ${(r.released ?? []).map((a) => `${a.op}${a.phase ? ` ${a.phase}` : ""}`).join(", ")}`
          : `refused: ${(r.refused ?? []).map((x) => x.code).join(", ")}`;
      lines.push(`  ${new Date(r.atMs).toISOString()} ${r.outcome} by ${r.actor.kind}:${r.actor.id} — "${r.because}" — ${what}`);
    }
  }
  for (const l of doc.lease ?? []) lines.push(`Live lease: ${l.phase} held by ${l.holder ?? "?"} until ${new Date(l.deadlineMs).toISOString()}`);
  if (doc.lastAdvance) {
    lines.push(`Last advance: ${doc.lastAdvance.phase} → ${doc.lastAdvance.toSlot ?? "?"} (${doc.lastAdvance.landed ? "landed" : "not landed"})`);
  }
  for (const u of doc.unreadable ?? []) lines.push(`Unreadable: ${u.table} (${u.error}) — absent from this report, not absent from the ticket.`);
  return lines;
}
