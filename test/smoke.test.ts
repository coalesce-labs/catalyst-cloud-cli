// smoke.test.ts — CTC-11083: `catalyst smoke readme`. The cloud is a scripted SmokeApi and time is a
// fake clock the injected sleep advances, so every end state is reached deterministically: a verified
// merge (exit 0), a hold, a block, a missed deadline, each merged-but-unverified reason, the preflight
// refusals, a resumed trial and a resent create.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import type { TenantContract } from "../src/contract-types";
import type { TicketExecution } from "../src/execution";
import {
  SMOKE_EXIT,
  SMOKE_TITLE,
  smokeReceiptPath,
  type IssueRead,
  type MarkerAnswer,
  type PullRead,
  type SmokeApi,
} from "../src/smoke";
import { FIXTURE_ACCOUNT, FIXTURE_ROUTE_PREFIX, buildFixtureContract } from "./fixture-contract";
import { joinedConfig, makeCtx, tempHome, type TestCtx } from "./helpers";
import { configPathFor } from "../src/config";

const REPO = "acme/app";
const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LANDED = "1111111111111111111111111111111111111111";
const AFTER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function contract(opts: { repos?: { default: string | null; registered: string[] } | null; markerRoute?: boolean } = {}): TenantContract {
  const doc = buildFixtureContract();
  if (opts.markerRoute !== false) {
    doc.routes.push({ method: "GET", path: `${FIXTURE_ROUTE_PREFIX}/repo-readme-marker`, takesWriteBudgetUnit: false, since: "2.79.0" });
  }
  const team = doc.teams.find((t) => t.key === "ENG")!;
  if (opts.repos !== null) team.repositories = opts.repos ?? { default: REPO, registered: [REPO] };
  return doc;
}

const marker = (state: MarkerAnswer["state"], over: Partial<MarkerAnswer> = {}): MarkerAnswer => ({
  repository: REPO,
  state,
  defaultBranch: "main",
  commitSha: state === "unavailable" ? null : BASE,
  ...over,
});

interface Poll {
  issue?: IssueRead | null;
  exec?: TicketExecution | null;
  pull?: PullRead | null;
}

/** A scripted cloud: each poll of the watch consumes the next entry; the last one repeats. */
class FakeCloud implements SmokeApi {
  calls: string[] = [];
  creates: Record<string, unknown>[] = [];
  markers: { repo: string; mergeSha?: string }[] = [];
  polls: Poll[] = [];
  private pollIndex = 0;
  private current: Poll = {};
  constructor(
    public doc: TenantContract,
    public preflight: MarkerAnswer | null = marker("absent"),
    public afterMerge: (mergeSha: string) => MarkerAnswer | null = (sha) =>
      marker("present", { commitSha: AFTER, mergeSha: sha, mergeShaOnDefaultBranch: true }),
    public priorIssue: IssueRead | null = null,
  ) {}
  async contract() {
    this.calls.push("contract");
    return this.doc;
  }
  async marker(repo: string, mergeSha?: string) {
    this.calls.push(mergeSha ? `marker:${mergeSha}` : "marker");
    this.markers.push({ repo, ...(mergeSha ? { mergeSha } : {}) });
    return mergeSha ? this.afterMerge(mergeSha) : this.preflight;
  }
  async create(body: Record<string, unknown>) {
    this.calls.push("create");
    this.creates.push(body);
    return { identifier: "ENG-501", id: "lin-501", url: "https://linear.app/hagale/issue/ENG-501" };
  }
  async issue(ticket: string) {
    this.calls.push(`issue:${ticket}`);
    // The resume check reads the prior trial before any poll.
    if (this.pollIndex === 0 && this.priorIssue && !this.calls.includes("poll-started")) {
      this.calls.push("poll-started");
      return this.priorIssue;
    }
    this.current = this.polls[Math.min(this.pollIndex, this.polls.length - 1)] ?? {};
    this.pollIndex += 1;
    return this.current.issue === undefined ? { identifier: ticket, state: "Todo" } : this.current.issue;
  }
  async execution() {
    return this.current.exec ?? null;
  }
  async pull() {
    return this.current.pull ?? null;
  }
}

