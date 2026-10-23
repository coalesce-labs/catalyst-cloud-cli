import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  configPathFor,
  loadConfig,
  writeConfig,
  type Ctx,
  type CustomerConfig,
} from "../src/config.js";
import { onboardCapacityAdapter } from "../src/onboard-capacity.js";
import type { OnboardJournal } from "../src/onboard.js";

const route = "/api/v1/me/runner-capacity";
const now = new Date("2026-10-01T06:20:00.000Z");
const homes: string[] = [],
  releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.resolve();
  await Promise.resolve();
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
interface TeamDto {
  teamKey: string;
  configuredLimit: number | null;
  defaultLimit: number;
  effectiveTeamLimit: number;
  source: string;
  paused: boolean;
  admissionEnabled: boolean;
  remainingUnits: number | null;
}
interface Dto {
  status: string;
  scope: string;
  observedAtMs: number;
  buckets: Array<{
    repoId: string;
    effectiveLimit: number;
    occupiedUnits: number;
    teams: TeamDto[];
  }>;
}
function capacity(): Dto {
  return {
    status: "ok",
    scope: "mapped-team-defaults",
    observedAtMs: now.getTime(),
    buckets: [
      {
        repoId: "repo-a",
        effectiveLimit: 3,
        occupiedUnits: 1,
        teams: [
          {
            teamKey: "A",
            configuredLimit: 3,
            defaultLimit: 20,
            effectiveTeamLimit: 3,
            source: "configured",
            paused: false,
            admissionEnabled: true,
            remainingUnits: 2,
          },
        ],
      },
    ],
  };
}
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "onboard-capacity-"));
  homes.push(home);
  const config: CustomerConfig = {
    baseUrl: "https://cloud.example.test",
    account: "account-a",
    slug: "a",
    name: "Private Workspace",
    permissions: ["mirror:read", "mirror:feed"],
    principal: "service",
    key: "ctc_user_fixture_secret",
    user: {
      id: "person-a",
      role: "owner",
      label: "Private Person",
      email: "private@example.test",
      linearUserId: null,
    },
    joinedAt: now.toISOString(),
    lastSkillBundleVersion: "fixture",
  };
  writeConfig(home, config);
  const repo = {
    owner: "example",
    name: "service",
    teamId: "team-a",
    repoId: "repo-a",
  };
  const journal: OnboardJournal = {
    schema: 1,
    runId: "capacity-run",
    cli: "fixture",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: config.baseUrl,
    exit: null,
    steps: [
      { id: "linear.team", state: "done", evidence: { team: "team-a" } },
      {
        id: "github.repos",
        state: "done",
        evidence: { repository: JSON.stringify([repo]) },
      },
    ],
    changes: [],
  };
  const contract = {
    contractVersion: "2.3.0",
    account: { id: "account-a" },
    merge: {
      repositories: [
        { owner: repo.owner, name: repo.name, repoId: repo.repoId },
      ],
    },
    onboarding: {
      schema: 1,
      routes: [{ method: "GET", path: route, personalBearer: true }],
      web: {
        connections: "/a/account/connections",
        personalConnections: "/settings/connected-accounts",
      },
    },
  };
  const state: {
    snapshot: unknown;
    teams: unknown;
    repositories: unknown;
    contract: unknown;
    me: unknown;
    override?: (
      path: string,
      call: number,
      init?: RequestInit,
    ) => Response | Promise<Response> | null;
  } = {
    snapshot: capacity(),
    teams: {
      teams: [{ teamId: "team-a", teamKey: "A", teamName: "Team A" }],
      liveTeamRead: { error: null },
    },
    repositories: {
      repos: [{ teamId: repo.teamId, owner: repo.owner, name: repo.name }],
    },
    contract,
    me: {
      account: config.account,
      principal: config.principal,
      permissions: config.permissions,
      user: config.user,
      name: config.name,
      slug: config.slug,
    },
  };
  const reads: string[] = [],
    messages: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(config.baseUrl);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_user_fixture_secret",
    );
    reads.push(url.pathname);
    const replaced = state.override?.(url.pathname, reads.length, init);
    if (replaced) return replaced;
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json(state.contract);
    if (url.pathname === "/api/v1/me") return Response.json(state.me);
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json(state.teams);
    if (url.pathname === "/api/v1/repos")
      return Response.json(state.repositories);
    if (url.pathname === route) return Response.json(state.snapshot);
    return new Response(null, { status: 404 });
  };
  const ctx: Ctx = {
    home,
    env: {},
    fetch: fetchImpl,
    now: () => now,
    stdout: () => {},
    stderr: () => {},
  };
  const adapter = onboardCapacityAdapter({
    message: (line) => messages.push(line),
  });
  return { home, config, repo, journal, state, reads, messages, ctx, adapter };
}
function stalledJson(value: unknown) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let ended = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        ready();
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const release = () => {
    if (ended) return;
    ended = true;
    controller?.enqueue(new TextEncoder().encode(JSON.stringify(value)));
    controller?.close();
  };
  releases.push(release);
  return { entered, release, response: new Response(body, { status: 200 }) };
}

