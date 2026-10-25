// fixture.ts — an in-process fixture cloud: /api/v1/me as before, plus the contract route (ETag, 304,
// 403 for a workstation key), the read routes the verbs use, and every POST agent route the fixture
// contract's route table names, recorded into `writes[]`. `requests[]` records every request so a test
// can assert a header was sent; `budgetExhausted` turns the agent POSTs into 429s naming the budget.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { TenantContract } from "../src/contract-types";
import { buildFixtureContract, FIXTURE_ACCOUNT, FIXTURE_ROUTE_PREFIX } from "./fixture-contract";

export const FIXTURE_ME_BODY = {
  account: FIXTURE_ACCOUNT,
  slug: "hagale-technologies",
  name: "Hagale Technologies",
  permissions: ["mirror:read", "mirror:feed"],
  principal: "service",
} as const;

export const FIXTURE_KEY = "fixture-key";
export const FIXTURE_USER_KEY = "fixture-user-key";
/** The person behind FIXTURE_USER_KEY, as the cloud names them on /me since CTC-2076. */
export const FIXTURE_ME_USER = {
  id: "d1-user-tony",
  label: "Tony",
  email: "tony@example.test",
  role: "admin",
  linearUserId: "linear-user-tony",
} as const;
export const FIXTURE_ETAG = '"fixture-etag-1"';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  contract: TenantContract;
  contractVersion: string;
  headCursor: number;
  /** The oldest seq still in the change log. A `since` below `minRetainedCursor - 1` was evicted and
   *  is answered with the 409 resync envelope, exactly as the mirror's `buildChanges` does. */
  minRetainedCursor: number;
  /** CTC-2499 — when set, the full-seed branch of `/api/v1/snapshot` (not the `head=1` probe) answers
   *  this HTTP status instead of the NDJSON body, so a test can drive a replica writer's snapshot pull
   *  into a real, repeated failure. */
  snapshotStatus?: number;
  /** CTC-6569 — when set, the full-seed branch of `/api/v1/snapshot` waits this many ms before it
   *  answers, the way the mirror prepares a large workspace's snapshot before its first byte. */
  snapshotDelayMs?: number;
  budgetExhausted: boolean;
  /** CTC-1953/CTC-1954 ship ahead of some tenants' mirror; `false` makes those two routes 404 the
   *  way an older cloud does, so the bundle's "needs a newer cloud" path meets a real 404. */
  routesDeployed: boolean;
  /** CTC-6204 — when set, GET /api/v1/coding-accounts answers these rows instead of CODING_ACCOUNTS. */
  codingAccounts?: unknown[];
  /** CTC-4744 — when set, GET /api/v1/agent/tenant/readiness?team=<id> answers 200 and calls this,
   *  the way the cloud's read-through recomputes an expired verdict. Unset, the route is a 404. */
  readinessRead?: (teamId: string) => void;
  /** CTC-4744 — the cloud's ETag hashes the whole contract, so a refreshed verdict changes it. */
  contractEtagSuffix?: string;
  /** Simulate a cloud older than CTC-2076 that still refuses a personal key on the contract. */
  contractRefusesPersonalKey?: boolean;
  /** Override the person /me names for FIXTURE_USER_KEY; `null` sends no user block at all. */
  meUser?:
    | typeof FIXTURE_ME_USER
    | {
        id: string;
        label: string;
        email: string | null;
        role: string;
        linearUserId: string | null;
      }
    | null;
  /** CTC-5399 — when set, /api/v1/me answers THIS refusal (status + JSON body) before the key
   *  table: the person is signed in but has no workspace behind them, so the cloud refuses with
   *  403 `jwt-org-unmapped` on the identity read. */
  meRefusal?: { status: number; body: unknown };
  /** CTC-5871 — when set, an agent write POST answers what this returns (after it is recorded in
   *  `writes`); `undefined` falls through to the default 200. */
  agentWriteReply?: (name: string, body: unknown) => { status: number; body: unknown } | undefined;
  writes: RecordedRequest[];
  requests: RecordedRequest[];
  /** Override the issue list the read routes serve. */
  issues: Record<string, unknown>[];
  /** Override the pull list the read routes serve; falls back to the module-level `PULLS`. */
  pulls?: Record<string, unknown>[];
  /** The server-side page cap the keyset routes (`/issues`, `/pulls`) enforce (production: 500). */
  pageCap?: number;
  /** CTC-4556 — serve `/issues` as a mirror before `state_name` and `x-mirror-scope`: team and
   *  state params narrow nothing and no scope header is sent. */
  legacyIssueScope?: boolean;
  /** CTC-7158 — serve `/pulls` as a mirror before the state, repo and draft facets: they narrow
   *  nothing. */
  legacyPullFacets?: boolean;
  /** CTC-7158 — the ticket read's `linked_pulls`, per identifier, instead of the ENG-2 default. */
  linkedPulls?: Record<string, { repo_id: string; number: number; node_id: string }[]>;
  /** A whole `/api/v1/work-eligibility` body served for one team key instead of the ENG fixture. */
  eligibilityByTeam: Record<string, Record<string, unknown>>;
  /** The contract's `ticket-release` route answers this (status + body) when set; `{outcome: "released"}` otherwise. */
  release?: { status: number; body: unknown };
  /** The contract's `ticket-release-class` route answers this when set. */
  releaseClass?: { status: number; body: unknown };
  /** CTC-3550 — `POST <prefix>/registry/pull-credential` answers this (status + body) when set; 404 otherwise. */
  pullCredential?: { status: number; body: unknown };
  /** CTC-2545 — the account-scope environment declaration, as a REAL little state machine rather than
   *  a canned body: propose bumps a revision and a hash, approve is a compare-and-set against them.
   *  A canned pair would let a verb that approved the wrong revision pass, which is the one thing
   *  the CAS exists to catch. `environmentForced` overrides it for the refusal shapes it cannot reach. */
  accountEnvironment: {
    current: {
      revision: number;
      canonicalHash: string;
      declaration: unknown;
      proposedBy: string;
    } | null;
    approved: { revision: number; canonicalHash: string } | null;
    unresolvedReferences: string[];
  };
  /** CTC-3549 — the repo secret store behind `/me/secrets` and `/me/secrets/import`: what was stored
   *  (keyed `owner/name:NAME`, value kept only so a test can assert the stored value), the audit
   *  `source` each write declared, the approved declaration's secret names, and the caller's seat. */
  secrets: {
    stored: Map<
      string,
      { value: string; version: number; source: string | null }
    >;
    repos: string[];
    declared: string[] | null;
    role: "admin" | "owner" | "member";
    /** `false` answers 401 to a bearer, the way a cloud that predates CTC-3549 does. */
    deployed: boolean;
  };
  /** Force one raw answer for the next environment call, by verb (e.g. a 400 invalid_declaration). */
  environmentForced?: Partial<
    Record<"read" | "propose" | "approve", { status: number; body: unknown }>
  >;
  /** Fields merged over the fixture execution report, for the renderer's null and park branches. */
  execution?: Record<string, unknown>;
  /** CTC-2112 — the WorkOS device-flow fixture: the discovery doc, the fake `authorize/device` and
   *  `authenticate`/refresh token endpoints, and the knobs a test turns to force each branch. */
  oauth: OauthFixture;
}