const linked = (over: Record<string, unknown> = {}) => ({
  repo_id: REPO,
  number: 7,
  node_id: "PR_7",
  state: "open",
  draft: 0,
  merged: 0,
  ...over,
});
const issueWith = (pull: Record<string, unknown> | null, over: Partial<IssueRead> = {}): IssueRead => ({
  identifier: "ENG-501",
  state: "In Review",
  linked_pulls: pull ? [linked(pull)] : [],
  ...over,
});
const phases = (status = "running"): TicketExecution => ({ phases: [{ phase: "implement", status }], governors: [] });

function setup(cloud: FakeCloud): { ctx: TestCtx; home: string; run: (...extra: string[]) => Promise<number>; clock: { ms: number } } {
  const home = tempHome();
  const clock = { ms: Date.parse("2026-11-19T15:00:00Z") };
  mkdirSync(dirname(configPathFor(home)), { recursive: true });
  writeFileSync(configPathFor(home), JSON.stringify(joinedConfig({ url: "http://fixture.invalid" } as never)), { mode: 0o600 });
  const ctx = makeCtx(home, { now: () => new Date(clock.ms) });
  const run = (...extra: string[]) =>
    main(["smoke", "readme", "--team", "ENG", "--repo", REPO, "--json", ...extra], ctx, {
      smoke: { api: cloud, sleep: async (ms) => void (clock.ms += ms) },
    });
  return { ctx, home, run, clock };
}

const result = (ctx: TestCtx) => JSON.parse(ctx.out.at(-1)!) as Record<string, unknown> & { pullRequest?: Record<string, unknown>; marker?: MarkerAnswer };
const receiptFile = (home: string) => smokeReceiptPath(home, FIXTURE_ACCOUNT, "ENG", REPO);

describe("catalyst smoke readme: the verified merge", () => {
  test("a trial that merges with its landed commit on the default branch and the marker present exits 0", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [
      { issue: issueWith(null, { state: "Todo" }) },
      { issue: issueWith(null, { state: "In Progress" }), exec: phases() },
      { issue: issueWith({ draft: 1 }), exec: phases() },
      { issue: issueWith({}), exec: phases("succeeded") },
      { issue: issueWith({ state: "closed", merged: 1 }), exec: phases("succeeded"), pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } },
    ];
    // the pull read follows the linked row on each poll
    for (const p of cloud.polls) if (p.issue?.linked_pulls?.length && p.pull === undefined) p.pull = { ...p.issue.linked_pulls[0], base_ref: "main", merged_commit_sha: null } as PullRead;
    const { ctx, home, run } = setup(cloud);

    const code = await run();

    expect(code).toBe(0);
    const out = result(ctx);
    expect(out).toMatchObject({ status: "merged", reason: "marker_on_default_branch", ticket: "ENG-501", repository: REPO });
    expect(out.pullRequest).toMatchObject({ number: 7, mergedCommitSha: LANDED });
    expect(out.marker).toMatchObject({ state: "present", commitSha: AFTER, mergeShaOnDefaultBranch: true });
    // preflight before the create, then the landed commit (never the branch head) for the merge
    expect(cloud.calls.indexOf("marker")).toBeLessThan(cloud.calls.indexOf("create"));
    expect(cloud.markers.at(-1)).toEqual({ repo: REPO, mergeSha: LANDED });
    expect(cloud.creates[0]).toMatchObject({ teamId: "team-eng", title: SMOKE_TITLE, stateId: "state-todo" });
    expect(cloud.creates[0]).not.toHaveProperty("labelNames");
    expect(String(cloud.creates[0]!.description)).toContain("Catalyst Cloud enabled");
    const receipt = JSON.parse(readFileSync(receiptFile(home), "utf8"));
    expect(receipt).toMatchObject({ ticket: "ENG-501", baseCommit: BASE, idempotencyId: cloud.creates[0]!.idempotencyId });
    // progress went to stderr, the one result line to stdout
    expect(ctx.out).toHaveLength(1);
    expect(ctx.err.some((l) => l.includes("Created ENG-501"))).toBe(true);
  });

  test("a merged trial whose landed commit arrives late is graded once the commit appears", async () => {
    const cloud = new FakeCloud(contract());
    const merged = issueWith({ state: "closed", merged: 1 });
    cloud.polls = [
      { issue: merged, pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: null } },
      { issue: merged, pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } },
    ];
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(0);
    expect(result(ctx).status).toBe("merged");
  });
});

