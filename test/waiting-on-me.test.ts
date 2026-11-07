// waiting-on-me.test.ts — CTC-5644: the defensive reader of the Waiting-on-me view. Every reply is
// either verified rows or a fallback reason; 401, 429 and network errors surface instead.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CliError, MeError } from "../src/errors";
import { apiClient } from "../src/transport";
import { checkViewRows, readWaitingOnMe, viewRowsOf, WAITING_ON_ME_PATH } from "../src/waiting-on-me";
import { fixtureIssue, startMeFixture, waitingOnMeFixture, FIXTURE_ME_USER, type FixtureServer } from "./fixture";
import { joinedConfig, makeCtx, tempHome } from "./helpers";

const ME = FIXTURE_ME_USER.linearUserId;
let server: FixtureServer;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
  server.pageCap = undefined;
  server.waitingOnMe = undefined;
  server.waitingOnMeEnvelope = undefined;
  server.waitingOnMeOrder = undefined;
  server.meUser = undefined;
  server.issues = waitingOnMeFixture();
});

function client(fetchImpl?: typeof fetch) {
  const cfg = joinedConfig(server, { key: "fixture-user-key" });
  return apiClient(cfg, makeCtx(tempHome(), fetchImpl ? { fetch: fetchImpl } : {}));
}
const viewRequests = () => server.requests.filter((r) => r.path.startsWith(WAITING_ON_ME_PATH));
const manyAsks = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    fixtureIssue({ identifier: `MINE-${i + 1}`, assignee_id: ME, labels: [{ id: "l", name: "catalyst-ask" }], updated_at: 1000 + i }),
  );

