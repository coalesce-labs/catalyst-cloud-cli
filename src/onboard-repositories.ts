import { isRepositoryId } from "./repository-id.js";
import type { ParsedArgs } from "./args.js";
import {
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  type Ctx,
} from "./config.js";
import { contractVersionInRange } from "./contract.js";
import {
  choiceList,
  readExistingOnboardJson,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

export interface ExistingOnboardRepository {
  teamId: string;
  owner: string;
  name: string;
  repoId: string;
  /** CTC-4742: already registered to the team, so the picker starts with it selected. */
  registered?: true;
}
/** CTC-4742: a repository the GitHub App can reach that the team does not use yet. Selecting it
 *  registers it to the team; it has no repository ID until then. */
export interface OfferedOnboardRepository {
  teamId: string;
  owner: string;
  name: string;
  repoId: null;
  registered: false;
}
export type OnboardRepositoryChoice =
  | ExistingOnboardRepository
  | OfferedOnboardRepository;
export type ChooseExistingRepositories = (
  repositories: readonly OnboardRepositoryChoice[],
) => Promise<string[] | null>;
const part = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const key = (row: Pick<ExistingOnboardRepository, "owner" | "name">) =>
  `${row.owner}/${row.name}`.toLowerCase();
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
/** CTC-5932: a choice no one was there to make, with the repositories it could have been. */
export const repositoryChoiceWait = (
  rows: ReadonlyArray<{ owner: string; name: string }>,
): OnboardStepResult =>
  rows.length
    ? {
        ...waiting("repository_choice_required"),
        evidence: { choices: choiceList(rows.map((row) => `${row.owner}/${row.name}`)) },
      }
    : waiting("repository_choice_required");
const valid = (value: unknown): value is ExistingOnboardRepository => {
  const row = object(value);
  return (
    !!row &&
    typeof row.teamId === "string" &&
    id.test(row.teamId) &&
    isRepositoryId(row.repoId) &&
    typeof row.owner === "string" &&
    part.test(row.owner) &&
    typeof row.name === "string" &&
    part.test(row.name)
  );
};

/** Names/IDs only. A saved selection never proves current access or repository readiness. */
export function selectedOnboardRepositories(
  journal?: OnboardJournal,
): ExistingOnboardRepository[] {
  const selection = journal?.steps.find(
    (row) => row.id === "github.repos" && row.state === "done",
  );
  const registered = journal?.steps.find(
    (row) => row.id === "projects" && row.state === "done",
  );
  const receipt = selection?.evidence?.repository;
  if (typeof receipt !== "string" || receipt.length > 64_000) return [];
  try {
    const rows: unknown = JSON.parse(receipt);
    if (!Array.isArray(rows) || !rows.length || rows.length > 100) return [];
    if (rows.every(valid)) {
      if (new Set(rows.map(key)).size !== rows.length) return [];
      return rows.map((row) => ({
        teamId: row.teamId,
        owner: row.owner,
        name: row.name,
        repoId: row.repoId,
      }));
    }
    // A fresh Q3 choice has names only. It may use later verified registration evidence only
    // when the exact selected team/repository matches, never an earlier project's selection.
    if (rows.length !== 1) return [];
    const selected = object(rows[0]);
    if (
      !selected ||
      selected.repoId !== undefined ||
      typeof selected.teamId !== "string" ||
      !id.test(selected.teamId) ||
      typeof selected.owner !== "string" ||
      !part.test(selected.owner) ||
      typeof selected.name !== "string" ||
      !part.test(selected.name)
    )
      return [];
    const evidence = registered?.evidence?.repository;
    if (typeof evidence !== "string" || evidence.length > 64_000) return [];
    const registeredRows: unknown = JSON.parse(evidence);
    if (
      !Array.isArray(registeredRows) ||
      registeredRows.length !== 1 ||
      !registeredRows.every(valid)
    )
      return [];
    const live = registeredRows[0]!;
    return live.teamId === selected.teamId &&
      key(live) === key({ owner: selected.owner, name: selected.name })
      ? [{ ...live }]
      : [];
  } catch {
    return [];
  }
}

/** The personal ACL inventory chooses bindings; a fresh contract supplies IDs only. No cache read. */
export async function readOnboardRepositoryInventory(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<
  | { repositories: ExistingOnboardRepository[]; canRegister?: boolean }
  | { reason: string }
> {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    !journal.account ||
    cfg.account !== journal.account ||
    journal.membershipId !== cfg.user.id ||
    !journal.baseUrl ||
    normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
  )
    return { reason: "repository_identity_unverified" };
  const personId = cfg.user.id;
  const sameIdentity = () => {
    const current = loadConfig(ctx.home);
    return (
      current?.user &&
      current.account === cfg.account &&
      current.user.id === personId &&
      normalizeBaseUrl(current.baseUrl) === normalizeBaseUrl(cfg.baseUrl)
    );
  };
  const teamId = selectedOnboardTeam(journal);
  if (!teamId) return { reason: "team_selection_unverified" };
  // CTC-4742: the per-person repository list names every project a repository belongs to, so a
  // team that uses several repositories shows all of them. A member's list is narrowed to their
  // own access by the server. An older server without the route falls back to the one-per-team
  // registry below.
  const agent = await readExistingOnboardJson(
    ctx,
    "/api/v1/agent/repos",
    signal,
  );
  if (!sameIdentity()) return { reason: "repository_identity_unverified" };
  if (!("reason" in agent))
    return teamRepositories(ctx, journal, teamId, agent.body, sameIdentity, signal);
  if (agent.status !== 404) return { reason: "repository_read_unavailable" };
  const read = await readExistingOnboardJson(ctx, "/api/v1/repos", signal);
  if (!sameIdentity()) return { reason: "repository_identity_unverified" };
  if ("reason" in read) return { reason: "repository_read_unavailable" };
  const body = object(read.body);
  if (!body || !Array.isArray(body.repos) || body.repos.length > 1_000)
    return { reason: "repository_inventory_shape" };
  const bindings: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();
  for (const value of body.repos) {
    const row = object(value);
    if (
      !row ||
      typeof row.teamId !== "string" ||
      !id.test(row.teamId) ||
      typeof row.owner !== "string" ||
      !part.test(row.owner) ||
      typeof row.name !== "string" ||
      !part.test(row.name)
    )
      return { reason: "repository_inventory_shape" };
    if (row.teamId !== teamId) continue;
    const name = key({ owner: row.owner, name: row.name });
    if (seen.has(name)) return { reason: "repository_binding_ambiguous" };
    seen.add(name);
    bindings.push({ owner: row.owner, name: row.name });
  }
  if (!sameIdentity()) return { reason: "repository_identity_unverified" };
  if (!bindings.length) return { repositories: [] };
  const contractRead = await readExistingOnboardJson(
    ctx,
    "/api/v1/agent/contract",
    signal,
  );
  if (!sameIdentity()) return { reason: "repository_identity_unverified" };
  if ("reason" in contractRead)
    return { reason: "repository_contract_unavailable" };
  const doc = object(contractRead.body);
  const account = object(doc?.account);
  const merge = object(doc?.merge);
  if (
    !doc ||
    account?.id !== journal.account ||
    typeof doc.contractVersion !== "string" ||
    contractVersionInRange(
      doc.contractVersion,
      readManifest().tenantContractRange,
    ) !== true ||
    !merge ||
    !Array.isArray(merge.repositories) ||
    merge.repositories.length > 10_000
  )
    return { reason: "repository_contract_unverified" };
  const lookup = new Map<string, string[]>();
  const idNames = new Map<string, string>();
  for (const value of merge.repositories) {
    const row = object(value);
    if (
      !row ||
      typeof row.owner !== "string" ||
      !part.test(row.owner) ||
      typeof row.name !== "string" ||
      !part.test(row.name) ||
      !isRepositoryId(row.repoId)
    )
      return { reason: "repository_contract_unverified" };
    const name = key({ owner: row.owner, name: row.name });
    if (idNames.has(row.repoId) && idNames.get(row.repoId) !== name)
      return { reason: "repository_contract_unverified" };
    idNames.set(row.repoId, name);
    lookup.set(name, [...(lookup.get(name) ?? []), row.repoId]);
  }
  const repositories: ExistingOnboardRepository[] = [];
  for (const binding of bindings) {
    const ids = lookup.get(key(binding));
    if (!ids || ids.length !== 1) return { reason: "repository_id_unverified" };
    repositories.push({ ...binding, teamId, repoId: ids[0]! });
  }
  return { repositories };
}

/** The saved login is still the person, account and origin this run started with (and, when
 *  `manager`, an owner or admin). Returns that config, or null. */
function journalIdentity(ctx: Ctx, journal: OnboardJournal, manager = false) {
  const cfg = loadConfig(ctx.home);
  return cfg?.user &&
    cfg.account === journal.account &&
    cfg.user.id === journal.membershipId &&
    !!journal.baseUrl &&
    normalizeBaseUrl(cfg.baseUrl) === normalizeBaseUrl(journal.baseUrl) &&
    (!manager || ["owner", "admin"].includes(cfg.user.role))
    ? cfg
    : null;
}

type ContractIds = { registered: Set<string>; ids: Map<string, string[]>; canRegister: boolean };
const REGISTER_PATH = "/api/v1/agent/project-repositories";
/** The fresh contract's repository IDs and the repositories registered to the chosen team (by its
 *  id), or why they can't be trusted. */
async function contractIds(
  ctx: Ctx,
  journal: OnboardJournal,
  teamId: string,
  sameIdentity: () => unknown,
  signal?: AbortSignal,
): Promise<ContractIds | { reason: string }> {
  const read = await readExistingOnboardJson(ctx, "/api/v1/agent/contract", signal);
  if (!sameIdentity()) return { reason: "repository_identity_unverified" };
  if ("reason" in read) return { reason: "repository_contract_unavailable" };
  const doc = object(read.body);
  const account = object(doc?.account);
  const merge = object(doc?.merge);
  if (
    !doc ||
    account?.id !== journal.account ||
    typeof doc.contractVersion !== "string" ||
    contractVersionInRange(doc.contractVersion, readManifest().tenantContractRange) !== true ||
    !merge ||
    !Array.isArray(merge.repositories) ||
    merge.repositories.length > 10_000 ||
    !Array.isArray(doc.teams) ||
    doc.teams.length > 1_000
  )
    return { reason: "repository_contract_unverified" };
  // The team's repositories, keyed by the team's id (a team key can be renamed or missing).
  const teams = doc.teams.filter((value) => object(value)?.id === teamId);
  const names = object(object(teams[0])?.repositories)?.registered;
  if (
    teams.length !== 1 ||
    !Array.isArray(names) ||
    names.length > 1_000 ||
    !names.every((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))
  )
    return { reason: "team_selection_unverified" };
  const registered = new Set(names.map((name) => (name as string).toLowerCase()));
  const ids = new Map<string, string[]>();
  const idNames = new Map<string, string>();
  for (const value of merge.repositories) {
    const row = object(value);
    if (
      !row ||
      typeof row.owner !== "string" ||
      !part.test(row.owner) ||
      typeof row.name !== "string" ||
      !part.test(row.name) ||
      !isRepositoryId(row.repoId)
    )
      return { reason: "repository_contract_unverified" };
    const name = key({ owner: row.owner, name: row.name });
    if (idNames.has(row.repoId) && idNames.get(row.repoId) !== name)
      return { reason: "repository_contract_unverified" };
    idNames.set(row.repoId, name);
    ids.set(name, [...(ids.get(name) ?? []), row.repoId]);
  }
  // Registering is offered only when this account's contract lists the route (CTC-4742).
  const canRegister =
    Array.isArray(doc.routes) &&
    doc.routes.some((value) => {
      const route = object(value);
      return route?.method === "POST" && route.path === REGISTER_PATH;
    });
  return { registered, ids, canRegister };
}

/** CTC-4742: every repository an active project of the chosen team uses, with its contract ID. */
async function teamRepositories(
  ctx: Ctx,
  journal: OnboardJournal,
  teamId: string,
  body: unknown,
  sameIdentity: () => unknown,
  signal?: AbortSignal,
): Promise<{ repositories: ExistingOnboardRepository[]; canRegister: boolean } | { reason: string }> {
  const list = object(body);
  if (!list || !Array.isArray(list.repositories) || list.repositories.length > 10_000)
    return { reason: "repository_inventory_shape" };
  const contract = await contractIds(ctx, journal, teamId, sameIdentity, signal);
  if ("reason" in contract) return contract;
  const repositories: ExistingOnboardRepository[] = [];
  const seen = new Set<string>();
  for (const value of list.repositories) {
    const row = object(value);
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.owner !== "string" ||
      !part.test(row.owner) ||
      typeof row.name !== "string" ||
      !part.test(row.name)
    )
      return { reason: "repository_inventory_shape" };
    // The contract says which repositories the team uses; this person's list says which of them
    // they can see (the server narrows it for a member).
    const name = key({ owner: row.owner, name: row.name });
    if (!contract.registered.has(name)) continue;
    if (seen.has(name)) return { reason: "repository_binding_ambiguous" };
    seen.add(name);
    const ids = contract.ids.get(name);
    if (!ids || ids.length !== 1 || ids[0] !== row.id)
      return { reason: "repository_id_unverified" };
    repositories.push({ teamId, owner: row.owner, name: row.name, repoId: ids[0]!, registered: true });
  }
  return { repositories, canRegister: contract.canRegister };
}

