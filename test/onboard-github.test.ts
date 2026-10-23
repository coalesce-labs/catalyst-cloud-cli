import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import { githubInstallationAdapter } from "../src/onboard-github.js";
import type { OnboardJournal } from "../src/onboard.js";

const homes: string[] = [];
const now = Date.parse("2026-09-30T23:00:00Z");
const origin = "https://fixture.invalid";
const path = "/api/v1/me/connections/github/workspace";
const link = `${origin}/connect/github/workspace/handoff?handoff=synthetic-signed-material`;
const installation = (id = "123", state = "connected") => ({
  installationId: id,
  githubOrg: "fixture",
  verification: { source: "live-probe", state, checkedAt: now },
});
const done = () => ({
  connected: true,
  installations: [installation()],
  pending: [],
});
const absent = () => ({ connected: false, installations: [], pending: [] });
function fixture(role: "owner" | "member" = "owner") {
  const home = mkdtempSync(join(tmpdir(), "onboard-github-"));
  homes.push(home);
  const logs: string[] = [],
    opened: string[] = [];
  const reads: Array<{ path: string; init?: RequestInit }> = [];
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {},
    now: () => new Date(now),
    stdout: (text) => logs.push(text),
    stderr: (text) => logs.push(text),
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
      role,
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_user_fake",
    joinedAt: new Date(now).toISOString(),
    lastSkillBundleVersion: "0.14.4",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "github-fixture",
    installer: null,
    cli: "0.14.4",
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    steps: [],
    changes: [],
    exit: null,
  };
  let status: unknown = done(),
    start: unknown = { authorizationUrl: link, expiresAt: now + 600_000 };
  let statusCode = 200,
    startCode = 200,
    flip = false;
  ctx.fetch = (async (input, init) => {
    const url = new URL(String(input));
    reads.push({ path: url.pathname, init });
    if (url.pathname === path)
      return Response.json(flip && opened.length ? done() : status, {
        status: statusCode,
      });
    if (url.pathname === `${path}/start`)
      return Response.json(start, { status: startCode });
    throw new Error("synthetic-private-diagnostic");
  }) as typeof fetch;
  const options = {
    openBrowser: (url: string) => {
      opened.push(url);
    },
    sleep: async () => {},
    wait: async <T>(_message: string, run: () => Promise<T>) => run(),
    requestTimeoutMs: 30,
    consentTimeoutMs: 50,
  };
  return {
    ctx,
    home,
    journal,
    logs,
    opened,
    reads,
    options,
    adapter: () => githubInstallationAdapter(options),
    status: (value: unknown) => {
      status = value;
    },
    start: (value: unknown) => {
      start = value;
    },
    statusCode: (code: number) => {
      statusCode = code;
    },
    startCode: (code: number) => {
      startCode = code;
    },
    flip: () => {
      flip = true;
    },
  };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
