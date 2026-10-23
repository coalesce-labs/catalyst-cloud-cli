// CTC-4629 — what a person reads when an existing connection's permissions are out of date, and
// that the evidence behind it survives the receipt.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { onboardReasonText, onboardStepDetail } from "../src/onboard-next.js";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import { readOnboardJournal, type OnboardStep } from "../src/onboard.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const review =
  "https://github.com/organizations/acme/settings/installations/123/permissions/update";
const settings =
  "https://github.com/organizations/acme/settings/installations/123";

describe("the action line for an outdated connection", () => {
  test("explains an existing install and this account's Confirm access code before its review link", () => {
    const text = onboardReasonText({
      id: "github.install", state: "waiting", reason: "github_app_permissions_outdated",
      evidence: { installation: "123", org: "acme", missing: "actions (write)", url: review, actor: "github-org-admin" },
    });
    expect(text).toContain("existing GitHub App installation");
    expect(text).toContain("Accept new permissions");
    expect(text).toContain("Confirm access");
    expect(text).toContain("two-factor code for the GitHub account you are signed in to");
    expect(text.indexOf("Confirm access")).toBeLessThan(text.indexOf(review));
  });

  test("GitHub App permissions: the org, the permissions, the direct review URL, and that an org admin takes it", () => {
    const text = onboardReasonText({
      id: "github.install",
      state: "waiting",
      reason: "github_app_permissions_outdated",
      evidence: {
        provider: "github",
        installation: "123",
        org: "acme",
        missing: "issues (write), pull_requests (write)",
        url: review,
        actor: "github-org-admin",
      },
    });
    expect(text).toBe(
      `The existing GitHub App installation on acme needs updated permissions accepted: issues (write), pull_requests (write). GitHub may show Confirm access. Use the two-factor code for the GitHub account you are signed in to. An organization owner on GitHub chooses Review permissions, then Accept new permissions at ${review}. Run catalyst onboard afterward.`,
    );
  });

  test("GitHub App permissions on a personal account name the account owner", () => {
    const url =
      "https://github.com/settings/installations/123/permissions/update";
    expect(
      onboardReasonText({
        id: "github.install",
        state: "waiting",
        reason: "github_app_permissions_outdated",
        evidence: {
          installation: "123",
          org: "ryan",
          missing: "issues (write)",
          url,
          actor: "github-account-owner",
        },
      }),
    ).toContain(
      `The owner of the ryan GitHub account chooses Review permissions, then Accept new permissions at ${url}`,
    );
  });

  test("a repository the installation lacks: which repository, and the installation's repository settings", () => {
    expect(
      onboardReasonText({
        id: "github.install",
        state: "waiting",
        reason: "github_app_repository_missing",
        evidence: {
          installation: "123",
          org: "acme",
          repository: "acme/api",
          url: settings,
          actor: "github-org-admin",
        },
      }),
    ).toBe(
      `The GitHub App installation on acme cannot reach acme/api, which a project registers. An organization owner on GitHub adds it under Repository access at ${settings}, then run catalyst onboard.`,
    );
  });

  test("a repository whose owner has no installation", () => {
    expect(
      onboardReasonText({
        id: "github.install",
        state: "pending",
        reason: "github_app_repository_not_installed",
        evidence: { repository: "globex/site", org: "globex" },
      }),
    ).toBe(
      "No GitHub App installation can reach globex/site, which a project registers. A workspace owner or administrator installs the GitHub App on globex: run catalyst onboard.",
    );
  });

  test("the workspace Linear grant: which grant, which scopes, the one re-authorize URL", () => {
    const url =
      "https://staging.catalystcloud.dev/settings/connections?reauthorize=linear";
    expect(
      onboardReasonText(
        {
          id: "linear.workspace",
          state: "waiting",
          reason: "linear_workspace_scope_outdated",
          evidence: {
            grant: "linear-workspace",
            missing: "app:assignable, app:mentionable",
            url,
            actor: "workspace-admin",
          },
        },
        { baseUrl: "https://staging.catalystcloud.dev" },
      ),
    ).toBe(
      `The workspace's Linear connection (the Catalyst app) is missing scopes this version needs: app:assignable, app:mentionable. A workspace owner or administrator re-authorizes it at ${url}, then run catalyst onboard.`,
    );
  });

  test("the person's own Linear grant", () => {
    const url =
      "https://staging.catalystcloud.dev/connect/linear/personal/start";
    expect(
      onboardReasonText(
        {
          id: "linear.personal",
          state: "waiting",
          reason: "linear_personal_scope_outdated",
          evidence: {
            grant: "linear-personal",
            missing: "write",
            url,
            actor: "member",
          },
        },
        { baseUrl: "https://staging.catalystcloud.dev" },
      ),
    ).toBe(
      `Your personal Linear connection is missing scopes this version needs: write. Re-authorize it at ${url}, then run catalyst onboard.`,
    );
  });

  test("a check that could not be made says so", () => {
    for (const reason of [
      "linear_workspace_permissions_unverified",
      "personal_permissions_unverified",
      "github_app_repository_access_unverified",
      "github_app_permissions_unverified",
    ])
      expect(
        onboardReasonText({ id: "github.install", state: "waiting", reason }),
      ).toMatch(/could not be checked\. Run catalyst onboard to try again\.$/);
  });

  test("without evidence the table still gives an action, and a tampered receipt prints no foreign URL", () => {
    expect(
      onboardReasonText({
        id: "github.install",
        state: "waiting",
        reason: "github_app_permissions_outdated",
      }),
    ).toBe(
      "The existing GitHub App installation needs updated permissions accepted. GitHub may show Confirm access. Use the two-factor code for the GitHub account you are signed in to. An organization owner on GitHub opens the App's installation page, chooses Review permissions, then Accept new permissions. Run catalyst onboard afterward.",
    );
    const text = onboardReasonText({
      id: "github.install",
      state: "waiting",
      reason: "github_app_permissions_outdated",
      evidence: {
        org: "acme\u001b[31m",
        missing: "issues (write)\nrm -rf",
        url: "https://evil.example/organizations/acme/settings/installations/123/permissions/update",
        actor: "github-org-admin",
      },
    });
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\n");
  });
});

