#!/usr/bin/env node
// read-ticket.mjs — one ticket with its comments, relations, labels, linked pull requests and agent
// sessions inline, from the cloud API by default, or an explicitly chosen local replica. The source line the
// CLI prints on stderr is the freshness verdict; it is always shown.
import {
  parseFlags,
  parseJson,
  relayStderr,
  runCli,
  usage,
  wantsHelp,
} from "./lib/cli.mjs";

const HELP = `Usage: node scripts/read-ticket.mjs <ticket> [--comments] [--source replica|api] [--json]

Reads one ticket record. Wraps: catalyst query issue.

  <ticket>               the Linear identifier, e.g. KEY-123
  --comments             also print every comment (id, author, time, body)
  --source replica|api   choose one source; default is the cloud API
  --json                 print the full record as JSON

The first stderr line names the source ("source: api (cloud reads by default)" or "source: replica (--source replica)"); quote it when the freshness of the answer matters.

Exit 0 found, 1 not found or a usage error, 2 when this machine is not connected to a tenant or the
cloud refused the read (the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, {
  bool: ["comments", "json"],
  value: ["source"],
});
const ticket = positionals[0];
if (!ticket) usage("read-ticket needs a ticket identifier (see --help)");

const args = ["query", "issue", ticket, "--json"];
if (flags.source) args.push("--source", flags.source);
const r = runCli(args);
relayStderr(r);
if (r.code !== 0) {
  const out = r.stdout.trimEnd();
  if (out) console.log(out);
  process.exit(r.code);
}
const row = parseJson(r.stdout);
if (!row || typeof row !== "object") {
  console.log(r.stdout.trimEnd());
  process.exit(1);
}
if (flags.json) {
  console.log(JSON.stringify(row));
  process.exit(0);
}

const line = (label, value) => {
  if (value === undefined || value === null || value === "") return;
  console.log(
    `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
};
const names = (list, key) =>
  Array.isArray(list)
    ? list.map((x) =>
        x && typeof x === "object" ? (x[key] ?? JSON.stringify(x)) : String(x),
      )
    : [];

line("ticket", row.identifier ?? row.id);
line("title", row.title);
line("state", row.state);
line("priority", row.priority_label ?? row.priority);
line("assignee", row.assignee_name ?? row.assignee);
line("delegate", row.delegate_name ?? row.delegate);
line("team", row.team_key ?? row.team_name ?? row.team_id);
line("project", row.project_name ?? row.project_id);
line("cycle", row.cycle_name ?? row.cycle_id);
line("parent", row.parent_identifier);
line("labels", names(row.labels, "name").join(", "));
line("url", row.url);
line("updated", row.updated_at);
// `relations` holds only the edges this ticket points out along. Each line ends with the other
// ticket's state when the record carries it.
if (Array.isArray(row.relations) && row.relations.length) {
  console.log(`relations (${row.relations.length}):`);
  for (const rel of row.relations)
    console.log(
      `  ${rel.type ?? "?"}: ${rel.issue_identifier ?? ""} -> ${rel.related_identifier ?? JSON.stringify(rel)}${rel.related_state ? ` [${rel.related_state}]` : ""}`,
    );
}
// The tickets holding this one arrive in `blocked_by`, never in `relations`: a reader shown only
// the block above sees a held ticket as free and files its blockers again.
if (Array.isArray(row.blocked_by) && row.blocked_by.length) {
  console.log(`blocked by (${row.blocked_by.length}):`);
  for (const blocker of row.blocked_by) {
    const marks = ["is_ask", "is_approval", "is_decided", "unresolved"]
      .filter((flag) => blocker?.[flag] === true)
      .map((flag) => flag.replace(/^is_/, ""));
    console.log(
      `  ${blocker?.identifier ?? "?"} [${blocker?.state ?? "?"}]${marks.length ? ` (${marks.join(", ")})` : ""} ${blocker?.title ?? ""}`.trimEnd(),
    );
  }
}
if (Array.isArray(row.linked_pulls) && row.linked_pulls.length) {
  console.log(`linked pull requests (${row.linked_pulls.length}):`);
  for (const pr of row.linked_pulls)
    console.log(
      `  #${pr.number ?? "?"} ${pr.repo_id ?? ""} [${pr.node_id ?? ""}]`,
    );
}
if (Array.isArray(row.agent_sessions))
  line("agent sessions", row.agent_sessions.length);
if (Array.isArray(row.activity)) line("activity entries", row.activity.length);
if (Array.isArray(row.comments)) line("comments", row.comments.length);
if (row.description) {
  console.log("description:");
  console.log(String(row.description).trimEnd());
}
if (flags.comments && Array.isArray(row.comments)) {
  console.log(`== comments (${row.comments.length})`);
  for (const c of row.comments) {
    const who = c.author_name ?? c.author_id ?? "?";
    const bot = c.is_bot ? " [bot]" : "";
    const parent = c.parent_id ? ` reply-to ${c.parent_id}` : "";
    console.log(
      `-- ${c.id} · ${who}${bot} · ${c.updated_at ?? c.created_at ?? ""}${parent}`,
    );
    console.log(String(c.body ?? "").trimEnd());
  }
}
