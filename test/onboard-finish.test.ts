// CTC-4680: setup can finish. The values step reads the team's required-values check, the first
// ticket is chosen and moved to Todo in a terminal (never with --yes, JSON or headless), and the
// readiness step no longer waits for work nobody can observe yet.
import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { contractPathFor } from "../src/config.js";
import type { ContractReadinessCheck } from "../src/contract-types.js";
import { parseArgs } from "../src/args.js";
import {
  cmdOnboard,
  ONBOARD_DEPENDENCIES,
  ONBOARD_STEPS,
  stepSatisfied,
  type OnboardAdapter,
  type OnboardJournal,
  type OnboardStepId,
} from "../src/onboard.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import { onboardValuesAdapter } from "../src/onboard-values.js";
import {
  FIRST_TICKET_SAMPLE,
  FIRST_TICKET_SKIP,
  onboardFirstTicketAdapter,
  type FirstTicketOption,
} from "../src/onboard-first-ticket.js";
import {
  observeCloudOnboarding,
  onboardReadyStep,
  type OnboardingReadyReport,
} from "../src/onboard-ready.js";
import { onboardReasonText } from "../src/onboard-next.js";
import { setupFinalScreen, setupStepView } from "../src/setup-onboard-copy.js";
import { buildFixtureContract, FIXTURE_ROUTE_PREFIX } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const BASE = "https://staging.catalystcloud.dev";
// Inside the fixture contract's readiness window (checkedAt 1_756_000_000_000, one hour).
const NOW = new Date(1_756_000_600_000);

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home, { now: () => NOW });
  server.writes.length = 0;
  server.contract = buildFixtureContract();
  server.issues = [];
  await seedJoined(home, server, { contract: false });
});

// The fixture keeps one ETag, so a contract changed by a test is read past the cache.
function uncached(): void {
  rmSync(contractPathFor(home), { force: true });
}

function teamJournal(): OnboardJournal {
  return {
    schema: 1,
    runId: "run-1",
    installer: null,
    cli: "test",
    tenant: null,
    exit: null,
    operations: { "first-ticket": "run-1:first-ticket" },
    changes: [],
    steps: [{ id: "linear.team", state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }],
  };
}

