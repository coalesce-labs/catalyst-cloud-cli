#!/usr/bin/env node
// snapshot.mjs — one call that answers "where are we?": the account's contract (trimmed to what a
// status reply needs), what is running, what is queued, what is waiting on a human, and whether the
// local replica is fresh. Prints ONE JSON document on stdout and the source line on stderr.
import {
  mustRun,
  parseFlags,
  parseJson,
  printHelp,
  runCli,
} from "./lib/cli.mjs";

/** Cards listed per board column by default. Counts are never capped by this; the cards are. */
const BOARD_CARDS_PER_COLUMN = 50;
/** One page of `query issues` when the whole-scope read fails: the server's page cap. */
const BOARD_FALLBACK_PAGE = 500;
const TERMINAL_TYPES = new Set(["completed", "canceled", "cancelled"]);

const SPEC = {
  team: { value: true, help: "limit the queue and the board to this team key" },
  board: {
    value: false,
    help: "also include open tickets grouped by stage, in the contract's slot order",
  },
  limit: {
    value: true,
    help: `board: max cards listed per column (default ${BOARD_CARDS_PER_COLUMN}); column counts always cover every ticket read`,
  },
  "full-contract": {
    value: false,
    help: "include the whole contract instead of the trimmed `tenant` block",
  },
  accounts: {
    value: false,
    help: "also include the coding accounts: provider, state, usage limits, walls, quarantine (never a credential)",
  },
  replica: {
    value: false,
    help: "also read optional local replica diagnostics",
  },
};

const { help, flags } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp(
    "node scripts/snapshot.mjs [--team K] [--board] [--accounts] [--limit N] [--full-contract] [--help]",
    SPEC,
    [
      "Reads catalyst contract, running, queue and ask list from the cloud (query issues with --board,",
      "accounts with --accounts, optional local diagnostics with --replica).",
      "Output: one JSON document {takenAt, source, tenant, running, queue, waitingOnHuman, board?, boardTruncated?, accounts?, errors?}.",
      "board.counts counts every open ticket in scope; boardTruncated is present whenever a card list or the read itself left tickets out.",
      "A section the cloud refused is reported under errors and the rest still prints; exit 1 in that case.",
      "Every account fact (stage names, thresholds, teams) comes from the contract in this output, never from prose.",
    ],
  );
  process.exit(0);
}

const errors = {};
const section = (name, args) => {
  const r = runCli(args);
  if (r.code !== 0) {
    errors[name] = (r.stderr || r.stdout || `exit ${r.code}`)
      .trim()
      .split("\n")
      .at(-1);
    return null;
  }
  return parseJson(r.stdout, name);
};

const contract = parseJson(
  mustRun(["contract", "--json"], { quiet: true }).stdout,
  "contract",
);
// `replica status` exits 0 fresh, 1 stale, 3 absent — all three are verdicts with JSON on stdout,
// not failures; only a non-JSON answer is an error.
const replica = (() => {
  if (!flags.replica)
    return { verdict: "not-selected", cursor: null, heartbeatAgeMs: null };
  const r = runCli(["replica", "status", "--json"]);
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    errors.replica = (r.stderr || r.stdout || `exit ${r.code}`)
      .trim()
      .split("\n")
      .at(-1);
    return { verdict: "unknown", cursor: null, heartbeatAgeMs: null };
  }
})();
const running = section("running", ["running", "--json"]);
const queue = section(
  "queue",
  flags.team ? ["queue", "--team", flags.team, "--json"] : ["queue", "--json"],
);
const asks = section("waitingOnHuman", ["ask", "list", "--json"]);

const out = {
  takenAt: new Date().toISOString(),
  source: {
    reads: "api",
    replica: replica.verdict,
    replicaCursor: replica.cursor ?? null,
    replicaHeartbeatAgeMs: replica.heartbeatAgeMs ?? null,
  },
  tenant: flags["full-contract"]
    ? contract
    : trimContract(contract, flags.team),
  running,
  queue,
  waitingOnHuman: asks,
};

if (flags.accounts) out.accounts = section("accounts", ["accounts", "--json"]);

