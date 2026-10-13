// snapshot-script.test.ts — CTC-2010: a board read is a window on purpose (`--limit` stays 200),
// but a window the cloud cut short must say so rather than reading as the whole team. Modelled on
// unstick-script.test.ts: a real `node` process, a home holding a customer.json, and a stand-in CLI
// at the recorded cliPath that answers each verb with JSON (and, for `query issues`, the two stderr
// lines the real CLI now prints).
//
// CTC-5622: the board reads the whole scope through `query issues --all`, counts every open ticket
// per column, lists at most `--limit` cards per column and says so at the top level, and drops
// canceled-type states (Duplicate) the contract has no slot for. Terminal is judged per ticket —
// the ticket's own `state_type`, or its OWN team's contract — so one team's completed `Review`
// never blacklists another team's open `Review`.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(
  here,
  "..",
  "skills",
  "whats-happening",
  "scripts",
  "snapshot.mjs",
);

function fakeCli(dir: string, replicaUnavailable = false): string {
  const path = join(dir, "fake-cli.mjs");
  writeFileSync(
    path,
    [
      "const a = process.argv.slice(2);",
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(a) + "\\n");`,
      'if (a[0] === "contract") { console.log(JSON.stringify({ contractVersion: "1.0.0", account: {}, slots: [], teams: [] })); process.exit(0); }',
      replicaUnavailable
        ? 'if (a[0] === "replica") { console.error("local replica is unavailable"); process.exit(9); }'
        : 'if (a[0] === "replica" && a[1] === "status") { console.log(JSON.stringify({ verdict: "fresh", cursor: 10, heartbeatAgeMs: 0 })); process.exit(0); }',
      'if (a[0] === "running") { console.log(JSON.stringify({})); process.exit(0); }',
      'if (a[0] === "queue") { console.log(JSON.stringify({})); process.exit(0); }',
      'if (a[0] === "ask" && a[1] === "list") { console.log(JSON.stringify({ asks: [] })); process.exit(0); }',
      // The real CLI prints a truncation line only for a single page; `--all` reads to the end or fails.
      'if (a[0] === "query" && a[1] === "issues" && a.includes("--all")) { console.error("GET /api/v1/issues still had pages after 100 of them (50000 rows)"); process.exit(1); }',
      'if (a[0] === "query" && a[1] === "issues") { process.stderr.write("source: api (--source api)\\ntruncated at 50 of 120 — re-run with --all to read the whole scope\\n"); console.log(JSON.stringify([])); process.exit(0); }',
      "process.exit(9);",
    ].join("\n"),
  );
  return path;
}

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "snapshot-script-"));
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify(config),
  );
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CATALYST_SKILLS_HOME: home },
  });
}

interface BoardOut {
  source: { board?: string; boardTruncated?: string };
  board: {
    stageOrder: string[];
    counts: Record<string, number>;
    byStage: Record<string, unknown[]>;
    terminalStagesDropped: string[];
  };
  boardTruncated?: {
    returned: number;
    total: number;
    perColumn: number;
    countsComplete: boolean;
    read?: { returned: number; total: number | null };
    reason?: string | null;
    message: string;
  };
}

/** n tickets in one state, as `/issues` rows carry them (state name plus Linear's state type). */
function issues(state: string, stateType: string, n: number, team = "CQD") {
  const prefix = state.replace(/\W/g, "").slice(0, 3).toUpperCase();
  return Array.from({ length: n }, (_, i) => ({
    identifier: `${team}-${prefix}${i}`,
    title: `${state} ${i}`,
    state,
    state_type: stateType,
    team_key: team,
    updated_at: new Date(Date.UTC(2026, 9, 10) - i * 60_000).toISOString(),
  }));
}

/** CQD's contract: Backlog is not a slot, so it is mapped by name here only to fix the order;
 *  Duplicate has no slot at all, which is the point of the canceled-type case. */
const CQD_CONTRACT = {
  contractVersion: "1.0.0",
  account: {},
  slots: ["backlog", "todo", "inProgress", "done", "canceled"],
  teams: [
    {
      key: "CQD",
      stages: {
        backlog: { name: "Backlog", type: "backlog" },
        todo: { name: "Todo", type: "unstarted" },
        inProgress: { name: "In Progress", type: "started" },
        done: { name: "Done", type: "completed" },
        canceled: { name: "Canceled", type: "canceled" },
      },
    },
  ],
};

/** Two teams sharing the state NAME `Review` with opposite terminal types: CQD's `review` slot is
 *  an open work column, while ENG has no slot for Review at all and its Review rows are
 *  completed-typed — the collision the P2 finding reproduced. */
const TWO_TEAM_CONTRACT = {
  contractVersion: "1.0.0",
  account: {},
  slots: ["backlog", "todo", "inProgress", "review", "done", "canceled"],
  teams: [
    {
      key: "CQD",
      stages: {
        backlog: { name: "Backlog", type: "backlog" },
        todo: { name: "Todo", type: "unstarted" },
        inProgress: { name: "In Progress", type: "started" },
        review: { name: "Review", type: "started" },
        done: { name: "Done", type: "completed" },
        canceled: { name: "Canceled", type: "canceled" },
      },
    },
    {
      key: "ENG",
      stages: {
        backlog: { name: "Backlog", type: "backlog" },
        todo: { name: "Todo", type: "unstarted" },
        inProgress: { name: "In Progress", type: "started" },
        done: { name: "Done", type: "completed" },
        canceled: { name: "Canceled", type: "canceled" },
      },
    },
  ],
};

/** The same shared name, but now ENG's done slot itself is named `Review`: contract-terminal for
 *  ENG while CQD keeps it as an open column, so the terminal lookup must be scoped by team. */
const SHARED_NAME_CONTRACT = {
  ...TWO_TEAM_CONTRACT,
  teams: TWO_TEAM_CONTRACT.teams.map((t) =>
    t.key === "ENG"
      ? {
          ...t,
          stages: { ...t.stages, done: { name: "Review", type: "completed" } },
        }
      : t,
  ),
};

/** A stand-in CLI over a row fixture that follows the real `query issues` contract: `--all` returns
 *  every row (or fails as the CLI does past its page ceiling), a single read returns at most one
 *  500-row page and prints the CLI's truncation line when rows remain. */
function boardHome(opts: {
  rows: Record<string, unknown>[];
  refuseAll?: boolean;
  contract?: Record<string, unknown>;
}): string {
  const home = homeWith({ baseUrl: "https://x", account: "tenant-3", key: "ctc_user_x" });
  writeFileSync(join(home, "rows.json"), JSON.stringify(opts.rows));
  const contract = opts.contract ?? CQD_CONTRACT;
  const path = join(home, "fake-cli.mjs");
  writeFileSync(
    path,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const a = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(join(home, "calls.jsonl"))}, JSON.stringify(a) + "\\n");`,
      `if (a[0] === "contract") { console.log(${JSON.stringify(JSON.stringify(contract))}); process.exit(0); }`,
      'if (a[0] === "running" || a[0] === "queue") { console.log("{}"); process.exit(0); }',
      'if (a[0] === "ask" && a[1] === "list") { console.log(JSON.stringify({ asks: [] })); process.exit(0); }',
      'if (a[0] === "query" && a[1] === "issues") {',
      `  const rows = JSON.parse(readFileSync(${JSON.stringify(join(home, "rows.json"))}, "utf8"));`,
      '  if (a.includes("--all")) {',
      opts.refuseAll
        ? '    process.stderr.write("source: api (--source api)\\nGET /api/v1/issues still had pages after 100 of them (50000 rows) — narrow the scope\\n"); process.exit(1);'
        : '    process.stderr.write("source: api (--source api)\\n"); process.stdout.write(JSON.stringify(rows) + "\\n");',
      "  } else {",
      '    const limit = Math.min(Number(a[a.indexOf("--limit") + 1]), 500);',
      "    const page = rows.slice(0, limit);",
      '    process.stderr.write("source: api (--source api)\\n");',
      '    if (rows.length > page.length) process.stderr.write(`truncated at ${page.length} of ${rows.length} — re-run with --all to read the whole scope\\n`);',
      '    process.stdout.write(JSON.stringify(page) + "\\n");',
      "  }",
      "} else process.exitCode = 9;",
    ].join("\n"),
  );
  const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), cliPath: path }),
  );
  return home;
}