function issue(identifier: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lin-${identifier.toLowerCase()}`,
    identifier,
    title: `Title of ${identifier}`,
    state: "Backlog",
    state_id: "state-backlog-eng",
    state_type: "backlog",
    estimate: null,
    priority: 3,
    team_id: "team-eng",
    team_key: "ENG",
    ...over,
  };
}

describe("on main, setup could never finish", () => {
  test("the production runtime registers the values and first-ticket steps", () => {
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), ctx, {
      login: async () => 0,
      ready: async () => ({ state: "done" }),
    });
    expect(runtime.adapters?.values).toBeDefined();
    expect(runtime.adapters?.["first-ticket"]).toBeDefined();
  });

  test("readiness is done before any work is observed", () => {
    const report: OnboardingReadyReport = {
      schema: 1,
      readMode: "cloud",
      state: "unknown",
      checks: [{ id: "team.team-eng.token_live", state: "pass", required: true }],
      work: { state: "unknown" },
    };
    expect(onboardReadyStep(report, { steps: [] })).toMatchObject({ state: "done" });
  });
});

describe("values", () => {
  test("a passing required-values check is done as values set", async () => {
    server.contract.teams[0]!.readiness.checks.push({ id: "required_values", state: "pass" });
    uncached();
    const result = await onboardValuesAdapter().check(ctx, teamJournal());
    expect(result.state).toBe("done");
    expect(setupStepView({ id: "values", state: "done" }).outcome).toBe("values set");
  });

  test("missing values wait with the variable names and the command that sets them, never a value", async () => {
    server.contract.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      reason: "required_values_missing",
      names: ["STRIPE_KEY", "DATABASE_URL"],
    });
    uncached();
    const result = await onboardValuesAdapter().check(ctx, teamJournal());
    expect(result).toMatchObject({ state: "waiting", reason: "required_values_missing" });
    const step = { id: "values" as const, state: "waiting" as const, reason: result.reason, evidence: result.evidence };
    expect(onboardReasonText(step, { baseUrl: BASE })).toBe(
      `Set STRIPE_KEY, DATABASE_URL with catalyst var set NAME --repo <owner/name> (catalyst secret set NAME --repo <owner/name> for a secret). Then run catalyst setup.`,
    );
    const screen = setupFinalScreen(
      { ...teamJournal(), exit: 0, steps: [{ id: "projects", state: "done" }, step] },
      BASE,
    );
    expect(screen.actions[0]!.text).toContain("STRIPE_KEY, DATABASE_URL");
  });

  test("an unread or absent check waits without claiming values are set", async () => {
    expect(await onboardValuesAdapter().check(ctx, teamJournal())).toMatchObject({
      state: "waiting",
      reason: "required_values_unverified",
    });
    server.contract.teams[0]!.readiness.checks.push({ id: "required_values", state: "unknown" });
    uncached();
    // CTC-4744: a fresh verdict whose check is still unknown is the cloud's unread, named as such.
    expect(await onboardValuesAdapter().check(ctx, teamJournal())).toMatchObject({
      state: "waiting",
      reason: "required_values_unread",
    });
    const stale = makeCtx(home, { now: () => new Date(1_756_010_000_000) });
    server.contract.teams[0]!.readiness.checks = [{ id: "required_values", state: "pass" }];
    uncached();
    expect(await onboardValuesAdapter().check(stale, teamJournal())).toMatchObject({ state: "waiting" });
  });
});

describe("CTC-4744 — the end of setup reads a fresh verdict and waits instead of handing a wait to the person", () => {
  const LATER = new Date(1_756_010_000_000); // past the fixture verdict's one-hour window
  const freshen = (checks: ContractReadinessCheck[]) => () => {
    const readiness = server.contract.teams[0]!.readiness;
    readiness.checkedAt = LATER.getTime() - 1_000;
    readiness.expiresAt = LATER.getTime() + 300_000;
    readiness.checks = checks;
    server.contractEtagSuffix = `-${(Number(server.contractEtagSuffix?.slice(1)) || 0) + 1}`;
  };

  test("a stale verdict is refreshed through the read-through route before values are judged", async () => {
    server.contract.teams[0]!.readiness.checks.push({ id: "required_values", state: "pass" });
    uncached();
    server.readinessRead = freshen([{ id: "required_values", state: "pass" }]);
    try {
      const later = makeCtx(home, { now: () => LATER });
      expect(await onboardValuesAdapter().check(later, teamJournal())).toMatchObject({ state: "done" });
      expect(server.requests.some((r) => r.path.startsWith("/api/v1/agent/tenant/readiness?team=team-eng"))).toBe(true);
    } finally {
      server.readinessRead = undefined;
      server.contractEtagSuffix = undefined;
    }
  });

  test("a check the cloud has not read yet is waited on with one line, then names what is still unread", async () => {
    server.readinessRead = freshen([{ id: "required_values", state: "unknown", reason: "required_values_unread" }]);
    const lines: string[] = [];
    const sleeps: number[] = [];
    try {
      const later = makeCtx(home, { now: () => LATER });
      const result = await onboardValuesAdapter({
        message: (text) => lines.push(text),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }).check(later, teamJournal());
      expect(result).toMatchObject({ state: "waiting", reason: "required_values_unread" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Waiting for Catalyst to read the settings of .+ \(up to 1 minute\)…$/);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
      expect(sleeps.length).toBeGreaterThan(0);
    } finally {
      server.readinessRead = undefined;
      server.contractEtagSuffix = undefined;
    }
  });

  test("a read that finishes while setup waits completes the step without asking anyone", async () => {
    let reads = 0;
    server.readinessRead = () => {
      reads += 1;
      freshen([
        reads < 2
          ? { id: "required_values", state: "unknown", reason: "required_values_unread" }
          : { id: "required_values", state: "pass" },
      ])();
    };
    const lines: string[] = [];
    try {
      const later = makeCtx(home, { now: () => LATER });
      const result = await onboardValuesAdapter({ message: (t) => lines.push(t), sleep: async () => {} }).check(later, teamJournal());
      expect(result.state).toBe("done");
      expect(lines).toHaveLength(1);
    } finally {
      server.readinessRead = undefined;
      server.contractEtagSuffix = undefined;
    }
  });

  test("what an unread check tells the person is true and asks nothing of them", () => {
    const text = onboardReasonText({ id: "values", state: "waiting", reason: "required_values_unread" }, { baseUrl: BASE });
    expect(text).not.toMatch(/run catalyst setup again in a few minutes/i);
    expect(text).toContain("You don't need to do anything");
    expect(text).toContain("catalyst ready");
  });

  test("a first ticket waits for the values check", () => {
    expect(ONBOARD_DEPENDENCIES["first-ticket"]).toContain("values");
  });

  test.each([
    ["required_values_unread", false],
    ["required_values_unverified", true],
    ["required_values_missing", true],
  ] as const)("with values %s, setup %s offers a first ticket", async (reason, offered) => {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters["linear.team"] = { check: async () => ({ state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }) };
    adapters.values = { check: async () => ({ state: "waiting", reason }) };
    let asked = 0;
    adapters["first-ticket"] = {
      check: async () => {
        asked += 1;
        return { state: "skipped", reason: "first_ticket_skipped" };
      },
    };
    await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      { ...ctx, stdout: () => {}, stderr: () => {} },
      { adapters, bindSignals: false, identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "admin" }) },
    );
    expect(asked > 0).toBe(offered);
  });

  test("setup's readiness step refreshes the verdict too, so it agrees with catalyst ready", async () => {
    await seedJoined(home, server, {
      contract: false,
      config: { user: { id: "person-a", role: "admin", label: "A", email: null, linearUserId: null } },
    });
    server.readinessRead = freshen([{ id: "token_live", state: "pass" }]);
    try {
      const later = makeCtx(home, { now: () => LATER });
      const observed = await observeCloudOnboarding(later, { teamIds: ["team-eng"] });
      expect(observed.checks.map((c) => c.state)).toEqual(["pass"]);
    } finally {
      server.readinessRead = undefined;
      server.contractEtagSuffix = undefined;
    }
  });
});

describe("first ticket", () => {
  test("--yes, JSON and headless runs never list, choose or create a ticket", async () => {
    const adapter = onboardFirstTicketAdapter({});
    const before = server.requests.length;
    expect(await adapter.check(ctx, teamJournal())).toMatchObject({
      state: "waiting",
      reason: "first_ticket_choice_required",
    });
    expect(server.requests.length).toBe(before);
    expect(server.writes).toHaveLength(0);
    expect(
      onboardReasonText({ id: "first-ticket", state: "waiting", reason: "first_ticket_choice_required" }, { journal: teamJournal() }),
    ).toBe("Move one of ENG's tickets to the stage that starts Catalyst's work in Linear. Catalyst picks it up next.");
    // With the contract on this computer, it names the team's own stage, still without a network read.
    await seedJoined(home, server);
    const cached = server.requests.length;
    const known = await adapter.check(ctx, teamJournal());
    expect(server.requests.length).toBe(cached);
    expect(
      onboardReasonText({ id: "first-ticket", state: "waiting", reason: known.reason, evidence: known.evidence }, { journal: teamJournal() }),
    ).toBe("Move one of ENG's tickets to Todo in Linear. Catalyst picks it up next.");
  });

  test("offers up to five open tickets, smallest estimate first, and moves the choice to Todo", async () => {
    server.issues = [
      issue("ENG-1", { estimate: 8 }),
      issue("ENG-2", { estimate: 1 }),
      issue("ENG-3", { state: "Todo", state_id: "state-todo", state_type: "unstarted" }),
      issue("ENG-4", { state: "Done", state_id: "state-done", state_type: "completed" }),
      issue("ENG-5", { estimate: 2 }),
      issue("ENG-6", { estimate: 3, state: "Triage", state_id: "state-triage", state_type: "triage" }),
      issue("ENG-7", { estimate: 5 }),
      issue("ENG-8"),
      issue("ENG-9", { estimate: 1, state: "Ready", state_id: "state-ready", state_type: "unstarted" }),
      issue("OPS-1", { team_id: "team-ops", team_key: "OPS" }),
    ];
    let offered: FirstTicketOption[] = [];
    const adapter = onboardFirstTicketAdapter({
      choose: async (tickets) => {
        offered = tickets;
        return "ENG-5";
      },
    });
    const journal = teamJournal();
    expect(await adapter.check(ctx, journal)).toEqual({ state: "pending" });
    const result = await adapter.act!(ctx, journal);
    expect(offered.map((t) => t.identifier)).toEqual(["ENG-2", "ENG-9", "ENG-5", "ENG-6", "ENG-7"]);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/issue-state`);
    expect(server.writes[0]!.body).toEqual({ issueId: "lin-eng-5", stateId: "state-todo" });
    expect(result).toEqual({
      state: "done",
      evidence: { ticket: "ENG-5", teamKey: "ENG", stage: "Todo", url: "https://linear.app/hagale/issue/ENG-5" },
    });
    // The engine checks again right after the action, before the receipt has the evidence.
    expect(await adapter.check(ctx, journal)).toEqual(result);
    const done = { id: "first-ticket" as const, state: "done" as const, evidence: result.evidence };
    expect(setupStepView(done).outcome).toBe("ENG-5 moved to Todo. Catalyst picks it up next.");
    expect(await onboardFirstTicketAdapter({}).check(ctx, { ...journal, steps: [...journal.steps, done] })).toMatchObject({
      state: "done",
    });
  });

  test("a sample ticket is created straight into Todo with the run's idempotency key", async () => {
    const adapter = onboardFirstTicketAdapter({ choose: async () => FIRST_TICKET_SAMPLE });
    const result = await adapter.act!(ctx, teamJournal());
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.path).toBe(`${FIXTURE_ROUTE_PREFIX}/issue-create`);
    expect(server.writes[0]!.body).toMatchObject({
      teamId: "team-eng",
      stateId: "state-todo",
      title: "Document how to run repository tests",
      idempotencyId: "run-1:first-ticket",
    });
    expect(String((server.writes[0]!.body as { description: string }).description)).toContain("Update only CONTRIBUTING.md");
    expect(result).toMatchObject({ state: "done", evidence: { ticket: "ENG-201" } });
  });

  test("skip for now is a choice that lets setup finish", async () => {
    const adapter = onboardFirstTicketAdapter({ choose: async () => FIRST_TICKET_SKIP });
    const result = await adapter.act!(ctx, teamJournal());
    expect(result).toEqual({ state: "skipped", reason: "first_ticket_skipped", evidence: { stage: "Todo" } });
    expect(server.writes).toHaveLength(0);
    expect(stepSatisfied({ id: "first-ticket", state: "skipped", reason: "first_ticket_skipped" })).toBe(true);
    expect(stepSatisfied({ id: "first-ticket", state: "skipped", reason: "interrupted" })).toBe(false);
  });

  test("a refused move tells the person who to ask", async () => {
    server.issues = [issue("ENG-1")];
    const refused = makeCtx(home, {
      now: () => NOW,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        String(input).includes("/issue-state")
          ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
          : fetch(input, init)) as typeof fetch,
    });
    const result = await onboardFirstTicketAdapter({ choose: async () => "ENG-1" }).act!(refused, teamJournal());
    expect(result).toEqual({ state: "waiting", reason: "first_ticket_move_refused", evidence: { stage: "Todo" } });
    expect(onboardReasonText({ id: "first-ticket", state: "waiting", reason: result.reason, evidence: result.evidence }, { journal: teamJournal() })).toBe(
      "Catalyst could not move the ticket for you. Ask a Catalyst owner or admin to check its Linear connection, or move one of ENG's tickets to Todo in Linear yourself.",
    );
  });
});

