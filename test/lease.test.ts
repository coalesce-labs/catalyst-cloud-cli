// lease.test.ts — CTC-6400: `catalyst lease` takes, renews, releases and reads a seat's ticket lease
// through /api/v1/agent/ticket-lease, and `catalyst work available` lists free tickets and unowned
// pull requests from /api/v1/work-eligibility. The fixture bodies follow catalyst-cloud's
// ticket-lease-store.ts (outcome taken|renewed|released|refused) and the explain's openPulls rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli";
import { configDirFor, configPathFor } from "../src/config";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

type Body = Record<string, unknown>;
type Request = { method: string; path: string; body: Body | null; authorization: string | null };
const now = Date.parse("2026-10-23T18:00:00Z");
const key = "ctc_user_lease_fixture";
const sha = "3713dc3009c56d76b2527a849094b9366100b263";
const holder = "seat:key-1:agent-a";
const lease = (over: Body = {}): Body => ({
  ticket: "ENG-123", holder, lastHolder: null, generation: 7,
  deadlineMs: now + 30 * 60_000, hardDeadlineMs: now + 24 * 3_600_000, acquiredAtMs: now,
  lastProgress: null, lastProgressAtMs: null, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let home: string;
let ctx: TestCtx;
let requests: Request[];
let respond: (request: Request) => Response;

beforeEach(() => {
  home = tempHome();
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    baseUrl: "https://cloud.example", key, account: "account-fixture", slug: "fixture", name: "Fixture",
    permissions: [], principal: "session", joinedAt: "2026-09-01T00:00:00Z",
  }));
  requests = [];
  respond = () => json({ outcome: "taken", lease: lease(), minted: true, adopted: [] });
  ctx = makeCtx(home, {
    now: () => new Date(now),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const request: Request = {
        method: init?.method ?? "GET", path: url.pathname + url.search,
        body: init?.body ? (JSON.parse(String(init.body)) as Body) : null,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      requests.push(request);
      return respond(request);
    },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const leaseFiles = () => {
  try {
    return readdirSync(join(configDirFor(home), "leases"));
  } catch {
    return [];
  }
};

describe("lease take", () => {
  test("prints the holder, the deadline and the generation, and stores the seat and generation 0600", async () => {
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(0);
    expect(requests).toEqual([{
      method: "POST", path: "/api/v1/agent/ticket-lease/take",
      body: { ticket: "ENG-123", agent: "agent-a" }, authorization: `Bearer ${key}`,
    }]);
    expect(ctx.out).toEqual([`ENG-123: held by ${holder} until 2026-10-23T18:30:00.000Z, generation 7`]);
    const file = join(configDirFor(home), "leases", "ENG-123--agent-a.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ticket: "ENG-123", agent: "agent-a", generation: 7, holder });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("--ttl is sent in milliseconds", async () => {
    expect(await main(["lease", "take", "eng-123", "--agent", "agent-a", "--ttl", "45"], ctx)).toBe(0);
    expect(requests[0]!.body).toEqual({ ticket: "ENG-123", agent: "agent-a", ttlMs: 2_700_000 });
  });

  test("a ticket another seat holds is refused with the holder and retry time, exit 1, and nothing is stored", async () => {
    respond = () => json({
      outcome: "refused",
      refusal: { reason: "ticket_lease_held", current: lease({ holder: "seat:key-2:agent-b" }), occupied: null, retryAtMs: now + 31 * 60_000 },
    });
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    expect(ctx.out).toEqual([
      "refused: ticket_lease_held; held by seat:key-2:agent-b until 2026-10-23T18:30:00.000Z; retry at 2026-10-23T18:31:00.000Z",
    ]);
    expect(leaseFiles()).toEqual([]);
  });

  test("a seat that does not reach the ticket's team is a 403 with the server's reason", async () => {
    respond = () => json({ outcome: "rejected", reason: "team-not-accessible" }, 403);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused (403): your login does not reach this ticket's team: team-not-accessible"]);
  });

  test("needs --agent, and a seat name the cloud would refuse never leaves the machine", async () => {
    await expect(main(["lease", "take", "ENG-123"], ctx)).resolves.toBe(1);
    await expect(main(["lease", "take", "ENG-123", "--agent", "PR Burn"], ctx)).resolves.toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("lease renew", () => {
  test("names the stored generation and the commit; a second renewal of the same commit is no_new_progress, exit 1", async () => {
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(0);
    respond = () => json({ outcome: "renewed", lease: lease({ deadlineMs: now + 60 * 60_000, lastProgress: `commit:${sha}` }) });
    expect(await main(["lease", "renew", "ENG-123", "--commit", sha], ctx)).toBe(0);
    expect(requests[1]).toEqual({
      method: "POST", path: "/api/v1/agent/ticket-lease/renew",
      body: { ticket: "ENG-123", agent: "agent-a", generation: 7, progress: { kind: "commit", ref: sha } },
      authorization: `Bearer ${key}`,
    });
    expect(ctx.out.slice(1)).toEqual([
      `ENG-123: held by ${holder} until 2026-10-23T19:00:00.000Z, generation 7`,
      `  last progress: commit:${sha}`,
    ]);
    respond = () => json({ outcome: "refused", refusal: { reason: "no_new_progress", current: lease(), occupied: null, retryAtMs: null } });
    expect(await main(["lease", "renew", "ENG-123", "--commit", sha, "--note", "same work, new words"], ctx)).toBe(1);
    expect(requests[2]!.body!.progress).toEqual({ kind: "commit", ref: sha, note: "same work, new words" });
    expect(ctx.out.at(-1)).toBe(`refused: no_new_progress; held by ${holder} until 2026-10-23T18:30:00.000Z`);
  });

  test("each progress kind is sent as the cloud parses it", async () => {
    respond = () => json({ outcome: "renewed", lease: lease() });
    for (const [flag, ref, kind] of [["--pr", "12686", "pr"], ["--artifact", "thoughts/shared/plans/x.md", "artifact"], ["--finding", "120544104498", "finding"]] as const) {
      expect(await main(["lease", "renew", "ENG-123", flag, ref, "--agent", "agent-a", "--generation", "7"], ctx)).toBe(0);
      expect(requests.at(-1)!.body!.progress).toEqual({ kind, ref });
    }
  });

  test("needs exactly one valid progress, and a lease this machine took or names", async () => {
    await expect(main(["lease", "renew", "ENG-123", "--commit", sha, "--agent", "agent-a", "--generation", "7", "--pr", "1"], ctx)).resolves.toBe(1);
    await expect(main(["lease", "renew", "ENG-123", "--commit", sha.toUpperCase(), "--agent", "agent-a", "--generation", "7"], ctx)).resolves.toBe(1);
    await expect(main(["lease", "renew", "ENG-123", "--commit", sha], ctx)).resolves.toBe(1);
    expect(ctx.err.join("\n")).toContain("this machine holds no lease on ENG-123");
    expect(requests).toEqual([]);
  });

  test("two seats on one machine must be named", async () => {
    await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx);
    respond = () => json({ outcome: "taken", lease: lease({ holder: "seat:key-1:agent-b", generation: 8 }), minted: true, adopted: [] });
    await main(["lease", "take", "ENG-123", "--agent", "agent-b"], ctx);
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("name one with --agent");
    respond = () => json({ outcome: "renewed", lease: lease({ generation: 8 }) });
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686", "--agent", "agent-b"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ agent: "agent-b", generation: 8 });
  });
});

describe("lease release and show", () => {
  test("release names the stored generation and forgets the lease", async () => {
    await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx);
    respond = () => json({ outcome: "released", lease: lease({ holder: null, lastHolder: holder }) });
    expect(await main(["lease", "release", "ENG-123"], ctx)).toBe(0);
    expect(requests[1]).toMatchObject({ path: "/api/v1/agent/ticket-lease/release", body: { ticket: "ENG-123", agent: "agent-a", generation: 7 } });
    expect(ctx.out.at(-1)).toBe("ENG-123: released by agent-a");
    expect(leaseFiles()).toEqual([]);
  });

  test("a refused release keeps the stored lease", async () => {
    await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx);
    respond = () => json({ outcome: "refused", refusal: { reason: "stale_generation", current: lease({ generation: 9 }), occupied: null, retryAtMs: null } });
    expect(await main(["lease", "release", "ENG-123"], ctx)).toBe(1);
    expect(leaseFiles()).toEqual(["ENG-123--agent-a.json"]);
  });

  test("show reads a held lease, a lapsed one and none", async () => {
    respond = () => json({ ticket: "ENG-123", lease: { ...lease({ lastProgress: "pr:12686" }), live: true }, delegations: [] });
    expect(await main(["lease", "show", "ENG-123"], ctx)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/v1/agent/ticket-lease?ticket=ENG-123" });
    respond = () => json({ ticket: "ENG-123", lease: { ...lease({ lastHolder: holder, lastProgress: "pr:12686" }), live: false }, delegations: [] });
    expect(await main(["lease", "show", "ENG-123"], ctx)).toBe(0);
    respond = () => json({ ticket: "ENG-123", lease: null, delegations: [] });
    expect(await main(["lease", "show", "ENG-123"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      `ENG-123: held by ${holder} until 2026-10-23T18:30:00.000Z, generation 7`,
      "  last progress: pr:12686",
      `ENG-123: free; last held by ${holder}, generation 7`,
      "  last progress: pr:12686",
      "ENG-123: no ticket lease",
    ]);
  });

  test("a cloud without the route says it needs a newer cloud", async () => {
    respond = () => json({ error: "not_found" }, 404);
    expect(await main(["lease", "show", "ENG-123"], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused (404): this Catalyst Cloud does not serve lease show yet (needs a newer cloud): not_found"]);
  });
});

describe("work available", () => {
  const explain = {
    team: "ENG",
    eligibility: {
      rows: [
        { ticket: "ENG-123", status: "offered", lastHolder: holder, lastProgress: `commit:${sha}` },
        { ticket: "ENG-200", status: "capability_mismatch" },
        { ticket: "ENG-300", status: "excluded", reason: "ticket_lease_held", holder: "seat:key-2:agent-b" },
        { ticket: "ENG-400", status: "offered", holder: "owner:host-1", deadlineMs: now },
        { ticket: "ENG-500", status: "excluded", reason: "blocked" },
      ],
    },
    openPulls: [
      { repoId: "r", number: 12686, title: "lease verbs", draft: true, headRef: "ENG-123", author: "a", ticket: "ENG-123", owner: "unowned" },
      { repoId: "r", number: 12700, title: "owned", draft: false, headRef: "ENG-300", author: "a", ticket: "ENG-300", owner: "seat:key-2:agent-b" },
    ],
  };

  test("lists free tickets with their last holder and progress, and unowned PRs with drafts included", async () => {
    respond = () => json(explain);
    expect(await main(["work", "available", "--team", "eng"], ctx)).toBe(0);
    expect(requests).toEqual([{ method: "GET", path: "/api/v1/work-eligibility?team=ENG", body: null, authorization: `Bearer ${key}` }]);
    expect(ctx.out).toEqual([
      "ENG: 2 free tickets, 1 unowned open pull request",
      `  ENG-123; last held by ${holder}, last progress commit:${sha}`,
      "  ENG-200",
      "  #12686 (draft) ENG-123: unowned, lease verbs",
    ]);
  });

  test("--json with one team is that team's lists", async () => {
    respond = () => json(explain);
    expect(await main(["work", "available", "--team", "ENG", "--json"], ctx)).toBe(0);
    const out = JSON.parse(ctx.out.join("\n")) as { tickets: Body[]; unownedPulls: Body[] };
    expect(out.tickets.map((t) => t.ticket)).toEqual(["ENG-123", "ENG-200"]);
    expect(out.unownedPulls.map((p) => p.number)).toEqual([12686]);
  });

  test("an older cloud with no openPulls lists tickets only", async () => {
    respond = () => json({ team: "ENG", eligibility: { rows: [{ ticket: "ENG-200", status: "offered" }] } });
    expect(await main(["work", "available", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["ENG: 1 free ticket, 0 unowned open pull requests", "  ENG-200"]);
  });

  test("needs the word available", async () => {
    await expect(main(["work"], ctx)).resolves.toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("lease edges", () => {
  const take = () => main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx);

  test("usage errors never reach the cloud", async () => {
    for (const argv of [
      ["lease"], ["lease", "steal", "ENG-123"], ["lease", "show"], ["lease", "show", "4107"], ["lease", "show", "ENG-123", "extra"],
      ["lease", "take", "ENG-123", "--agent", "agent-a", "--ttl", "soon"],
      ["lease", "renew", "ENG-123", "--pr", "12686", "--agent", "agent-a", "--generation", "0"],
      ["lease", "renew", "ENG-123", "--pr", "0", "--agent", "agent-a", "--generation", "7"],
      ["lease", "renew", "ENG-123", "--artifact", "two words", "--agent", "agent-a", "--generation", "7"],
      ["lease", "renew", "ENG-123", "--agent", "agent-a", "--generation", "7"],
      ["work", "available", "extra"],
    ]) {
      expect(await main(argv, ctx), argv.join(" ")).toBe(1);
    }
    expect(requests).toEqual([]);
  });

  test("--json prints each success body verbatim", async () => {
    const taken = { outcome: "taken", lease: lease(), minted: true, adopted: [] };
    respond = () => json(taken);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--json"], ctx)).toBe(0);
    const renewed = { outcome: "renewed", lease: lease({ lastProgress: "pr:12686" }) };
    respond = () => json(renewed);
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686", "--note", "  ", "--json"], ctx)).toBe(0);
    expect(requests.at(-1)!.body!.progress).toEqual({ kind: "pr", ref: "12686" });
    const shown = { ticket: "ENG-123", lease: { ...lease(), live: true }, delegations: [] };
    respond = () => json(shown);
    expect(await main(["lease", "show", "ENG-123", "--json"], ctx)).toBe(0);
    const released = { outcome: "released", lease: lease({ holder: null }) };
    respond = () => json(released);
    expect(await main(["lease", "release", "ENG-123", "--json"], ctx)).toBe(0);
    expect(ctx.out.map((l) => JSON.parse(l) as unknown)).toEqual([taken, renewed, shown, released]);
  });

  test("--json on a refusal or a rejection prints the status with the body, and exits 1", async () => {
    const refusal = { outcome: "refused", refusal: { reason: "ticket_lease_held", current: lease({ holder: "seat:key-2:agent-b" }), occupied: null, retryAtMs: now } };
    respond = () => json(refusal);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--json"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "budget exhausted" }, 429);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--json"], ctx)).toBe(1);
    respond = () => new Response("not json", { status: 403 });
    expect(await main(["lease", "show", "ENG-123", "--json"], ctx)).toBe(1);
    expect(ctx.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      { status: 200, ...refusal },
      { status: 429, outcome: "rejected", reason: "budget exhausted" },
      { status: 403 },
    ]);
  });

  test("an expired lease's renewal names only the reason; a 429 and a 400 say what they mean", async () => {
    await take();
    respond = () => json({ outcome: "refused", refusal: { reason: "expired", current: lease({ holder: null }), occupied: null, retryAtMs: null } });
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686"], ctx)).toBe(1);
    respond = () => json({ outcome: "refused", refusal: { current: null } });
    expect(await main(["lease", "release", "ENG-123"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "write budget exhausted" }, 429);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "progress.ref: a pr ref is the pull request's number" }, 400);
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686"], ctx)).toBe(1);
    respond = () => json({ outcome: "taken" });
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    expect(ctx.out.slice(1)).toEqual([
      "refused: expired",
      "refused: unknown",
      "refused (429): your write budget is spent for now: write budget exhausted",
      "refused (400): lease renew failed: progress.ref: a pr ref is the pull request's number",
      "refused (200): lease take failed",
    ]);
  });

  test("--generation overrides the stored one, and an unreadable stored file is not a lease", async () => {
    await take();
    respond = () => json({ outcome: "renewed", lease: lease({ generation: 9 }) });
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686", "--generation", "9"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toMatchObject({ agent: "agent-a", generation: 9 });
    const dir = join(configDirFor(home), "leases");
    writeFileSync(join(dir, "ENG-123--agent-a.json"), "{not json");
    writeFileSync(join(dir, "ENG-123--agent-c.json"), JSON.stringify({ ticket: "ENG-999", agent: "agent-c", generation: 1 }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12687"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("this machine holds no lease on ENG-123");
    expect(await main(["lease", "release", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("this machine holds no lease on ENG-123 for agent-a");
  });
});

describe("work available across the contract's teams", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startMeFixture();
  });
  afterAll(async () => {
    await server.close();
  });

  test("with no --team it reads every team the contract names, keyed by team in --json", async () => {
    const fixtureHome = tempHome();
    try {
      await seedJoined(fixtureHome, server);
      server.eligibilityByTeam = {
        ENG: {
          eligibility: { rows: [{ ticket: "ENG-1", status: "offered", lastHolder: "seat:k:a" }, { status: "offered" }] },
          openPulls: [{ number: 5, draft: false, ticket: null, owner: "unowned" }, "not a row", { number: 6, owner: "seat:k:a" }],
        },
        OPS: { eligibility: {}, openPulls: null },
      };
      const human = makeCtx(fixtureHome);
      expect(await main(["work", "available"], human)).toBe(0);
      expect(human.out).toEqual([
        "ENG: 1 free ticket, 1 unowned open pull request",
        "  ENG-1; last held by seat:k:a",
        "  #5: unowned",
        "OPS: 0 free tickets, 0 unowned open pull requests",
      ]);
      const machine = makeCtx(fixtureHome);
      expect(await main(["work", "available", "--json"], machine)).toBe(0);
      expect(Object.keys(JSON.parse(machine.out.join("\n")) as Body)).toEqual(["ENG", "OPS"]);
    } finally {
      server.eligibilityByTeam = {};
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
});
