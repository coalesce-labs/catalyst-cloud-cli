// write.test.ts — every write reads the route table (the fixture's unusual prefix proves it),
// --bookkeeping prefixes the contract's marker, state moves resolve by slot and by state type, labels
// resolve by name, a 429 names hostDailyWriteBudget, and the ask verbs post what the route expects.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { rankAsks } from "../src/ask";
import { firstStateOfType } from "../src/write";
import { buildFixtureContract, FIXTURE_ROUTE_PREFIX } from "./fixture-contract";
import { fixtureIssues, startMeFixture, type FixtureServer } from "./fixture";
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
  server.writes.length = 0;
  server.budgetExhausted = false;
  server.agentWriteReply = undefined;
  server.issues = fixtureIssues();
  await seedJoined(home, server);
});

describe("write", () => {
  test("comment posts to the fixture contract's unusual comment path with the resolved issue id", async () => {
    expect(await main(["write", "comment", "ENG-1", "--body", "hello"], ctx)).toBe(0);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/issue-comment`);
    expect(server.writes[0]!.body).toEqual({ issueId: "lin-eng-1", body: "hello" });
    expect(ctx.out.join("\n")).toMatch(/^comment: ok \(lin-issue-comment-1\)/);
  });
  test("--bookkeeping prefixes the vocabulary marker; --parent and --as-user ride along; --stdin reads the body", async () => {
    expect(await main(["write", "comment", "ENG-1", "--body", "merged", "--bookkeeping", "--parent", "c-1", "--as-user"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ issueId: "lin-eng-1", body: "[bookkeeping-fixture] merged", parentId: "c-1", createAsUser: true });
    const c2 = makeCtx(home);
    expect(await main(["write", "comment", "ENG-1", "--stdin", "--json"], c2, { write: { readStdin: async () => "from stdin\n" } })).toBe(0);
    expect(server.writes[1]!.body).toEqual({ issueId: "lin-eng-1", body: "from stdin" });
    expect(JSON.parse(c2.out.join("\n"))).toMatchObject({ id: "lin-issue-comment-2" });
    expect(await main(["write", "comment", "ENG-1"], makeCtx(home))).toBe(1);
  });
  test("state --slot pr posts the team's pr stateId; --state-type backlog posts the workflow-stages id; --state-id passes through", async () => {
    expect(await main(["write", "state", "ENG-1", "--slot", "pr"], ctx)).toBe(0);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/issue-state`);
    expect(server.writes[0]!.body).toEqual({ issueId: "lin-eng-1", stateId: "state-pr-x7" });
    expect(await main(["write", "state", "ENG-1", "--state-type", "backlog"], makeCtx(home))).toBe(0);
    expect(server.writes[1]!.body).toEqual({ issueId: "lin-eng-1", stateId: "state-backlog-eng" });
    expect(await main(["write", "state", "OPS-1", "--state-type", "backlog"], makeCtx(home))).toBe(0);
    expect(server.writes[2]!.body).toEqual({ issueId: "lin-ops-1", stateId: "state-backlog-ops" });
    expect(await main(["write", "state", "ENG-1", "--state-id", "raw-id"], makeCtx(home))).toBe(0);
    expect(server.writes[3]!.body).toEqual({ issueId: "lin-eng-1", stateId: "raw-id" });
    expect(await main(["write", "state", "ENG-1"], makeCtx(home))).toBe(1);
    const c = makeCtx(home);
    expect(await main(["write", "state", "OPS-1", "--slot", "pr"], c)).toBe(2);
    expect(c.err.join("\n")).toMatch(/not mapped/);
    expect(await main(["write", "state", "ENG-1", "--state-type", "frozen"], makeCtx(home))).toBe(2);
  });
  test("label --add <name> posts the resolved id; --remove posts a second call; an absent label refuses", async () => {
    expect(await main(["write", "label", "ENG-1", "--add", "catalyst-ask", "--remove", LABEL_UUID], ctx)).toBe(0);
    expect(server.writes.map((w) => w.body)).toEqual([
      { issueId: "lin-eng-1", labelIds: ["label-ask-unscoped"], mode: "add" },
      { issueId: "lin-eng-1", labelIds: [LABEL_UUID], mode: "remove" },
    ]);
    expect(await main(["write", "label", "ENG-1"], makeCtx(home))).toBe(1);
    const c = makeCtx(home);
    expect(await main(["write", "label", "ENG-1", "--add", "catalyst-not-an-ask"], c)).toBe(2);
    expect(c.err.join("\n")).toMatch(/absent/);
  });
  test("create, reaction, attachment and session post their bodies", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "New", "--label", "catalyst-ask", "--priority", "2"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ teamId: "team-eng", title: "New", labelIds: ["label-ask-unscoped"], priority: 2 });
    expect(await main(["write", "reaction", "ENG-1", "--emoji", "👀"], makeCtx(home))).toBe(0);
    expect(server.writes[1]!.body).toEqual({ emoji: "👀", issueId: "lin-eng-1" });
    expect(await main(["write", "reaction", "--comment", "c-9", "--emoji", "👍"], makeCtx(home))).toBe(0);
    expect(server.writes[2]!.body).toEqual({ emoji: "👍", commentId: "c-9" });
    expect(await main(["write", "attachment", "ENG-1", "--title", "PR", "--url", "https://x/1"], makeCtx(home))).toBe(0);
    expect(server.writes[3]!.body).toEqual({ issueId: "lin-eng-1", title: "PR", url: "https://x/1" });
    writeFileSync(`${home}/plan.json`, JSON.stringify([{ content: "research", status: "inProgress" }]));
    expect(await main(["write", "session", "ENG-1", "--title", "Relay", "--plan-file", `${home}/plan.json`, "--activity", "started"], makeCtx(home))).toBe(0);
    expect(server.writes[4]!.body).toEqual({ issueId: "lin-eng-1", title: "Relay", plan: [{ content: "research", status: "inProgress" }], activity: "started" });
    expect(server.writes.every((w) => w.path.startsWith(FIXTURE_ROUTE_PREFIX))).toBe(true);
    expect(await main(["write", "create", "--title", "x"], makeCtx(home))).toBe(1);
    expect(await main(["write", "reaction", "ENG-1"], makeCtx(home))).toBe(1);
    expect(await main(["write", "attachment", "ENG-1"], makeCtx(home))).toBe(1);
    expect(await main(["write", "delegate"], makeCtx(home))).toBe(1);
    expect(await main(["write", "wat"], makeCtx(home))).toBe(1);
    expect(await main(["write"], makeCtx(home))).toBe(1);
  });
  test("an unknown ticket is exit 2; a 429 exits 2 naming hostDailyWriteBudget", async () => {
    expect(await main(["write", "comment", "ENG-404", "--body", "x"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toMatch(/ENG-404 is not in the mirror/);
    server.budgetExhausted = true;
    const c = makeCtx(home);
    expect(await main(["write", "comment", "ENG-1", "--body", "x"], c)).toBe(2);
    expect(c.err.join("\n")).toMatch(/write budget/);
    expect(c.err.join("\n")).toMatch(/hostDailyWriteBudget is 3000/);
    expect(c.err.join("\n")).toMatch(/retry after 3600s/);
  });
  test("⭐ a personal key posts through the proxy like any other (CTC-2076)", async () => {
    await seedJoined(home, server, { config: { key: "fixture-user-key" } });
    const code = await main(["write", "comment", "ENG-1", "--body", "x"], ctx);
    expect(code).toBe(0);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.headers.authorization).toBe("Bearer fixture-user-key");
  });
});