describe("native personal-bearer GitHub App installation", () => {
  test("requires fresh live installation and App permissions without claiming repository access", async () => {
    const f = fixture();
    const before = readFileSync(configPathFor(f.home));
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "done",
      evidence: { provider: "github", installation: '["123"]', checkedAt: now },
    });
    expect(f.reads[0]!.init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { authorization: "Bearer ctc_user_fake" },
    });
    expect(f.opened).toEqual([]);
    expect(f.logs).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test("accepts the server's sanitized missing permission labels as actionable absence", async () => {
    const f = fixture();
    f.status({
      connected: false,
      installations: [
        {
          ...installation("123", "missing-scope"),
          verification: {
            source: "live-probe",
            state: "missing-scope",
            checkedAt: now,
            missing: ["issues (write)", "contents (read)"],
          },
        },
      ],
      pending: [],
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
  });
  test("reuses a freshly verified installation without minting a handoff", async () => {
    const f = fixture();
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.reads).toHaveLength(1);
    expect(f.opened).toEqual([]);
  });
  test("one transient browser-only link starts installation, then fresh status verifies it", async () => {
    const f = fixture();
    f.status(absent());
    f.flip();
    const before = readFileSync(configPathFor(f.home));
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.opened).toEqual([link]);
    expect(f.reads.map((row) => row.path)).toEqual([
      path,
      `${path}/start`,
      path,
    ]);
    expect(f.logs.join("\n")).not.toContain("synthetic-signed-material");
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test("warns which account's two-factor code GitHub wants before opening the install handoff", async () => {
    const f = fixture();
    f.status(absent());
    f.flip();
    let beforeOpen = "";
    const adapter = githubInstallationAdapter({
      ...f.options,
      openBrowser: (url) => {
        beforeOpen = f.logs.join("\n");
        f.opened.push(url);
      },
    });
    expect((await adapter.act!(f.ctx, f.journal)).state).toBe("done");
    expect(beforeOpen).toContain("GitHub may show Confirm access");
    expect(beforeOpen).toContain("two-factor code for the GitHub account you are signed in to");
    expect(f.opened).toEqual([link]);
    expect(f.logs.join("\n")).not.toContain("synthetic-signed-material");
  });
  test.each([404, 405, 503])(
    "older cloud or unavailable status %s waits without fallback or browser",
    async (code) => {
      const f = fixture();
      f.statusCode(code);
      expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("waiting");
      expect(f.reads).toHaveLength(1);
      expect(f.opened).toEqual([]);
    },
  );
  test.each([404, 405])(
    "a status route removed during approval %s stops waiting without retrying",
    async (code) => {
      const f = fixture();
      f.status(absent());
      const adapter = githubInstallationAdapter({
        ...f.options,
        openBrowser: (url) => {
          f.opened.push(url);
          f.statusCode(code);
        },
        sleep: async () => {
          throw new Error("unsupported route must not retry");
        },
      });
      expect(await adapter.act!(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "cloud_capability_unavailable",
        elapsedMs: expect.any(Number),
      });
      expect(f.reads.map((row) => row.path)).toEqual([
        path,
        `${path}/start`,
        path,
      ]);
      expect(f.opened).toEqual([link]);
    },
  );
  test.each([401, 403])("status refusal %s never opens", async (code) => {
    const f = fixture();
    f.statusCode(code);
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("refused");
    expect(f.opened).toEqual([]);
  });
  test("members can check but cannot mint organization installation consent", async () => {
    const f = fixture("member");
    expect((await f.adapter().check(f.ctx, f.journal)).state).toBe("done");
    const g = fixture("member");
    expect((await g.adapter().act!(g.ctx, g.journal)).reason).toBe(
      "github_installation_admin_required",
    );
    expect(g.reads).toEqual([]);
  });
  test.each([
    { connected: true, installations: [], pending: [] },
    {
      connected: true,
      installations: [installation(), installation("456", "missing-scope")],
      pending: [],
    },
    {
      connected: true,
      installations: [installation(), installation()],
      pending: [],
    },
    {
      connected: true,
      installations: [
        {
          ...installation(),
          verification: {
            source: "live-probe",
            state: ["connected"],
            checkedAt: now,
          },
        },
      ],
      pending: [],
    },
    {
      connected: true,
      installations: [
        {
          ...installation(),
          verification: {
            source: "live-probe",
            state: "connected",
            checkedAt: now - 120_001,
          },
        },
      ],
      pending: [],
    },
    {
      connected: true,
      installations: [
        {
          ...installation(),
          verification: {
            source: "live-probe",
            state: "connected",
            checkedAt: now + 30_001,
          },
        },
      ],
      pending: [],
    },
    {
      connected: false,
      installations: [],
      pending: [{ githubOrg: "fixture", requestedAt: "yesterday" }],
    },
    {
      connected: false,
      installations: [],
      pending: Array.from({ length: 101 }, () => ({
        githubOrg: "fixture",
        requestedAt: now,
      })),
    },
    {
      connected: true,
      installations: Array.from({ length: 100 }, (_, i) =>
        installation(String(i + 1)),
      ),
      pending: [{ githubOrg: "fixture", requestedAt: now }],
    },
  ])(
    "rejects malformed, stale, contradictory, or oversized installation inventories %#",
    async (status) => {
      const f = fixture();
      f.status(status);
      expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
        "github_installation_status_shape",
      );
      expect(f.opened).toEqual([]);
    },
  );
  test.each([
    { source: "none", checkedAt: null, state: "not-run" },
    { source: "live-probe", checkedAt: now, state: "unreachable" },
  ])(
    "unknown probes wait without interpreting stored metadata as absence %#",
    async (verification) => {
      const f = fixture();
      f.status({
        connected: false,
        installations: [{ ...installation(), verification }],
        pending: [],
      });
      expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
        "github_installation_status_unavailable",
      );
      expect(f.reads).toHaveLength(1);
      expect(f.opened).toEqual([]);
    },
  );
  test.each([
    `${origin}/connect/github/workspace/handoff?handoff=a&handoff=b`,
    `${origin}/connect/github/workspace/handoff?handoff=a&account=other`,
    `${origin}/connect/github/personal/start?handoff=a`,
    `${origin}/connect/linear/workspace/handoff?handoff=a`,
    `https://foreign.invalid/connect/github/workspace/handoff?handoff=a`,
    `http://fixture.invalid/connect/github/workspace/handoff?handoff=a`,
    `https://user@fixture.invalid/connect/github/workspace/handoff?handoff=a`,
    `${origin}/connect/github/workspace/handoff?handoff=a#fragment`,
    `\n${origin}/connect/github/workspace/handoff?handoff=a`,
    `${origin}/connect/github/workspace/handoff?handoff=%0a`,
    `${origin}/connect/github/workspace/handoff?handoff=`,
  ])("refuses unsafe or wrong-purpose handoff %#", async (authorizationUrl) => {
    const f = fixture();
    f.status(absent());
    f.start({ authorizationUrl, expiresAt: now + 600_000 });
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "github_installation_consent_handoff",
    );
    expect(f.opened).toEqual([]);
  });
  test.each([now, now - 1, now + 630_001, null])(
    "refuses invalid expiry %#",
    async (expiresAt) => {
      const f = fixture();
      f.status(absent());
      f.start({ authorizationUrl: link, expiresAt });
      expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("refused");
      expect(f.opened).toEqual([]);
    },
  );
  test("identity mismatch or unbound receipt refuses before network", async () => {
    const f = fixture();
    f.journal.membershipId = "foreign";
    expect((await f.adapter().check(f.ctx, f.journal)).state).toBe("refused");
    expect(f.reads).toEqual([]);
    const g = fixture();
    delete g.journal.baseUrl;
    expect((await g.adapter().check(g.ctx, g.journal)).state).toBe("refused");
    expect(g.reads).toEqual([]);
  });
  test("a changed current identity during body parsing cannot produce done or open a browser", async () => {
    const f = fixture();
    f.ctx.fetch = (async () =>
      ({
        status: 200,
        json: async () => {
          const cfg = loadConfig(f.home)!;
          cfg.user!.id = "foreign";
          writeConfig(f.home, cfg);
          return done();
        },
      }) as unknown as Response) as typeof fetch;
    expect((await f.adapter().check(f.ctx, f.journal)).state).toBe("refused");
    expect(f.opened).toEqual([]);
  });
  test("headers ignoring abort are bounded and late completion cannot mint or open", async () => {
    const f = fixture();
    let complete!: (response: Response) => void;
    f.ctx.fetch = (() =>
      new Promise((resolve) => {
        complete = resolve;
      })) as typeof fetch;
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "github_installation_status_unavailable",
    );
    complete(Response.json(absent()));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.opened).toEqual([]);
  });
  test("body ignoring abort is bounded independently of transport completion", async () => {
    const f = fixture();
    f.ctx.fetch = (async () =>
      ({
        status: 200,
        json: () => new Promise(() => {}),
      }) as unknown as Response) as typeof fetch;
    expect((await f.adapter().check(f.ctx, f.journal)).reason).toBe(
      "github_installation_status_unavailable",
    );
  });
  test("interruption after the start response never launches its signed URL", async () => {
    const f = fixture();
    f.status(absent());
    const abort = new AbortController();
    const original = f.ctx.fetch;
    f.ctx.fetch = (async (url, init) => {
      const result = await original(url, init);
      if (String(url).endsWith("/start")) abort.abort();
      return result;
    }) as typeof fetch;
    expect(
      (await f.adapter().act!(f.ctx, f.journal, abort.signal)).reason,
    ).toBe("interrupted");
    expect(f.opened).toEqual([]);
  });
  test("consent timeout stays waiting rather than reporting setup complete", async () => {
    const f = fixture();
    f.status(absent());
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "consent_timeout",
    );
    expect(f.opened).toHaveLength(1);
  });
  test("without a browser it names the Connections page and keeps waiting, never printing the signed link", async () => {
    const f = fixture();
    f.status(absent());
    const adapter = githubInstallationAdapter({
      ...f.options,
      openBrowser: async () => {
        await Promise.resolve();
        f.status(done());
        throw new Error("https://example.test/?handoff=private-opener-value");
      },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "done",
    });
    const printed = f.logs.join("\n");
    // CTC-4680: the printed link starts the install on GitHub; Integrations started nothing.
    expect(printed).toContain(`${origin}/connect/github/start`);
    expect(printed).not.toContain("/settings/connections");
    expect(printed).not.toContain("private-opener-value");
  });
  test("without a browser the deadline asks the person to finish on the web and resume", async () => {
    const f = fixture();
    f.status(absent());
    const adapter = githubInstallationAdapter({
      ...f.options,
      openBrowser: async () => {
        throw new Error("no opener");
      },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "github_installation_browser_unavailable",
    });
  });
  test("login expiry during browser approval stops with its actual cause", async () => {
    const f = fixture();
    f.status(absent());
    const adapter = githubInstallationAdapter({
      ...f.options,
      openBrowser: () => {
        const config = loadConfig(f.home)!;
        writeConfig(f.home, {
          ...config,
          key: undefined,
          auth: {
            kind: "oauth",
            accessToken: "expired-token-sentinel",
            refreshToken: "unused-refresh-sentinel",
            expiresAt: new Date(now - 1).toISOString(),
            sessionId: "original-session",
          },
        });
      },
      sleep: async () => {
        throw new Error("refresh-required status must not poll again");
      },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "github_installation_login_refresh_required",
    });
    expect(f.reads).toHaveLength(2);
    expect(f.logs.join("\n")).not.toMatch(
      /expired-token-sentinel|unused-refresh-sentinel/,
    );
  });
});

