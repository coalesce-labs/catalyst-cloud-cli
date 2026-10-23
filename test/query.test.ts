// query.test.ts — a fresh replica is chosen and the stderr line says so; a stale one falls back to
// the API and says so; --source forces each; `issue` has the same keys from both sources; `changes`
// hits /api/v1/changes?since=.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { main } from "../src/cli";
import { applyFilters, rowsOf, summaryLine } from "../src/query";
import {
  fixtureIssues,
  manyIssues,
  startMeFixture,
  type FixtureServer,
} from "./fixture";
import {
  makeCtx,
  seedJoined,
  seedReplica,
  tempHome,
  type TestCtx,
} from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

const REPLICA_ISSUES = [
  {
    id: "lin-eng-1",
    identifier: "ENG-1",
    title: "Title of ENG-1",
    state: "Todo",
    team_id: "team-eng",
    project_id: "proj-a",
    priority: 2,
  },
  {
    id: "lin-eng-2",
    identifier: "ENG-2",
    title: "Title of ENG-2",
    state: "In Progress",
    team_id: "team-eng",
    project_id: "proj-a",
    priority: 1,
  },
  {
    id: "lin-ops-1",
    identifier: "OPS-1",
    title: "Title of OPS-1",
    state: "Todo",
    team_id: "team-ops",
    project_id: "proj-b",
  },
];

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.requests.length = 0;
});

describe("source selection", () => {
  test("an existing fresh replica does not replace the default cloud read", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
    });
    expect(await main(["query", "issues", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (cloud reads by default)");
    const rows = JSON.parse(ctx.out.join("\n")) as { identifier: string }[];
    expect(rows.map((r) => r.identifier).sort()).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-7",
      "ENG-8",
      "ENG-9",
      "OPS-1",
    ]);
    expect(
      server.requests.filter((r) => r.path.startsWith("/api/v1/issues")),
    ).toHaveLength(1);
  });
  test("a stale replica leaves default cloud reads unchanged", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 60_000,
      issues: REPLICA_ISSUES,
    });
    expect(await main(["query", "issues", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (cloud reads by default)");
    expect(
      server.requests.filter((r) => r.path.startsWith("/api/v1/issues")),
    ).toHaveLength(1);
  });
  test("default cloud reads work without a replica; no config is exit 2", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "issues"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (cloud reads by default)");
    expect(ctx.out.length).toBeGreaterThan(0);
    expect(ctx.out[0]).toMatch(/^ENG-1  Todo  Title of ENG-1/);
    const c2 = makeCtx(tempHome());
    expect(await main(["query", "issues"], c2)).toBe(2);
    expect(c2.err.join("\n")).toContain("not connected");
  });
  test("--source forces each; forcing the replica when absent is a usage error", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 60_000,
      issues: REPLICA_ISSUES,
    });
    expect(
      await main(["query", "issues", "--source", "replica", "--json"], ctx),
    ).toBe(0);
    expect(ctx.err[0]).toBe("source: replica (--source replica)");
    const c2 = makeCtx(home);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      dbPath: `${home}/.config/catalyst-cloud/replica.db`,
    }).catch(() => {});
    expect(
      await main(["query", "issues", "--source", "api", "--json"], c2),
    ).toBe(0);
    expect(c2.err[0]).toBe("source: api (--source api)");
    const c3 = makeCtx(home);
    expect(await main(["query", "issues", "--source", "wat"], c3)).toBe(1);
  });
  test("api-only subcommands name why", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
    });
    expect(await main(["query", "cycles", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (cycles is api-only)");
  });
});

