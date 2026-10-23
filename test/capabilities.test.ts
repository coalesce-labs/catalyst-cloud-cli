// capabilities.test.ts — CTC-4271. `catalyst capabilities`: the machine-readable list a setup guide
// reads instead of carrying its own verb table. Judged against the CACHED contract only (no network),
// so a verb that rides a route this cloud does not serve reads `needs_newer_cloud`, a local or
// read-plane verb is always `available`, and with no cache at all a route-bearing verb reads
// `cloud_unread` rather than a guess either way.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import type { ContractRoute } from "../src/contract-types";
import { CAPABILITIES, reportCapabilities } from "../src/capabilities";
import { FLAG_TABLES, VERB_USAGE } from "../src/args";
import { startMeFixture, type FixtureServer } from "./fixture";
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
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
});

type Report = {
  cli: { name: string; version: string };
  contract: { version: string; fetchedAt: string } | null;
  capabilities: { verb: string; needs: string; availability: string; missing: { method: string; path: string }[]; routes: unknown[] }[];
};

describe("the table itself", () => {
  test("every verb is unique, names a role, and every route is an agent route with a method", () => {
    const verbs = CAPABILITIES.map((c) => c.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
    for (const c of CAPABILITIES) {
      expect(["member", "admin"]).toContain(c.needs);
      expect(c.does.length).toBeGreaterThan(10);
      for (const r of c.routes) {
        expect(r.path.startsWith("/api/v1/agent/")).toBe(true);
        expect(["GET", "POST"]).toContain(r.method);
      }
    }
    expect(CAPABILITIES.find((c) => c.verb === "onboard")?.bootstrapHandoff).toBe(true);
    // CTC-4633: the installer forwards --headless only to a CLI that says it takes it.
    expect(CAPABILITIES.find((c) => c.verb === "onboard")?.headless).toBe(true);
    expect(CAPABILITIES.find((c) => c.verb === "setup")).toMatchObject({
      engineProtocol: 1,
      bootstrapHandoffVersion: 2,
    });
  });

  test("every verb the table names is one the dispatcher knows (the first word), and the verb has usage and a flag table", () => {
    for (const c of CAPABILITIES) {
      const head = c.verb.split(" ")[0]!.split("|")[0]!;
      expect(VERB_USAGE[head], `usage for ${head}`).toBeDefined();
      expect(FLAG_TABLES[head] ?? {}, `flag table for ${head}`).toBeDefined();
    }
  });

  test("the team verbs the setup guide relies on are declared admin, and reads are member", () => {
    const needs = Object.fromEntries(CAPABILITIES.map((c) => [c.verb, c.needs]));
    expect(needs["team check"]).toBe("admin");
    expect(needs["env import"]).toBe("admin");
    expect(needs["team map"]).toBe("admin");
    expect(needs["team adopt"]).toBe("admin");
    expect(needs["team list"]).toBe("member");
    expect(needs["mcp status"]).toBe("member");
    expect(needs["ready"]).toBe("member");
    expect(needs["environment approve"]).toBe("admin");
    expect(needs["project wip-limit get"]).toBe("member");
    expect(needs["project wip-limit set"]).toBe("admin");
    expect(needs["repo agents-block"]).toBe("member");
    expect(needs["repo agent-setup"]).toBe("member");
  });
  test("the update verbs name 0.16.31, the first published release that carries them (0.16.30 shipped before them)", () => {
    for (const verb of ["update", "update sdk", "update policy"]) {
      expect(CAPABILITIES.find((row) => row.verb === verb)?.since).toBe("0.16.31");
    }
  });
});

describe("availability against a contract", () => {
  test("a route the contract serves is available; one it does not serve is needs_newer_cloud, naming the route", () => {
    const routes = [{ method: "POST" as const, path: "/api/v1/agent/issue-comment", takesWriteBudgetUnit: true, since: "1.0.0" }];
    const report = Object.fromEntries(reportCapabilities(routes).map((r) => [r.verb, r]));
    expect(report["team check"]!.availability).toBe("needs_newer_cloud");
    expect(report["team check"]!.missing).toEqual([{ method: "POST", path: "/api/v1/agent/team-workflow/check" }]);
    // a verb with several routes needs every one of them
    expect(report["write comment|state|label|create|reaction|attachment|session"]!.availability).toBe("needs_newer_cloud");
    expect(report["write comment|state|label|create|reaction|attachment|session"]!.missing.map((m) => m.path)).not.toContain("/api/v1/agent/issue-comment");
    // a local or read-plane verb needs nothing from the cloud
    expect(report["ready"]!.availability).toBe("available");
    expect(report["status"]!.availability).toBe("available");
  });

  test("with no contract at all, a route-bearing verb is cloud_unread, never available and never missing", () => {
    const report = reportCapabilities(null);
    for (const r of report) {
      if (r.routes.length === 0) expect(r.availability).toBe("available");
      else {
        expect(r.availability).toBe("cloud_unread");
        expect(r.missing).toEqual([]);
      }
    }
  });
});

describe("the verb", () => {
  test("--json against a cached contract: the CLI's version, the contract's, and one row per capability", async () => {
    await seedJoined(home, server);
    const code = await main(["capabilities", "--json"], ctx);
    expect(code).toBe(0);
    const doc = JSON.parse(ctx.out.join("\n")) as Report;
    expect(doc.cli.name).toBe("catalyst");
    expect(doc.cli.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.contract?.version).toBe(server.contractVersion);
    expect(doc.capabilities.map((c) => c.verb)).toEqual(CAPABILITIES.map((c) => c.verb));
    const byVerb = Object.fromEntries(doc.capabilities.map((c) => [c.verb, c]));
    // the fixture contract's routes live under /api/v1/agent-fixture, so against it every route-bearing
    // verb is honestly `needs_newer_cloud`, naming the real route, and every local verb is available
    expect(byVerb["team check"]!.availability).toBe("needs_newer_cloud");
    expect(byVerb["team check"]!.missing).toEqual([{ method: "POST", path: "/api/v1/agent/team-workflow/check" }]);
    expect(byVerb["environment approve"]!.availability).toBe("needs_newer_cloud");
    expect(byVerb["ready"]!.availability).toBe("available");
  });

  test("with no cache: exit 0, and the human line says to run contract after connecting", async () => {
    const code = await main(["capabilities"], ctx);
    expect(code).toBe(0);
    expect(ctx.out[0]).toContain("no contract cached yet");
    expect(ctx.out[0]).toContain("catalyst contract");
    // one line per capability follows, each naming its role
    expect(ctx.out.length).toBe(1 + CAPABILITIES.length);
    for (const line of ctx.out.slice(1)) expect(line).toMatch(/ (member|admin) {2}/);
  });

  test("never reaches the network: a dead fetch changes nothing", async () => {
    await seedJoined(home, server);
    const offline = makeCtx(home, { fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch });
    expect(await main(["capabilities", "--json"], offline)).toBe(0);
    expect(JSON.parse(offline.out.join("\n")).capabilities.length).toBe(CAPABILITIES.length);
  });
});

test("mcp status is an available member read with no agent route dependencies", () => {
  expect(CAPABILITIES.find((row) => row.verb === "mcp status")).toMatchObject({
    verb: "mcp status", needs: "member", routes: [], since: "0.16.24",
  });
  expect(reportCapabilities(null).find((row) => row.verb === "mcp status")?.availability).toBe("available");
});

describe("repository lifecycle discovery", () => {
  const repoRoutes: ContractRoute[] = [
    { method: "GET", path: "/api/v1/agent/repos", takesWriteBudgetUnit: false, since: "1.0.0" },
    { method: "POST", path: "/api/v1/agent/repos/pause", takesWriteBudgetUnit: true, since: "1.0.0" },
    { method: "POST", path: "/api/v1/agent/repos/resume", takesWriteBudgetUnit: true, since: "1.0.0" },
  ];
  test("declares exact descriptions, roles and agent routes", () => {
    expect(CAPABILITIES.find((row) => row.verb === "repo status")).toMatchObject({
      does: "list visible repositories with their state, pause details and projects", needs: "member",
      routes: [{ method: "GET", path: "/api/v1/agent/repos" }],
    });
    expect(CAPABILITIES.find((row) => row.verb === "repo pause|resume")).toMatchObject({
      does: "pause or resume a repository as a workspace owner or admin", needs: "admin",
      routes: repoRoutes.map(({ method, path }) => ({ method, path })),
    });
  });
  test("both rows name 0.16.27, the first published release that carries them (0.16.26 was never published)", () => {
    const report = reportCapabilities(repoRoutes);
    for (const verb of ["repo status", "repo pause|resume"]) {
      expect(CAPABILITIES.find((row) => row.verb === verb)?.since).toBe("0.16.27");
      expect(report.find((row) => row.verb === verb)?.since).toBe("0.16.27");
    }
  });
  test("all exact routes make both rows available", () => {
    const report = reportCapabilities(repoRoutes);
    for (const verb of ["repo status", "repo pause|resume"]) {
      expect(report.find((row) => row.verb === verb)).toMatchObject({ availability: "available", missing: [] });
    }
  });
  test.each(repoRoutes)("missing $method $path names that exact dependency", (absent) => {
    const report = reportCapabilities(repoRoutes.filter((route) => route.path !== absent.path));
    expect(report.find((row) => row.verb === "repo pause|resume")).toMatchObject({
      availability: "needs_newer_cloud", missing: [{ method: absent.method, path: absent.path }],
    });
    expect(report.find((row) => row.verb === "repo status")?.availability).toBe(absent.method === "GET" ? "needs_newer_cloud" : "available");
  });
  test("no cached contract reports cloud_unread and makes no network requests", async () => {
    let requests = 0;
    const offline = makeCtx(home, { fetch: async () => { requests++; throw new Error("unexpected network call"); } });
    expect(await main(["capabilities", "--json"], offline)).toBe(0);
    const report: Report = JSON.parse(offline.out.join("\n"));
    for (const verb of ["repo status", "repo pause|resume"]) {
      expect(report.capabilities.find((row) => row.verb === verb)).toMatchObject({ availability: "cloud_unread", missing: [] });
    }
    expect(requests).toBe(0);
  });
});
