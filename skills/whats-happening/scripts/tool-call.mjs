#!/usr/bin/env node
// tool-call.mjs — "why did that tool call fail?" in one line. A thin wrapper over
// `catalyst mcp status <server> --json`, which reads the portal's record of the server's newest
// tool calls. The script picks the newest failed call that matches --ticket / --tool and prints
// the ticket, the tool, the reason as the cloud wrote it, and who can fix it.
import { parseFlags, parseJson, printHelp, runCli } from "./lib/cli.mjs";

const SPEC = {
  ticket: { value: true, help: "keep calls dispatched for this ticket (the KEY-123 shape)" },
  tool: { value: true, help: "keep calls to this tool (its name, or part of it)" },
  json: { value: false, help: "print the answer's fields and a verdict as JSON instead of the line" },
};
const LIMIT = 50; // the verb reads the newest 50 calls, no further back
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ACTOR =
  /\b(?:(an?|the|your)\s+)?(workspace owner or admin|workspace owner|workspace admin|account admin|admin|owner|operator)\b/i;
const NO_ONE =
  "the record names no one; a workspace owner or admin manages this workspace's MCP servers";

const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const text = (v) => (typeof v === "string" && oneLine(v) ? oneLine(v) : null);
/** An element of `calls` the verb passed through unchecked: only a plain object can be a recorded call. */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const normaliseServer = (raw) =>
  raw.trim().toLowerCase().replace(/[\s.]+/g, "-").replace(/[^a-z0-9_-]/g, "");

/** The first actor the explanation names, with its article ("a workspace admin"), or null. */
function actorIn(explanation) {
  const m = (explanation ?? "").match(ACTOR);
  if (!m) return null;
  const actor = m[2].toLowerCase();
  return `${m[1]?.toLowerCase() ?? (/^[aeiou]/.test(actor) ? "an" : "a")} ${actor}`;
}

// Only a numeric timestamp counts, as in the verb: new Date(null) is the epoch, and the line must not print it.
const when = (at) => (typeof at === "number" && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null);

/** The answer for one read: the fields of the call it rests on, a verdict, and the reason as the verb prints it. */
function answer(server, ticket, tool, calls) {
  const base = { server, ticket: ticket ?? null, phase: null, tool: null, outcome: null, reason: null, explanation: null, at: null };
  const window = { read: calls.length, limit: LIMIT };
  const kept = calls.filter(
    (c) =>
      isRecord(c) &&
      (!ticket || String(c.dispatch?.ticket ?? "").toLowerCase() === ticket.toLowerCase()) &&
      (!tool || String(c.tool_name ?? "").toLowerCase().includes(tool.toLowerCase())),
  );
  const failed = kept.find((c) => c.outcome !== "ok");
  const call = failed ?? kept[0];
  if (!call) return { a: { ...base, fixer: { named: false, who: null }, window, verdict: "not-in-window" } };
  const explanation = text(call.explanation);
  const who = failed ? actorIn(explanation) : null;
  const a = {
    ...base,
    ticket: call.dispatch?.ticket ?? null,
    phase: call.dispatch?.phase ?? null,
    tool: call.tool_name ?? null,
    outcome: call.outcome ?? null,
    reason: failed ? (text(call.denied_reason) ?? text(call.outcome)) : null,
    explanation: failed ? explanation : null,
    at: when(call.at),
    fixer: { named: who !== null, who },
    window,
    verdict: failed ? "failed" : "no-failure",
  };
  return { a, why: [text(call.denied_reason), explanation].filter(Boolean).join(": ") };
}

/** The one line the desk replies with. */
function render({ a, why }, ticket, tool, n) {
  const matching = tool ? ` matching ${tool}` : "";
  if (a.verdict === "not-in-window") {
    const subject = ticket ? `${ticket} has no call to ${a.server}` : `there is no call to ${a.server}`;
    return `${subject}${matching} among the newest ${LIMIT} this workspace recorded, so the record cannot say why; this read sees no further back.`;
  }
  if (a.verdict === "no-failure") {
    return `no failed call to ${a.server}${ticket ? ` on ${ticket}` : ""}${matching} in its newest ${n} recorded call${n === 1 ? "" : "s"}; the newest was ok at ${a.at ?? "an unrecorded time"}.`;
  }
  const slot = a.ticket ? `${a.ticket} ${a.phase ?? ""}`.trim() : "no ticket";
  return `${slot}: ${a.tool} on ${a.server} failed (${a.outcome}) — ${sentence(why || "the record gives no reason")} Who can fix it: ${a.fixer.who ?? NO_ONE}.`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { help, flags, positionals } = parseFlags(process.argv.slice(2), SPEC);
if (help || positionals.length === 0) {
  printHelp("node scripts/tool-call.mjs <server> [--ticket KEY-123] [--tool <name>] [--json] [--help]", SPEC, [
    "The server is the name the person used, lowercased (WorkOS becomes workos). The script reads the server's newest",
    `${LIMIT} recorded calls through \`catalyst mcp status <server> --json\` and prints one line: the ticket, the tool, the`,
    "reason as the cloud wrote it, and who can fix it. --ticket and --tool narrow within those calls; a call outside",
    "them cannot be explained, and the line says so. Exit 0 means the record was read, whatever it says.",
  ]);
  process.exit(help ? 0 : 1);
}

const server = normaliseServer(positionals[0]);
if (!SERVER_NAME.test(server)) fail(`"${positionals[0]}" is not a server name (lowercase letters, digits, - and _, starting with a letter)`);

const r = runCli(["mcp", "status", server, "--json"]);
if (r.code === 3) {
  fail(
    `could not read MCP server ${server}: either this workspace registered it under another name or this Catalyst Cloud does not serve tool-call records yet. A workspace owner or admin can list the names with \`catalyst mcp list\`.`,
  );
}
if (r.code !== 0) fail(`could not read MCP server ${server}: ${r.stderr.split("\n").map(oneLine).find(Boolean) ?? `exit code ${r.code}`}`);

const calls = parseJson(r.stdout, "the MCP status")?.calls?.calls;
if (!Array.isArray(calls)) fail(`could not read MCP server ${server}: the status came back in a shape this script does not know`);

const result = answer(server, flags.ticket, flags.tool, calls);
// The line is collapsed whole, so no value in it (a flag, a recorded ticket, phase, tool or outcome) can break it in two.
process.stdout.write(`${flags.json ? JSON.stringify(result.a) : oneLine(render(result, flags.ticket, flags.tool, calls.length))}\n`);
process.exit(0);
