// A bare local seat holds one cloud phase across CLI invocations. The cloud owns the phase graph;
// this client only publishes through a live, fenced local-phase claim.
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, openSync, readFileSync, renameSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { configDirFor, requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract } from "./contract.js";
import { stageIdForSlot, teamForTicket } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { CliError, UsageError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import { apiClient } from "./transport.js";
import { postAgent, resolveIssue } from "./write.js";

type Route = "claim" | "renew" | "release" | "artifact" | "object" | "coordination";
interface LeaseState {
  version: 1;
  account: string;
  baseUrl: string;
  ticket: string;
  phase: string;
  nonce: number;
  credential: string;
  runtime: { incarnation: string; nonce: number };
  machine: string;
  node: string;
  expiresAtMs: number;
  routes: Record<Route, string>;
}

const names: Record<Route, string> = {
  claim: "/local-phase/claim", renew: "/local-phase/renew", release: "/local-phase/release",
  artifact: "/api/v1/artifacts/publish", object: "/api/v1/artifacts/object", coordination: "/api/v1/coordination/publish",
};
const artifactNames: Record<string, string> = {
  intake: "intake.json", research: "research.md", plan: "plan.md", implement: "implement.md",
  validate: "validation.md", pr: "pr.md", merge: "merge.md", remediate: "remediation.json",
};
const slotForPhase: Record<string, string> = { validate: "verify", merge: "pr" };

function statePath(home: string, ticket: string): string {
  return join(configDirFor(home), "local-stages", `${ticket}.json`);
}
function saveState(home: string, state: LeaseState): void {
  const path = statePath(home, state.ticket);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(state) + "\n"); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function readState(ctx: Ctx, cfg: CustomerConfig, ticket: string, phase: string): LeaseState {
  let state: LeaseState;
  try { state = JSON.parse(readFileSync(statePath(ctx.home, ticket), "utf8")) as LeaseState; }
  catch { throw new CliError(`no local stage claim for ${ticket}; run catalyst stage start ${ticket} ${phase}`, "stage-state"); }
  if (state.version !== 1 || state.ticket !== ticket || state.phase !== phase || state.account !== cfg.account || state.baseUrl !== cfg.baseUrl)
    throw new CliError("local stage claim does not match this ticket, phase, or workspace login", "stage-state");
  return state;
}
function routes(doc: { routes: readonly { method: string; path: string }[] }): Record<Route, string> {
  const discovered = { ...names };
  for (const key of ["claim", "renew", "release"] as const) {
    const suffix = names[key];
    const path = doc.routes.find((r) => r.method === "POST" && r.path.endsWith(suffix))?.path;
    if (!path) throw new CliError(`tenant contract has no POST ${suffix} route; update the cloud`, "stage-route");
    discovered[key] = path;
  }
  return discovered;
}
async function request(ctx: Ctx, cfg: CustomerConfig, path: string, options: {
  method?: "GET" | "POST"; query?: Record<string, string | number>; body?: unknown; bytes?: Buffer | string;
  credential?: string; contentType?: string;
}): Promise<{ body: unknown; bytes: Buffer; status: number }> {
  const url = new URL(path, cfg.baseUrl);
  url.searchParams.set("account", cfg.account);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { authorization: `Bearer ${await bearerFor(ctx, cfg)}` };
  if (options.credential) headers["x-catalyst-lease-credential"] = options.credential;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.bytes !== undefined) headers["content-type"] = options.contentType ?? "application/octet-stream";
  const res = await ctx.fetch(url, {
    method: options.method ?? "POST", headers,
    body: options.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: AbortSignal.timeout(options.bytes === undefined ? 30_000 : 120_000),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let body: unknown;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { body = undefined; }
  if (!res.ok) {
    const reason = body && typeof body === "object" ? JSON.stringify(body) : bytes.toString("utf8").slice(0, 200);
    if (res.status === 403 && body && typeof body === "object" &&
      (body as { reason?: unknown }).reason === "invalid-lease-credential")
      throw new CliError(`${options.method ?? "POST"} ${path} refused a stale or superseded lease; publish nothing`, "stage-dispossessed", 2, 403);
    throw new CliError(`${options.method ?? "POST"} ${path} failed (${res.status}): ${reason}`, "stage-http", 2, res.status);
  }
  return { body, bytes, status: res.status };
}
function record(state: LeaseState, kind: "started" | "complete" | "failed", summary?: string, artifactKey?: string): object {
  return {
    host: state.node,
    event_id: `stage-${state.ticket}-${state.phase}-${state.nonce}-${kind}`,
    event_name: `phase.${state.phase}.${kind}`,
    ts: new Date().toISOString(),
    attributes: { ticket: state.ticket, phase: state.phase, nonce: state.nonce, node: state.node,
      ...(summary ? { summary } : {}),
      ...(kind === "failed" ? { failureMode: "phase_failed", ...(summary ? { failureDetail: summary } : {}),
        ...(artifactKey ? { artifactRef: artifactKey } : {}) } : artifactKey ? { artifactKey } : {}) },
  };
}
async function publishEvent(ctx: Ctx, cfg: CustomerConfig, state: LeaseState, kind: "started" | "complete" | "failed", summary?: string, artifactKey?: string): Promise<void> {
  const result = (await request(ctx, cfg, state.routes.coordination, {
    credential: state.credential, body: { records: [record(state, kind, summary, artifactKey)] },
  })).body as { accepted?: number };
  // A retry after a lost response can reach the same deterministic event ID again.
  if (result?.accepted !== 1 && result?.accepted !== 0) throw new CliError(`cloud did not accept ${kind} event`, "stage-publish");
}
async function moveCardToStage(ctx: Ctx, cfg: CustomerConfig, doc: TenantContract, state: LeaseState): Promise<void> {
  const api = apiClient(cfg, ctx);
  const issue = await resolveIssue(api, state.ticket);
  const stageId = stageIdForSlot(teamForTicket(doc, issue.identifier), slotForPhase[state.phase] ?? state.phase);
  const result = await postAgent<{ outcome?: string; reason?: string }>(api, doc, "issue-state", {
    issueId: issue.id,
    stateId: stageId,
  });
  if (result?.outcome !== "succeeded")
    throw new CliError(`card move to ${state.phase} was not confirmed: ${result?.reason ?? result?.outcome ?? "missing outcome"}`, "stage-card-move");
}
async function publishArtifact(ctx: Ctx, cfg: CustomerConfig, state: LeaseState, name: string, bytes: Buffer | string, contentType?: string): Promise<string> {
  const result = (await request(ctx, cfg, state.routes.artifact, {
    credential: state.credential, query: { ticket: state.ticket, phase: state.phase, name }, bytes, contentType,
  })).body as { key?: string; bytes?: number };
  if (!result?.key || !Number.isSafeInteger(result.bytes)) throw new CliError(`artifact ${name} publish returned no key or byte count`, "stage-publish");
  if (result.bytes !== Buffer.byteLength(bytes)) throw new CliError(`artifact ${name} publish acknowledged ${result.bytes} bytes; sent ${Buffer.byteLength(bytes)}`, "stage-publish");
  return result.key;
}
async function release(ctx: Ctx, cfg: CustomerConfig, state: LeaseState, outcome?: "setup_failed", reason?: string): Promise<void> {
  await request(ctx, cfg, state.routes.release, { credential: state.credential, body: {
    ticket: state.ticket, phase: state.phase, nonce: state.nonce, runtime: state.runtime,
    machine: state.machine, ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}),
  } });
  try { unlinkSync(statePath(ctx.home, state.ticket)); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
function checkedArtifact(path: string, expectedName: string): Buffer {
  if (basename(path) !== expectedName) throw new UsageError(`artifact must be named ${expectedName}`);
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.toString("utf8").trim() === "") throw new UsageError(`${path} is empty`);
  return bytes;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError("evidence must be a JSON object");
  return value as Record<string, unknown>;
}
function evidenceFor(phase: string, path: string, bytes: Buffer): Record<string, unknown> {
  const evidence = object(JSON.parse(readFileSync(path, "utf8")));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (evidence.artifactSha256 !== digest) throw new UsageError("evidence artifactSha256 does not match the artifact bytes");
  for (const [field, allowed] of [["scope", "plan"], ["ladder", "validate"], ["offPlan", "remediate"],
    ["conflictRouting", "remediate"], ["findingsRouting", "remediate"]] as const) {
    if (evidence[field] !== undefined && phase !== allowed) throw new UsageError(`${field} is only valid for ${allowed}`);
  }
  if (phase === "plan") {
    const scope = object(evidence.scope);
    if (!["declared", "truncated"].includes(String(scope.status)) || !Array.isArray(scope.files) || !Array.isArray(scope.packages) || !Array.isArray(scope.exclusive))
      throw new UsageError("plan needs a valid evidence.scope with status, files, packages, and exclusive");
  }
  if (phase === "validate") {
    const ladder = object(evidence.ladder);
    const expected = ["plan-conformance", "type-safety", "code-review", "security-review", "security-audit"];
    const steps = ladder.steps;
    if (ladder.version !== 1 || !Array.isArray(steps) || steps.length !== expected.length ||
      !expected.every((step, i) => object(steps[i]).step === step && object(steps[i]).verdict === "PASS"))
      throw new UsageError("validate needs five PASS ladder verdicts in the canonical order");
  }
  if (phase === "implement" && (typeof evidence.pushedHeadSha !== "string" || !/^[a-f0-9]{40}$/.test(evidence.pushedHeadSha) || typeof evidence.pullRequestUrl !== "string"))
    throw new UsageError("implement needs pushedHeadSha and pullRequestUrl evidence");
  if (phase === "merge" && (typeof evidence.mergedHeadSha !== "string" || !/^[a-f0-9]{40}$/.test(evidence.mergedHeadSha)))
    throw new UsageError("merge needs mergedHeadSha evidence");
  if (phase === "intake" || phase === "remediate") JSON.parse(bytes.toString("utf8"));
  return evidence;
}
async function start(ctx: Ctx, cfg: CustomerConfig, ticket: string, phase: string): Promise<void> {
  if (artifactNames[phase] === undefined) throw new UsageError(`stage ${phase} has no declared artifact`);
  try { readFileSync(statePath(ctx.home, ticket)); throw new UsageError(`${ticket} already has a local stage claim`); }
  catch (err) { if (err instanceof UsageError) throw err; }
  const { doc } = await loadContract(ctx, cfg, { refresh: true });
  const paths = routes(doc);
  const machine = hostname();
  const incarnation = randomUUID();
  const claimed = (await request(ctx, cfg, paths.claim, { body: { ticket, machine, incarnation, ttlMs: 3_600_000 } })).body as {
    claimed?: boolean; refusal?: string; credential?: string;
    assignment?: { ticket: string; phase: string; lease?: { holder?: string }; grant: { nonce: number; expiresAtMs: number; round?: number }; priorArtifacts?: string[] };
    runtime?: { incarnation: string; nonce: number };
  };
  if (!claimed?.claimed || !claimed.assignment || !claimed.runtime) throw new CliError(`claim refused: ${claimed?.refusal ?? "invalid answer"}`, "stage-claim");
  const a = claimed.assignment;
  if (!claimed.credential) throw new CliError(`claim granted without a lease credential; it expires at ${new Date(a.grant.expiresAtMs).toISOString()}`, "stage-claim");
  const state: LeaseState = { version: 1, account: cfg.account, baseUrl: cfg.baseUrl, ticket: a.ticket, phase: a.phase,
    nonce: a.grant.nonce, credential: claimed.credential, runtime: claimed.runtime, machine,
    node: a.lease?.holder ?? `customer-local:${machine}`, expiresAtMs: a.grant.expiresAtMs, routes: paths };
  if (a.ticket !== ticket || a.phase !== phase) {
    await release(ctx, cfg, state);
    throw new CliError(`cloud granted ${a.ticket}/${a.phase}; requested ${ticket}/${phase}; released unrun grant`, "stage-mismatch");
  }
  try {
    // Persist the lease proof before any further network I/O, so a killed CLI leaves a claim the
    // next invocation can renew or release instead of an invisible hour-long ticket lock.
    saveState(ctx.home, state);
    await publishArtifact(ctx, cfg, state, `${phase}-round.json`, JSON.stringify({ version: 1, ticket, phase,
      nonce: state.nonce, ...(a.grant.round === undefined ? {} : { round: a.grant.round }),
      atMs: ctx.now().getTime(), substrate: "local", node: state.node, incarnation }), "application/json");
    for (const ref of a.priorArtifacts ?? []) {
      const parts = ref.split("/");
      const name = parts.at(-1), nonce = Number(parts.at(-2)), priorPhase = parts.at(-3), priorTicket = parts.at(-4);
      if (!name || !priorPhase || priorTicket !== ticket || !Number.isSafeInteger(nonce)) throw new CliError(`invalid prior artifact ref ${ref}`, "stage-prior");
      const prior = await request(ctx, cfg, state.routes.object, { method: "GET", credential: state.credential,
        query: { ticket, phase: priorPhase, nonce, name } });
      if (prior.bytes.length === 0) throw new CliError(`prior artifact ${ref} is empty`, "stage-prior");
    }
    await publishEvent(ctx, cfg, state, "started");
    await moveCardToStage(ctx, cfg, doc, state);
  } catch (err) {
    if (err instanceof CliError && err.code === "stage-dispossessed") {
      try { unlinkSync(statePath(ctx.home, state.ticket)); } catch { /* stale state only */ }
      throw err;
    }
    // A start event must have a matching terminal event even when the card move fails.
    // Otherwise the board can show a permanently active seat after this claim is released.
    try { await publishEvent(ctx, cfg, state, "failed", `stage_start_failed: ${String(err)}`); }
    catch { /* release and the original error remain authoritative */ }
    try { await release(ctx, cfg, state, "setup_failed", "stage_start_failed"); }
    catch (releaseError) { throw new CliError(`stage start failed (${String(err)}); release also failed (${String(releaseError)}). Run stage renew or fail before lease expiry.`, "stage-release"); }
    throw err;
  }
  ctx.stdout(`${ticket}/${phase}: started; lease expires ${new Date(state.expiresAtMs).toISOString()}. Renew with catalyst stage renew ${ticket} ${phase} --assertion <work done>.`);
}
async function renew(ctx: Ctx, cfg: CustomerConfig, state: LeaseState, assertion: string): Promise<void> {
  let result: { renewed?: boolean; refusal?: string; grant?: { expiresAtMs?: number } };
  try { result = (await request(ctx, cfg, state.routes.renew, { credential: state.credential, body: {
    ticket: state.ticket, phase: state.phase, nonce: state.nonce, assertion, ttlMs: 3_600_000,
    runtime: state.runtime, machine: state.machine,
  } })).body as typeof result; }
  catch (err) {
    if (err instanceof CliError && err.code === "stage-dispossessed") {
      try { unlinkSync(statePath(ctx.home, state.ticket)); } catch { /* stale state only */ }
    }
    throw err;
  }
  if (result?.renewed !== true) {
    try { unlinkSync(statePath(ctx.home, state.ticket)); } catch { /* stale state only */ }
    throw new CliError(`renew refused: ${result?.refusal ?? "unknown"}; do not publish`, "stage-dispossessed");
  }
  if (typeof result.grant?.expiresAtMs === "number") { state.expiresAtMs = result.grant.expiresAtMs; saveState(ctx.home, state); }
  ctx.stdout(`${state.ticket}/${state.phase}: renewed`);
}
async function terminal(ctx: Ctx, cfg: CustomerConfig, state: LeaseState, kind: "complete" | "failed", args: ParsedArgs): Promise<void> {
  const summary = flagString(args, "summary")?.trim();
  if (kind === "failed" && !summary) throw new UsageError("stage fail needs --summary <reason>");
  // Validate local evidence before the first terminal write. A corrected file can then be retried
  // under the same lease, without inventing a failed phase or releasing a live claim.
  let completeBytes: Buffer | undefined;
  let completeEvidence: Record<string, unknown> | undefined;
  if (kind === "complete") {
    const artifactPath = flagString(args, "artifact") ?? (ctx.env.CATALYST_ARTIFACT_DIR ? join(ctx.env.CATALYST_ARTIFACT_DIR, artifactNames[state.phase]!) : undefined);
    if (!artifactPath) throw new UsageError("stage done needs --artifact <path> or CATALYST_ARTIFACT_DIR");
    const evidencePath = flagString(args, "evidence");
    if (!evidencePath) throw new UsageError("stage done needs --evidence <json> with artifactSha256");
    completeBytes = checkedArtifact(artifactPath, artifactNames[state.phase]!);
    completeEvidence = evidenceFor(state.phase, evidencePath, completeBytes);
  }
  let artifactKey: string | undefined;
  let failure: unknown;
  try {
    if (kind === "complete") {
      const evidence = completeEvidence!;
      artifactKey = await publishArtifact(ctx, cfg, state, artifactNames[state.phase]!, completeBytes!);
      const receipt = { version: 1, artifactRef: artifactKey,
        ...(evidence.scope ? { scope: evidence.scope } : {}), ...(evidence.ladder ? { ladder: evidence.ladder } : {}),
        ...(evidence.offPlan ? { offPlan: evidence.offPlan } : {}),
        ...(evidence.conflictRouting ? { conflictRouting: evidence.conflictRouting } : {}),
        ...(evidence.findingsRouting ? { findingsRouting: evidence.findingsRouting } : {}) };
      await publishArtifact(ctx, cfg, state, "relay-done.json", JSON.stringify(receipt), "application/json");
    } else {
      const artifactPath = flagString(args, "artifact");
      const diagnostic = state.phase === "intake" || state.phase === "remediate"
        ? JSON.stringify({ failed: true, summary }) : `# ${state.phase} failed\n\n${summary}\n`;
      const bytes = artifactPath ? checkedArtifact(artifactPath, artifactNames[state.phase]!) : Buffer.from(diagnostic);
      artifactKey = await publishArtifact(ctx, cfg, state, artifactNames[state.phase]!, bytes);
    }
    await publishEvent(ctx, cfg, state, kind, summary ?? (kind === "complete" ? `${state.phase} completed` : undefined), artifactKey);
  } catch (err) { failure = err; }
  if (failure instanceof CliError && failure.code === "stage-dispossessed") {
    try { unlinkSync(statePath(ctx.home, state.ticket)); } catch { /* stale state only */ }
    throw failure;
  }
  // A transport error after the receipt write is ambiguous: the cloud may already have advanced
  // the phase. Retain the lease so the operator can retry the same deterministic writes safely.
  if (failure) throw new CliError(`stage ${kind} did not finish: ${String(failure)}; lease retained, retry ${kind === "complete" ? "done" : "fail"} or renew before expiry`, "stage-publish");
  try { await release(ctx, cfg, state); }
  catch (releaseError) { throw new CliError(`stage ${kind} landed but lease release failed: ${String(releaseError)}; retry ${kind === "complete" ? "done" : "fail"}`, "stage-release"); }
  ctx.stdout(`${state.ticket}/${state.phase}: ${kind === "complete" ? "done" : "failed"}`);
}
export async function cmdStage(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [verb, ticket, phase, ...extra] = positionals(args);
  if (!verb || !ticket || !phase || extra.length || !/^[A-Z][A-Z0-9]+-\d+$/.test(ticket))
    throw new UsageError("stage takes start|renew|done|fail <ticket> <phase>");
  if (!["start", "renew", "done", "fail"].includes(verb)) throw new UsageError(`unknown stage verb ${verb}`);
  const cfg = requireConfig(ctx);
  if (cfg.principal !== "service" || !cfg.key)
    throw new CliError("stage needs a personal API key login; browser sessions cannot publish with a local-phase lease", "stage-credential");
  if (verb === "start") await start(ctx, cfg, ticket, phase);
  else {
    const state = readState(ctx, cfg, ticket, phase);
    if (verb === "renew") {
      const assertion = flagString(args, "assertion")?.trim();
      if (!assertion) throw new UsageError("stage renew needs --assertion <work done>");
      await renew(ctx, cfg, state, assertion);
    } else await terminal(ctx, cfg, state, verb === "done" ? "complete" : "failed", args);
  }
  return 0;
}