/** CTC-4742: repositories the GitHub App can reach that the team does not use yet, for an owner or
 *  admin only (only they can register one). Any read problem means no offers, never a stopped step. */
async function offeredRepositories(
  ctx: Ctx,
  journal: OnboardJournal,
  teamId: string,
  registered: readonly ExistingOnboardRepository[],
  signal?: AbortSignal,
): Promise<OfferedOnboardRepository[]> {
  if (!journalIdentity(ctx, journal, true)) return [];
  const read = await readExistingOnboardJson(ctx, "/api/v1/me/repositories/options", signal);
  if (!journalIdentity(ctx, journal, true) || "reason" in read) return [];
  const github = object(object(read.body)?.github);
  if (!github || github.connected !== true || !Array.isArray(github.repositories) || github.repositories.length > 10_000)
    return [];
  const used = new Set(registered.map(key));
  const offers: OfferedOnboardRepository[] = [];
  for (const value of github.repositories) {
    const row = object(value);
    if (!row || typeof row.owner !== "string" || !part.test(row.owner) || typeof row.name !== "string" || !part.test(row.name))
      return [];
    const name = key({ owner: row.owner, name: row.name });
    if (used.has(name)) continue;
    used.add(name);
    offers.push({ teamId, owner: row.owner, name: row.name, repoId: null, registered: false });
  }
  return offers;
}

