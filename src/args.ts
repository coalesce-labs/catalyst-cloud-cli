// args.ts — argument parsing for every verb. Positional 0 is the command, positional 1 the
// subcommand, the rest are positionals; flags are per-verb tables so an unknown flag is a usage
// error naming the verb, and every verb's --help is generated from its own table.
import { UsageError } from "./errors.js";

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  rest: string[];
  flags: Record<string, FlagValue>;
  /** Global flags, kept top-level for the verbs (and tests) that read them directly. */
  key?: string;
  baseUrl?: string;
  skillsDir?: string;
  force: boolean;
  help: boolean;
  version: boolean;
  json: boolean;
}

export interface FlagSpec {
  /** Takes a value (`--name value` / `--name=value`); otherwise boolean. */
  value: boolean;
  /** May be given more than once; collected into a string[]. */
  repeat?: boolean;
  /** Boolean unless a following value is supplied (runner opt-in). */
  optionalValue?: boolean;
  help: string;
}

export type FlagTable = Record<string, FlagSpec>;

const GLOBAL_FLAGS: FlagTable = {
  key: { value: true, help: "your personal key (or CATALYST_CLOUD_TOKEN)" },
  "base-url": {
    value: true,
    help: "Catalyst Cloud origin (or CATALYST_CLOUD_BASE_URL)",
  },
  "skills-dir": {
    value: true,
    help: "where the skills are copied (default ~/.claude/skills)",
  },
  force: {
    value: false,
    help: "replace a skill directory this package did not install",
  },
  json: { value: false, help: "machine-readable output" },
};

