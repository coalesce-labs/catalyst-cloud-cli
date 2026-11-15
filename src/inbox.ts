import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

/** Checking never acknowledges. The caller names the session and consumed message explicitly. */
export async function cmdInbox(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [verb, ...extra] = positionals(args);
  if (extra.length || !["check", "send", "ack"].includes(verb ?? "")) throw new UsageError("inbox takes check, send or ack");
  const ticket = flagString(args, "ticket")?.trim().toUpperCase();
  if (!ticket || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(ticket)) throw new UsageError("inbox needs --ticket CTC-N");
  const session = flagString(args, "session");
  let body: Record<string, unknown>;
  if (verb === "send") {
    const text = flagString(args, "body");
    const kind = flagString(args, "kind") ?? "note";
    if (!text?.trim() || !["note", "question", "answer"].includes(kind)) throw new UsageError("inbox send needs --body and --kind note|question|answer");
    const re = flagString(args, "re");
    body = {ticket, body: text, kind, ...(session ? {to: {session}} : {}), ...(re ? {re} : {})};
  } else {
    const agent = flagString(args, "agent");
    if (!agent || !/^[a-z0-9-]{1,40}$/.test(agent)) throw new UsageError("inbox check and ack need --agent matching your ticket lease");
    body = {ticket, agent, ...(session ? {session} : {})};
    if (verb === "ack") {
      const messageId = flagString(args, "message");
      const turn = Number(flagString(args, "turn"));
      if (!session || !messageId || !Number.isSafeInteger(turn) || turn < 1) throw new UsageError("inbox ack needs --session, --message and a positive --turn");
      body.delivered = [{messageId, turn}];
    }
  }
  const client = apiClient(requireConfig(ctx), ctx);
  const res = await client.postJson<Record<string, unknown>>(verb === "send" ? "/api/v1/agent/messages" : `/api/v1/agent/inbox/${verb}`, body, {accept: [400, 401, 403, 404, 409, 429, 502]});
  if (args.json) ctx.stdout(JSON.stringify(res.body));
  const success = res.status >= 200 && res.status < 300 && res.body.outcome !== "refused";
  if (!success) {
    if (!args.json) ctx.stderr(`inbox: ${String(res.body.reason ?? res.body.refusal ?? res.body.error ?? res.status)}`);
    return 1;
  }
  if (args.json) return 0;
  if (verb === "send") ctx.stdout(`${String(res.body.messageId)}: ${String(res.body.delivery)}${res.body.reason ? ` (${String(res.body.reason)})` : ""}`);
  else if (verb === "check") {
    ctx.stdout(`session: ${String(res.body.session)}`);
    for (const message of res.body.messages as Array<{id: string; body: string; from: {label: string}}>) ctx.stdout(`${message.id} ${message.from.label}: ${message.body}`);
  } else ctx.stdout(`acknowledged: ${(res.body.delivered as string[]).join(", ") || "none"}; ignored: ${(res.body.ignored as string[]).join(", ") || "none"}`);
  return 0;
}