// CTC-5871 — the mirror's own rule (CTC-5566): a labelIds entry that is not a UUID is a 400 naming
// labelNames. The mock answers exactly that, so the pre-fix CLI (every value in labelIds) goes red here.
const LABEL_UUID = "0f8e5a3c-1b2d-4c6e-9a7b-3d5f7e9a1c2b";
const MIRROR_LABEL_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function mirrorLabelRule(name: string, body: unknown): { status: number; body: unknown } | undefined {
  if (name !== "issue-label" && name !== "issue-create") return undefined;
  // The fixture contract's preferred ids (`label-…`) stand in for the UUIDs a real contract carries.
  const ids = ((body as { labelIds?: string[] }).labelIds ?? []).filter((id) => !MIRROR_LABEL_ID_SHAPE.test(id) && !id.startsWith("label-"));
  if (ids.length === 0) return undefined;
  return { status: 400, body: { outcome: "rejected", reason: `labelIds entry "${ids[0]}" is not a label ID (a UUID); send a label by its name in labelNames` } };
}

describe("write labels by name or id (CTC-5871)", () => {
  beforeEach(() => {
    server.agentWriteReply = mirrorLabelRule;
  });
  test("create --label Bug sends Bug in labelNames and succeeds", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--priority", "4", "--label", "Bug", "--description", "d", "--json"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ teamId: "team-eng", title: "T", description: "d", labelNames: ["Bug"], priority: 4 });
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ id: "lin-issue-create-1" });
  });
  test("label --add Bug sends Bug in labelNames; --remove Bug does the same with mode remove", async () => {
    expect(await main(["write", "label", "ENG-1", "--add", "Bug", "--remove", "Feature"], ctx)).toBe(0);
    expect(server.writes.map((w) => w.body)).toEqual([
      { issueId: "lin-eng-1", labelNames: ["Bug"], mode: "add" },
      { issueId: "lin-eng-1", labelNames: ["Feature"], mode: "remove" },
    ]);
    expect(ctx.out).toEqual(["label: ok"]);
  });
  test("a UUID goes in labelIds on create, add and remove", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--label", LABEL_UUID.toUpperCase()], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ teamId: "team-eng", title: "T", labelIds: [LABEL_UUID.toUpperCase()] });
    expect(await main(["write", "label", "ENG-1", "--add", LABEL_UUID, "--remove", LABEL_UUID], makeCtx(home))).toBe(0);
    expect(server.writes.slice(1).map((w) => w.body)).toEqual([
      { issueId: "lin-eng-1", labelIds: [LABEL_UUID], mode: "add" },
      { issueId: "lin-eng-1", labelIds: [LABEL_UUID], mode: "remove" },
    ]);
  });
  test("mixed values split: contract-known name → its id, UUID → labelIds, other names → labelNames", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--label", "Bug", "--label", "catalyst-ask", "--label", LABEL_UUID, "--label", "Customer"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({
      teamId: "team-eng",
      title: "T",
      labelIds: ["label-ask-unscoped", LABEL_UUID],
      labelNames: ["Bug", "Customer"],
    });
    expect(await main(["write", "label", "ENG-1", "--add", "catalyst-ask", "--add", "Bug", "--remove", LABEL_UUID, "--remove", "Feature"], makeCtx(home))).toBe(0);
    expect(server.writes.slice(1).map((w) => w.body)).toEqual([
      { issueId: "lin-eng-1", labelIds: ["label-ask-unscoped"], labelNames: ["Bug"], mode: "add" },
      { issueId: "lin-eng-1", labelIds: [LABEL_UUID], labelNames: ["Feature"], mode: "remove" },
    ]);
  });
  test("a rejected create exits 2; --json prints one JSON error object on stdout and keeps stderr", async () => {
    server.agentWriteReply = () => ({ status: 400, body: { outcome: "rejected", reason: "label Bug is not in team ENG" } });
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--label", "Bug", "--json"], ctx)).toBe(2);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({
      ok: false,
      command: "write create",
      error: { code: "http", status: 400, message: `POST ${FIXTURE_ROUTE_PREFIX}/issue-create failed (400): label Bug is not in team ENG` },
    });
    expect(ctx.err.join("\n")).toMatch(/issue-create failed \(400\): label Bug is not in team ENG/);
    const human = makeCtx(home);
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--label", "Bug"], human)).toBe(2);
    expect(human.out).toEqual([]);
    expect(human.err.join("\n")).toMatch(/issue-create failed \(400\)/);
  });
  test("a rejected add or remove exits 2 with a JSON error on stdout", async () => {
    server.agentWriteReply = (name, body) => ((body as { mode?: string }).mode === "remove" ? { status: 400, body: { outcome: "rejected", reason: "no such label" } } : undefined);
    expect(await main(["write", "label", "ENG-1", "--add", "Bug", "--remove", "Nope", "--json"], ctx)).toBe(2);
    expect(server.writes).toHaveLength(2);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ ok: false, command: "write label", error: { code: "http", status: 400 } });
    server.agentWriteReply = () => ({ status: 400, body: { outcome: "rejected", reason: "no such label" } });
    const c = makeCtx(home);
    expect(await main(["write", "label", "ENG-1", "--add", "Bug", "--json"], c)).toBe(2);
    expect(JSON.parse(c.out[0]!)).toMatchObject({ ok: false, command: "write label", error: { message: expect.stringMatching(/no such label/) } });
  });
  test("a 200 whose body says the label write failed still exits 2", async () => {
    server.agentWriteReply = () => ({ status: 200, body: { outcome: "failed", code: "operation_failed", reason: "one or more label writes failed", results: [] } });
    const c = makeCtx(home);
    expect(await main(["write", "label", "ENG-1", "--add", "Bug", "--json"], c)).toBe(2);
    expect(JSON.parse(c.out[0]!)).toMatchObject({ ok: false, error: { code: "write-failed", status: 200, message: expect.stringMatching(/one or more label writes failed/) } });
    const h = makeCtx(home);
    expect(await main(["write", "label", "ENG-1", "--remove", "Bug"], h)).toBe(2);
    expect(h.err.join("\n")).toMatch(/outcome "failed"/);
  });
});

