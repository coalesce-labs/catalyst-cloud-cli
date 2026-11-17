// environment.test.ts — `catalyst environment`: the tenant-scope declaration through the
// contract's account-environment routes, against the fixture cloud. The fixture's environment routes
// are a real little state machine (propose bumps a revision and a hash, approve is a compare-and-set
// against them), so a verb that approved the wrong revision fails here instead of passing on a canned
// body.
//
// ⭐ THE CONTROLS IN THIS FILE ARE INDEPENDENT OF THE SUBJECT. `src/environment.ts` is never imported
// by a control, and no control derives its expectation from the code under test: the route-discovery
// controls are literal assertions about the FIXTURE, and the matcher controls are literal strings.
// Deleting the route discovery from `src/environment.ts` reddens the subject tests and leaves every
// control green — which is the only arrangement in which a green control means anything.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { FIXTURE_ROUTE_PREFIX, buildFixtureContract } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

/** The declaration is opaque to this bundle: the cloud validates it, the CLI only carries it. */
const DECLARATION = { agentAssets: [{ kind: "env", name: "BUILD_TOKEN", value: "$BUILD_TOKEN" }] };

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
  server.writes.length = 0;
  server.budgetExhausted = false;
  server.contract = buildFixtureContract();
  server.accountEnvironment = { current: null, approved: null, unresolvedReferences: [] };
  server.environmentForced = undefined;
  await seedJoined(home, server);
});