describe("readiness and the end screen", () => {
  const report = (checks: OnboardingReadyReport["checks"]): OnboardingReadyReport => ({
    schema: 1,
    readMode: "cloud",
    state: "unknown",
    checks,
    work: { state: "unknown" },
  });

  test("readiness waits on a required step, fails on a broken connection, and leaves values to its own step", () => {
    const waitingStep = { steps: [{ id: "accounts" as const, state: "waiting" as const, reason: "account_enrollment_required" }] };
    expect(onboardReadyStep(report([]), waitingStep)).toMatchObject({ state: "waiting" });
    expect(
      onboardReadyStep(report([{ id: "team.team-eng.token_live", state: "fail", required: true }]), { steps: [] }),
    ).toMatchObject({ state: "failed" });
    expect(
      onboardReadyStep(
        report([
          { id: "team.team-eng.required_values", state: "fail", required: true, reason: "required_value_missing" },
          { id: "team.team-eng.reviewer_configured", state: "fail", required: true, reason: "no_reviewer_configured" },
          { id: "team.team-eng.webhook_covers_team", state: "unknown", required: true, reason: "delivery_window_empty" },
          { id: "team.team-eng.writes_land", state: "unknown", required: true, reason: "no_write_observed" },
        ]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "done" });
    expect(
      onboardReadyStep(report([{ id: "cloud.setup", state: "unknown", required: true, reason: "cloud_observation_unavailable" }]), { steps: [] }),
    ).toMatchObject({ state: "waiting" });
  });

  async function run(firstTicket: OnboardAdapter) {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters.housekeeping = { check: async () => ({ state: "skipped", reason: "housekeeping_no_scheduler" }) };
    adapters.settings = { check: async () => ({ state: "waiting", reason: "settings_checkout_unverified" }) };
    adapters["first-ticket"] = firstTicket;
    const out: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      { ...ctx, stdout: (line) => out.push(line), stderr: () => {} },
      {
        adapters,
        bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "admin" }),
      },
    );
    const { readOnboardJournal, onboardStatePath } = await import("../src/onboard.js");
    return { code, out, journal: readOnboardJournal(onboardStatePath(home, ctx.env))! };
  }

  test("optional waits and a skipped first ticket still complete setup", async () => {
    const { code, journal } = await run({
      check: async () => ({ state: "skipped", reason: "first_ticket_skipped" }),
    });
    expect(code).toBe(0);
    expect(journal.complete).toBe(true);
    const screen = setupFinalScreen(journal, BASE);
    expect(screen.heading).toBe("Setup complete");
    expect(screen.actions).toEqual([]);
    expect(screen.next).toBe("Next: move a ticket to the stage that starts Catalyst's work in Linear.");
  });

  test("a first ticket that waits for a choice is ready for work, not complete", async () => {
    const { code, journal } = await run({
      check: async () => ({ state: "waiting", reason: "first_ticket_choice_required" }),
    });
    expect(code).toBe(0);
    expect(journal.complete).toBe(false);
    expect(setupFinalScreen(journal, BASE).heading).toBe("Ready for work");
  });

  test("a started ticket ends on where to follow it", async () => {
    const { journal } = await run({
      check: async () => ({
        state: "done",
        evidence: { ticket: "ENG-5", teamKey: "ENG", url: "https://linear.app/hagale/issue/ENG-5" },
      }),
    });
    expect(journal.complete).toBe(true);
    expect(setupFinalScreen(journal, BASE).next).toBe(
      "Follow https://linear.app/hagale/issue/ENG-5 in Linear; Catalyst comments there as each phase finishes.",
    );
  });
});

