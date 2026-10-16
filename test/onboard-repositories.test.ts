import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { configPathFor, defaultCtx, writeConfig, type Ctx } from "../src/config.js";
import { cmdOnboard, onboardStatePath, readOnboardJournal, type OnboardJournal } from "../src/onboard.js";
import { existingRepositoryAdapter, selectedOnboardRepositories, type ChooseExistingRepositories } from "../src/onboard-repositories.js";

const homes: string[] = [];
const now = new Date("2026-09-30T20:00:00Z");
const binding = { owner: "example", name: "service", teamId: "team-a", teamKey: "A", label: "Service" };
const repository = { owner: "example", name: "service", repoId: "actual-repo-a" };
function fixture(argv: string[] = [], choose?: ChooseExistingRepositories) {
  const home = mkdtempSync(join(tmpdir(), "onboard-repositories-")); homes.push(home);
  writeConfig(home, { account: "account-a", slug: "a", name: "A", permissions: null, principal: "session", baseUrl: "https://fixture.invalid", key: "ctc_user_fixture",
    user: { id: "person-a", role: "owner", label: "A", email: "a@example.invalid", linearUserId: null }, joinedAt: now.toISOString(), lastSkillBundleVersion: "0.14.1" });
  let bindings: unknown = [binding];
  let contract: unknown = { contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [repository] }, projects: [{ id: "wrong-project-id" }] };
  let readResponse: ((path: string) => Response | null) | undefined;
  const reads: string[] = [];
  const ctx: Ctx = { ...defaultCtx(), home, env: {}, now: () => now, stdout: () => {}, stderr: () => {}, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    reads.push(`${init?.method ?? "GET"} ${path}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ctc_user_fixture");
    const override = readResponse?.(path);
    if (override) return override;
    if (path === "/api/v1/repos") return Response.json({ repos: bindings });
    if (path === "/api/v1/agent/contract") return Response.json(contract);
    return new Response(null, { status: 404 });
  }) as typeof fetch };
  const journal: OnboardJournal = { schema: 1, runId: "run-a", installer: null, cli: "0.14.1", tenant: "account-a", account: "account-a", membershipId: "person-a", baseUrl: "https://fixture.invalid", exit: null,
    steps: [{ id: "linear.team", state: "done", evidence: { team: "team-a" } }], changes: [] };
  const args = parseArgs(["onboard", "--yes", ...argv]);
  const adapter = existingRepositoryAdapter(args, choose);
  return { home, ctx, journal, args, adapter, reads, setBindings: (value: unknown) => { bindings = value; }, setContract: (value: unknown) => { contract = value; }, setResponse: (value: typeof readResponse) => { readResponse = value; } };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("explicit repository selection", () => {
  test("even one accessible repository needs an explicit answer in unattended mode", async () => {
    const f = fixture();
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_choice_required", evidence: { choices: "example/service" } });
    expect(f.journal.steps).toHaveLength(1);
  });
  test("fresh ACL binding joins the real repo ID, never the project ID or cached inventory", async () => {
    const f = fixture(["--repo", "EXAMPLE/service"]);
    const before = readFileSync(configPathFor(f.home), "utf8");
    const result = await f.adapter.check(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(JSON.parse(String(result.evidence?.repository))).toEqual([{ ...repository, teamId: "team-a" }]);
    // CTC-4742: the per-person repository list is read first; this server has none (404), so the
    // one-per-team registry answers, as before.
    expect(f.reads).toEqual(["GET /api/v1/agent/repos", "GET /api/v1/repos", "GET /api/v1/agent/contract"]);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    expect(JSON.stringify(result)).not.toContain("wrong-project-id");
  });
  test("contract-only and other-team repositories cannot become choices", async () => {
    const f = fixture(["--repo", "example/private"]);
    f.setBindings([binding, { ...binding, name: "private", teamId: "team-b" }]);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [repository, { ...repository, name: "private", repoId: "private-id" }] } });
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_selection_unverified" });
  });
  test.each([
    { contractVersion: "1.24.0", account: { id: "foreign" }, merge: { repositories: [repository] } },
    { contractVersion: "99.0.0", account: { id: "account-a" }, merge: { repositories: [repository] } },
    { contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [{ ...repository, repoId: "bad/id" }] } },
    { contractVersion: "1.24.0", account: { id: "account-a" }, projects: [{ id: "wrong-project-id" }] },
  ])("invalid contract cannot grant an ID %#", async value => {
    const f = fixture(["--repo", "example/service"]); f.setContract(value);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_contract_unverified" });
  });
  test.each([[], [repository, { ...repository, owner: "EXAMPLE" }], [repository, { ...repository, repoId: "other-id" }]].map(repositories => ({ repositories })))("absent or duplicate ID matches remain unknown %#", async ({ repositories }) => {
    const f = fixture(["--repo", "example/service"]);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories } });
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_id_unverified" });
  });
  test("duplicate accessible binding is ambiguous even when the ID matches", async () => {
    const f = fixture(["--repo", "example/service"]); f.setBindings([binding, { ...binding, owner: "EXAMPLE" }]);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_binding_ambiguous" });
  });
  test("the same repository ID cannot grant two different repository names", async () => {
    const f = fixture(["--repo", "example/service"]);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [repository, { ...repository, name: "different" }] } });
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_contract_unverified" });
  });
  test.each(["/api/v1/repos", "/api/v1/agent/contract"])("non-200 success responses cannot prove a fresh selection (%s)", async path => {
    const f = fixture(["--repo", "example/service"]);
    f.setResponse(actual => actual === path ? Response.json(path.endsWith("repos") ? { repos: [binding] } : { contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [repository] } }, { status: 206 }) : null);
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
  });
  test.each(["/api/v1/repos", "/api/v1/agent/contract"])("a stalled body cannot outlive cancellation (%s)", async path => {
    const f = fixture(["--repo", "example/service"]); const stop = new AbortController();
    f.setResponse(actual => actual === path ? { status: 200, json: async () => { stop.abort(); return new Promise(() => {}); } } as Response : null);
    await expect(f.adapter.check(f.ctx, f.journal, stop.signal)).rejects.toMatchObject({ exitCode: 11 });
    expect(f.journal.steps).toHaveLength(1);
  });
  test.each([["--repo", "example/service", "--repo", "EXAMPLE/service"], ["--repo", "../service"], ["--repo", "missing/repository"]].map(argv => ({ argv })))("unverified explicit selection is not accepted %#", async ({ argv }) => {
    const f = fixture(argv);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_selection_unverified" });
  });
  test("a saved selection is rechecked and cannot reuse a changed repository ID", async () => {
    const f = fixture(["--repo", "example/service"]);
    const selected = await f.adapter.check(f.ctx, f.journal);
    f.journal.steps.push({ id: "github.repos", state: "done", evidence: selected.evidence });
    expect(selectedOnboardRepositories(f.journal)).toHaveLength(1);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [{ ...repository, repoId: "replacement-id" }] } });
    const resumed = existingRepositoryAdapter(parseArgs(["onboard", "--yes"]));
    expect(await resumed.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_selection_unverified" });
  });
  test("mutating chooser options cannot grant a new repository", async () => {
    const f = fixture([], async rows => { (rows[0] as { owner: string }).owner = "injected"; return ["injected/service"]; });
    expect(await f.adapter.act!(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_selection_unverified" });
    expect(f.journal.steps).toHaveLength(1);
  });
  test("chooser cancellation bounds an ignoring hook and ignores its late answer", async () => {
    const controller = new AbortController(); let release: ((value: string[]) => void) | undefined;
    const f = fixture([], async () => new Promise(resolve => { release = resolve; controller.abort(); }));
    expect(await f.adapter.act!(f.ctx, f.journal, controller.signal)).toEqual({ state: "waiting", reason: "interrupted" });
    release?.(["example/service"]); await Promise.resolve();
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "pending" });
    expect(f.journal.steps).toHaveLength(1);
  });
  test("selection disappearance during Q3's fresh recheck does not approve it", async () => {
    const f = fixture([], async () => { f.setBindings([]); return ["example/service"]; });
    expect(await f.adapter.act!(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_inventory_empty" });
  });
  test("identity mismatch makes no inventory request", async () => {
    const f = fixture(["--repo", "example/service"]); f.journal.membershipId = "other-person";
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_identity_unverified" });
    expect(f.reads).toEqual([]);
  });
  test("malformed saved choices do not become unattended defaults", async () => {
    const f = fixture(); f.journal.steps.push({ id: "github.repos", state: "done", evidence: { repository: '[{"owner":"example","name":"service","repoId":"actual-repo-a"}]' } });
    expect(selectedOnboardRepositories(f.journal)).toEqual([]);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_choice_required", evidence: { choices: "example/service" } });
  });
  test("unsupported GitHub installation prevents repository selection from claiming progress", async () => {
    const f = fixture(["--only", "github.repos", "--repo", "example/service"]);
    const done = { check: async () => ({ state: "done" as const }) };
    expect(await cmdOnboard(f.args, f.ctx, { bindSignals: false,
      adapters: { signin: done, "linear.workspace": done, "linear.personal": done, "linear.team": { check: async () => ({ state: "done", evidence: { team: "team-a" } }) },
        "github.install": { check: async () => ({ state: "waiting", reason: "cloud_capability_unavailable" }) }, "github.repos": f.adapter } })).toBe(11);
    const journal = readOnboardJournal(onboardStatePath(f.home))!;
    expect(journal.steps.find(row => row.id === "github.repos")).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
    expect(f.reads).toEqual([]);
    expect(journal.complete).toBe(false);
  });
  test("invited member flow keeps Q3 in the administrator's scope", async () => {
    const f = fixture(["--only", "github.repos"]);
    expect(await cmdOnboard(f.args, f.ctx, { bindSignals: false, identity: async () => ({ account: "account-a", membershipId: "person-a", baseUrl: "https://fixture.invalid", role: "member" }),
      adapters: { "github.repos": f.adapter } })).toBe(0);
    const journal = readOnboardJournal(onboardStatePath(f.home))!;
    expect(journal.steps.find(row => row.id === "github.repos")).toMatchObject({ state: "skipped", reason: "member_scope" });
    expect(f.reads).toEqual([]);
    expect(journal.complete).toBe(false);
  });
  test("scoped selection roundtrips IDs but cannot declare onboarding complete", async () => {
    const f = fixture(["--only", "github.repos", "--repo", "example/service"]);
    const done = { check: async () => ({ state: "done" as const }) };
    expect(await cmdOnboard(f.args, f.ctx, { bindSignals: false, identity: async () => ({ account: "account-a", membershipId: "person-a", baseUrl: "https://fixture.invalid", role: "owner" }),
      adapters: { signin: done, "linear.workspace": done, "linear.personal": done, "linear.team": { check: async () => ({ state: "done", evidence: { team: "team-a" } }) }, "github.install": done, "github.repos": f.adapter } })).toBe(0);
    const journal = readOnboardJournal(onboardStatePath(f.home))!;
    expect(selectedOnboardRepositories(journal)).toEqual([{ ...repository, teamId: "team-a" }]);
    expect(journal.complete).toBe(false);
    expect(journal.scope).toBe("step");
  });
  test.each([
    "account-a:example__service",
    "account-a:example__service.api",
    "account-a:" + "a".repeat(39) + "__" + "b".repeat(100),
  ])("a real minted cloud ID survives live selection and journal resume: %s", async repoId => {
    const f = fixture(["--repo", "example/service"]);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [{ ...repository, repoId }] } });
    const result = await f.adapter.check(f.ctx, f.journal);
    expect(result.state).toBe("done");
    f.journal.steps.push({ id: "github.repos", state: "done", evidence: result.evidence });
    expect(selectedOnboardRepositories(f.journal)).toEqual([{ ...repository, repoId, teamId: "team-a" }]);
    const resumed = existingRepositoryAdapter(parseArgs(["onboard", "--yes"]));
    expect((await resumed.check(f.ctx, f.journal)).state).toBe("done");
  });
  test.each(["x".repeat(257), "account-a:repo/escape", "account-a:repo\\escape", "repo\nsecret", "repo%2fescape"])("unsafe cloud ID remains unverified: %s", async repoId => {
    const f = fixture(["--repo", "example/service"]);
    f.setContract({ contractVersion: "1.24.0", account: { id: "account-a" }, merge: { repositories: [{ ...repository, repoId }] } });
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "repository_contract_unverified" });
  });
});
