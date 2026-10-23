import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { readExistingOnboardJson } from "./onboard-existing.js";
import { pollConsent } from "./onboard-consent.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

const listPath = "/api/v1/coding-accounts";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const slotPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export interface Slot {
  accountSlot: string;
  provider: string;
  declaredState: string;
  ownedByMe: boolean;
  needsCredential: boolean;
  walled: boolean;
  quarantined: boolean;
  renewalStatus: "renews" | "canceled" | null;
  revokedAtMs: number | null;
  accessEndsAtMs: number | null;
}
interface Binding {
  account: string;
  person: string;
  origin: string;
  role: string;
}
function binding(ctx: Ctx, journal: OnboardJournal): Binding | null {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    cfg.account !== (journal.account ?? journal.tenant) ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return null;
  return {
    account: cfg.account,
    person: cfg.user.id,
    origin: normalizeBaseUrl(cfg.baseUrl),
    role: cfg.user.role,
  };
}
const equal = (a: Binding | null, b: Binding) =>
  a?.account === b.account &&
  a.person === b.person &&
  a.origin === b.origin &&
  a.role === b.role;
async function inventory(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<
  | {
      slots: Slot[];
      identity: Binding;
    }
  | { reason: string }
> {
  const identity = binding(ctx, journal);
  if (!identity) return { reason: "account_identity_unverified" };
  const support = await verifyOnboardRoutes(
    ctx,
    journal,
    [{ method: "GET", path: listPath }],
    signal,
  );
  if ("reason" in support) return support;
  if (!equal(binding(ctx, journal), identity))
    return { reason: "account_identity_unverified" };
  const read = await readExistingOnboardJson(ctx, listPath, signal);
  if (!equal(binding(ctx, journal), identity))
    return { reason: "account_identity_unverified" };
  if ("reason" in read) return { reason: "account_inventory_unavailable" };
  const body = object(read.body);
  const now = ctx.now().getTime();
  if (
    !Array.isArray(body?.accounts) ||
    body.accounts.length > 1000 ||
    typeof body.observedAtMs !== "number" ||
    !Number.isSafeInteger(body.observedAtMs) ||
    body.observedAtMs > now + 5000 ||
    body.observedAtMs < now - 30000
  )
    return { reason: "account_inventory_unverified" };
  const slots: Slot[] = [],
    seen = new Set<string>();
  for (const value of body.accounts) {
    const row = object(value);
    if (
      !row ||
      typeof row.accountSlot !== "string" ||
      !slotPattern.test(row.accountSlot) ||
      seen.has(row.accountSlot) ||
      typeof row.provider !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.provider) ||
      typeof row.declaredState !== "string" ||
      !["active", "inactive"].includes(row.declaredState) ||
      typeof row.ownedByMe !== "boolean" ||
      typeof row.needsCredential !== "boolean" ||
      typeof row.walled !== "boolean" ||
      typeof row.quarantined !== "boolean" ||
      ![null, "renews", "canceled"].includes(
        row.renewalStatus as null | string,
      ) ||
      !(
        row.revokedAtMs === null ||
        (typeof row.revokedAtMs === "number" &&
          Number.isSafeInteger(row.revokedAtMs))
      ) ||
      !(
        row.accessEndsAtMs === null ||
        (typeof row.accessEndsAtMs === "number" &&
          Number.isSafeInteger(row.accessEndsAtMs))
      )
    )
      return { reason: "account_inventory_unverified" };
    seen.add(row.accountSlot);
    // Project only metadata we need. Unknown server fields never enter output or receipts.
    slots.push({
      accountSlot: row.accountSlot,
      provider: row.provider,
      declaredState: row.declaredState,
      ownedByMe: row.ownedByMe,
      needsCredential: row.needsCredential,
      walled: row.walled,
      quarantined: row.quarantined,
      renewalStatus: row.renewalStatus as "renews" | "canceled" | null,
      revokedAtMs: row.revokedAtMs as number | null,
      accessEndsAtMs: row.accessEndsAtMs as number | null,
    });
  }
  return { slots, identity };
}

