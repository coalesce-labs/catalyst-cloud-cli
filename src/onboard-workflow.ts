import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { configPathFor, loadConfig, normalizeBaseUrl } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import type {
  TeamAdoptResult,
  TeamWorkflowFailure,
  TenantClient,
} from "@catalyst-cloud/sdk";
import { onboardTeamKey } from "./onboard-next.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
import type { Ctx } from "./config.js";
import { ownedFetch } from "./owned-fetch.js";
import { loadHttpSdk } from "./sdk.js";
import { fetchMe } from "./transport.js";

const path = "/api/v1/agent/team-workflow";
const slots = [
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
] as const;
const requiredTypes = {
  dispatch: ["unstarted", "backlog"],
  intake: ["unstarted", "backlog"],
  pr: ["started"],
  done: ["completed"],
  canceled: ["canceled"],
} as const;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
interface WorkflowObservation {
  mappingHash: string;
  mappingRevision: number;
  readinessRevision: number;
  checkedAt: number;
  mappedSlots: number;
  /** Cloud readiness's four pull request automation checks: "none" when all pass, the conflicting
   * events when any fail, absent when any is unknown or missing. */
  automations?: string;
}
const automationChecks = [
  ["open", "linear_automation_pr_open"],
  ["review", "linear_automation_pr_review"],
  ["ready", "linear_automation_pr_ready"],
  ["merge", "linear_automation_pr_merge"],
] as const;

/** Existing mappings can satisfy this step by observation. This never means a preview was applied. */
export function observeOnboardWorkflow(
  value: unknown,
  team: string,
  now: number,
): WorkflowObservation | null {
  const row = object(value),
    config = object(row?.config),
    readiness = object(row?.readiness);
  if (
    !row ||
    !config ||
    !readiness ||
    config.teamId !== team ||
    readiness.teamId !== team ||
    typeof config.mode !== "string" ||
    !["mapped-existing", "adopted-recommended", "mixed"].includes(
      config.mode,
    ) ||
    (config.gitAutomation !== "off" && config.gitAutomation !== "managed") ||
    !integer(config.workflowRev) ||
    !integer(readiness.workflowRev) ||
    typeof readiness.status !== "string" ||
    !["ready", "degraded", "blocked"].includes(readiness.status) ||
    !integer(readiness.checkedAt) ||
    readiness.checkedAt > now ||
    now - readiness.checkedAt >= 300_000 ||
    (row.stageSource !== "linear" && row.stageSource !== "mirror") ||
    typeof row.mappingHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.mappingHash) ||
    !Array.isArray(row.rows) ||
    row.rows.length > slots.length ||
    !Array.isArray(row.stages) ||
    row.stages.length > 1_000 ||
    !Array.isArray(readiness.checks) ||
    readiness.checks.length > 100
  )
    return null;
  const stages = new Map<string, string>();
  for (const candidate of row.stages) {
    const stage = object(candidate);
    if (
      !stage ||
      !id(stage.id) ||
      stages.has(stage.id) ||
      // Linear adds types such as "duplicate"; only the required slots' targets are type-checked below.
      typeof stage.type !== "string" ||
      !/^[a-z][a-z_-]{0,39}$/.test(stage.type)
    )
      return null;
    stages.set(stage.id, stage.type);
  }
  const mapping = new Map<string, string | null>();
  for (const candidate of row.rows) {
    const item = object(candidate);
    if (
      !item ||
      typeof item.slot !== "string" ||
      !(slots as readonly string[]).includes(item.slot) ||
      mapping.has(item.slot) ||
      (item.linearStateId !== null && !id(item.linearStateId)) ||
      (item.source !== undefined &&
        item.source !== "created" &&
        item.source !== "matched" &&
        item.source !== "chosen") ||
      (item.linearStateId !== null &&
        (item.stateStillExists !== true || !stages.has(item.linearStateId)))
    )
      return null;
    mapping.set(item.slot, item.linearStateId);
  }
  for (const [slot, types] of Object.entries(requiredTypes)) {
    const target = mapping.get(slot);
    if (
      !target ||
      !(types as readonly string[]).includes(stages.get(target) ?? "")
    )
      return null;
  }
  const checks = new Map<string, string>();
  for (const candidate of readiness.checks) {
    const check = object(candidate);
    if (
      !check ||
      typeof check.id !== "string" ||
      checks.has(check.id) ||
      (check.state !== "pass" &&
        check.state !== "fail" &&
        check.state !== "unknown")
    )
      return null;
    checks.set(check.id, check.state);
  }
  // Adoption does not establish coding accounts, automation rule safety or first-ticket readiness.
  if (
    [
      "team_visible",
      "mapped_states_exist",
      "mapping_total",
      "types_compatible",
      "labels_present",
    ].some((check) => checks.get(check) !== "pass")
  )
    return null;
  const automations = automationChecks.map(([event, check]) => [
    event,
    checks.get(check),
  ]);
  const conflicts = automations
    .filter(([, state]) => state === "fail")
    .map(([event]) => event);
  return {
    mappingHash: row.mappingHash,
    mappingRevision: config.workflowRev,
    readinessRevision: readiness.workflowRev,
    checkedAt: readiness.checkedAt,
    mappedSlots: [...mapping.values()].filter((value) => value !== null).length,
    ...(automations.every(([, state]) => state === "pass" || state === "fail")
      ? { automations: conflicts.length ? conflicts.join(",") : "none" }
      : {}),
  };
}