describe("ask", () => {
  test("raise without --blocks or --nothing-to-block is exit 1 and posts nothing", async () => {
    expect(await main(["ask", "raise", "--team", "ENG", "--title", "Which?"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--blocks/);
    expect(server.writes).toHaveLength(0);
  });
  test("raise with --blocks posts teamId, blocks[] (resolved ids), options and the default", async () => {
    const code = await main(
      ["ask", "raise", "--team", "ENG", "--title", "Which?", "--context", "ctx", "--option", "A", "--option", "B", "--default", "A", "--blocks", "ENG-1", "--blocks", "ENG-2", "--ask-key", "k1"],
      ctx,
    );
    expect(code).toBe(0);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/ask`);
    expect(server.writes[0]!.body).toEqual({ title: "Which?", teamId: "team-eng", context: "ctx", options: ["A", "B"], defaultIfSilent: "A", blocks: ["lin-eng-1", "lin-eng-2"], askKey: "k1" });
    expect(ctx.out.join("\n")).toMatch(/ask raised: ENG-101 \(blocks 2\)/);
  });
  test("raise with --nothing-to-block posts the flag; missing team/title is a usage error", async () => {
    expect(await main(["ask", "raise", "--team", "ENG", "--title", "Which?", "--nothing-to-block", "--json"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ title: "Which?", teamId: "team-eng", nothingToBlock: true });
    expect(await main(["ask", "raise", "--nothing-to-block"], makeCtx(home))).toBe(1);
    expect(await main(["ask"], makeCtx(home))).toBe(1);
    expect(await main(["ask", "wat"], makeCtx(home))).toBe(1);
  });
  test("accept posts the three fields", async () => {
    expect(await main(["ask", "accept", "ENG-7", "--answer", "c-42", "--role", "steward"], ctx)).toBe(0);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/ask-accept`);
    expect(server.writes[0]!.body).toEqual({ askIssueId: "lin-eng-7", answerCommentId: "c-42", acceptedByRole: "steward" });
    expect(ctx.out.join("\n")).toContain("answer c-42 recorded by steward");
    expect(await main(["ask", "accept", "ENG-7"], makeCtx(home))).toBe(1);
  });
  test("list with the cloud account's shared key is every open ask, ranked, and says it names no person", async () => {
    expect(await main(["ask", "list", "--json"], ctx)).toBe(0);
    const { scope, asks } = JSON.parse(ctx.out.join("\n")) as { scope: { kind: string }; asks: { identifier: string; blocks: string[]; score: number }[] };
    expect(scope).toEqual({ kind: "no-person" });
    expect(asks.map((r) => r.identifier)).toEqual(["ENG-7", "ENG-8"]);
    expect(asks[0]).toMatchObject({ blocks: ["ENG-1", "ENG-2"], score: 2 });
    expect(asks[1]).toMatchObject({ blocks: ["ENG-3"], score: 1 });
    const c2 = makeCtx(home);
    expect(await main(["ask", "list"], c2)).toBe(0);
    expect(c2.out[0]).toMatch(/^ENG-7  holds 2 tickets: ENG-1, ENG-2/);
    expect(c2.err.join("\n")).toMatch(/shared key, which names no person/);
    server.issues = [];
    const c3 = makeCtx(home);
    expect(await main(["ask", "list"], c3)).toBe(0);
    expect(c3.out.join("\n")).toBe("no open asks");
  });
  test("⭐ list with a personal key means MINE by default; --anyone widens; an unmatched identity says so (CTC-2077)", async () => {
    await seedJoined(home, server, { config: { key: "fixture-user-key", user: { id: "d1-user-tony", label: "Tony", email: null, role: "admin", linearUserId: "linear-user-tony" } } });
    const c1 = makeCtx(home);
    expect(await main(["ask", "list", "--json"], c1)).toBe(0);
    const mine = JSON.parse(c1.out.join("\n")) as { scope: { kind: string; label?: string }; asks: { identifier: string }[] };
    expect(mine.scope).toEqual({ kind: "mine", linearUserId: "linear-user-tony", label: "Tony" });
    expect(mine.asks.map((a) => a.identifier)).toEqual(["ENG-7"]);
    expect(c1.err).toEqual([]);
    const c2 = makeCtx(home);
    expect(await main(["ask", "list", "--anyone", "--json"], c2)).toBe(0);
    const all = JSON.parse(c2.out.join("\n")) as { scope: { kind: string }; asks: { identifier: string }[] };
    expect(all.scope).toEqual({ kind: "anyone" });
    expect(all.asks.map((a) => a.identifier)).toEqual(["ENG-7", "ENG-8"]);
    // Nothing of mine: the line names the wider count so an empty inbox never reads as "nothing needs anyone".
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, assignee_id: "someone-else" } : i));
    const c3 = makeCtx(home);
    expect(await main(["ask", "list"], c3)).toBe(0);
    expect(c3.out.join("\n")).toBe("no open asks assigned to Tony (2 open in your cloud account — add --anyone to see them)");
    // Unmatched Linear identity: the whole list plus one named stderr line, never a silently empty one.
    await seedJoined(home, server, { config: { key: "fixture-user-key", user: { id: "d1-user-tony", label: "Tony", email: null, role: "admin", linearUserId: null } } });
    const c4 = makeCtx(home);
    expect(await main(["ask", "list", "--json"], c4)).toBe(0);
    expect((JSON.parse(c4.out.join("\n")) as { scope: { kind: string } }).scope).toEqual({ kind: "unmatched", label: "Tony" });
    const c5 = makeCtx(home);
    expect(await main(["ask", "list"], c5)).toBe(0);
    expect(c5.err.join("\n")).toMatch(/Linear identity is not matched yet/);
    expect(c5.out.length).toBe(2); // the whole list, never a silently empty one
  });
  test("rankAsks skips blocked tickets that are closed and recognises ask/ prefixed labels", () => {
    const issues = [
      { identifier: "ENG-1", state: "Done", priority: 1 },
      { identifier: "ENG-5", state: "Todo", title: "q", labels: [{ id: "x", name: "ask/decision" }], relations: [{ type: "blocks", issue_identifier: "ENG-5", related_identifier: "ENG-1" }] },
    ];
    const ranked = rankAsks(issues, server.contract, (i) => i.state !== "Done");
    expect(ranked).toEqual([{ identifier: "ENG-5", title: "q", state: "Todo", blocks: [], score: 0, assigneeId: null }]);
  });
  test("firstStateOfType names the types seen when none matches", () => {
    expect(() => firstStateOfType([{ id: "a", name: "A", type: "started", teamId: "t" }], "t", "backlog")).toThrow(/types seen: started/);
  });
});

