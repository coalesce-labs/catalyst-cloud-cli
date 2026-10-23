#!/usr/bin/env node
// raise.mjs — file one decision for the human as an ask ticket, through the cloud's own ask route.
// Wraps `catalyst ask raise`. You pass fields (question, options, default, what it blocks);
// the cloud renders the body from the tenant's ask template, applies the ask labels, and creates the
// blocking relations in one atomic write. Headings are never composed here.
import { mustRun, parseFlags, parseJson, printHelp } from "./lib/cli.mjs";

const SPEC = {
  team: { value: true, help: "the team key the ask is filed on (required)" },
  title: { value: true, help: "the question, one sentence (required)" },
  context: { value: true, help: "a short paragraph of context the human needs to answer" },
  option: { value: true, repeat: true, help: "one realistic option (repeat per option; the contract caps how many)" },
  default: { value: true, help: "what proceeds if the human stays silent, and after how long" },
  blocks: { value: true, repeat: true, help: "a ticket this decision holds (repeat per ticket)" },
  "nothing-to-block": { value: false, help: "declare that no ticket is held (the ask then never shows in Waiting on me)" },
  "ask-key": { value: true, help: "idempotency key so a re-run does not file a second ask" },
  "gates-pr": { value: true, repeat: true, help: "a PR whose hold label the answer removes (repeat per PR; needs --released-by)" },
  "gates-label": { value: true, repeat: true, help: "the hold the answer removes: hold or hold:preview (repeatable; default hold)" },
  "released-by": { value: true, repeat: true, help: "an option letter whose answer releases the hold (repeat per letter)" },
  "gates-repo": { value: true, help: "the --gates-pr repository as owner/name (default: the account's only repository)" },
  json: { value: false, help: "print the cloud's response as JSON" },
};

const { help, flags } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp("node scripts/raise.mjs --team <key> --title <question> [--context <text>] [--option <text>]... [--default <text>] --blocks <ticket>... | --nothing-to-block [--ask-key <key>] [--gates-pr <n>... --released-by <letter>... [--gates-label hold|hold:preview]... [--gates-repo <owner/name>]] [--json] [--help]", SPEC, [
    "Search for an existing ask first (node scripts/inbox.mjs); one decision, one ask.",
    "File BEFORE proceeding on the default. Cite the identifier only from this script's output.",
  ]);
  process.exit(0);
}
const missing = [];
if (!flags.team) missing.push("--team");
if (!flags.title) missing.push("--title");
if (!flags.blocks && !flags["nothing-to-block"]) missing.push("--blocks <ticket> (or --nothing-to-block)");
if (missing.length) {
  process.stderr.write(`raise needs ${missing.join(", ")} (try --help)\n`);
  process.exit(1);
}

const args = ["ask", "raise", "--team", flags.team, "--title", flags.title];
if (flags.context) args.push("--context", flags.context);
for (const o of flags.option ?? []) args.push("--option", o);
if (flags.default) args.push("--default", flags.default);
for (const b of flags.blocks ?? []) args.push("--blocks", b);
if (flags["nothing-to-block"]) args.push("--nothing-to-block");
if (flags["ask-key"]) args.push("--ask-key", flags["ask-key"]);
for (const n of flags["gates-pr"] ?? []) args.push("--gates-pr", n);
for (const l of flags["gates-label"] ?? []) args.push("--gates-label", l);
for (const l of flags["released-by"] ?? []) args.push("--released-by", l);
if (flags["gates-repo"]) args.push("--gates-repo", flags["gates-repo"]);
args.push("--json");

const result = parseJson(mustRun(args, { quiet: true }).stdout, "ask raise");
const id = result.identifier ?? result.id ?? null;
if (flags.json) process.stdout.write(JSON.stringify(result) + "\n");
else {
  process.stdout.write(`ask raised: ${id ?? "(no identifier returned)"}${flags.blocks ? ` — holds ${flags.blocks.join(", ")}` : " — holds nothing"}\n`);
  if (flags.default) process.stdout.write(`default if silent: ${flags.default}\n`);
  if (flags["gates-pr"]) process.stdout.write(`answer ${flags["released-by"].join(" or ")} releases the hold on PR ${flags["gates-pr"].map((n) => `#${n}`).join(", ")}\n`);
}
process.exit(0);