/** Why one account cannot take work, or null when it can. The Connect page's AI-account rule
 * (the server's isUsableCodingAccount): any provider, any member's account, and a canceled
 * subscription keeps working until its paid access ends. */
function unusableCause(row: Slot, now: number): string | null {
  // CTC-6204: ended first. A revoked account is usually also declared inactive, and "turn it on"
  // is advice it can never take.
  if (
    row.revokedAtMs !== null ||
    (row.accessEndsAtMs !== null && row.accessEndsAtMs <= now)
  )
    return "coding_account_ended";
  if (row.declaredState !== "active") return "coding_account_inactive";
  if (row.needsCredential) return "coding_account_needs_login";
  if (row.quarantined) return "coding_account_quarantined";
  if (row.walled) return "coding_account_walled";
  return null;
}
export function usableAiAccount(row: Slot, now: number): boolean {
  return unusableCause(row, now) === null;
}

/** CTC-4680: the step is done when the workspace has at least one usable AI account, from any
 * provider. With --coding-account, that named account is the one that must be usable. */
export function onboardAccountsAdapter(
  input: {
    waitForAccount?: <T>(work: () => Promise<T>) => Promise<T>;
    accountWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** The slot named by --coding-account; without it any usable account counts. */
    slot?: string;
  } = {},
): OnboardAdapter {
  const usable = (slots: Slot[], now: number) =>
    slots
      .filter(
        (row) =>
          (input.slot === undefined || row.accountSlot === input.slot) &&
          usableAiAccount(row, now),
      )
      .sort((a, b) => a.accountSlot.localeCompare(b.accountSlot))[0];
  const check: OnboardAdapter["check"] = async (ctx, journal, signal) => {
    const live = await inventory(ctx, journal, signal);
    if ("reason" in live) return waiting(live.reason);
    const selected = usable(live.slots, ctx.now().getTime());
    if (selected)
      return {
        state: "done",
        evidence: {
          provider: selected.provider,
          checkedAt: ctx.now().toISOString(),
        },
      };
    if (input.slot !== undefined) {
      const named = live.slots.find((row) => row.accountSlot === input.slot);
      // A named account speaks for itself: other accounts in the workspace may be fine.
      return waiting(
        named
          ? (unusableCause(named, ctx.now().getTime()) ?? "coding_account_not_found")
          : "coding_account_not_found",
      );
    }
    if (
      input.waitForAccount &&
      ["owner", "admin"].includes(live.identity.role)
    )
      return { state: "pending" };
    return waiting(
      live.slots.length ? "ai_account_not_usable" : "account_enrollment_required",
    );
  };
  return {
    check,
    act: async (ctx, journal, external) => {
      const initial = await inventory(ctx, journal, external);
      if ("reason" in initial) return waiting(initial.reason);
      if (
        !input.waitForAccount ||
        !["owner", "admin"].includes(initial.identity.role)
      )
        return check(ctx, journal, external);
      let enrolled = initial.slots.length > 0;
      const result = await input.waitForAccount(() =>
        pollConsent({
          timeoutMs: input.accountWaitMs,
          signal: external,
          sleep: input.sleep,
          readStatus: async (signal) => {
            const current = await inventory(ctx, journal, signal);
            if ("reason" in current)
              return { outcome: "waiting", reason: current.reason };
            enrolled = current.slots.length > 0;
            return {
              outcome: usable(current.slots, ctx.now().getTime())
                ? "connected"
                : "absent",
            };
          },
        }),
      );
      if (result.state === "done") return check(ctx, journal, external);
      // A wait that ran out holds the step and offers another try (round 5).
      return waiting(
        result.reason !== "consent_timeout"
          ? (result.reason ?? "account_enrollment_required")
          : enrolled
            ? "ai_account_not_usable"
            : "account_enrollment_required",
      );
    },
  };
}