describe("more write branches", () => {
  test("fetchWorkflowStates reads every shape the route may answer", async () => {
    const { fetchWorkflowStates } = await import("../src/write");
    const fake = (body: unknown) => ({ getJson: async () => ({ status: 200, body, headers: new Headers() }) }) as unknown as Parameters<typeof fetchWorkflowStates>[0];
    expect(await fetchWorkflowStates(fake([{ id: "a", name: "A", type: "backlog", team_id: "t1" }]))).toEqual([{ id: "a", name: "A", type: "backlog", teamId: "t1" }]);
    expect(await fetchWorkflowStates(fake({ stages: [{ id: "b", teamId: "t2" }] }))).toEqual([{ id: "b", name: "", type: "", teamId: "t2" }]);
    expect(await fetchWorkflowStates(fake({ teams: [{ id: "t3", stages: [{ id: "c", type: "started" }] }, { team_id: "t4", states: [{ nope: 1 }] }] }))).toEqual([{ id: "c", name: "", type: "started", teamId: "t3" }]);
    expect(await fetchWorkflowStates(fake("nonsense"))).toEqual([]);
  });
  test("create carries a description from --description or --stdin, and refuses both or an empty stdin", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--description", "Given a\nThen b"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ teamId: "team-eng", title: "T", description: "Given a\nThen b" });
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--stdin"], makeCtx(home), { write: { readStdin: async () => "## Why\n\nbody\n\n" } })).toBe(0);
    expect(server.writes[1]!.body).toEqual({ teamId: "team-eng", title: "T", description: "## Why\n\nbody" });
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--description", "x", "--stdin"], makeCtx(home), { write: { readStdin: async () => "y" } })).toBe(1);
    expect(await main(["write", "create", "--team", "ENG", "--title", "T", "--stdin"], makeCtx(home), { write: { readStdin: async () => "  \n" } })).toBe(1);
    expect(server.writes).toHaveLength(2);
  });
  test("create without options, session with only the ticket, and reaction --as-user post minimal bodies", async () => {
    expect(await main(["write", "create", "--team", "ENG", "--title", "Bare"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ teamId: "team-eng", title: "Bare" });
    expect(await main(["write", "session", "ENG-1", "--url", "https://x/s"], makeCtx(home))).toBe(0);
    expect(server.writes[1]!.body).toEqual({ issueId: "lin-eng-1", url: "https://x/s" });
    expect(await main(["write", "reaction", "ENG-1", "--emoji", "x", "--as-user", "--json"], makeCtx(home))).toBe(0);
    expect(server.writes[2]!.body).toEqual({ emoji: "x", createAsUser: true, issueId: "lin-eng-1" });
    expect(await main(["write", "create", "--team", "ENG", "--title", "x", "--as-user"], makeCtx(home))).toBe(0);
    expect(server.writes[3]!.body).toMatchObject({ createAsUser: true });
    expect(await main(["write", "session"], makeCtx(home))).toBe(1);
    expect(await main(["write", "state"], makeCtx(home))).toBe(1);
    expect(await main(["write", "label"], makeCtx(home))).toBe(1);
    expect(await main(["write", "attachment"], makeCtx(home))).toBe(1);
    expect(await main(["write", "comment"], makeCtx(home))).toBe(1);
  });
  test("a non-budget proxy error passes through unchanged", async () => {
    const { postAgent } = await import("../src/write");
    const { CliError } = await import("../src/errors");
    const failing = { postJson: async () => { throw new CliError("nope", "http", 2, 500); } } as unknown as Parameters<typeof postAgent>[0];
    await expect(postAgent(failing, server.contract, "ask", {})).rejects.toMatchObject({ code: "http" });
  });
});