/** Per-verb flag tables. A verb absent here accepts only the global flags. */
export const FLAG_TABLES: Record<string, FlagTable> = {
  hosts: { yes: { value: false, help: "confirm removal without a terminal" } },
  runner: {
    yes: { value: false, help: "uninstall: confirm without a terminal" },
    "delete-checkouts": { value: false, help: "uninstall: also delete the repository and thoughts checkouts" },
  },
  login: {
    "start-replica": {
      value: false,
      help: "run `replica start --detach` after connecting",
    },
  },
  mcp: {
    url: { value: true, help: "add: the upstream HTTPS endpoint" },
    auth: { value: true, help: "add: none for an unauthenticated upstream" },
    bearer: {
      value: true,
      help: "add: vault secret NAME for a bearer token, never its value",
    },
    header: {
      value: true,
      repeat: true,
      help: "add: HEADER_NAME=VAULT_SECRET_NAME (repeatable)",
    },
  },
  install: {},
  onboard: {
    "machine-name": {
      value: true,
      help: "name this self-hosted machine (default: its hostname)",
    },
    verbose: { value: false, help: "show granted permissions for connected steps in interactive setup" },
    team: {
      value: true,
      help: "explicitly select an existing Linear team by ID or unique key",
    },
    repo: {
      value: true,
      repeat: true,
      help: "explicitly select an accessible repository as owner/name (repeatable)",
    },
    "local-sync": {
      value: false,
      help: "include the optional local sync setup in this plan",
    },
    runner: {
      value: false,
      optionalValue: true,
      help: "run Catalyst's work on this machine; with --headless, supply yes|no (or CATALYST_ONBOARD_RUNNER)",
    },
    "no-runner": {
      value: false,
      help: "do not run Catalyst's work on this machine, and do not ask",
    },
    "no-color": {
      value: false,
      help: "print setup in plain text, without colour or the Catalyst Cloud mark",
    },
    "resume-from": {
      value: true,
      help: "resume at a verified onboarding step",
    },
    only: { value: true, help: "run only the named onboarding step" },
    yes: { value: false, help: "accept the plan's default choices" },
    "dry-run": {
      value: false,
      help: "print the plan without taking the lock or changing files",
    },
    headless: {
      value: false,
      help: "never prompt or open a browser; every input by flag, env or file; exit 11 names what is missing (or CATALYST_ONBOARD_HEADLESS=1)",
    },
    "key-file": {
      value: true,
      help: "headless: read the personal key from this file (or CATALYST_CLOUD_TOKEN_FILE, or the key in CATALYST_CLOUD_TOKEN); never the key itself on the command line",
    },
    "coding-account": {
      value: true,
      help: "verify this coding-account slot (catalyst accounts lists them; or CATALYST_ONBOARD_CODING_ACCOUNT)",
    },
  },
  status: {},
  notice: {},
  me: {},
  contract: {
    refresh: { value: false, help: "ignore the cache age and revalidate now" },
    path: { value: true, help: "print a sub-document, e.g. teams.0.stages" },
  },
  query: {
    team: { value: true, help: "team key filter" },
    project: { value: true, help: "project id filter" },
    state: { value: true, help: "state name filter" },
    limit: {
      value: true,
      help: "max rows (default 50); one page only unless --all",
    },
    since: { value: true, help: "changes: the cursor to read after" },
    source: {
      value: true,
      help: "replica | api (default: api; replica is an explicit local opt-in)",
    },
    ticket: { value: true, help: "pulls: only PRs linked to this ticket" },
    all: {
      value: false,
      help: "issues/pulls: follow the cloud's page cursor to the end of the scope",
    },
  },
  replica: {
    detach: {
      value: false,
      help: "start: run the writer in the background and write a pidfile",
    },
    db: { value: true, help: "replica file path (default from customer.json)" },
    probe: {
      value: false,
      help: "status: also fetch the cloud head and print the lag",
    },
    "stale-ms": {
      value: true,
      help: "status: heartbeat age that counts as stale (default 15000)",
    },
  },
  events: {
    "from-cache": {
      value: false,
      help: "read the local event cache instead of the cloud (opt-in local sync)",
    },
    probe: {
      value: false,
      help: "status --from-cache: compare the local event cursor with the cloud event head",
    },
    type: { value: true, help: "exact event type" },
    ticket: {
      value: true,
      help: "ticket identifier found in the event",
    },
    after: {
      value: true,
      help: "event sequence to read after (tail and wait-for default to new events only)",
    },
    before: {
      value: true,
      help: "query: event sequence to read before (newest-first paging)",
    },
    order: { value: true, help: "query: desc (newest first, default) or asc" },
    limit: {
      value: true,
      help: "query: maximum matching events (default 50; at most 200 from the cloud)",
    },
    timeout: {
      value: true,
      help: "wait-for: bounded wait in seconds (default 300)",
    },
    directory: {
      value: true,
      help: "with --from-cache: event cache directory (default: SDK XDG path)",
    },
  },
  explain: {
    history: {
      value: false,
      help: "per-ticket execution history instead of the eligibility reason",
    },
  },
  history: {},
  running: {
    ticket: {
      value: true,
      help: "with --phase: also the lease attributions for this (ticket, phase)",
    },
    phase: {
      value: true,
      help: "with --ticket: the phase whose lease attributions to read",
    },
  },
  queue: {
    team: {
      value: true,
      help: "team key (default: every team the tenant contract names)",
    },
  },
  watch: {
    team: { value: true, help: "scope: a team key" },
    ticket: {
      value: true,
      repeat: true,
      help: "scope: a ticket identifier (repeatable)",
    },
    project: { value: true, help: "scope: a project id" },
    exec: {
      value: true,
      help: "run this shell command per frame with the frame on stdin",
    },
    "cursor-file": {
      value: true,
      help: "cursor file path (default ~/.config/catalyst-cloud/watch-cursor.json)",
    },
    from: { value: true, help: "cursor | head (default cursor)" },
  },
  write: {
    body: { value: true, help: "comment: the body text" },
    stdin: {
      value: false,
      help: "comment: read the body from stdin; create: read the description from stdin",
    },
    parent: { value: true, help: "comment: reply under this comment id" },
    bookkeeping: {
      value: false,
      help: "comment: prefix the contract's bookkeeping marker",
    },
    "as-user": {
      value: false,
      help: "post with the personal identity instead of the app actor",
    },
    slot: { value: true, help: "state: the workflow slot to move to" },
    "state-id": { value: true, help: "state: an explicit Linear state id" },
    "state-type": {
      value: true,
      help: "state: the first state of this type on the ticket's team (e.g. backlog)",
    },
    add: {
      value: true,
      repeat: true,
      help: "label: label name or id to add (repeatable)",
    },
    remove: {
      value: true,
      repeat: true,
      help: "label: label name or id to remove (repeatable)",
    },
    team: { value: true, help: "create: team key" },
    title: { value: true, help: "create/attachment/session: title" },
    description: {
      value: true,
      help: "create: the ticket description (markdown)",
    },
    label: {
      value: true,
      repeat: true,
      help: "create: label name or id (repeatable)",
    },
    priority: { value: true, help: "create: Linear priority 0-4" },
    comment: {
      value: true,
      help: "reaction: react to this comment id instead of the ticket",
    },
    emoji: { value: true, help: "reaction: the emoji" },
    url: { value: true, help: "attachment/session: the URL" },
    "plan-file": { value: true, help: "session: a JSON file holding the plan" },
    activity: { value: true, help: "session: one activity line" },
  },
  ask: {
    team: { value: true, help: "raise: team key" },
    title: { value: true, help: "raise: the question" },
    context: { value: true, help: "raise: context paragraph" },
    option: {
      value: true,
      repeat: true,
      help: "raise: an option (repeatable)",
    },
    default: { value: true, help: "raise: the default if silent" },
    blocks: {
      value: true,
      repeat: true,
      help: "raise: a ticket this decision blocks (repeatable)",
    },
    "nothing-to-block": {
      value: false,
      help: "raise: declare that nothing is blocked",
    },
    "gates-pr": {
      value: true,
      repeat: true,
      help: "raise: a PR whose hold the answer releases (repeatable; needs --released-by)",
    },
    "gates-label": {
      value: true,
      repeat: true,
      help: "raise: the hold label the answer removes: hold or hold:preview (repeatable; default hold)",
    },
    "released-by": {
      value: true,
      repeat: true,
      help: "raise: an option letter whose answer releases the hold (repeatable)",
    },
    "gates-repo": {
      value: true,
      help: "raise: the --gates-pr repository as owner/name (default: the account's only repository)",
    },
    anyone: {
      value: false,
      help: "list: every open ask in the tenant, not only the ones assigned to you",
    },
    "ask-key": { value: true, help: "raise: idempotency key" },
    answer: { value: true, help: "accept: the answering comment id" },
    role: { value: true, help: "accept: the role recording the answer" },
  },
  ready: {
    onboarding: {
      value: false,
      help: "check current onboarding evidence and observed project work",
    },
    "local-sync": {
      value: false,
      help: "include the selected local sync mode",
    },
    offline: {
      value: false,
      help: "skip the published-release check (no network)",
    },
  },
  accounts: {},
  seat: {
    size: { value: true, help: "model size: big or med" },
    stage: { value: true, help: "sized relay stage; defaults from size" },
    harness: { value: true, help: "comma-separated runnable harnesses" },
    "session-id": { value: true, help: "stable id for this local session; generated when omitted" },
    "key-env": { value: true, help: "read the bearer from this environment variable, never argv" },
  },
  env: {
    root: {
      value: true,
      help: "draft: repository directory (default: current directory)",
    },
    write: {
      value: false,
      help: "draft: write a new .catalyst/catalyst.toml; refuse to overwrite",
    },
    diff: {
      value: false,
      help: "draft: show the generated TOML as an additions-only diff",
    },
  },
  var: {
    repo: {
      value: true,
      help: "repository scope (owner/name); omit for tenant scope",
    },
    names: {
      value: true,
      repeat: true,
      help: "import: only send these names (repeatable or comma-separated)",
    },
  },
  team: {
    all: { value: false, help: "check every team, one request at a time" },
    stage: {
      value: true,
      repeat: true,
      help: "map a role to a live Linear state name (role=StateName)",
    },
    choice: {
      value: true,
      repeat: true,
      help: "migrate a source state to a destination (sourceId=destinationId)",
    },
    yes: {
      value: false,
      help: "apply the plan you have reviewed with the person",
    },
    "plan-hash": {
      value: true,
      help: "apply only the exact preview hash the person reviewed",
    },
    undo: {
      value: false,
      help: "adopt: preview or archive stages a prior adoption created",
    },
    retire: {
      value: false,
      help: "migrate: separately preview or retire emptied source stages",
    },
  },
  environment: {
    file: { value: true, help: "propose: a JSON file holding the declaration" },
    stdin: { value: false, help: "propose: read the declaration from stdin" },
    "expect-revision": {
      value: true,
      help: "propose: refuse unless the stored declaration is still at this revision",
    },
    approve: {
      value: false,
      help: "propose: approve exactly the revision the propose returned",
    },
    revision: {
      value: true,
      help: "approve: the revision to approve (with --hash; default is whatever read returns)",
    },
    hash: {
      value: true,
      help: "approve: the canonical hash to approve (with --revision)",
    },
  },
  secret: {
    repo: { value: true, help: "the repository, as owner/name (required)" },
    command: {
      value: true,
      help: "set: run this command on this machine and store its output (e.g. 'op read op://Vault/item/field'); the command text is audited, so never put a value in it",
    },
    rotate: {
      value: true,
      repeat: true,
      help: "import: replace this name if it is already set (repeatable)",
    },
    names: {
      value: true,
      repeat: true,
      help: "import: only send these names from the local file (repeatable or comma-separated)",
    },
  },
  identity: {},
  capabilities: {},
  project: {
    team: {
      value: true,
      help: "the project's team key (default: the only mapped project)",
    },
  },
  legacy: {
    remove: {
      value: false,
      help: "remove what was found, after one question (or --yes)",
    },
    data: {
      value: false,
      help: "historical flag; shared data folders are always kept",
    },
    yes: {
      value: false,
      help: "with --remove: answer the question yes (a run with no terminal only reports otherwise)",
    },
  },
  repo: {
    write: {
      value: false,
      help: "agents-block: write or update the block in AGENTS.md (working tree only)",
    },
    apply: {
      value: false,
      help: "agent-setup: perform the portable-layout plan in the working tree",
    },
    "with-check": {
      value: false,
      help: "agent-setup: also write scripts/agents-md-check.mjs, a CI check for the layout",
    },
  },
  connections: {
    wait: {
      value: true,
      help: "start: wait up to this many seconds for browser approval (0-600)",
    },
  },
  release: {
    because: {
      value: true,
      help: "what changed since the ticket was held (required unless --dry-run)",
    },
    "retry-unchanged": {
      value: false,
      help: "release even though nothing the mirror can see changed (say what did in --because)",
    },
    "dry-run": {
      value: false,
      help: "show what a release would clear and refuse, and change nothing",
    },
    class: {
      value: true,
      help: "release every ticket on --team parked under this failure class",
    },
    team: { value: true, help: "with --class: the team key" },
    limit: {
      value: true,
      help: "with --class: at most this many tickets (the cloud caps it at 25)",
    },
  },
  stage: {
    artifact: { value: true, help: "done/fail: path to the phase artifact" },
    evidence: { value: true, help: "done: JSON file with phase-specific receipt evidence" },
    summary: { value: true, help: "done/fail: concise outcome summary" },
    assertion: { value: true, help: "renew: work completed since the previous renewal" },
  },
};

