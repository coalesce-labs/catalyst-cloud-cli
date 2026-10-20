// ask-proxy.test.ts — CTC-6279: `ask answer --proxy` records an owner's chat answer through the
// contract's ask-answer-proxy route, refusing locally whatever the cloud would refuse; `ask proxy`
// reads and sets the owner's own switch; `ask disown` takes a proxy answer back. Each refusal the
// cloud answers is one plain sentence and a non-zero exit.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { FIXTURE_ROUTE_PREFIX } from "./fixture-contract";
import { fixtureIssues, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const NOW = new Date("2026-10-20T12:00:00Z");

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

/** A ctx whose fetch answers the two personal routes from `reply`, and passes every other request to
 *  the fixture server. `me` records what reached the personal routes. */
interface MeCall {
  method: string;
  path: string;
  body: unknown;
}
let me: MeCall[];
let reply: (call: MeCall) => { status: number; body: unknown };

function ctxWithMe(): TestCtx {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/api/v1/me/ask-")) {
      const call = { method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined };
      me.push(call);
      const r = reply(call);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  }) as typeof fetch;
  return makeCtx(home, { fetch: fetchImpl, now: () => NOW });
}

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  server.writes.length = 0;
  server.agentWriteReply = undefined;
  server.issues = fixtureIssues();
  me = [];
  reply = () => ({ status: 500, body: {} });
  await seedJoined(home, server);
  ctx = ctxWithMe();
});

const recorded = (askIdentifier = "ENG-7") => () => ({
  status: 200,
  body: { outcome: "recorded", askIdentifier, decisionSummary: "Option C", failedBlockedComments: [], resume: { tickets: [] } },
});