// The independent review of #267: five findings, each red before its fix.
describe("review fixes", () => {
  const report = (checks: OnboardingReadyReport["checks"]): OnboardingReadyReport => ({
    schema: 1,
    readMode: "cloud",
    state: "unknown",
    checks,
    work: { state: "unknown" },
  });

  test.each([
    ["a stale team check", { id: "team.team-eng", state: "unknown" as const, required: true, reason: "team_check_pending" }],
    ["an unverified team", { id: "team.team-eng", state: "unknown" as const, required: true, reason: "team_selection_unverified" }],
    ["an unread Linear connection", { id: "team.team-eng.token_live", state: "unknown" as const, required: true }],
    ["an unread GitHub install", { id: "team.team-eng.github_app_installed", state: "unknown" as const, required: true }],
    ["a measuring check with another reason", { id: "team.team-eng.writes_land", state: "unknown" as const, required: true, reason: "writes_unread" }],
  ])("readiness waits on %s", (_name, check) => {
    expect(onboardReadyStep(report([check]), { steps: [] })).toMatchObject({ state: "waiting" });
  });

  test("no host connected yet does not hold readiness: an account with no local replica has none by design", () => {
    expect(
      onboardReadyStep(
        report([{ id: "team.team-eng.hosts_current", state: "unknown", required: true, reason: "no_host_connected" }]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "done" });
    expect(
      onboardReadyStep(
        report([{ id: "team.team-eng.hosts_current", state: "unknown", required: true, reason: "hosts_unreported" }]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "waiting" });
  });

  test("a value reference with no value fails readiness: the checkout refuses it before any work", () => {
    expect(
      onboardReadyStep(
        report([{ id: "team.team-eng.required_values", state: "fail", required: true, reason: "value_reference_unresolved" }]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "failed" });
  });

  test("a resumed run re-moves the ticket it chose, and never lists or moves a second one", async () => {
    server.issues = [issue("ENG-1"), issue("ENG-5")];
    const journal = { ...teamJournal(), operations: { "first-ticket": "run-1:first-ticket:ENG-5" } };
    const adapter = onboardFirstTicketAdapter({
      choose: async () => {
        throw new Error("a resumed move must not ask again");
      },
    });
    const result = await adapter.act!(ctx, journal);
    expect(server.writes.map((w) => w.body)).toEqual([{ issueId: "lin-eng-5", stateId: "state-todo" }]);
    expect(result).toMatchObject({ state: "done", evidence: { ticket: "ENG-5" } });
    server.writes.length = 0;
    server.issues = [issue("ENG-1"), issue("ENG-5", { state: "Research", state_id: "state-research", state_type: "started" })];
    // Already picked up by Catalyst: recorded as it is, never moved back to the dispatch stage.
    expect(await adapter.act!(ctx, journal)).toMatchObject({
      state: "done",
      evidence: { ticket: "ENG-5" },
    });
    expect(server.writes).toHaveLength(0);
  });

  test("the chosen ticket is saved in the receipt before the move is sent", async () => {
    server.issues = [issue("ENG-1")];
    const { onboardStatePath, readOnboardJournal, writeOnboardJournal } = await import("../src/onboard.js");
    const path = onboardStatePath(home, ctx.env);
    const journal = teamJournal();
    writeOnboardJournal(path, journal);
    let saved: string | undefined;
    const watching = makeCtx(home, {
      now: () => NOW,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes("/issue-state")) saved = readOnboardJournal(path)?.operations?.["first-ticket"];
        return fetch(input, init);
      }) as typeof fetch,
    });
    await onboardFirstTicketAdapter({ choose: async () => "ENG-1" }).act!(watching, journal);
    expect(saved).toBe("run-1:first-ticket:ENG-1");
  });

  test("a renamed dispatch stage is named in the question, the outcome and the next step", async () => {
    server.contract.teams[0]!.stages.dispatch!.name = "Ready for Catalyst";
    server.issues = [issue("ENG-1")];
    let stage: string | undefined;
    const result = await onboardFirstTicketAdapter({
      choose: async (_tickets, where) => {
        stage = where.stage;
        return "ENG-1";
      },
    }).act!(ctx, teamJournal());
    expect(stage).toBe("Ready for Catalyst");
    const done = { id: "first-ticket" as const, state: "done" as const, evidence: result.evidence };
    expect(setupStepView(done).outcome).toBe("ENG-1 moved to Ready for Catalyst. Catalyst picks it up next.");
    const skipped = { id: "first-ticket" as const, state: "skipped" as const, reason: "first_ticket_skipped", evidence: { stage: "Ready for Catalyst" } };
    const finished = { ...teamJournal(), exit: 0, complete: true, steps: [...ONBOARD_STEPS.map((id) => ({ id, state: "done" as const })).filter((s) => s.id !== "first-ticket"), skipped] };
    expect(setupFinalScreen(finished, BASE).next).toBe("Next: move a ticket to Ready for Catalyst in Linear.");
  });

  test("a variable that refers to a secret with no value is not told to be set", async () => {
    server.contract.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      reason: "value_reference_unresolved",
      names: ["DATABASE_URL", "STRIPE_KEY"],
      unresolved: [{ name: "DATABASE_URL", references: ["DB_PASSWORD"] }],
    });
    uncached();
    const result = await onboardValuesAdapter().check(ctx, teamJournal());
    expect(result).toMatchObject({ state: "waiting", reason: "required_values_missing" });
    expect(onboardReasonText({ id: "values", state: "waiting", reason: result.reason, evidence: result.evidence }, { baseUrl: BASE })).toBe(
      `Set STRIPE_KEY with catalyst var set STRIPE_KEY --repo <owner/name> (catalyst secret set STRIPE_KEY --repo <owner/name> for a secret). DATABASE_URL refers to DB_PASSWORD, which has no value, so Catalyst can't start work there. Then run catalyst setup.`,
    );
  });
});

