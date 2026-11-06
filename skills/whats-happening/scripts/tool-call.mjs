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
// The roles an explanation can name, longest first. Splitting a sentence on ROLE_MENTION keeps the article and the
// role as captures: [before, article, role, between, article, role, ..., after].
const ROLE = "workspace owner or admin|workspace owner|workspace admin|account admin|owner or admin|admin|owner|operator";
const ROLE_MENTION = new RegExp(`\\b(?:(an?|the|your)\\s+)?(${ROLE})\\b`, "i");
const KINDS = ["owner", "admin", "operator"];
// A role is named when the sentence says it can act (the text after it) or says to turn to it (the text before it).
const CAN = /^\s+(?:can|could|should|must|may|will|needs?\s+to|has\s+to|have\s+to|is\s+able\s+to)\b/i;
const TURN_TO = /\b(?:ask|contact|tell|have|notify|message)\s+$/i;
// A negation or a restriction anywhere in the sentence takes the role out. "Only an owner can ..." restricts
// to the owner, so an "only" that directly governs a role does not count.
const NEGATED = new RegExp(
  `\\b(?:not|no|none|nobody|never|cannot|unable|unless|without|except|instead|neither|nor)\\b|n['\\u2019]t\\b|\\bonly\\b(?!\\s+(?:(?:an?|the|your)\\s+)?(?:${ROLE})\\b)`,
  "i",
);
// With no explanation at all the record names no one, and the one fact we hold is who manages MCP servers
// (src/capabilities.ts: `mcp add|list|remove` needs an admin). With an explanation that names no role the
// explanation may itself say the admin cannot help, so the line adds no pointer.
const NO_ONE =
  "the record names no one; a workspace owner or admin manages this workspace's MCP servers";
const NOT_NAMED = "the explanation does not name one";

const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const text = (v) => (typeof v === "string" && oneLine(v) ? oneLine(v) : null);
/** A plain object: the only shape a recorded call, or its dispatch, can have. */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** A string that says something, without the spaces around it (" ok " is ok); any other type, and a blank string, is absent. */
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const normaliseServer = (raw) =>
  raw.trim().toLowerCase().replace(/[\s.]+/g, "-").replace(/[^a-z0-9_-]/g, "");

/**
 * The first role the explanation affirms can fix the failure, with its article ("a workspace admin"), or null.
 * A sentence that holds a negation or a restriction names no role, and a role mentioned in any such sentence
 * is never named, whatever other sentences say about it.
 */
function actorIn(explanation) {
  if (!explanation) return null;
  const barred = new Set();
  const stated = [];
  for (const sentence of explanation.split(/[.!?;]+/)) {
    const negated = NEGATED.test(sentence);
    const parts = sentence.split(ROLE_MENTION);
    for (let i = 2; i < parts.length; i += 3) {
      const role = parts[i].toLowerCase();
      const kinds = KINDS.filter((k) => role.includes(k));
      if (negated) for (const k of kinds) barred.add(k);
      else if (CAN.test(parts[i + 1]) || TURN_TO.test(parts[i - 2]))
        stated.push({ kinds, who: `${parts[i - 1]?.toLowerCase() ?? (/^[aeiou]/.test(role) ? "an" : "a")} ${role}` });
    }
  }
  return stated.find((r) => !r.kinds.some((k) => barred.has(k)))?.who ?? null;
}

// Only a numeric timestamp counts, as in the verb: new Date(null) is the epoch, and the line must not print it.
const when = (at) => (typeof at === "number" && Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null);

/**
 * One element of `calls` as the script reads it, or null when it is not a usable recorded call. The verb checks
 * that `calls` is an array and nothing about its elements, so each field is read by type. A usable call is a
 * plain object whose tool_name and outcome are non-empty strings; without them the line cannot name the tool or
 * say whether the call failed. Every other field of the wrong type is absent. No value reaches String(), a
 * template or a string method unless it is already a string.
 */
