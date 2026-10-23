import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";
import { parseArgs } from "../src/args.js";
import {
  configPathFor,
  contractPathFor,
  defaultCtx,
  writeConfig,
  type CustomerConfig,
} from "../src/config.js";
import {
  cmdOnboard,
  onboardStatePath,
  onboardLockPath,
  type OnboardIdentity,
  type OnboardJournal,
} from "../src/onboard.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import type { OnboardUi } from "../src/onboard-ui.js";
import { seedReplica } from "./helpers.js";

const homes: string[] = [];
const baseUrl = "https://staging.catalystcloud.dev";
const user = {
  id: "person-a",
  label: "Test Person",
  email: "test@example.com",
  role: "member" as const,
  linearUserId: null,
};
const me = {
  account: "tenant-a",
  slug: "tenant-a",
  name: "Tenant A",
  permissions: null,
  principal: "session" as const,
  user,
};
const supportedPersonalRoutes = [
  "/api/v1/me",
  "/api/v1/agent/contract",
  "/api/v1/me/connections/linear/personal",
  "/connect/linear/personal/start",
  "/api/v1/me/connections/github/personal",
  "/connect/github/personal/start",
];
function supportedContract(paths: readonly string[] = supportedPersonalRoutes) {
  return {
    account: { id: me.account },
    contractVersion: "2.10.0",
    onboarding: {
      schema: 1,
      routes: paths.map((path) => ({
        method: "GET",
        path,
        personalBearer: true,
      })),
      web: {
        connections: "/a/account/connections",
        personalConnections: "/settings/connected-accounts",
      },
    },
  };
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-runtime-"));
  homes.push(home);
  const transcript: string[] = [];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: (s: string) => transcript.push(s),
    stderr: (s: string) => transcript.push(s),
    now: () => new Date("2026-09-30T14:00:00Z"),
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${baseUrl}/api/v1/agent/contract`)
        return Response.json(supportedContract());
      return url === `${baseUrl}/api/v1/me`
        ? Response.json(me)
        : Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch,
  };
  const cfg: CustomerConfig = {
    ...me,
    baseUrl,
    key: "ctc_user_test_fixture",
    joinedAt: "2026-09-30T14:00:00Z",
    lastSkillBundleVersion: "0.14.0",
  };
  const seed = (extra: Partial<CustomerConfig> = {}) =>
    writeConfig(home, { ...cfg, ...extra });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "runtime-fixture",
    installer: null,
    cli: "0.14.0",
    tenant: me.account,
    account: me.account,
    membershipId: user.id,
    baseUrl,
    exit: null,
    steps: [],
    changes: [],
  };
  const hooks = {
    login: async () => 0,
    ready: async () => ({ state: "waiting" as const, reason: "not_ready" }),
    realHome: () => "/a/different/real/home",
  };
  // A supported-server fixture advertises exact routes separately from the
  // endpoint response under test. This keeps route failures from accidentally
  // becoming contract failures, and never enables workspace browser routes.
  const supportedFetch = (
    endpoint: typeof fetch,
    paths: readonly string[] = supportedPersonalRoutes,
  ) => {
    ctx.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${baseUrl}/api/v1/agent/contract`)
        return Response.json(supportedContract(paths));
      return endpoint(input, init);
    }) as typeof fetch;
  };
  return { home, ctx, seed, journal, hooks, transcript, supportedFetch };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function consentUi(): OnboardUi {
  return {
    signal: new AbortController().signal,
    interactive: true,
    message() {},
    stepStart() {},
    stepEnd() {},
    finish() {},
    dispose() {},
    plan() {},
    confirmPlan: async () => ({ proceed: true, localSync: false }),
    wait: async (_text, run) => run(),
  };
}

