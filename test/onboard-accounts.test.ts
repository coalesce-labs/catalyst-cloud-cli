import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import { onboardAccountsAdapter } from "../src/onboard-accounts.js";
import { onboardReasonText } from "../src/onboard-next.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import type { OnboardJournal } from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";

const homes: string[] = [];
const origin = "https://accounts-fixture.invalid";
const now = Date.parse("2026-10-01T04:00:00Z");
const accountPath = "/api/v1/coding-accounts";
interface Route {
  method: "GET" | "POST";
  path: string;
  personalBearer: boolean;
}
const routes = (): Route[] => [
  { method: "GET", path: accountPath, personalBearer: true },
  {
    method: "POST",
    path: "/api/v1/coding-accounts/:slot/validate",
    personalBearer: true,
  },
];
function slot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // Match TenantWireAccount metadata, including nullable subscription facts. No credential DTO.
  return {
    accountSlot: "claude-one",
    provider: "claude",
    harness: "claude",
    label: "Fixture",
    declaredState: "active",
    observedState: "unobserved",
    observedStatus: "unobserved",
    status: "unobserved",
    renewalStatus: null,
    accessEndsAtMs: null,
    revokedAtMs: null,
    window5h: { usedPercent: null, resetsAtMs: null },
    window7d: { usedPercent: null, resetsAtMs: null },
    bindingWindow: null,
    bindingUsedPercent: null,
    bindingResetsAtMs: null,
    usageObservedAtMs: null,
    lastPolledAtMs: null,
    walled: false,
    quarantined: false,
    quarantineReason: null,
    pollFailureCount: 0,
    lastPollErrorCode: null,
    needsCredential: false,
    liveHoldsCount: 0,
    liveHolds: [],
    ownedByMe: true,
    ...overrides,
  };
}
interface State {
  routes: Route[];
  accounts: unknown;
  observedAtMs: number;
  inventoryResponse?: () => Response;
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-accounts-"));
  homes.push(home);
  const messages: string[] = [];
  const calls: Array<{ method: string; path: string; init?: RequestInit }> = [];
  let currentTime = now;
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: { CATALYST_CLOUD_TOKEN: "ctc_unused_ambient_synthetic" },
    now: () => new Date(currentTime),
    stdout: vi.fn(),
    stderr: vi.fn(),
  };
  writeConfig(home, {
    baseUrl: origin,
    account: "account-a",
    slug: "fixture",
    name: "Fixture",
    principal: "session",
    permissions: null,
    user: {
      id: "person-a",
      role: "owner",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_person_synthetic",
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: "0.14.6",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "accounts-fixture",
    cli: "0.14.6",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    steps: [],
    changes: [],
    exit: null,
  };
  const state: State = {
    routes: routes(),
    accounts: [slot()],
    observedAtMs: now,
  };
  ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_person_synthetic",
    );
    calls.push({ method, path: url.pathname, init });
    if (url.pathname === "/api/v1/agent/contract" && method === "GET")
      return Response.json({
        account: { id: "account-a" },
        contractVersion: "2.16.0",
        onboarding: {
          schema: 1,
          routes: state.routes,
          web: {
            connections: "/a/account/connections",
            personalConnections: "/settings/connected-accounts",
          },
        },
      });
    if (url.pathname === accountPath && method === "GET")
      return state.inventoryResponse
        ? state.inventoryResponse()
        : Response.json({
            accounts: state.accounts,
            observedAtMs: state.observedAtMs,
          });
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  const ui: OnboardUi = {
    signal: new AbortController().signal,
    plan: () => {},
    confirmPlan: async () => ({ proceed: false, localSync: false }),
    stepStart: () => {},
    stepEnd: () => {},
    finish: () => {},
    dispose: () => {},
    wait: async (_text, work) => work(),
    message: (text) => {
      messages.push(text);
    },
  };
  const makeAdapter = () => {
    const adapter = createOnboardRuntime(parseArgs(["onboard", "--yes"]), ctx, {
      ui,
      login: async () => {
        throw new Error("Unexpected login in accounts fixture");
      },
      ready: async () => ({ state: "waiting", reason: "fixture_unverified" }),
    }).adapters?.accounts;
    if (!adapter?.act) throw new Error("Real accounts runtime adapter missing");
    return adapter;
  };
  return {
    home,
    ctx,
    state,
    journal,
    messages,
    calls,
    adapter: makeAdapter(),
    makeAdapter,
    posts: () => calls.filter((call) => call.method === "POST"),
    configBytes: () => readFileSync(configPathFor(home)),
    setTime: (time: number) => {
      currentTime = time;
    },
  };
}
function switchConfig(home: string, dimension: string) {
  const cfg = loadConfig(home);
  if (!cfg?.user) throw new Error("Fixture personal config missing");
  if (dimension === "person") cfg.user.id = "person-replacement";
  if (dimension === "account") cfg.account = "account-replacement";
  if (dimension === "origin") cfg.baseUrl = "https://replacement.invalid";
  if (dimension === "role") cfg.user.role = "member";
  writeConfig(home, cfg);
}
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("CTC-4680: any usable AI account finishes the step", () => {
  test.each([
    ["claude", {}],
    ["codex", { accountSlot: "codex-one", provider: "codex" }],
    ["another member's", { ownedByMe: false }],
    // The server's rule: a canceled subscription works until its paid access ends.
    ["a canceled but still paid", { renewalStatus: "canceled", accessEndsAtMs: now + 86400000 }],
    ["a canceled one with no end recorded", { renewalStatus: "canceled", accessEndsAtMs: null }],
  ])("%s account counts", async (_name, change) => {
    const f = fixture();
    f.state.accounts = [slot(change)];
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: (change as { provider?: string }).provider ?? "claude" },
    });
    // Done is read from the account list alone: no provider request, no write.
    expect(f.posts()).toEqual([]);
  });
  test("one usable account among unusable ones is enough", async () => {
    const f = fixture();
    f.state.accounts = [
      slot({ accountSlot: "claude-walled", walled: true }),
      slot({ accountSlot: "codex-ok", provider: "codex" }),
    ];
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: "codex" },
    });
  });
  test("missing advertised GET prevents the account read", async () => {
    const f = fixture();
    f.state.routes = [];
    expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
      "cloud_capability_unavailable",
    );
    // The contract is read for the checklist and for the list; neither route is called.
    expect(new Set(f.calls.map((call) => call.path))).toEqual(
      new Set(["/api/v1/agent/contract"]),
    );
  });
  test("an account list that hides credential fields never echoes them", async () => {
    const f = fixture();
    const before = f.configBytes();
    f.state.accounts = [
      slot({
        accessToken: "hidden-provider-token",
        enrolledEmail: "hidden@example.invalid",
      }),
    ];
    const result = await f.adapter.check(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(f.configBytes()).toEqual(before);
  });
  test.each(["person", "account", "origin", "role"])(
    "a login that changed (%s) before the read is refused",
    async (dimension) => {
      const f = fixture();
      switchConfig(f.home, dimension);
      if (dimension === "role") {
        // The role is the member's own; the account list stays readable.
        expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("done");
        return;
      }
      expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
        "account_identity_unverified",
      );
    },
  );
});