describe("CTC-4629: an existing installation whose permissions or repositories are out of date", () => {
  const review = "https://github.com/organizations/fixture/settings/installations/123/permissions/update";
  const settings = "https://github.com/organizations/fixture/settings/installations/123";
  const current = {
    state: "current",
    grant: "github-installation",
    granted: ["contents (write)", "issues (write)"],
  };
  const live = (permissions: unknown, state = "connected", missing?: string[]) => ({
    ...installation("123", state),
    verification: { source: "live-probe", state, checkedAt: now, ...(missing ? { missing } : {}) },
    permissions,
  });
  const outdated = {
    state: "outdated",
    grant: "github-installation",
    granted: ["contents (read)"],
    missing: ["issues (write)"],
    action: { kind: "review-permissions", url: review, actor: "github-org-admin" },
  };

  test("a pending permission request waits as an org-admin action with the installation's direct review URL", async () => {
    const f = fixture();
    f.status({
      connected: false,
      installations: [live(outdated, "missing-scope", ["issues (write)"])],
      pending: [],
      repositories: { state: "covered", checked: [] },
    });
    const expected = {
      state: "waiting",
      reason: "github_app_permissions_outdated",
      evidence: {
        provider: "github",
        grant: "github-installation",
        installation: "123",
        org: "fixture",
        granted: "contents (read)",
        missing: "issues (write)",
        url: review,
        actor: "github-org-admin",
      },
    };
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual(expected);
    // It is GitHub's own review page, not a new installation: no handoff is minted or opened.
    expect(await f.adapter().act!(f.ctx, f.journal)).toEqual(expected);
    expect(f.reads.every((row) => row.path === path)).toBe(true);
    expect(f.opened).toEqual([]);
  });

  test("an installation lacking a registered repository names it and links to the installation's repository settings", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: {
        state: "missing",
        checked: ["fixture/api", "fixture/web"],
        unchecked: [],
        missing: [
          {
            repository: "fixture/api",
            installationId: "123",
            githubOrg: "fixture",
            settingsUrl: settings,
            actor: "github-org-admin",
          },
        ],
      },
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_app_repository_missing",
      evidence: {
        provider: "github",
        installation: "123",
        org: "fixture",
        repository: "fixture/api",
        url: settings,
        actor: "github-org-admin",
      },
    });
  });

  test("a registered repository whose owner has no installation is an installation still to make", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: {
        state: "missing",
        checked: ["globex/site"],
        unchecked: [],
        missing: [
          {
            repository: "globex/site",
            installationId: null,
            githubOrg: "globex",
            settingsUrl: null,
            actor: null,
          },
        ],
      },
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "pending",
      reason: "github_app_repository_not_installed",
      evidence: { provider: "github", repository: "globex/site", org: "globex" },
    });
  });

  test("everything matching is done with the granted permissions in its details", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: { state: "covered", checked: ["fixture/api"] },
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "done",
      evidence: {
        provider: "github",
        installation: '["123"]',
        checkedAt: now,
        granted: "fixture: contents (write), issues (write)",
      },
    });
  });

  test("repository access that could not be checked waits and never claims done", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: { state: "unknown", reason: "unreachable" },
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_app_repository_access_unverified",
    });
  });

  test.each([
    ["an unrelated host", "https://evil.example/organizations/fixture/settings/installations/123/permissions/update"],
    ["another installation", "https://github.com/organizations/fixture/settings/installations/999/permissions/update"],
    ["another organization", "https://github.com/organizations/other/settings/installations/123/permissions/update"],
    ["a query", `${review}?next=x`],
  ])("a review URL on %s is a shape error, never printed", async (_label, url) => {
    const f = fixture();
    f.status({
      connected: false,
      installations: [
        live({ ...outdated, action: { ...outdated.action, url } }, "missing-scope", ["issues (write)"]),
      ],
      pending: [],
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_installation_status_shape",
    });
  });

  test("a current verdict on a missing-scope row is a shape error", async () => {
    const f = fixture();
    f.status({
      connected: false,
      installations: [live(current, "missing-scope", ["issues (write)"])],
      pending: [],
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_installation_status_shape",
    });
  });
});