export interface OauthFixture {
  clientId: string;
  /** How many `authorization_pending` polls to answer before the token pair. */
  pendingPolls: number;
  /** Answer the FIRST poll with `slow_down` (before the pending countdown). */
  slowDownOnce: boolean;
  /** Answer the device grant with `access_denied` / `expired_token` instead of a token. */
  denied: boolean;
  expired: boolean;
  /** `expires_in` the device-authorize response advertises (the poll's own deadline). Default 300. */
  deviceExpiresIn: number;
  /** CTC-2136: the next N device codes minted answer `expired_token` (counts down per mint); a later
   *  one proceeds normally. Safe on a server shared across tests. */
  expireNextCodes: number;
  /** CTC-2136: leave `verification_uri_complete` out of the device-authorize response. */
  omitVerificationUriComplete: boolean;
  /** Answer the first N device-code polls with this transient status (408/429/5xx) — retried, not fatal. */
  pollTransientStatus: number | null;
  pollTransientTimes: number;
  /** Answer a refresh with `invalid_grant` (revoked / inactive session). */
  refreshInvalidGrant: boolean;
  /** Answer the first N refreshes with this status (429/5xx) before rotating. */
  refreshFailStatus: number | null;
  refreshFailTimes: number;
  /** Access-token lifetime baked into the minted JWT's `exp`, in seconds. The probe showed 300s
   *  today, 900s once the 15-min duration is set — the bundle must read `exp`, never hard-code it. */
  accessTokenTtlSec: number;
  /** The `sid` claim the minted JWT carries, and the config's `sessionId`. */
  sessionId: string;
  /** The `role` claim baked into the JWT. The probe showed this is UNRELIABLE (a D1 admin's token
   *  said "member"), so the bundle must read the role from /me.user.role, never from the token. */
  jwtRole: string;
  /** Grace-window replay: a refresh answers 200 echoing the SAME refresh token it was given (a
   *  consumed token replayed inside the grace window). The bundle must accept this, not error. */
  refreshEchoesToken: boolean;
  // ── counters the tests read ──
  deviceAuthorizeCount: number;
  tokenPollCount: number;
  refreshCount: number;
  /** Every access token the fixture has minted; any of them authenticates as the person. */
  issuedAccessTokens: Set<string>;
  lastRefreshToken: string | null;
  // ── CTC-2136 bookkeeping: which minted codes expire, and how far into a chain of expiries we are ──
  expiringDeviceCodes: Set<string>;
  /** 0 for a fresh login's first code; +1 for each code minted right after one that expired. */
  mintChain: number;
  lastMintExpired: boolean;
}

// ── the tenant's data ─────────────────────────────────────────────────────────────────────────────

function issue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `lin-${String(over.identifier).toLowerCase()}`,
    title: `Title of ${over.identifier}`,
    state: "Todo",
    state_id: null,
    state_type: null,
    assignee: null,
    assignee_id: null,
    assignee_name: null,
    assignee_avatar_url: null,
    priority: 3,
    estimate: null,
    project_id: null,
    cycle_id: null,
    team_id: "team-eng",
    sort_order: null,
    updated_at: 1_756_100_000_000,
    labels: [],
    relations: [],
    ...over,
  };
}

export function fixtureIssues(): Record<string, unknown>[] {
  return [
    issue({ identifier: "ENG-1", priority: 2, project_id: "proj-a" }),
    issue({
      identifier: "ENG-2",
      state: "In Progress",
      priority: 1,
      project_id: "proj-a",
    }),
    issue({ identifier: "ENG-3", priority: 4 }),
    issue({
      identifier: "ENG-7",
      title: "Should we ship the widget now or after the audit?",
      // Assigned to the person FIXTURE_USER_KEY names, so "what needs me" has one ask that is theirs.
      assignee_id: FIXTURE_ME_USER.linearUserId,
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [
        {
          type: "blocks",
          issue_identifier: "ENG-7",
          related_identifier: "ENG-1",
        },
        {
          type: "blocks",
          issue_identifier: "ENG-7",
          related_identifier: "ENG-2",
        },
      ],
    }),
    issue({
      identifier: "ENG-8",
      title: "Which region?",
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [
        {
          type: "blocks",
          issue_identifier: "ENG-8",
          related_identifier: "ENG-3",
        },
      ],
    }),
    issue({
      identifier: "ENG-9",
      title: "Old decision",
      state: "Done",
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [
        {
          type: "blocks",
          issue_identifier: "ENG-9",
          related_identifier: "ENG-1",
        },
      ],
    }),
    issue({ identifier: "OPS-1", team_id: "team-ops", project_id: "proj-b" }),
  ];
}

/** N throwaway issues (`ENG-1`..`ENG-N`) for pagination tests that need a scope bigger than the
 *  server's page cap. Unlabelled and unrelated — a test that combines these with `fixtureIssues()`
 *  relies on the latter's ENG-7/ENG-8 ask rows being the only labelled ones in the combined scope. */
export function manyIssues(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    issue({ identifier: `ENG-${i + 1}` }),
  );
}

function fixtureBlockers(row: Record<string, unknown>, issues: Record<string, unknown>[]) {
  return issues.filter((candidate) => {
    const terminal = candidate.state_type != null
      ? ["completed", "canceled", "duplicate"].includes(String(candidate.state_type))
      : ["done", "canceled", "cancelled", "duplicate"].includes(String(candidate.state).toLowerCase());
    return !terminal && Array.isArray(candidate.relations) && candidate.relations.some(
      (relation) => relation?.type === "blocks" && relation.related_identifier === row.identifier,
    );
  }).map((candidate) => {
    const names = Array.isArray(candidate.labels) ? candidate.labels.map((label) => label.name) : [];
    return {
      identifier: candidate.identifier,
      title: candidate.title,
      state: candidate.state,
      is_ask: names.some((name) => name === "catalyst-ask" || String(name).startsWith("ask/")),
      is_approval: names.includes("ask/approval"),
      is_decided: false,
      unresolved: false,
      assignee_id: candidate.assignee_id ?? null,
      assignee_name: candidate.assignee_name ?? candidate.assignee ?? null,
    };
  });
}