function readCall(c) {
  if (!isRecord(c)) return null;
  const tool = str(c.tool_name);
  const outcome = str(c.outcome);
  if (!tool || !outcome) return null;
  const dispatch = isRecord(c.dispatch) ? c.dispatch : {};
  return {
    tool,
    outcome,
    ticket: str(dispatch.ticket),
    phase: str(dispatch.phase),
    denied: text(c.denied_reason),
    explanation: text(c.explanation),
    at: when(c.at),
  };
}

/** The answer for one read: the fields of the call it rests on, a verdict, and the reason as the verb prints it. */
function answer(server, ticket, tool, calls) {
  const base = { server, ticket: ticket ?? null, phase: null, tool: null, outcome: null, reason: null, explanation: null, at: null };
  const readable = calls.map(readCall).filter((c) => c !== null);
  const window = { read: calls.length, limit: LIMIT, unreadable: calls.length - readable.length };
  const kept = readable.filter(
      (c) =>
        (!ticket || (c.ticket ?? "").toLowerCase() === ticket.toLowerCase()) &&
        (!tool || c.tool.toLowerCase().includes(tool.toLowerCase())),
    );
  const failed = kept.find((c) => c.outcome !== "ok");
  const call = failed ?? kept[0];
  if (!call) return { a: { ...base, fixer: { named: false, who: null }, window, verdict: "not-in-window" } };
  const who = failed ? actorIn(call.explanation) : null;
  const a = {
    ...base,
    ticket: call.ticket,
    phase: call.phase,
    tool: call.tool,
    outcome: call.outcome,
    reason: failed ? (call.denied ?? text(call.outcome)) : null,
    explanation: failed ? call.explanation : null,
    at: call.at,
    fixer: { named: who !== null, who },
    window,
    verdict: failed ? "failed" : "no-failure",
  };
  return { a, why: [call.denied, call.explanation].filter(Boolean).join(": ") };
}

/** The one line the desk replies with. Records the script could not read are counted, and no sentence speaks for them. */
function render({ a, why }, ticket, tool) {
  const { read, unreadable } = a.window;
  const calls = (n, adjective = "") => `${n} ${adjective}recorded call${n === 1 ? "" : "s"}`;
  const matching = tool ? ` matching ${tool}` : "";
  if (a.verdict === "not-in-window") {
    const none = unreadable ? "no readable call" : "no call";
    const subject = ticket ? `${ticket} has ${none} to ${a.server}` : `there is ${none} to ${a.server}`;
    const cannot = unreadable ? `, and ${calls(unreadable)} could not be read, so the record cannot say why` : ", so the record cannot say why";
    return `${subject}${matching} among the newest ${LIMIT} this workspace recorded${cannot}; this read sees no further back.`;
  }
  if (a.verdict === "no-failure") {
    const seen = unreadable ? `the ${read - unreadable} readable of its newest ${calls(read)}` : `its newest ${calls(read)}`;
    const newest = ticket || tool ? "the newest one that matches" : unreadable ? "the newest readable one" : "the newest";
    const rest = unreadable ? `; ${calls(unreadable)} could not be read, so this may not be the whole picture` : "";
    return `no failed call to ${a.server}${ticket ? ` on ${ticket}` : ""}${matching} in ${seen}; ${newest} was ok at ${a.at ?? "an unrecorded time"}${rest}.`;
  }
  const slot = a.ticket ? `${a.ticket} ${a.phase ?? ""}`.trim() : "no ticket";
  const who = a.fixer.who ?? (a.explanation ? NOT_NAMED : NO_ONE);
  const skipped = unreadable ? ` ${calls(unreadable, "other ")} could not be read, so this may not be the newest failure.` : "";
  return `${slot}: ${a.tool} on ${a.server} failed (${a.outcome}) — ${sentence(why || "the record gives no reason")} Who can fix it: ${who}.${skipped}`;
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
process.stdout.write(`${flags.json ? JSON.stringify(result.a) : oneLine(render(result, flags.ticket, flags.tool))}\n`);
process.exit(0);
