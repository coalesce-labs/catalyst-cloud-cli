// `messages read`: the bodies behind comms.message.posted events, on the person's own login (CTC-6650).
import type { MessagesReadResult, TenantClient, TenantClientOptions } from "@catalyst-cloud/sdk";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import { loadHttpSdk } from "./sdk.js";
export interface MessagesDeps {
  createClient?: (options: TenantClientOptions) => Promise<Pick<TenantClient, "messages">> | Pick<TenantClient, "messages">;
}
function failure(result: Exclude<MessagesReadResult, { outcome: "ok" }>): string {
  const reason = "reason" in result && typeof result.reason === "string" ? `: ${result.reason}` : "";
  return `messages: ${result.outcome}${"status" in result && result.status ? ` (${result.status})` : ""}${reason}`;
}
export async function cmdMessages(args: ParsedArgs, ctx: Ctx, deps: MessagesDeps = {}): Promise<number> {
  const [action, ...extra] = positionals(args);
  if (action !== "read" || extra.length) throw new UsageError("messages takes: read --ticket CTC-N [--since SEQUENCE]");
  const ticket = flagString(args, "ticket")?.trim().toUpperCase();
  if (!ticket) throw new UsageError("messages read needs --ticket CTC-N");
  const rawSince = flagString(args, "since");
  const since = rawSince === undefined ? undefined : Number(rawSince);
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
    throw new UsageError("--since must be a non-negative message sequence");
  const cfg = requireConfig(ctx);
  const createClient = deps.createClient ?? (async (options: TenantClientOptions) => (await loadHttpSdk()).createTenantClient(options));
  const client = await createClient({ key: await bearerFor(ctx, cfg), baseUrl: cfg.baseUrl, fetch: ctx.fetch });
  if (!client.messages) throw new CliError("the installed SDK cannot read messages; upgrade the catalyst CLI", "sdk-upgrade-required");
  const result = await client.messages.read({ ticket, ...(since === undefined ? {} : { since }) });
  if (result.outcome !== "ok") {
    if (args.json) ctx.stdout(JSON.stringify(result));
    else ctx.stderr(failure(result));
    return 1;
  }
  if (args.json) ctx.stdout(JSON.stringify({ ticket: result.ticket, messages: result.messages, next: result.next }));
  else if (result.messages.length === 0) ctx.stdout(`${result.ticket}: no messages${since === undefined ? "" : ` at or after ${since}`}`);
  else
    for (const message of result.messages) {
      ctx.stdout(`#${message.seq} ${message.sentAt} ${message.from.label} (${message.kind})`);
      for (const line of message.body.split("\n")) ctx.stdout(`  ${line}`);
    }
  if (result.next !== null) ctx.stderr(`more: re-run with --since ${result.next}`);
  return 0;
}