describe("catalyst smoke readme: a merge that cannot be verified is never exit 0", () => {
  const mergedPoll = (pull: PullRead): Poll[] => [{ issue: issueWith({ state: "closed", merged: 1 }), pull }];

  test("an older cloud whose pull read has no merged_commit_sha field", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "main" });
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(SMOKE_EXIT.merged_unverified);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "cloud_omits_merged_commit" });
  });

  test("a landed commit that is not on the default branch", async () => {
    const cloud = new FakeCloud(contract(), marker("absent"), (sha) => marker("present", { mergeSha: sha, mergeShaOnDefaultBranch: false }));
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED });
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(7);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "merged_commit_not_on_default_branch" });
  });

  test("a merge into a branch other than the default", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "release", merged_commit_sha: LANDED });
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(7);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "merged_into_other_branch" });
  });

  test("a merge whose README does not carry the marker", async () => {
    const cloud = new FakeCloud(contract(), marker("absent"), (sha) => marker("absent", { mergeSha: sha, mergeShaOnDefaultBranch: true }));
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED });
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(7);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "merged_without_marker" });
  });

  test("ancestry that stays unknown until the merge deadline names that reason and keeps the receipt", async () => {
    const cloud = new FakeCloud(contract(), marker("absent"), (sha) => marker("present", { mergeSha: sha, mergeShaOnDefaultBranch: null }));
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED });
    const { ctx, home, run, clock } = setup(cloud);
    const start = clock.ms;
    expect(await run("--deadline", "merge=5")).toBe(7);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "ancestry_unknown" });
    expect(clock.ms - start).toBeGreaterThanOrEqual(5 * 60_000);
    expect(JSON.parse(readFileSync(receiptFile(home), "utf8")).ticket).toBe("ENG-501");
  });

  test("an unavailable marker after the merge is its own reason", async () => {
    const cloud = new FakeCloud(contract(), marker("absent"), () => marker("unavailable", { reason: "provider_unavailable", defaultBranch: null }));
    cloud.polls = mergedPoll({ number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED });
    const { ctx, run } = setup(cloud);
    expect(await run("--deadline", "merge=1")).toBe(7);
    expect(result(ctx)).toMatchObject({ status: "merged_unverified", reason: "marker_unavailable:provider_unavailable" });
  });
});

