// contract-types.ts — the SHAPE of GET /api/v1/agent/contract as this bundle reads it. Typed here
// (the cloud's own declaration lives in another repository) and filled only from the wire. No field
// below carries a default: a tenant value the contract does not serve is refused, never guessed.

export type WorkflowSlot =
  | "dispatch"
  | "intake"
  | "research"
  | "plan"
  | "implement"
  | "remediate"
  | "verify"
  | "review"
  | "pr"
  | "done"
  | "canceled";

export interface ContractLabel {
  name: string;
  unscopedId: string | null;
  teamScopedId: string | null;
  scope: "unscoped" | "team" | "absent";
  preferredId: string | null;
}

export interface ContractStage {
  stateId: string;
  name: string | null;
  type: string | null;
  stateStillExists: boolean;
  source: string;
}

export interface ContractReadinessCheck {
  id: string;
  state: "pass" | "fail" | "unknown";
  reason?: string;
  count?: number;
  /** OPTIONAL (contract 1.24.0, CTC-3547): the declared variable NAMES a `required_values` fail found
   *  with no value. Names only, never a value. An older cloud omits it. */
  names?: readonly string[];
  /** OPTIONAL (contract 1.24.0, CTC-3547): the subset of `names` that exist as plain variables but
   *  whose `$NAME` references name a secret with no value. Names only. An older cloud omits it. */
  unresolved?: readonly ContractUnresolvedValue[];
  /** OPTIONAL (CTC-2539; `names` / `unresolved` since 1.24.0): the check's findings for the team's
   *  OTHER registered repositories. An older cloud omits it, or omits the per-repo names. */
  repos?: readonly ContractReadinessRepoNote[];
}

/** CTC-3547 — a required variable whose references do not resolve. Both sides are names. */
export interface ContractUnresolvedValue {
  name: string;
  references: readonly string[];
}

/** CTC-2539 / CTC-3547 — one non-default repository's findings for a team check. */
export interface ContractReadinessRepoNote {
  /** `owner/name`. */
  repo: string;
  reason?: string;
  names?: readonly string[];
  unresolved?: readonly ContractUnresolvedValue[];
}

/**
 * OPTIONAL: the team's dispatch gate as the CONTRACT spells it. An older cloud omits it and every
 * reader treats absence as "say nothing" — the `skillsBundle?` precedent below.
 *
 * ⛔ NOTE THE FIELD NAME. The eligibility response spells this same concept `cause`
 * (`DispatchGate` in execution.ts); the contract spells it `status`. Both are real wire shapes.
 * `status` is typed `string`, not a union: an unrecognized value must be PRINTED as the cloud
 * spelled it, never swallowed. `"open"` is the one open value; anything else is a shut gate.
 */
export interface ContractDispatchGate {
  status: string;
  missingSlots?: readonly string[];
  remedy?: string | null;
}

export interface ContractTeam {
  id: string;
  key: string | null;
  name: string | null;
  workflowMode: string;
  gitAutomation: string;
  stages: Partial<Record<WorkflowSlot, ContractStage>>;
  labels: { ask: ContractLabel[]; hold: ContractLabel[]; release: ContractLabel[] };
  readiness: {
    status: "ready" | "degraded" | "blocked" | "unchecked";
    checks: ContractReadinessCheck[];
    checkedAt: number | null;
    expiresAt: number | null;
    workflowRev: number | null;
  };
  dispatchGate?: ContractDispatchGate;
}

export interface ContractRoute {
  method: "GET" | "POST";
  path: string;
  takesWriteBudgetUnit: boolean;
  since: string;
}

export interface TenantContract {
  contractVersion: string;
  protocolVersion: number;
  cache: { maxAgeSeconds: number; staleRefusalSeconds: number };
  account: {
    id: string;
    slug: string;
    name: string;
    linearWorkspaceId: string | null;
    linearWorkspaceSlug: string | null;
  };
  apiPrefix: string;
  slots: readonly WorkflowSlot[];
  routes: readonly ContractRoute[];
  teams: ContractTeam[];
  vocabulary: {
    askLabelPrefix: string;
    askPhaseLabelPrefix: string;
    askMarkerLabel: string;
    releaseLabel: string;
    bookkeeping: {
      marker: string;
      prefixOnly: boolean;
      asciiCaseInsensitive: boolean;
      leadingWhitespaceTrimmed: boolean;
    };
  };
  askTemplate: {
    headings: { ask: string; options: string; defaultIfSilent: string; howToAnswer: string };
    howToAnswer: { withOptions: string; withoutOptions: string };
    optionBulletFormat: string;
    maxLetteredOptions: number;
    maxAskGenerations: number;
    example: string;
  };
  ladder: {
    phases: readonly string[];
    keying: string;
    keyingScope: string;
    intakeEnabled: boolean;
    advance: readonly {
      phase: string;
      result: "ok" | "failed";
      fromSlots: readonly WorkflowSlot[] | null;
      toSlot: WorkflowSlot | null;
      because: string;
    }[];
  };
  thresholds: {
    scope: string;
    parkAfterConsecutiveFailures: number;
    remediateRoundCap: number;
    remediateEscalatedRoundBudget: number;
    remediateRewindBudget: number;
    retryBackoffMs: readonly number[];
    hostDailyWriteBudget: number;
  };
  merge: {
    policies: readonly string[];
    defaultPolicy: string;
    repositories: readonly {
      repoId: string;
      owner: string;
      name: string;
      policy: string;
      policySource: "repo" | "tenant" | "default";
    }[];
    reviewerLogin: string;
    cleanPassShapes: readonly { kind: string; description: string; honoured: boolean; ticket: string | null }[];
    /** Served by 1.x contracts only; 2.0.0 (CTC-1999) removed it. Readers treat absence as []. */
    cloudRemediateRequiredChecks?: readonly string[];
    prLabels: { queueReady: string; handStepsHold: string; hold: string; preview: string };
  };
  /** The customer skill bundle the cloud expects, when it publishes one (catalyst-cloud#3746). OPTIONAL:
   *  an older cloud omits it, and `ready` reads it defensively — an absent field emits nothing. */
  skillsBundle?: { package: string; minVersion: string };
  /** The workspace's MCP portal (CTC-6103). Older clouds omit it; readers refuse instead of guessing.
   *  `url` is null exactly when `unavailable` names why (agent-contract.md rule 6). */
  portal?: { url: string | null; unavailable?: string | null } | null;
  readinessChecks: readonly { id: string; severity: string; needsAnswer: boolean }[];
  humans: readonly { linearUserId: string; role: "owner" | "admin" }[];
  asks: { approvalsTeamId: string | null };
}