// Fixture capture 05c: a member's run skipped every admin step and still ended "Setup complete".
describe("a member's run", () => {
  const MEMBER_SKIPS = ["linear.workspace", "linear.adopt", "github.install"] as const;
  const teamChecks = (states: Partial<Record<string, "pass" | "fail" | "unknown">>) => ({
    schema: 1 as const,
    readMode: "cloud" as const,
    state: "unknown" as const,
    work: { state: "unknown" as const },
    checks: ["oauth_scope", "token_live", "github_app_installed", "mapping_total", "mapped_states_exist"].map((id) => ({
      id: `team.team-eng.${id}`,
      state: states[id] ?? ("pass" as const),
      required: true,
    })),
  });
  const memberSteps = () => ({
    steps: [
      { id: "linear.team" as const, state: "done" as const, evidence: { team: "team-eng", teamKey: "ENG" } },
      ...MEMBER_SKIPS.map((id) => ({ id, state: "skipped" as const, reason: "member_scope" })),
    ],
  });

  test("readiness waits, naming what an admin still has to connect", () => {
    expect(onboardReadyStep(teamChecks({ token_live: "fail", github_app_installed: "fail" }), memberSteps())).toMatchObject({
      state: "waiting",
      reason: "admin_setup_pending",
      evidence: { admin: "linear.workspace,github.install" },
    });
    const ready = onboardReadyStep(teamChecks({ token_live: "fail", github_app_installed: "fail" }), memberSteps());
    expect(onboardReasonText({ id: "ready", state: "waiting", reason: ready.reason, evidence: ready.evidence }, { baseUrl: BASE })).toBe(
      `A Catalyst owner or admin still has to connect Linear and install Catalyst on GitHub. Ask one to open ${BASE}/settings/connections, then run catalyst setup.`,
    );
    expect(onboardReadyStep(teamChecks({}), memberSteps())).toMatchObject({ state: "done" });
  });

  async function memberRun(states: Partial<Record<string, "pass" | "fail" | "unknown">>) {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters["linear.team"] = { check: async () => ({ state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }) };
    adapters.ready = { check: async (_ctx, journal) => onboardReadyStep(teamChecks(states), journal) };
    const code = await cmdOnboard(
      parseArgs(["onboard", "--yes", "--team", "ENG"]),
      { ...ctx, stdout: () => {}, stderr: () => {} },
      {
        adapters,
        bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "member" }),
      },
    );
    const { readOnboardJournal, onboardStatePath } = await import("../src/onboard.js");
    return { code, journal: readOnboardJournal(onboardStatePath(home, ctx.env))! };
  }

  test("nothing an admin owns connected: not complete, and the end screen says what an admin has to do", async () => {
    const { journal } = await memberRun({ token_live: "fail", github_app_installed: "fail", mapping_total: "fail" });
    expect(journal.complete).toBe(false);
    expect(journal.steps.find((s) => s.id === "github.install")).toMatchObject({ state: "skipped", reason: "member_scope" });
    const screen = setupFinalScreen(journal, BASE);
    expect(screen.heading).not.toBe("Setup complete");
    const text = screen.actions.map((a) => a.text);
    expect(text).toContain(
      `Only a Catalyst owner or admin can connect Linear. Ask one to open ${BASE}/settings/connections and connect it there.`,
    );
    expect(text).toContain(
      `Only an owner or admin of your Catalyst workspace can install Catalyst on GitHub. Ask one to open ${BASE}/settings/connections and install it there.`,
    );
    expect(text).toContain(
      "Only a Catalyst owner or admin can set up the team's Catalyst workflow. Ask one to run catalyst team adopt ENG.",
    );
  });

  test("an admin already connected everything: the member's setup is complete", async () => {
    const { journal } = await memberRun({});
    expect(journal.complete).toBe(true);
    expect(setupFinalScreen(journal, BASE).heading).toBe("Setup complete");
  });
});