describe("a receipt URL prints only for its own reason, installation and cloud (CTC-4629 review)", () => {
  const fallback = (reason: string) =>
    onboardReasonText({ id: "github.install", state: "waiting", reason });

  test("a Linear URL with no saved login to compare against is not printed", () => {
    const step: OnboardStep = {
      id: "linear.workspace",
      state: "waiting",
      reason: "linear_workspace_scope_outdated",
      evidence: {
        missing: "write",
        url: "https://evil.example/settings/connections?reauthorize=linear",
      },
    };
    expect(onboardReasonText(step)).toBe(
      fallback("linear_workspace_scope_outdated"),
    );
    expect(
      onboardReasonText(step, { baseUrl: "https://staging.catalystcloud.dev" }),
    ).toBe(fallback("linear_workspace_scope_outdated"));
  });

  test.each([
    "https://staging.catalystcloud.dev/settings/connections",
    "https://staging.catalystcloud.dev/settings/connections?reauthorize=linear&next=/redirect",
    "https://staging.catalystcloud.dev/settings/connections?reauthorize=linear&reauthorize=linear",
    "https://staging.catalystcloud.dev/connect/linear/start",
  ])("a workspace review action rejects unsupported URL %s", (url) => {
    expect(
      onboardReasonText(
        {
          id: "linear.workspace",
          state: "waiting",
          reason: "linear_workspace_scope_outdated",
          evidence: { url },
        },
        { baseUrl: "https://staging.catalystcloud.dev" },
      ),
    ).toBe(fallback("linear_workspace_scope_outdated"));
  });

  test("the workspace start is not printed for the personal grant, nor the reverse", () => {
    const base = { baseUrl: "https://staging.catalystcloud.dev" };
    expect(
      onboardReasonText(
        {
          id: "linear.personal",
          state: "waiting",
          reason: "linear_personal_scope_outdated",
          evidence: {
            url: "https://staging.catalystcloud.dev/settings/connections?reauthorize=linear",
          },
        },
        base,
      ),
    ).toBe(fallback("linear_personal_scope_outdated"));
    expect(
      onboardReasonText(
        {
          id: "linear.workspace",
          state: "waiting",
          reason: "linear_workspace_scope_outdated",
          evidence: {
            url: "https://staging.catalystcloud.dev/connect/linear/personal/start",
          },
        },
        base,
      ),
    ).toBe(fallback("linear_workspace_scope_outdated"));
  });

  test("a GitHub page for another installation, another org or the other page kind is not printed", () => {
    for (const [reason, url] of [
      [
        "github_app_repository_missing",
        "https://github.com/organizations/acme/settings/installations/999",
      ],
      [
        "github_app_repository_missing",
        "https://github.com/organizations/other/settings/installations/123",
      ],
      ["github_app_repository_missing", review],
      ["github_app_permissions_outdated", settings],
    ] as const)
      expect(
        onboardReasonText({
          id: "github.install",
          state: "waiting",
          reason,
          evidence: {
            installation: "123",
            org: "acme",
            repository: "acme/api",
            url,
          },
        }),
      ).toBe(fallback(reason));
  });
});