describe("mapped-team-defaults advisory capacity", () => {
  test("performs the whole fresh sequence, publishes only advisory numbers and writes nothing", async () => {
    const f = fixture(),
      configBefore = readFileSync(configPathFor(f.home), "utf8"),
      journalBefore = JSON.stringify(f.journal);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "done",
      evidence: {
        repoId: "repo-a",
        effectiveLimit: 3,
        occupiedUnits: 1,
        remainingUnits: 2,
        observedAtMs: now.getTime(),
        advisory: true,
      },
    });
    expect(f.reads).toEqual([
      "/api/v1/agent/contract",
      "/api/v1/me",
      "/api/v1/agent/teams",
      "/api/v1/agent/repos",
      "/api/v1/repos",
      "/api/v1/agent/contract",
      route,
      "/api/v1/me",
    ]);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(configBefore);
    expect(JSON.stringify(f.journal)).toBe(journalBefore);
    expect(f.adapter.act).toBeUndefined();
    expect(f.messages).toEqual([
      "Runner capacity observed: 1 of 3 units in use. Starting work will check admission again.",
    ]);
  });
  test("a previously done capacity receipt cannot mask a fresh full bucket", async () => {
    const f = fixture(),
      dto = capacity();
    dto.buckets[0]!.occupiedUnits = 3;
    dto.buckets[0]!.teams[0]!.remainingUnits = 0;
    f.state.snapshot = dto;
    f.journal.steps.push({
      id: "capacity",
      state: "done",
      evidence: { remainingUnits: 999, advisory: true },
    });
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "capacity_currently_full",
    });
    expect(f.reads).toContain(route);
    expect(f.messages).toEqual([]);
  });
  test("a project may keep several registered repositories while checking its mapped default", async () => {
    const f = fixture();
    const second = { owner: "example", name: "other", teamId: "team-a", repoId: "repo-b" };
    const repos = f.journal.steps.find(s => s.id === "github.repos")!;
    const original = JSON.parse(String(repos.evidence!.repository));
    repos.evidence = { repository: JSON.stringify([...original, second]) };
    const contract = f.state.contract as { merge: { repositories: unknown[] } };
    contract.merge.repositories.push(second);
    const inventory = f.state.repositories as { repos: unknown[] };
    inventory.repos.push(second);
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done", evidence: { repoId: "repo-a", advisory: true },
    });
    expect(JSON.parse(String(repos.evidence.repository))).toHaveLength(2);
    expect(f.messages[0]).toContain("Starting work will check admission again");
  });
  test("disabled selected default admission does not borrow another team's enabled admission", async () => {
    const f = fixture(),
      dto = capacity();
    dto.buckets[0]!.teams[0]!.admissionEnabled = false;
    dto.buckets[0]!.teams[0]!.remainingUnits = null;
    dto.buckets.push({
      repoId: "repo-b",
      effectiveLimit: 3,
      occupiedUnits: 1,
      teams: [
        {
          ...dto.buckets[0]!.teams[0]!,
          teamKey: "B",
          admissionEnabled: true,
          remainingUnits: 2,
        },
      ],
    });
    f.state.snapshot = dto;
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "capacity_admission_unverified",
    });
  });
  test("selected-repository override cannot borrow another default-mapped team's bucket", async () => {
    const f = fixture(),
      dto = capacity();
    dto.buckets[0]!.teams[0]!.teamKey = "B";
    f.state.snapshot = dto;
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "capacity_context_unverified",
    });
  });
  test("configured and default team limits share the actual minimum bucket cap", async () => {
    const f = fixture(),
      dto = capacity();
    dto.buckets[0]!.teams.push({
      teamKey: "B",
      configuredLimit: null,
      defaultLimit: 20,
      effectiveTeamLimit: 20,
      source: "default",
      paused: false,
      admissionEnabled: true,
      remainingUnits: 2,
    });
    f.state.snapshot = dto;
    expect(
      (await f.adapter.check(f.ctx, f.journal)).evidence?.effectiveLimit,
    ).toBe(3);
  });
  test("paused mapping yields a zero shared cap and never a positive admission", async () => {
    const f = fixture(),
      dto = capacity();
    dto.buckets[0]!.effectiveLimit = 0;
    dto.buckets[0]!.teams[0]!.remainingUnits = 0;
    dto.buckets[0]!.teams.push({
      teamKey: "B",
      configuredLimit: null,
      defaultLimit: 20,
      effectiveTeamLimit: 0,
      source: "default",
      paused: true,
      admissionEnabled: true,
      remainingUnits: 0,
    });
    f.state.snapshot = dto;
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "capacity_currently_full",
    });
  });
  const malformed: Array<{ label: string; change(dto: Dto): void }> = [
    {
      label: "old bucket-wide scope",
      change: (dto) => {
        dto.scope = "repository-admission";
      },
    },
    {
      label: "stale observation",
      change: (dto) => {
        dto.observedAtMs -= 30_001;
      },
    },
    {
      label: "future observation",
      change: (dto) => {
        dto.observedAtMs += 5_001;
      },
    },
    {
      label: "negative occupancy",
      change: (dto) => {
        dto.buckets[0]!.occupiedUnits = -1;
      },
    },
    {
      label: "unsafe limit",
      change: (dto) => {
        dto.buckets[0]!.effectiveLimit = Number.MAX_SAFE_INTEGER + 1;
      },
    },
    {
      label: "wrong bucket minimum",
      change: (dto) => {
        dto.buckets[0]!.effectiveLimit = 4;
        dto.buckets[0]!.teams[0]!.remainingUnits = 3;
      },
    },
    {
      label: "wrong remaining",
      change: (dto) => {
        dto.buckets[0]!.teams[0]!.remainingUnits = 3;
      },
    },
    {
      label: "wrong source",
      change: (dto) => {
        dto.buckets[0]!.teams[0]!.source = "default";
      },
    },
    {
      label: "wrong effective team limit",
      change: (dto) => {
        dto.buckets[0]!.teams[0]!.effectiveTeamLimit = 4;
      },
    },
    {
      label: "duplicate bucket",
      change: (dto) => {
        dto.buckets.push(structuredClone(dto.buckets[0]!));
      },
    },
    {
      label: "duplicate team key",
      change: (dto) => {
        dto.buckets[0]!.teams.push(structuredClone(dto.buckets[0]!.teams[0]!));
      },
    },
    {
      label: "control character team key",
      change: (dto) => {
        dto.buckets[0]!.teams[0]!.teamKey = "A\n";
      },
    },
  ];
  test.each(malformed)(
    "refuses $label without a positive message",
    async ({ change }) => {
      const f = fixture(),
        dto = capacity();
      change(dto);
      f.state.snapshot = dto;
      expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "capacity_context_unverified",
      });
      expect(f.messages).toEqual([]);
    },
  );
  test("missing capability prevents identity, inventory and capacity probes", async () => {
    const f = fixture();
    f.state.contract = {
      contractVersion: "2.3.0",
      account: { id: "account-a" },
      onboarding: {
        schema: 1,
        routes: [],
        web: {
          connections: "/a/account/connections",
          personalConnections: "/settings/connected-accounts",
        },
      },
    };
    expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
      "cloud_capability_unavailable",
    );
    expect(f.reads).toEqual(["/api/v1/agent/contract"]);
  });
  test("pre-aborted check performs no request", async () => {
    const f = fixture(),
      stop = new AbortController();
    stop.abort();
    expect(await f.adapter.check(f.ctx, f.journal, stop.signal)).toEqual({
      state: "waiting",
      reason: "interrupted",
    });
    expect(f.reads).toEqual([]);
  });
  test("live demotion on the final person read refuses the numeric aggregate", async () => {
    const f = fixture();
    let meReads = 0;
    f.state.override = (path) =>
      path === "/api/v1/me" && ++meReads === 2
        ? Response.json({
            account: "account-a",
            principal: "service",
            user: { id: "person-a", role: "member" },
          })
        : null;
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "capacity_identity_unverified",
    });
    expect(meReads).toBe(2);
    expect(f.messages).toEqual([]);
  });
  test("saved person or credential change during the capacity read refuses publication", async () => {
    const f = fixture();
    f.state.override = (path) => {
      if (path !== route) return null;
      const cfg = loadConfig(f.home);
      if (!cfg) throw new Error("missing actual test config");
      writeConfig(f.home, { ...cfg, key: "ctc_user_replaced" });
      return Response.json(capacity());
    };
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.messages).toEqual([]);
  });
  test("a changed chosen repository during capacity observation refuses publication", async () => {
    const f = fixture();
    f.state.override = (path) => {
      if (path !== route) return null;
      const step = f.journal.steps.find((row) => row.id === "github.repos");
      if (!step?.evidence) throw new Error("missing selection receipt");
      step.evidence.repository = JSON.stringify([
        { ...f.repo, repoId: "repo-replaced" },
      ]);
      return Response.json(capacity());
    };
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.messages).toEqual([]);
  });
  test.each(["duplicate", "sanitized"] as const)(
    "ambiguous $0 inventory key cannot supply a default-team join",
    async (kind) => {
      const f = fixture();
      f.state.teams = {
        teams:
          kind === "duplicate"
            ? [
                { teamId: "team-a", teamKey: "A", teamName: "A" },
                { teamId: "team-b", teamKey: "A", teamName: "B" },
              ]
            : [{ teamId: "team-a", teamKey: "A\n", teamName: "A" }],
      };
      expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "capacity_context_unverified",
      });
      expect(f.messages).toEqual([]);
    },
  );
  test("actual stalled capacity JSON cancellation ignores its late valid body and preserves config/journal", async () => {
    const f = fixture(),
      held = stalledJson(capacity()),
      stop = new AbortController();
    const beforeConfig = readFileSync(configPathFor(f.home), "utf8"),
      beforeJournal = JSON.stringify(f.journal);
    f.state.override = (path) => (path === route ? held.response : null);
    const check = f.adapter.check(f.ctx, f.journal, stop.signal);
    await held.entered;
    stop.abort();
    expect(await check).toEqual({ state: "waiting", reason: "interrupted" });
    held.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(beforeConfig);
    expect(JSON.stringify(f.journal)).toBe(beforeJournal);
    expect(f.messages).toEqual([]);
  });
  test("owned capability deadline reports unavailable rather than inventing a user interruption", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      held = stalledJson({});
    f.state.override = (path) =>
      path === "/api/v1/agent/contract" ? held.response : null;
    const check = f.adapter.check(f.ctx, f.journal);
    await held.entered;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await check).toEqual({
      state: "waiting",
      reason: "capacity_unavailable",
    });
    expect(f.reads).toEqual(["/api/v1/agent/contract"]);
    expect(f.messages).toEqual([]);
  });
  test("raw DTO extras and display identities never appear in advisory evidence", async () => {
    const f = fixture();
    f.state.snapshot = {
      ...capacity(),
      credential: "raw-secret",
      holder: "raw-holder",
      ticket: "raw-ticket",
    };
    const result = await f.adapter.check(f.ctx, f.journal),
      emitted = JSON.stringify([result, f.messages]);
    expect(result.state).toBe("done");
    for (const value of [
      "raw-secret",
      "raw-holder",
      "raw-ticket",
      "Private Person",
      "private@example.test",
      "ctc_user_fixture_secret",
    ])
      expect(emitted).not.toContain(value);
  });
});