function calls(home: string): string[][] {
  return readFileSync(join(home, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("snapshot.mjs --board", () => {
  test("cloud status and board succeed without opening an unavailable local replica", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home, true);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.errors).toBeUndefined();
    expect(out.source.replica).toBe("not-selected");
    const calls: string[][] = readFileSync(join(home, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.some((args) => args[0] === "replica")).toBe(false);
    expect(calls.find((args) => args[0] === "query")).toContain("api");
  });
  test("explicit local diagnostics retain an actual replica refusal", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home, true);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );
    const res = run(home, ["--replica"]);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).errors.replica).toBe(
      "local replica is unavailable",
    );
  });
  test("the board snapshot carries the cloud's truncation line instead of swallowing it", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );

    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    expect(out.source.board).toBe("api (--source api)");
    expect(out.source.boardTruncated).toMatch(/^truncated at \d+ of \d+/);
    // CTC-5622: and the top level says how much of the scope the counts cover.
    expect(out.boardTruncated).toMatchObject({
      countsComplete: false,
      read: { returned: 50, total: 120 },
    });
  });

  test("a board over 500 tickets counts every Todo and Backlog ticket and reports the card truncation at the top level", () => {
    const rows = [
      ...issues("Backlog", "backlog", 712),
      ...issues("Todo", "unstarted", 585),
      ...issues("Done", "completed", 300),
    ];
    const home = boardHome({ rows });
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    expect(out.board.counts).toEqual({ Backlog: 712, Todo: 585, "In Progress": 0 });
    expect(out.board.stageOrder).toEqual(["Backlog", "Todo", "In Progress"]);
    expect(out.board.byStage.Todo).toHaveLength(50);
    expect(out.board.byStage.Backlog).toHaveLength(50);
    expect(out.board.byStage.Done).toBeUndefined();
    expect(out.boardTruncated).toMatchObject({
      returned: 100,
      total: 1297,
      perColumn: 50,
      countsComplete: true,
    });
    expect(out.boardTruncated?.message).toContain("lists 100 of 1,297 open tickets");
    expect(res.stderr).toMatch(/^board truncated: board lists 100 of 1,297/m);
    // The whole scope, through the CLI's own page cursor; never a single capped page.
    const query = calls(home).filter((a) => a[0] === "query");
    expect(query).toHaveLength(1);
    expect(query[0]).toContain("--all");
    expect(query[0]).not.toContain("--limit");
  });

  test("--limit raises the cards per column without changing the counts", () => {
    const home = boardHome({
      rows: [...issues("Todo", "unstarted", 585), ...issues("Backlog", "backlog", 712)],
    });
    const out = JSON.parse(run(home, ["--board", "--limit", "600"]).stdout) as BoardOut;
    expect(out.board.counts).toEqual({ Backlog: 712, Todo: 585, "In Progress": 0 });
    expect(out.board.byStage.Todo).toHaveLength(585);
    expect(out.board.byStage.Backlog).toHaveLength(600);
    expect(out.boardTruncated).toMatchObject({ returned: 1185, total: 1297, perColumn: 600 });
  });

  test("a canceled-type state such as Duplicate is not a board column, even with no slot for it", () => {
    const rows = [
      ...issues("Todo", "unstarted", 3),
      ...issues("Duplicate", "canceled", 4),
      ...issues("Canceled", "canceled", 2),
      ...issues("In Progress", "started", 1),
    ];
    const home = boardHome({ rows });
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    expect(out.board.stageOrder).toEqual(["Backlog", "Todo", "In Progress"]);
    expect(out.board.stageOrder).not.toContain("Duplicate");
    expect(out.board.byStage.Duplicate).toBeUndefined();
    expect(out.board.counts).toEqual({ Backlog: 0, Todo: 3, "In Progress": 1 });
    expect(out.board.terminalStagesDropped).toEqual(
      expect.arrayContaining(["Done", "Canceled", "Duplicate"]),
    );
    // Everything open is listed, so there is nothing to report as left out.
    expect(out.boardTruncated).toBeUndefined();
  });

  test("one team's completed Review never blacklists another team's open Review", () => {
    const rows = [
      ...issues("Todo", "unstarted", 1),
      ...issues("Review", "started", 2), // CQD: open work in a contract slot
      ...issues("Review", "completed", 3, "ENG"), // ENG: terminal rows outside its slots
    ];
    const home = boardHome({ rows, contract: TWO_TEAM_CONTRACT });
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    // CQD's open Review tickets stay on the board, counted and listed.
    expect(out.board.counts).toEqual({
      Backlog: 0,
      Todo: 1,
      "In Progress": 0,
      Review: 2,
    });
    expect(out.board.stageOrder).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Review",
    ]);
    expect(
      (out.board.byStage.Review as { identifier: string }[]).map(
        (c) => c.identifier,
      ),
    ).toEqual(["CQD-REV0", "CQD-REV1"]);
    // ENG's completed Review rows are dropped as terminal, not shown anywhere.
    expect(out.board.terminalStagesDropped).toEqual(
      expect.arrayContaining(["Review"]),
    );
    expect(out.boardTruncated).toBeUndefined();
  });

  test("a terminal contract slot named like another team's open column stays scoped to its team", () => {
    const rows = [
      ...issues("Review", "started", 2), // CQD: open column
      ...issues("Review", "started", 1, "ENG"), // ENG: its contract names the done slot Review
    ];
    const home = boardHome({ rows, contract: SHARED_NAME_CONTRACT });
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    expect(out.board.counts).toEqual({
      Backlog: 0,
      Todo: 0,
      "In Progress": 0,
      Review: 2,
    });
    expect(
      (out.board.byStage.Review as { identifier: string }[]).map(
        (c) => c.identifier,
      ),
    ).toEqual(["CQD-REV0", "CQD-REV1"]);
    expect(out.board.terminalStagesDropped).toEqual(
      expect.arrayContaining(["Review"]),
    );
    expect(out.boardTruncated).toBeUndefined();
  });

  test("when the whole-scope read is refused, one page is read and the partial counts say so at the top level", () => {
    const rows = [...issues("Todo", "unstarted", 585), ...issues("Backlog", "backlog", 712)];
    const home = boardHome({ rows, refuseAll: true });
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as BoardOut;
    expect(out.boardTruncated).toMatchObject({
      countsComplete: false,
      read: { returned: 500, total: 1297 },
      reason: expect.stringContaining("still had pages"),
    });
    expect(out.boardTruncated?.message).toContain("cover only the 500 most recently updated of 1,297 tickets read");
    expect(out.source.boardTruncated).toMatch(/^truncated at 500 of 1297/);
    const query = calls(home).filter((a) => a[0] === "query");
    expect(query.map((a) => a.includes("--all"))).toEqual([true, false]);
    expect(query[1]).toEqual(expect.arrayContaining(["--limit", "500"]));
  });

  test("--team narrows the whole-scope read and the columns to that team", () => {
    const home = boardHome({ rows: issues("Todo", "unstarted", 2) });
    const out = JSON.parse(run(home, ["--board", "--team", "CQD"]).stdout) as BoardOut;
    expect(out.board.counts).toEqual({ Backlog: 0, Todo: 2, "In Progress": 0 });
    const query = calls(home).find((a) => a[0] === "query");
    expect(query).toEqual(expect.arrayContaining(["--all", "--team", "CQD"]));
  });

  test("--limit must be a positive whole number", () => {
    const home = boardHome({ rows: [] });
    const res = run(home, ["--board", "--limit", "0"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--limit must be a positive whole number");
  });
});
