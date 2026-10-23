import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import type { ParsedArgs } from "./args.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import {
  readExistingOnboardJson,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import {
  existingRepositoryAdapter,
  repositoryChoiceWait,
  type ChooseExistingRepositories,
} from "./onboard-repositories.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

export interface FirstOnboardRepository {
  owner: string;
  name: string;
}
export type ChooseFirstOnboardRepository = (
  rows: readonly FirstOnboardRepository[],
) => Promise<string | null>;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const part = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const key = (row: FirstOnboardRepository) =>
  `${row.owner}/${row.name}`.toLowerCase();
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
function repository(value: unknown): FirstOnboardRepository | null {
  const row = object(value);
  return row &&
    typeof row.owner === "string" &&
    part.test(row.owner) &&
    typeof row.name === "string" &&
    part.test(row.name)
    ? { owner: row.owner, name: row.name }
    : null;
}
function pendingSelection(
  journal: OnboardJournal,
): FirstOnboardRepository | null {
  const step = journal.steps.find(
    (row) => row.id === "github.repos" && row.state === "done",
  );
  const raw = step?.evidence?.repository;
  if (typeof raw !== "string" || raw.length > 64_000) return null;
  try {
    const values: unknown = JSON.parse(raw);
    if (
      !Array.isArray(values) ||
      values.length !== 1 ||
      object(values[0])?.teamId !== selectedOnboardTeam(journal)
    )
      return null;
    return repository(values[0]);
  } catch {
    return null;
  }
}
type Options = {
  rows: FirstOnboardRepository[];
  teamKey: string;
  taken: Array<{
    teamId: string;
    repo: FirstOnboardRepository;
    active: boolean;
  }>;
  truncated: boolean;
};
async function options(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<Options | { reason: string }> {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    !["owner", "admin"].includes(cfg.user.role) ||
    cfg.account !== journal.account ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return { reason: "project_identity_unverified" };
  const personId = cfg.user.id;
  const teamId = selectedOnboardTeam(journal);
  if (!teamId) return { reason: "team_selection_unverified" };
  const support = await verifyOnboardRoutes(
    ctx,
    journal,
    [{ method: "GET", path: "/api/v1/me/repositories/options" }],
    signal,
  );
  if ("reason" in support) return support;
  const sameIdentity = () => {
    const current = loadConfig(ctx.home);
    return (
      current?.user &&
      ["owner", "admin"].includes(current.user.role) &&
      current.account === cfg.account &&
      current.user.id === personId &&
      normalizeBaseUrl(current.baseUrl) === normalizeBaseUrl(cfg.baseUrl)
    );
  };
  // The read helper loads its own credential. Reject a switch before that read and again
  // after its body settles, before any provider names become receipt evidence.
  if (!sameIdentity()) return { reason: "project_identity_unverified" };
  const read = await readExistingOnboardJson(
    ctx,
    "/api/v1/me/repositories/options",
    signal,
  );
  if (!sameIdentity()) return { reason: "project_identity_unverified" };
  if ("reason" in read) return { reason: "project_options_unavailable" };
  const body = object(read.body),
    linear = object(body?.linear),
    github = object(body?.github);
  if (
    !linear ||
    !github ||
    linear.connected !== true ||
    github.connected !== true ||
    linear.error !== null ||
    github.error !== null
  )
    return { reason: "project_provider_inventory_unavailable" };
  if (
    !Array.isArray(linear.teams) ||
    linear.teams.length > 1_000 ||
    !Array.isArray(github.repositories) ||
    github.repositories.length > 10_000 ||
    typeof github.truncated !== "boolean" ||
    !Array.isArray(body?.taken) ||
    body.taken.length > 10_000
  )
    return { reason: "project_options_unverified" };
  const teams = linear.teams.filter((value) => object(value)?.id === teamId);
  const team = object(teams[0]);
  if (
    teams.length !== 1 ||
    typeof team?.key !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(team.key)
  )
    return { reason: "team_selection_unverified" };
  const rows: FirstOnboardRepository[] = [],
    seen = new Set<string>();
  for (const value of github.repositories) {
    const row = repository(value);
    if (!row || seen.has(key(row)))
      return { reason: "project_options_unverified" };
    seen.add(key(row));
    rows.push(row);
  }
  const taken: Options["taken"] = [];
  for (const value of body.taken) {
    const row = object(value);
    const repo = repository({
      owner: row?.githubRepoOwner,
      name: row?.githubRepoName,
    });
    if (
      !row ||
      !repo ||
      typeof row.linearTeamId !== "string" ||
      typeof row.status !== "string" ||
      !["active", "archived"].includes(row.status)
    )
      return { reason: "project_options_unverified" };
    taken.push({
      teamId: row.linearTeamId,
      repo,
      active: row.status === "active",
    });
  }
  return { rows, taken, teamKey: team.key, truncated: github.truncated };
}

/** Q3 records a choice. It does not report an unregistered repository as a cloud binding. */
export function firstProjectAdapters(
  args: ParsedArgs,
  input: {
    chooseExisting?: ChooseExistingRepositories;
    chooseFirst?: ChooseFirstOnboardRepository;
    message?: (text: string) => void;
  } = {},
): Record<"github.repos" | "projects", OnboardAdapter> {
  const existing = existingRepositoryAdapter(args, input.chooseExisting);
  let chosen: FirstOnboardRepository | null = null;
  const selected = (journal: OnboardJournal) => {
    const explicit = args.flags.repo;
    if (explicit !== undefined) {
      const values = Array.isArray(explicit) ? explicit : [explicit];
      if (values.length !== 1 || typeof values[0] !== "string") return null;
      const parts = values[0].split("/");
      return parts.length === 2
        ? repository({ owner: parts[0], name: parts[1] })
        : null;
    }
    return chosen ?? pendingSelection(journal);
  };
  const selectionResult = (
    row: FirstOnboardRepository,
    journal: OnboardJournal,
  ): OnboardStepResult => ({
    state: "done",
    evidence: {
      repository: JSON.stringify([
        { ...row, teamId: selectedOnboardTeam(journal) },
      ]),
      count: 1,
    },
  });
  const binding = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ) => {
    const row = selected(journal);
    if (!row) return waiting("repository_selection_unverified");
    return existingRepositoryAdapter({
      ...args,
      flags: { ...args.flags, repo: `${row.owner}/${row.name}` },
    }).check(ctx, journal, signal);
  };
  const projectCheck: OnboardAdapter["check"] = async (
    ctx,
    journal,
    signal,
  ) => {
    const known = await existing.check(ctx, journal, signal);
    if (known.state === "done") return known;
    const live = await binding(ctx, journal, signal);
    if (live.state === "done") return live;
    if (live.reason !== "repository_inventory_empty") return live;
    const row = selected(journal);
    if (!row) return waiting("repository_selection_unverified");
    const list = await options(ctx, journal, signal);
    if ("reason" in list) return waiting(list.reason);
    const held = list.taken.filter(
      (value) =>
        value.teamId === selectedOnboardTeam(journal) ||
        key(value.repo) === key(row),
    );
    if (held.length)
      return waiting(
        held.length === 1 &&
          held[0]!.active &&
          held[0]!.teamId === selectedOnboardTeam(journal) &&
          key(held[0]!.repo) === key(row)
          ? "project_registration_visibility_pending"
          : "project_binding_conflict",
      );
    return list.rows.some((value) => key(value) === key(row))
      ? { state: "pending" }
      : waiting("repository_selection_unverified");
  };
  return {
    "github.repos": {
      check: async (ctx, journal, signal) => {
        const live = await existing.check(ctx, journal, signal);
        if (live.state === "done") return live;
        // A names-only Q3 receipt remains the selected choice when registration later becomes
        // visible. Resolve its actual ID without asking the registered-repository picker again.
        if (selected(journal)) {
          const registered = await binding(ctx, journal, signal);
          if (
            registered.state === "done" ||
            registered.reason !== "repository_inventory_empty"
          )
            return registered;
        }
        if (live.reason !== "repository_inventory_empty") return live;
        const list = await options(ctx, journal, signal);
        if ("reason" in list) return waiting(list.reason);
        const row = selected(journal);
        if (row)
          return list.rows.some((value) => key(value) === key(row))
            ? selectionResult(row, journal)
            : waiting("repository_selection_unverified");
        return input.chooseFirst && list.rows.length
          ? { state: "pending" }
          : repositoryChoiceWait(list.rows);
      },
      act: async (ctx, journal, signal) => {
        const live = await existing.check(ctx, journal, signal);
        if (live.reason !== "repository_inventory_empty")
          return existing.act ? existing.act(ctx, journal, signal) : live;
        const list = await options(ctx, journal, signal);
        if ("reason" in list) return waiting(list.reason);
        if (!input.chooseFirst || !list.rows.length)
          return repositoryChoiceWait(list.rows);
        if (list.truncated)
          input.message?.(
            "GitHub returned part of its repository list. Choose a displayed repository, or stop and adjust the App access before resuming.",
          );
        let remove = () => {};
        const answer = await new Promise<string | null>((resolve, reject) => {
          const stopped = () => resolve(null);
          if (signal?.aborted) {
            stopped();
            return;
          }
          signal?.addEventListener("abort", stopped, { once: true });
          remove = () => signal?.removeEventListener("abort", stopped);
          Promise.resolve()
            .then(() =>
              signal?.aborted
                ? null
                : input.chooseFirst!(list.rows.map((row) => ({ ...row }))),
            )
            .then(resolve, reject);
        }).finally(() => remove());
        if (signal?.aborted || answer === null) return waiting("interrupted");
        chosen =
          list.rows.find((row) => key(row) === answer.toLowerCase()) ?? null;
        if (!chosen) return waiting("repository_selection_unverified");
        const fresh = await options(ctx, journal, signal);
        return "reason" in fresh
          ? waiting(fresh.reason)
          : fresh.rows.some((row) => key(row) === key(chosen!))
            ? selectionResult(chosen, journal)
            : waiting("repository_selection_unverified");
      },
    },
    projects: {
      check: projectCheck,
      act: async (ctx, journal, signal) => {
        const before = await projectCheck(ctx, journal, signal);
        if (before.state !== "pending") return before;
        const row = selected(journal);
        if (!row) return waiting("repository_selection_unverified");
        const list = await options(ctx, journal, signal);
        if ("reason" in list) return waiting(list.reason);
        // Recheck after the second provider read before any mutation; an archived holder is a conflict.
        if (
          !list.rows.some((value) => key(value) === key(row)) ||
          list.taken.some(
            (value) =>
              value.teamId === selectedOnboardTeam(journal) ||
              key(value.repo) === key(row),
          )
        )
          return projectCheck(ctx, journal, signal);
        const result = await createFirstProject(
          ctx,
          journal,
          row,
          list.teamKey,
          signal,
        );
        if (result) return waiting(result);
        return projectCheck(ctx, journal, signal);
      },
    },
  };
}