describe("readWaitingOnMe", () => {
  test("one page: the member's open asks, hydrated with related_state", async () => {
    const r = await readWaitingOnMe(client(), ME);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.identifier).sort()).toEqual(["ENG-50", "ENG-51", "ENG-52", "ENG-53"]);
    expect(r.pages).toBe(1);
    expect(viewRequests()).toHaveLength(1);
  });
  test("follows the next-cursor header with after", async () => {
    server.issues = manyAsks(12);
    server.pageCap = 5;
    const r = await readWaitingOnMe(client(), ME);
    expect(r.ok && r.rows.length).toBe(12);
    expect(viewRequests()).toHaveLength(3);
    expect(viewRequests()[1]!.path).toContain("after=");
    expect(viewRequests()[2]!.path).toContain("after=");
  });
  test("a bare array and an empty list are fine", async () => {
    server.waitingOnMeEnvelope = "bare";
    expect(await readWaitingOnMe(client(), ME)).toMatchObject({ ok: true });
    server.issues = [];
    expect(await readWaitingOnMe(client(), ME)).toEqual({ ok: true, rows: [], pages: 1 });
  });
  test.each([
    ["absent", { status: 404, body: {} }, "absent"],
    ["no identity", { status: 409, body: { error: "no_linear_identity" } }, "no-linear-identity"],
    ["other 409", { status: 409, body: { error: "x" } }, "refused"],
    ["403", { status: 403, body: { error: "personal_credential_required" } }, "refused"],
    ["400", { status: 400, body: {} }, "refused"],
    ["unknown envelope", { status: 200, body: { nope: 1 } }, "shape"],
    ["row without identifier", { status: 200, body: { rows: [{ assignee_id: ME }] } }, "shape"],
    ["blocks without related_state", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [{ type: "blocks", issue_identifier: "A-1", related_identifier: "A-2" }] }] } }, "shape"],
    ["relations not an array", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: ME, relations: "x" }] } }, "shape"],
    ["labels not an array", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: ME, labels: "x" }] } }, "shape"],
    ["relation not an object", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [null] }] } }, "shape"],
    ["row not an object", { status: 200, body: { rows: [null] } }, "shape"],
    ["related_state of a wrong type", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [{ type: "blocks", issue_identifier: "A-1", related_identifier: "A-2", related_state: 3 }] }] } }, "shape"],
    ["someone else's row", { status: 200, body: { rows: [{ identifier: "A-1", assignee_id: "other" }] } }, "other-person"],
    ["body cursor, no header", { status: 200, body: { rows: [], nextCursor: "x" } }, "unpaged"],
    ["hasMore, no header", { status: 200, body: { rows: [], hasMore: true } }, "unpaged"],
    ["repeated cursor", { status: 200, body: { rows: [] }, headers: { "x-mirror-next-cursor": "same" } }, "stalled"],
  ] as const)("%s falls back as %s", async (_n, reply, reason) => {
    server.waitingOnMe = { ...reply, headers: "headers" in reply ? { ...reply.headers } : undefined };
    expect(await readWaitingOnMe(client(), ME)).toEqual({ ok: false, reason });
  });
  test("a non-JSON 200 body is a shape fallback", async () => {
    const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname === WAITING_ON_ME_PATH) return new Response("not json", { status: 200 });
      return fetch(input, init);
    }) as typeof fetch;
    expect(await readWaitingOnMe(client(f), ME)).toEqual({ ok: false, reason: "shape" });
  });
  test("a stale identity (the cloud names someone else) is other-person", async () => {
    server.meUser = { id: "u", label: "N", email: null, role: "admin", linearUserId: "linear-user-new" };
    server.issues = [fixtureIssue({ identifier: "N-1", assignee_id: "linear-user-new", labels: [{ id: "l", name: "catalyst-ask" }] })];
    expect(await readWaitingOnMe(client(), ME)).toEqual({ ok: false, reason: "other-person" });
  });
  test("ten pages that still have a cursor are an overrun", async () => {
    server.issues = manyAsks(11);
    server.pageCap = 1;
    expect(await readWaitingOnMe(client(), ME)).toEqual({ ok: false, reason: "overrun" });
    expect(viewRequests()).toHaveLength(10);
  });
  test("401 and 429 surface and never fall back", async () => {
    const f401 = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(readWaitingOnMe(client(f401), ME)).rejects.toMatchObject({ code: "unauthorized" });
    server.waitingOnMe = { status: 429, body: { error: "rate limited" } };
    const err = await readWaitingOnMe(client(), ME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toMatch(/rate-limited|budget/);
  });
  test.each([500, 502, 503, 504])("a %i from the view surfaces and never falls back", async (status) => {
    server.waitingOnMe = { status, body: {} };
    await expect(readWaitingOnMe(client(), ME)).rejects.toBeInstanceOf(CliError);
  });
  test("a network error surfaces", async () => {
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(readWaitingOnMe(client(boom), ME)).rejects.toBeInstanceOf(MeError);
    await expect(readWaitingOnMe(client(boom), ME)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("viewRowsOf and checkViewRows", () => {
  test("viewRowsOf returns null, never [], for an unknown shape", () => {
    for (const body of [undefined, "x", {}, { rows: "x" }, null]) expect(viewRowsOf(body)).toBeNull();
    expect(viewRowsOf({ asks: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  test("checkViewRows accepts a clean row and a non-blocks relation without related_state", () => {
    expect(checkViewRows([{ identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [{ type: "related", issue_identifier: "A-1" }] }], ME)).toBeNull();
  });
  test("the age key and a blocks relation's identifier are checked", () => {
    const row = (over: Record<string, unknown>) => ({ identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [], ...over });
    expect(checkViewRows([row({ updated_at: "nope" })], ME)).toBe("shape");
    expect(checkViewRows([row({ updated_at: "2026-01-01T00:00:00Z", created_at: 5 })], ME)).toBeNull();
    expect(checkViewRows([row({ created_at: null })], ME)).toBeNull();
    expect(checkViewRows([row({ created_at: "nope" })], ME)).toBe("shape");
    expect(checkViewRows([row({ created_at: {} })], ME)).toBe("shape");
    const blocks = (rel: Record<string, unknown>) => row({ relations: [{ type: "blocks", issue_identifier: "A-1", related_state: null, ...rel }] });
    expect(checkViewRows([blocks({ related_identifier: "A-2" })], ME)).toBeNull();
    expect(checkViewRows([blocks({})], ME)).toBe("shape");
    expect(checkViewRows([blocks({ related_identifier: 7 })], ME)).toBe("shape");
  });
  test.each(["labels", "state", "title", "relations", "updated_at"])("a view row without %s is a shape fallback", async (field) => {
    const row: Record<string, unknown> = { identifier: "A-1", assignee_id: ME, labels: [], state: "Todo", title: "T", updated_at: 1, relations: [] };
    expect(checkViewRows([row], ME)).toBeNull();
    delete row[field];
    expect(checkViewRows([row], ME)).toBe("shape");
    server.waitingOnMe = { status: 200, body: { rows: [row] } };
    expect(await readWaitingOnMe(client(), ME)).toEqual({ ok: false, reason: "shape" });
  });
});