describe("more ask branches", () => {
  test("too many options is a usage error; accept --json; raise with --json", async () => {
    const options = Array.from({ length: 27 }, (_, i) => ["--option", `o${i}`]).flat();
    expect(await main(["ask", "raise", "--team", "ENG", "--title", "t", "--nothing-to-block", ...options], ctx)).toBe(1);
    const c2 = makeCtx(home);
    expect(await main(["ask", "accept", "ENG-7", "--answer", "c", "--role", "r", "--json"], c2)).toBe(0);
    expect(JSON.parse(c2.out.join("\n"))).toMatchObject({ ok: true });
    const c3 = makeCtx(home);
    expect(await main(["ask", "raise", "--team", "ENG", "--title", "t", "--blocks", "ENG-1", "--json"], c3)).toBe(0);
    expect(JSON.parse(c3.out.join("\n"))).toMatchObject({ identifier: expect.stringMatching(/^ENG-1\d\d$/) });
    expect(await main(["ask", "raise", "--team", "ENG", "--title", "t", "--blocks", "ENG-404"], makeCtx(home))).toBe(2);
  });
  test("rankAsks orders by open tickets blocked, then the oldest ask, never by priority", () => {
    const ask = (identifier: string, created_at: number, blocks: string[]) => ({
      identifier,
      state: "Todo",
      title: identifier,
      created_at,
      labels: [{ id: "label-ask-eng", name: "ask" }],
      relations: blocks.map((b) => ({ type: "blocks", issue_identifier: identifier, related_identifier: b })),
    });
    const issues = [
      { identifier: "ENG-1", state: "Todo", priority: 4 },
      { identifier: "ENG-2", state: "Todo", priority: 4 },
      { identifier: "ENG-3", state: "Todo", priority: 1 },
      ask("ENG-10", 3_000, ["ENG-3"]), // holds one urgent ticket
      ask("ENG-11", 2_000, ["ENG-1", "ENG-2"]), // holds two low ones: first, whatever their priority
      ask("ENG-12", 1_000, ["ENG-1"]), // ties ENG-10 on count and is older, so it goes before it
    ];
    expect(rankAsks(issues, server.contract, () => true).map((a) => a.identifier)).toEqual(["ENG-11", "ENG-12", "ENG-10"]);
  });
  test("rankAsks scores a priority-none ticket like any other and drops non-asks", () => {
    const issues = [
      { identifier: "ENG-1", state: "Todo", priority: 0 },
      { identifier: "ENG-2", state: "Todo", priority: 9 },
      { identifier: "ENG-5", state: "Todo", title: "q", labels: [{ id: "label-ask-eng", name: "other" }], relations: [{ type: "blocks", issue_identifier: "ENG-5", related_identifier: "ENG-1" }, { type: "blocks", issue_identifier: "ENG-5", related_identifier: "ENG-2" }, { type: "related", issue_identifier: "ENG-5", related_identifier: "ENG-3" }] },
      { identifier: "ENG-6", state: "Todo", title: "not an ask", labels: [{ id: "z", name: "bug" }] },
      { identifier: "ENG-7", state: "Todo", title: "no labels" },
    ];
    const ranked = rankAsks(issues, server.contract, () => true);
    expect(ranked).toEqual([{ identifier: "ENG-5", title: "q", state: "Todo", blocks: ["ENG-1", "ENG-2"], score: 2, assigneeId: null }]);
  });
});