if (flags.board) {
  const perColumn = flags.limit === undefined ? BOARD_CARDS_PER_COLUMN : Number(flags.limit);
  if (!Number.isInteger(perColumn) || perColumn < 1) {
    process.stderr.write(`--limit must be a positive whole number, got ${flags.limit}\n`);
    process.exit(1);
  }
  const read = readBoard(flags.team);
  if (read.error) errors.board = read.error;
  else {
    out.board = groupByStage(read.rows, contract, flags.team, perColumn);
    if (read.sourceLine) out.source.board = read.sourceLine.replace(/^source: /, "");
    if (read.truncatedLine) out.source.boardTruncated = read.truncatedLine;
    const truncated = boardTruncation(out.board, read, perColumn);
    if (truncated) out.boardTruncated = truncated;
  }
}

if (Object.keys(errors).length) out.errors = errors;
process.stderr.write(
  `source: api for running/queue/asks; replica ${replica.verdict}${replica.cursor != null ? ` (cursor ${replica.cursor})` : ""}${out.source.board ? `; board from ${out.source.board}` : ""}\n`,
);
if (out.boardTruncated) process.stderr.write(`board truncated: ${out.boardTruncated.message}\n`);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
// exitCode, not exit(): a whole board is well past a pipe's buffer, and exit() would cut it off.
process.exitCode = Object.keys(errors).length ? 1 : 0;

/** The contract facts a status reply needs, and nothing a reply should not paste. */
function trimContract(doc, teamKey) {
  const teams = (doc.teams ?? []).filter(
    (t) =>
      !teamKey || String(t.key ?? "").toUpperCase() === teamKey.toUpperCase(),
  );
  return {
    contractVersion: doc.contractVersion,
    account: { slug: doc.account?.slug, name: doc.account?.name },
    slots: doc.slots,
    ladder: {
      phases: doc.ladder?.phases,
      intakeEnabled: doc.ladder?.intakeEnabled,
      keying: doc.ladder?.keying,
    },
    thresholds: doc.thresholds,
    mergeDefaultPolicy: doc.merge?.defaultPolicy,
    teams: teams.map((t) => ({
      key: t.key,
      name: t.name,
      workflowMode: t.workflowMode,
      readiness: t.readiness?.status,
      stages: Object.fromEntries(
        (doc.slots ?? Object.keys(t.stages ?? {}))
          .filter((slot) => t.stages?.[slot])
          .map((slot) => [
            slot,
            {
              name: t.stages[slot].name,
              type: t.stages[slot].type,
              stateStillExists: t.stages[slot].stateStillExists,
            },
          ]),
      ),
      labels: {
        ask: (t.labels?.ask ?? []).map((l) => l.name),
        hold: (t.labels?.hold ?? []).map((l) => l.name),
        release: (t.labels?.release ?? []).map((l) => l.name),
      },
    })),
  };
}

/**
 * Every ticket in scope, so the board counts are whole (CTC-5622). The cloud caps one page at 500
 * rows, so a single `--limit` read is a window over the most recently updated tickets, and the
 * stages it happens to cover are not the board. `--all` follows the cloud's page cursor to the end.
 * If that read is refused (a scope past the CLI's page ceiling, say), one full page is read instead
 * and the result says exactly how much of the scope it covers.
 */
function readBoard(teamKey) {
  const base = ["query", "issues", "--source", "api"];
  const team = teamKey ? ["--team", teamKey] : [];
  const lineOf = (stderr, re) => (stderr.match(re) ?? [null])[0];
  const lastLine = (r) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").at(-1);

  const all = runCli([...base, "--all", "--json", ...team]);
  if (all.code === 0) {
    const rows = parseJson(all.stdout, "issues");
    return {
      rows,
      complete: true,
      read: { returned: rows.length, total: rows.length },
      sourceLine: lineOf(all.stderr, /^source: .*$/m),
      truncatedLine: null,
    };
  }
  const allError = lastLine(all);
  const page = runCli([...base, "--limit", String(BOARD_FALLBACK_PAGE), "--json", ...team]);
  if (page.code !== 0) return { error: `${allError}; one page: ${lastLine(page)}` };
  const rows = parseJson(page.stdout, "issues");
  const truncatedLine = lineOf(page.stderr, /^truncated at .*$/m);
  // The CLI's line: "truncated at N of M — …", where M is a count or "an unknown total (…)".
  const m = truncatedLine?.match(/^truncated at (\d+) of (\d+)?/);
  return {
    rows,
    complete: !truncatedLine,
    read: {
      returned: m ? Number(m[1]) : rows.length,
      total: truncatedLine ? (m?.[2] ? Number(m[2]) : null) : rows.length,
    },
    readError: allError,
    sourceLine: lineOf(page.stderr, /^source: .*$/m),
    truncatedLine,
  };
}

