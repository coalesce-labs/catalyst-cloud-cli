// fixture-contract.ts — the GET /api/v1/agent/contract document the fixture cloud serves, modelled on
// the cloud's own committed fixture: two teams, all eleven slots on one of them, ask/hold/release
// labels, the route table under a DELIBERATELY unusual prefix (so a hard-coded `/api/v1/agent/...`
// fails the write tests), vocabulary, askTemplate, ladder, thresholds, merge, readinessChecks, humans.
// Every value is synthetic.
import type { TenantContract } from "../src/contract-types";

export const FIXTURE_ROUTE_PREFIX = "/api/v1/agent-fixture";

export const FIXTURE_ACCOUNT = "tenant-3";

export function buildFixtureContract(): TenantContract {
  const route = (method: "GET" | "POST", name: string, budget: boolean) => ({
    method,
    path: `${FIXTURE_ROUTE_PREFIX}/${name}`,
    takesWriteBudgetUnit: budget,
    since: "1.0.0",
  });
  const stage = (
    stateId: string,
    name: string | null,
    type: string | null,
    exists = true,
    source = "matched",
  ) => ({
    stateId,
    name,
    type,
    stateStillExists: exists,
    source,
  });
  return {
    contractVersion: "1.0.0",
    protocolVersion: 4,
    cache: { maxAgeSeconds: 900, staleRefusalSeconds: 3600 },
    account: {
      id: FIXTURE_ACCOUNT,
      slug: "hagale-technologies",
      name: "Hagale Technologies",
      linearWorkspaceId: "lw-fixture",
      linearWorkspaceSlug: "hagale",
    },
    apiPrefix: "/api/v1",
    slots: [
      "dispatch",
      "intake",
      "research",
      "plan",
      "implement",
      "remediate",
      "verify",
      "review",
      "pr",
      "done",
      "canceled",
    ],
    routes: [
      route("POST", "delegate", false),
      route("POST", "issue-state", true),
      route("POST", "issue-label", true),
      route("POST", "issue-comment", true),
      route("POST", "ask-accept", true),
      route("POST", "ask-answer-proxy", true),
      route("POST", "ask", true),
      route("POST", "attachment", true),
      route("GET", "attachments", false),
      route("POST", "session", true),
      route("POST", "reaction", true),
      route("POST", "issue-create", true),
      route("GET", "linear/read", false),
      route("POST", "ticket-release", true),
      route("POST", "ticket-release-class", true),
      // CTC-2545 — the account-scope environment declaration. The GET is the prefix the CLI derives
      // propose/approve from; both POSTs are listed because the verb CHECKS the derived paths against
      // this table rather than trusting the derivation.
      route("GET", "account-environment", false),
      route("POST", "account-environment/propose", false),
      route("POST", "account-environment/approve", false),
      route("GET", "tenant/repositories", false),
      {
        method: "GET",
        path: "/api/v1/agent/contract",
        takesWriteBudgetUnit: false,
        since: "1.0.0",
      },
    ],
    teams: [
      {
        id: "team-eng",
        key: "ENG",
        name: "Engineering",
        workflowMode: "auto",
        gitAutomation: "full",
        stages: {
          dispatch: stage("state-todo", "Todo", "unstarted"),
          intake: stage("state-intake", "Intake", "unstarted", true, "created"),
          research: stage(
            "state-research",
            "Research",
            "started",
            true,
            "created",
          ),
          plan: stage("state-plan", "Plan", "started", true, "created"),
          implement: stage(
            "state-implement",
            "In Progress",
            "started",
            true,
            "chosen",
          ),
          remediate: stage(
            "state-remediate",
            "Remediate",
            "started",
            true,
            "created",
          ),
          verify: stage("state-verify", "Validate", "started", true, "created"),
          review: stage("state-deleted", null, null, false),
          pr: stage("state-pr-x7", "In Review", "started"),
          done: stage("state-done", "Done", "completed"),
          canceled: stage("state-canceled", "Canceled", "canceled"),
        },
        labels: {
          ask: [
            {
              name: "catalyst-ask",
              unscopedId: "label-ask-unscoped",
              teamScopedId: "label-ask-eng",
              scope: "unscoped",
              preferredId: "label-ask-unscoped",
            },
          ],
          hold: [
            {
              name: "hold:needs-remediation",
              unscopedId: null,
              teamScopedId: "label-remediate-eng",
              scope: "team",
              preferredId: "label-remediate-eng",
            },
          ],
          release: [
            {
              name: "catalyst-not-an-ask",
              unscopedId: null,
              teamScopedId: null,
              scope: "absent",
              preferredId: null,
            },
          ],
        },
        readiness: {
          status: "ready",
          checks: [
            { id: "oauth_scope", state: "pass" },
            { id: "token_live", state: "pass" },
            { id: "team_visible", state: "pass" },
            { id: "mapped_states_exist", state: "pass" },
            { id: "mapping_total", state: "pass" },
            { id: "types_compatible", state: "pass" },
            { id: "labels_present", state: "pass" },
            { id: "writes_land", state: "pass" },
            {
              id: "webhook_covers_team",
              state: "unknown",
              reason: "no_delivery_observed",
            },
            { id: "hosts_current", state: "pass" },
          ],
          checkedAt: 1_756_000_000_000,
          expiresAt: 1_756_003_600_000,
          workflowRev: 7,
        },
      },
      {
        id: "team-ops",
        key: "OPS",
        name: "Operations",
        workflowMode: "manual",
        gitAutomation: "off",
        stages: {},
        labels: {
          ask: [
            {
              name: "catalyst-ask",
              unscopedId: "label-ask-unscoped",
              teamScopedId: null,
              scope: "unscoped",
              preferredId: "label-ask-unscoped",
            },
          ],
          hold: [
            {
              name: "hold:needs-remediation",
              unscopedId: null,
              teamScopedId: null,
              scope: "absent",
              preferredId: null,
            },
          ],
          release: [
            {
              name: "catalyst-not-an-ask",
              unscopedId: null,
              teamScopedId: null,
              scope: "absent",
              preferredId: null,
            },
          ],
        },
        readiness: {
          status: "unchecked",
          checks: [],
          checkedAt: null,
          expiresAt: null,
          workflowRev: null,
        },
      },
    ],
    vocabulary: {
      askLabelPrefix: "ask/",
      askPhaseLabelPrefix: "ask/phase:",
      askMarkerLabel: "catalyst-ask",
      releaseLabel: "catalyst-not-an-ask",
      bookkeeping: {
        marker: "[bookkeeping-fixture]",
        prefixOnly: true,
        asciiCaseInsensitive: true,
        leadingWhitespaceTrimmed: true,
      },
    },
    askTemplate: {
      headings: {
        ask: "**Ask:**",
        options: "**Options:**",
        defaultIfSilent: "**Default if silent:**",
        howToAnswer: "**How to answer:**",
      },
      howToAnswer: {
        withOptions:
          "**How to answer:** reply with the option letter, or `DECIDED: <your answer>`.",
        withoutOptions:
          "**How to answer:** reply with `DECIDED: <your answer>`.",
      },
      optionBulletFormat: "- **A** — <label>",
      maxLetteredOptions: 26,
      maxAskGenerations: 25,
      example:
        "**Ask:** Should we adopt approach A or approach B?\n\n**Options:**\n- **A** — Option A\n- **B** — Option B\n\n**Default if silent:** Option A\n\n**How to answer:** reply with the option letter, or `DECIDED: <your answer>`.",
    },
    ladder: {
      phases: [
        "intake",
        "research",
        "plan",
        "implement",
        "validate",
        "pr",
        "remediate",
        "merge",
      ],
      keying: "trailing",
      keyingScope: "fleet",
      intakeEnabled: true,
      advance: [
        {
          phase: "research",
          result: "ok",
          fromSlots: ["dispatch"],
          toSlot: "research",
          because: "research landed",
        },
        {
          phase: "merge",
          result: "ok",
          fromSlots: ["pr"],
          toSlot: null,
          because: "the merge webhook writes Done",
        },
      ],
    },
    thresholds: {
      scope: "fleet",
      parkAfterConsecutiveFailures: 3,
      remediateRoundCap: 3,
      remediateEscalatedRoundBudget: 1,
      remediateRewindBudget: 1,
      retryBackoffMs: [120_000, 300_000, 900_000],
      hostDailyWriteBudget: 3000,
    },
    merge: {
      policies: [
        "codex-attestation",
        "codex-attestation-strict",
        "checks-and-threads",
      ],
      defaultPolicy: "codex-attestation",
      repositories: [
        {
          repoId: "repo-api",
          owner: "hagale",
          name: "api",
          policy: "codex-attestation-strict",
          policySource: "repo",
        },
        {
          repoId: "repo-web",
          owner: "hagale",
          name: "web",
          policy: "checks-and-threads",
          policySource: "tenant",
        },
      ],
      reviewerLogin: "reviewer-bot[bot]",
      cleanPassShapes: [
        {
          kind: "reaction:+1",
          description:
            "a thumbs-up reaction from the reviewer bot at or after the head commit",
          honoured: true,
          ticket: null,
        },
        {
          kind: "comment:no-major-issues",
          description: "a terse no-major-issues comment",
          honoured: false,
          ticket: null,
        },
      ],
      cloudRemediateRequiredChecks: ["Check", "Check (full)"],
      prLabels: {
        queueReady: "queue:ready",
        handStepsHold: "hold:hand-steps",
        hold: "hold",
        preview: "hold:preview",
      },
    },
    readinessChecks: [
      { id: "oauth_scope", severity: "blocking", needsAnswer: true },
      { id: "token_live", severity: "blocking", needsAnswer: true },
      { id: "team_visible", severity: "blocking", needsAnswer: true },
      { id: "mapped_states_exist", severity: "blocking", needsAnswer: true },
      { id: "mapping_total", severity: "blocking", needsAnswer: true },
      { id: "types_compatible", severity: "blocking", needsAnswer: true },
      { id: "labels_present", severity: "degrading", needsAnswer: false },
      { id: "writes_land", severity: "blocking", needsAnswer: false },
      { id: "webhook_covers_team", severity: "degrading", needsAnswer: false },
      { id: "hosts_current", severity: "degrading", needsAnswer: false },
      { id: "environment_declared", severity: "degrading", needsAnswer: true },
      { id: "tools_resolvable", severity: "degrading", needsAnswer: true },
      { id: "reviewer_required", severity: "blocking", needsAnswer: true },
      {
        id: "reviewer_configured",
        severity: "informational",
        needsAnswer: false,
      },
    ],
    humans: [
      { linearUserId: "u-fixture-owner", role: "owner" },
      { linearUserId: "u-fixture-admin", role: "admin" },
    ],
    asks: { approvalsTeamId: "team-eng" },
  };
}