describe("catalyst smoke readme: a hold, a block and a missed deadline each have their own status", () => {
  test("a ready pull request on a ticket with a hold label waits on the owner (exit 4)", async () => {
    const cloud = new FakeCloud(contract());
    const issue = issueWith({}, { labels: [{ name: "hold:needs-remediation" }] });
    cloud.polls = [{ issue, pull: { number: 7, state: "open", draft: 0, merged: 0, base_ref: "main", merged_commit_sha: null } }];
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(SMOKE_EXIT.waiting_on_owner);
    expect(result(ctx)).toMatchObject({ status: "waiting_on_owner", reason: "hold_label:hold:needs-remediation" });
    expect(String(result(ctx).next)).toContain("never merges");
  });

  test("a ready pull request nobody merges by the merge deadline waits on the owner, not a missed deadline", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [{ issue: issueWith({}), pull: { number: 7, state: "open", draft: 0, merged: 0, base_ref: "main", merged_commit_sha: null } }];
    const { ctx, run } = setup(cloud);
    expect(await run("--deadline", "merge=2")).toBe(4);
    expect(result(ctx)).toMatchObject({ status: "waiting_on_owner", reason: "ready_not_merged" });
  });

  test("a governor that needs someone blocks (exit 5) and names its release", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [
      { exec: phases() },
      { exec: { phases: [{ phase: "verify", status: "held" }], governors: [{ kind: "validate_hold", phase: "verify", release: "Answer ask ENG-9, then release the ticket." }] } },
    ];
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(SMOKE_EXIT.blocked);
    expect(result(ctx)).toMatchObject({ status: "blocked", reason: "validate_hold", next: "Answer ask ENG-9, then release the ticket." });
  });

  test("a park the cloud releases by itself and a live lease are waits, not blocks", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [
      { exec: { phases: [{ phase: "implement", status: "running" }], governors: [{ kind: "live_lease", phase: "implement" }, { kind: "phase_park", sentinel: "parked:rate_limited" }], park: { sentinel: "parked:rate_limited", selfReleases: true, releasedBy: "the cloud" } } },
    ];
    const { ctx, run } = setup(cloud);
    expect(await run("--deadline", "phase=3")).toBe(SMOKE_EXIT.deadline_missed);
    expect(result(ctx)).toMatchObject({ status: "deadline_missed", reason: "phase_deadline" });
  });

  test("a ticket that never starts misses the launch deadline (exit 6)", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [{}];
    const { ctx, run, clock } = setup(cloud);
    const start = clock.ms;
    expect(await run("--deadline", "launch=10", "--interval", "60")).toBe(6);
    expect(result(ctx)).toMatchObject({ status: "deadline_missed", reason: "launch_deadline", stage: "launch" });
    expect(clock.ms - start).toBe(10 * 60_000);
  });

  test("a pull request closed without merging blocks", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [{ issue: issueWith({ state: "closed" }), pull: { number: 7, state: "closed", draft: 0, merged: 0, base_ref: "main", merged_commit_sha: null } }];
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(5);
    expect(result(ctx)).toMatchObject({ status: "blocked", reason: "pull_request_closed" });
  });
});

