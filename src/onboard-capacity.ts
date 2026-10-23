import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import {
  readExistingOnboardJson,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import {
  readOnboardRepositoryInventory,
  selectedOnboardRepositories,
} from "./onboard-repositories.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
const route = "/api/v1/me/runner-capacity";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !Array.from(value).some(
    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  );
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
interface Team {
  key: string;
  admission: boolean;
  remaining: number | null;
}
interface Bucket {
  repo: string;
  limit: number;
  occupied: number;
  teams: Team[];
}
function snapshot(
  value: unknown,
  now: number,
): { at: number; buckets: Bucket[] } | null {
  const body = object(value);
  if (
    !body ||
    body.status !== "ok" ||
    body.scope !== "mapped-team-defaults" ||
    !integer(body.observedAtMs) ||
    body.observedAtMs < now - 30_000 ||
    body.observedAtMs > now + 5_000 ||
    !Array.isArray(body.buckets) ||
    body.buckets.length > 500
  )
    return null;
  const buckets: Bucket[] = [],
    seen = new Set<string>(),
    seenTeam = new Set<string>();
  let totalTeams = 0;
  for (const value of body.buckets) {
    const b = object(value);
    if (
      !b ||
      !text(b.repoId) ||
      seen.has(b.repoId) ||
      !integer(b.effectiveLimit) ||
      !integer(b.occupiedUnits) ||
      !Array.isArray(b.teams) ||
      !b.teams.length ||
      b.teams.length > 500
    )
      return null;
    seen.add(b.repoId);
    totalTeams += b.teams.length;
    if (totalTeams > 1000) return null;
    const teams: Team[] = [];
    let minimum = Number.MAX_SAFE_INTEGER;
    for (const value of b.teams) {
      const t = object(value);
      if (
        !t ||
        !text(t.teamKey) ||
        seenTeam.has(t.teamKey) ||
        !integer(t.defaultLimit) ||
        t.defaultLimit < 1 ||
        !(
          t.configuredLimit === null ||
          (integer(t.configuredLimit) && t.configuredLimit > 0)
        ) ||
        typeof t.paused !== "boolean" ||
        typeof t.admissionEnabled !== "boolean" ||
        !integer(t.effectiveTeamLimit)
      )
        return null;
      const configured =
        t.configuredLimit === null ? t.defaultLimit : t.configuredLimit;
      if (
        t.source !== (t.configuredLimit === null ? "default" : "configured") ||
        t.effectiveTeamLimit !== (t.paused ? 0 : configured)
      )
        return null;
      const remaining = t.admissionEnabled
        ? Math.max(0, b.effectiveLimit - b.occupiedUnits)
        : null;
      if (t.remainingUnits !== remaining) return null;
      seenTeam.add(t.teamKey);
      minimum = Math.min(minimum, t.effectiveTeamLimit);
      teams.push({ key: t.teamKey, admission: t.admissionEnabled, remaining });
    }
    if (minimum !== b.effectiveLimit) return null;
    buckets.push({
      repo: b.repoId,
      limit: b.effectiveLimit,
      occupied: b.occupiedUnits,
      teams,
    });
  }
  return { at: body.observedAtMs, buckets };
}
function binding(ctx: Ctx, journal: OnboardJournal): string | null {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    !["owner", "admin"].includes(cfg.user.role) ||
    cfg.account !== (journal.account ?? journal.tenant) ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return null;
  return JSON.stringify([
    cfg.account,
    cfg.user.id,
    cfg.user.role,
    normalizeBaseUrl(cfg.baseUrl),
    cfg.permissions,
    cfg.key ?? cfg.auth?.sessionId,
  ]);
}
const selection = (journal: OnboardJournal) =>
  JSON.stringify([
    selectedOnboardTeam(journal),
    selectedOnboardRepositories(journal),
  ]);
export async function liveTeamKey(
  ctx: Ctx,
  teamId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const read = await readExistingOnboardJson(
    ctx,
    "/api/v1/agent/teams",
    signal,
  );
  if ("reason" in read) return null;
  const body = object(read.body),
    live = object(body?.liveTeamRead);
  if (
    !body ||
    !Array.isArray(body.teams) ||
    body.teams.length > 1000 ||
    (live?.error !== undefined && live.error !== null)
  )
    return null;
  const ids = new Set<string>(),
    keys = new Set<string>();
  let selected: string | null = null;
  for (const value of body.teams) {
    const team = object(value);
    if (
      !team ||
      !text(team.teamId) ||
      !text(team.teamKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(team.teamKey) ||
      ids.has(team.teamId) ||
      keys.has(team.teamKey)
    )
      return null;
    ids.add(team.teamId);
    keys.add(team.teamKey);
    if (team.teamId === teamId) selected = team.teamKey;
  }
  return selected;
}
/** Whether `teamKey`'s pool admits hosts, from a fresh capacity read. Null when the read is
 * unavailable, stale or does not name the team. */
export async function onboardTeamAdmission(
  ctx: Ctx,
  teamKey: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const read = await readExistingOnboardJson(ctx, route, signal);
  if ("reason" in read) return null;
  const teams = snapshot(read.body, ctx.now().getTime())?.buckets.flatMap(
    (b) => b.teams.filter((t) => t.key === teamKey),
  );
  return teams?.length ? teams.some((t) => t.admission) : null;
}
async function liveIdentity(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<boolean> {
  const read = await readExistingOnboardJson(ctx, "/api/v1/me", signal);
  if ("reason" in read) return false;
  const me = object(read.body),
    user = object(me?.user),
    cfg = loadConfig(ctx.home);
  return (
    !!cfg?.user &&
    me?.account === (journal.account ?? journal.tenant) &&
    user?.id === cfg.user.id &&
    user.role === cfg.user.role &&
    ["owner", "admin"].includes(cfg.user.role) &&
    me?.principal === cfg.principal
  );
}

/** Fresh advisory for the selected team's DEFAULT mapped repo. It grants no lease and does not
 * establish provider eligibility, host liveness or selected-repo overrides. No extra question. */
export function onboardCapacityAdapter(
  input: { message?: (text: string) => void } = {},
): OnboardAdapter {
  return {
    check: async (ctx, journal, external) => {
      if (external?.aborted) return waiting("interrupted");
      const expected = binding(ctx, journal),
        selected = selection(journal),
        teamId = selectedOnboardTeam(journal),
        repos = selectedOnboardRepositories(journal);
      if (!expected) return waiting("capacity_identity_unverified");
      if (!teamId || repos.length === 0 || repos.some(r => r.teamId !== teamId))
        return waiting("capacity_context_unverified");
      const controller = new AbortController(),
        signal = external
          ? AbortSignal.any([external, controller.signal])
          : controller.signal;
      const timer = setTimeout(() => controller.abort(), 30_000);
      const current = () =>
        !signal.aborted &&
        binding(ctx, journal) === expected &&
        selection(journal) === selected;
      const pause = (reason: string) =>
        waiting(
          external?.aborted
            ? "interrupted"
            : controller.signal.aborted
              ? "capacity_unavailable"
              : reason,
        );
      try {
        const support = await verifyOnboardRoutes(
          ctx,
          journal,
          [{ method: "GET", path: route }],
          signal,
        );
        if ("reason" in support) return pause(support.reason);
        if (
          !current() ||
          !(await liveIdentity(ctx, journal, signal)) ||
          !current()
        )
          return pause("capacity_identity_unverified");
        const teamKey = await liveTeamKey(ctx, teamId, signal);
        if (!teamKey || !current()) return pause("capacity_context_unverified");
        const inventory = await readOnboardRepositoryInventory(
          ctx,
          journal,
          signal,
        );
        if (
          "reason" in inventory ||
          !current() ||
          !repos.every(selectedRepo => inventory.repositories.some(
            r => r.repoId === selectedRepo.repoId && r.teamId === teamId &&
              r.owner.toLowerCase() === selectedRepo.owner.toLowerCase() &&
              r.name.toLowerCase() === selectedRepo.name.toLowerCase(),
          ))
        )
          return pause("capacity_context_unverified");
        const read = await readExistingOnboardJson(ctx, route, signal);
        if ("reason" in read || !current())
          return pause("capacity_unavailable");
        if (!(await liveIdentity(ctx, journal, signal)) || !current())
          return pause("capacity_identity_unverified");
        const observed = snapshot(read.body, ctx.now().getTime());
        const bucket = observed?.buckets.find(
            b => b.teams.some(t => t.key === teamKey) && repos.some(r => r.repoId === b.repo),
          ),
          mapped = bucket?.teams.find((t) => t.key === teamKey);
        if (!observed || !bucket || !mapped)
          return pause("capacity_context_unverified");
        if (!mapped.admission || mapped.remaining === null)
          return pause("capacity_admission_unverified");
        if (mapped.remaining === 0) return pause("capacity_currently_full");
        input.message?.(
          `Runner capacity observed: ${bucket.occupied} of ${bucket.limit} units in use. Starting work will check admission again.`,
        );
        if (!current()) return pause("capacity_identity_unverified");
        return {
          state: "done",
          evidence: {
            repoId: bucket.repo,
            effectiveLimit: bucket.limit,
            occupiedUnits: bucket.occupied,
            remainingUnits: mapped.remaining,
            observedAtMs: observed.at,
            advisory: true,
          },
        };
      } catch {
        return pause(
          external?.aborted ? "interrupted" : "capacity_unavailable",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
