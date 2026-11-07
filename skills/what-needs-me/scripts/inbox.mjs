#!/usr/bin/env node
// inbox.mjs — "what needs me?": the open asks in this cloud account, ranked by what each answer releases.
// A thin wrapper over `catalyst ask list`, which reads the connected person's asks from the workspace's
// Waiting-on-me view (every ticket for --anyone), follows each one's blocking relations, and ranks by
// the count of open tickets held, then the oldest ask. By default the CLI keeps only the asks assigned
// to the connected person; --anyone widens to the whole account. Prints the ranked list; --json prints the
// CLI's {scope, asks} unchanged.
import { mustRun, parseFlags, parseJson, printHelp } from "./lib/cli.mjs";

const SPEC = {
  json: { value: false, help: "print the CLI's answer as JSON: {scope, asks: [{identifier, title, state, blocks[], score, assigneeId}]}" },
  team: { value: true, help: "only asks whose identifier carries this team key" },
  all: { value: false, help: "include asks that hold nothing (by default they are listed last, marked)" },
  anyone: { value: false, help: "every open ask in the account, not only the ones assigned to you" },
};

const { help, flags } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp("node scripts/inbox.mjs [--json] [--team K] [--all] [--anyone] [--help]", SPEC, [
    "Rank: most open tickets blocked first, then the oldest ask; priority is not a weight.",
    "An ask that holds nothing is real but will not appear in the Waiting-on-me view; it is",
    "listed last with a marker so you can attach the work it should block (references/reading-the-inbox.md).",
  ]);
  process.exit(0);
}

const answer = parseJson(mustRun(["ask", "list", "--json", ...(flags.anyone ? ["--anyone"] : [])], { quiet: true }).stdout, "ask list");
const rows = answer.asks;
const scope = answer.scope;
const wanted = flags.team ? rows.filter((r) => String(r.identifier).toUpperCase().startsWith(`${flags.team.toUpperCase()}-`)) : rows;
if (flags.json) {
  process.stdout.write(JSON.stringify({ scope, asks: wanted }) + "\n");
  process.exit(0);
}
// Say whose list this is before the list, so an empty "mine" never reads as "nothing needs anyone".
if (scope.kind === "mine") process.stdout.write(`asks assigned to ${scope.label}:\n`);
else if (scope.kind === "anyone") process.stdout.write("every open ask in the account:\n");
else if (scope.kind === "unmatched") process.stdout.write(`every open ask (your Linear identity is not matched yet; match it with: catalyst identity linear set):\n`);
else process.stdout.write("every open ask (connected with the account key, which names no person — log in with your personal key to see only yours):\n");
if (wanted.length === 0) {
  process.stdout.write(scope.kind === "mine" ? "nothing needs you: no open asks assigned to you (--anyone lists everyone's)\n" : "nothing needs anyone: no open asks\n");
  process.exit(0);
}
const holding = wanted.filter((r) => r.blocks.length > 0);
const idle = wanted.filter((r) => r.blocks.length === 0);
let n = 0;
for (const r of holding) {
  n += 1;
  process.stdout.write(`${n}. ${r.identifier}  holds ${r.blocks.length}: ${r.blocks.join(", ")}\n   ${r.title}\n`);
}
if (idle.length && (flags.all || holding.length === 0)) {
  process.stdout.write(`${holding.length ? "\n" : ""}asks that hold nothing (not shown in Waiting on me until they block something):\n`);
  for (const r of idle) process.stdout.write(`   ${r.identifier}  ${r.title}\n`);
} else if (idle.length) {
  process.stdout.write(`\n(${idle.length} more ask${idle.length === 1 ? "" : "s"} hold nothing; --all lists them)\n`);
}
process.exit(0);