describe("an account that cannot take work does not count", () => {
  test.each([
    { declaredState: "inactive" },
    { needsCredential: true },
    { walled: true },
    { quarantined: true },
    { revokedAtMs: 0 },
    { renewalStatus: "canceled", accessEndsAtMs: now - 1, provider: "codex" },
    { accessEndsAtMs: now },
  ])("excluded account %# waits with a plain reason", async (change) => {
    const f = fixture();
    f.state.accounts = [slot(change)];
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "ai_account_not_usable",
    });
    expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
      "ai_account_not_usable",
    );
    expect(f.posts()).toEqual([]);
  });
  test("no accounts at all asks for one to be added", async () => {
    const f = fixture();
    f.state.accounts = [];
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
    });
  });
  test.each([
    { renewalStatus: "unknown" },
    { revokedAtMs: "0" },
    { accessEndsAtMs: "tomorrow" },
    { declaredState: "disabled" },
  ])("malformed metadata %# refuses the list", async (change) => {
    const f = fixture();
    f.state.accounts = [slot(change)];
    expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
      "account_inventory_unverified",
    );
  });
  test.each(["duplicate", "over-limit", "future", "stale"])(
    "%s list cannot finish the step",
    async (kind) => {
      const f = fixture();
      if (kind === "duplicate") f.state.accounts = [slot(), slot()];
      if (kind === "over-limit")
        f.state.accounts = Array.from({ length: 1001 }, (_, index) =>
          slot({ accountSlot: `claude-${index}` }),
        );
      if (kind === "future") f.state.observedAtMs = now + 5001;
      if (kind === "stale") f.state.observedAtMs = now - 30001;
      expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
        "account_inventory_unverified",
      );
    },
  );
});

