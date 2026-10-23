import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { archiveReturningProject } from "../src/onboard-project-cleanup.js";
import { parseArgs } from "../src/args.js";
import { defaultCtx, loadConfig, writeConfig } from "../src/config.js";
import { cmdOnboard, ONBOARD_STEPS, onboardStatePath, type OnboardJournal, type OnboardAdapter } from "../src/onboard.js";
import { readReturningProjects, returningWorkspaceAdapters, type ReturningChoice } from "../src/onboard-returning.js";
import { onboardJsonView, setupFinalScreen } from "../src/setup-onboard-copy.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "returning-workspace-")); homes.push(home);
  const identity = { account: "account-a", membershipId: "person-a", baseUrl: "https://fixture.invalid", role: "owner" as const };
  const now = Date.parse("2026-10-08T12:00:00Z");
  writeConfig(home, { account: identity.account, baseUrl: identity.baseUrl, key: "ctc_user_fixture",
    principal: "session", slug: "a", name: "Workspace A", permissions: null, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.16.0",
    user: { id: identity.membershipId, role: "owner", label: "Person", email: null, linearUserId: null } });
  const ctx = { ...defaultCtx(), home, env: {}, now: () => new Date(now), stdout: () => {}, stderr: () => {} };
  const projects = [
    { id: "team-cloud", key: "CTC", name: "Catalyst Cloud", repositories: { registered: ["org/cloud", "org/cli"] } },
    { id: "team-sdk", key: "SDK", name: "SDK", repositories: { registered: ["org/sdk"] } },
    { id: "team-unconfigured", key: "OTHER", name: "Other", repositories: { registered: [] } },
  ];
  let contract: unknown = { account: { id: identity.account }, teams: projects, routes: [{ method: "GET", path: "/api/v1/agent/tenant/repositories" }] };
  let rows = projects.slice(0, 2).flatMap(p => p.repositories.registered.map((name, i) => ({ id: `account-a:${p.id}-${i}`, name: p.name, linearTeamId: p.id, linearTeamKey: p.key, status: "active", githubRepoOwner: name.split("/")[0], githubRepoName: name.split("/")[1] })));
  let failInventory = false, failReadiness = false, archiveAllowed = false, failArchiveAfter = Infinity;
  let linkedExtra: string[] = [], failLinks = false;
  const archived: string[] = [];
  const requests: string[] = [];
  ctx.fetch = (async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method && init.method !== "GET") {
      if (!archiveAllowed || init.method !== "POST") throw new Error("unexpected project write");
      const match = /^\/api\/v1\/me\/repositories\/([^/]+)\/archive$/.exec(url.pathname);
      const row = match ? rows.find(r => r.id === decodeURIComponent(match[1]!)) : undefined;
      if (!row || archived.length >= failArchiveAfter) return Response.json({}, { status: 503 });
      expect(init.redirect).toBe("error");
      expect(init.body).toBe("{}");
      row.status = "archived"; archived.push(row.id);
      return Response.json({ repository: row });
    }
    const linkedMatch = /^\/api\/v1\/me\/projects\/([^/]+)\/repositories$/.exec(url.pathname);
    if (linkedMatch) {
      const row = rows.find(r => r.id === decodeURIComponent(linkedMatch[1]!));
      if (!row) return Response.json({}, { status: 404 });
      if (failLinks) return Response.json({}, { status: 403 });
      const names = [...projects.find(p => p.id === row.linearTeamId)!.repositories.registered, ...linkedExtra];
      return Response.json({ project: { id: row.id, teamId: row.linearTeamId }, repositories: names.map(fullName => ({ fullName })) });
    }
    if (url.pathname === "/api/v1/agent/teams") return Response.json({ teams: projects.map(p => ({ teamId: p.id, teamKey: p.key, teamName: p.name })) });
    if (url.pathname === "/api/v1/agent/contract") return Response.json(contract, { status: failInventory ? 503 : 200 });
    if (url.pathname === "/api/v1/agent/tenant/repositories") return Response.json({ canManage: true, repositories: rows });
    if (url.pathname === "/api/v1/agent/tenant/readiness") {
      const sdk = url.searchParams.get("team") === "team-sdk";
      return Response.json({ readiness: { teamId: url.searchParams.get("team"), status: sdk ? "blocked" : "ready", checkedAt: now, workflowRev: 1,
        checks: [{ id: "merge_queue_configured", state: sdk ? "fail" : "pass" }] } }, { status: failReadiness ? 503 : 200 });
    }
    throw new Error("unexpected read");
  }) as typeof fetch;
  const journal: OnboardJournal = { schema: 1, runId: "returning", installer: null, cli: "0.16.0", tenant: identity.account,
    ...identity, exit: null, steps: [], changes: [] };
  return { ctx, journal, identity, requests, archived,
    changeLinks: () => { linkedExtra.push(linkedExtra.length ? "org/linked-next" : "org/linked"); },
    failLinks: () => { failLinks = true; },
    pauseCloud: () => { rows = rows.map(r => r.linearTeamId === "team-cloud" ? { ...r, status: "paused" } : r); },
    allowArchive: (failAfter = Infinity) => { archiveAllowed = true; failArchiveAfter = failAfter; },
    changeSdk: () => { rows = rows.map(r => r.linearTeamId === "team-sdk" ? { ...r, githubRepoName: "changed" } : r); },
    empty: () => { rows = []; },
    omitMappedTeams: () => { (contract as { teams: unknown[] }).teams = []; },
    archiveSdk: () => { rows = rows.map(row => row.linearTeamId === "team-sdk" ? { ...row, status: "archived" } : row); },
    breakInventory: () => { failInventory = true; }, breakReadiness: () => { failReadiness = true; } };
}