// Re-review of #267 at 37fd6ef: four findings, each red before its fix.
describe("re-review fixes", () => {
  const report = (checks: OnboardingReadyReport["checks"]): OnboardingReadyReport => ({
    schema: 1,
    readMode: "cloud",
    state: "unknown",
    checks,
    work: { state: "unknown" },
  });
  const adminSkips = ["linear.workspace", "linear.adopt", "github.install"].map((id) => ({
    id: id as OnboardStepId,
    state: "skipped" as const,
    reason: "member_scope",
  }));

  test("a member with no team is asked to choose one, not told an admin left everything undone", () => {
    const steps = [{ id: "linear.team" as const, state: "skipped" as const, reason: "member_scope" }, ...adminSkips];
    const result = onboardReadyStep(
      report([{ id: "projects", state: "unknown", required: true, reason: "project_selection_unverified" }]),
      { steps },
    );
    expect(result).toMatchObject({ state: "waiting", reason: "member_team_required" });
    expect(onboardReasonText({ id: "ready", state: "waiting", reason: result.reason })).toBe(
      "Setup needs your Linear team to check what Catalyst can work on. Run catalyst setup again with --team <KEY>, using your team's key from Linear.",
    );
  });

  test("a member whose team checks are stale waits for them, without naming admin steps", () => {
    const steps = [{ id: "linear.team" as const, state: "done" as const, evidence: { team: "team-eng", teamKey: "ENG" } }, ...adminSkips];
    expect(
      onboardReadyStep(report([{ id: "team.team-eng", state: "unknown", required: true, reason: "team_check_pending" }]), { steps }),
    ).toMatchObject({ state: "waiting", reason: "onboarding_checks_pending" });
  });

  test("a reviewer that has not answered yet does not hold readiness", () => {
    expect(
      onboardReadyStep(
        report([{ id: "team.team-eng.reviewer_answering", state: "unknown", required: true, reason: "reviewer_not_yet_answered" }]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "done" });
  });

  test("a failed delivery probe holds readiness; only an empty delivery window waits it out", () => {
    expect(
      onboardReadyStep(
        report([{ id: "team.team-eng.webhook_covers_team", state: "unknown", required: true, reason: "no_delivery_observed" }]),
        { steps: [] },
      ),
    ).toMatchObject({ state: "waiting" });
  });

  test("the plain finish names the team's own dispatch stage, and leaves the move to a waiting first ticket", async () => {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters["linear.team"] = { check: async () => ({ state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }) };
    // CTC-4744: a first ticket waits for the values check, so values are set here.
    adapters.values = { check: async () => ({ state: "done" }) };
    // Setup stays unfinished on a step that does not hold a first ticket, so the plain finish lists
    // next actions (with every step done it prints the complete screen instead).
    adapters.ready = { check: async () => ({ state: "waiting", reason: "team_check_pending" }) };
    adapters["first-ticket"] = {
      check: async () => ({ state: "done", evidence: { ticket: "ENG-5", teamKey: "ENG", stage: "Ready for Catalyst" } }),
    };
    const plain = async () => {
      const out: string[] = [];
      await cmdOnboard(
        parseArgs(["onboard", "--yes"]),
        { ...ctx, stdout: (line) => out.push(line), stderr: () => {} },
        { adapters, bindSignals: false, identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "admin" }) },
      );
      return out.join("\n");
    };
    const done = await plain();
    expect(done).toContain("Move a ticket in ENG to Ready for Catalyst;");
    expect(done).not.toContain("Todo");
    adapters["first-ticket"] = {
      check: async () => ({ state: "waiting", reason: "first_ticket_choice_required", evidence: { stage: "Ready for Catalyst" } }),
    };
    const waiting = await plain();
    expect(waiting).toContain("Start a first ticket: Move one of ENG's tickets to Ready for Catalyst in Linear.");
    expect(waiting).not.toContain("Move a ticket in ENG");
  });
});