describe("ask answer --proxy", () => {
  test("an option letter is recorded as its index, with where and when the owner said it", async () => {
    server.agentWriteReply = recorded();
    const code = await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "go with C", "--option", "c", "--said-in", "session-42", "--said-at", "2026-10-20T11:58:00Z", "--role", "steward"], ctx);
    expect(code).toBe(0);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/ask-answer-proxy`);
    expect(server.writes[0]!.body).toEqual({
      askIssueId: "ENG-7",
      ownerQuote: "go with C",
      optionIndex: 2,
      saidIn: "session-42",
      saidAtMs: Date.parse("2026-10-20T11:58:00Z"),
      acceptedByRole: "steward",
    });
    expect(ctx.out[0]).toBe('ENG-7 answered C by proxy: "go with C"');
    expect(ctx.out.join("\n")).toContain("catalyst ask disown ENG-7");
  });

  test("A is option 0 and Z is option 25", async () => {
    server.agentWriteReply = recorded();
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "A", "--option", "A", "--said-in", "s"], ctxWithMe())).toBe(0);
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "Z", "--option", "Z", "--said-in", "s"], ctxWithMe())).toBe(0);
    expect(server.writes.map((w) => (w.body as { optionIndex?: number }).optionIndex)).toEqual([0, 25]);
  });

  test("with no --option the quote is a free-text answer, sent as written and said now", async () => {
    server.agentWriteReply = recorded();
    const quote = "  do whichever is cheaper  ";
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", quote, "--said-in", "chan-1"], ctx)).toBe(0);
    expect(server.writes[0]!.body).toEqual({ askIssueId: "ENG-7", ownerQuote: quote, saidIn: "chan-1", saidAtMs: NOW.getTime() });
    expect(ctx.out[0]).toBe(`ENG-7 answered by proxy, in the owner's words: "${quote}"`);
  });

  test("--json prints the cloud's body", async () => {
    server.agentWriteReply = recorded();
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ outcome: "recorded", askIdentifier: "ENG-7", decisionSummary: "Option C" });
  });

  test("a held ticket that missed its note is named; the answer still counts", async () => {
    server.agentWriteReply = () => ({ status: 200, body: { outcome: "recorded", askIdentifier: "ENG-7", decisionSummary: "yes", failedBlockedComments: ["ENG-1"], resume: {} } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("1 held ticket did not get the note");
  });

  test("an owner who has not turned it on: non-zero, and the message names the command the owner runs", async () => {
    server.agentWriteReply = () => ({ status: 409, body: { outcome: "refused", reason: "proxy-answering-off" } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/owner has not turned on answers by proxy.*catalyst ask proxy on/);
  });

  test("a letter past the ask's options names the options it has", async () => {
    server.agentWriteReply = () => ({ status: 409, body: { outcome: "refused", reason: "option-out-of-range", optionCount: 2 } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "C", "--option", "C", "--said-in", "s"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toBe("ENG-7 has options A to B; C is not one of them.");
  });

  test.each([
    ["not-an-ask", "is not an ask"],
    ["already-resolved", "already has an answer"],
    ["proxy-answer-already-recorded", "run it again with the same --quote, --option and --said-at"],
    ["proxy-caller-not-owner", "If it is your ask, check that your Linear identity is matched: catalyst identity linear status"],
    ["already-in-flight", "being recorded right now"],
    ["something-new", "refused (something-new)"],
  ])("refusal %s is one plain sentence and exit 1", async (reason, says) => {
    server.agentWriteReply = () => ({ status: 409, body: { outcome: "refused", reason } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain(says);
  });

  test("a failed record exits non-zero and names the --said-at that finishes the same answer", async () => {
    server.agentWriteReply = () => ({ status: 502, body: { outcome: "record-failed", reason: "linear-unavailable" } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s"], ctx)).toBe(2);
    const saidAt = new Date((server.writes[0]!.body as { saidAtMs: number }).saidAtMs).toISOString();
    const out = ctx.out.join("\n");
    expect(out).toContain(`did not finish recording (linear-unavailable)`);
    expect(out).toContain(`--said-at ${saidAt}`);
    expect(out).not.toContain("Nothing changed");
  });

  test("a failed record in --json carries the said-at to retry with", async () => {
    server.agentWriteReply = () => ({ status: 502, body: { outcome: "record-failed", reason: "linear-unavailable" } });
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s", "--said-at", "2026-10-20T11:55:00Z", "--json"], ctx)).toBe(2);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual({ outcome: "record-failed", reason: "linear-unavailable", retrySaidAt: "2026-10-20T11:55:00.000Z" });
  });

  test("a lowercase ask identifier is sent as the cloud writes it", async () => {
    server.agentWriteReply = recorded("ENG-7");
    expect(await main(["ask", "answer", "eng-7", "--proxy", "--quote", "yes", "--said-in", "s"], ctx)).toBe(0);
    expect((server.writes[0]!.body as { askIssueId: string }).askIssueId).toBe("ENG-7");
  });

  test("without --proxy it refuses and points at ask accept, before anything is sent", async () => {
    expect(await main(["ask", "answer", "ENG-7", "--quote", "yes", "--said-in", "s"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("needs --proxy");
    expect(ctx.err.join("\n")).toContain("catalyst ask accept <ask> --answer <commentId>");
    expect(server.writes).toHaveLength(0);
  });

  test.each([
    ["no quote", ["--said-in", "s"], "needs --quote"],
    ["a blank quote", ["--quote", "   ", "--said-in", "s"], "needs --quote"],
    ["a quote past 4000 characters", ["--quote", "x".repeat(4001), "--said-in", "s"], "the most an answer can carry is 4000"],
    ["no said-in", ["--quote", "yes"], "needs --said-in"],
    ["a two-line said-in", ["--quote", "yes", "--said-in", "a\nb"], "one line of at most 200"],
    ["a said-in past 200 characters", ["--quote", "yes", "--said-in", "s".repeat(201)], "one line of at most 200"],
    ["a role past 64 characters", ["--quote", "yes", "--said-in", "s", "--role", "r".repeat(65)], "one line of at most 64"],
    ["a said-at that is not a time", ["--quote", "yes", "--said-in", "s", "--said-at", "yesterday-ish"], "must be an ISO-8601 time"],
    ["a said-at ten minutes ahead", ["--quote", "yes", "--said-in", "s", "--said-at", "2026-10-20T12:10:00Z"], "is in the future"],
    ["a two-letter option", ["--quote", "yes", "--said-in", "s", "--option", "AA"], "one letter from A to Z"],
    ["a numbered option", ["--quote", "yes", "--said-in", "s", "--option", "3"], "one letter from A to Z"],
    ["two options", ["--quote", "yes", "--said-in", "s", "--option", "A", "--option", "B"], "takes one --option"],
  ])("refuses %s locally", async (_what, flags, says) => {
    expect(await main(["ask", "answer", "ENG-7", "--proxy", ...flags], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain(says);
    expect(server.writes).toHaveLength(0);
  });

  test("a said-at within the five-minute allowance is accepted", async () => {
    server.agentWriteReply = recorded();
    expect(await main(["ask", "answer", "ENG-7", "--proxy", "--quote", "yes", "--said-in", "s", "--said-at", "2026-10-20T12:04:00Z"], ctx)).toBe(0);
    expect((server.writes[0]!.body as { saidAtMs: number }).saidAtMs).toBe(Date.parse("2026-10-20T12:04:00Z"));
  });
});

describe("ask proxy", () => {
  test("status is the default and says whether agents may record your chat answers", async () => {
    reply = () => ({ status: 200, body: { enabled: false } });
    expect(await main(["ask", "proxy"], ctx)).toBe(0);
    expect(me).toEqual([{ method: "GET", path: "/api/v1/me/ask-proxy-answering", body: undefined }]);
    expect(ctx.out.join("\n")).toMatch(/^Off: agents may not record an answer you give them in chat.*catalyst ask proxy on$/);
    reply = () => ({ status: 200, body: { enabled: true } });
    const c2 = ctxWithMe();
    expect(await main(["ask", "proxy", "status"], c2)).toBe(0);
    expect(c2.out.join("\n")).toMatch(/^On: agents may record an answer you give them in chat/);
  });

  test("on and off PUT the switch and say what changed", async () => {
    reply = (call) => ({ status: 200, body: call.body });
    expect(await main(["ask", "proxy", "on"], ctx)).toBe(0);
    const c2 = ctxWithMe();
    expect(await main(["ask", "proxy", "off", "--json"], c2)).toBe(0);
    expect(me).toEqual([
      { method: "PUT", path: "/api/v1/me/ask-proxy-answering", body: { enabled: true } },
      { method: "PUT", path: "/api/v1/me/ask-proxy-answering", body: { enabled: false } },
    ]);
    expect(ctx.out.join("\n")).toMatch(/^Turned on: /);
    expect(JSON.parse(c2.out.join("\n"))).toEqual({ enabled: false });
  });

  test("an unmatched Linear identity is a plain message and exit 1", async () => {
    reply = () => ({ status: 409, body: { error: "no_linear_identity" } });
    expect(await main(["ask", "proxy", "on"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("Your Linear identity is not matched yet");
    expect(ctx.out.join("\n")).toContain("catalyst identity linear options");
  });

  test("the workspace's shared key is told it needs your own login", async () => {
    reply = () => ({ status: 403, body: { error: "personal_credential_required" } });
    expect(await main(["ask", "proxy"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("needs your own login");
  });

  test("anything but status, on or off is a usage error, before anything is sent", async () => {
    expect(await main(["ask", "proxy", "maybe"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("ask proxy takes: status | on | off");
    expect(me).toHaveLength(0);
  });
});

describe("ask disown", () => {
  test("reopens the ask and lists each ticket it touched", async () => {
    reply = () => ({
      status: 200,
      body: { outcome: "disowned", askIdentifier: "ENG-7", tickets: [{ ticket: "ENG-1", phase: "implement", status: "held again" }, { ticket: "ENG-2", phase: "plan", status: "stopped" }] },
    });
    expect(await main(["ask", "disown", "ENG-7"], ctx)).toBe(0);
    expect(me).toEqual([{ method: "POST", path: "/api/v1/me/ask-disown", body: { issueId: "lin-eng-7" } }]);
    expect(ctx.out).toEqual(["ENG-7 is open again: the answer recorded by proxy is taken back.", "  ENG-1: implement held again", "  ENG-2: plan stopped"]);
  });

  test.each([
    ["not-owner", "is not your ask"],
    ["not-proxy-answered", "was not answered by proxy"],
    ["already-disowned", "already took back"],
    ["already-in-flight", "being recorded right now"],
  ])("refusal %s is one plain sentence and exit 1", async (reason, says) => {
    reply = () => ({ status: 409, body: { outcome: "refused", reason } });
    expect(await main(["ask", "disown", "ENG-7"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain(says);
  });

  test("a failed disown exits 2 and says it can be run again", async () => {
    reply = () => ({ status: 502, body: { outcome: "disown-failed", askIdentifier: "ENG-7", reason: "linear-unavailable" } });
    expect(await main(["ask", "disown", "ENG-7"], ctx)).toBe(2);
    expect(ctx.out.join("\n")).toContain("run the same command again");
  });

  test("an unmatched Linear identity is a plain message and exit 1", async () => {
    reply = () => ({ status: 409, body: { error: "no_linear_identity" } });
    expect(await main(["ask", "disown", "ENG-7"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("Your Linear identity is not matched yet");
  });

  test("--json prints the cloud's body", async () => {
    reply = () => ({ status: 409, body: { outcome: "refused", reason: "not-owner" } });
    expect(await main(["ask", "disown", "ENG-7", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual({ outcome: "refused", reason: "not-owner" });
  });
});