test("counts each configured project once across repositories and names its actual unfinished check", async () => {
  const f = fixture();
  const read = await readReturningProjects(f.ctx, f.journal);
  expect(read).toMatchObject({ projects: [{ id: "team-cloud", status: "Ready" }, { id: "team-sdk" }] });
  if ("reason" in read) throw new Error(read.reason);
  expect(read.projects).toHaveLength(2);
  expect(read.projects[1]!.status).toContain("merge queue");
  expect(read.projects[1]!.status).not.toContain("merge_queue_configured");
});

test("a known empty contract and an unreadable inventory are distinct", async () => {
  const f = fixture(); f.empty();
  expect(await readReturningProjects(f.ctx, f.journal)).toEqual({ projects: [] });
  f.breakInventory();
  expect(await readReturningProjects(f.ctx, f.journal)).toEqual({ reason: "returning_inventory_unverified" });
});

test("a failed readiness read keeps the known project count with unknown statuses", async () => {
  const f = fixture(); f.breakReadiness();
  const read = await readReturningProjects(f.ctx, f.journal);
  expect(read).toMatchObject({ projects: [{ status: expect.stringContaining("could not be checked") }, { status: expect.stringContaining("could not be checked") }] });
});

test("moving on records the project skip, runs machine steps, and never claims the workspace is ready", async () => {
  const f = fixture(), args = parseArgs(["onboard", "--yes"]);
  const executed: string[] = [], messages: string[] = [];
  const adapters = Object.fromEntries(ONBOARD_STEPS.map(id => [id, { check: async () => { executed.push(id); return { state: "done" as const }; } }]));
  returningWorkspaceAdapters(adapters, args, undefined, text => messages.push(text), () => { throw new Error("new project not requested"); });
  expect(await cmdOnboard(args, f.ctx, { adapters, identity: async () => f.identity, bindSignals: false })).toBe(0);
  expect(executed).toEqual(["machine", "cli", "skills", "legacy", "signin", "daemon", "housekeeping", "accounts", "runner"]);
  const receipt = JSON.parse(readFileSync(onboardStatePath(f.ctx.home, f.ctx.env), "utf8")) as OnboardJournal;
  expect(receipt.steps.find(s => s.id === "projects")).toMatchObject({ state: "skipped", reason: "returning_workspace_move_on", evidence: { projectCount: 2 } });
  expect(messages[0]).toBe("This workspace already has 2 Catalyst projects.");
  expect(setupFinalScreen(receipt).heading).toBe("This computer is set up");
  expect(onboardJsonView(receipt).verdict).toBe("machine-complete");
  expect(args.flags.team).toBeUndefined();
  expect(f.requests.every(r => r.startsWith("GET "))).toBe(true);
});