export const VERB_USAGE: Record<string, string> = {
  runner:
    "runner [status] | runner stop | runner start | runner uninstall [--yes] [--delete-checkouts] [--json]",
  hosts:
    "hosts [list] | hosts remove <name-or-id> [--yes] | hosts rename <name-or-id> <new-name> [--json]",
  setup:
    "setup [onboard options]   (sets up Catalyst step by step; same as catalyst onboard) | setup --engine <file> --engine-sha256 <hex> [-- <install options>]   (run by install.sh; install.sh --help lists the options)",
  login:
    "login [--base-url <url>] [--start-replica]   (keyless; or --key <personal-key> / CATALYST_CLOUD_TOKEN)",
  onboard:
    "onboard [--team <ID|key>] [--repo <owner/name>]... [--coding-account <slot>] [--resume-from <step>] [--only <step>] [--local-sync] [--runner|--no-runner] [--no-color] [--yes] [--dry-run] [--json] | onboard --headless [--key-file <path>] [--team ...] [--repo ...]... [--coding-account ...] [--runner yes|no] [--json]",
  install: "install [--skills-dir <dir>] [--force]",
  status: "status",
  notice: "notice",
  me: "me [--json]",
  contract: "contract [--refresh] [--path <a.b.c>] [--json]",
  query:
    "query <issues|issue <id>|pulls|pull <id>|projects|cycles|search <terms>|changes --since <cursor|head>> [--team K] [--project P] [--state S] [--limit N] [--all] [--source replica|api] [--json]",
  replica:
    'replica <start [--detach]|stop|status [--probe] [--json]|sql "<select>"|schema [table]> [--db <path>]',
  runtime: "runtime <status [--json]|install|path|uninstall>",
  events:
    "events <tail|wait-for|query|status [--probe] [--json]> [--type NAME] [--ticket CTC-N] [--after SEQUENCE] [--limit N] [--timeout SECONDS] [--directory PATH]",
  explain: "explain <ticket> [--history] [--json]",
  history: "history <ticket> [--json]",
  running: "running [--ticket T --phase P] [--json]",
  queue: "queue [--team K] [--json]",
  watch:
    "watch [--team K] [--ticket T]... [--project P] [--exec CMD] [--cursor-file <path>] [--from cursor|head]",
  write:
    "write <comment <ticket> --body|--stdin [--parent] [--bookkeeping] [--as-user] | state <ticket> --slot|--state-id|--state-type | label <ticket> --add... --remove... | create --team --title [--description|--stdin] [--label] [--priority] | reaction <ticket>|--comment <id> --emoji <e> | attachment <ticket> --title --url | session <ticket> [--title] [--plan-file] [--activity]>",
  ask: "ask <raise --team --title [--context] [--option]... [--default] --blocks <ticket>...|--nothing-to-block [--ask-key] [--gates-pr <n>... --released-by <letter>... [--gates-label hold|hold:preview]... [--gates-repo <owner/name>]] | accept <askTicket> --answer <commentId> --role <role> | list [--anyone] [--json]>",
  ready: "ready [--onboarding] [--local-sync] [--json] [--offline]",
  accounts: "accounts [--json]",
  seat: "seat checkout --size big|med --harness claude,codex,opencode [--session-id ID] [--stage STAGE] [--key-env NAME]",
  mcp: "mcp <add <name> --url URL <--auth none|--bearer SECRET_NAME|--header NAME=SECRET_NAME...>|list|remove <name>> [--json]",
  team: "team <list|check <KEY>|check --all|map <KEY> [--stage role=StateName]... [--yes --plan-hash H]|adopt <KEY> [--undo] [--yes --plan-hash H]|migrate <KEY> [--choice sourceId=destinationId]... [--retire] [--yes --plan-hash H]|checklist <KEY>> [--json]",
  env: "env <inventory [path] | check <file> | migrate [catalyst.env.json] | draft [--root DIR] [--diff] [--write]> [--json]   (THIS repository, offline — no login, no network)",
  environment:
    "environment [read] [--json] | environment propose --file <path>|--stdin [--expect-revision N] [--approve] [--json] | environment approve [--revision N --hash H] [--json]   (your ACCOUNT's declaration; needs login)",
  secret:
    "secret set <NAME> --repo <owner/name> [--command '<cmd>'] [--json]   (value from --command, stdin, or a hidden prompt) | secret import <file> --repo <owner/name> [--names NAME[,NAME...]] [--rotate NAME]... [--json]",
  var: "var <set NAME|import <file>> [--repo <owner/name>] [--names NAME[,NAME...]] [--json]   (plain environment variables; set reads stdin or a hidden prompt)",
  identity: "identity linear <status|options|set> [<linearUserId>] [--json]",
  capabilities: "capabilities [--json]",
  project:
    "project <list [--json] | wip-limit <get|set <n>|set default> [--team K] [--json]>",
  repo: "repo <agents-block <path> [--write]|agent-setup <path> [--apply] [--with-check]> [--json]",
  legacy: "legacy [--remove [--data] [--yes]] [--json]",
  connections:
    "connections personal <linear|github> <start|status> [--wait <seconds>] [--json]",
  release:
    "release <ticket> --because <what changed> [--retry-unchanged] [--dry-run] [--json] | release --class <failure-class> --team <K> --because <what changed> [--retry-unchanged] [--dry-run] [--limit N] [--json]",
  stage:
    "stage start|renew|done|fail <ticket> <phase> [--artifact <path>] [--evidence <json>] [--summary <text>] [--assertion <work done>]",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    subcommand: null,
    rest: [],
    flags: {},
    force: false,
    help: false,
    version: false,
    json: false,
  };
  const positionals: string[] = [];
  // The per-verb table is switched in the moment the command positional is seen, so a verb's own
  // flags are accepted after it and a global flag is accepted anywhere.
  let table: FlagTable = { ...GLOBAL_FLAGS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      out.version = true;
      continue;
    }
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let inlineValue: string | undefined;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const spec = table[name];
      if (!spec) {
        throw new UsageError(
          out.command
            ? `unknown option for ${out.command}: --${name}`
            : `unknown option: --${name}`,
        );
      }
      if (spec.optionalValue) {
        const next = argv[i + 1];
        if (inlineValue !== undefined) out.flags[name] = inlineValue;
        else if (next !== undefined && !next.startsWith("-")) out.flags[name] = argv[++i]!;
        else out.flags[name] = true;
      } else if (spec.value) {
        const v = inlineValue ?? requireValue(argv, ++i, `--${name}`);
        if (spec.repeat) {
          const prev = out.flags[name];
          out.flags[name] = Array.isArray(prev) ? [...prev, v] : [v];
        } else {
          out.flags[name] = v;
        }
      } else {
        if (inlineValue !== undefined)
          throw new UsageError(`--${name} takes no value`);
        out.flags[name] = true;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1)
      throw new UsageError(`unknown option: ${a}`);
    positionals.push(a);
    if (positionals.length === 1) {
      out.command = a;
      table = { ...GLOBAL_FLAGS, ...(FLAG_TABLES[a] ?? {}) };
    }
  }
  out.command = positionals[0] ?? null;
  out.subcommand = positionals[1] ?? null;
  out.rest = positionals.slice(2);
  if (typeof out.flags.key === "string") out.key = out.flags.key;
  if (typeof out.flags["base-url"] === "string")
    out.baseUrl = out.flags["base-url"];
  if (typeof out.flags["skills-dir"] === "string")
    out.skillsDir = out.flags["skills-dir"];
  out.force = out.flags.force === true;
  out.json = out.flags.json === true;
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v === "")
    throw new UsageError(`${flag} requires a value`);
  return v;
}

