// environment.ts — `catalyst environment`: the tenant-scope environment declaration, through
// the contract's account-environment routes. This is the ONE setup write a person's own key can
// perform: the cloud has admitted it since the routes shipped, and until this verb existed nothing
// could call it, so every setup action was a settings page.
//
// ⛔ THE ROUTE PATHS ARE DISCOVERED, NEVER ASSUMED. `read` is the route the contract's table names;
// `propose` and `approve` are derived from it the way the Worker derives them (one prefix, three
// verbs) and then CHECKED against the same table. A tenant whose cloud predates the routes gets the
// "needs a newer cloud" refusal by name rather than a 404 from a hand-copied path.
//
// ⭐ APPROVE IS A COMPARE-AND-SET on `(revision, canonicalHash)`, and with no flags this verb reads
// the current state and approves exactly what it just read. Hand-copying a hash between two commands
// is the failure that shape exists to prevent; making the caller do it anyway would reintroduce it.
import { readFileSync } from "node:fs";
import { flagBool, flagInt, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { UsageError } from "./errors.js";
import { needsNewerCloud } from "./execution.js";
import { apiClient, type ApiClient } from "./transport.js";

/** One stored revision of the declaration, as the cloud puts it on the wire. */
export interface EnvironmentState {
  revision: number;
  canonicalHash: string;
  declaration: unknown;
  proposedBy?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface EnvironmentRead {
  current: EnvironmentState | null;
  isApproved?: boolean;
  approvedBy?: string | null;
  /** The revision a phase's checkout actually carries: the latest APPROVED one, which a pending
   *  re-proposal does not replace until it is approved in its turn. */
  delivered?: { revision: number; canonicalHash: string } | null;
  unresolvedReferences?: string[];
  audit?: unknown[];
  [k: string]: unknown;
}

export interface ProposeResult {
  status?: "created" | "updated" | "unchanged";
  state?: EnvironmentState;
  error?: string;
  reason?: string;
  message?: string;
  currentRevision?: number;
  [k: string]: unknown;
}

export interface ApproveResult {
  approved?: boolean;
  state?: EnvironmentState;
  error?: string;
  message?: string;
  currentRevision?: number;
  currentHash?: string;
  [k: string]: unknown;
}

export interface EnvironmentRoutes {
  read: string;
  propose: string;
  approve: string;
}

/**
 * The three account-environment paths this tenant serves.
 *
 * ⛔ `propose` and `approve` are NOT looked up by their own last path segment. `routePath`-style
 * last-segment matching takes the FIRST route ending in that word, so the day a repo-scope
 * `.../repo-environment/propose` joins the table, a lookup for "propose" could silently return it
 * and this verb would write a repo's declaration into the account's name. Deriving both from the
 * account prefix — and then asserting each derived path is really in the table — cannot do that.
 */
export function environmentRoutes(doc: TenantContract, cfg: { baseUrl: string }): EnvironmentRoutes {
  const base = doc.routes.find(
    (r) => r.method === "GET" && r.path.split("/").filter(Boolean).at(-1) === "account-environment",
  );
  if (!base) {
    throw needsNewerCloud('the tenant environment declaration (the contract serves no "account-environment" route)', cfg);
  }
  const routes: EnvironmentRoutes = {
    read: base.path,
    propose: `${base.path}/propose`,
    approve: `${base.path}/approve`,
  };
  for (const verb of ["propose", "approve"] as const) {
    const served = doc.routes.some((r) => r.method === "POST" && r.path === routes[verb]);
    if (!served) {
      throw needsNewerCloud(`the tenant environment declaration's ${verb} route (${routes[verb]} is absent from the contract)`, cfg);
    }
  }
  return routes;
}

/** The declaration to send: a JSON file, or stdin. Never invented, and never partially parsed. */
async function readDeclaration(args: ParsedArgs, readStdin: () => Promise<string>): Promise<unknown> {
  const file = flagString(args, "file");
  const useStdin = flagBool(args, "stdin");
  if (file !== undefined && useStdin) throw new UsageError("environment propose takes --file <path> or --stdin, not both");
  if (file === undefined && !useStdin) {
    throw new UsageError("environment propose needs --file <path> or --stdin (the declaration is JSON; this verb never invents one)");
  }
  const text = file === undefined ? await readStdin() : readFileSync(file, "utf8");
  if (text.trim() === "") throw new UsageError(`the declaration ${file === undefined ? "on stdin" : `in ${file}`} is empty`);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(`the declaration ${file === undefined ? "on stdin" : `in ${file}`} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function renderRead(r: EnvironmentRead): string[] {
  const lines: string[] = [];
  if (r.current === null || r.current === undefined) {
    lines.push("no tenant environment declaration yet — nothing is delivered to a phase's checkout");
    return lines;
  }
  lines.push(`revision ${r.current.revision} (${r.current.canonicalHash})${r.current.proposedBy ? `, proposed by ${r.current.proposedBy}` : ""}`);
  lines.push(r.isApproved ? `approved${r.approvedBy ? ` by ${r.approvedBy}` : ""}` : "NOT approved — it is not delivered until someone approves it");
  lines.push(
    r.delivered
      ? `delivered to phases: revision ${r.delivered.revision} (${r.delivered.canonicalHash})`
      : "delivered to phases: nothing yet",
  );
  // A name the declaration references that no tenant secret or variable carries RIGHT NOW. A warning,
  // never a refusal: the secret may be created next, and a repo may supply the name at checkout.
  const unresolved = r.unresolvedReferences ?? [];
  if (unresolved.length > 0) {
    lines.push(`referenced but not set in this workspace yet: ${unresolved.join(", ")}. Set them with catalyst var set or catalyst secret set, or a phase that needs one will fail on it`);
  }
  return lines;
}

function renderState(state: EnvironmentState | undefined, verb: string): string[] {
  if (!state) return [`${verb}, but the cloud returned no state`];
  return [`${verb}: revision ${state.revision} (${state.canonicalHash})`];
}

export interface EnvironmentDeps {
  readStdin?: () => Promise<string>;
}

async function readState(api: ApiClient, routes: EnvironmentRoutes): Promise<EnvironmentRead> {
  const res = await api.getJson<EnvironmentRead>(routes.read);
  return res.body;
}

async function approveExact(
  api: ApiClient,
  routes: EnvironmentRoutes,
  revision: number,
  canonicalHash: string,
): Promise<{ body: ApproveResult; status: number }> {
  const res = await api.postJson<ApproveResult>(routes.approve, { revision, canonicalHash }, { accept: [404, 409] });
  return { body: res.body, status: res.status };
}

export async function cmdEnvironment(args: ParsedArgs, ctx: Ctx, deps: EnvironmentDeps = {}): Promise<number> {
  const [sub = "read", ...extra] = positionals(args);
  if (extra.length > 0) throw new UsageError(`environment takes one subcommand (got an extra "${extra[0]}")`);
  if (sub !== "read" && sub !== "propose" && sub !== "approve") {
    throw new UsageError(`unknown environment subcommand "${sub}": read | propose | approve`);
  }
  const cfg: CustomerConfig = requireConfig(ctx);
  const { doc } = await loadContract(ctx, cfg);
  const routes = environmentRoutes(doc, cfg);
  const api = apiClient(cfg, ctx);

  if (sub === "read") {
    const body = await readState(api, routes);
    if (args.json) ctx.stdout(JSON.stringify(body));
    else for (const line of renderRead(body)) ctx.stdout(line);
    return 0;
  }

  if (sub === "propose") {
    const declaration = await readDeclaration(args, deps.readStdin ?? readStdin);
    const expectedRevision = args.flags["expect-revision"] === undefined ? undefined : flagInt(args, "expect-revision", 0);
    const res = await api.postJson<ProposeResult>(
      routes.propose,
      { declaration, ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
      { accept: [400, 404, 409] },
    );
    const body = res.body;
    // A refusal is the cloud's own sentence, printed verbatim and exited 1 — never retried, and never
    // smoothed into a success. `conflict` means someone else moved the declaration; re-read and redo.
    if (res.status === 409 || res.status === 400 || res.status === 404) {
      if (args.json) ctx.stdout(JSON.stringify(body));
      else {
        ctx.stdout(`refused (${res.status}): ${body.message ?? body.error ?? "no reason given"}`);
        if (body.reason) ctx.stdout(`  reason: ${body.reason}`);
        if (body.currentRevision !== undefined) {
          ctx.stdout(`  the declaration is now at revision ${body.currentRevision} — run \`catalyst environment read\` and propose again from that`);
        }
      }
      return 1;
    }
    const approveToo = flagBool(args, "approve");
    if (!args.json) for (const line of renderState(body.state, body.status === "unchanged" ? "unchanged" : `${body.status ?? "proposed"}`)) ctx.stdout(line);
    if (!approveToo) {
      if (args.json) ctx.stdout(JSON.stringify(body));
      else if (body.status !== "unchanged") ctx.stdout("not delivered until it is approved: catalyst environment approve");
      return 0;
    }
    // ⭐ Approve exactly what propose just returned. The whole point of the CAS is that the approver
    // saw the revision they are approving, and nothing here has to be copied by a human or a model.
    const state = body.state;
    if (!state) {
      ctx.stderr("the cloud returned no state to approve — run: catalyst environment read");
      return 1;
    }
    const approved = await approveExact(api, routes, state.revision, state.canonicalHash);
    if (args.json) {
      ctx.stdout(JSON.stringify({ propose: body, approve: approved.body }));
      return approved.status === 200 ? 0 : 1;
    }
    return renderApprove(ctx, approved);
  }

  // approve — with no flags, read the current state and approve exactly that.
  const revisionFlag = args.flags.revision === undefined ? undefined : flagInt(args, "revision", 0);
  const hashFlag = flagString(args, "hash");
  if ((revisionFlag === undefined) !== (hashFlag === undefined)) {
    throw new UsageError("environment approve takes --revision and --hash together, or neither (it reads the current one)");
  }
  let revision = revisionFlag;
  let hash = hashFlag;
  if (revision === undefined || hash === undefined) {
    const current = (await readState(api, routes)).current;
    if (current === null || current === undefined) {
      ctx.stdout("there is no declaration to approve — propose one first: catalyst environment propose --file <path>");
      return 1;
    }
    revision = current.revision;
    hash = current.canonicalHash;
  }
  const approved = await approveExact(api, routes, revision, hash);
  if (args.json) {
    ctx.stdout(JSON.stringify(approved.body));
    return approved.status === 200 ? 0 : 1;
  }
  return renderApprove(ctx, approved);
}

function renderApprove(ctx: Ctx, approved: { body: ApproveResult; status: number }): number {
  const { body, status } = approved;
  if (status === 200 && body.approved) {
    for (const line of renderState(body.state, "approved")) ctx.stdout(line);
    ctx.stdout("it is now what a phase's checkout carries");
    return 0;
  }
  ctx.stdout(`refused (${status}): ${body.message ?? body.error ?? "no reason given"}`);
  if (body.currentRevision !== undefined) {
    ctx.stdout(`  it is now at revision ${body.currentRevision}${body.currentHash ? ` (${body.currentHash})` : ""} — read it again before approving`);
  }
  return 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