describe("subcommands", () => {
  test("issue <id> has the same keys from both sources", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
    });
    expect(
      await main(
        ["query", "issue", "ENG-1", "--source", "replica", "--json"],
        ctx,
      ),
    ).toBe(0);
    const fromReplica = JSON.parse(ctx.out.join("\n")) as Record<
      string,
      unknown
    >;
    const c2 = makeCtx(home);
    expect(
      await main(["query", "issue", "ENG-1", "--source", "api", "--json"], c2),
    ).toBe(0);
    const fromApi = JSON.parse(c2.out.join("\n")) as Record<string, unknown>;
    for (const key of Object.keys(fromReplica))
      expect(fromApi, `api detail must carry ${key}`).toHaveProperty(key);
    expect(fromReplica.identifier).toBe("ENG-1");
    expect(fromApi.identifier).toBe("ENG-1");
    expect(Array.isArray(fromReplica.comments)).toBe(true);
    expect(Array.isArray(fromApi.comments)).toBe(true);
  });
  test("API detail reports the open inbound ask and excludes the completed ask", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "issue", "ENG-1", "--source", "api", "--json"], ctx)).toBe(0);
    const detail = JSON.parse(ctx.out.join("\n"));
    expect(detail.blocked_by).toEqual([
      expect.objectContaining({ identifier: "ENG-7", is_ask: true, unresolved: false }),
    ]);
    const unblocked = makeCtx(home);
    expect(await main(["query", "issue", "OPS-1", "--source", "api", "--json"], unblocked)).toBe(0);
    expect(JSON.parse(unblocked.out.join("\n")).blocked_by).toEqual([]);
  });
  test("an unknown issue is exit 1 from either source", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
    });
    expect(
      await main(["query", "issue", "ENG-999", "--source", "replica"], ctx),
    ).toBe(1);
    expect(
      await main(
        ["query", "issue", "ENG-999", "--source", "api"],
        makeCtx(home),
      ),
    ).toBe(1);
  });
  test("filters: --team and --project on the replica", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
    });
    expect(
      await main(
        ["query", "issues", "--source", "replica", "--team", "OPS", "--json"],
        ctx,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(ctx.out.join("\n")) as { identifier: string }[]).map(
        (r) => r.identifier,
      ),
    ).toEqual(["OPS-1"]);
    const c2 = makeCtx(home);
    expect(
      await main(
        [
          "query",
          "issues",
          "--source",
          "replica",
          "--project",
          "proj-a",
          "--json",
        ],
        c2,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(c2.out.join("\n")) as { identifier: string }[]).length,
    ).toBe(2);
  });
  test("pulls, pull, projects, search, cycles from the API", async () => {
    await seedJoined(home, server);
    expect(
      await main(["query", "pulls", "--ticket", "ENG-2", "--json"], ctx),
    ).toBe(0);
    expect(
      (JSON.parse(ctx.out.join("\n")) as { number: number }[])[0]?.number,
    ).toBe(41);
    const c2 = makeCtx(home);
    expect(
      await main(["query", "pull", "PR_kwDOfixture41", "--json"], c2),
    ).toBe(0);
    expect(
      (JSON.parse(c2.out.join("\n")) as { reviews: unknown[] }).reviews,
    ).toHaveLength(1);
    const c3 = makeCtx(home);
    expect(await main(["query", "projects"], c3)).toBe(0);
    expect(c3.out.join("\n")).toContain("Project A");
    const c4 = makeCtx(home);
    expect(await main(["query", "search", "widget"], c4)).toBe(0);
    const found = c4.out.join("\n");
    expect(found).toContain("ENG-7");
    // CTC-4303: pulls, projects and initiatives the hub found come back too, each named by kind.
    expect(found).toContain("pull        #41  Widget pull  (acme/app)");
    expect(found).toContain("project     Widget project");
    expect(found).toContain("initiative  Widget initiative");
    const c4j = makeCtx(home);
    expect(await main(["query", "search", "widget", "--json"], c4j)).toBe(0);
    const kinds = (JSON.parse(c4j.out.join("\n")) as { kind: string }[]).map(
      (r) => r.kind,
    );
    expect(new Set(kinds)).toEqual(
      new Set(["issue", "pull", "project", "initiative"]),
    );
    const c5 = makeCtx(home);
    expect(await main(["query", "cycles"], c5)).toBe(0);
    expect(c5.out.join("\n")).toContain("cycle 12");
    const c6 = makeCtx(home);
    expect(await main(["query", "pull", "PR_nope"], c6)).toBe(1);
    const c7 = makeCtx(home);
    expect(await main(["query", "search"], c7)).toBe(1);
  });
  test("changes hits /api/v1/changes?since=", async () => {
    await seedJoined(home, server);
    expect(
      await main(["query", "changes", "--since", "3", "--json"], ctx),
    ).toBe(0);
    const req = server.requests.find((r) =>
      r.path.startsWith("/api/v1/changes"),
    );
    expect(req?.path).toContain("since=3");
    // ⛔ The 200 is NDJSON (`streamNdjson`), not JSON. Reading it with getJson made every real
    // success "returned a non-JSON body"; asserting only the exit code would not have noticed,
    // because a refusal IS JSON and the smoke never reached a 200. Assert the parsed rows.
    const body = JSON.parse(ctx.out.join("\n")) as {
      since: number;
      head: number;
      changes: Record<string, unknown>[];
    };
    expect(body.since).toBe(3);
    expect(body.head).toBe(server.headCursor);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      seq: 4,
      entity: "issues",
      entityId: "lin-eng-1",
      op: "upsert",
    });
    expect(await main(["query", "changes"], makeCtx(home))).toBe(1);
  });
  // ⛔ THE CHANGEFEED EVICTS, so `--since 0` — the form the docs show — is a 409 resync envelope on
  // any tenant whose log has rotated, and 0.2.0 surfaced it as a bare "GET /api/v1/changes failed
  // (409)" with no way to learn a cursor that works. The head seq is stamped on the 409 itself
  // (`x-catalyst-head-seq`), so the CLI can always say what to use instead.
  test("an evicted --since says so and names a cursor that works", async () => {
    await seedJoined(home, server);
    expect(
      await main(["query", "changes", "--since", "0", "--json"], ctx),
    ).toBe(1);
    const err = ctx.err.join("\n");
    expect(err).toMatch(/no longer in the change log|evicted/i);
    expect(err).toContain("--since head");
    // The actionable half: the cursor to use, read off the response the refusal itself carried.
    expect(err).toContain(String(server.headCursor));
  });
  test("--since head resolves the live cursor instead of guessing one", async () => {
    await seedJoined(home, server);
    expect(
      await main(["query", "changes", "--since", "head", "--json"], ctx),
    ).toBe(0);
    const asked = server.requests
      .filter((r) => r.path.startsWith("/api/v1/changes"))
      .map((r) => new URL(r.path, "http://x").searchParams.get("since"));
    // The probe learns the head from the header, then the real read asks for it — never "head".
    expect(asked).toContain(String(server.headCursor));
    expect(asked).not.toContain("head");
    expect((JSON.parse(ctx.out.join("\n")) as { since: number }).since).toBe(
      server.headCursor,
    );
  });
  test("a cursor past the head is refused with the same actionable line", async () => {
    await seedJoined(home, server);
    expect(
      await main(["query", "changes", "--since", "99999", "--json"], ctx),
    ).toBe(1);
    expect(ctx.err.join("\n")).toContain("--since head");
  });
  test("missing subcommand or positional is a usage error", async () => {
    await seedJoined(home, server);
    expect(await main(["query"], ctx)).toBe(1);
    expect(await main(["query", "issue"], makeCtx(home))).toBe(1);
    expect(await main(["query", "wat"], makeCtx(home))).toBe(1);
  });
});