test("CTC-4629: an installation made for an uncovered repository that still lacks it stops polling with the settings link", async () => {
  const f = fixture();
  const settings = "https://github.com/organizations/fixture/settings/installations/123";
  f.status({
    connected: true,
    installations: [installation()],
    pending: [],
    repositories: {
      state: "missing",
      checked: ["fixture/site"],
      unchecked: [],
      missing: [
        {
          repository: "fixture/site",
          installationId: null,
          githubOrg: "fixture",
          settingsUrl: null,
          actor: null,
        },
      ],
    },
  });
  const adapter = githubInstallationAdapter({
    ...f.options,
    openBrowser: (url) => {
      f.opened.push(url);
      f.status({
        connected: true,
        installations: [installation()],
        pending: [],
        repositories: {
          state: "missing",
          checked: ["fixture/site"],
          unchecked: [],
          missing: [
            {
              repository: "fixture/site",
              installationId: "123",
              githubOrg: "fixture",
              settingsUrl: settings,
              actor: "github-org-admin",
            },
          ],
        },
      });
    },
    sleep: async () => {
      throw new Error("a GitHub-side action must not keep polling");
    },
  });
  expect(await adapter.act!(f.ctx, f.journal)).toEqual({
    state: "waiting",
    reason: "github_app_repository_missing",
    evidence: {
      provider: "github",
      installation: "123",
      org: "fixture",
      repository: "fixture/site",
      url: settings,
      actor: "github-org-admin",
    },
  });
  expect(f.opened).toEqual([link]);
});