const plainText = (text: string) =>
  text
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
      "",
    )
    .trim();
const label = (text: string) => plainText(text).slice(0, 80);
const listed = (names: readonly string[]) =>
  names.length > 10
    ? `${names.slice(0, 10).join(", ")}, and ${names.length - 10} more`
    : names.join(", ");

function unfinishedLabelLines(plan: Pick<TeamAdoptResult, "labels"> & Partial<Pick<TeamAdoptResult, "labelsNotCreated">>): string[] {
  return [
    ...plan.labels.filter((row) => row.outcome === "refused").map(
      (row) => {
        const name = plainText(row.name);
        const reason = plainText(row.reason ?? "Linear did not supply a reason.");
        const guidance = name === "review-followup"
          ? "Optional for the cloud workflow; no action is needed to finish setup."
          : [
            name === "catalyst-not-an-ask"
              ? "Required for the cloud workflow. Without this label, work held by the ask-shape check cannot be released."
              : "Only missing required labels block workflow readiness.",
            "Ask a Linear workspace administrator to resolve the reported refusal and make this label available to the team, then run catalyst onboard.",
          ].join(" ");
        return `Linear refused label: ${name}. ${reason} ${guidance}`;
      },
    ),
    ...(plan.labelsNotCreated ?? []).map(
      (row) => {
        const entry = object(row);
        const name = typeof entry?.name === "string" ? plainText(entry.name) : "";
        const reason = typeof entry?.reason === "string" ? plainText(entry.reason) : "";
        return `Label not added: ${name || "Unnamed label"}. ${reason || "The server did not supply a reason; run catalyst onboard again to retry."}`;
      },
    ),
  ];
}

/** The adopt preview in plain words: stages and labels it creates or keeps. Linear's names are data. */
export function adoptPlanLines(
  plan: Pick<TeamAdoptResult, "stages" | "labels"> & Partial<Pick<TeamAdoptResult, "mode" | "unfilledLoadBearing" | "provenanceGaps" | "labelProvenanceGaps" | "labelsNotCreated">>,
): string[] {
  const group = (
    rows: readonly { name: string; outcome: string }[],
    outcome: string,
  ) => rows.filter((row) => row.outcome === outcome).map((row) => label(row.name));
  return (
    [
      ["Create stages", group(plan.stages, "would-create")],
      ["Keep existing stages", group(plan.stages, "already-present")],
      ["Linear refused stages", group(plan.stages, "refused")],
      ["Create labels", group(plan.labels, "would-create")],
      ["Labels already present", group(plan.labels, "already-present")],
    ] as const
  )
    .filter(([, names]) => names.length > 0)
    .map(([title, names]) => `${title}: ${listed(names)}`)
    .concat(
      
      plan.unfilledLoadBearing?.length ? [`Required work stages still missing: ${plan.unfilledLoadBearing.length}`] : [],
      (plan.provenanceGaps?.length ?? 0) + (plan.labelProvenanceGaps?.length ?? 0) ? ["Some existing states or labels have no recorded creator; setup keeps them"] : [],
      unfinishedLabelLines(plan),
    );
}