test.each(["new", { repair: "team-sdk" }] as ReturningChoice[])("an explicit project choice carries only the selected context: %j", async choice => {
  const f = fixture(), args = parseArgs(["onboard"]), create = vi.fn(), act = vi.fn(async () => ({ state: "pending" as const }));
  const adapters: Record<"linear.workspace" | "projects", OnboardAdapter> = { "linear.workspace": { check: act }, projects: { check: act } };
  returningWorkspaceAdapters(adapters, args, async () => choice, () => {}, create);
  await adapters["linear.workspace"].check(f.ctx, f.journal);
  expect(act).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledTimes(choice === "new" ? 1 : 0);
  expect(args.flags.team).toBe(choice === "new" ? undefined : "team-sdk");
});

test("unknown inventory blocks project actions instead of treating the workspace as new", async () => {
  const f = fixture(); f.breakInventory();
  const act = vi.fn(async () => ({ state: "pending" as const }));
  const adapters: Record<"linear.workspace" | "projects", OnboardAdapter> = { "linear.workspace": { check: act, act }, projects: { check: act, act } };
  returningWorkspaceAdapters(adapters, parseArgs(["onboard"]), undefined, () => {}, () => {});
  expect(await adapters["linear.workspace"].check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "returning_inventory_unverified" });
  expect(await adapters.projects.act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "returning_inventory_unverified" });
  expect(act).not.toHaveBeenCalled();
});

 test("the complete project read includes projects omitted from mapped-team contract context", async () => {
   const f = fixture(); f.omitMappedTeams();
   expect(await readReturningProjects(f.ctx, f.journal)).toMatchObject({ projects: [{ id: "team-cloud" }, { id: "team-sdk" }] });
 });
 test("archived repository rows do not count as current projects", async () => {
   const f = fixture(); f.archiveSdk();
   const read = await readReturningProjects(f.ctx, f.journal);
   if ("reason" in read) throw new Error(read.reason);
   expect(read.projects.map(p => p.id)).toEqual(["team-cloud"]);
 });


test.each([false, true])("cleanup requires its own preview approval and changes only the selected project (approve %s)", async approve => {
  const f = fixture(); f.allowArchive();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const selected = inventory.projects.find(p => p.id === "team-sdk")!;
  const result = await archiveReturningProject(selected, f.ctx, f.journal, async (project, lines) => {
    expect(project.id).toBe("team-sdk"); expect(f.archived).toEqual([]);
    expect(lines.join("\n")).toContain("Repository affected: org/sdk.");
    expect(lines.join("\n")).not.toContain("org/cloud");
    return approve;
  });
  expect(result.state).toBe("done");
  expect(f.archived).toEqual(approve ? ["account-a:team-sdk-0"] : []);
  expect(f.journal.changes).toHaveLength(approve ? 1 : 0);
});

test("a changed cleanup preview makes no project write", async () => {
  const f = fixture(); f.allowArchive();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const result = await archiveReturningProject(inventory.projects.find(p => p.id === "team-sdk")!, f.ctx, f.journal, async () => {
    f.changeSdk(); return true;
  });
  expect(result).toEqual({ state: "waiting", reason: "returning_project_cleanup_changed" });
  expect(f.archived).toEqual([]);
});

test("partial cleanup records confirmed changes and preserves the unknown remainder", async () => {
  const f = fixture(); f.allowArchive(1);
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const result = await archiveReturningProject(inventory.projects.find(p => p.id === "team-cloud")!, f.ctx, f.journal, async () => true);
  expect(result).toEqual({ state: "waiting", reason: "returning_project_cleanup_unverified" });
  expect(f.archived).toEqual(["account-a:team-cloud-0"]);
  expect(f.journal.changes).toHaveLength(1);
});