async function createFirstProject(
  ctx: Ctx,
  journal: OnboardJournal,
  row: FirstOnboardRepository,
  teamKey: string,
  external?: AbortSignal,
): Promise<string | null> {
  const support = await verifyOnboardRoutes(
    ctx,
    journal,
    [{ method: "POST", path: "/api/v1/me/repositories" }],
    external,
  );
  if ("reason" in support) return support.reason;
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    !["admin", "owner"].includes(cfg.user.role) ||
    cfg.account !== journal.account ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return "project_identity_unverified";
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return "project_login_refresh_required";
  const owned = new AbortController(),
    signal = external
      ? AbortSignal.any([external, owned.signal])
      : owned.signal;
  const timer = setTimeout(() => owned.abort(), 30_000);
  let remove = () => {};
  try {
    return await new Promise<string | null>((resolve) => {
      const stopped = () =>
        resolve(
          external?.aborted ? "interrupted" : "project_create_unverified",
        );
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async () => {
          if (signal.aborted) return "interrupted";
          const response = await ctx.fetch(
            `${normalizeBaseUrl(cfg.baseUrl)}/api/v1/me/repositories`,
            {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                name: `${row.owner}/${row.name}`.slice(0, 80),
                linearTeamId: selectedOnboardTeam(journal),
                linearTeamKey: teamKey,
                githubRepoOwner: row.owner,
                githubRepoName: row.name,
              }),
            },
          );
          // A response is not readiness evidence. The next check reads the binding and contract again.
          return response.status === 201 || response.status === 409
            ? null
            : "project_create_unverified";
        })
        .then(
          (result) => (signal.aborted ? stopped() : resolve(result)),
          () =>
            signal.aborted ? stopped() : resolve("project_create_unverified"),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
    owned.abort();
  }
}