// CTC-5044 — an ask can name the PR hold its answer releases. The cloud removes the named labels when
// the ask is answered with a releasing letter, so the CLI refuses what the route would refuse (an
// unknown label, a letter that is not one of the options) before anything is posted.
describe("ask raise --gates-pr (CTC-5044)", () => {
  const base = ["ask", "raise", "--team", "ENG", "--title", "Ship it?", "--context", "c", "--option", "Release the hold", "--option", "Keep it held", "--default", "B", "--blocks", "ENG-1"];
  const oneRepo = async () => {
    const doc = buildFixtureContract();
    doc.merge.repositories = [doc.merge.repositories[0]!];
    server.contract = doc;
    home = tempHome();
    ctx = makeCtx(home);
    await seedJoined(home, server);
  };
  afterEach(() => {
    server.contract = buildFixtureContract();
  });

  test("the flags parse into gates: repo, every PR, every label, every releasing letter", async () => {
    const code = await main([...base, "--gates-repo", "hagale/web", "--gates-pr", "5412", "--gates-pr", "5413", "--gates-label", "hold", "--gates-label", "hold:preview", "--released-by", "A"], ctx);
    expect(code).toBe(0);
    expect(server.writes[0]!.body).toMatchObject({ gates: { repo: "hagale/web", pr: [5412, 5413], labels: ["hold", "hold:preview"], releasedBy: ["A"] } });
  });
  test("one PR is a number, the label defaults to hold, a lowercase letter is uppercased, and the repo defaults to the account's only one", async () => {
    await oneRepo();
    expect(await main([...base, "--gates-pr", "5412", "--released-by", "a"], ctx)).toBe(0);
    expect((server.writes[0]!.body as Record<string, unknown>).gates).toEqual({ repo: "hagale/api", pr: 5412, labels: ["hold"], releasedBy: ["A"] });
  });
  test("without --gates-pr the body carries no gates and is the same as before", async () => {
    expect(await main(base, ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ title: "Ship it?", teamId: "team-eng", context: "c", options: ["Release the hold", "Keep it held"], defaultIfSilent: "B", blocks: ["lin-eng-1"] });
  });
  test("a releasing letter that is not one of the options is refused and posts nothing", async () => {
    expect(await main([...base, "--gates-repo", "hagale/web", "--gates-pr", "5412", "--released-by", "C"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--released-by C is not one of this ask's options \(A, B\)/);
    expect(server.writes).toHaveLength(0);
  });
  test("an unknown label is refused by name and posts nothing", async () => {
    expect(await main([...base, "--gates-repo", "hagale/web", "--gates-pr", "5412", "--gates-label", "hold:hand-steps", "--released-by", "A"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--gates-label hold:hand-steps .*hold, hold:preview/);
    expect(server.writes).toHaveLength(0);
  });
  test("--gates-pr needs --released-by; gates flags without --gates-pr are refused; a PR must be a positive integer", async () => {
    expect(await main([...base, "--gates-repo", "hagale/web", "--gates-pr", "5412"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--released-by/);
    const c2 = makeCtx(home);
    expect(await main([...base, "--released-by", "A"], c2)).toBe(1);
    expect(c2.err.join("\n")).toMatch(/only with --gates-pr/);
    const c3 = makeCtx(home);
    expect(await main([...base, "--gates-repo", "hagale/web", "--gates-pr", "#12", "--released-by", "A"], c3)).toBe(1);
    expect(c3.err.join("\n")).toMatch(/--gates-pr must be a PR number/);
    expect(server.writes).toHaveLength(0);
  });
  test("the repo must be named when the account has several, and must be one the account registers", async () => {
    expect(await main([...base, "--gates-pr", "5412", "--released-by", "A"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--gates-repo <owner\/name>.*hagale\/api, hagale\/web/);
    const c2 = makeCtx(home);
    expect(await main([...base, "--gates-repo", "hagale/nope", "--gates-pr", "5412", "--released-by", "A"], c2)).toBe(1);
    expect(c2.err.join("\n")).toMatch(/hagale\/nope is not a repository this account registers/);
    expect(server.writes).toHaveLength(0);
  });
});
