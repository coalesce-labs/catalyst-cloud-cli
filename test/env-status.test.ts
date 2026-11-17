// env-status.test.ts — CTC-10325: `catalyst env status` reads GET /api/v1/agent/repo-environments and
// prints the lines catalyst-cloud's private `catalyst-env env status` prints (CTC-5625, decision B on
// CTC-10276). Every expected line below is copied from catalyst-cloud's apps/cli/test/env-status.test.ts
// at 8df2a518, so the two commands cannot word the same answer differently. The fixture bodies follow
// that repository's repo-environment-routes.ts: {repository, defaultBranch, inEffect, applying}.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { main } from "../src/cli";
import { configPathFor } from "../src/config";
import { CONTRACT_ROUTE } from "../src/contract";
import { buildFixtureContract } from "./fixture-contract";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

type Request = { method: string; path: string; authorization: string | null };
const key = "ctc_user_env_status_fixture";
const SHA_FULL = "3713dc3009c56d76b2527a849094b9366100b263";
const SHA_NEXT = "9f0e1d2c3b4a59687766554433221100ffeeddcc";
const ROUTE = "/api/v1/agent/repo-environments";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const NOTE = "A merge or push to main approves the settings file, so there is nothing to approve in Catalyst.";

const contractDoc = (withRoute: boolean, contractVersion = withRoute ? "2.71.0" : "2.70.0") => {
  const doc = buildFixtureContract();
  return {
    ...doc,
    contractVersion,
    routes: withRoute
      ? [...doc.routes, { method: "GET", path: ROUTE, takesWriteBudgetUnit: false, idempotencyKeyField: null, since: "2.71.0" }]
      : doc.routes,
  };
};
const branchApproval = (over: Record<string, unknown> = {}) => ({
  kind: "default-branch", commitSha: SHA_FULL, branch: "main", ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  repository: "acme/pancetta",
  defaultBranch: "main",
  inEffect: { revision: 2, canonicalHash: "h2", approval: branchApproval() },
  applying: null,
  ...over,
});

let home: string;
let ctx: TestCtx;
let requests: Request[];
let withRoute: boolean;
let answer: () => Response;
let origin: string | null;

const run = (...args: string[]) =>
  main(["env", "status", ...args], ctx, { env: { status: { originRepository: async () => origin } } });

beforeEach(() => {
  home = tempHome();
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    baseUrl: "https://cloud.example", key, account: "account-fixture", slug: "fixture", name: "Fixture",
    permissions: [], principal: "session", joinedAt: "2026-09-01T00:00:00Z",
  }));
  requests = [];
  withRoute = true;
  origin = "acme/pancetta";
  answer = () => json(body());
  ctx = makeCtx(home, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", path: url.pathname + url.search, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname === CONTRACT_ROUTE) return json(contractDoc(withRoute));
      return answer();
    },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const everything = () => [...ctx.out, ...ctx.err].join("\n");