describe("CTC-4629 review: coverage and permission verdicts that cannot be verified", () => {
  const current = {
    state: "current",
    grant: "github-installation",
    granted: ["contents (write)"],
  };
  const live = (permissions: unknown) => ({ ...installation(), permissions });

  test("a connected installation whose permissions could not be checked waits and never claims done", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [
        live({ state: "unknown", grant: "github-installation", reason: "grant-unreadable" }),
      ],
      pending: [],
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_app_permissions_unverified",
    });
  });

  test("a missing repository next to unchecked ones reports the missing one", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: {
        state: "missing",
        checked: ["globex/site"],
        missing: [
          {
            repository: "globex/site",
            installationId: null,
            githubOrg: "globex",
            settingsUrl: null,
            actor: null,
          },
        ],
        unchecked: [{ repository: "fixture/api", reason: "listing-truncated" }],
      },
    });
    expect((await f.adapter().check(f.ctx, f.journal)).reason).toBe(
      "github_app_repository_not_installed",
    );
  });

  test("a truncated listing is an unverified repository check", async () => {
    const f = fixture();
    f.status({
      connected: true,
      installations: [live(current)],
      pending: [],
      repositories: { state: "unknown", reason: "listing-truncated" },
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_app_repository_access_unverified",
    });
  });

  test.each([
    [
      "a missing repository absent from checked",
      {
        state: "missing",
        checked: [],
        unchecked: [],
        missing: [
          { repository: "globex/site", installationId: null, githubOrg: "globex", settingsUrl: null, actor: null },
        ],
      },
    ],
    [
      "a covered verdict carrying missing rows",
      { state: "covered", checked: ["globex/site"], missing: [] },
    ],
    [
      "a missing verdict without its unchecked list",
      {
        state: "missing",
        checked: ["globex/site"],
        missing: [
          { repository: "globex/site", installationId: null, githubOrg: "globex", settingsUrl: null, actor: null },
        ],
      },
    ],
  ])("%s is a shape error", async (_label, repositories) => {
    const f = fixture();
    f.status({ connected: true, installations: [live(current)], pending: [], repositories });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "github_installation_status_shape",
    });
  });
});


