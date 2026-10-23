// Tenant MCP registration. Credentials remain vault references; the server owns admission.
import type { PortalServer, PortalServerAuth, PortalServerRegisterInput } from "@catalyst-cloud/sdk";
import { flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { cmdMcpStatus } from "./mcp-status.js";
import { bearerFor } from "./oauth.js";
import { loadTenantSdk } from "./sdk.js";

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(["host", "connection", "transfer-encoding", "content-length"]);

function secretName(value: string): string {
  if (!SECRET_NAME.test(value)) throw new UsageError("auth needs a vault secret NAME (A-Z, 0-9 and _, starting with a letter), never its value");
  return value;
}

function parseAuth(args: ParsedArgs): PortalServerAuth {
  const bearer = flagString(args, "bearer");
  const headers = flagList(args, "header");
  const auth = flagString(args, "auth");
  if (Number(bearer !== undefined) + Number(headers.length > 0) + Number(auth !== undefined) !== 1) {
    throw new UsageError("choose exactly one of --auth none, --bearer SECRET_NAME, or --header NAME=SECRET_NAME");
  }
  if (auth !== undefined) {
    if (auth !== "none") throw new UsageError("--auth accepts only none");
    return { kind: "none" };
  }
  if (bearer !== undefined) return { kind: "bearer", secretName: secretName(bearer) };
  const seen = new Set<string>();
  return { kind: "headers", headers: headers.map((entry) => {
    const equal = entry.indexOf("=");
    if (equal < 1) throw new UsageError("--header needs HEADER_NAME=VAULT_SECRET_NAME");
    const name = entry.slice(0, equal);
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-")) {
      throw new UsageError("--header contains an invalid or forbidden routing/framing header");
    }
    if (seen.has(lower)) throw new UsageError("--header names must be unique, ignoring case");
    seen.add(lower);
    return { name, secretName: secretName(entry.slice(equal + 1)) };
  }) };
}

function registration(args: ParsedArgs, name: string): PortalServerRegisterInput {
  const raw = flagString(args, "url");
  let url: URL;
  try { url = new URL(raw ?? ""); }
  catch { throw new UsageError("mcp add needs --url with an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || raw?.includes("?") || raw?.includes("#") || (url.port && url.port !== "443")) {
    throw new UsageError("MCP URLs require HTTPS on port 443, without userinfo, query strings or fragments");
  }
  // The cloud validates public DNS, catalog identity and admin approval. Never contact this URL here.
  return { name, url: url.href, auth: parseAuth(args) };
}

function describeServer(server: PortalServer): string {
  const state = server.status === "pending" ? "waiting for admin approval"
    : server.status === "pending_egress_guard" ? "waiting for public egress guard" : "ready";
  const auth = server.auth.kind === "none" ? "none" : server.auth.kind === "bearer"
    ? `bearer: ${server.auth.secretName}`
    : server.auth.headers.map((header) => `${header.name}: ${header.secretName}`).join(", ");
  return `${server.name} (${server.id}): ${state}\n  ${server.url}\n  auth: ${auth}`;
}

export async function cmdMcp(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [verb, ...rest] = positionals(args);
  if (verb !== "add" && verb !== "list" && verb !== "remove" && verb !== "status") throw new UsageError("mcp needs add, list, remove or status");
  if (rest.length !== (verb === "list" ? 0 : 1)) throw new UsageError(`mcp ${verb}${verb === "list" ? "" : " <name>"}`);
  const name = rest[0] ?? "";
  if (verb !== "list" && !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new UsageError("server name must start with a lowercase letter and contain only lowercase letters, digits, _ or - (up to 64 characters)");
  if (verb !== "add" && ["url", "auth", "bearer", "header"].some((key) => key in args.flags)) {
    throw new UsageError("URL and auth options are only accepted by mcp add");
  }
  if (verb === "status") return await cmdMcpStatus(args, ctx, name);
  const input = verb === "add" ? registration(args, name) : null;
  const cfg = requireConfig(ctx);
  const key = await bearerFor(ctx, cfg);
  const sdk = await loadTenantSdk();
  const client = sdk.createTenantClient({ key, baseUrl: cfg.baseUrl, fetch: ctx.fetch, now: () => ctx.now().getTime() });
  const result = input !== null ? await client.agent.portalServerRegister(input)
    : verb === "list" ? await client.agent.portalServers()
    : await client.agent.portalServerRemove({ name });
  if (result.outcome !== "registered" && result.outcome !== "ok" && result.outcome !== "removed") {
    const reason = result.outcome === "route-unknown" ? `cloud does not advertise ${result.route}`
      : "reason" in result ? result.reason : result.outcome;
    throw new CliError(String(reason), result.outcome);
  }
  if (args.json) ctx.stdout(JSON.stringify(result));
  else if (result.outcome === "registered") ctx.stdout(describeServer(result.server));
  else if (result.outcome === "ok") ctx.stdout(result.servers.length === 0 ? "No portal servers registered." : result.servers.map(describeServer).join("\n"));
  else ctx.stdout(result.removed ? `Removed ${name}.` : `${name} was not registered.`);
  return 0;
}