describe("catalyst env status (CTC-10325)", () => {
  test("⭐ a merged pull request is named in full: 'Approved automatically when pull request #8810 merged as commit <40-char sha> into main.'; exit 0", async () => {
    answer = () => json(body({ inEffect: { revision: 2, canonicalHash: "h2", approval: branchApproval({ pullRequest: { number: 8810 } }) } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual([
      "acme/pancetta: revision 2 is in effect for new phases.",
      `Approved automatically when pull request #8810 merged as commit ${SHA_FULL} into main.`,
      NOTE,
    ]);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${CONTRACT_ROUTE}`,
      `GET ${ROUTE}?repo=acme%2Fpancetta`,
    ]);
  });

  test("⭐ a direct push names the commit: 'Approved automatically when commit <40-char sha> reached main.'; exit 0", async () => {
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual([
      "acme/pancetta: revision 2 is in effect for new phases.",
      `Approved automatically when commit ${SHA_FULL} reached main.`,
      NOTE,
    ]);
  });

  test("an approval with no recorded commit says the revision reached the branch", async () => {
    answer = () => json(body({ inEffect: { revision: 2, canonicalHash: "h2", approval: branchApproval({ commitSha: null }) } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out[1]).toBe("Approved automatically when this revision reached main.");
  });

  test("an approval naming no branch says 'the default branch'", async () => {
    answer = () => json(body({ inEffect: { revision: 2, canonicalHash: "h2", approval: branchApproval({ branch: null }) } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out[1]).toBe(`Approved automatically when commit ${SHA_FULL} reached the default branch.`);
    expect(ctx.out[2]).toBe("A merge or push to the default branch approves the settings file, so there is nothing to approve in Catalyst.");
  });

  test("an applying revision prints 'Catalyst is applying revision 3 from commit <sha> on main.'; exit 0", async () => {
    answer = () => json(body({ applying: { revision: 3, commitSha: SHA_NEXT, restoreHeld: false } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual([
      "acme/pancetta: revision 2 is in effect for new phases.",
      `Approved automatically when commit ${SHA_FULL} reached main.`,
      NOTE,
      `Catalyst is applying revision 3 from commit ${SHA_NEXT} on main. New phases use revision 2 until it is applied.`,
    ]);
  });

  test("a first revision still applying says no declaration is in effect and that Catalyst is applying it", async () => {
    answer = () => json(body({ inEffect: null, applying: { revision: 1, commitSha: SHA_NEXT, restoreHeld: false } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual([
      "acme/pancetta: no declaration is in effect for new phases.",
      `Catalyst is applying revision 1 from commit ${SHA_NEXT} on main.`,
    ]);
  });

  test("a revision with no commit is named as not coming from the settings file", async () => {
    answer = () => json(body({ applying: { revision: 3, commitSha: null, restoreHeld: false } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out.at(-1)).toBe("Revision 3 is not in effect: it did not come from .catalyst/catalyst.toml on main.");
  });

  test("a revision held behind a restore says the restored revision stays in effect", async () => {
    answer = () => json(body({ applying: { revision: 3, commitSha: SHA_NEXT, restoreHeld: true } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out.at(-1)).toBe(
      `Revision 3 from commit ${SHA_NEXT} on main is not in effect: revision 2 was restored, and it stays in effect until [environment] changes on main.`,
    );
  });

  test("a restored revision prints 'Revision 2 was restored from revision 1 by an admin or owner.' and no approval line", async () => {
    answer = () => json(body({ inEffect: { revision: 2, canonicalHash: "h2", approval: { kind: "restore", sourceRevision: 1 } } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual([
      "acme/pancetta: revision 2 is in effect for new phases.",
      "Revision 2 was restored from revision 1 by an admin or owner.",
    ]);
    expect(everything()).not.toContain("Approved automatically");
  });

  test("a manual approval prints only the revision line", async () => {
    answer = () => json(body({ inEffect: { revision: 1, canonicalHash: "h1", approval: { kind: "manual" } } }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual(["acme/pancetta: revision 1 is in effect for new phases."]);
  });

  test("no revision in effect prints 'acme/pancetta: no declaration is in effect for new phases.'; exit 0", async () => {
    answer = () => json(body({ inEffect: null }));
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(ctx.out).toEqual(["acme/pancetta: no declaration is in effect for new phases."]);
  });

  test("with no --repo, the checkout's origin remote names the repository", async () => {
    origin = "acme/pancetta";
    expect(await run()).toBe(0);
    expect(requests.at(-1)?.path).toBe(`${ROUTE}?repo=acme%2Fpancetta`);
  });

  test("an origin that names no GitHub repository exits 1 and calls nothing", async () => {
    origin = null;
    expect(await run()).toBe(1);
    expect(ctx.err.join("\n")).toContain("pass --repo OWNER/NAME");
    expect(requests).toEqual([]);
  });

  test("a malformed --repo is a usage error and calls nothing", async () => {
    expect(await run("--repo", "not a repo")).toBe(1);
    expect(ctx.err.join("\n")).toContain("--repo OWNER/NAME");
    expect(requests).toEqual([]);
  });

  test("⭐ a cloud whose contract has no repo-environments row is named as older, and the read is never called", async () => {
    withRoute = false;
    expect(await run("--repo", "acme/pancetta")).toBe(2);
    expect(ctx.err.join("\n")).toContain("does not publish the repository environment read yet (contract 2.70.0)");
    expect(requests.map((r) => r.path)).toEqual([CONTRACT_ROUTE]);
  });

  test("a repository outside the workspace answers 404 and exits 1", async () => {
    answer = () => json({ error: "not_found" }, 404);
    expect(await run("--repo", "acme/elsewhere")).toBe(1);
    expect(ctx.err).toContain("acme/elsewhere is not a repository in this workspace");
  });

  test("an unusable body exits 2 and prints no status line", async () => {
    answer = () => json({ repository: "acme/pancetta", inEffect: { revision: "two" }, applying: null });
    expect(await run("--repo", "acme/pancetta")).toBe(2);
    expect(ctx.out).toEqual([]);
  });

  test("--json prints the cloud's answer as it came", async () => {
    const raw = body({ inEffect: { revision: 2, canonicalHash: "h2", approval: branchApproval({ pullRequest: { number: 8810 } }) } });
    answer = () => json(raw);
    expect(await run("--repo", "acme/pancetta", "--json")).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual(raw);
  });

  test("the key goes only in the authorization header and never in any printed line", async () => {
    expect(await run("--repo", "acme/pancetta")).toBe(0);
    expect(requests.every((r) => r.authorization === `Bearer ${key}`)).toBe(true);
    expect(everything()).not.toContain(key);
  });
});