describe("an interactive owner waits for a usable account", () => {
  test("empty accounts wait for one to be added, then finish", async () => {
    const f = fixture();
    f.state.accounts = [];
    let polls = 0;
    const adapter = onboardAccountsAdapter({
      waitForAccount: (work) => work(),
      sleep: async () => {
        polls++;
        f.state.accounts = [slot({ provider: "codex" })];
      },
    });
    expect(await adapter.check(f.ctx, f.journal)).toEqual({ state: "pending" });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: "codex" },
    });
    expect(polls).toBe(1);
  });
  test("an unusable account is waited on too, until it is fixed", async () => {
    const f = fixture();
    f.state.accounts = [slot({ walled: true })];
    const adapter = onboardAccountsAdapter({
      waitForAccount: (work) => work(),
      sleep: async () => {
        f.state.accounts = [slot()];
      },
    });
    expect(await adapter.check(f.ctx, f.journal)).toEqual({ state: "pending" });
    expect((await adapter.act!(f.ctx, f.journal)).state).toBe("done");
  });
  test("the wait has a hard deadline and names what is missing", async () => {
    const f = fixture();
    f.state.accounts = [];
    const adapter = onboardAccountsAdapter({
      waitForAccount: (work) => work(),
      accountWaitMs: 20,
      sleep: () => new Promise(() => {}),
    });
    expect(await adapter.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
    });
    f.state.accounts = [slot({ walled: true })];
    expect(await adapter.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "ai_account_not_usable",
    });
  });
  test("interrupting the wait stops it", async () => {
    const f = fixture();
    f.state.accounts = [];
    const stop = new AbortController();
    const adapter = onboardAccountsAdapter({
      waitForAccount: (work) => work(),
      sleep: async () => {
        stop.abort();
      },
    });
    expect(await adapter.act!(f.ctx, f.journal, stop.signal)).toMatchObject({
      state: "waiting",
      reason: "interrupted",
    });
  });
  test("a member never waits: adding an account is an admin's", async () => {
    const f = fixture();
    switchConfig(f.home, "role");
    f.state.accounts = [];
    const adapter = onboardAccountsAdapter({
      waitForAccount: () => {
        throw new Error("must not wait");
      },
    });
    expect(await adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
    });
  });
});

describe("--coding-account pins the account setup checks (CTC-4633)", () => {
  const pinned = (f: ReturnType<typeof fixture>, slotName: string) => {
    const adapter = createOnboardRuntime(
      parseArgs(["onboard", "--yes", "--coding-account", slotName]),
      f.ctx,
      {
        login: async () => {
          throw new Error("Unexpected login in accounts fixture");
        },
        ready: async () => ({ state: "waiting", reason: "fixture_unverified" }),
      },
    ).adapters?.accounts;
    if (!adapter?.act) throw new Error("Real accounts runtime adapter missing");
    return adapter;
  };

  test("an account that is not enrolled waits with a named reason", async () => {
    const f = fixture();
    expect(await pinned(f, "claude-absent").check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "coding_account_not_found",
    });
  });

  test("the named account is the one that must be usable", async () => {
    const f = fixture();
    f.state.accounts = [slot({ accountSlot: "claude-a-first" }), slot({ provider: "codex" })];
    expect(await pinned(f, "claude-one").check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: "codex" },
    });
  });

  test.each([
    [{ walled: true }, "coding_account_walled"],
    [{ needsCredential: true }, "coding_account_needs_login"],
    [{ quarantined: true }, "coding_account_quarantined"],
    [{ declaredState: "inactive" }, "coding_account_inactive"],
    [{ revokedAtMs: 0 }, "coding_account_ended"],
    // CTC-6204: a revoked account that is also turned off is ended, never "turn it on".
    [{ revokedAtMs: 0, declaredState: "inactive" }, "coding_account_ended"],
    [{ renewalStatus: "canceled", accessEndsAtMs: now - 1 }, "coding_account_ended"],
  ])("an unusable named account %o names its own cause, not the workspace's", async (change, reason) => {
    const f = fixture();
    f.state.accounts = [slot(), slot({ accountSlot: "claude-two", ...change })];
    expect(await pinned(f, "claude-two").check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason,
    });
    const text = onboardReasonText({ id: "accounts", state: "waiting", reason });
    expect(text).toContain("The AI account named by --coding-account");
    expect(text).not.toContain("No AI account in this workspace");
  });
});
