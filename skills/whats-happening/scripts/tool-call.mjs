#!/usr/bin/env node
// tool-call.mjs — "why did that tool call fail?" in one line. A thin wrapper over
// `catalyst mcp status <server> --json`, which reads the portal's record of the server's newest
// tool calls. The script picks the newest failed call that matches --ticket / --tool and prints
// the ticket, the tool, the reason as the cloud wrote it, and who can fix it.
import { CONNECT_COMMAND } from "./lib/credential.mjs";
import { parseFlags, printHelp, runCli } from "./lib/cli.mjs";

const SPEC = {
  ticket: { value: true, help: "keep calls dispatched for this ticket (the KEY-123 shape)" },
  tool: { value: true, help: "keep calls to this tool (its name, or part of it)" },
  json: { value: false, help: "print the answer's fields and a verdict as JSON instead of the line" },
};
const LIMIT = 50; // the verb reads the newest 50 calls, no further back
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
// Nothing the CLI wrote reaches a refusal: its words can hold a banned word, a route, an address or an instruction the
// skill must not give. Each refusal is a fixed sentence that names the validated server and the CLI's exit code only.
const NOT_CONNECTED = `not connected (this machine is not joined to a workspace) — run: ${CONNECT_COMMAND}`;

// Who can fix a failure is not decided here. The explanation is free prose, and no rule over it is sound: negations,
// restrictions, a second actor, "can retry" against "can fix" each beat the rule written for the last one. The line shows
// the explanation as the cloud wrote it and says only what is true by construction: which listed roles the explanation
// mentions, that it mentions none, or that there is no explanation.
// Splitting on ROLE_MENTION keeps the article and the role as captures: [before, article, role, between, ..., after].
const ROLE = "workspace owner or admin|workspace owner|workspace admin|account admin|owner or admin|admin|owner|operator";
const ROLE_MENTION = new RegExp(`\\b(?:(an?|the|your)\\s+)?(${ROLE})\\b`, "i");
// With no explanation at all, the one thing true by construction is that the record has none, so it names no one.
const NO_ONE = "the record has no explanation, so it names no one";
// With an explanation that mentions no listed role, the line says what this script found, not what the explanation means.
const NONE_FOUND = "this script found no workspace owner, admin or operator in the explanation above; read it as written";

// The verb treats ok as the only success and never classifies the rest, so the script does: ok is success, these
// outcomes mean the call has not finished (compared exactly, as the verb compares ok), and any other outcome is a failure.
const IN_FLIGHT = new Set([
  "pending", "in_flight", "in-flight", "in_progress", "in-progress", "running", "queued", "started",
  "awaiting_approval", "awaiting-approval", "approval_pending",
]);
const isFailure = (c) => c.outcome !== "ok" && !IN_FLIGHT.has(c.outcome);
const isUnfinished = (c) => IN_FLIGHT.has(c.outcome);

const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const text = (v) => (typeof v === "string" && oneLine(v) ? oneLine(v) : null);
/** A plain object: the only shape a recorded call, or its dispatch, can have. */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** A string that says something, without the spaces around it (" ok " is ok); any other type, and a blank string, is absent. */
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const normaliseServer = (raw) =>
  raw.trim().toLowerCase().replace(/[\s.]+/g, "-").replace(/[^a-z0-9_-]/g, "");

/** The listed roles the explanation mentions, each once, in order of first mention, as written ("a workspace admin"). */
function rolesIn(explanation) {
  const parts = (explanation ?? "").split(ROLE_MENTION);
  const roles = [];
  for (let i = 2; i < parts.length; i += 3) {
    const role = parts[i].toLowerCase();
    if (!roles.some((r) => r.endsWith(` ${role}`))) roles.push(`${parts[i - 1]?.toLowerCase() ?? (/^[aeiou]/.test(role) ? "an" : "a")} ${role}`);
  }
  return roles;
}
const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

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
  // The route sends dispatch as null (not dispatched) or an object with a string ticket. Anything else does not tell
  // which ticket the call is for, and a --ticket answer must not read that as "a different ticket".
  const ticketKnown = c.dispatch == null || (isRecord(c.dispatch) && str(c.dispatch.ticket) !== null);
  return {
    tool,
    outcome,
    ticketKnown,
    ticket: str(dispatch.ticket),
    phase: str(dispatch.phase),
    denied: text(c.denied_reason),
    explanation: text(c.explanation),
    at: when(c.at),
  };
}

/**
 * What the answer says about who can fix it: the roles the explanation mentions, as written, and why that is all it
 * says. Nothing here names a role as the one that can fix it; that is for the reader of the explanation to decide.
 */
function fixer(explanation, mentioned, failed) {
  const basis = !failed ? null : mentioned.length ? "mentioned in the explanation" : explanation ? "explanation names none" : "no explanation";
  return { mentioned, basis };
}