type WorkflowClient = TenantClient["teamWorkflow"];
/** What one adopt session may post: a preview, or the apply of the exact plan the person approved. */
export type AdoptAllow =
  | { mode: "preview" }
  | { mode: "apply"; team: string; planHash: string };

/** The only adopt bodies setup sends: this team, and the approved mode and hash. */
export function adoptRequestAllowed(
  body: unknown,
  team: string,
  allow: AdoptAllow,
): boolean {
  if (typeof body !== "string") return false;
  try {
    const sent = object(JSON.parse(body));
    return (
      !!sent &&
      sent.team === team &&
      sent.mode === allow.mode &&
      Object.keys(sent).length === (allow.mode === "apply" ? 3 : 2) &&
      (allow.mode === "preview" ||
        (allow.team === team && sent.planHash === allow.planHash))
    );
  } catch {
    return false;
  }
}
interface WorkflowSession {
  team: string;
  client: WorkflowClient;
  live: () => Promise<boolean>;
}

/** One bounded, identity-pinned exchange. Reads are GETs on the workflow, /me and the contract;
 * `adopt` also allows the one POST it names to the adopt route, the same route `catalyst team adopt`
 * uses. No credential rotation, no config write. Every entered fetch/body joins before return. */
async function workflowSession(
  ctx: Ctx,
  journal: OnboardJournal,
  external: AbortSignal | undefined,
  adopt: AdoptAllow | null,
  run: (session: WorkflowSession) => Promise<OnboardStepResult>,
  announce?: () => void,
): Promise<OnboardStepResult> {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    return waiting("workflow_identity_unverified");
  }
  const team = selectedOnboardTeam(journal);
  if (
    !team ||
    !cfg?.user ||
    (cfg.user.role !== "owner" && cfg.user.role !== "admin") ||
    cfg.account !== (journal.account ?? journal.tenant) ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return waiting("workflow_identity_unverified");
  if (adopt?.mode === "apply" && adopt.team !== team)
    return waiting("workflow_identity_unverified");
  const origin = normalizeBaseUrl(cfg.baseUrl),
    person = cfg.user.id,
    role = cfg.user.role;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return waiting("workflow_identity_unverified");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    return waiting("workflow_identity_unverified");
  const credential =
    cfg.key ||
    (cfg.auth && Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!credential) return waiting("workflow_login_refresh_required");
  const configWitness = () =>
    createHash("sha256")
      .update(readFileSync(configPathFor(ctx.home)))
      .digest("hex");
  let before: string;
  try {
    before = configWitness();
  } catch {
    return waiting("workflow_identity_unverified");
  }
  const current = () => {
    try {
      const now = loadConfig(ctx.home);
      return (
        now?.user?.id === person &&
        now.user.role === role &&
        now.account === cfg.account &&
        normalizeBaseUrl(now.baseUrl) === origin &&
        configWitness() === before &&
        selectedOnboardTeam(journal) === team &&
        (!!cfg.key ||
          (!!cfg.auth && Date.parse(cfg.auth.expiresAt) > ctx.now().getTime()))
      );
    } catch {
      return false;
    }
  };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  const signal = external
    ? AbortSignal.any([external, deadline.signal])
    : deadline.signal;
  const owned = ownedFetch(ctx.fetch, signal, { maxBodyBytes: 524_288 });
  const read: typeof fetch = (request, init) => {
    if (!current() || signal.aborted)
      return Promise.reject(new Error("workflow_read_stopped"));
    const requested = new URL(
      request instanceof Request ? request.url : String(request),
    );
    const method =
      init?.method ?? (request instanceof Request ? request.method : "GET");
    const write =
      !!adopt &&
      method === "POST" &&
      requested.pathname === `${path}/adopt` &&
      requested.search === "" &&
      !(request instanceof Request) &&
      adoptRequestAllowed(init?.body, team, adopt);
    if (
      (method !== "GET" && !write) ||
      requested.origin !== origin ||
      requested.username ||
      requested.password ||
      requested.hash ||
      (!write &&
        (!["/api/v1/me", "/api/v1/agent/contract", path].includes(
          requested.pathname,
        ) ||
          (requested.pathname === path
            ? requested.search !== `?team=${encodeURIComponent(team)}`
            : requested.search !== "")))
    )
      return Promise.reject(new Error("workflow_read_scope"));
    return owned.fetch(request, { ...init, signal, redirect: "error" });
  };
  const live = async () => {
    const me = await fetchMe(origin, credential, read);
    return (
      current() &&
      !signal.aborted &&
      me.account === cfg.account &&
      me.user?.id === person &&
      me.user.role === role
    );
  };
  const result = await (async (): Promise<OnboardStepResult> => {
    try {
      if (!(await live())) return waiting("workflow_identity_unverified");
      const support = await verifyOnboardRoutes(
        { ...ctx, fetch: read },
        journal,
        [{ method: "GET", path }],
        signal,
      );
      if ("reason" in support) return waiting(support.reason);
      if (adopt) {
        // Onboarding's own route list does not carry adopt; the tenant contract does, and it is the
        // list `catalyst team adopt` requires before it posts.
        const reply = await read(`${origin}/api/v1/agent/contract`, {
          headers: {
            authorization: `Bearer ${credential}`,
            accept: "application/json",
          },
        });
        const routes = reply.ok ? object(await reply.json())?.routes : null;
        if (
          !Array.isArray(routes) ||
          !routes.some(
            (route) =>
              object(route)?.method === "POST" &&
              object(route)?.path === `${path}/adopt`,
          )
        )
          return waiting("cloud_capability_unavailable");
      }
      if (!current() || signal.aborted)
        return waiting("workflow_identity_unverified");
      const sdk = await loadHttpSdk();
      if (!current() || signal.aborted)
        return waiting("workflow_identity_unverified");
      const client = sdk.createTenantClient({
        baseUrl: origin,
        key: credential,
        fetch: read,
        timeoutMs: 30_000,
        now: () => ctx.now().getTime(),
      });
      return await run({ team, client: client.teamWorkflow, live });
    } catch {
      return waiting(external?.aborted ? "interrupted" : "workflow_unavailable");
    } finally {
      try {
        owned.abort(new Error("workflow_read_complete"));
        await owned.settle();
      } finally {
        clearTimeout(timer);
      }
    }
  })();
  if (!current()) return waiting("workflow_identity_unverified");
  if (signal.aborted)
    return waiting(external?.aborted ? "interrupted" : "workflow_unavailable");
  if (result.state === "done" && announce) {
    // The display runs outside the bounded exchange, so identity is checked again after it.
    announce();
    if (!current() || signal.aborted)
      return waiting("workflow_identity_unverified");
  }
  return result;
}