function issueDetail(
  row: Record<string, unknown>,
  issues: Record<string, unknown>[],
  linkedPulls?: FixtureServer["linkedPulls"],
): Record<string, unknown> {
  return {
    ...row,
    description: `Description of ${row.identifier}`,
    team_key: null,
    team_name: null,
    project_name: row.project_id ? `Project ${row.project_id}` : null,
    project_state: row.project_id ? "started" : null,
    project_description: null,
    project_progress: null,
    project_health: null,
    cycle_name: null,
    cycle_number: null,
    cycle_starts_at: null,
    cycle_ends_at: null,
    delegate_id: null,
    delegate_name: null,
    delegate_avatar_url: null,
    bot_actor_name: null,
    bot_actor_type: null,
    bot_actor_sub_type: null,
    parent_id: null,
    parent_identifier: null,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    created_at: 1_756_000_000_000,
    due_date: null,
    priority_label: null,
    url: `https://linear.app/hagale/issue/${row.identifier}`,
    comments: [
      {
        id: `c-${row.identifier}-1`,
        body: "first comment",
        author_id: "u-1",
        author_name: "Ana",
        author_avatar_url: null,
        is_bot: 0,
        parent_id: null,
        updated_at: 1_756_100_000_000,
      },
    ],
    activity: [],
    linked_pulls:
      linkedPulls?.[String(row.identifier)] ??
      (row.identifier === "ENG-2"
        ? [{ repo_id: "repo-api", number: 41, node_id: "PR_kwDOfixture41" }]
        : []),
    agent_sessions: [],
    blocked_by: fixtureBlockers(row, issues),
  };
}

const PULLS: Record<string, unknown>[] = [
  {
    repo_id: "repo-api",
    number: 41,
    node_id: "PR_kwDOfixture41",
    title: "ENG-2: implement the thing",
    body: "",
    author_login: "catalyst[bot]",
    author_avatar_url: null,
    state: "open",
    draft: 0,
    merged: 0,
    merged_at: null,
    head_sha: "abc123",
    base_ref: "main",
    mergeable: 1,
    mergeable_state: "clean",
    auto_merge: null,
    created_at: 1_756_000_000_000,
    closed_at: null,
    comment_count: 1,
    milestone_title: null,
    updated_at: 1_756_100_000_000,
    linear_issue_identifier: "ENG-2",
    checks: [{ name: "Check", status: "completed", conclusion: "success" }],
  },
];

const WORKFLOW_STAGES = {
  teams: [
    {
      teamId: "team-eng",
      key: "ENG",
      states: [
        {
          id: "state-backlog-eng",
          name: "Backlog",
          type: "backlog",
          position: 0,
        },
        { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-intake", name: "Intake", type: "unstarted", position: 2 },
        {
          id: "state-research",
          name: "Research",
          type: "started",
          position: 3,
        },
        { id: "state-plan", name: "Plan", type: "started", position: 4 },
        {
          id: "state-implement",
          name: "In Progress",
          type: "started",
          position: 5,
        },
        {
          id: "state-remediate",
          name: "Remediate",
          type: "started",
          position: 6,
        },
        { id: "state-verify", name: "Validate", type: "started", position: 7 },
        { id: "state-pr-x7", name: "In Review", type: "started", position: 8 },
        { id: "state-done", name: "Done", type: "completed", position: 9 },
        {
          id: "state-canceled",
          name: "Canceled",
          type: "canceled",
          position: 10,
        },
      ],
    },
    {
      teamId: "team-ops",
      key: "OPS",
      states: [
        {
          id: "state-backlog-ops",
          name: "Backlog",
          type: "backlog",
          position: 0,
        },
        { id: "state-ops-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-ops-done", name: "Done", type: "completed", position: 2 },
      ],
    },
  ],
};

const ELIGIBILITY = {
  team: "ENG",
  nowMs: 1_756_100_000_000,
  eligibility: {
    rows: [
      {
        position: 1,
        ticket: "ENG-1",
        status: "offered",
        phase: "research",
        advisories: [],
        failure: null,
      },
      {
        position: 2,
        ticket: "ENG-2",
        status: "excluded",
        reason: "retry_backoff",
        advisories: ["human_addressed_unlabeled_ask_suspect"],
        failure: {
          phase: "implement",
          class: "vendor_5xx",
          attempts: 2,
          lastFailedAt: 1_756_099_000_000,
        },
      },
      {
        position: 3,
        ticket: "ENG-3",
        status: "excluded",
        reason: "frobnicate_pending",
        advisories: [],
        failure: null,
      },
    ],
  },
};

const DISPATCH_QUEUE = {
  team: "ENG",
  source: "self-derived",
  rows: [{ position: 1, ticket: "ENG-1", phase: "research" }],
};
const FLEET_ACTIVITY = {
  rows: [
    { ticket: "ENG-2", phase: "implement", host: "runner-7", state: "running" },
  ],
};
const AGENT_ROSTER = { roster: [{ role: "concierge", session: "sess-1" }] };
const LEASES = {
  attributions: [{ ticket: "ENG-2", phase: "implement", holder: "runner-7" }],
};

/** CTC-1953's `TenantWireAccount` projection — the safe fields only. */
const CODING_ACCOUNTS = [
  {
    accountSlot: "slot-a",
    provider: "claude",
    harness: "claude-code",
    label: "primary",
    declaredState: "active",
    observedState: "healthy",
    observedStatus: "working",
    status: "active",
    window5h: { usedPercent: 12, resetsAtMs: 1_756_200_000_000 },
    window7d: { usedPercent: 40, resetsAtMs: 1_756_700_000_000 },
    bindingWindow: "7d",
    bindingUsedPercent: 40,
    bindingResetsAtMs: 1_756_700_000_000,
    usageObservedAtMs: 1_756_100_000_000,
    lastPolledAtMs: 1_756_100_000_000,
    walled: false,
    quarantined: false,
    quarantineReason: null,
    liveHoldsCount: 1,
    liveHolds: [
      {
        ticket: "ENG-2",
        phase: "implement",
        leaseDeadlineMs: 1_756_100_600_000,
      },
    ],
    revokedAtMs: null,
  },
  {
    accountSlot: "slot-b",
    provider: "codex",
    harness: "codex-cli",
    label: null,
    declaredState: "active",
    observedState: "healthy",
    observedStatus: "walled",
    status: "walled",
    window5h: { usedPercent: 100, resetsAtMs: 1_756_200_000_000 },
    window7d: { usedPercent: 100, resetsAtMs: 1_756_700_000_000 },
    bindingWindow: "5h",
    bindingUsedPercent: 100,
    bindingResetsAtMs: 1_756_200_000_000,
    usageObservedAtMs: 1_756_100_000_000,
    lastPolledAtMs: 1_756_100_000_000,
    walled: true,
    quarantined: false,
    quarantineReason: null,
    liveHoldsCount: 0,
    liveHolds: [],
    revokedAtMs: null,
  },
];

/** CTC-1954's `TicketExecutionReport`, trimmed to the fields the bundle renders. */
const TICKET_EXECUTION = {
  ticket: "ENG-2",
  observedAtMs: 1_756_100_000_000,
  attemptHistory: "latest-per-phase",
  hasLadderHistory: true,
  phases: [
    {
      phase: "research",
      attempt: 1,
      status: "completed",
      lastFailureClass: null,
      consecutiveFailures: null,
    },
    {
      phase: "implement",
      attempt: 2,
      status: "cooling",
      lastFailureClass: "vendor_5xx",
      consecutiveFailures: 1,
    },
  ],
  failure: {
    phase: "implement",
    failureMode: "vendor_5xx",
    failureDetail: "upstream 503",
    summary: null,
    attempt: 2,
  },
  remediate: { roundsDispatched: 1, cap: 3 },
  park: null,
  lease: [
    {
      phase: "implement",
      holder: "runner-7",
      generation: 4,
      deadlineMs: 1_756_100_600_000,
    },
  ],
  lastAdvance: {
    phase: "research",
    nonce: 1,
    toSlot: "plan",
    toStateId: "state-plan",
    landed: true,
  },
  governors: [
    {
      kind: "phase_park",
      phase: "implement",
      sentinel: "parked:repeated_failure",
      heldAtMs: 1_756_099_000_000,
      failureClass: "vendor_5xx",
      escalationSpent: false,
      release:
        "catalyst-skills release ENG-2 once its cause is fixed (it refuses a cause the mirror cannot see change unless you say what changed)",
    },
    {
      kind: "human_owned_pr",
      phase: "remediate",
      heldAtMs: 1_756_099_500_000,
      prNumber: 41,
      authorLogin: "ana",
      release:
        "PR #41 by ana is a person's; close or merge it (or hand it to Catalyst), which releases this automatically",
    },
  ],
  releases: [
    {
      id: 2,
      ticket: "ENG-2",
      atMs: 1_756_100_800_000,
      actor: { kind: "user", id: "user-ana", keyId: "key-ana", tier: "user" },
      via: "ticket",
      because: "retry after the outage",
      retryUnchanged: true,
      outcome: "refused",
      governors: [],
      released: [],
      refused: [
        {
          governor: "human_owned_pr",
          phase: "remediate",
          code: "human_owned_pr",
          humanAction: "close or merge PR #41",
        },
      ],
      evidence: {
        branchPushAtMs: null,
        humanCommentAtMs: null,
        mainPushAtMs: null,
      },
      warnings: [],
    },
    {
      id: 1,
      ticket: "ENG-2",
      atMs: 1_756_099_800_000,
      actor: {
        kind: "key",
        id: "ak_host",
        keyId: "ak_host",
        tier: "organization",
      },
      via: "ticket",
      because: "secret rotated",
      retryUnchanged: false,
      outcome: "released",
      governors: [],
      released: [{ governor: "phase_park", phase: "implement", op: "unpark" }],
      refused: [],
      evidence: {
        branchPushAtMs: 1_756_099_700_000,
        humanCommentAtMs: null,
        mainPushAtMs: null,
      },
      warnings: [],
    },
  ],
  unreadable: [],
};

// ── the server ───────────────────────────────────────────────────────────────────────────────────

interface KeysetPageResult {
  rows: Record<string, unknown>[];
  total: number;
  headers: Record<string, string>;
  bad?: string;
}

/** One keyset page, exactly as the mirror builds it: `limit` clamped to the server's page cap
 *  (`state.pageCap`, default 500), `X-Mirror-Total` set to the WHOLE scope's count, and
 *  `X-Mirror-Next-Cursor` present ONLY when rows remain past this page — absent, not empty, on the
 *  last one. The cursor is opaque to the client, so its encoding here is deliberately arbitrary. */
function keysetPage(
  rows: Record<string, unknown>[],
  url: URL,
  state: FixtureServer,
  route: string,
): KeysetPageResult {
  const total = rows.length;
  const requested = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(
    Math.max(1, Number.isFinite(requested) ? requested : 100),
    state.pageCap ?? 500,
  );
  const after = url.searchParams.get("after");
  let start = 0;
  if (after !== null) {
    const decoded = Number(
      Buffer.from(after, "base64url").toString("utf8").split("|")[0] ?? "",
    );
    if (!Number.isInteger(decoded) || decoded < 0) {
      return {
        rows: [],
        total,
        headers: {},
        bad: `invalid ?after= cursor for ${route}`,
      };
    }
    start = decoded;
  }
  const page = rows.slice(start, start + limit);
  const end = start + page.length;
  const headers: Record<string, string> = {
    "x-mirror-cursor": String(state.headCursor),
    "x-mirror-total": String(total),
  };
  if (end < total) {
    headers["x-mirror-next-cursor"] = Buffer.from(`${end}|`, "utf8").toString(
      "base64url",
    );
  }
  return { rows: page, total, headers };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => resolve(raw));
  });
}