test.each(["permissions", "repositories"])("a GitHub approval with unreadable %s reports its actual check failure immediately", async (kind) => {
 const f = fixture(); f.status(absent());
 const adapter = githubInstallationAdapter({ ...f.options, openBrowser: () => f.status({ ...done(), ...(kind === "permissions" ? { installations: [{ ...installation(), permissions: { state: "unknown", grant: "github-installation", reason: "grant-unreadable" } }] } : { repositories: { state: "unknown", reason: "listing-truncated" } }) }), sleep: async () => { throw new Error("permission failure must not poll"); } });
 expect(await adapter.act!(f.ctx, f.journal)).toEqual({ state: "waiting", reason: kind === "permissions" ? "github_app_permissions_unverified" : "github_app_repository_access_unverified" });
});

test("without an interactive wait seam, missing approval returns immediately without opening a browser", async () => {
  const f = fixture();
  f.status(absent());
  const adapter = githubInstallationAdapter({ ...f.options, wait: undefined });
  const result = await adapter.act!(f.ctx, f.journal);
  expect(result).toMatchObject({
    state: "waiting",
    reason: "github_installation_approval_required",
  });
  expect(f.opened).toEqual([]);
  expect(f.reads).toHaveLength(1);
});

test("CTC-4680 round 5: an install request already waiting on GitHub is not requested again", async () => {
  const f = fixture();
  f.status({
    connected: false,
    installations: [],
    pending: [{ githubOrg: "fixture", requestedAt: now - 60_000 }],
  });
  expect(await f.adapter().act!(f.ctx, f.journal)).toEqual({
    state: "waiting",
    reason: "github_installation_approval_pending",
    evidence: { provider: "github", org: "fixture" },
  });
  expect(f.opened).toEqual([]);
  expect(f.reads.map((r) => r.path)).not.toContain(`${path}/start`);
});