/** Verifies the selected team's mapping by observation. With a plan question or --yes, an unadopted
 * team is `pending` and `act` previews, asks and applies the same adopt plan `catalyst team adopt`
 * applies, then the engine checks again. Without either, setup never writes the workflow. */
export function onboardWorkflowVerificationAdapter(
  input: {
    message?: (text: string) => void;
    confirm?: (team: string, lines: readonly string[]) => Promise<boolean>;
    yes?: boolean;
  } = {},
): OnboardAdapter {
  const adopts = !!input.confirm || input.yes === true;
  const check: OnboardAdapter["check"] = (ctx, journal, external) =>
    workflowSession(
      ctx,
      journal,
      external,
      null,
      async ({ team, client, live }) => {
        const first = await client.get(team);
        const observed =
          first.outcome === "ok"
            ? observeOnboardWorkflow(first, team, ctx.now().getTime())
            : null;
        if (!observed)
          return first.outcome === "ok" && adopts && Array.isArray(first.rows) && first.rows.length === 0
            ? { state: "pending", reason: "workflow_mapping_unverified" }
            : waiting("workflow_mapping_unverified");
        if (!(await live())) return waiting("workflow_identity_unverified");
        const last = await client.get(team);
        const verified =
          last.outcome === "ok"
            ? observeOnboardWorkflow(last, team, ctx.now().getTime())
            : null;
        if (
          !verified ||
          verified.mappingHash !== observed.mappingHash ||
          verified.mappingRevision !== observed.mappingRevision ||
          verified.readinessRevision !== observed.readinessRevision
        )
          return waiting("workflow_mapping_changed");
        if (!(await live())) return waiting("workflow_identity_unverified");
        return {
          state: "done",
          evidence: {
            team,
            revision: verified.readinessRevision,
            mappingRevision: verified.mappingRevision,
            checkedAt: verified.checkedAt,
            mappingHash: verified.mappingHash,
            count: verified.mappedSlots,
            ...(verified.automations
              ? { automations: verified.automations }
              : {}),
          },
        };
      },
      () =>
        input.message?.(
          `${onboardTeamKey(journal) ?? "This team"} has every required state and label`,
        ),
    );
  if (!adopts) return { check };
  // A local non-admin never gets here; a 403 means the seat changed after login.
  const refusal = (reply: TeamWorkflowFailure) =>
    reply.outcome === "unauthorized"
      ? waiting("workflow_login_refresh_required")
      : "status" in reply && reply.status === 403
        ? waiting("workflow_admin_required")
        : waiting("workflow_unavailable");
  return {
    check,
    act: async (ctx, journal, external) => {
      // A plan that changed between preview and apply is planned and approved once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        let plan: TeamAdoptResult | undefined, previewedTeam = "";
        const previewed = await workflowSession(
          ctx,
          journal,
          external,
          { mode: "preview" },
          async ({ team, client }) => {
            const reply = await client.adoptPreview(team);
            if (reply.outcome !== "ok") return refusal(reply);
            plan = reply;
            previewedTeam = team;
            return { state: "done" };
          },
        );
        if (previewed.state !== "done" || !plan) return previewed;
        const key = onboardTeamKey(journal) ?? (label(plan.teamKey) || "this team");
        const lines = adoptPlanLines(plan);
        if (!input.confirm) input.message?.([`Catalyst workflow plan for ${key}:`, ...lines].join("\n"));
        const approved = input.confirm
          ? await input.confirm(key, lines)
          : input.yes === true;
        if (external?.aborted) return waiting("interrupted");
        if (!approved) return waiting("workflow_adoption_declined");
        const hash = plan.planHash;
        let stale = false,
          summary = "";
        const applied = await workflowSession(
          ctx,
          journal,
          external,
          { mode: "apply", team: previewedTeam, planHash: hash },
          async ({ team, client }) => {
            const reply = await client.adoptApply(team, hash);
            if (reply.outcome !== "ok") {
              stale =
                "status" in reply &&
                reply.status === 409 &&
                reply.error === "plan-stale";
              return stale ? waiting("workflow_plan_changed") : refusal(reply);
            }
            const created = (rows: readonly { outcome: string }[]) =>
              rows.filter((row) => row.outcome === "created").length;
            const stages = created(reply.stages),
              labels = created(reply.labels);
            summary = [
              `Applied the Catalyst workflow to ${key}: created ${stages} ${stages === 1 ? "stage" : "stages"} and ${labels} ${labels === 1 ? "label" : "labels"}.`,
              ...unfinishedLabelLines(reply),
            ].join("\n");
            return { state: "done" };
          },
          () => input.message?.(summary),
        );
        // Only the server's own plan-stale answer plans again; a later identity refusal does not.
        if (!input.confirm || !(stale && applied.reason === "workflow_plan_changed"))
          return applied;
      }
      return waiting("workflow_plan_changed");
    },
  };
}
