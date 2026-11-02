// lease.test.ts — CTC-6400: `catalyst lease` takes, renews, releases and reads a seat's ticket lease
// through /api/v1/agent/ticket-lease, and `catalyst work available` lists free tickets and unowned
// pull requests from /api/v1/work-eligibility. The fixture bodies follow catalyst-cloud's
// ticket-lease-store.ts (outcome taken|renewed|released|refused) and the explain's openPulls rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli";
import { configDirFor, configPathFor } from "../src/config";
import { CONTRACT_ROUTE, writeContractCache } from "../src/contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { buildFixtureContract } from "./fixture-contract";
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
    respond = () => json({ outcome: "refused", refusal: { reason: "active_descendants", current: lease(), occupied: null, retryAtMs: null } });
    expect(await main(["lease", "release", "ENG-123"], ctx)).toBe(1);
    expect(leaseFiles()).toEqual(["ENG-123--agent-a.json"]);
  });

  test("a release or renew refused because the lease is gone exits 1 and forgets the stored lease", async () => {
    for (const [verb, reason] of [["release", "expired"], ["release", "not_holder"], ["renew", "stale_generation"], ["renew", "expired"]] as const) {
      respond = () => json({ outcome: "taken", lease: lease(), minted: true, adopted: [] });
      await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx);
      respond = () => json({ outcome: "refused", refusal: { reason, current: null, occupied: null, retryAtMs: null } });
      const argv = verb === "renew" ? ["lease", "renew", "ENG-123", "--pr", "12686"] : ["lease", "release", "ENG-123"];
      expect(await main(argv, ctx)).toBe(1);
      expect(ctx.out.at(-1)).toBe(`refused: ${reason}`);
      expect(ctx.err.at(-1)).toBe("[catalyst] agent-a no longer holds ENG-123; forgot its stored lease");
      expect(leaseFiles()).toEqual([]);
    }
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

  test("--json on a refusal or a rejection prints the route's body unchanged, and exits 1 (CTC-8873)", async () => {
    const refusal = { outcome: "refused", refusal: { reason: "ticket_lease_held", current: lease({ holder: "seat:key-2:agent-b" }), occupied: null, retryAtMs: now } };
    respond = () => json(refusal);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--json"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "budget exhausted" }, 429);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--json"], ctx)).toBe(1);
    respond = () => new Response("not json", { status: 403 });
    expect(await main(["lease", "show", "ENG-123", "--json"], ctx)).toBe(1);
    // An unparseable body prints null: the route sent no JSON, and none is invented for it.
    expect(ctx.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      refusal,
      { outcome: "rejected", reason: "budget exhausted" },
      null,
    ]);
  });

  test("an expired lease's renewal names only the reason; a 429 and a 400 say what they mean", async () => {
    await take();
    respond = () => json({ outcome: "refused", refusal: { reason: "expired", current: lease({ holder: null }), occupied: null, retryAtMs: null } });
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686"], ctx)).toBe(1);
    expect(leaseFiles()).toEqual([]);
    respond = () => json({ outcome: "refused", refusal: { current: null } });
    expect(await main(["lease", "release", "ENG-123", "--agent", "agent-a", "--generation", "7"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "write budget exhausted" }, 429);
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(1);
    respond = () => json({ outcome: "rejected", reason: "progress.ref: a pr ref is the pull request's number" }, 400);
    expect(await main(["lease", "renew", "ENG-123", "--pr", "12686", "--agent", "agent-a", "--generation", "7"], ctx)).toBe(1);
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

// ── CTC-8873: holder details, the 2.65.0 gate, lease list and raw JSON ──────────────────────────
// Synthetic credentials are built at run time so no token-shaped literal sits in the source.
const ghToken = `ghp_${"a1B2".repeat(9)}`;
const contractDoc = (contractVersion: string) => ({ ...buildFixtureContract(), contractVersion });
const seedContract = (contractVersion: string) =>
  writeContractCache(home, { etag: null, fetchedAt: new Date(now - 1_000).toISOString(), contractVersion, doc: contractDoc(contractVersion) });
const factoryOwner = { type: "organization-key", keyId: "key_01JFACTORY", keyName: "factory-trial" };
const factoryDetails = (over: Body = {}): Body => ({
  kind: "factory", displayName: "Example Agent (trial)", sessionUrl: null, externalId: "s_8f2c", contact: null,
  owner: factoryOwner, declared: true, generation: 3, recordedAtMs: now, ...over,
});
const factoryLease = (over: Body = {}): Body =>
  lease({ ticket: "CTC-6480", holder: "seat:key_01JFACTORY:factory-droid", generation: 3, holderDetails: factoryDetails(), ...over });
const factoryTake = ["lease", "take", "CTC-6480", "--agent", "factory-droid", "--holder-kind", "factory", "--name", "Example Agent (trial)", "--external-id", "s_8f2c"];

describe("lease take with holder details (CTC-8873)", () => {
  test("scenario: an external agent takes a lease with its details, and show names it and its owner", async () => {
    seedContract("2.65.0");
    respond = () => json({ outcome: "taken", minted: true, adopted: [], lease: factoryLease() });
    expect(await main(factoryTake, ctx)).toBe(0);
    expect(requests).toEqual([{
      method: "POST", path: "/api/v1/agent/ticket-lease/take",
      body: { ticket: "CTC-6480", agent: "factory-droid", holderDetails: { kind: "factory", displayName: "Example Agent (trial)", externalId: "s_8f2c" } },
      authorization: `Bearer ${key}`,
    }]);
    expect(ctx.out).toEqual(["CTC-6480: held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z, generation 3"]);
    const file = join(configDirFor(home), "leases", "CTC-6480--factory-droid.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ticket: "CTC-6480", agent: "factory-droid", generation: 3, holder: "seat:key_01JFACTORY:factory-droid", kind: "factory" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    respond = () => json({ ticket: "CTC-6480", lease: { ...factoryLease(), live: true, lastHolderDetails: null }, delegations: [] });
    expect(await main(["lease", "show", "CTC-6480"], ctx)).toBe(0);
    expect(ctx.out.slice(1)).toEqual([
      "CTC-6480: held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z, generation 3",
      "  owner: organization key factory-trial",
      "  external id: s_8f2c",
    ]);
  });

  test("scenario: a cloud on contract 2.64 refuses holder details before any take is sent", async () => {
    seedContract("2.64.0");
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--holder-kind", "factory"], ctx)).toBe(1);
    expect(ctx.err).toEqual(["this cloud does not record holder details yet (needs contract 2.65.0)"]);
    expect(requests).toEqual([]);
  });

  test("an uncached contract is read first: 2.64 refuses with only that read, 2.65 and 2.66 take", async () => {
    let served = "2.64.0";
    respond = (r) => r.path === CONTRACT_ROUTE ? json(contractDoc(served)) : json({ outcome: "taken", minted: true, adopted: [], lease: factoryLease() });
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--holder-kind", "factory"], ctx)).toBe(1);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${CONTRACT_ROUTE}`]);
    for (const version of ["2.65.0", "2.66.0"]) {
      rmSync(join(configDirFor(home), "contract.json"), { force: true });
      served = version;
      requests = [];
      expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--holder-kind", "factory"], ctx)).toBe(0);
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${CONTRACT_ROUTE}`, "POST /api/v1/agent/ticket-lease/take"]);
    }
  });

  test("a contract read that fails never falls through to the take", async () => {
    respond = (r) => r.path === CONTRACT_ROUTE ? json({ error: "boom" }, 500) : json({ outcome: "taken", lease: factoryLease() });
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--name", "Agent 1"], ctx)).not.toBe(0);
    expect(requests.map((r) => r.path)).toEqual([CONTRACT_ROUTE]);
  });

  test("scenario: a link off the kind's allowlist is refused naming the allowed hosts, with no request at all", async () => {
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--holder-kind", "claude-code", "--link", "https://example.com/s/1"], ctx)).toBe(1);
    expect(ctx.err[0]).toBe("--link: kind claude-code allows session links on claude.ai only");
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--holder-kind", "factory", "--link", "https://app.factory.ai/s/1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind factory allows no session link yet (allowed hosts: none)");
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--link", "https://claude.ai/s/1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toContain("kind unspecified allows no session link yet (allowed hosts: none); declare the agent kind with --holder-kind");
    expect(requests).toEqual([]);
  });

  test("scenario: today's scripts run unchanged against a 2.65 cloud, with kind unspecified", async () => {
    const unspecified = { kind: "unspecified", displayName: "agent-1", sessionUrl: null, externalId: null, contact: null, owner: { type: "person", userId: "user-sam", name: "Sam Example" }, declared: true };
    respond = () => json({ outcome: "taken", minted: true, adopted: [], lease: lease({ ticket: "CTC-6480", holder: "seat:key-2:agent-1", generation: 4, holderDetails: unspecified }) });
    expect(await main(["lease", "take", "CTC-6480", "--agent", "agent-1", "--ttl", "60"], ctx)).toBe(0);
    expect(requests).toEqual([{
      method: "POST", path: "/api/v1/agent/ticket-lease/take",
      body: { ticket: "CTC-6480", agent: "agent-1", ttlMs: 3_600_000 }, authorization: `Bearer ${key}`,
    }]);
    expect(ctx.out).toEqual(["CTC-6480: held by seat:key-2:agent-1 until 2026-10-23T18:30:00.000Z, generation 4"]);
    expect(ctx.err).toEqual([]);
  });

  test("a credential in any of the four fields, the link's path included, is refused naming the flag, never the value", async () => {
    const cases: [string[], string][] = [
      [["--name", `Droid ${ghToken}`], "--name"],
      [["--external-id", ghToken], "--external-id"],
      [["--contact", `https://github.com/${ghToken}`], "--contact"],
      [["--holder-kind", "claude-code", "--link", `https://claude.ai/code/${ghToken}`], "--link"],
      [["--name", "GITHUB_TOKEN=abcd1234"], "--name"],
    ];
    for (const [flags, flag] of cases) {
      expect(await main(["lease", "take", "CTC-6480", "--agent", "x", ...flags], ctx)).toBe(1);
      expect(ctx.err.at(-1)).toMatch(new RegExp(`^${flag} looks like a (GitHub token|secret assignment)\\. Holder details are visible to every member of the workspace`));
    }
    ctx.env.CATALYST_LEASE_EXTERNAL_ID = ghToken;
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toContain("--external-id (from CATALYST_LEASE_EXTERNAL_ID) looks like a GitHub token");
    // A credential is reported as one even when the value also breaks a structural rule.
    delete ctx.env.CATALYST_LEASE_EXTERNAL_ID;
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--contact", `http://example.com/${ghToken}`], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toContain("--contact looks like a GitHub token");
    expect(requests).toEqual([]);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(ghToken);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain("abcd1234");
    // A clean near-match reaches the request.
    seedContract("2.65.0");
    respond = () => json({ outcome: "taken", minted: true, lease: factoryLease() });
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x", "--external-id", "ghp_short", "--name", "sk-integration-test-runner"], ctx)).toBe(0);
    expect(requests.at(-1)!.body!.holderDetails).toEqual({ displayName: "sk-integration-test-runner", externalId: "ghp_short" });
  });

  test("the environment stands in for --holder-kind, --link and --external-id, and a flag wins over it", async () => {
    seedContract("2.65.0");
    respond = () => json({ outcome: "taken", minted: true, lease: lease({ holderDetails: { kind: "claude-code", displayName: "agent-a" } }) });
    ctx.env.CATALYST_LEASE_HOLDER_KIND = "claude-code";
    ctx.env.CATALYST_LEASE_LINK = "https://claude.ai/code/session_abc";
    ctx.env.CATALYST_LEASE_EXTERNAL_ID = "session_abc";
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(0);
    expect(requests.at(-1)!.body!.holderDetails).toEqual({ kind: "claude-code", sessionUrl: "https://claude.ai/code/session_abc", externalId: "session_abc" });
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--holder-kind", "codex", "--link", "https://chatgpt.com/codex/tasks/t_1", "--external-id", "t_1", "--ttl", "45"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toEqual({
      ticket: "ENG-123", agent: "agent-a", ttlMs: 2_700_000,
      holderDetails: { kind: "codex", sessionUrl: "https://chatgpt.com/codex/tasks/t_1", externalId: "t_1" },
    });
    // A blank variable is absent; a blank flag is an error.
    ctx.env.CATALYST_LEASE_HOLDER_KIND = " ";
    ctx.env.CATALYST_LEASE_LINK = "";
    ctx.env.CATALYST_LEASE_EXTERNAL_ID = "";
    const sent = requests.length;
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toEqual({ ticket: "ENG-123", agent: "agent-a" });
    expect(await main(["lease", "take", "ENG-123", "--agent", "agent-a", "--name=  "], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--name needs a value; leave the flag out to send none");
    expect(requests.length).toBe(sent + 1);
  });

  test("a same-holder retry keeps what the cloud recorded, and says so only when the details differ", async () => {
    seedContract("2.65.0");
    respond = () => json({ outcome: "taken", minted: false, lease: factoryLease() });
    expect(await main(factoryTake, ctx)).toBe(0);
    expect(ctx.err).toEqual([]);
    expect(await main(["lease", "take", "CTC-6480", "--agent", "factory-droid", "--holder-kind", "factory", "--external-id", "s_new"], ctx)).toBe(0);
    expect(ctx.err).toEqual(["CTC-6480: this seat already holds the ticket; its recorded holder details were kept"]);
    expect(ctx.out.at(-1)).toBe("CTC-6480: held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z, generation 3");
  });

  test("a refused take names the incumbent by its declared name and kind", async () => {
    respond = () => json({ outcome: "refused", refusal: { reason: "ticket_lease_held", current: factoryLease(), occupied: null, retryAtMs: now + 30 * 60_000 + 1 } });
    expect(await main(["lease", "take", "CTC-6480", "--agent", "x"], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused: ticket_lease_held; held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z; retry at 2026-10-23T18:30:00.001Z"]);
  });
});

describe("lease renew with holder details (CTC-8873)", () => {
  const takeFactory = async () => {
    seedContract("2.65.0");
    respond = () => json({ outcome: "taken", minted: true, lease: factoryLease() });
    expect(await main(factoryTake, ctx)).toBe(0);
    requests = [];
  };

  test("sends each detail beside its one progress, and never a kind", async () => {
    await takeFactory();
    respond = () => json({ outcome: "renewed", lease: factoryLease({ lastProgress: "pr:15901", holderDetails: factoryDetails({ externalId: "s_91aa" }) }) });
    const contact = "https://github.com/coalesce-labs/catalyst-cloud-cli/issues/1";
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "15901", "--name", "Example Agent (trial)", "--external-id", "s_91aa", "--contact", contact], ctx)).toBe(0);
    expect(requests).toEqual([{
      method: "POST", path: "/api/v1/agent/ticket-lease/renew",
      body: {
        ticket: "CTC-6480", agent: "factory-droid", generation: 3, progress: { kind: "pr", ref: "15901" },
        holderDetails: { displayName: "Example Agent (trial)", externalId: "s_91aa", contact },
      },
      authorization: `Bearer ${key}`,
    }]);
    expect(ctx.out.slice(1)).toEqual([
      "CTC-6480: held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z, generation 3",
      "  last progress: pr:15901",
    ]);
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "15902", "--holder-kind", "codex"], ctx)).toBe(1);
    expect(await main(["lease", "renew", "CTC-6480", "--external-id", "s_1"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("lease renew needs exactly one of");
    expect(requests).toHaveLength(1);
  });

  test("all four details together; the link is checked against the kind the take stored", async () => {
    await takeFactory();
    ctx.env.CATALYST_LEASE_HOLDER_KIND = "claude-code";
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--link", "https://claude.ai/code/s_1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind factory allows no session link yet (allowed hosts: none)");
    expect(requests).toEqual([]);
    respond = () => json({ outcome: "renewed", lease: lease({ holderDetails: { kind: "catalyst-seat", displayName: "seat" } }) });
    writeFileSync(join(configDirFor(home), "leases", "CTC-6480--factory-droid.json"), JSON.stringify({ ticket: "CTC-6480", agent: "factory-droid", generation: 3, holder: null, kind: "catalyst-seat" }));
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--name", "Seat", "--external-id", "e_1", "--contact", "https://linear.app/x/issue/CTC-6480", "--link", "https://app.catalystcloud.dev/runs/r_1"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toEqual({
      ticket: "CTC-6480", agent: "factory-droid", generation: 3, progress: { kind: "pr", ref: "1" },
      holderDetails: { displayName: "Seat", externalId: "e_1", contact: "https://linear.app/x/issue/CTC-6480", sessionUrl: "https://app.catalystcloud.dev/runs/r_1" },
    });
  });

  test("a link the stored kind refuses makes no request, not even a contract read", async () => {
    mkdirSync(join(configDirFor(home), "leases"), { recursive: true });
    writeFileSync(join(configDirFor(home), "leases", "CTC-6480--factory-droid.json"), JSON.stringify({ ticket: "CTC-6480", agent: "factory-droid", generation: 3, holder: null, kind: "factory" }));
    respond = (r) => r.path === CONTRACT_ROUTE ? json(contractDoc("2.65.0")) : json({ outcome: "renewed", lease: factoryLease() });
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--link", "https://claude.ai/code/s_1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind factory allows no session link yet (allowed hosts: none)");
    expect(requests).toEqual([]);
  });

  test("a renew whose take declared no kind is refused without pointing at --holder-kind, which renew refuses", async () => {
    seedContract("2.65.0");
    mkdirSync(join(configDirFor(home), "leases"), { recursive: true });
    writeFileSync(join(configDirFor(home), "leases", "CTC-6480--agent-1.json"), JSON.stringify({ ticket: "CTC-6480", agent: "agent-1", generation: 3, holder: null, kind: "unspecified" }));
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--link", "https://claude.ai/code/s_1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind unspecified allows no session link yet (allowed hosts: none)");
    expect(requests).toEqual([]);
  });

  test("a kind the cloud returned reaches a link refusal with its terminal controls removed", async () => {
    seedContract("2.65.0");
    const kind = "\u001b]0;owned\u0007evil‮";
    respond = (r) => r.method === "GET"
      ? json({ ticket: "CTC-6480", lease: { ...factoryLease({ holderDetails: factoryDetails({ kind }) }), live: true } })
      : json({ outcome: "renewed", lease: factoryLease() });
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--agent", "factory-droid", "--generation", "3", "--link", "https://claude.ai/code/s_1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind ]0;ownedevil allows no session link yet (allowed hosts: none)");
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  test("with no stored kind, the lease is read once for it; a mismatched or absent kind refuses before the renew", async () => {
    seedContract("2.65.0");
    const args = ["lease", "renew", "CTC-6480", "--pr", "1", "--agent", "factory-droid", "--generation", "3"];
    const read = (over: Body) => json({ ticket: "CTC-6480", lease: { ...factoryLease({ holderDetails: factoryDetails({ kind: "claude-code" }) }), live: true, ...over } });
    respond = (r) => r.method === "GET" ? read({}) : json({ outcome: "renewed", lease: factoryLease() });
    expect(await main([...args, "--link", "https://example.com/s/1"], ctx)).toBe(1);
    expect(ctx.err.at(-1)).toBe("--link: kind claude-code allows session links on claude.ai only");
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
    expect(requests[0]!.path).toBe("/api/v1/agent/ticket-lease?ticket=CTC-6480");
    expect(await main([...args, "--link", "https://claude.ai/code/s_1"], ctx)).toBe(0);
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
    for (const over of [{ generation: 4 }, { holder: "seat:key_01JFACTORY:other" }, { holderDetails: null }, { live: false }]) {
      respond = (r) => r.method === "GET" ? read(over) : json({ outcome: "renewed", lease: factoryLease() });
      requests = [];
      expect(await main([...args, "--link", "https://claude.ai/code/s_1"], ctx)).toBe(1);
      expect(ctx.err.at(-1)).toBe("--link needs the current holder kind; take this lease with this CLI before setting its session link");
      expect(requests.map((r) => r.method)).toEqual(["GET"]);
    }
  });

  test("renew reads the link and external id stand-ins, a flag wins, and release never sends the stored kind", async () => {
    await takeFactory();
    writeFileSync(join(configDirFor(home), "leases", "CTC-6480--factory-droid.json"), JSON.stringify({ ticket: "CTC-6480", agent: "factory-droid", generation: 3, holder: null, kind: "claude-code" }));
    respond = () => json({ outcome: "renewed", lease: factoryLease() });
    ctx.env.CATALYST_LEASE_LINK = "https://claude.ai/code/s_env";
    ctx.env.CATALYST_LEASE_EXTERNAL_ID = "s_env";
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1"], ctx)).toBe(0);
    expect(requests.at(-1)!.body!.holderDetails).toEqual({ sessionUrl: "https://claude.ai/code/s_env", externalId: "s_env" });
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "2", "--external-id", "s_flag"], ctx)).toBe(0);
    expect(requests.at(-1)!.body!.holderDetails).toEqual({ sessionUrl: "https://claude.ai/code/s_env", externalId: "s_flag" });
    expect(requests.map((r) => r.method)).toEqual(["POST", "POST"]);
    respond = () => json({ outcome: "released", lease: factoryLease({ holder: null }) });
    expect(await main(["lease", "release", "CTC-6480"], ctx)).toBe(0);
    expect(requests.at(-1)!.body).toEqual({ ticket: "CTC-6480", agent: "factory-droid", generation: 3 });
  });

  test("a stored kind from another generation is not used: the lease is read for the current one", async () => {
    await takeFactory();
    respond = (r) => r.method === "GET"
      ? json({ ticket: "CTC-6480", lease: { ...factoryLease({ generation: 4, holderDetails: factoryDetails({ kind: "codex" }) }), live: true } })
      : json({ outcome: "renewed", lease: factoryLease({ generation: 4 }) });
    expect(await main(["lease", "renew", "CTC-6480", "--pr", "1", "--generation", "4", "--link", "https://chatgpt.com/c/1"], ctx)).toBe(0);
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(requests[1]!.body).toMatchObject({ agent: "factory-droid", generation: 4, holderDetails: { sessionUrl: "https://chatgpt.com/c/1" } });
  });

  test("a renew with no details reads no contract; release and show refuse detail flags", async () => {
    respond = () => json({ outcome: "renewed", lease: lease() });
    expect(await main(["lease", "renew", "ENG-123", "--pr", "1", "--agent", "agent-a", "--generation", "7"], ctx)).toBe(0);
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/agent/ticket-lease/renew"]);
    expect(requests[0]!.body).toEqual({ ticket: "ENG-123", agent: "agent-a", generation: 7, progress: { kind: "pr", ref: "1" } });
    expect(await main(["lease", "release", "ENG-123", "--agent", "agent-a", "--generation", "7", "--name", "x"], ctx)).toBe(1);
    expect(await main(["lease", "show", "ENG-123", "--link", "https://claude.ai/x"], ctx)).toBe(1);
    expect(await main(["lease", "show", "ENG-123", "--team", "CTC"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--name is not an option of lease release");
    expect(requests).toHaveLength(1);
  });
});

describe("lease show and list with holder details (CTC-8873)", () => {
  const sam = { type: "person", userId: "user-sam", name: "Sam Example" };
  const row = (ticket: string, over: Body): Body => ({ ...lease({ ticket }), live: true, lastHolderDetails: null, ...over });
  const three = {
    team: "CTC", state: "live", nextCursor: null,
    leases: [
      row("CTC-6480", { holder: "seat:key_01JFACTORY:factory-droid", generation: 3, deadlineMs: now + 30 * 60_000, holderDetails: factoryDetails() }),
      row("CTC-6477", { holder: "seat:key-2:agent-1", generation: 1, deadlineMs: now + 20 * 60_000, holderDetails: { kind: "claude-code", displayName: "Agent 1", owner: sam } }),
      row("CTC-6476", { holder: "seat:key-2:agent-2", generation: 2, deadlineMs: now + 10 * 60_000, holderDetails: { kind: "unspecified", displayName: "agent-2", owner: sam } }),
    ],
  };

  test("scenario: an operator lists a team's leases, one line each with the holder's name and kind", async () => {
    respond = () => json(three);
    expect(await main(["lease", "list", "--team", "ctc"], ctx)).toBe(0);
    expect(requests).toEqual([{ method: "GET", path: "/api/v1/agent/ticket-leases?team=CTC", body: null, authorization: `Bearer ${key}` }]);
    expect(ctx.out).toEqual([
      "CTC: 3 live leases",
      "  CTC-6480: Example Agent (trial) [factory], owner organization key factory-trial, until 2026-10-23T18:30:00.000Z, generation 3",
      "  CTC-6477: Agent 1 [claude-code], owner person Sam Example, until 2026-10-23T18:20:00.000Z, generation 1",
      "  CTC-6476: agent-2 [unspecified], owner person Sam Example, until 2026-10-23T18:10:00.000Z, generation 2",
    ]);
  });

  test("an empty page, one recent free row, and the next page's command with every option it was given", async () => {
    respond = () => json({ team: "CTC", state: "live", leases: [], nextCursor: null });
    expect(await main(["lease", "list", "--team", "CTC"], ctx)).toBe(0);
    respond = () => json({
      team: "CTC", state: "recent", nextCursor: "eyJzIjoxfQ",
      leases: [row("CTC-6480", { live: false, holder: "seat:key_01JFACTORY:factory-droid", lastHolder: null, generation: 3, holderDetails: factoryDetails(), lastHolderDetails: { kind: "codex", displayName: "Wrong side" } })],
    });
    expect(await main(["lease", "list", "--team", "CTC", "--state", "recent", "--limit", "1"], ctx)).toBe(0);
    expect(requests.at(-1)!.path).toBe("/api/v1/agent/ticket-leases?team=CTC&state=recent&limit=1");
    expect(ctx.out).toEqual([
      "CTC: 0 live leases",
      "CTC: 1 recent lease",
      "  CTC-6480: free; last held by Example Agent (trial) [factory], generation 3",
      "  more: catalyst lease list --team CTC --state recent --limit 1 --cursor eyJzIjoxfQ",
    ]);
    const cursor = "a'b c$(x)&\u001b[31m";
    respond = () => json({ team: "CTC", state: "live", leases: [], nextCursor: cursor });
    expect(await main(["lease", "list", "--team", "CTC", "--cursor", "it's next"], ctx)).toBe(0);
    expect([...new URL(`https://cloud.example${requests.at(-1)!.path}`).searchParams]).toEqual([["team", "CTC"], ["cursor", "it's next"]]);
    expect(ctx.out.at(-1)).toBe("  more: catalyst lease list --team CTC --cursor $'a\\'b c$(x)&\\u001b[31m'");
    respond = () => json({ team: "CTC", state: "live", leases: [], nextCursor: "it's" });
    expect(await main(["lease", "list", "--team", "CTC"], ctx)).toBe(0);
    expect(ctx.out.at(-1)).toBe("  more: catalyst lease list --team CTC --cursor 'it'\\''s'");
  });

  test("--json prints the list body unchanged, unknown fields included", async () => {
    const body = { team: "CTC", state: "live", leases: [], nextCursor: null, sentinel: { kept: true } };
    respond = () => json(body);
    expect(await main(["lease", "list", "--team", "CTC", "--json"], ctx)).toBe(0);
    expect(ctx.out.map((l) => JSON.parse(l) as unknown)).toEqual([body]);
    respond = () => json({ outcome: "rejected", reason: "limit is 1 to 200", code: "invalid_query" }, 400);
    expect(await main(["lease", "list", "--team", "CTC", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out.at(-1)!)).toEqual({ outcome: "rejected", reason: "limit is 1 to 200", code: "invalid_query" });
  });

  test("list refusals: an older cloud, a team out of reach, a bad query and a spent budget", async () => {
    for (const [status, body] of [[404, null], [403, { reason: "team-not-accessible" }], [400, { reason: "bad cursor" }], [429, { reason: "slow down" }]] as const) {
      respond = () => body === null ? new Response("not found", { status }) : json(body, status);
      expect(await main(["lease", "list", "--team", "CTC"], ctx)).toBe(1);
    }
    expect(ctx.out).toEqual([
      "refused (404): this Catalyst Cloud does not serve lease list yet (needs a newer cloud)",
      "refused (403): your login does not reach this ticket's team: team-not-accessible",
      "refused (400): lease list failed: bad cursor",
      "refused (429): your write budget is spent for now: slow down",
    ]);
  });

  test("list refuses a missing team, a ticket, a bad state or limit, and lease flags, before any request", async () => {
    for (const argv of [
      ["lease", "list"], ["lease", "list", "CTC-1", "--team", "CTC"], ["lease", "list", "--team", "C T"],
      ["lease", "list", "--team", "CTC", "--state", "all"], ["lease", "list", "--team", "CTC", "--limit", "0"],
      ["lease", "list", "--team", "CTC", "--limit", "201"], ["lease", "list", "--team", "CTC", "--agent", "a"],
      ["lease", "list", "--team", "CTC", "--name", "x"], ["lease", "list", "--team", "CTC", "--cursor="],
    ]) expect(await main(argv, ctx)).toBe(1);
    expect(requests).toEqual([]);
  });

  test("show: a free row pairs the name with its own details; a live row names the previous holder; old rows keep the seat", async () => {
    const shows: Body[] = [
      { ticket: "CTC-6480", lease: { ...factoryLease({ lastProgress: "pr:15901", holderDetails: factoryDetails({ externalId: "s_91aa" }) }), live: false, lastHolder: null, lastHolderDetails: { kind: "codex", displayName: "Not this one" } } },
      { ticket: "CTC-6480", lease: { ...factoryLease({ holderDetails: factoryDetails({ sessionUrl: "https://app.factory.ai/s/1", contact: "https://github.com/x", owner: { type: "person", userId: "u", name: null } }) }), live: true, lastHolder: "seat:key-2:agent-1", lastHolderDetails: { kind: "unspecified", displayName: "agent-1" } } },
      { ticket: "CTC-6480", lease: { ...lease({ ticket: "CTC-6480", lastHolder: "seat:key-3:old" }), live: true } },
      { ticket: "CTC-9000", lease: null },
    ];
    for (const shown of shows) {
      respond = () => json(shown);
      expect(await main(["lease", "show", String(shown.ticket)], ctx)).toBe(0);
    }
    expect(ctx.out).toEqual([
      "CTC-6480: free; last held by Example Agent (trial) [factory], generation 3",
      "  last progress: pr:15901",
      "  owner: organization key factory-trial",
      "  external id: s_91aa",
      "CTC-6480: held by Example Agent (trial) [factory] until 2026-10-23T18:30:00.000Z, generation 3",
      "  owner: person (a member of this workspace)",
      "  session: https://app.factory.ai/s/1",
      "  external id: s_8f2c",
      "  contact: https://github.com/x",
      "  previous holder: agent-1 [unspecified]",
      `CTC-6480: held by ${holder} until 2026-10-23T18:30:00.000Z, generation 7`,
      "  previous holder: seat:key-3:old",
      "CTC-9000: no ticket lease",
    ]);
  });

  test("terminal controls in names, owners and details never reach the screen; --json keeps them", async () => {
    const hostile = { kind: "factory\u001b[2J", displayName: "Evil\u202e\u0007 Droid", externalId: "id\u009b1", owner: { type: "organization-key", keyId: "k", keyName: "key\u001b]0;x\u0007" } };
    const shown = { ticket: "CTC-6480", lease: { ...factoryLease({ holderDetails: hostile }), live: true } };
    respond = () => json(shown);
    expect(await main(["lease", "show", "CTC-6480"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      "CTC-6480: held by Evil Droid [factory[2J] until 2026-10-23T18:30:00.000Z, generation 3",
      "  owner: organization key key]0;x",
      "  external id: id1",
    ]);
    expect(await main(["lease", "show", "CTC-6480", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.at(-1)!)).toEqual(shown);
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