test("choosing cleanup in check makes no change; act previews then archives before machine-only continuation", async () => {
  const f = fixture(); f.allowArchive();
  const adapters: Partial<Record<typeof ONBOARD_STEPS[number], OnboardAdapter>> = {
    "linear.workspace": { check: async () => ({ state: "done" }), act: async () => { throw new Error("project setup not requested"); } },
    "linear.team": { check: async () => { throw new Error("team selection not requested"); } },
  };
  returningWorkspaceAdapters(adapters, parseArgs(["onboard"]), async () => ({ cleanup: "team-sdk" }), () => {}, () => {}, () => true,
    (project, ctx, journal, signal) => archiveReturningProject(project, ctx, journal, async () => true, signal));
  expect(await adapters["linear.workspace"]!.check(f.ctx, f.journal)).toMatchObject({ state: "pending" });
  expect(f.archived).toEqual([]);
  expect(await adapters["linear.workspace"]!.act!(f.ctx, f.journal)).toMatchObject({ state: "skipped", reason: "returning_workspace_move_on" });
  expect(f.archived).toEqual(["account-a:team-sdk-0"]);
  expect(await adapters["linear.team"]!.check(f.ctx, f.journal)).toMatchObject({ state: "skipped" });
});


test("cleanup stops before writing when the signed-in workspace changes after approval", async () => {
  const f = fixture(); f.allowArchive();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const result = await archiveReturningProject(inventory.projects[0]!, f.ctx, f.journal, async () => {
    writeConfig(f.ctx.home, { ...loadConfig(f.ctx.home)!, account: "other-workspace" });
    return true;
  });
  expect(result).toEqual({ state: "waiting", reason: "returning_project_cleanup_unverified" });
  expect(f.archived).toEqual([]);
});

test("the receipt engine runs chosen machine steps after confirmed project cleanup", async () => {
  const f = fixture(); f.allowArchive();
  const executed: string[] = [];
  const adapters = Object.fromEntries(ONBOARD_STEPS.map(id => [id, {
    check: async () => { executed.push(id); return { state: "done" as const }; },
    act: async () => { throw new Error("unselected project write"); },
  }]));
  const args = parseArgs(["onboard", "--yes"]);
  returningWorkspaceAdapters(adapters, args, async () => ({ cleanup: "team-sdk" }), () => {}, () => {}, () => true,
    (project, ctx, journal, signal) => archiveReturningProject(project, ctx, journal, async () => true, signal));
  expect(await cmdOnboard(args, f.ctx, { adapters, identity: async () => f.identity, bindSignals: false })).toBe(0);
  expect(f.archived).toEqual(["account-a:team-sdk-0"]);
  expect(executed).toEqual(["machine", "cli", "skills", "legacy", "signin", "daemon", "housekeeping", "accounts", "runner"]);
  const saved = JSON.parse(readFileSync(onboardStatePath(f.ctx.home), "utf8")) as OnboardJournal;
  expect(saved.changes).toHaveLength(1);
  expect(saved.steps.find(s => s.id === "linear.team")).toMatchObject({ state: "skipped", reason: "returning_workspace_move_on" });
  expect(onboardJsonView(saved, f.ctx.home).verdict).toBe("machine-complete");
});


test("cleanup previews linked repositories and refuses a changed linked set before any archive", async () => {
  const f = fixture(); f.allowArchive(); f.changeLinks();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const result = await archiveReturningProject(inventory.projects.find(p => p.id === "team-sdk")!, f.ctx, f.journal, async (_project, lines) => {
    expect(lines.join("\n")).toContain("Repository affected: org/linked.");
    f.changeLinks(); return true;
  });
  expect(result).toEqual({ state: "waiting", reason: "returning_project_cleanup_changed" });
  expect(f.archived).toEqual([]);
});

test("an unavailable linked-repository inventory makes no preview or write", async () => {
  const f = fixture(); f.allowArchive(); f.failLinks();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  const confirm = vi.fn(async () => true);
  expect(await archiveReturningProject(inventory.projects[0]!, f.ctx, f.journal, confirm)).toMatchObject({ state: "waiting" });
  expect(confirm).not.toHaveBeenCalled(); expect(f.archived).toEqual([]);
});

test("paused registry entries stay visibly paused even when readiness checks pass", async () => {
  const f = fixture(); f.pauseCloud();
  const inventory = await readReturningProjects(f.ctx, f.journal);
  if ("reason" in inventory) throw new Error(inventory.reason);
  expect(inventory.projects[0]!.status).toBe("Paused: org/cloud, org/cli. Readiness checks pass.");
});