describe("pure helpers", () => {
  test("rowsOf accepts bare arrays and wrapped rows", () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsOf({ nope: 1 })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });
  test("applyFilters and summaryLine", () => {
    const rows = [
      { identifier: "ENG-1", state: "Todo", title: "t", team_id: "team-eng" },
      { identifier: "OPS-1", state: "Done", title: "u" },
    ];
    expect(
      applyFilters(rows, { state: "done" }).map((r) => r.identifier),
    ).toEqual(["OPS-1"]);
    expect(applyFilters(rows, { team: "team-eng" })).toHaveLength(1);
    expect(
      summaryLine("pulls", {
        number: 1,
        state: "open",
        merged: 1,
        title: "x",
        node_id: "n",
      }),
    ).toContain("merged");
    expect(summaryLine("projects", { id: "p", state: "s", name: "n" })).toBe(
      "p  s  n",
    );
    expect(summaryLine("other", { a: 1 })).toBe('{"a":1}');
  });
});

describe("more replica reads", () => {
  test("explicit replica reads retain pulls/project filters and limits", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
      pulls: [
        {
          repo_id: "repo-api",
          number: 7,
          node_id: "PR_7",
          title: "seven",
          state: "open",
          linear_issue_identifier: "ENG-1",
        },
      ],
      projects: [
        { id: "proj-a", name: "Project A", state: "started" },
        { id: "proj-z", name: "Project Z", state: "completed" },
      ],
    });
    expect(await main(["query", "pulls", "--source", "replica"], ctx)).toBe(0);
    expect(ctx.err[0]).toMatch(/^source: replica/);
    expect(ctx.out[0]).toContain("#7  open  seven  [PR_7]");
    const c2 = makeCtx(home);
    expect(
      await main(
        [
          "query",
          "projects",
          "--source",
          "replica",
          "--state",
          "completed",
          "--json",
        ],
        c2,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(c2.out.join("\n")) as { id: string }[]).map((p) => p.id),
    ).toEqual(["proj-z"]);
    const c3 = makeCtx(home);
    expect(await main(["query", "issues", "--limit", "1", "--json"], c3)).toBe(
      0,
    );
    expect(JSON.parse(c3.out.join("\n"))).toHaveLength(1);
    const c4 = makeCtx(home);
    expect(await main(["query", "issues", "--limit", "x"], c4)).toBe(1);
    const c5 = makeCtx(home);
    expect(
      await main(
        [
          "query",
          "issues",
          "--source",
          "replica",
          "--state",
          "todo",
          "--team",
          "ENG",
        ],
        c5,
      ),
    ).toBe(0);
    expect(c5.out).toHaveLength(1);
  });
  test("api reads honour --team and --project and the issues summary shows an assignee", async () => {
    await seedJoined(home, server);
    server.issues = [...fixtureIssuesWithAssignee()];
    expect(await main(["query", "issues", "--team", "OPS"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["OPS-1  Todo  Title of OPS-1"]);
    const c2 = makeCtx(home);
    expect(await main(["query", "issues", "--project", "proj-a"], c2)).toBe(0);
    expect(c2.out.some((l) => l.includes("(Ana)"))).toBe(true);
    // A caught-up cursor is the head ITSELF, not some number past it: `buildChanges` uses a strict
    // `since > head` for the resync refusal precisely so the steady-state poll stays a 200. This read
    // used 99 and passed only because the fixture answered every cursor 200.
    const c3 = makeCtx(home);
    expect(
      await main(
        ["query", "changes", "--since", String(server.headCursor), "--json"],
        c3,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(c3.out.join("\n")) as { changes: unknown[] }).changes,
    ).toEqual([]);
  });
});