const declarationFile = (value: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "catalyst-env-"));
  const path = join(dir, "declaration.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const envWrites = (suffix: string) =>
  server.writes.filter((w) => w.path === `${FIXTURE_ROUTE_PREFIX}/account-environment/${suffix}`);
const text = () => ctx.out.join("\n");

// ── controls ─────────────────────────────────────────────────────────────────────────────────────
// These assert facts about the FIXTURE and about plain strings. None imports or exercises
// `src/environment.ts`, so none of them can be made green by a change to it — or red by one.

describe("controls (independent of the verb under test)", () => {
  test("the fixture serves its routes under a prefix that is NOT the production one, so a hard-coded path cannot pass", () => {
    expect(FIXTURE_ROUTE_PREFIX).not.toBe("/api/v1/agent");
    expect(FIXTURE_ROUTE_PREFIX.startsWith("/api/v1/agent/")).toBe(false);
  });

  test("the fixture contract really carries the three account-environment routes, with the derived paths spelled out", () => {
    const paths = buildFixtureContract().routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET ${FIXTURE_ROUTE_PREFIX}/account-environment`);
    expect(paths).toContain(`POST ${FIXTURE_ROUTE_PREFIX}/account-environment/propose`);
    expect(paths).toContain(`POST ${FIXTURE_ROUTE_PREFIX}/account-environment/approve`);
  });

  test("a contract with those three routes removed really has none of them left", () => {
    const doc = buildFixtureContract();
    doc.routes = doc.routes.filter((r) => !r.path.includes("account-environment"));
    expect(doc.routes.some((r) => r.path.includes("account-environment"))).toBe(false);
    // And the rest of the table survives, so a refusal below is about these routes and not an empty one.
    expect(doc.routes.length).toBeGreaterThan(5);
  });

  test("the refusal matcher fires on the sentence the bundle uses for an older cloud, and not on a success line", () => {
    const older = /needs a newer Catalyst Cloud/;
    expect("the tenant environment declaration needs a newer Catalyst Cloud than https://x is running").toMatch(older);
    expect("approved: revision 1 (sha-1)").not.toMatch(older);
  });
});

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

describe("environment read", () => {
  test("says plainly when there is no declaration yet, and exits 0 — nothing to fix", async () => {
    expect(await main(["environment"], ctx)).toBe(0);
    expect(text()).toContain("no tenant environment declaration yet");
  });

  test("names the revision, whether it is approved, and what a phase actually gets", async () => {
    server.accountEnvironment.current = { revision: 4, canonicalHash: "sha-4", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    server.accountEnvironment.approved = { revision: 3, canonicalHash: "sha-3" };
    expect(await main(["environment", "read"], ctx)).toBe(0);
    const out = text();
    expect(out).toContain("revision 4 (sha-4)");
    // ⛔ The distinction this line exists for: revision 4 is stored and revision 3 is what runs.
    expect(out).toContain("NOT approved");
    expect(out).toContain("delivered to phases: revision 3 (sha-3)");
  });

  test("warns about a referenced name the tenant does not carry yet, without failing", async () => {
    server.accountEnvironment.current = { revision: 1, canonicalHash: "sha-1", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    server.accountEnvironment.approved = { revision: 1, canonicalHash: "sha-1" };
    server.accountEnvironment.unresolvedReferences = ["BUILD_TOKEN"];
    expect(await main(["environment", "read"], ctx)).toBe(0);
    expect(text()).toContain("BUILD_TOKEN");
    expect(text()).toContain("approved");
  });

  test("--json prints the cloud's own document", async () => {
    server.accountEnvironment.current = { revision: 2, canonicalHash: "sha-2", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "read", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ current: { revision: 2, canonicalHash: "sha-2" } });
  });
});

// ── propose ──────────────────────────────────────────────────────────────────────────────────────

describe("environment propose", () => {
  test("posts the declaration to the CONTRACT's propose path and reports the revision it created", async () => {
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(0);
    const [w] = envWrites("propose");
    expect(w?.body).toEqual({ declaration: DECLARATION });
    expect(text()).toContain("created: revision 1 (sha-1)");
    // A proposal is not what runs, and the verb has to say so or a person stops here believing it is.
    expect(text()).toContain("not delivered until it is approved");
  });

  test("reads the declaration from stdin too", async () => {
    const code = await main(["environment", "propose", "--stdin"], ctx, {
      environment: { readStdin: async () => JSON.stringify(DECLARATION) },
    });
    expect(code).toBe(0);
    expect(envWrites("propose")[0]?.body).toEqual({ declaration: DECLARATION });
  });

  test("refuses to invent a declaration: neither --file nor --stdin is a usage error, and nothing is posted", async () => {
    expect(await main(["environment", "propose"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--file <path> or --stdin");
    expect(envWrites("propose")).toEqual([]);
  });

  test("a file that is not JSON is refused before any request", async () => {
    const path = declarationFile(DECLARATION).replace("declaration.json", "broken.json");
    writeFileSync(path, "{not json");
    expect(await main(["environment", "propose", "--file", path], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("is not JSON");
    expect(envWrites("propose")).toEqual([]);
  });

  test("--expect-revision is sent, and a mismatch prints the cloud's conflict and exits 1", async () => {
    server.accountEnvironment.current = { revision: 7, canonicalHash: "sha-7", declaration: { a: 1 }, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--expect-revision", "2"], ctx)).toBe(1);
    expect(envWrites("propose")[0]?.body).toEqual({ declaration: DECLARATION, expectedRevision: 2 });
    const out = text();
    expect(out).toContain("refused (409)");
    expect(out).toContain("now at revision 7");
  });

  test("CTC-10761 — a pull-request answer is reported as a pull request, exits 0, and approves nothing even with --approve", async () => {
    server.environmentForced = {
      propose: {
        status: 202,
        body: { status: "pull_request", pullRequest: { number: 14, url: "https://github.com/acme/ws/pull/14" }, repository: "acme/ws", path: "catalyst.toml", changes: 2 },
      },
    };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve"], ctx)).toBe(0);
    const out = text();
    expect(out).toContain("opened pull request #14 on acme/ws");
    expect(out).toContain("nothing to approve in Catalyst");
    expect(envWrites("approve")).toEqual([]);
  });

  test("CTC-10761 — no config repository: the cloud's refusal is printed with how to get one, and exits 1", async () => {
    server.environmentForced = {
      propose: { status: 409, body: { error: "no_config_repository", message: "this workspace has no config repository" } },
    };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(1);
    const out = text();
    expect(out).toContain("this workspace has no config repository");
    expect(out).toContain("Settings, Environment");
  });

  test("an unchanged re-proposal is reported as unchanged, not as a new revision", async () => {
    server.accountEnvironment.current = { revision: 3, canonicalHash: "sha-3", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(0);
    expect(text()).toContain("unchanged: revision 3 (sha-3)");
  });

  test("the cloud's own invalid_declaration reason is printed verbatim and exits 1", async () => {
    server.environmentForced = {
      propose: { status: 400, body: { error: "invalid_declaration", reason: "asset_name_duplicated", message: "two assets share the name BUILD_TOKEN" } },
    };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(1);
    const out = text();
    expect(out).toContain("two assets share the name BUILD_TOKEN");
    expect(out).toContain("asset_name_duplicated");
  });
});

// ── approve ──────────────────────────────────────────────────────────────────────────────────────

describe("environment approve", () => {
  test("with no flags it reads the current state and approves EXACTLY that revision and hash", async () => {
    server.accountEnvironment.current = { revision: 5, canonicalHash: "sha-5", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "approve"], ctx)).toBe(0);
    // ⭐ The point of the CAS: the pair sent is the pair read, with nothing copied by hand between.
    expect(envWrites("approve")[0]?.body).toEqual({ revision: 5, canonicalHash: "sha-5" });
    expect(text()).toContain("approved: revision 5 (sha-5)");
    expect(server.accountEnvironment.approved).toEqual({ revision: 5, canonicalHash: "sha-5" });
  });

  test("an explicit pair that no longer matches is refused by the cloud and exits 1, approving nothing", async () => {
    server.accountEnvironment.current = { revision: 9, canonicalHash: "sha-9", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "approve", "--revision", "8", "--hash", "sha-8"], ctx)).toBe(1);
    const out = text();
    expect(out).toContain("refused (409)");
    expect(out).toContain("now at revision 9 (sha-9)");
    expect(server.accountEnvironment.approved).toBeNull();
  });

  test("CTC-10761 — approve refused by the cloud names merging the pull request as the way, and exits 1", async () => {
    server.accountEnvironment.current = { revision: 5, canonicalHash: "sha-5", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    server.environmentForced = {
      approve: { status: 409, body: { error: "declaration_comes_from_workspace_file", message: "this workspace takes its settings from catalyst.toml in acme/ws" } },
    };
    expect(await main(["environment", "approve"], ctx)).toBe(1);
    expect(text()).toContain("nothing is approved in Catalyst");
  });

  test("--revision without --hash is a usage error, so half a compare-and-set never reaches the cloud", async () => {
    expect(await main(["environment", "approve", "--revision", "2"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--revision and --hash together");
    expect(envWrites("approve")).toEqual([]);
  });

  test("nothing to approve says so and exits 1 rather than posting", async () => {
    expect(await main(["environment", "approve"], ctx)).toBe(1);
    expect(text()).toContain("there is no declaration to approve");
    expect(envWrites("approve")).toEqual([]);
  });

  test("CTC-10761 — nothing to approve and no config repository gives the config-repository guidance, not 'propose again'", async () => {
    expect(await main(["environment", "approve"], ctx)).toBe(1);
    const out = text();
    expect(out).toContain("config repository");
    expect(out).toContain("Settings, Environment");
    expect(out).not.toContain("propose one first");
    expect(envWrites("approve")).toEqual([]);
  });
});

// ── the one-command form the onboarding ladder uses ──────────────────────────────────────────────

describe("environment propose --approve", () => {
  test("proposes, then approves the revision the propose returned, and the tenant ends up delivering it", async () => {
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve"], ctx)).toBe(0);
    expect(envWrites("propose")).toHaveLength(1);
    expect(envWrites("approve")[0]?.body).toEqual({ revision: 1, canonicalHash: "sha-1" });
    expect(text()).toContain("it is now what a phase's checkout carries");
    expect(server.accountEnvironment.approved).toEqual({ revision: 1, canonicalHash: "sha-1" });
  });

  test("a propose that is refused never reaches approve", async () => {
    server.environmentForced = { propose: { status: 400, body: { error: "invalid_declaration", message: "bad" } } };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve"], ctx)).toBe(1);
    expect(envWrites("approve")).toEqual([]);
  });
});

// ── route discovery ──────────────────────────────────────────────────────────────────────────────

describe("the route paths come from the contract, never from a constant", () => {
  test("every call lands on the fixture's own prefix, which is not the production one", async () => {
    await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve"], ctx);
    const paths = server.writes.map((w) => w.path);
    expect(paths).toEqual([
      `${FIXTURE_ROUTE_PREFIX}/account-environment/propose`,
      `${FIXTURE_ROUTE_PREFIX}/account-environment/approve`,
    ]);
    for (const p of paths) expect(p.startsWith("/api/v1/agent/")).toBe(false);
  });

  test("a cloud whose contract serves no account-environment route is named as older, not 404'd", async () => {
    const doc = buildFixtureContract();
    doc.routes = doc.routes.filter((r) => !r.path.includes("account-environment"));
    server.contract = doc;
    home = tempHome();
    ctx = makeCtx(home);
    await seedJoined(home, server);
    expect(await main(["environment", "read"], ctx)).toBe(3);
    expect(ctx.err.join("\n")).toMatch(/needs a newer Catalyst Cloud/);
  });

  test("a cloud serving the GET but not the POSTs is refused by name, so a derived path is never assumed to exist", async () => {
    const doc = buildFixtureContract();
    doc.routes = doc.routes.filter((r) => !r.path.endsWith("account-environment/propose"));
    server.contract = doc;
    home = tempHome();
    ctx = makeCtx(home);
    await seedJoined(home, server);
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(3);
    expect(ctx.err.join("\n")).toContain("propose route");
  });
});

// ── the shapes the state machine does not produce on its own ─────────────────────────────────────

describe("environment usage errors are caught before any request", () => {
  test.each([
    [["environment", "read", "extra"], 'environment takes one subcommand (got an extra "extra")'],
    [["environment", "delete"], 'unknown environment subcommand "delete": read | propose | approve'],
  ])("%j is refused with its own sentence", async (argv, message) => {
    expect(await main(argv, ctx)).toBe(1);
    expect(ctx.err[0]).toBe(message);
    expect(server.writes).toEqual([]);
  });

  test("--file beside --stdin is refused, so which declaration was meant is never guessed", async () => {
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--stdin"], ctx)).toBe(1);
    expect(ctx.err[0]).toBe("environment propose takes --file <path> or --stdin, not both");
    expect(envWrites("propose")).toEqual([]);
  });

  test("an empty stdin and a non-JSON stdin are each refused as coming from stdin", async () => {
    expect(await main(["environment", "propose", "--stdin"], ctx, { environment: { readStdin: async () => "  \n" } })).toBe(1);
    expect(ctx.err[0]).toBe("the declaration on stdin is empty");
    const again = makeCtx(home);
    expect(await main(["environment", "propose", "--stdin"], again, { environment: { readStdin: async () => "{nope" } })).toBe(1);
    expect(again.err[0]).toMatch(/^the declaration on stdin is not JSON: /);
    expect(envWrites("propose")).toEqual([]);
  });

  test("an empty file is refused by its path", async () => {
    const path = declarationFile(DECLARATION);
    writeFileSync(path, "");
    expect(await main(["environment", "propose", "--file", path], ctx)).toBe(1);
    expect(ctx.err[0]).toBe(`the declaration in ${path} is empty`);
  });
});

describe("environment read with a sparse cloud answer", () => {
  test("an approved revision with no proposer, no approver, no delivered revision and no reference list still reads plainly", async () => {
    server.environmentForced = { read: { status: 200, body: { current: { revision: 2, canonicalHash: "sha-2", declaration: {} }, isApproved: true } } };
    expect(await main(["environment", "read"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["revision 2 (sha-2)", "approved", "delivered to phases: nothing yet"]);
  });

  test("an approval names who approved it", async () => {
    server.accountEnvironment.current = { revision: 1, canonicalHash: "sha-1", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    server.accountEnvironment.approved = { revision: 1, canonicalHash: "sha-1" };
    expect(await main(["environment", "read"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("revision 1 (sha-1), proposed by d1-user-tony");
    expect(ctx.out[1]).toMatch(/^approved by \S+$/);
    expect(ctx.out[2]).toBe("delivered to phases: revision 1 (sha-1)");
  });
});

describe("environment propose and approve in --json, and odd cloud answers", () => {
  test("a refused propose in --json prints the cloud's body and exits 1", async () => {
    const body = { error: "invalid_declaration", message: "bad" };
    server.environmentForced = { propose: { status: 400, body } };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out.join(""))).toEqual(body);
  });

  test("a refusal with no message, no reason and no revision says no reason was given", async () => {
    server.environmentForced = { propose: { status: 404, body: {} } };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused (404): no reason given"]);
  });

  test("a propose in --json prints only the cloud's body, with no human lines beside it", async () => {
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--json"], ctx)).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toMatchObject({ status: "created", state: { revision: 1, canonicalHash: "sha-1" } });
  });

  test("an unchanged propose does not tell the person to approve it again", async () => {
    server.accountEnvironment.current = { revision: 3, canonicalHash: "sha-3", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(0);
    expect(ctx.out).toEqual(["unchanged: revision 3 (sha-3)"]);
  });

  test("a success with no state and no status is reported as proposed-without-state, and --approve refuses to guess one", async () => {
    server.environmentForced = { propose: { status: 200, body: {} } };
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION)], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("proposed, but the cloud returned no state");
    const again = makeCtx(home);
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve"], again)).toBe(1);
    expect(again.err).toEqual(["the cloud returned no state to approve — run: catalyst environment read"]);
    expect(envWrites("approve")).toEqual([]);
  });

  test("propose --approve --json prints both answers, and exits 1 when the approve half is refused", async () => {
    expect(await main(["environment", "propose", "--file", declarationFile(DECLARATION), "--approve", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ propose: { status: "created" }, approve: { approved: true } });

    server.environmentForced = { approve: { status: 409, body: { error: "stale" } } };
    const again = makeCtx(home);
    expect(await main(["environment", "propose", "--file", declarationFile({ other: true }), "--approve", "--json"], again)).toBe(1);
    expect(JSON.parse(again.out.join(""))).toMatchObject({ propose: { status: "updated" }, approve: { error: "stale" } });
  });

  test("approve --json prints the cloud's answer and carries its exit code", async () => {
    server.accountEnvironment.current = { revision: 5, canonicalHash: "sha-5", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    expect(await main(["environment", "approve", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ approved: true, state: { revision: 5 } });
    const again = makeCtx(home);
    expect(await main(["environment", "approve", "--revision", "4", "--hash", "sha-4", "--json"], again)).toBe(1);
    expect(JSON.parse(again.out.join(""))).toMatchObject({ error: "stale", currentRevision: 5, currentHash: "sha-5" });
  });

  test("a refused approve with only a revision and no words says so without inventing a hash", async () => {
    server.accountEnvironment.current = { revision: 5, canonicalHash: "sha-5", declaration: DECLARATION, proposedBy: "d1-user-tony" };
    server.environmentForced = { approve: { status: 409, body: { currentRevision: 6 } } };
    expect(await main(["environment", "approve"], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused (409): no reason given", "  it is now at revision 6 — read it again before approving"]);
  });
});