/** The top-level truncation report, or null when the board lists every open ticket in scope. */
function boardTruncation(board, read, perColumn) {
  const total = Object.values(board.counts).reduce((a, b) => a + b, 0);
  const returned = Object.values(board.byStage).reduce((a, cards) => a + cards.length, 0);
  if (read.complete && returned === total) return null;
  const n = (v) => (v === null ? "an unknown number of" : v.toLocaleString("en-US"));
  const parts = [];
  if (returned < total)
    parts.push(`lists ${n(returned)} of ${n(total)} open tickets (at most ${perColumn} per column; raise --limit for more)`);
  parts.push(
    read.complete
      ? "column counts cover every ticket"
      : `column counts cover only the ${n(read.read.returned)} most recently updated of ${n(read.read.total)} tickets read, so they are low`,
  );
  return {
    returned,
    total,
    perColumn,
    countsComplete: read.complete,
    ...(read.complete ? {} : { read: read.read, reason: read.readError ?? null }),
    message: `board ${parts.join("; ")}`,
  };
}

/** Open tickets by stage name, ordered by the contract's slot order for the ticket's team; unmapped
 *  state names follow, alphabetically. Terminal stages are dropped so the board is work only: a stage
 *  in the done or canceled slot, a stage the contract types completed or canceled, and any state the
 *  ticket itself carries a completed or canceled `state_type` for (Duplicate is canceled-typed and
 *  sits in no slot). `counts` covers every row; `byStage` lists the first `perColumn` per stage. */
function groupByStage(rows, doc, teamKey, perColumn) {
  const order = [];
  const seen = new Set();
  const terminal = new Set();
  for (const t of doc.teams ?? []) {
    if (teamKey && String(t.key ?? "").toUpperCase() !== teamKey.toUpperCase())
      continue;
    for (const slot of doc.slots ?? []) {
      const s = t.stages?.[slot];
      if (!s?.name) continue;
      if (
        slot === "done" ||
        slot === "canceled" ||
        TERMINAL_TYPES.has(String(s.type ?? "").toLowerCase())
      )
        terminal.add(s.name);
      else if (!seen.has(s.name)) {
        seen.add(s.name);
        order.push(s.name);
      }
    }
  }
  for (const r of rows)
    if (TERMINAL_TYPES.has(String(r.state_type ?? "").toLowerCase()))
      terminal.add(String(r.state ?? "unknown"));
  const counts = {};
  const byStage = {};
  for (const r of rows) {
    const state = String(r.state ?? "unknown");
    if (terminal.has(state)) continue;
    counts[state] = (counts[state] ?? 0) + 1;
    const cards = (byStage[state] ??= []);
    if (cards.length >= perColumn) continue;
    cards.push({
      identifier: r.identifier,
      title: r.title,
      priority: r.priority ?? null,
      assignee: r.assignee_name ?? r.assignee ?? null,
      updatedAt: r.updated_at ?? null,
      projectId: r.project_id ?? null,
    });
  }
  const extra = Object.keys(byStage)
    .filter((s) => !seen.has(s))
    .sort();
  const stageOrder = [...order.filter((s) => !terminal.has(s)), ...extra];
  return {
    stageOrder,
    counts: Object.fromEntries(stageOrder.map((s) => [s, counts[s] ?? 0])),
    byStage,
    terminalStagesDropped: [...terminal],
  };
}