describe("catalyst smoke readme: preflight refuses before creating anything (exit 3)", () => {
  const refusedBy = async (cloud: FakeCloud, reason: string) => {
    const { ctx, home, run } = setup(cloud);
    expect(await run()).toBe(SMOKE_EXIT.refused);
    expect(result(ctx)).toMatchObject({ status: "refused", reason });
    expect(cloud.creates).toEqual([]);
    expect(existsSync(receiptFile(home))).toBe(false);
  };

  test("the README already carries the marker", async () => {
    await refusedBy(new FakeCloud(contract(), marker("present")), "already_present");
  });
  test("the repository has no README", async () => {
    await refusedBy(new FakeCloud(contract(), marker("readme_missing")), "readme_missing");
  });
  test("the README cannot be read", async () => {
    await refusedBy(new FakeCloud(contract(), marker("unavailable", { reason: "contents_403", defaultBranch: "main" })), "marker_unavailable:contents_403");
  });
  test("the cloud does not know the repository", async () => {
    await refusedBy(new FakeCloud(contract(), null), "repository_not_registered");
  });
  test("the repository is not registered to the team: no marker read either", async () => {
    const cloud = new FakeCloud(contract({ repos: { default: "acme/other", registered: ["acme/other"] } }));
    await refusedBy(cloud, "repository_not_registered");
    expect(cloud.markers).toEqual([]);
  });
  test("a team the contract does not map", async () => {
    const cloud = new FakeCloud(contract());
    cloud.doc.teams = cloud.doc.teams.filter((t) => t.key !== "ENG");
    await refusedBy(cloud, "team_unknown");
  });
  test("a closed dispatch gate", async () => {
    const cloud = new FakeCloud(contract());
    cloud.doc.teams.find((t) => t.key === "ENG")!.dispatchGate = { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map the team's stages." } as never;
    await refusedBy(cloud, "dispatch_gate:mapping_missing");
  });
  test("a cloud without the marker route is an error, not a refusal", async () => {
    const cloud = new FakeCloud(contract({ markerRoute: false }));
    const { ctx, run } = setup(cloud);
    expect(await run()).toBe(2);
    expect(ctx.err.join("\n")).toContain("does not serve the README marker read");
    expect(cloud.creates).toEqual([]);
  });
});

describe("catalyst smoke readme: one trial per team and repository", () => {
  test("a team with several repositories binds the trial to the one asked for", async () => {
    const cloud = new FakeCloud(contract({ repos: { default: "acme/web", registered: ["acme/web", REPO] } }));
    cloud.polls = [{ issue: issueWith({ state: "closed", merged: 1 }), pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } }];
    const { run } = setup(cloud);
    expect(await run()).toBe(0);
    expect(cloud.creates[0]).toMatchObject({ labelNames: [`repo:${REPO}`] });
  });

  test("a rerun resumes the open trial before reading the README, and creates nothing", async () => {
    const cloud = new FakeCloud(contract(), marker("present"));
    cloud.priorIssue = { identifier: "ENG-501", state: "In Review" };
    cloud.polls = [{ issue: issueWith({ state: "closed", merged: 1 }), pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } }];
    const { ctx, home, run } = setup(cloud);
    mkdirSync(dirname(receiptFile(home)), { recursive: true });
    writeFileSync(receiptFile(home), JSON.stringify({ version: 1, team: "ENG", repo: REPO, idempotencyId: "smoke-readme:first", createdAt: "2026-11-19T14:00:00Z", ticket: "ENG-501" }));

    expect(await run()).toBe(0);
    expect(cloud.creates).toEqual([]);
    expect(cloud.calls).not.toContain("marker");
    expect(result(ctx)).toMatchObject({ status: "merged", resumed: true });
  });

  test("a create that landed but lost its answer is resent with the same key", async () => {
    const cloud = new FakeCloud(contract());
    cloud.polls = [{ issue: issueWith({ state: "closed", merged: 1 }), pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } }];
    const { home, run } = setup(cloud);
    mkdirSync(dirname(receiptFile(home)), { recursive: true });
    writeFileSync(receiptFile(home), JSON.stringify({ version: 1, team: "ENG", repo: REPO, idempotencyId: "smoke-readme:first", createdAt: "2026-11-19T14:00:00Z" }));

    expect(await run()).toBe(0);
    expect(cloud.creates).toHaveLength(1);
    expect(cloud.creates[0]!.idempotencyId).toBe("smoke-readme:first");
  });

  test("a canceled earlier trial is archived and a new one starts after a fresh README read", async () => {
    const cloud = new FakeCloud(contract());
    cloud.priorIssue = { identifier: "ENG-400", state: "Canceled", canceled_at: "2026-11-19T14:30:00Z" };
    cloud.polls = [{ issue: issueWith({ state: "closed", merged: 1 }), pull: { number: 7, state: "closed", merged: 1, base_ref: "main", merged_commit_sha: LANDED } }];
    const { home, run } = setup(cloud);
    mkdirSync(dirname(receiptFile(home)), { recursive: true });
    writeFileSync(receiptFile(home), JSON.stringify({ version: 1, team: "ENG", repo: REPO, idempotencyId: "smoke-readme:old", createdAt: "2026-11-19T14:00:00Z", ticket: "ENG-400" }));

    expect(await run()).toBe(0);
    expect(cloud.calls).toContain("marker");
    expect(cloud.creates[0]!.idempotencyId).not.toBe("smoke-readme:old");
    expect(readdirSync(dirname(receiptFile(home))).some((f) => f.includes(".closed-"))).toBe(true);
  });
});

describe("catalyst smoke readme: arguments", () => {
  test.each([
    [["smoke"], "smoke needs a check"],
    [["smoke", "readme", "--repo", REPO], "needs --team"],
    [["smoke", "readme", "--team", "ENG", "--repo", "acme/.."], "needs --repo"],
    [["smoke", "readme", "--team", "ENG", "--repo", REPO, "--deadline", "merge=0"], "--deadline takes"],
    [["smoke", "readme", "--team", "ENG", "--repo", REPO, "--interval", "1"], "--interval takes"],
  ])("%j is a usage error", async (argv, message) => {
    const ctx = makeCtx(tempHome());
    expect(await main(argv, ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain(message);
  });
});