describe("onboarding production runtime", () => {
  test.each(["yes", "no"])("local-sync-off setup lists writer and cache sizes before one explicit %s", async (answer) => {
    const f = fixture();
    f.seed();
    const plist = join(f.home, "Library", "LaunchAgents", "ai.coalesce.catalyst-replica-sync.plist");
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "existing writer");
    const local = [
      join(f.home, ".config", "catalyst-cloud", "replica.db"),
      join(f.home, ".config", "catalyst-cloud", "replica.db-wal"),
      join(f.home, ".config", "catalyst-cloud", "replica.db.writer.lock"),
      join(f.home, ".local", "state", "catalyst", "events", "tenant-a", "backbone", "cursor.json"),
      join(f.home, ".local", "state", "catalyst", "events", "tenant-a", "backbone", "2026-10-04.jsonl"),
    ];
    for (const path of local) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "local cache bytes");
    }
    const protectedFiles = [configPathFor(f.home), contractPathFor(f.home), join(f.home, ".config", "catalyst", "settings.json")];
    mkdirSync(join(protectedFiles[2], ".."), { recursive: true });
    writeFileSync(protectedFiles[1], "saved contract");
    writeFileSync(protectedFiles[2], "saved settings");
    const before = protectedFiles.map((path) => readFileSync(path, "utf8"));
    let running = true;
    let confirmations = 0;
    const ui = consentUi();
    ui.message = (text) => f.transcript.push(text);
    const args = parseArgs(["onboard", "--only", "legacy"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks, ui, realHome: () => f.home,
      legacy: {
        platform: "darwin", uid: 501, isTty: () => true,
        prompt: async () => {
          confirmations++;
          expect(running).toBe(true);
          for (const path of [plist, ...local]) expect(f.transcript.join("\n")).toContain(path);
          expect(f.transcript.join("\n")).toContain("17 bytes");
          return answer;
        },
        run: () => { running = false; return { status: 0, stdout: "", stderr: "" }; },
      },
    });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(answer === "yes" ? 0 : 11);
    expect(confirmations).toBe(1);
    expect(running).toBe(answer !== "yes");
    for (const path of [plist, ...local]) expect(existsSync(path)).toBe(answer !== "yes");
    expect(protectedFiles.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  test("headless local-sync-off setup without a removal flag reports files and deletes nothing", async () => {
    const f = fixture();
    f.seed();
    const data = join(f.home, ".config", "catalyst-cloud", "replica.db");
    writeFileSync(data, "local cache bytes");
    const args = parseArgs(["onboard", "--headless", "--only", "legacy", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, { ...f.hooks, realHome: () => f.home });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(11);
    expect(readFileSync(data, "utf8")).toBe("local cache bytes");
    expect(f.transcript.join("\n")).toContain(data);
    expect(f.transcript.join("\n")).toContain("17 bytes");
    expect(f.transcript.join("\n")).toContain("--remove-local-data");
  });

  test("setup does not delete a cache file that appeared after its cleanup inventory was approved", async () => {
    const f = fixture();
    f.seed();
    const data = join(f.home, ".config", "catalyst-cloud", "replica.db");
    const newFile = `${data}-wal`;
    writeFileSync(data, "approved local data");
    const ui = consentUi();
    ui.confirmLocalSyncRemoval = async () => {
      writeFileSync(newFile, "not in the approved inventory");
      return true;
    };
    const args = parseArgs(["onboard", "--only", "legacy"]);
    const runtime = createOnboardRuntime(args, f.ctx, { ...f.hooks, ui, realHome: () => f.home });
    await cmdOnboard(args, f.ctx, runtime);
    expect(readFileSync(newFile, "utf8")).toBe("not in the approved inventory");
    expect(existsSync(data)).toBe(false);
  });

  test("headless local-sync-off setup removes listed data only with its explicit removal flag, after stopping the writer", async () => {
    const f = fixture();
    f.seed();
    const data = join(f.home, ".config", "catalyst-cloud", "replica.db");
    writeFileSync(data, "existing local data");
    writeFileSync(`${data}.pid`, "424242");
    let stopped = false;
    const args = parseArgs(["onboard", "--headless", "--only", "legacy", "--remove-local-data", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks, realHome: () => f.home,
      legacy: { stopWriter: async (pid) => {
        expect(pid).toBe(424242);
        expect(readFileSync(data, "utf8")).toBe("existing local data");
        stopped = true;
      } },
    });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    expect(stopped).toBe(true);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(`${data}.pid`)).toBe(false);
  });

  test("local-sync-on setup reuses a fresh existing replica without changing its DB", async () => {
    const f = fixture();
    f.seed();
    const data = await seedReplica(f.home, { cursor: 17, heartbeatAgeMs: 0 });
    const before = readFileSync(data);
    const args = parseArgs(["onboard", "--local-sync", "--only", "daemon", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, { ...f.hooks, realHome: () => f.home });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    expect(readFileSync(data)).toEqual(before);
  });

  test.each([
    ["selected unattended", ["--local-sync", "--yes", "--json"]],
    ["selected in the plan", []],
  ])("setup with local sync %s keeps the running old replica and its data while cleaning other legacy services", async (_selection, flags) => {
    const f = fixture();
    f.seed();
    const jobs = join(f.home, "Library", "LaunchAgents");
    mkdirSync(jobs, { recursive: true });
    const replica = join(jobs, "ai.coalesce.catalyst-replica-sync.plist");
    const other = join(jobs, "com.catalyst.agent.plist");
    writeFileSync(replica, "existing replica service");
    writeFileSync(other, "other legacy service");
    const data = join(f.home, ".config", "catalyst", "replica.db");
    mkdirSync(join(data, ".."), { recursive: true });
    writeFileSync(data, "existing replica data");
    writeFileSync(`${data}-wal`, "uncheckpointed replica data");
    let replicaRunning = true;
    const args = parseArgs(["onboard", "--only", "legacy", ...flags]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: { ...consentUi(), confirmPlan: async () => ({ proceed: true, localSync: true }) },
      realHome: () => f.home,
      legacy: {
        platform: "darwin",
        uid: 501,
        run: (command, argv) => {
          if (
            command === "launchctl" &&
            argv.includes("gui/501/ai.coalesce.catalyst-replica-sync")
          )
            replicaRunning = false;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });

    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);

    expect(replicaRunning).toBe(true);
    expect(readFileSync(replica, "utf8")).toBe("existing replica service");
    expect(readFileSync(data, "utf8")).toBe("existing replica data");
    expect(readFileSync(`${data}-wal`, "utf8")).toBe("uncheckpointed replica data");
    expect(existsSync(other)).toBe(false);
  });

  test("fake HOME reports a legacy service and never stops or removes it", async () => {
    const f = fixture();
    const plist = join(
      f.home,
      "Library",
      "LaunchAgents",
      "com.catalyst.agent.plist",
    );
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "fixture legacy service");
    const touched = join(f.home, "service-was-stopped");
    const runtime = createOnboardRuntime(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      f.ctx,
      {
        ...f.hooks,
        legacy: {
          platform: "darwin",
          run: () => {
            writeFileSync(touched, "unexpected");
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    const adapter = runtime.adapters!.legacy!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "skipped",
      reason: "fake_home_report_only",
    });
    if (adapter.act)
      expect(await adapter.act(f.ctx, f.journal)).toMatchObject({
        state: "skipped",
        reason: "fake_home_report_only",
      });
    expect(readFileSync(plist, "utf8")).toBe("fixture legacy service");
    expect(existsSync(touched)).toBe(false);
  });

  test("personal identity uses live account and user id rather than interpreting user role as a membership id", async () => {
    const f = fixture();
    f.seed();
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    expect(await runtime.identity!()).toMatchObject({
      account: me.account,
      membershipId: user.id,
      baseUrl,
      role: "member",
    });
  });

  test("a fresh successful sign-in is verified and bound in the same run", async () => {
    const f = fixture();
    const args = parseArgs(["onboard", "--only", "signin", "--yes"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      login: async () => {
        f.seed();
        return 0;
      },
    });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(receipt).toMatchObject({
      exit: 0,
      account: me.account,
      membershipId: user.id,
      baseUrl,
    });
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "signin"),
    ).toMatchObject({
      state: "done",
      evidence: { account: me.account, membershipId: user.id },
    });
  });

  test("receipt identity mismatch refuses before attempting an expired OAuth refresh", async () => {
    const f = fixture();
    f.seed({
      key: undefined,
      auth: {
        kind: "oauth",
        accessToken: "expired-fixture",
        refreshToken: "refresh-fixture",
        expiresAt: "2026-09-30T13:00:00Z",
        sessionId: "session-fixture",
      },
    });
    const before = readFileSync(configPathFor(f.home), "utf8");
    const fetched = join(f.home, "network-was-used");
    f.ctx.fetch = (async () => {
      writeFileSync(fetched, "unexpected");
      return Response.json({});
    }) as typeof fetch;
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    const journal = {
      ...f.journal,
      account: "another-tenant",
      tenant: "another-tenant",
      membershipId: user.id,
      baseUrl,
    };
    await expect(runtime.identity!(journal)).rejects.toMatchObject({
      exitCode: 12,
    });
    expect(existsSync(fetched)).toBe(false);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
  });

  test("main refuses a mismatched receipt before automatic config or skills repair", async () => {
    const f = fixture();
    const skillsDir = join(f.home, "skills");
    mkdirSync(join(skillsDir, "ask"), { recursive: true });
    const skill = join(skillsDir, "ask", "SKILL.md");
    writeFileSync(skill, "fixture skill to preserve");
    f.seed({
      cliPath: join(f.home, "old-package", "bin", "catalyst-skills.js"),
      lastSkillBundleVersion: "0.1.0",
      skillsDir,
    });
    const before = readFileSync(configPathFor(f.home), "utf8");
    const path = onboardStatePath(f.home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ...f.journal,
        account: "another-tenant",
        tenant: "another-tenant",
      }),
    );
    expect(await main(["onboard", "--only", "legacy", "--yes"], f.ctx)).toBe(
      12,
    );
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    expect(readFileSync(skill, "utf8")).toBe("fixture skill to preserve");
  });

  test("fresh onboarding refuses an account token before saving host credentials", async () => {
    const f = fixture();
    const token = "ctc_account_private_fixture";
    f.ctx.env.CATALYST_CLOUD_TOKEN = token;
    f.ctx.fetch = (async () =>
      Response.json({
        ...me,
        principal: "service",
        user: undefined,
      })) as typeof fetch;
    expect(await main(["onboard", "--only", "signin", "--yes"], f.ctx)).toBe(
      12,
    );
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(f.transcript.join("\n")).not.toContain(token);
  });

  test("an account credential never becomes a member identity", async () => {
    const f = fixture();
    f.seed({
      key: "ctc_account_fixture",
      principal: "service",
      user: undefined,
    });
    f.ctx.fetch = (async () =>
      Response.json({
        ...me,
        principal: "service",
        user: undefined,
      })) as typeof fetch;
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    let identity: unknown = null;
    try {
      identity = await runtime.identity!();
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(12);
    }
    expect(identity).toBeNull();
  });

  test("base URL mismatch refuses before writing a receipt or changing login config", async () => {
    const f = fixture();
    f.seed();
    const before = readFileSync(configPathFor(f.home), "utf8");
    const args = parseArgs([
      "onboard",
      "--yes",
      "--base-url",
      "https://other.example.com",
    ]);
    let code: number;
    try {
      code = await cmdOnboard(
        args,
        f.ctx,
        createOnboardRuntime(args, f.ctx, f.hooks),
      );
    } catch (error) {
      code = (error as { exitCode: number }).exitCode;
    }
    expect(code).toBe(12);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("signin check validates the saved personal user against the live me endpoint", async () => {
    const f = fixture();
    f.seed();
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    expect(
      await runtime.adapters!.signin!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "done" });
    f.ctx.fetch = (async () =>
      Response.json({
        ...me,
        user: { ...user, id: "another-person" },
      })) as typeof fetch;
    let state: string;
    try {
      state = (await runtime.adapters!.signin!.check(f.ctx, f.journal)).state;
    } catch (error) {
      expect((error as { exitCode: number }).exitCode).toBe(12);
      state = "refused";
    }
    expect(state).toBe("refused");
  });

  test("an old server without onboarding advertisement waits with a public fallback and never calls unsupported workspace routes", async () => {
    const f = fixture();
    f.seed({ user: { ...user, role: "owner" } });
    // A stale disk contract and catchall 403 must not establish support.
    writeFileSync(
      contractPathFor(f.home),
      JSON.stringify({
        schema: 1,
        routes: ["/connect/linear", "/connect/github"],
      }),
    );
    const requests: string[] = [];
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      if (url === `${baseUrl}/api/v1/agent/contract`)
        return Response.json({
          account: { id: me.account },
          contractVersion: "2.10.0",
        });
      // This models the deployed catchall that previously became false consent refusal.
      return Response.json({ error: "forbidden" }, { status: 403 });
    }) as typeof fetch;
    const runtime = createOnboardRuntime(
      parseArgs(["onboard", "--json"]),
      f.ctx,
      f.hooks,
    );
    for (const id of ["linear.workspace", "github.install"] as const) {
      const adapter = runtime.adapters![id]!;
      const expected = {
        state: "waiting",
        reason: "cloud_capability_unavailable",
        evidence: { path: `${baseUrl}/a/account/connections` },
      };
      expect(await adapter.check(f.ctx, f.journal)).toEqual(expected);
      expect(await adapter.act!(f.ctx, f.journal)).toEqual(expected);
    }
    expect(requests).toEqual(Array(4).fill(`${baseUrl}/api/v1/agent/contract`));
    expect(f.transcript.join("\n")).toContain(
      "not available on this server yet",
    );
    expect(f.transcript.join("\n")).toContain(
      `${baseUrl}/a/account/connections`,
    );
    expect(f.transcript.join("\n")).not.toContain("consent_refused");
    expect(f.transcript.join("\n")).not.toContain("consent refused");
  });

  test.each([
    {
      account: undefined,
      tenant: null,
      membershipId: undefined,
      baseUrl: undefined,
    },
    { account: "foreign-account" },
    { membershipId: "foreign-person" },
    { baseUrl: "https://foreign.invalid" },
  ])(
    "an unbound or foreign remote-step receipt makes zero requests %#",
    async (binding) => {
      const f = fixture();
      f.seed();
      const requests: string[] = [];
      f.ctx.fetch = (async (input) => {
        requests.push(String(input));
        return Response.json(supportedContract());
      }) as typeof fetch;
      const runtime = createOnboardRuntime(
        parseArgs(["onboard"]),
        f.ctx,
        f.hooks,
      );
      expect(
        await runtime.adapters!["linear.personal"]!.check(f.ctx, {
          ...f.journal,
          ...binding,
        }),
      ).toMatchObject({
        state: "waiting",
        reason: "onboarding_capability_identity_unverified",
      });
      expect(requests).toEqual([]);
    },
  );

  test("personal Linear consent opens the signed Catalyst handoff and polls usable status with an interactive UI", async () => {
    const f = fixture();
    f.seed();
    const browser = join(f.home, "opened-url");
    const grant = join(f.home, "linear-granted");
    const url = `${baseUrl}/connect/linear/personal/start?handoff=signed-fixture`;
    f.supportedFetch((async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ctc_user_test_fixture",
      );
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me/connections/linear/personal")
        return Response.json({ connected: existsSync(grant) });
      if (path === "/connect/linear/personal/start")
        return Response.json({
          authorizationUrl: url,
          expiresAt: f.ctx.now().getTime() + 60_000,
        });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (opened) => {
        writeFileSync(browser, opened);
        writeFileSync(grant, "connected");
      },
      sleep: async () => {},
    });
    const adapter = runtime.adapters!["linear.personal"]!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "pending",
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "done",
    });
    expect(readFileSync(browser, "utf8")).toBe(url);
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
    });
    expect(f.transcript.join("\n")).not.toContain("ctc_user_test_fixture");
  });

  test("an already usable personal grant is verified without a new consent", async () => {
    const f = fixture();
    f.seed();
    const unexpected = join(f.home, "unexpected-start-or-browser");
    f.supportedFetch((async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/api/v1/me/connections/linear/personal"))
        return Response.json({ connected: true });
      writeFileSync(unexpected, String(input));
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => writeFileSync(unexpected, url),
    });
    expect(
      await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "done" });
    expect(existsSync(unexpected)).toBe(false);
  });

  test.each([
    [403, { connected: false }, "refused", "personal_consent_refused"],
    [503, { error: "unavailable" }, "waiting", "personal_status_unavailable"],
    [200, { connected: "yes" }, "failed", "personal_status_shape"],
  ] as const)(
    "personal status %s preserves refusal, unavailable and malformed outcomes",
    async (status, body, state, reason) => {
      const f = fixture();
      f.seed();
      f.supportedFetch((async () =>
        Response.json(body, { status })) as typeof fetch);
      const runtime = createOnboardRuntime(
        parseArgs(["onboard"]),
        f.ctx,
        f.hooks,
      );
      expect(
        await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal),
      ).toMatchObject({ state, reason });
    },
  );

  test("a handoff to another origin is refused without opening the browser", async () => {
    const f = fixture();
    f.seed();
    const opened = join(f.home, "unsafe-browser-opened");
    f.supportedFetch((async (input) =>
      String(input).endsWith("/personal/start")
        ? Response.json({
            authorizationUrl: "https://unrelated.example/consent",
            expiresAt: f.ctx.now().getTime() + 60_000,
          })
        : Response.json({ connected: false })) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => writeFileSync(opened, url),
    });
    expect(
      await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "refused", reason: "personal_consent_handoff" });
    expect(existsSync(opened)).toBe(false);
  });

  test("workspace prerequisite refusal leaves personal consent waiting without opening a browser", async () => {
    const f = fixture();
    f.seed();
    const opened = join(f.home, "premature-browser-opened");
    f.supportedFetch((async (input) =>
      String(input).endsWith("/personal/start")
        ? Response.json({ error: "linear_workspace_required" }, { status: 409 })
        : Response.json({ connected: false })) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => writeFileSync(opened, url),
    });
    expect(
      await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "waiting", reason: "linear_workspace_required" });
    expect(existsSync(opened)).toBe(false);
  });

  test("real-home legacy service cleanup retains data and suppresses raw provider output", async () => {
    const f = fixture();
    const plist = join(
      f.home,
      "Library",
      "LaunchAgents",
      "com.catalyst.agent.plist",
    );
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "legacy service");
    const data = join(f.home, ".catalyst", "kept-data");
    mkdirSync(join(data, ".."), { recursive: true });
    writeFileSync(data, "retain this data");
    const service = join(f.home, "stopped-service");
    const secret = "raw-provider-fixture-secret";
    const runtime = createOnboardRuntime(
      parseArgs(["onboard", "--yes", "--json"]),
      f.ctx,
      {
        ...f.hooks,
        realHome: () => f.home,
        legacy: {
          platform: "darwin",
          uid: 501,
          run: (command, argv) => {
            writeFileSync(service, JSON.stringify({ command, argv }));
            return { status: 0, stdout: secret, stderr: secret };
          },
        },
      },
    );
    const adapter = runtime.adapters!.legacy!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "pending",
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "done",
    });
    expect(JSON.parse(readFileSync(service, "utf8"))).toEqual({
      command: "launchctl",
      argv: ["bootout", "gui/501/com.catalyst.agent"],
    });
    expect(existsSync(plist)).toBe(false);
    expect(readFileSync(data, "utf8")).toBe("retain this data");
    expect(f.transcript.join("\n")).not.toContain(secret);
  });

  test.each([
    [401, {}, "refused", "personal_consent_refused"],
    [500, {}, "failed", "personal_consent_start_failed"],
    [
      200,
      { authorizationUrl: null, expiresAt: 1 },
      "refused",
      "personal_consent_handoff",
    ],
    [
      200,
      { authorizationUrl: "not-a-url", expiresAt: 1 },
      "refused",
      "personal_consent_handoff",
    ],
    [
      200,
      {
        authorizationUrl: "http://staging.catalystcloud.dev/consent",
        expiresAt: 1,
      },
      "refused",
      "personal_consent_handoff",
    ],
    [
      200,
      {
        authorizationUrl: "https://user:pass@staging.catalystcloud.dev/consent",
        expiresAt: 1,
      },
      "refused",
      "personal_consent_handoff",
    ],
  ] as const)(
    "unsafe or refused personal handoff %s never opens a browser",
    async (status, body, state, reason) => {
      const f = fixture();
      f.seed();
      const opened = join(f.home, "unexpected-browser");
      f.supportedFetch((async (input) =>
        String(input).endsWith("/personal/start")
          ? Response.json(body, { status })
          : Response.json({ connected: false })) as typeof fetch);
      const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
        ...f.hooks,
        ui: consentUi(),
        openBrowser: (url) => writeFileSync(opened, url),
      });
      expect(
        await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal),
      ).toMatchObject({ state, reason });
      expect(existsSync(opened)).toBe(false);
    },
  );

  test("personal consent without login waits for a personal sign-in before status or start", async () => {
    const f = fixture();
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    const adapter = runtime.adapters!["linear.personal"]!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "personal_login_required",
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "personal_login_required",
    });
  });

  test("a lapsed personal connection is not reported usable", async () => {
    const f = fixture();
    f.seed();
    f.supportedFetch((async () =>
      Response.json({ connected: false, reason: "lapsed" })) as typeof fetch);
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    expect(
      await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "pending" });
  });

  test.each([
    null,
    {},
    { connected: false },
    { error: "provider_problem" },
  ] as const)(
    "status response distinguishes absent from malformed evidence %#",
    async (body) => {
      const f = fixture();
      f.seed();
      f.supportedFetch((async () => Response.json(body)) as typeof fetch);
      const runtime = createOnboardRuntime(
        parseArgs(["onboard"]),
        f.ctx,
        f.hooks,
      );
      const result = await runtime.adapters!["linear.personal"]!.check(
        f.ctx,
        f.journal,
      );
      expect(result.state).toBe(
        body && "connected" in body ? "pending" : "failed",
      );
    },
  );

  test("skills verification remains pending until every selected skill exists", async () => {
    const f = fixture();
    const skillsDir = join(f.home, "skills");
    f.ctx.env.CATALYST_SKILLS_DIR = skillsDir;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      skillNames: ["ask", "research"],
    });
    const adapter = runtime.adapters!.skills!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "skills_install_unverified",
    });
    for (const name of ["ask", "research"]) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `fixture ${name}`);
    }
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { count: 2, path: skillsDir },
    });
  });

  test("failed legacy service removal retains its plist and hides raw command errors", async () => {
    const f = fixture();
    const plist = join(
      f.home,
      "Library",
      "LaunchAgents",
      "com.catalyst.agent.plist",
    );
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "legacy service");
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      realHome: () => f.home,
      legacy: {
        platform: "darwin",
        run: () => ({
          status: 1,
          stdout: "fixture-private-secret",
          stderr: "fixture-private-secret",
        }),
      },
    });
    expect(
      await runtime.adapters!.legacy!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "failed", reason: "legacy_cleanup_failed" });
    expect(existsSync(plist)).toBe(true);
    expect(f.transcript.join("\n")).not.toContain("fixture-private-secret");
  });

  test("member personal GitHub onboarding works without administering the workspace installation", async () => {
    const f = fixture();
    f.seed();
    const opened = join(f.home, "github-browser");
    const grant = join(f.home, "github-personal-granted");
    const handoff = `${baseUrl}/connect/github/personal/start?handoff=signed-github-fixture`;
    f.supportedFetch((async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ctc_user_test_fixture",
      );
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me") return Response.json(me);
      if (path === "/api/v1/me/connections/github/personal")
        return Response.json({
          connected: existsSync(grant),
          githubLogin: "fixture-person",
        });
      if (path === "/connect/github/personal/start")
        return Response.json({
          authorizationUrl: handoff,
          expiresAt: f.ctx.now().getTime() + 60000,
        });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch);
    const args = parseArgs(["onboard", "--only", "github.personal"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => {
        writeFileSync(opened, url);
        writeFileSync(grant, "connected");
      },
      sleep: async () => {},
    });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    expect(readFileSync(opened, "utf8")).toBe(handoff);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      receipt.steps.find(
        (step: { id: string }) => step.id === "github.personal",
      ),
    ).toMatchObject({ state: "done" });
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "github.install")
        .state,
    ).not.toBe("done");
  });

  test.each([
    [200, { connected: false, reason: "lapsed" }, "pending"],
    [200, { connected: true, githubLogin: "fixture-person" }, "done"],
    [403, { error: "forbidden" }, "refused"],
    [503, { error: "github_grant_check_unavailable" }, "waiting"],
  ] as const)(
    "personal GitHub status %s remains distinct from workspace installation",
    async (status, body, state) => {
      const f = fixture();
      f.seed();
      f.supportedFetch((async () =>
        Response.json(body, { status })) as typeof fetch);
      const runtime = createOnboardRuntime(
        parseArgs(["onboard"]),
        f.ctx,
        f.hooks,
      );
      expect(
        await runtime.adapters!["github.personal"]!.check(f.ctx, f.journal),
      ).toMatchObject({ state });
      expect(
        await runtime.adapters!["github.install"]!.check(f.ctx, f.journal),
      ).toMatchObject({ state: "waiting" });
    },
  );

  test("personal GitHub handoff refuses another origin before opening a browser", async () => {
    const f = fixture();
    f.seed();
    const opened = join(f.home, "unsafe-github-browser");
    f.supportedFetch((async (input) =>
      String(input).endsWith("/personal/start")
        ? Response.json({
            authorizationUrl: "https://unrelated.example/consent",
            expiresAt: f.ctx.now().getTime() + 60000,
          })
        : Response.json({ connected: false })) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => writeFileSync(opened, url),
    });
    expect(
      await runtime.adapters!["github.personal"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "refused" });
    expect(existsSync(opened)).toBe(false);
  });

  test("personal GitHub status server failure cannot become a pending consent or expose its error body", async () => {
    const f = fixture();
    f.seed();
    const secret = "private-github-provider-error";
    f.supportedFetch((async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/api/v1/me")
        ? Response.json(me)
        : Response.json({ error: secret }, { status: 500 })) as typeof fetch);
    const args = parseArgs([
      "onboard",
      "--only",
      "github.personal",
      "--yes",
      "--json",
    ]);
    const runtime = createOnboardRuntime(args, f.ctx, f.hooks);
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(10);
    const stored = readFileSync(onboardStatePath(f.home), "utf8");
    const receipt = JSON.parse(stored);
    expect(
      receipt.steps.find(
        (step: { id: string }) => step.id === "github.personal",
      ),
    ).toMatchObject({ state: "failed", reason: "personal_status_failed" });
    expect(stored).not.toContain(secret);
    expect(f.transcript.join("\n")).not.toContain(secret);
  });

  test("nonboolean GitHub connected status is invalid evidence rather than consent completion", async () => {
    const f = fixture();
    f.seed();
    f.supportedFetch((async () =>
      Response.json({ connected: 1 })) as typeof fetch);
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    expect(
      await runtime.adapters!["github.personal"]!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "failed", reason: "personal_status_shape" });
  });

  test.each([
    [409, "failed", "personal_consent_start_failed"],
    [500, "failed", "personal_consent_start_failed"],
  ] as const)(
    "GitHub start %s does not open a browser or claim connection",
    async (status, state, reason) => {
      const f = fixture();
      f.seed();
      const opened = join(f.home, "github-start-error-browser");
      const secret = "private-github-start-error";
      f.supportedFetch((async (input) =>
        String(input).endsWith("/personal/start")
          ? Response.json({ error: secret }, { status })
          : Response.json({ connected: false })) as typeof fetch);
      const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
        ...f.hooks,
        ui: consentUi(),
        openBrowser: (url) => writeFileSync(opened, url),
      });
      expect(
        await runtime.adapters!["github.personal"]!.act!(f.ctx, f.journal),
      ).toMatchObject({ state, reason });
      expect(existsSync(opened)).toBe(false);
      expect(f.transcript.join("\n")).not.toContain(secret);
    },
  );

  test("retryable Linear status outage during consent can recover without another browser opening", async () => {
    const f = fixture();
    f.seed();
    const recovered = join(f.home, "linear-status-recovered");
    const opened = join(f.home, "linear-recovery-browser");
    const handoff = `${baseUrl}/connect/linear/personal/start?handoff=recovery-fixture`;
    f.supportedFetch((async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/connect/linear/personal/start"))
        return Response.json({
          authorizationUrl: handoff,
          expiresAt: f.ctx.now().getTime() + 60000,
        });
      if (!existsSync(opened)) return Response.json({ connected: false });
      return existsSync(recovered)
        ? Response.json({ connected: true })
        : Response.json(
            { error: "linear_grant_check_unavailable" },
            { status: 503 },
          );
    }) as typeof fetch);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: consentUi(),
      openBrowser: (url) => writeFileSync(opened, url),
      sleep: async () => {
        writeFileSync(recovered, "usable");
      },
    });
    expect(
      await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal),
    ).toMatchObject({ state: "done" });
    expect(readFileSync(opened, "utf8")).toBe(handoff);
    expect(existsSync(recovered)).toBe(true);
  });

  test("explicit local sync cannot be silently skipped on the first run", async () => {
    const f = fixture();
    const runtime = createOnboardRuntime(
      parseArgs(["onboard", "--local-sync"]),
      f.ctx,
      f.hooks,
    );
    expect(
      await runtime.adapters!.daemon!.check(f.ctx, f.journal),
    ).toMatchObject({
      state: "waiting",
      reason: "local_sync_capability_unavailable",
    });
  });

  test("saved local sync consent still requires verification when its flag is omitted on resume", async () => {
    const f = fixture();
    const runtime = createOnboardRuntime(
      parseArgs(["onboard"]),
      f.ctx,
      f.hooks,
    );
    expect(
      await runtime.adapters!.daemon!.check(f.ctx, {
        ...f.journal,
        localSync: true,
      }),
    ).toMatchObject({
      state: "waiting",
      reason: "local_sync_capability_unavailable",
    });
  });

  test("skills verification honors the directory recorded by the login when no override is supplied", async () => {
    const f = fixture();
    const skillsDir = join(f.home, "recorded-skills");
    f.seed({ skillsDir });
    mkdirSync(join(skillsDir, "ask"), { recursive: true });
    writeFileSync(join(skillsDir, "ask", "SKILL.md"), "fixture installed ask");
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      skillNames: ["ask"],
    });
    expect(
      await runtime.adapters!.skills!.check(f.ctx, f.journal),
    ).toMatchObject({ state: "done", evidence: { path: skillsDir, count: 1 } });
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred not initialized");
  };
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function previewUi(proceed = false) {
  const controller = new AbortController();
  const identities: Array<OnboardIdentity | null | undefined> = [];
  const events: string[] = [];
  const messages: string[] = [];
  const ui: OnboardUi = {
    signal: controller.signal,
    plan: (_journal, identity) => {
      identities.push(identity);
      events.push("plan");
    },
    confirmPlan: async (localSync) => {
      events.push("Q1");
      return { proceed, localSync };
    },
    stepStart: (id) => {
      events.push(`start:${id}`);
    },
    stepEnd: (step) => {
      events.push(`end:${step.id}`);
    },
    message: (text) => {
      messages.push(text);
    },
    finish: () => {
      events.push("finish");
    },
    wait: async (_text, work) => work(),
    dispose: () => controller.abort(),
  };
  return { ui, controller, identities, events, messages };
}

