import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { buildFixtureContract } from "./fixture-contract.js";
import { parseArgs } from "../src/args.js";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import {
  cmdOnboard,
  onboardStatePath,
  type OnboardJournal,
} from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";

const homes: string[] = [];
const now = Date.parse("2026-09-30T14:00:00Z");
const team = {
  teamId: "team-engineering",
  teamKey: "ENG",
  teamName: "Engineering",
  mode: "mapped-existing",
  gitAutomation: null,
  mappedSlots: 0,
  mappedLoadBearingSlots: 0,
  mirrored: true,
  checkedAt: now,
  status: "ready",
  checks: [
    { id: "oauth_scope", state: "pass" },
    { id: "token_live", state: "pass" },
  ],
};
const readiness = () => ({
  teamId: team.teamId,
  teamKey: team.teamKey,
  teamName: team.teamName,
  checkedAt: now,
  workflowRev: 4,
  status: "blocked",
  checks: [
    { id: "oauth_scope", state: "pass" },
    { id: "token_live", state: "pass" },
    { id: "team_visible", state: "pass" },
    { id: "stage_mapping", state: "fail", reason: "missing_mapping" },
  ],
});
const origin = "https://fixture.invalid";
function supportedOnboarding() {
  return {
    schema: 1,
    routes: [
      "/api/v1/agent/contract",
      "/api/v1/agent/teams",
      "/api/v1/agent/tenant/readiness",
      "/api/v1/me/connections/linear/workspace",
      "/api/v1/me/connections/linear/workspace/start",
      "/api/v1/me/connections/linear/personal",
      "/api/v1/me/connections/github/personal",
    ].map((path) => ({ method: "GET", path, personalBearer: true })),
    web: {
      connections: "/a/account/connections",
      personalConnections: "/settings/connected-accounts",
    },
  };
}
function workspaceObservation() {
  return {
    connected: true,
    workspace: {
      bound: true,
      workspaceId: "workspace-fixture",
      workspaceSlug: "fixture",
      workspaceName: "Fixture",
    },
    credential: {
      stored: true,
      updatedAt: now - 1000,
      expiresAt: now + 60_000,
      warmth: "warm",
    },
    verification: { source: "live-probe", state: "connected", checkedAt: now },
  };
}
function fixture(
  argv: string[] = [],
  role: "owner" | "member" = "owner",
  interactive = false,
) {
  const home = mkdtempSync(join(tmpdir(), "existing-team-"));
  homes.push(home);
  const user = {
    id: "fixture-person",
    label: "Fixture",
    email: "fixture@example.com",
    role,
    linearUserId: null,
  };
  const me = {
    account: "fixture-account",
    slug: "fixture",
    name: "Fixture",
    permissions: null,
    principal: "session" as const,
    user,
  };
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    now: () => new Date(now),
    stdout: (_text: string) => {},
    stderr: (_text: string) => {},
  };
  writeConfig(home, {
    ...me,
    baseUrl: "https://fixture.invalid",
    key: "ctc_user_fixture",
    joinedAt: new Date(now).toISOString(),
    lastSkillBundleVersion: "0.14.1",
  });
  let inventory: unknown[] = [team];
  let observation: unknown = readiness();
  let workspace: unknown = workspaceObservation();
  let contract: unknown = {
    account: { id: me.account },
    contractVersion: "2.16.0",
    onboarding: supportedOnboarding(),
  };
  let liveTeamRead: unknown = { attempted: false, error: null };
  const reads: string[] = [];
  ctx.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    reads.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (init?.method && init.method !== "GET")
      return Response.json({ error: "write_not_authorized" }, { status: 403 });
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json(contract);
    if (url.pathname === "/api/v1/me") return Response.json(me);
    if (url.pathname === "/api/v1/me/connections/linear/workspace")
      return Response.json(workspace);
    if (
      url.pathname === "/api/v1/me/connections/linear/personal" ||
      url.pathname === "/api/v1/me/connections/github/personal"
    )
      return Response.json({ connected: true });
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json({
        teams: inventory,
        canManage: role === "owner",
        liveTeamRead,
        everChecked: true,
        mirrorRead: true,
      });
    if (url.pathname === "/api/v1/agent/tenant/readiness")
      return Response.json({ readiness: observation });
    return Response.json({ error: "unexpected_route" }, { status: 404 });
  }) as typeof fetch;
  const args = parseArgs([
    "onboard",
    ...(interactive ? [] : ["--yes", "--json"]),
    ...argv,
  ]);
  const hooks = {
    login: async () => 0,
    ready: async () => ({ state: "waiting" as const, reason: "not_ready" }),
  };
  const runtime = createOnboardRuntime(args, ctx, hooks);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "existing-team",
    installer: null,
    cli: "0.14.1",
    tenant: me.account,
    account: me.account,
    membershipId: user.id,
    baseUrl: "https://fixture.invalid",
    exit: null,
    steps: [],
    changes: [],
  };
  return {
    home,
    ctx,
    args,
    hooks,
    runtime,
    journal,
    reads,
    setInventory: (value: unknown[]) => {
      inventory = value;
    },
    setLiveTeamRead: (value: unknown) => {
      liveTeamRead = value;
    },
    setReadiness: (value: unknown) => {
      observation = value;
    },
    setWorkspace: (value: unknown) => {
      workspace = value;
    },
    setContract: (value: unknown) => {
      contract = value;
    },
  };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("native existing Linear workspace and explicit team selection", () => {
  test("fresh native workspace status proves connection despite unrelated mapping failure, without choosing a team", async () => {
    const f = fixture();
    expect(
      await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "done" });
    expect(
      f.journal.steps.find((step) => step.id === "linear.team"),
    ).toBeUndefined();
    expect(f.reads).toEqual([
      "GET /api/v1/agent/contract",
      "GET /api/v1/me/connections/linear/workspace",
    ]);
  });
  test("warm team readiness cannot replace unknown native workspace evidence", async () => {
    const f = fixture();
    f.setWorkspace({
      ...workspaceObservation(),
      connected: false,
      verification: { source: "none", state: "not-run", checkedAt: null },
    });
    expect(
      await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
    ).toMatchObject({
      state: "waiting",
      reason: "workspace_status_unavailable",
    });
    expect(
      f.reads.some(
        (read) =>
          read.includes("/api/v1/agent/teams") ||
          read.includes("/api/v1/agent/tenant/readiness"),
      ),
    ).toBe(false);
  });
  test("readiness for another team never substitutes for unavailable native workspace status", async () => {
    const f = fixture();
    f.setReadiness({ ...readiness(), teamId: "foreign-team" });
    f.setWorkspace({
      ...workspaceObservation(),
      connected: false,
      verification: {
        source: "live-probe",
        state: "unreachable",
        checkedAt: now,
      },
    });
    expect(
      await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
    ).toMatchObject({
      state: "waiting",
      reason: "workspace_status_unavailable",
    });
    expect(f.reads).toEqual([
      "GET /api/v1/agent/contract",
      "GET /api/v1/me/connections/linear/workspace",
    ]);
  });
  test("an old cloud cannot borrow team readiness to bypass missing workspace capability", async () => {
    const f = fixture();
    f.setContract({
      account: { id: "fixture-account" },
      contractVersion: "2.16.0",
    });
    expect(
      await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
    ).toEqual({
      state: "waiting",
      reason: "cloud_capability_unavailable",
      evidence: { path: `${origin}/a/account/connections` },
    });
    expect(f.reads).toEqual(["GET /api/v1/agent/contract"]);
  });
  test.each(["unbound", "account", "person", "origin"] as const)(
    "invalid team receipt makes zero capability or team requests (%s)",
    async (mismatch) => {
      const f = fixture(["--team", team.teamId]);
      const journal = { ...f.journal };
      if (mismatch === "unbound") {
        delete journal.account;
        journal.tenant = null;
        delete journal.membershipId;
        delete journal.baseUrl;
      }
      if (mismatch === "account") journal.account = "foreign-account";
      if (mismatch === "person") journal.membershipId = "another-person";
      if (mismatch === "origin") journal.baseUrl = "https://foreign.invalid";
      expect(
        await f.runtime.adapters!["linear.team"]!.check(f.ctx, journal),
      ).toMatchObject({
        state: "waiting",
        reason: "onboarding_capability_identity_unverified",
      });
      expect(f.reads).toEqual([]);
    },
  );
  test("yes and JSON never choose even the sole registered team", async () => {
    const f = fixture();
    expect(
      await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting" });
    // CTC-5932: the wait names the team, so the advice can name the exact flag.
    expect(
      await f.runtime.adapters!["linear.team"]!.act!(f.ctx, f.journal),
    ).toEqual({ state: "waiting", reason: "team_choice_required", evidence: { choices: "ENG" } });
  });
  test("explicit unique key selects real ID with safe evidence and no fabricated counts", async () => {
    const f = fixture(["--team", "ENG"]);
    const result = await f.runtime.adapters!["linear.team"]!.check(
      f.ctx,
      f.journal,
    );
    expect(result).toMatchObject({
      state: "done",
      evidence: {
        team: team.teamId,
        teamKey: "ENG",
        checkedAt: now,
        revision: 4,
      },
    });
    expect(result.evidence).not.toHaveProperty("count");
    expect(result.evidence).not.toHaveProperty("openIssues");
  });
  test("ambiguous or malformed inventory never selects an arbitrary match", async () => {
    const f = fixture(["--team", "ENG"]);
    f.setInventory([team, { ...team, teamId: "team-other" }]);
    expect(
      await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting" });
    f.setInventory([team, { ...team, teamId: "" }]);
    expect(
      await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting" });
  });
  test("removed resumed selection is revalidated rather than accepted from receipt", async () => {
    const f = fixture();
    f.journal.steps.push({
      id: "linear.team",
      state: "done",
      at: new Date(now).toISOString(),
      evidence: { team: team.teamId, checkedAt: now, revision: 4 },
    });
    f.setInventory([]);
    expect(
      await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting" });
  });
  test("member explicit existing-team journey persists verified selection using reads only", async () => {
    const f = fixture(
      ["--only", "linear.team", "--team", team.teamId],
      "member",
    );
    expect(
      await cmdOnboard(f.args, f.ctx, { ...f.runtime, bindSignals: false }),
    ).toBe(0);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "linear.team"),
    ).toMatchObject({ state: "done", evidence: { team: team.teamId } });
    expect(f.reads.every((read) => read.startsWith("GET "))).toBe(true);
  });
  test("Q2 presents registered IDs and names then verifies the chosen visible team", async () => {
    const f = fixture([], "owner", true);
    let presented: Array<{ id: string; key: string; name: string }> = [];
    const ui: OnboardUi & {
      chooseTeam: (
        options: Array<{ id: string; key: string; name: string }>,
        selectedId?: string,
      ) => Promise<string | null>;
    } = {
      signal: new AbortController().signal,
      plan: () => {},
      confirmPlan: async () => ({ proceed: true, localSync: false }),
      stepStart: () => {},
      stepEnd: () => {},
      message: () => {},
      finish: () => {},
      dispose: () => {},
      wait: async (_message, run) => run(),
      chooseTeam: async (options) => {
        presented = options;
        return team.teamId;
      },
    };
    const runtime = createOnboardRuntime(f.args, f.ctx, { ...f.hooks, ui });
    expect(
      await runtime.adapters!["linear.team"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "done", evidence: { team: team.teamId } });
    expect(presented).toEqual([
      { id: team.teamId, key: "ENG", name: "Engineering" },
    ]);
  });
  test("fresh unknown team visibility does not approve an explicit selection", async () => {
    const f = fixture(["--team", team.teamId]);
    const row = readiness();
    row.checks = row.checks.map((check) =>
      check.id === "team_visible" ? { ...check, state: "unknown" } : check,
    );
    f.setReadiness(row);
    expect(
      await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting" });
  });
  test("receipt roundtrip rechecks selection and removes its proof when inventory drops the team", async () => {
    const f = fixture(["--only", "linear.team", "--team", team.teamId]);
    expect(
      await cmdOnboard(f.args, f.ctx, { ...f.runtime, bindSignals: false }),
    ).toBe(0);
    const before = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      before.steps.find((step: { id: string }) => step.id === "linear.team"),
    ).toMatchObject({ state: "done", evidence: { team: team.teamId } });
    f.setInventory([]);
    expect(
      await cmdOnboard(f.args, f.ctx, { ...f.runtime, bindSignals: false }),
    ).toBe(11);
    const after = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(after.runId).toBe(before.runId);
    const selected = after.steps.find(
      (step: { id: string }) => step.id === "linear.team",
    );
    expect(selected.state).toBe("waiting");
    expect(selected.evidence?.team).toBeUndefined();
  });

  test.each([
    { ...readiness(), status: "unchecked" },
    { ...readiness(), checks: null },
    { ...readiness(), checks: [{ id: "team_visible", state: "ready" }] },
    {
      ...readiness(),
      checks: [
        { id: "team_visible", state: "pass" },
        { id: "team_visible", state: "fail" },
      ],
    },
  ])(
    "malformed readiness cannot approve a selected team %#",
    async (observation) => {
      const f = fixture(["--team", team.teamId]);
      f.setReadiness(observation);
      expect(
        await f.runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
      ).toMatchObject({ state: "waiting" });
    },
  );
  test("inventory provider error is neutral and does not leak its raw message", async () => {
    const f = fixture(["--team", team.teamId]);
    f.setLiveTeamRead({ attempted: true, error: "secret-provider-token" });
    const result = await f.runtime.adapters!["linear.team"]!.check(
      f.ctx,
      f.journal,
    );
    expect(result).toMatchObject({
      state: "waiting",
      reason: "team_read_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
  });
  test("chooser cancellation bounds an ignoring hook and late answer cannot become a selection", async () => {
    const f = fixture([], "owner", true);
    const controller = new AbortController();
    let release: ((value: string) => void) | undefined;
    const runtime = createOnboardRuntime(f.args, f.ctx, {
      ...f.hooks,
      ui: {
        signal: controller.signal,
        plan: () => {},
        confirmPlan: async () => ({ proceed: true, localSync: false }),
        stepStart: () => {},
        stepEnd: () => {},
        message: () => {},
        finish: () => {},
        dispose: () => {},
        wait: async (_message, run) => run(),
        chooseTeam: async () =>
          new Promise<string>((resolve) => {
            release = resolve;
            controller.abort();
          }),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runtime.adapters!["linear.team"]!.act!(
        f.ctx,
        f.journal,
        controller.signal,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("hung"), 250);
      }),
    ]);
    clearTimeout(timer);
    expect(result).toMatchObject({ state: "waiting", reason: "interrupted" });
    release?.(team.teamId);
    await Promise.resolve();
    expect(
      await runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "pending" });
    expect(f.journal.steps).toEqual([]);
  });
  test("mutating chooser options cannot smuggle a team into the validated inventory", async () => {
    const f = fixture([], "owner", true);
    const runtime = createOnboardRuntime(f.args, f.ctx, {
      ...f.hooks,
      ui: {
        signal: new AbortController().signal,
        plan: () => {},
        confirmPlan: async () => ({ proceed: true, localSync: false }),
        stepStart: () => {},
        stepEnd: () => {},
        message: () => {},
        finish: () => {},
        dispose: () => {},
        wait: async (_message, run) => run(),
        chooseTeam: async (options) => {
          options[0].id = "injected-team";
          return "injected-team";
        },
      },
    });
    expect(
      await runtime.adapters!["linear.team"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting", reason: "team_selection_unverified" });
    expect(f.reads.some((read) => read.includes("team=injected-team"))).toBe(
      false,
    );
  });
  test("actual main ready scopes the contract to selected B and ignores failing unselected A", async () => {
    const f = fixture();
    f.journal.steps = [
      {
        id: "linear.team",
        state: "done",
        at: new Date(now).toISOString(),
        evidence: { team: "team-ops", checkedAt: now, revision: 4 },
      },
    ];
    mkdirSync(dirname(onboardStatePath(f.home)), { recursive: true });
    writeFileSync(onboardStatePath(f.home), JSON.stringify(f.journal));
    const doc = buildFixtureContract();
    doc.account.id = "fixture-account";
    Object.assign(doc, { onboarding: supportedOnboarding() });
    doc.teams[0].readiness = {
      ...doc.teams[0].readiness,
      checkedAt: now,
      expiresAt: now + 60_000,
      checks: [
        { id: "token_live", state: "fail", reason: "expired_or_revoked" },
      ],
    };
    doc.teams[1].readiness = {
      ...doc.teams[1].readiness,
      checkedAt: now,
      expiresAt: now + 60_000,
      checks: [
        { id: "token_live", state: "pass" },
        { id: "team_visible", state: "unknown", reason: "liveness_unchecked" },
      ],
    };
    const original = f.ctx.fetch;
    f.ctx.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) =>
      new URL(String(input instanceof Request ? input.url : input)).pathname ===
      "/api/v1/agent/contract"
        ? Response.json(doc)
        : original(input, init)) as typeof fetch;
    expect(
      await main(["onboard", "--only", "ready", "--yes", "--json"], f.ctx),
    ).toBe(11);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "ready"),
    ).toMatchObject({ state: "waiting", evidence: { checks: 2, passed: 1 } });
  });

  test.each([-1, 10_000, 30_000])(
    "direct scoped reads refuse insufficient OAuth lifetime %s without refresh or writes",
    async (remaining) => {
      const f = fixture();
      const cfg = loadConfig(f.home)!;
      delete cfg.key;
      cfg.auth = {
        kind: "oauth",
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        sessionId: "fixture-session",
        expiresAt: new Date(now + remaining).toISOString(),
      };
      writeConfig(f.home, cfg);
      const before = readFileSync(configPathFor(f.home), "utf8");
      expect(
        await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
      ).toMatchObject({ state: "waiting" });
      expect(f.reads).toEqual([]);
      expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    },
  );
  test("direct scoped reads use sufficiently live OAuth bearer without rotating stored credentials", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    delete cfg.key;
    cfg.auth = {
      kind: "oauth",
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      sessionId: "fixture-session",
      expiresAt: new Date(now + 120_000).toISOString(),
    };
    writeConfig(f.home, cfg);
    const before = readFileSync(configPathFor(f.home), "utf8");
    const original = f.ctx.fetch;
    const authorization: Array<string | null> = [];
    f.ctx.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      return original(input, init);
    }) as typeof fetch;
    expect(
      await f.runtime.adapters!["linear.workspace"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "done" });
    expect(authorization).toEqual([
      "Bearer fixture-access",
      "Bearer fixture-access",
    ]);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
  });

  test.each(["bound", "account", "person", "origin"] as const)(
    "standalone readiness borrows selection only from identity-bound receipt (%s)",
    async (mismatch) => {
      const f = fixture();
      const output: string[] = [];
      f.ctx.stdout = (text: string) => {
        output.push(text);
      };
      f.journal.steps = [
        {
          id: "linear.team",
          state: "done",
          at: new Date(now).toISOString(),
          evidence: { team: "team-ops", checkedAt: now, revision: 4 },
        },
      ];
      f.journal.localSync = mismatch !== "bound";
      if (mismatch === "account") {
        f.journal.account = "foreign-account";
        f.journal.tenant = "foreign-account";
      }
      if (mismatch === "person") f.journal.membershipId = "another-person";
      if (mismatch === "origin")
        f.journal.baseUrl = "https://another-cloud.invalid";
      mkdirSync(dirname(onboardStatePath(f.home)), { recursive: true });
      writeFileSync(onboardStatePath(f.home), JSON.stringify(f.journal));
      const doc = buildFixtureContract();
      doc.account.id = "fixture-account";
      Object.assign(doc, { onboarding: supportedOnboarding() });
      doc.teams[0].readiness = {
        ...doc.teams[0].readiness,
        checkedAt: now,
        expiresAt: now + 60_000,
        checks: [
          { id: "token_live", state: "fail", reason: "expired_or_revoked" },
        ],
      };
      doc.teams[1].readiness = {
        ...doc.teams[1].readiness,
        checkedAt: now,
        expiresAt: now + 60_000,
        checks: [
          { id: "token_live", state: "pass" },
          {
            id: "team_visible",
            state: "unknown",
            reason: "liveness_unchecked",
          },
        ],
      };
      const original = f.ctx.fetch;
      f.ctx.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) =>
        new URL(String(input instanceof Request ? input.url : input))
          .pathname === "/api/v1/agent/contract"
          ? Response.json(doc)
          : original(input, init)) as typeof fetch;
      expect(await main(["ready", "--onboarding", "--json"], f.ctx)).toBe(11);
      expect(output).toHaveLength(1);
      const report = JSON.parse(output[0]);
      expect(report.readMode).toBe("cloud");
      expect(
        report.checks.some(
          (check: { state: string }) => check.state === "fail",
        ),
      ).toBe(false);
      if (mismatch === "bound") {
        expect(report.checks).toHaveLength(2);
        expect(
          report.checks.every(
            (check: { evidence?: { team?: string } }) =>
              check.evidence?.team === "team-ops",
          ),
        ).toBe(true);
      } else {
        expect(report.checks).toEqual([
          expect.objectContaining({
            state: "unknown",
            reason: "project_selection_unverified",
          }),
        ]);
      }
    },
  );

  test("default invited member onboarding never asks Q2 and records administrative team scope", async () => {
    const f = fixture([], "member", true);
    let choices = 0;
    const ui: OnboardUi = {
      signal: new AbortController().signal,
      plan: () => {},
      confirmPlan: async () => ({ proceed: true, localSync: false }),
      stepStart: () => {},
      stepEnd: () => {},
      message: () => {},
      finish: () => {},
      dispose: () => {},
      wait: async (_message, run) => run(),
      chooseTeam: async () => {
        choices++;
        return team.teamId;
      },
    };
    const runtime = createOnboardRuntime(f.args, f.ctx, { ...f.hooks, ui });
    expect(
      await cmdOnboard(f.args, f.ctx, { ...runtime, ui, bindSignals: false }),
    ).toBe(11);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "linear.team"),
    ).toMatchObject({ state: "skipped", reason: "member_scope" });
    expect(choices).toBe(0);
    expect(f.reads.every((read) => read.startsWith("GET "))).toBe(true);
  });
});