/** The positional arguments after the command: `[subcommand, ...rest]` with nulls dropped. */
export function positionals(args: ParsedArgs): string[] {
  return args.subcommand === null ? [] : [args.subcommand, ...args.rest];
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? [v] : [];
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagInt(
  args: ParsedArgs,
  name: string,
  fallback: number,
): number {
  const v = flagString(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n))
    throw new UsageError(`--${name} must be an integer`);
  return n;
}

/** The help text for one verb: usage line, then every flag in its table and the global ones. */
export function verbHelp(verb: string): string {
  const lines = [`Usage: catalyst ${VERB_USAGE[verb] ?? verb}`, ""];
  const table = FLAG_TABLES[verb] ?? {};
  const names = Object.keys(table);
  if (names.length > 0) {
    lines.push("Options:");
    for (const name of names)
      lines.push(
        `  --${name}${table[name]!.value ? " <value>" : ""}  ${table[name]!.help}`,
      );
    lines.push("");
  }
  lines.push("Global options:");
  for (const name of Object.keys(GLOBAL_FLAGS)) {
    lines.push(
      `  --${name}${GLOBAL_FLAGS[name]!.value ? " <value>" : ""}  ${GLOBAL_FLAGS[name]!.help}`,
    );
  }
  lines.push("  -h, --help  this text", "  -V, --version  the bundle version");
  return lines.join("\n");
}