function seedPreviewReceipt(
  f: ReturnType<typeof fixture>,
  extra: Partial<OnboardJournal> = {},
) {
  const path = onboardStatePath(f.home);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...f.journal,
        account: me.account,
        tenant: me.account,
        membershipId: user.id,
        baseUrl,
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
  return readFileSync(path);
}

function previewOauth(expiresAt: string) {
  return {
    kind: "oauth" as const,
    accessToken: "preview-access-fixture",
    refreshToken: "preview-refresh-fixture",
    expiresAt,
    sessionId: "preview-session-fixture",
  };
}

describe("Q1 live identity preview", () => {
  test("current me display and role replace stale saved labels before Q1, and Stop preserves both files", async () => {
    const f = fixture();
    f.seed({
      name: "Stale Workspace",
      slug: "stale-slug",
      user: {
        ...user,
        label: "Stale Person",
        email: "stale@example.com",
        role: "owner",
      },
      key: undefined,
      auth: previewOauth("2026-09-30T14:00:45Z"),
    });
    const configBefore = readFileSync(configPathFor(f.home));
    const receiptBefore = seedPreviewReceipt(f);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    f.ctx.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(me);
    }) as typeof fetch;
    const screen = previewUi();
    const args = parseArgs(["onboard"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: screen.ui,
    });
    expect(
      await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
    ).toBe(0);
    expect(screen.identities).toEqual([
      expect.objectContaining({
        role: "member",
        display: {
          personLabel: user.label,
          email: user.email,
          workspaceName: me.name,
          workspaceSlug: me.slug,
        },
      }),
    ]);
    expect(screen.events).toEqual(["plan", "Q1"]);
    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/api/v1/me`,
    ]);
    expect(requests[0]!.init).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer preview-access-fixture" },
    });
    expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
    expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
    expect(existsSync(contractPathFor(f.home))).toBe(false);
  });

  test.each(["2026-09-30T14:00:30Z", "2026-09-30T13:59:59Z", "invalid-expiry"])(
    "a saved OAuth token at %s waits for explicit renewal without discovery or refresh IO",
    async (expiresAt) => {
      const f = fixture();
      f.seed({ key: undefined, auth: previewOauth(expiresAt) });
      const configBefore = readFileSync(configPathFor(f.home));
      const receiptBefore = seedPreviewReceipt(f);
      const fetch = vi.fn(async () => Response.json(me));
      f.ctx.fetch = fetch;
      const screen = previewUi();
      const args = parseArgs(["onboard"]);
      const runtime = createOnboardRuntime(args, f.ctx, {
        ...f.hooks,
        ui: screen.ui,
      });
      expect(
        await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
      ).toBe(11);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.events).toEqual([]);
      expect(f.transcript.join("\n")).toContain(
        "Renew your login with catalyst login",
      );
      expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
      expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );

  test("expiry during Q1 waits with the supported renewal command and never refreshes saved credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T14:00:00Z"));
    const f = fixture();
    f.ctx.now = () => new Date();
    f.seed({ key: undefined, auth: previewOauth("2026-09-30T14:00:45Z") });
    const configBefore = readFileSync(configPathFor(f.home));
    seedPreviewReceipt(f);
    const requests: string[] = [];
    f.ctx.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json(me);
    }) as typeof fetch;
    const screen = previewUi(true);
    screen.ui.confirmPlan = async (localSync) => {
      screen.events.push("Q1");
      await vi.advanceTimersByTimeAsync(16_000);
      return { proceed: true, localSync };
    };
    const args = parseArgs(["onboard", "--only", "signin"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: screen.ui,
    });
    expect(
      await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
    ).toBe(11);
    expect(screen.identities[0]).toMatchObject({
      display: { personLabel: user.label },
    });
    expect(requests).toEqual([`${baseUrl}/api/v1/me`]);
    expect(screen.messages.join("\n")).toContain(
      "Renew your login with catalyst login, then run catalyst onboard",
    );
    expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(receipt).toMatchObject({ exit: 11, complete: false });
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "signin"),
    ).toMatchObject({
      state: "waiting",
      reason: "onboard_login_refresh_required",
    });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("a first run has no fabricated person before Q1 and stopping makes no login or receipt", async () => {
    const f = fixture();
    const fetch = vi.fn(async () => Response.json(me));
    const login = vi.fn(async () => 0);
    f.ctx.fetch = fetch;
    const screen = previewUi();
    const args = parseArgs(["onboard"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      login,
      ui: screen.ui,
    });
    expect(
      await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
    ).toBe(0);
    expect(screen.identities).toEqual([null]);
    expect(screen.events).toEqual(["plan", "Q1"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test.each([
    { account: "foreign-account", tenant: "foreign-account" },
    { membershipId: "foreign-person" },
    { baseUrl: "https://another-cloud.example.com" },
  ])(
    "foreign receipt binding %j still refuses before any network request or Q1",
    async (binding) => {
      const f = fixture();
      f.seed();
      const configBefore = readFileSync(configPathFor(f.home));
      const receiptBefore = seedPreviewReceipt(f, binding);
      const fetch = vi.fn(async () => Response.json(me));
      f.ctx.fetch = fetch;
      const screen = previewUi();
      const args = parseArgs(["onboard"]);
      const runtime = createOnboardRuntime(args, f.ctx, {
        ...f.hooks,
        ui: screen.ui,
      });
      expect(
        await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
      ).toBe(12);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.events).toEqual([]);
      expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
      expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
    },
  );

  test("a newer saved person while me is pending rejects the old result and preserves that login", async () => {
    const f = fixture();
    f.seed();
    const receiptBefore = seedPreviewReceipt(f);
    const response = deferred<Response>();
    const fetch = vi.fn(async () => response.promise);
    f.ctx.fetch = fetch;
    const screen = previewUi();
    const args = parseArgs(["onboard"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: screen.ui,
    });
    const run = cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    f.seed({ key: "new-login-fixture", user: { ...user, id: "new-person" } });
    const newConfig = readFileSync(configPathFor(f.home));
    response.resolve(Response.json(me));
    expect(await run).toBe(12);
    expect(screen.events).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(newConfig);
    expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
  });

  test.each(["headers", "body"] as const)(
    "the owned 30-second budget bounds stalled %s and ignores its late result",
    async (phase) => {
      vi.useFakeTimers();
      const f = fixture();
      f.seed();
      const configBefore = readFileSync(configPathFor(f.home));
      const receiptBefore = seedPreviewReceipt(f);
      const headers = deferred<Response>();
      const body = deferred<unknown>();
      const response = Response.json(me);
      if (phase === "body")
        vi.spyOn(response, "json").mockReturnValue(body.promise);
      let requestSignal: AbortSignal | null | undefined;
      const fetch = vi.fn(
        async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          requestSignal = init?.signal;
          return phase === "headers" ? headers.promise : response;
        },
      );
      f.ctx.fetch = fetch;
      const screen = previewUi();
      const args = parseArgs(["onboard"]);
      const runtime = createOnboardRuntime(args, f.ctx, {
        ...f.hooks,
        ui: screen.ui,
      });
      const run = cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false });
      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      expect(screen.events).toEqual([]);
      expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toBe(11);
      expect(requestSignal?.aborted).toBe(true);
      expect(screen.events).toEqual([]);
      headers.resolve(response);
      body.resolve(me);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(screen.events).toEqual([]);
      expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
      expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );

  test("an already-cancelled preview does no network IO and preserves saved state", async () => {
    const f = fixture();
    f.seed();
    const configBefore = readFileSync(configPathFor(f.home));
    const receiptBefore = seedPreviewReceipt(f);
    const fetch = vi.fn(async () => Response.json(me));
    f.ctx.fetch = fetch;
    const screen = previewUi();
    screen.controller.abort();
    const args = parseArgs(["onboard"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: screen.ui,
    });
    expect(
      await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
    ).toBe(11);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.events).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
    expect(readFileSync(onboardStatePath(f.home))).toEqual(receiptBefore);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("cancelling a pending body aborts the request and never renders late identity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.seed();
    const configBefore = readFileSync(configPathFor(f.home));
    const body = deferred<unknown>();
    const response = Response.json(me);
    const bodyStarted = deferred<void>();
    const json = vi.spyOn(response, "json").mockImplementation(() => {
      bodyStarted.resolve(undefined);
      return body.promise;
    });
    let requestSignal: AbortSignal | null | undefined;
    f.ctx.fetch = (async (_input, init) => {
      requestSignal = init?.signal;
      return response;
    }) as typeof fetch;
    const screen = previewUi();
    const args = parseArgs(["onboard"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      ui: screen.ui,
    });
    const run = cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false });
    await bodyStarted.promise;
    expect(json).toHaveBeenCalledTimes(1);
    screen.controller.abort();
    expect(await run).toBe(11);
    expect(requestSignal?.aborted).toBe(true);
    body.resolve(me);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.events).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(configBefore);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("first sign-in and a JSON recheck render live identity only outside the single receipt object", async () => {
    const f = fixture();
    const out: string[] = [];
    const err: string[] = [];
    f.ctx.stdout = (line) => out.push(line);
    f.ctx.stderr = (line) => err.push(line);
    const args = parseArgs(["onboard", "--only", "signin", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, {
      ...f.hooks,
      login: async () => {
        f.seed();
        return 0;
      },
    });
    expect(
      await cmdOnboard(args, f.ctx, { ...runtime, bindSignals: false }),
    ).toBe(0);
    expect(out).toHaveLength(1);
    const receiptText = readFileSync(onboardStatePath(f.home), "utf8");
    const parsed = JSON.parse(out[0]!);
    const { verdict, actions, next, ...raw } = parsed;
    expect(raw).toEqual(JSON.parse(receiptText));
    expect(verdict).toBe("ready");
    expect(actions).toEqual([]);
    expect(next).toBe("catalyst onboard");
    expect(err.join("\n")).toContain(
      `Signed in to Catalyst as ${user.label} (${user.email})`,
    );
    expect(err.join("\n")).toContain(
      `Catalyst workspace: ${me.name} · member`,
    );
    for (const text of [out[0]!, receiptText]) {
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(user.label);
      expect(text).not.toContain(me.name);
      expect(text).not.toContain("personLabel");
      expect(text).not.toContain("workspaceName");
      expect(text).not.toContain("ctc_user_test_fixture");
    }
    out.length = 0;
    err.length = 0;
    const login = vi.fn(async () => {
      throw new Error("saved login must be rechecked without a new sign-in");
    });
    const recheck = createOnboardRuntime(args, f.ctx, { ...f.hooks, login });
    expect(
      await cmdOnboard(args, f.ctx, { ...recheck, bindSignals: false }),
    ).toBe(0);
    expect(login).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    const {
      verdict: recheckVerdict,
      actions: recheckActions,
      next: recheckNext,
      ...recheckRaw
    } = JSON.parse(out[0]!);
    expect(recheckRaw).toEqual(
      JSON.parse(readFileSync(onboardStatePath(f.home), "utf8")),
    );
    expect(recheckVerdict).toBe("ready");
    expect(recheckActions).toEqual([]);
    expect(recheckNext).toBe("catalyst onboard");
    expect(err.filter((line) => line.startsWith("Signed in to Catalyst as "))).toHaveLength(
      2,
    );
  });
});

// CTC-4630: the workflow step may apply its plan only with a question to ask or --yes.
describe("inline workflow adoption wiring", () => {
  const ctx = () => ({
    ...defaultCtx(),
    home: mkdtempSync(join(tmpdir(), "onboard-adopt-wiring-")),
    env: {} as NodeJS.ProcessEnv,
  });
  const hooks = { login: async () => 0, ready: async () => ({ state: "done" as const }) };
  test.each([
    [["onboard"], false, false],
    [["onboard", "--yes"], false, true],
    [["onboard"], true, true],
  ] as const)("%j with a plan question %s has an apply action: %s", (argv, question, expected) => {
    const c = ctx();
    homes.push(c.home);
    const ui: OnboardUi | undefined = question
      ? {
          signal: new AbortController().signal,
          plan: () => {},
          confirmPlan: async () => ({ proceed: true, localSync: false }),
          confirmWorkflowAdoption: async () => true,
          stepStart: () => {},
          stepEnd: () => {},
          message: () => {},
          finish: () => {},
          wait: async (_text, run) => run(),
          dispose: () => {},
        }
      : undefined;
    const runtime = createOnboardRuntime(parseArgs([...argv]), c, { ...hooks, ui });
    expect(typeof runtime.adapters?.["linear.adopt"]?.act === "function").toBe(expected);
  });
});
test.each([{ flags: [] }, { flags: ["--json"] }, { flags: ["--yes"] }])(
  "approval without an interactive UI %j returns immediately",
  async ({ flags }) => {
    const f = fixture();
    f.seed();
    const reads: string[] = [];
    const opened: string[] = [];
    f.supportedFetch((async (input) => {
      reads.push(String(input));
      return Response.json({ connected: false });
    }) as typeof fetch);
    const runtime = createOnboardRuntime(
      parseArgs(["onboard", ...flags]),
      f.ctx,
      {
        ...f.hooks,
        openBrowser: (url) => {
          opened.push(url);
        },
      },
    );
    const result = await runtime.adapters!["linear.personal"]!.act!(
      f.ctx,
      f.journal,
    );
    expect(result).toMatchObject({
      state: "waiting",
      reason: "personal_approval_required",
    });
    expect(opened).toEqual([]);
    expect(reads.some((r) => r.endsWith("/personal/start"))).toBe(false);
  },
);
test("JSON mode ignores an available interactive UI approval seam", async () => {
  const f = fixture();
  f.seed();
  f.supportedFetch((async () =>
    Response.json({ connected: false })) as typeof fetch);
  const ui = consentUi();
  ui.wait = async () => {
    throw new Error("wait must not start");
  };
  const runtime = createOnboardRuntime(
    parseArgs(["onboard", "--json"]),
    f.ctx,
    {
      ...f.hooks,
      ui,
      openBrowser: () => {
        throw new Error("must not open");
      },
    },
  );
  expect(
    await runtime.adapters!["github.personal"]!.act!(f.ctx, f.journal),
  ).toMatchObject({ state: "waiting", reason: "personal_approval_required" });
});
test("unexpected onboarding JSON failure still has one error journal", async () => {
  const f = fixture();
  const deps = { setupUi: consentUi() };
  deps.setupUi.dispose = () => {
    throw new Error("private-implementation-detail");
  };
  expect(await main(["onboard", "--json"], f.ctx, deps)).toBe(10);
  const docs = f.transcript.filter((t) => t.startsWith("{"));
  expect(docs).toHaveLength(1);
  expect(JSON.parse(docs[0]!)).toMatchObject({ exit: 10, complete: false });
  expect(f.transcript.join("\n")).not.toContain(
    "private-implementation-detail",
  );
});

describe("CTC-4680 round 5: a timed-out browser step holds", () => {
  const timedOut = { state: "waiting", reason: "consent_timeout", elapsedMs: 600_000 };
  function personalLinear(f: ReturnType<typeof fixture>, grant: string) {
    f.supportedFetch((async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me/connections/linear/personal")
        return Response.json({ connected: existsSync(grant) });
      if (path === "/connect/linear/personal/start")
        return Response.json({
          authorizationUrl: `${baseUrl}/connect/linear/personal/start?handoff=fresh-${Math.random()}`,
          expiresAt: f.ctx.now().getTime() + 60_000,
        });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch);
  }
  test("yes gives a fresh link and waits again", async () => {
    const f = fixture();
    f.seed();
    const grant = join(f.home, "granted");
    personalLinear(f, grant);
    const opened: string[] = [];
    const asked: string[] = [];
    let waits = 0;
    const ui: OnboardUi = {
      ...consentUi(),
      // The first wait runs out its window; the second one sees the grant.
      wait: async <T,>(_text: string, run: () => Promise<T>) =>
        ++waits === 1 ? (timedOut as T) : run(),
      retryTimedOut: async (id) => {
        asked.push(id);
        return true;
      },
    };
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui,
      openBrowser: (url) => {
        opened.push(url);
        if (opened.length === 2) writeFileSync(grant, "connected");
      },
      sleep: async () => {},
    });
    const result = await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(asked).toEqual(["linear.personal"]);
    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
  });
  test("stop leaves the step waiting and asks nothing more", async () => {
    const f = fixture();
    f.seed();
    personalLinear(f, join(f.home, "never"));
    let asked = 0;
    const ui: OnboardUi = {
      ...consentUi(),
      wait: async <T,>() => timedOut as T,
      retryTimedOut: async () => {
        asked += 1;
        return false;
      },
    };
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui,
      openBrowser: () => {},
      sleep: async () => {},
    });
    expect(await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "consent_timeout",
    });
    expect(asked).toBe(1);
  });
  test("an interrupted wait is skipped, not re-offered", async () => {
    const f = fixture();
    f.seed();
    personalLinear(f, join(f.home, "never"));
    let asked = 0;
    const ui: OnboardUi = {
      ...consentUi(),
      wait: async <T,>() => ({ state: "waiting", reason: "interrupted", elapsedMs: 5 }) as T,
      retryTimedOut: async () => {
        asked += 1;
        return true;
      },
    };
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui,
      openBrowser: () => {},
      sleep: async () => {},
    });
    await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal);
    expect(asked).toBe(0);
  });
  test("the runner question waits until Catalyst is on GitHub", async () => {
    const f = fixture();
    f.seed();
    let chosen = 0;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...f.hooks,
      ui: { ...consentUi(), chooseRunner: async () => (chosen++, false) },
    });
    const journal = {
      ...f.journal,
      steps: [{ id: "github.install" as const, state: "waiting" as const, reason: "consent_timeout" }],
    };
    // The engine runs check before act, and the runner's check is where the question is asked.
    expect(await runtime.adapters!.runner!.check(f.ctx, journal)).toEqual({
      state: "waiting",
      reason: "github_install_pending",
    });
    expect(await runtime.adapters!.runner!.act!(f.ctx, journal)).toEqual({
      state: "waiting",
      reason: "github_install_pending",
    });
    expect(chosen).toBe(0);
  });
});