/** CTC-4742: register one repository to the team's project. Only adds; nothing here removes one. */
async function registerToTeam(
  ctx: Ctx,
  journal: OnboardJournal,
  teamId: string,
  repository: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // The person who answered the question is the one who registers: checked right before the write.
  const cfg = journalIdentity(ctx, journal, true);
  if (!cfg) return "repository_identity_unverified";
  const expiry = cfg.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
  const bearer = cfg.key || (cfg.auth && Number.isFinite(expiry) && expiry > 30_000 ? cfg.auth.accessToken : undefined);
  if (!bearer) return "project_login_refresh_required";
  // Bounded like every read here, so a server that never answers can't hold setup.
  const deadline = AbortSignal.timeout(30_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await ctx.fetch(`${normalizeBaseUrl(cfg.baseUrl)}${REGISTER_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: bounded,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ teamId, repository }),
    });
    // A response is not evidence: the next read must show the repository on the team.
    return response.status === 200 ? null : "repository_register_unverified";
  } catch {
    return signal?.aborted ? "interrupted" : "repository_register_unverified";
  }
}

export function existingRepositoryAdapter(
  args: ParsedArgs,
  choose?: ChooseExistingRepositories,
): OnboardAdapter {
  let chosen: ExistingOnboardRepository[] | undefined;
  const requested = (
    repositories: ExistingOnboardRepository[],
    journal: OnboardJournal,
  ): ExistingOnboardRepository[] | null => {
    const explicit = args.flags.repo;
    if (explicit !== undefined) {
      const names = Array.isArray(explicit) ? explicit : [explicit];
      if (
        !names.length ||
        names.length > 100 ||
        !names.every(
          (name) =>
            typeof name === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
              name,
            ),
        )
      )
        return null;
      const wanted = names.map((name) => String(name).toLowerCase());
      if (new Set(wanted).size !== wanted.length) return null;
      const selected = wanted.map((name) =>
        repositories.find((row) => key(row) === name),
      );
      return selected.every((row): row is ExistingOnboardRepository => !!row)
        ? selected
        : null;
    }
    const saved = chosen ?? selectedOnboardRepositories(journal);
    if (!saved.length) return null;
    const selected = saved.map((row) =>
      repositories.find(
        (live) =>
          key(live) === key(row) &&
          live.teamId === row.teamId &&
          live.repoId === row.repoId,
      ),
    );
    return selected.every((row): row is ExistingOnboardRepository => !!row)
      ? selected
      : null;
  };
  const check: OnboardAdapter["check"] = async (ctx, journal, signal) => {
    const list = await readOnboardRepositoryInventory(ctx, journal, signal);
    if ("reason" in list) return waiting(list.reason);
    if (!list.repositories.length) return waiting("repository_inventory_empty");
    const rows = requested(list.repositories, journal);
    if (!rows)
      return args.flags.repo !== undefined ||
        chosen ||
        selectedOnboardRepositories(journal).length
        ? waiting("repository_selection_unverified")
        : choose
          ? { state: "pending" }
          : repositoryChoiceWait(list.repositories);
    return {
      state: "done",
      evidence: {
        repository: JSON.stringify(
          rows.map(({ teamId, owner, name, repoId }) => ({ teamId, owner, name, repoId })),
        ),
        count: rows.length,
        checkedAt: ctx.now().getTime(),
      },
    };
  };
  return {
    check,
    act: async (ctx, journal, signal) => {
      const list = await readOnboardRepositoryInventory(ctx, journal, signal);
      if ("reason" in list) return waiting(list.reason);
      if (!list.repositories.length)
        return waiting("repository_inventory_empty");
      if (!choose) return repositoryChoiceWait(list.repositories);
      const teamId = list.repositories[0]!.teamId;
      const offers = list.canRegister
        ? await offeredRepositories(ctx, journal, teamId, list.repositories, signal)
        : [];
      const choices: OnboardRepositoryChoice[] = [
        ...list.repositories.map((row) => ({ ...row })),
        ...offers.map((row) => ({ ...row })),
      ];
      let remove = () => {};
      const answer = await new Promise<string[] | null>((resolve, reject) => {
        const stopped = () => resolve(null);
        if (signal?.aborted) {
          stopped();
          return;
        }
        signal?.addEventListener("abort", stopped, { once: true });
        remove = () => signal?.removeEventListener("abort", stopped);
        Promise.resolve()
          // The hook gets copies: changing one can never change what is matched below.
          .then(() =>
            signal?.aborted ? null : choose(choices.map((row) => ({ ...row }))),
          )
          .then(resolve, reject);
      }).finally(() => remove());
      if (!answer || signal?.aborted) return waiting("interrupted");
      if (
        !Array.isArray(answer) ||
        !answer.length ||
        answer.length > 100 ||
        !answer.every((name) => typeof name === "string")
      )
        return waiting("repository_selection_unverified");
      const names = answer.map((name) => name.toLowerCase());
      if (new Set(names).size !== names.length)
        return waiting("repository_selection_unverified");
      const picked = names.map((name) => choices.find((row) => key(row) === name));
      if (!picked.every((row): row is OnboardRepositoryChoice => !!row))
        return waiting("repository_selection_unverified");
      // CTC-4742: a selected offer is registered to the team. Leaving a registered repository
      // unselected never unregisters it; nothing here removes a repository.
      for (const row of picked) {
        if (row.registered !== false) continue;
        const failed = await registerToTeam(ctx, journal, teamId, `${row.owner}/${row.name}`, signal);
        if (failed) return waiting(failed);
      }
      const fresh = picked.some((row) => row.registered === false)
        ? await readOnboardRepositoryInventory(ctx, journal, signal)
        : list;
      if ("reason" in fresh) return waiting(fresh.reason);
      const rows = names.map((name) => fresh.repositories.find((row) => key(row) === name));
      if (!rows.every((row): row is ExistingOnboardRepository => !!row))
        return waiting("repository_registration_visibility_pending");
      chosen = rows;
      return check(ctx, journal, signal);
    },
  };
}