/** The answer for one read: the fields of the call it rests on, a verdict, and the reason as the verb prints it. */
function answer(server, ticket, tool, calls) {
  const base = { server, ticket: ticket ?? null, phase: null, tool: null, outcome: null, reason: null, explanation: null, at: null };
  const readable = calls.map(readCall).filter((c) => c !== null && (!ticket || c.ticketKnown));
  const window = { read: calls.length, limit: LIMIT, unreadable: calls.length - readable.length };
  const kept = readable.filter(
      (c) =>
        (!ticket || (c.ticket ?? "").toLowerCase() === ticket.toLowerCase()) &&
        (!tool || c.tool.toLowerCase().includes(tool.toLowerCase())),
    );
  const failed = kept.find(isFailure);
  const call = failed ?? kept[0];
  if (!call) return { a: { ...base, fixer: fixer(null, [], false), window, verdict: "not-in-window" } };
  const roles = failed ? rolesIn(call.explanation) : [];
  const a = {
    ...base,
    ticket: call.ticket,
    phase: call.phase,
    tool: call.tool,
    outcome: call.outcome,
    reason: failed ? (call.denied ?? text(call.outcome)) : null,
    explanation: failed ? call.explanation : null,
    at: call.at,
    fixer: fixer(failed ? call.explanation : null, roles, failed !== undefined),
    window,
    verdict: failed ? "failed" : "no-failure",
  };
  const newer = failed ? kept.slice(0, kept.indexOf(failed)).find(isUnfinished)?.outcome ?? null : null;
  return { a, why: [call.denied, call.explanation].filter(Boolean).join(": "), newer };
}

/** The one line the desk replies with. Records the script could not read are counted, and no sentence speaks for them. */
function render({ a, why, newer }, ticket, tool) {
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
    const state = isUnfinished(a) ? `is still ${a.outcome}, so it has not finished` : `was ok at ${a.at ?? "an unrecorded time"}`;
    return `no failed call to ${a.server}${ticket ? ` on ${ticket}` : ""}${matching} in ${seen}; ${newest} ${state}${rest}.`;
  }
  const slot = a.ticket ? `${a.ticket} ${a.phase ?? ""}`.trim() : "no ticket";
  const who = a.fixer.mentioned.length
    ? `see the explanation above, which mentions ${list(a.fixer.mentioned)}; read it as written`
    : a.explanation ? NONE_FOUND : NO_ONE;
  const later = newer ? ` A newer call is still ${newer}, so it has not finished.` : "";
  const skipped = unreadable ? ` ${calls(unreadable, "other ")} could not be read, so this may not be the newest failure.` : "";
  return `${slot}: ${a.tool} on ${a.server} failed (${a.outcome}) — ${sentence(why || "the record gives no reason")} Who can fix it: ${who}.${later}${skipped}`;
}

/** A refusal: one line, however the message was built. It is written once, at the end, and the process then ends on its own. */
class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(oneLine(message));
};
// A reader that closes early (`| head -c 20`) is not an error. On stderr the exit code is left as it was.
process.stdout.on("error", (err) => {
  if (err.code !== "EPIPE") throw err;
  process.exit(0);
});
process.stderr.on("error", () => {});

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

try {
  const server = normaliseServer(positionals[0]);
  if (!SERVER_NAME.test(server)) fail("that is not a server name (lowercase letters, digits, - and _, starting with a letter)");

  const r = runCli(["mcp", "status", server, "--json"], { say: () => NOT_CONNECTED });
  if (r.code === 3) {
    fail(
      `could not read MCP server ${server}: either this workspace registered it under another name or this Catalyst Cloud does not serve tool-call records yet. A workspace owner or admin can list the names with \`catalyst mcp list\`.`,
    );
  }
  if (r.code !== 0) fail(`could not read MCP server ${server}: \`catalyst mcp status ${server}\` refused the read (exit ${r.code}); run it in a terminal to see the reason.`);

  let status;
  try {
    status = JSON.parse(r.stdout.trim());
  } catch {
    fail(`could not read MCP server ${server}: could not parse the answer of \`catalyst mcp status ${server}\` as JSON (exit ${r.code}); run it in a terminal to see what it says.`);
  }
  const calls = status?.calls?.calls;
  if (!Array.isArray(calls)) fail(`could not read MCP server ${server}: the status came back in a shape this script does not know`);

  const result = answer(server, flags.ticket, flags.tool, calls);
  // The line is collapsed whole, so no value in it (a flag, a recorded ticket, phase, tool or outcome) can break it in two.
  // No process.exit() after the write: on a pipe it cuts a large write short, and the record's own words are kept whole.
  process.stdout.write(`${flags.json ? JSON.stringify(result.a) : oneLine(render(result, flags.ticket, flags.tool))}\n`);
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
