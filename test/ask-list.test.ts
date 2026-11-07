// ask-list.test.ts — CTC-2010 Tier 1, criterion 3: `ask list` reads the whole tenant scope, so an
// ask past the server's page cap still shows up in the inbox and is still scored against the whole
// tenant, not a partial view of what it blocks.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { fixtureIssue, fixtureIssues, manyIssues, startMeFixture, waitingOnMeFixture, type FixtureServer } from "./fixture";
import { openStateFrom, rankAsks } from "../src/ask";
import { FIXTURE_ME_USER } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

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
  server.pageCap = undefined;
  server.issues = fixtureIssues();
  server.meUser = undefined;
  server.waitingOnMe = undefined;
  server.waitingOnMeOrder = undefined;
  server.waitingOnMeEnvelope = undefined;
});

describe("ask list reads the whole scope", () => {
  afterAll(() => {
    server.pageCap = undefined;
    server.issues = fixtureIssues();
  });

  test("the inbox is complete on a tenant past the server's page cap", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = [...manyIssues(600), ...fixtureIssues()];
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    const { asks } = JSON.parse(ctx.out.join("\n")) as { asks: { identifier: string }[] };
    expect(asks.map((a) => a.identifier).sort()).toEqual(["ENG-7", "ENG-8"]);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(2);
  });

  test("a ticket an ask blocks is still scored using the whole tenant, even though the ask sits on a later page than the ticket it blocks", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = [...manyIssues(600), ...fixtureIssues()];
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    const { asks } = JSON.parse(ctx.out.join("\n")) as { asks: { identifier: string; score: number; blocks: string[] }[] };
    const eng7 = asks.find((a) => a.identifier === "ENG-7");
    // fixtureIssues: ENG-7 blocks ENG-1 and ENG-2. The score is the count of open tickets it blocks.
    expect(eng7?.blocks.sort()).toEqual(["ENG-1", "ENG-2"]);
    expect(eng7?.score).toBe(2);
  });

  test("a tenant that fits in one page still makes exactly one request", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = fixtureIssues();
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(1);
  });
});

// ── CTC-5644: a matched person reads their own view, never the whole issue table ──────────────────
const ME = FIXTURE_ME_USER.linearUserId;
const personal = (linearUserId: string | null = ME) => ({
  config: { key: "fixture-user-key", user: { id: "d1-user-tony", label: "Tony", email: null, role: "admin", linearUserId } },
});
type Out = { scope: { kind: string }; asks: { identifier: string; score: number; blocks: string[]; assigneeId: string | null }[] };
const parse = () => JSON.parse(ctx.out.join("\n")) as Out;
const viewReqs = () => server.requests.filter((r) => r.path.startsWith("/api/v1/views/waiting-on-me"));
const walkReqs = () => server.requests.filter((r) => r.path.startsWith("/api/v1/issues"));