describe("a done connection shows what was granted", () => {
  test("several installations keep their detail line", () => {
    expect(
      onboardStepDetail({
        id: "github.install",
        state: "done",
        evidence: {
          granted: "acme: contents (write); globex: contents (write)",
        },
      }),
    ).toBe("granted acme: contents (write); globex: contents (write)");
  });

  test("the detail line carries the granted scopes", () => {
    const step: OnboardStep = {
      id: "linear.workspace",
      state: "done",
      evidence: { provider: "linear", granted: "read, write, initiative:read" },
    };
    expect(onboardStepDetail(step)).toBe(
      "granted read, write, initiative:read",
    );
    expect(
      onboardStepDetail({ id: "linear.workspace", state: "done" }),
    ).toBeUndefined();
  });

  test.each([false, true])(
    "done connection details appear only with verbose=%s",
    (verbose) => {
      const events: Array<{ kind: string; text: string }> = [];
      const log = (kind: string) => (text: string) =>
        events.push({ kind, text });
      const ui = createClackOnboardUi(
        {
          intro: log("intro"),
          outro: log("outro"),
          log: {
            message: log("message"),
            info: log("info"),
            warn: log("warn"),
            error: log("error"),
          },
          select: async () => "cloud",
          isCancel: (value: unknown) => typeof value === "symbol",
        },
        { input: new PassThrough(), output: new PassThrough() },
        {
          signals: new EventEmitter(),
          progress: { start: () => {}, stop: () => {}, dispose: () => {} },
          baseUrl: () => undefined,
          verbose,
        },
      );
      ui.stepEnd(
        {
          id: "github.install",
          state: "done",
          evidence: {
            provider: "github",
            granted: "acme: contents (write), issues (write)",
          },
        },
        {
          schema: 1,
          runId: "detail",
          installer: null,
          cli: "0.14.10",
          tenant: null,
          exit: null,
          steps: [],
          changes: [],
        },
      );
      ui.dispose();
      expect(events.find((event) => event.kind === "info")?.text).toBe(
        "✓ Install Catalyst on GitHub",
      );
      const detail = events.find((event) => event.kind === "message");
      expect(detail?.text).toBe(
        verbose ? "granted acme: contents (write), issues (write)" : undefined,
      );
    },
  );
});

test("the receipt keeps the evidence an action line is built from", () => {
  const home = mkdtempSync(join(tmpdir(), "permission-drift-"));
  homes.push(home);
  const path = join(home, "onboard.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      runId: "drift",
      installer: null,
      cli: "0.14.10",
      tenant: null,
      exit: 11,
      steps: [
        {
          id: "github.install",
          state: "waiting",
          reason: "github_app_permissions_outdated",
          evidence: {
            provider: "github",
            grant: "github-installation",
            installation: "123",
            org: "acme",
            granted: "contents (read)",
            missing: "issues (write)",
            url: review,
            actor: "github-org-admin",
          },
        },
      ],
      changes: [],
    }),
  );
  expect(readOnboardJournal(path)!.steps[0]!.evidence).toEqual({
    provider: "github",
    grant: "github-installation",
    installation: "123",
    org: "acme",
    granted: "contents (read)",
    missing: "issues (write)",
    url: review,
    actor: "github-org-admin",
  });
});
