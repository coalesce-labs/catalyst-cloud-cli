// CTC-6103: portal status and calls live outside the SDK's agent registration routes.
// Discover the path from the contract and pin its origin before sending the login's bearer.
import type { ParsedArgs } from "./args.js";
import { normalizeBaseUrl, requireConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { CliError, MeError } from "./errors.js";
import { needsNewerCloud } from "./execution.js";
import { bearerFor } from "./oauth.js";
import { ApiClient } from "./transport.js";

export const CALLS_WINDOW = 50;
export interface PortalServerStatus {
  server: string;
  state: string;
  detail?: string;
  credentials?: string[];
  checked_at?: number;
  tools?: { offered: number; catalog: number; missing_upstream?: string[] };
  auth?: string;
  grants?: { key_id?: string; granted: number; cataloged: number; missing?: string[] };
  [key: string]: unknown;
}
export interface PortalToolCall {
  tool_name: string;
  outcome: string;
  denied_reason: string | null;
  latency_ms: number | null;
  at: number;
  dispatch: { ticket: string; phase: string; generation?: number } | null;
  explanation: string | null;
  [key: string]: unknown;
}
export interface PortalServerCalls {
  server: string;
  calls: PortalToolCall[];
  [key: string]: unknown;
}

function portalBase(doc: TenantContract, cfg: CustomerConfig): { origin: string; path: string } {
  const raw = doc.portal?.url;
  if (!raw) {
    throw new CliError(
      `mcp status needs a newer Catalyst Cloud than ${normalizeBaseUrl(cfg.baseUrl)} is running: its contract names no MCP portal (portal.url). Nothing is wrong with your workspace.`,
      "route-not-deployed", 3,
    );
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CliError(`the contract's portal.url is not a URL: ${raw}`, "contract-shape"); }
  const loginOrigin = new URL(normalizeBaseUrl(cfg.baseUrl)).origin;
  if (url.origin !== loginOrigin) {
    throw new CliError(
      `the contract's portal.url (${url.origin}) is not on the cloud you logged in to (${loginOrigin}); not sending your key there`,
      "portal-origin",
    );
  }
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
}

async function portalGet(api: ApiClient, path: string, what: string, cfg: CustomerConfig, query?: Record<string, number>): Promise<unknown> {
  const res = await api.getJson(path, { query, accept: [403, 404], parseAccepted: true });
  if (res.status === 404) throw needsNewerCloud(what, cfg);
  if (res.status === 403) {
    const body = res.body;
    const reason = typeof body === "object" && body !== null
      ? ("reason" in body && typeof body.reason === "string" ? body.reason
        : "error" in body && typeof body.error === "string" ? body.error : "forbidden")
      : "forbidden";
    throw new CliError(
      `GET ${path} failed (403): the MCP portal refused this key (${reason}). It admits an active member's personal key, or an account key scoped portal:access.`,
      "forbidden", 2, 403,
    );
  }
  return res.body;
}

function isStatus(body: unknown): body is PortalServerStatus {
  return typeof body === "object" && body !== null && "server" in body && typeof body.server === "string"
    && "state" in body && typeof body.state === "string";
}

function isCalls(body: unknown): body is PortalServerCalls {
  return typeof body === "object" && body !== null && "server" in body && typeof body.server === "string"
    && "calls" in body && Array.isArray(body.calls);
}

/** Numeric display fields are checked at runtime because older or malformed responses may omit them. */
export function renderServerStatus(
  status: PortalServerStatus,
  calls: readonly (Pick<PortalToolCall, "tool_name" | "outcome" | "denied_reason" | "dispatch" | "explanation"> & { at: unknown; latency_ms: unknown })[],
): string[] {
  const lines = [`${status.server} — ${status.state}`];
  if (status.detail) lines.push(`  ${status.detail}`);
  lines.push(`auth: ${status.auth ?? "not reported (no registration)"}`);
  if (status.credentials?.length) lines.push(`credentials: ${status.credentials.join(", ")}`);
  const tools = status.tools;
  lines.push(tools
    ? `tools: ${tools.offered} offered, ${tools.catalog} in catalog${tools.missing_upstream?.length ? ` (missing upstream: ${tools.missing_upstream.join(", ")})` : ""}`
    : `tools: not reported (${status.state})`);
  const grants = status.grants;
  lines.push(grants
    ? `grants for this key: ${grants.granted} of ${grants.cataloged}${grants.missing?.length ? ` (missing: ${grants.missing.join(", ")})` : ""}`
    : "grants for this key: not reported (no registration)");
  if (calls.length === 0) return [...lines, `No tool calls recorded for ${status.server}.`];
  lines.push(`last ${calls.length} call${calls.length === 1 ? "" : "s"} (newest first, up to ${CALLS_WINDOW}):`);
  const rows = calls.map((call) => {
    const date = new Date(typeof call.at === "number" ? call.at : NaN);
    return [
      Number.isFinite(date.getTime()) ? date.toISOString() : "?",
      call.outcome,
      call.tool_name,
      `${typeof call.latency_ms === "number" && Number.isFinite(call.latency_ms) ? call.latency_ms : "?"}ms`,
      call.dispatch ? `${call.dispatch.ticket} ${call.dispatch.phase}` : "-",
      call.outcome === "ok" ? "" : [call.denied_reason, call.explanation].filter((part) => typeof part === "string" && part.length > 0).join(": "),
    ];
  });
  const widths = Array.from({ length: 5 }, (_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  for (const row of rows) {
    lines.push(`  ${row.map((value, column) => column === 3 ? value.padStart(widths[column] ?? 0) : value.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd());
  }
  return lines;
}

export async function cmdMcpStatus(args: ParsedArgs, ctx: Ctx, name: string): Promise<number> {
  const cfg = requireConfig(ctx);
  let loaded = await loadContract(ctx, cfg);
  // A fresh cache may predate portal discovery. Revalidate once before refusing it.
  if (loaded.source === "cache" && !loaded.doc.portal?.url) loaded = await loadContract(ctx, cfg, { refresh: true });
  const base = portalBase(loaded.doc, cfg);
  const api = new ApiClient(base.origin, () => bearerFor(ctx, cfg), ctx.fetch);
  const server = `${base.path}/servers/${encodeURIComponent(name)}`;
  const [status, calls] = await Promise.all([
    portalGet(api, `${server}/status`, `MCP server status for ${name}`, cfg),
    portalGet(api, `${server}/calls`, `recent tool calls for ${name}`, cfg, { limit: CALLS_WINDOW }),
  ]);
  if (!isStatus(status)) throw new MeError(`GET ${server}/status returned an unexpected shape`, "shape");
  if (!isCalls(calls)) throw new MeError(`GET ${server}/calls returned an unexpected shape`, "shape");
  if (args.json) ctx.stdout(JSON.stringify({ status, calls }));
  else for (const line of renderServerStatus(status, calls.calls)) ctx.stdout(line);
  return 0;
}