/** Routes that act AS a host and refuse a personal key by class (CTC-2076's keep-list). None of the
 *  bundle's own verbs touch one; the set stays so a verb that grows onto a host route reddens here. */
const HOST_ONLY = new Set([
  "/api/v1/work/acquire",
  "/api/v1/artifacts/publish",
  "/api/v1/coordination/publish",
  "/api/v1/events/stream",
]);

export async function startMeFixture(
  handler?: (path: string) => { status: number; body: unknown },
): Promise<FixtureServer> {
  const state: FixtureServer = {
    url: "",
    port: 0,
    close: async () => {},
    contract: buildFixtureContract(),
    contractVersion: "1.0.0",
    headCursor: 10,
    minRetainedCursor: 4,
    budgetExhausted: false,
    routesDeployed: true,
    writes: [],
    requests: [],
    issues: fixtureIssues(),
    eligibilityByTeam: {},
    accountEnvironment: {
      current: null,
      approved: null,
      unresolvedReferences: [],
    },
    secrets: {
      stored: new Map(),
      repos: ["acme/app"],
      declared: null,
      role: "admin",
      deployed: true,
    },
    oauth: {
      clientId: "client_fixture",
      pendingPolls: 0,
      slowDownOnce: false,
      denied: false,
      expired: false,
      deviceExpiresIn: 300,
      expireNextCodes: 0,
      omitVerificationUriComplete: false,
      pollTransientStatus: null,
      pollTransientTimes: 0,
      refreshInvalidGrant: false,
      refreshFailStatus: null,
      refreshFailTimes: 0,
      accessTokenTtlSec: 900,
      sessionId: "session_fixture",
      jwtRole: "member",
      refreshEchoesToken: false,
      deviceAuthorizeCount: 0,
      tokenPollCount: 0,
      refreshCount: 0,
      issuedAccessTokens: new Set<string>(),
      lastRefreshToken: null,
      expiringDeviceCodes: new Set<string>(),
      mintChain: 0,
      lastMintExpired: false,
    },
  };
  const postRoutes = () =>
    new Set(
      state.contract.routes
        .filter((r) => r.method === "POST")
        .map((r) => r.path),
    );
  // CTC-2545 — the environment paths the fixture SERVES are read off the contract it serves, so the
  // fixture and the CLI agree by construction and a test that passes proves the CLI discovered them.
  const envBase = () =>
    state.contract.routes.find(
      (r) =>
        r.method === "GET" &&
        r.path.split("/").filter(Boolean).at(-1) === "account-environment",
    )?.path ?? null;

  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  /** A JWT the bundle only ever DECODES (never verifies): `exp` drives the refresh clock, `sid` the
   *  session id. Each mint is unique so rotation produces a genuinely new bearer. */
  const mintJwt = (): string => {
    const iat = Math.floor(Date.now() / 1000);
    // The staging probe's exact claim set (ctc-2080-device-probe-facts.json): a client-scoped issuer,
    // NO `aud`, and a `role` the bundle must ignore in favour of /me.user.role.
    const payload = {
      iss: `https://api.workos.com/user_management/${state.oauth.clientId}`,
      sub: FIXTURE_ME_USER.id,
      sid: state.oauth.sessionId,
      jti: `jwt-${state.oauth.issuedAccessTokens.size}`,
      auth_time: iat,
      client_id: state.oauth.clientId,
      org_id: FIXTURE_ACCOUNT,
      role: state.oauth.jwtRole,
      roles: [state.oauth.jwtRole],
      permissions: ["mirror:read", "mirror:feed"],
      exp: iat + state.oauth.accessTokenTtlSec,
      iat,
    };
    const token = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
    state.oauth.issuedAccessTokens.add(token);
    return token;
  };

  const server: Server = createServer(async (req, res) => {
    // Close every fixture socket so a busy suite cannot reuse an expired idle connection.
    res.setHeader("connection", "close");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const auth = req.headers.authorization ?? null;
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let body: unknown = undefined;
    if (rawBody) {
      const ctype = String(req.headers["content-type"] ?? "");
      if (ctype.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(rawBody));
      } else {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
    }
    state.requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      body,
    });
    const send = (
      status: number,
      payload: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    // ── CTC-2112: the WorkOS device-flow fixture (unauthenticated, before the bearer guard) ──
    const o = state.oauth;
    if (path === "/api/v1/auth/cli") {
      return send(200, {
        clientId: o.clientId,
        issuer: `${state.url}/oauth`,
        deviceAuthorizationUrl: `${state.url}/oauth/device`,
        tokenUrl: `${state.url}/oauth/token`,
        jwksUrl: `${state.url}/oauth/jwks`,
      });
    }
    if (path === "/oauth/device") {
      o.deviceAuthorizeCount += 1;
      // CTC-2136: a code minted right after one that expired is the next in its chain, so a re-minted
      // login shows WXYZ-1235, WXYZ-1236…; a fresh login's first code is always WXYZ-1234.
      o.mintChain = o.lastMintExpired ? o.mintChain + 1 : 0;
      const deviceCode = `device-code-fixture-${o.deviceAuthorizeCount}`;
      o.lastMintExpired = o.expired || o.expireNextCodes > 0;
      if (o.expireNextCodes > 0) {
        o.expireNextCodes -= 1;
        o.expiringDeviceCodes.add(deviceCode);
      }
      const userCode = `WXYZ-${1234 + o.mintChain}`;
      return send(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${state.url}/activate`,
        ...(o.omitVerificationUriComplete
          ? {}
          : {
              verification_uri_complete: `${state.url}/activate?user_code=${userCode}`,
            }),
        expires_in: o.deviceExpiresIn,
        interval: 5,
      });
    }
    if (path === "/oauth/token") {
      const grant = (body as { grant_type?: string } | undefined)?.grant_type;
      if (grant === "refresh_token") {
        o.refreshCount += 1;
        o.lastRefreshToken =
          (body as { refresh_token?: string }).refresh_token ?? null;
        if (o.refreshInvalidGrant)
          return send(400, {
            error: "invalid_grant",
            error_description: "refresh token revoked",
          });
        if (o.refreshFailStatus !== null && o.refreshFailTimes > 0) {
          o.refreshFailTimes -= 1;
          return send(o.refreshFailStatus, { error: "server_error" });
        }
        // Grace-window replay: WorkOS answers 200 with the SAME pair when a consumed refresh token is
        // replayed inside the grace window. Echo the incoming refresh token; still mint a valid access.
        const rotated = o.refreshEchoesToken
          ? (o.lastRefreshToken ?? `refresh-${o.refreshCount + 1}`)
          : `refresh-${o.refreshCount + 1}`;
        return send(200, {
          access_token: mintJwt(),
          refresh_token: rotated,
          token_type: "Bearer",
        });
      }
      // device_code grant. Transient failures are answered FIRST and do NOT advance the pending
      // countdown — the bundle must retry them, not exit.
      if (o.pollTransientStatus !== null && o.pollTransientTimes > 0) {
        o.pollTransientTimes -= 1;
        return send(o.pollTransientStatus, { error: "server_error" });
      }
      o.tokenPollCount += 1;
      if (o.denied)
        return send(400, {
          error: "access_denied",
          error_description: "the request was denied",
        });
      if (o.expired)
        return send(400, {
          error: "expired_token",
          error_description: "the device code expired",
        });
      if (
        o.expiringDeviceCodes.has(
          String((body as { device_code?: string } | undefined)?.device_code),
        )
      ) {
        return send(400, {
          error: "expired_token",
          error_description: "the device code expired",
        });
      }
      if (o.slowDownOnce && o.tokenPollCount === 1)
        return send(400, { error: "slow_down" });
      const pendingAnswered = o.slowDownOnce
        ? o.tokenPollCount - 1
        : o.tokenPollCount;
      if (pendingAnswered <= o.pendingPolls)
        return send(400, { error: "authorization_pending" });
      return send(200, {
        access_token: mintJwt(),
        refresh_token: "refresh-1",
        token_type: "Bearer",
        authentication_method: "device_code",
        user: { id: FIXTURE_ME_USER.id, email: FIXTURE_ME_USER.email },
        organization_id: FIXTURE_ACCOUNT,
      });
    }

    const isOauthPerson =
      auth !== null &&
      auth.startsWith("Bearer ") &&
      o.issuedAccessTokens.has(auth.slice("Bearer ".length));
    if (path.startsWith("/api/v1/me")) {
      if (state.meRefusal) return send(state.meRefusal.status, state.meRefusal.body);
      const out =
        handler?.(req.url ?? path) ??
        (auth === `Bearer ${FIXTURE_KEY}`
          ? { status: 200, body: FIXTURE_ME_BODY }
          : auth === `Bearer ${FIXTURE_USER_KEY}` || isOauthPerson
            ? {
                status: 200,
                body: {
                  ...FIXTURE_ME_BODY,
                  permissions: ["mirror:read", "mirror:feed"],
                  ...(state.meUser === null
                    ? {}
                    : { user: state.meUser ?? FIXTURE_ME_USER }),
                },
              }
            : {
                status: 401,
                body: {
                  error: "unauthorized",
                  reason: "credential-not-accepted",
                },
              });
      return send(out.status, out.body);
    }
    if (
      auth !== `Bearer ${FIXTURE_KEY}` &&
      auth !== `Bearer ${FIXTURE_USER_KEY}` &&
      !isOauthPerson
    ) {
      return send(401, {
        error: "unauthorized",
        reason: "credential-not-accepted",
      });
    }
    const machine = auth === `Bearer ${FIXTURE_KEY}`;
    if (HOST_ONLY.has(path) && !machine) {
      return send(403, { error: "forbidden", reason: "not-machine-principal" });
    }

    if (
      path === "/api/v1/agent/contract" &&
      state.contractRefusesPersonalKey &&
      !machine
    ) {
      return send(403, { error: "forbidden", reason: "not-machine-principal" });
    }
    if (path === "/api/v1/agent/tenant/readiness" && state.readinessRead) {
      const team = url.searchParams.get("team") ?? "";
      state.readinessRead(team);
      return send(200, { readiness: { teamId: team } });
    }
    if (path === "/api/v1/agent/contract") {
      const etag = FIXTURE_ETAG.replace(
        "1",
        state.contractVersion === "1.0.0" ? "1" : "2",
      ).replace(/"$/, `${state.contractEtagSuffix ?? ""}"`);
      if (req.headers["if-none-match"] === etag) {
        return send(304, undefined, {
          etag,
          "x-catalyst-contract-version": state.contractVersion,
        });
      }
      return send(
        200,
        { ...state.contract, contractVersion: state.contractVersion },
        {
          etag,
          "x-catalyst-contract-version": state.contractVersion,
          "cache-control": "private, no-cache",
        },
      );
    }
    if (path === "/api/v1/snapshot") {
      if (url.searchParams.get("head") === "1")
        return send(200, {
          accountId: FIXTURE_ACCOUNT,
          cursor: state.headCursor,
        });
      if (state.snapshotDelayMs !== undefined) await new Promise((r) => setTimeout(r, state.snapshotDelayMs));
      if (state.snapshotStatus !== undefined)
        return send(state.snapshotStatus, { error: "snapshot unavailable" });
      if (url.searchParams.get("account") !== FIXTURE_ACCOUNT)
        return send(403, { error: "account-mismatch" });
      // The full seed: NDJSON rows, then the cursor line; the head headers ride the response.
      const lines = state.issues.slice(0, 2).map((row) =>
        JSON.stringify({
          entity: "issues",
          op: "upsert",
          row: {
            id: row.id,
            identifier: row.identifier,
            title: row.title,
            state: row.state,
            team_id: row.team_id,
            updated_at: row.updated_at,
          },
        }),
      );
      lines.push(JSON.stringify({ cursor: state.headCursor }));
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-catalyst-head-seq": String(state.headCursor),
        "x-catalyst-server-time-ms": String(Date.now()),
      });
      return res.end(`${lines.join("\n")}\n`);
    }
    if (path === "/api/v1/freshness") {
      return send(200, {
        account: FIXTURE_ACCOUNT,
        last_reconcile_ms: 1_756_100_000_000,
        has_error: false,
        unproven_legs: [],
        server_time_ms: Date.now(),
      });
    }
    if (path === "/api/v1/issues") {
      // The mirror's contract (CTC-4556): `team_key` and `state_name` narrow, `team` and a state
      // name in `state` do not, and `x-mirror-scope` lists the params that narrowed.
      let rows = state.issues;
      const applied: string[] = [];
      // The mirror compares trimmed, lowercased names and nothing more: "In_Progress" is not "In Progress".
      const nameKey = (v: unknown) =>
        String(v ?? "")
          .trim()
          .toLowerCase();
      const teamKey = url.searchParams.get("team_key");
      const stateName = url.searchParams.get("state_name");
      const project = url.searchParams.get("project");
      if (teamKey && !state.legacyIssueScope) {
        rows = rows.filter(
          (r) =>
            nameKey(r.team_key ?? String(r.identifier).split("-")[0]) ===
            nameKey(teamKey),
        );
        applied.push("team_key");
      }
      if (stateName && !state.legacyIssueScope) {
        rows = rows.filter((r) => nameKey(r.state) === nameKey(stateName));
        applied.push("state_name");
      }
      if (project) {
        rows = rows.filter((r) => r.project_id === project);
        applied.push("project");
      }
      const p = keysetPage(rows, url, state, "/api/v1/issues");
      const headers = state.legacyIssueScope
        ? p.headers
        : { ...p.headers, "x-mirror-scope": applied.join(",") };
      return p.bad
        ? send(400, { error: p.bad })
        : send(200, { rows: p.rows, total: p.total }, headers);
    }
    const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const ref = decodeURIComponent(issueMatch[1]!);
      const row = state.issues.find(
        (r) => r.identifier === ref || r.id === ref,
      );
      return row
        ? send(200, issueDetail(row, state.issues, state.linkedPulls))
        : send(404, { error: "not found" });
    }
    if (path === "/api/v1/pulls") {
      // CTC-7158 — the mirror's facets (`MirrorDO.handlePulls`): `state` open|closed|merged, `repo`,
      // `draft` draft|ready; an unknown value narrows nothing, and there is NO ticket facet.
      let rows = state.pulls ?? PULLS;
      if (!state.legacyPullFacets) {
        const facet = url.searchParams.get("state");
        const merged = (p: Record<string, unknown>) => p.merged === 1 || p.merged === true;
        if (facet === "open") rows = rows.filter((p) => p.state === "open");
        if (facet === "merged") rows = rows.filter(merged);
        if (facet === "closed") rows = rows.filter((p) => p.state === "closed" && !merged(p));
        const repo = url.searchParams.get("repo");
        if (repo) rows = rows.filter((p) => p.repo_id === repo);
        const draft = url.searchParams.get("draft");
        if (draft === "draft") rows = rows.filter((p) => p.draft === 1 || p.draft === true);
        if (draft === "ready") rows = rows.filter((p) => !(p.draft === 1 || p.draft === true));
      }
      const p = keysetPage(rows, url, state, "/api/v1/pulls");
      return p.bad
        ? send(400, { error: p.bad })
        : send(200, { rows: p.rows, total: p.total }, p.headers);
    }
    const pullMatch = /^\/api\/v1\/pulls\/([^/]+)$/.exec(path);
    if (pullMatch) {
      const pr = (state.pulls ?? PULLS).find(
        (p) => p.node_id === decodeURIComponent(pullMatch[1]!),
      );
      return pr
        ? send(200, {
            ...pr,
            reviews: [
              {
                review_id: "r1",
                reviewer_name: "reviewer-bot[bot]",
                reviewer_avatar_url: null,
                state: "APPROVED",
                submitted_at: 1_756_100_000_000,
              },
            ],
            commit_statuses: [],
            blocked_on_ask: null,
          })
        : send(404, { error: "not found" });
    }
    if (path === "/api/v1/projects") {
      return send(200, {
        rows: [
          {
            id: "proj-a",
            name: "Project A",
            state: "started",
            updated_at: 1,
            initiatives: [],
          },
          {
            id: "proj-b",
            name: "Project B",
            state: "planned",
            updated_at: 1,
            initiatives: [],
          },
        ],
      });
    }
    if (path === "/api/v1/cycles")
      return send(200, {
        rows: [
          {
            id: "cyc-1",
            number: 12,
            name: "Cycle 12",
            starts_at: "2026-09-01",
            ends_at: "2026-09-14",
          },
        ],
      });
    if (path === "/api/v1/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      // The hub's real shape (read-model SearchView): four groups, not one `rows` list.
      const hit = (s: unknown) =>
        String(s ?? "")
          .toLowerCase()
          .includes(q);
      return send(200, {
        issues: state.issues
          .filter((r) => hit(r.title))
          .map((r) => ({ id: r.id, identifier: r.identifier, title: r.title })),
        pulls:
          q === "widget"
            ? [
                {
                  repo_id: "acme/app",
                  number: 41,
                  node_id: "PR_41",
                  title: "Widget pull",
                },
              ]
            : [],
        projects:
          q === "widget" ? [{ id: "proj-w", name: "Widget project" }] : [],
        initiatives:
          q === "widget" ? [{ id: "init-w", name: "Widget initiative" }] : [],
      });
    }
    // ⛔ The changefeed EVICTS. A cursor before the oldest retained seq is a 409
    // `{error:"cursor_underflow", resync:true}`, and one past the head is a 409
    // `{error:"cursor_ahead_of_head", resync:true, head}` — `buildChanges` in the mirror's
    // `do/changefeed.ts`. Both stamp `x-catalyst-head-seq` (CTC-137), which is the ONLY way a
    // caller learns a cursor that works. The fixture answered every `since` with a 200 until 0.2.1,
    // so `query changes --since 0` — the form the docs show — passed here and 409'd for any tenant
    // whose log had rotated.
    if (path === "/api/v1/changes") {
      const since = Number(url.searchParams.get("since") ?? "0");
      res.setHeader("x-catalyst-head-seq", String(state.headCursor));
      res.setHeader("x-catalyst-server-time-ms", String(Date.now()));
      if (since > state.headCursor)
        return send(409, {
          error: "cursor_ahead_of_head",
          resync: true,
          head: state.headCursor,
        });
      if (since < state.minRetainedCursor - 1)
        return send(409, { error: "cursor_underflow", resync: true });
      // ⛔ AND THE 200 IS NDJSON, NOT JSON — `buildChanges` ends in `streamNdjson`, one
      // `{accountId, seq, entity, entityId, op, row}` object per line. The fixture answered JSON, so
      // the CLI's `getJson` read fine here and could never read a real success: every 200 from a live
      // tenant came back "GET /api/v1/changes returned a non-JSON body". Nothing caught it because
      // `--since 0` 409s on a rotated feed before a 200 is ever reached.
      const lines =
        since < state.headCursor
          ? [
              JSON.stringify({
                accountId: FIXTURE_ACCOUNT,
                seq: since + 1,
                entity: "issues",
                entityId: "lin-eng-1",
                op: "upsert",
                row: { id: "lin-eng-1" },
              }),
            ]
          : [];
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-catalyst-head-seq": String(state.headCursor),
        "x-catalyst-server-time-ms": String(Date.now()),
      });
      return res.end(lines.length > 0 ? `${lines.join("\n")}\n` : "");
    }
    if (path === "/api/v1/workflow-stages") return send(200, WORKFLOW_STAGES);
    // CTC-1953 / CTC-1954 — the two tenant-facing routes the bundle reads. `routesDeployed: false`
    // makes the fixture answer 404 the way a tenant on an older mirror does, so the "needs a newer
    // cloud" path is tested against a real 404 rather than a mocked branch.
    if (path === "/api/v1/coding-accounts") {
      return state.routesDeployed
        ? send(200, { accounts: state.codingAccounts ?? CODING_ACCOUNTS })
        : send(404, { error: "not found" });
    }
    const executionMatch = /^\/api\/v1\/issues\/([^/]+)\/execution$/.exec(path);
    if (executionMatch) {
      if (!state.routesDeployed) return send(404, { error: "not found" });
      const ticket = decodeURIComponent(executionMatch[1]!);
      return send(200, {
        ...TICKET_EXECUTION,
        ...(state.execution ?? {}),
        ticket,
      });
    }
    if (path === "/api/v1/work-eligibility") {
      if (!url.searchParams.get("team"))
        return send(400, { error: "team is required" });
      const override =
        state.eligibilityByTeam[url.searchParams.get("team") ?? ""];
      if (override) return send(200, override);
      return send(200, {
        ...ELIGIBILITY,
        team: url.searchParams.get("team"),
        capabilities: url.searchParams.get("capabilities"),
      });
    }
    // ⛔ The team is REQUIRED, and the refusal is the mirror's own: a plain-text "bad team" 400 from
    // handleDispatchQueueCurrent, not JSON. The fixture answered 200 to a bare call until 0.2.1,
    // which is why `queue` with no --team passed here and 400'd against every real tenant.
    if (path === "/api/v1/dispatch-queue/current") {
      const team = url.searchParams.get("team");
      if (!team || !/^[A-Z][A-Z0-9]{1,9}$/.test(team)) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("bad team");
      }
      return send(200, { ...DISPATCH_QUEUE, team });
    }
    if (path === "/api/v1/fleet-activity/current")
      return send(200, FLEET_ACTIVITY);
    if (path === "/api/v1/agent-roster/current") return send(200, AGENT_ROSTER);
    // ⛔ Per (ticket, phase), and BOTH are required — `MirrorDO.handleLeaseAttributions` answers a
    // missing one with 400 `{error:"invalid_field", field}`. The fixture used to serve a bare call
    // 200, so `running`'s unconditional call looked fine in tests and 400'd for every tenant.
    if (path === "/api/v1/lease/attributions") {
      const ticket = url.searchParams.get("ticket");
      const phase = url.searchParams.get("phase");
      if (!ticket)
        return send(400, { error: "invalid_field", field: "ticket" });
      if (!phase) return send(400, { error: "invalid_field", field: "phase" });
      return send(200, { ticket, phase, ...LEASES });
    }

    if (req.method === "GET" && envBase() !== null && path === envBase()) {
      const forced = state.environmentForced?.read;
      if (forced) return send(forced.status, forced.body);
      const env = state.accountEnvironment;
      return send(200, {
        current: env.current,
        isApproved:
          env.approved !== null &&
          env.current !== null &&
          env.approved.revision === env.current.revision &&
          env.approved.canonicalHash === env.current.canonicalHash,
        approvedBy: env.approved === null ? null : FIXTURE_ME_USER.id,
        delivered: env.approved,
        unresolvedReferences: env.unresolvedReferences,
        audit: [],
      });
    }

    // CTC-3549 — the repo secret writes, on the browser's own paths, admitting a person's bearer.
    if (
      req.method === "POST" &&
      (path === "/me/secrets" || path === "/me/secrets/import")
    ) {
      const sec = state.secrets;
      if (!sec.deployed) return send(401, { error: "unauthorized" });
      if (machine)
        return send(403, {
          error: "personal_credential_required",
          message:
            "this route acts as a person: use your personal key (ctc_user_…) or a CLI login, not an account key",
        });
      state.writes.push({ method: "POST", path, headers: req.headers, body });
      if (sec.role === "member")
        return send(403, {
          error: "forbidden",
          message:
            "managing the organization's secrets requires an admin or owner role",
        });
      const b = (body ?? {}) as Record<string, unknown>;
      const repo = typeof b.repo === "string" ? b.repo : "";
      if (!sec.repos.includes(repo))
        return send(404, { error: "not_found", message: "no such repository" });
      const source = typeof b.source === "string" ? b.source : null;
      const held = (n: string) => sec.stored.has(`${repo}:${n}`);
      const put = (
        n: string,
        value: string,
      ): { version: number; created: boolean } => {
        const prior = sec.stored.get(`${repo}:${n}`);
        const version = (prior?.version ?? 0) + 1;
        sec.stored.set(`${repo}:${n}`, { value, version, source });
        return { version, created: prior === undefined };
      };
      const declared = () =>
        sec.declared === null
          ? null
          : {
              declared: [...sec.declared].sort(),
              missing: sec.declared.filter((n) => !held(n)).sort(),
            };
      if (path === "/me/secrets") {
        if (
          typeof b.name !== "string" ||
          typeof b.value !== "string" ||
          b.value === ""
        )
          return send(400, { error: "invalid_value" });
        const r = put(b.name, b.value);
        return send(r.created ? 201 : 200, {
          secret: { name: b.name, value: null },
          version: r.version,
          created: r.created,
          declared: declared(),
        });
      }
      const rotate = Array.isArray(b.rotateExisting)
        ? (b.rotateExisting as string[])
        : [];
      const created: string[] = [];
      const rotated: string[] = [];
      const errors: Array<{ name: string; reason: string }> = [];
      for (const line of String(b.text ?? "").split("\n")) {
        const m = /^\s*(?:export\s+)?([^=#\s]+)\s*=(.*)$/.exec(line);
        if (!m) continue;
        const [, n, v] = m as unknown as [string, string, string];
        if (held(n) && !rotate.includes(n)) {
          errors.push({ name: n, reason: "name_exists" });
          continue;
        }
        (put(n, v.trim()).created ? created : rotated).push(n);
      }
      return send(200, { created, rotated, errors, declared: declared() });
    }

    // CTC-3550 — the image download credential, ahead of the generic agent-POST branch so the write
    // budget and the canned `{id, ok}` reply never answer it. Tests opt in by adding the route.
    if (
      req.method === "POST" &&
      path === `${FIXTURE_ROUTE_PREFIX}/registry/pull-credential`
    ) {
      state.writes.push({ method: "POST", path, headers: req.headers, body });
      return state.pullCredential
        ? send(state.pullCredential.status, state.pullCredential.body)
        : send(404, { error: "not found" });
    }

    if (req.method === "POST" && postRoutes().has(path)) {
      if (state.budgetExhausted) {
        return send(
          429,
          {
            error: "write-budget-exhausted",
            reason: "the per-host daily write budget is exhausted",
          },
          { "retry-after": "3600" },
        );
      }
      state.writes.push({ method: "POST", path, headers: req.headers, body });
      const name = path.split("/").at(-1);
      const reply = state.agentWriteReply?.(name ?? "", body);
      if (reply) return send(reply.status, reply.body);
      if (name === "ticket-release") {
        const r = state.release ?? {
          status: 200,
          body: {
            ticket: (body as { ticket?: string })?.ticket,
            outcome: "released",
            dryRun: false,
            released: [],
            refused: [],
            warnings: [],
            auditId: 1,
          },
        };
        return send(r.status, r.body);
      }
      if (name === "ticket-release-class") {
        const r = state.releaseClass ?? {
          status: 200,
          body: {
            released: [],
            refused: [],
            nothingHeld: [],
            truncated: false,
          },
        };
        return send(r.status, r.body);
      }
      const base = envBase();
      if (base !== null && path === `${base}/propose`) {
        const forced = state.environmentForced?.propose;
        if (forced) return send(forced.status, forced.body);
        const env = state.accountEnvironment;
        const b = (body ?? {}) as {
          declaration?: unknown;
          expectedRevision?: number;
        };
        if (b.declaration === undefined)
          return send(400, {
            error: "invalid",
            message: "declaration is required",
          });
        const at = env.current?.revision ?? 0;
        if (b.expectedRevision !== undefined && b.expectedRevision !== at) {
          return send(409, {
            error: "conflict",
            message:
              "the declaration changed since you last read it — refresh and retry",
            currentRevision: at,
          });
        }
        if (
          env.current !== null &&
          JSON.stringify(env.current.declaration) ===
            JSON.stringify(b.declaration)
        ) {
          return send(200, { status: "unchanged", state: env.current });
        }
        const created = env.current === null;
        const revision = at + 1;
        env.current = {
          revision,
          canonicalHash: `sha-${revision}`,
          declaration: b.declaration,
          proposedBy: FIXTURE_ME_USER.id,
        };
        return send(created ? 201 : 200, {
          status: created ? "created" : "updated",
          state: env.current,
        });
      }
      if (base !== null && path === `${base}/approve`) {
        const forced = state.environmentForced?.approve;
        if (forced) return send(forced.status, forced.body);
        const env = state.accountEnvironment;
        const b = (body ?? {}) as { revision?: number; canonicalHash?: string };
        if (env.current === null) return send(404, { error: "not_found" });
        if (
          b.revision !== env.current.revision ||
          b.canonicalHash !== env.current.canonicalHash
        ) {
          return send(409, {
            error: "stale",
            message:
              "the declaration changed since you reviewed it — refresh and re-approve",
            currentRevision: env.current.revision,
            currentHash: env.current.canonicalHash,
          });
        }
        env.approved = {
          revision: env.current.revision,
          canonicalHash: env.current.canonicalHash,
        };
        return send(200, { approved: true, state: env.current });
      }
      const id = `lin-${name}-${state.writes.length}`;
      if (name === "ask")
        return send(200, {
          id,
          identifier: `ENG-${100 + state.writes.length}`,
        });
      if (name === "issue-create")
        return send(200, {
          id,
          identifier: `ENG-${200 + state.writes.length}`,
        });
      return send(200, { id, ok: true });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture server has no port");
  state.port = address.port;
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return state;
}