// Second re-review of #267 at 249a5ec: two findings and the --team next line, each red first.
describe("second re-review fixes", () => {
  test("an unread admin check (an outage, a workflow just adopted) is the ordinary wait, not an admin's job", () => {
    const report: OnboardingReadyReport = {
      schema: 1,
      readMode: "cloud",
      state: "unknown",
      work: { state: "unknown" },
      checks: [
        { id: "team.team-eng.token_live", state: "unknown", required: true, reason: "linear_unreachable" },
        { id: "team.team-eng.mapping_total", state: "unknown", required: true, reason: "stages_pending_write" },
        { id: "team.team-eng.github_app_installed", state: "unknown", required: true, reason: "github_app_installation_unread" },
      ],
    };
    const steps = [
      { id: "linear.team" as const, state: "done" as const, evidence: { team: "team-eng", teamKey: "ENG" } },
      ...["linear.workspace", "linear.adopt", "github.install"].map((id) => ({
        id: id as OnboardStepId,
        state: "skipped" as const,
        reason: "member_scope",
      })),
    ];
    expect(onboardReadyStep(report, { steps })).toMatchObject({ state: "waiting", reason: "onboarding_checks_pending" });
  });

  test("a person who skipped the first ticket still gets the hint to move one", async () => {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters["linear.team"] = { check: async () => ({ state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }) };
    // CTC-4744: the hint to start work comes only once values are known, so they are set here.
    adapters.values = { check: async () => ({ state: "done" }) };
    // Setup stays unfinished on a step that does not hold a first ticket, so the plain finish lists
    // next actions (with every step done it prints the complete screen instead).
    adapters.ready = { check: async () => ({ state: "waiting", reason: "team_check_pending" }) };
    adapters["first-ticket"] = {
      check: async () => ({ state: "skipped", reason: "first_ticket_skipped", evidence: { stage: "Ready for Catalyst" } }),
    };
    const out: string[] = [];
    await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      { ...ctx, stdout: (line) => out.push(line), stderr: () => {} },
      { adapters, bindSignals: false, identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "admin" }) },
    );
    expect(out.join("\n")).toContain("Move a ticket in ENG to Ready for Catalyst;");
  });

  test("a member asked to choose a team is told to rerun with --team", () => {
    const journal: OnboardJournal = {
      ...teamJournal(),
      exit: 11,
      steps: [
        { id: "linear.team", state: "skipped", reason: "member_scope" },
        { id: "ready", state: "waiting", reason: "member_team_required" },
      ],
    };
    expect(setupFinalScreen(journal, BASE).next).toBe("Next: run catalyst onboard --team <KEY> to check again.");
  });
});