describe("ask list reads a matched person's view", () => {
  test("scenario 1: 10,000 issues, 12 mine, one view read and no issues walk", async () => {
    await seedJoined(home, server, personal());
    const asks = Array.from({ length: 12 }, (_, i) =>
      fixtureIssue({
        identifier: `MINE-${i + 1}`,
        assignee_id: ME,
        labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
        relations: [{ type: "blocks", issue_identifier: `MINE-${i + 1}`, related_identifier: `ENG-${i + 1}` }],
      }),
    );
    server.issues = [...manyIssues(10000), ...asks];
    expect(await main(["ask", "list", "--json"], ctx)).toBe(0);
    const out = parse();
    expect(out.scope).toEqual({ kind: "mine", linearUserId: ME, label: "Tony" });
    expect(out.asks).toHaveLength(12);
    expect(viewReqs()).toHaveLength(1);
    expect(Number(new URL(`http://x${viewReqs()[0]!.path}`).searchParams.get("limit"))).toBeLessThanOrEqual(500);
    expect(walkReqs()).toHaveLength(0);
    expect(ctx.err).toEqual([]);
  });

  async function walkOutput(): Promise<string> {
    const c = makeCtx(home);
    server.waitingOnMe = "absent";
    expect(await main(["ask", "list", "--json"], c)).toBe(0);
    server.waitingOnMe = undefined;
    return c.out.join("\n");
  }

  test("scenario 2: the view gives the walk's asks, order, score and blocks", async () => {
    await seedJoined(home, server, personal());
    server.issues = waitingOnMeFixture();
    // today's walk, before looking at the view
    const c0 = makeCtx(home);
    expect(await main(["ask", "list", "--anyone", "--json"], c0)).toBe(0);
    const walk = (JSON.parse(c0.out.join("\n")) as Out).asks.filter((a) => a.assigneeId === ME);
    expect(walk.map((a) => [a.identifier, a.score])).toEqual([["ENG-52", 3], ["ENG-51", 1], ["ENG-53", 1], ["ENG-50", 0]]);
    expect(walk[0]!.blocks).toEqual(["ENG-1", "ENG-2", "ENG-404"]);
    expect(walk[1]!.blocks).toEqual(["ENG-1"]);
    const states = [{ name: "Done", type: "completed" }];
    const direct = rankAsks(server.issues, server.contract, openStateFrom(states)).filter((a) => a.assigneeId === ME);
    for (const knob of [undefined, "reversed", "bare"] as const) {
      server.waitingOnMeOrder = knob === "reversed" ? "reversed" : undefined;
      server.waitingOnMeEnvelope = knob === "bare" ? "bare" : undefined;
      const c = makeCtx(home);
      server.requests.length = 0;
      expect(await main(["ask", "list", "--json"], c)).toBe(0);
      expect((JSON.parse(c.out.join("\n")) as Out).asks).toEqual(walk);
      expect((JSON.parse(c.out.join("\n")) as Out).asks).toEqual(direct);
      expect(walkReqs()).toHaveLength(0);
      expect(c.out.join("\n")).toBe(await walkOutput());
    }
  });

  test("scenario 3: --anyone, unmatched and no-person keep the walk and never call the view", async () => {
    await seedJoined(home, server, personal());
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    expect(viewReqs()).toHaveLength(0);
    expect(walkReqs().filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(1);
    expect(parse().asks.map((a) => a.identifier)).toEqual(["ENG-7", "ENG-8"]);
    await seedJoined(home, server, personal(null));
    server.requests.length = 0;
    const c2 = makeCtx(home);
    expect(await main(["ask", "list", "--json"], c2)).toBe(0);
    expect((JSON.parse(c2.out.join("\n")) as Out).scope.kind).toBe("unmatched");
    expect(viewReqs()).toHaveLength(0);
    expect(walkReqs()).toHaveLength(1);
    await seedJoined(home, server);
    server.requests.length = 0;
    server.pageCap = 500;
    server.issues = [...manyIssues(600), ...fixtureIssues()];
    const c3 = makeCtx(home);
    expect(await main(["ask", "list", "--json"], c3)).toBe(0);
    expect((JSON.parse(c3.out.join("\n")) as Out).scope.kind).toBe("no-person");
    expect(viewReqs()).toHaveLength(0);
    expect(walkReqs().filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(2);
  });

  const fallbacks: [string, () => void][] = [
    ["absent", () => (server.waitingOnMe = "absent")],
    ["no_linear_identity", () => (server.waitingOnMe = { status: 409, body: { error: "no_linear_identity" } })],
    ["503", () => (server.waitingOnMe = { status: 503, body: {} })],
    ["unknown envelope", () => (server.waitingOnMe = { status: 200, body: { nope: 1 } })],
    ["row missing related_state", () => (server.waitingOnMe = { status: 200, body: { rows: [{ identifier: "ENG-7", assignee_id: ME, relations: [{ type: "blocks", issue_identifier: "ENG-7", related_identifier: "ENG-1" }] }] } })],
    ["stale identity", () => (server.meUser = { id: "u", label: "N", email: null, role: "admin", linearUserId: "linear-user-new" })],
  ];
  test.each(fallbacks)("fallback (%s) keeps today's answer", async (_n, arm) => {
    await seedJoined(home, server, personal());
    server.issues = waitingOnMeFixture().concat(
      fixtureIssue({ identifier: "NEW-1", assignee_id: "linear-user-new", labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }] }),
    );
    const base = makeCtx(home);
    expect(await main(["ask", "list", "--anyone", "--json"], base)).toBe(0);
    const expected = JSON.stringify({ scope: { kind: "mine", linearUserId: ME, label: "Tony" }, asks: (JSON.parse(base.out.join("\n")) as Out).asks.filter((a) => a.assigneeId === ME) });
    server.requests.length = 0;
    arm();
    expect(await main(["ask", "list", "--json"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe(expected);
    expect(viewReqs()).toHaveLength(1);
    expect(walkReqs().filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(1);
    expect(ctx.err).toEqual([]);
  });

  test("a 401 on the view surfaces and never walks", async () => {
    await seedJoined(home, server, personal());
    const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname.startsWith("/api/v1/views/")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      return fetch(input, init);
    }) as typeof fetch;
    const c = makeCtx(home, { fetch: f });
    expect(await main(["ask", "list", "--json"], c)).toBe(2);
    expect(c.out).toEqual([]);
    expect(walkReqs()).toHaveLength(0);
  });

  test("a 429 on the view surfaces and never walks", async () => {
    await seedJoined(home, server, personal());
    server.waitingOnMe = { status: 429, body: { error: "rate limited" } };
    expect(await main(["ask", "list", "--json"], ctx)).toBe(2);
    expect(ctx.out).toEqual([]);
    expect(walkReqs()).toHaveLength(0);
  });

  test("text mode: the empty line has no workspace count on the view path, and keeps it on the walk", async () => {
    await seedJoined(home, server, personal());
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, assignee_id: "someone-else" } : i));
    expect(await main(["ask", "list"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("no open asks assigned to Tony (add --anyone to see every open ask in your cloud account)");
    server.waitingOnMe = "absent";
    const c = makeCtx(home);
    expect(await main(["ask", "list"], c)).toBe(0);
    expect(c.out.join("\n")).toBe("no open asks assigned to Tony (2 open in your cloud account — add --anyone to see them)");
    expect(c.err).toEqual([]);
  });

  test("text mode: a stale identity says to log in again, and the list still prints", async () => {
    await seedJoined(home, server, personal());
    server.meUser = { id: "u", label: "N", email: null, role: "admin", linearUserId: "linear-user-new" };
    server.issues = [...fixtureIssues(), fixtureIssue({ identifier: "NEW-1", assignee_id: "linear-user-new", labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }] })];
    expect(await main(["ask", "list"], ctx)).toBe(0);
    expect(ctx.err.join("\n")).toMatch(/different Linear identity for you than this machine recorded at login.*catalyst login/);
    expect(ctx.out.join("\n")).toMatch(/^ENG-7  holds 2 tickets/);
  });
});
