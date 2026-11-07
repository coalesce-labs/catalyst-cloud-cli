// fixture-pagination.test.ts — the shared fixture must model the mirror's keyset contract itself
// (limit clamped to a server-side cap, `x-mirror-total` always set, `x-mirror-next-cursor` present
// only while rows remain), or nothing built on top of it can test cursor-following behaviour at all.
import { afterAll, beforeAll, expect, test } from "vitest";
import { FIXTURE_KEY, manyIssues, startMeFixture, type FixtureServer } from "./fixture";

let server: FixtureServer;
const auth = { authorization: `Bearer ${FIXTURE_KEY}` };

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});

async function walkToEnd(path: string): Promise<Response> {
  let after: string | null = null;
  let res: Response;
  do {
    const url = new URL(`${server.url}${path}`);
    url.searchParams.set("limit", "500");
    if (after) url.searchParams.set("after", after);
    res = await fetch(url, { headers: auth });
    after = res.headers.get("x-mirror-next-cursor");
  } while (after !== null);
  return res;
}

test("a page is capped, carries the whole-scope total, and offers a cursor only while rows remain", async () => {
  server.pageCap = 50;
  server.issues = manyIssues(120);
  const first = await fetch(`${server.url}/api/v1/issues?limit=500`, { headers: auth });
  expect(first.headers.get("x-mirror-total")).toBe("120");
  const firstBody = (await first.clone().json()) as { rows: { identifier: string }[] };
  expect(firstBody.rows).toHaveLength(50); // clamped to the cap, not 500
  const cursor = first.headers.get("x-mirror-next-cursor");
  expect(cursor).not.toBeNull();

  const second = await fetch(`${server.url}/api/v1/issues?limit=500&after=${cursor}`, { headers: auth });
  const secondBody = (await second.clone().json()) as { rows: { identifier: string }[] };
  expect(secondBody.rows[0]!.identifier).toBe("ENG-51"); // continues, never restarts

  const last = await walkToEnd("/api/v1/issues");
  expect(last.headers.get("x-mirror-next-cursor")).toBeNull(); // ABSENT on the last page
  expect(last.headers.get("x-mirror-total")).toBe("120"); // total is page-independent
});

test("an unreadable ?after= is a 400 naming the route, never a silent full scan", async () => {
  server.pageCap = 50;
  server.issues = manyIssues(120);
  const res = await fetch(`${server.url}/api/v1/issues?after=not-a-cursor`, { headers: auth });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("/api/v1/issues");
});

test("/api/v1/pulls pages the same way", async () => {
  server.pageCap = 50;
  server.pulls = manyIssues(120).map((i, idx) => ({ ...i, node_id: `PR_${idx + 1}` }));
  const first = await fetch(`${server.url}/api/v1/pulls?limit=500`, { headers: auth });
  expect(first.headers.get("x-mirror-total")).toBe("120");
  const firstBody = (await first.clone().json()) as { rows: unknown[] };
  expect(firstBody.rows).toHaveLength(50);
  const cursor = first.headers.get("x-mirror-next-cursor");
  expect(cursor).not.toBeNull();

  const last = await walkToEnd("/api/v1/pulls");
  expect(last.headers.get("x-mirror-next-cursor")).toBeNull();
  expect(last.headers.get("x-mirror-total")).toBe("120");
});

test("the fake Waiting-on-me view pages, refuses by class, and hydrates related_state (CTC-5644)", async () => {
  const { FIXTURE_USER_KEY, fixtureIssue, FIXTURE_ME_USER, waitingOnMeFixture } = await import("./fixture");
  const person = { authorization: `Bearer ${FIXTURE_USER_KEY}` };
  server.issues = [
    ...waitingOnMeFixture(),
    ...Array.from({ length: 6 }, (_, i) => fixtureIssue({ identifier: `MINE-${i}`, assignee_id: FIXTURE_ME_USER.linearUserId, labels: [{ id: "l", name: "ask/x" }] })),
  ];
  server.pageCap = 5;
  try {
    const first = await fetch(`${server.url}/api/v1/views/waiting-on-me?limit=500`, { headers: person });
    expect(first.status).toBe(200);
    const cursor = first.headers.get("x-mirror-next-cursor");
    expect(cursor).not.toBeNull();
    const body = (await first.json()) as { rows: { identifier: string; relations: { related_state: string | null }[] }[] };
    expect(body.rows).toHaveLength(5);
    expect(body.rows[0]).toMatchObject({ identifier: "ENG-52" });
    expect(body.rows[0]!.relations.map((r) => r.related_state)).toEqual(["Todo", "In Progress", null]);
    const second = await fetch(`${server.url}/api/v1/views/waiting-on-me?limit=500&after=${cursor}`, { headers: person });
    expect(second.headers.get("x-mirror-next-cursor")).toBeNull();
    expect((await fetch(`${server.url}/api/v1/views/waiting-on-me`, { headers: auth })).status).toBe(403);
    server.meUser = { id: "u", label: "N", email: null, role: "admin", linearUserId: null };
    expect((await fetch(`${server.url}/api/v1/views/waiting-on-me`, { headers: person })).status).toBe(409);
    server.meUser = null;
    expect((await fetch(`${server.url}/api/v1/views/waiting-on-me`, { headers: person })).status).toBe(403);
    server.meUser = undefined;
    expect((await fetch(`${server.url}/api/v1/views/waiting-on-me?after=bad`, { headers: person })).status).toBe(400);
  } finally {
    server.pageCap = undefined;
    server.meUser = undefined;
    server.issues = (await import("./fixture")).fixtureIssues();
  }
});