// Final review of #267 at e5f333e: two bugs in the feature itself, each red before its fix.
describe("final review fixes", () => {
  test("a refused move forgets the choice, so the next run offers the list and Skip again", async () => {
    server.issues = [issue("ENG-1"), issue("ENG-2")];
    const refused = makeCtx(home, {
      now: () => NOW,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        String(input).includes("/issue-state")
          ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
          : fetch(input, init)) as typeof fetch,
    });
    const journal = teamJournal();
    const first = await onboardFirstTicketAdapter({ choose: async () => "ENG-1" }).act!(refused, journal);
    expect(first).toMatchObject({ state: "waiting", reason: "first_ticket_move_refused" });
    expect(journal.operations?.["first-ticket"]).toBe("run-1:first-ticket");
    let offered: FirstTicketOption[] | undefined;
    const again = await onboardFirstTicketAdapter({
      choose: async (tickets) => {
        offered = tickets;
        return FIRST_TICKET_SKIP;
      },
    }).act!(ctx, journal);
    expect(offered?.map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(again).toMatchObject({ state: "skipped", reason: "first_ticket_skipped" });
    expect(server.writes).toHaveLength(0);
  });

  test("a resumed choice is re-sent for that ticket even when another one already waited in the dispatch stage", async () => {
    // ENG-5 sat in Todo before setup started; the person chose ENG-1 and the move answered 502.
    server.issues = [issue("ENG-1"), issue("ENG-5", { state: "Todo", state_id: "state-todo", state_type: "unstarted" })];
    const journal = { ...teamJournal(), operations: { "first-ticket": "run-1:first-ticket:ENG-1" } };
    const result = await onboardFirstTicketAdapter({
      choose: async () => {
        throw new Error("must not ask");
      },
    }).act!(ctx, journal);
    expect(server.writes.map((w) => w.body)).toEqual([{ issueId: "lin-eng-1", stateId: "state-todo" }]);
    expect(result).toMatchObject({ state: "done", evidence: { ticket: "ENG-1" } });
  });

  test("a member's run checks the values too, and says who sets a missing one", async () => {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters["linear.team"] = { check: async () => ({ state: "done", evidence: { team: "team-eng", teamKey: "ENG" } }) };
    adapters.values = {
      check: async () => ({
        state: "waiting",
        reason: "required_values_missing",
        evidence: { team: "team-eng", requiredValues: JSON.stringify({ names: ["STRIPE_KEY"] }) },
      }),
    };
    await cmdOnboard(
      parseArgs(["onboard", "--yes", "--team", "ENG"]),
      { ...ctx, stdout: () => {}, stderr: () => {} },
      {
        adapters,
        bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "member" }),
      },
    );
    const { readOnboardJournal, onboardStatePath } = await import("../src/onboard.js");
    const journal = readOnboardJournal(onboardStatePath(home, ctx.env))!;
    expect(journal.steps.find((s) => s.id === "values")).toMatchObject({ state: "waiting", reason: "required_values_missing" });
    expect(journal.complete).toBe(false);
    const withRole = {
      ...journal,
      steps: journal.steps.map((s) => (s.id === "signin" ? { ...s, evidence: { role: "member" } } : s)),
    };
    expect(setupFinalScreen(withRole, BASE).actions.map((a) => a.text)).toContain(
      `Ask a Catalyst owner or admin to set STRIPE_KEY with catalyst var set STRIPE_KEY --repo <owner/name> (catalyst secret set STRIPE_KEY --repo <owner/name> for a secret). Then run catalyst setup.`,
    );
  });
});

// Delta review at 66b5af9: a member's plain run without --team.
describe("delta review fixes", () => {
  test("a member without --team skips values and is told to rerun with --team", async () => {
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters.values = onboardValuesAdapter();
    adapters.ready = {
      check: async (_ctx, journal) =>
        onboardReadyStep(
          {
            schema: 1,
            readMode: "cloud",
            state: "unknown",
            work: { state: "unknown" },
            checks: [{ id: "projects", state: "unknown", required: true, reason: "project_selection_unverified" }],
          },
          journal,
        ),
    };
    await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      { ...ctx, stdout: () => {}, stderr: () => {} },
      {
        adapters,
        bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: BASE, role: "member" }),
      },
    );
    const { readOnboardJournal, onboardStatePath } = await import("../src/onboard.js");
    const journal = readOnboardJournal(onboardStatePath(home, ctx.env))!;
    expect(journal.steps.find((s) => s.id === "values")).toMatchObject({ state: "skipped", reason: "member_scope" });
    const screen = setupFinalScreen(journal, BASE);
    expect(screen.actions.map((a) => a.text).join("\n")).not.toContain("few minutes");
    expect(screen.next).toBe("Next: run catalyst onboard --team <KEY> to check again.");
  });
});