// CTC-2010 — `query issues|pulls --all` follows the cloud's keyset cursor to the end of the scope,
// and a capped read without `--all` says so on stderr.
describe("--all and truncation", () => {
  afterAll(() => {
    server.pageCap = undefined;
    server.pulls = undefined;
    server.issues = fixtureIssues();
  });

  test("query issues --all follows the cursor to the end of the scope", async () => {
    await seedJoined(home, server);
    server.pageCap = 50;
    server.issues = [...manyIssues(120), ...fixtureIssues()];
    expect(await main(["query", "issues", "--all", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toHaveLength(server.issues.length);
    expect(
      server.requests.filter((r) => r.path.startsWith("/api/v1/issues?"))
        .length,
    ).toBeGreaterThan(1);
    expect(ctx.err[0]).toBe("source: api (--all follows the cloud's pages)");
  });

  test("query pulls --all follows the cursor to the end of the scope", async () => {
    await seedJoined(home, server);
    server.pageCap = 50;
    server.pulls = manyIssues(130).map((row, i) => ({
      ...row,
      node_id: `PR_${i + 1}`,
      number: i + 1,
    }));
    expect(await main(["query", "pulls", "--all", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toHaveLength(130);
    expect(
      server.requests.filter((r) => r.path.startsWith("/api/v1/pulls?")).length,
    ).toBeGreaterThan(1);
  });

  test("without --all, a capped read says `truncated at N of M` on stderr", async () => {
    await seedJoined(home, server);
    server.pageCap = 50;
    server.issues = manyIssues(120);
    expect(
      await main(
        ["query", "issues", "--source", "api", "--limit", "500", "--json"],
        ctx,
      ),
    ).toBe(0);
    expect(ctx.err.join("\n")).toContain("truncated at 50 of 120");
  });

  test("a scope that fits in one page prints no truncation line", async () => {
    await seedJoined(home, server);
    server.pageCap = undefined;
    server.issues = fixtureIssues();
    expect(
      await main(["query", "issues", "--source", "api", "--json"], ctx),
    ).toBe(0);
    expect(ctx.err.join("\n")).not.toMatch(/truncat/i);
  });

  test("--all is refused on a subcommand with no cursor, and beside --source replica", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "projects", "--all"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("only issues and pulls");
    expect(
      await main(
        ["query", "issues", "--all", "--source", "replica"],
        makeCtx(home),
      ),
    ).toBe(1);
  });

  test("--all with --limit says the limit is ignored, and the limit is ignored", async () => {
    await seedJoined(home, server);
    server.pageCap = 50;
    server.issues = manyIssues(120);
    expect(
      await main(["query", "issues", "--all", "--limit", "10", "--json"], ctx),
    ).toBe(0);
    expect(ctx.err.join("\n")).toContain(
      "--all reads the whole scope, so --limit is ignored",
    );
    expect(JSON.parse(ctx.out.join("\n"))).toHaveLength(120);
  });
});

function fixtureIssuesWithAssignee(): Record<string, unknown>[] {
  const rows = fixtureIssues();
  (rows[0] as Record<string, unknown>).assignee_name = "Ana";
  return rows;
}

// CTC-4556 — `--team CTC --state Implement --limit 5` printed nothing over "truncated at 5 of 8541":
// the CLI sent `team` and `state`, which the mirror does not narrow by, then filtered a page of the
// newest rows. Filters now ride as `team_key` and `state_name`, and a page the cloud did not narrow
// is refused rather than printed.
describe("issue filters narrow on the server", () => {
  afterAll(() => {
    server.pageCap = undefined;
    server.legacyIssueScope = undefined;
    server.issues = fixtureIssues();
  });

  test("--team and --state reach the server as team_key and state_name, and the page is that scope", async () => {
    await seedJoined(home, server);
    server.pageCap = 5;
    // 120 newer Todo rows first: a page of the newest rows holds no In Progress issue.
    server.issues = [...manyIssues(120), ...fixtureIssues()];
    expect(
      await main(
        [
          "query",
          "issues",
          "--team",
          "ENG",
          "--state",
          "in progress",
          "--limit",
          "5",
          "--source",
          "api",
          "--json",
        ],
        ctx,
      ),
    ).toBe(0);
    const rows = JSON.parse(ctx.out.join("\n")) as { identifier: string }[];
    expect(rows.map((r) => r.identifier)).toEqual(["ENG-2"]);
    const sent = server.requests.find((r) =>
      r.path.startsWith("/api/v1/issues?"),
    );
    const params = new URL(`http://x${sent?.path}`).searchParams;
    expect(params.get("team_key")).toBe("ENG");
    expect(params.get("state_name")).toBe("in progress");
    expect(params.has("team")).toBe(false);
    expect(params.has("state")).toBe(false);
  });

  test.each([
    [["--state", "Todo"], "--state"],
    [["--team", "ENG"], "--team"],
    [["--all", "--state", "Todo"], "--state"],
  ])(
    "a cloud that does not report narrowing %j is refused, not printed",
    async (flags, named) => {
      await seedJoined(home, server);
      server.legacyIssueScope = true;
      expect(
        await main(
          ["query", "issues", ...flags, "--source", "api", "--json"],
          ctx,
        ),
      ).toBe(1);
      expect(ctx.out).toEqual([]);
      expect(ctx.err.join("\n")).toContain(`the cloud did not apply ${named}`);
    },
  );

  test("padded --team and --state are trimmed before they are sent, and match without regard to case", async () => {
    await seedJoined(home, server);
    server.legacyIssueScope = undefined;
    expect(
      await main(
        ["query", "issues", "--team", "  eng ", "--state", "  IN PROGRESS ", "--source", "api", "--json"],
        ctx,
      ),
    ).toBe(0);
    expect((JSON.parse(ctx.out.join("\n")) as { identifier: string }[]).map((r) => r.identifier)).toEqual([
      "ENG-2",
    ]);
    const sent = server.requests.filter((r) => r.path.startsWith("/api/v1/issues?")).at(-1);
    const params = new URL(`http://x${sent?.path}`).searchParams;
    expect(params.get("team_key")).toBe("eng");
    expect(params.get("state_name")).toBe("IN PROGRESS");
  });

  test("In_Progress is a different state name from In Progress", async () => {
    await seedJoined(home, server);
    server.legacyIssueScope = undefined;
    expect(
      await main(["query", "issues", "--state", "In_Progress", "--source", "api", "--json"], ctx),
    ).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual([]);
  });

  test("with no filter, a cloud without the scope header is still read", async () => {
    await seedJoined(home, server);
    server.legacyIssueScope = true;
    expect(
      await main(["query", "issues", "--source", "api", "--json"], ctx),
    ).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).not.toHaveLength(0);
  });
});
