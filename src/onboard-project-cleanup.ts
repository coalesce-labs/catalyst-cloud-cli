import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { readExistingOnboardJson } from "./onboard-existing.js";
import { readReturningProjects, type ReturningProject } from "./onboard-returning.js";
import type { OnboardJournal, OnboardStepResult } from "./onboard.js";

export type ConfirmProjectCleanup = (project: ReturningProject, lines: readonly string[]) => Promise<boolean>;
const waiting = (reason: string): OnboardStepResult => ({ state: "waiting", reason });
const signature = (project: ReturningProject) => JSON.stringify(
  [...(project.repositories ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
);

/** Archiving uses the existing reversible project action. Only the explicitly reviewed scope
 * is changed, after fresh inventory and identity checks. A failed write is never assumed absent. */
export async function archiveReturningProject(
  project: ReturningProject,
  ctx: Ctx,
  journal: OnboardJournal,
  confirm: ConfirmProjectCleanup | undefined,
  signal?: AbortSignal,
): Promise<OnboardStepResult> {
  const cfg = loadConfig(ctx.home);
  const sameIdentity = () => {
    const now = loadConfig(ctx.home);
    return cfg?.user && now?.user && cfg.account === journal.account &&
      cfg.user.id === journal.membershipId && now.account === cfg.account &&
      now.user.id === cfg.user.id && ["owner", "admin"].includes(now.user.role) &&
      normalizeBaseUrl(now.baseUrl) === journal.baseUrl && normalizeBaseUrl(cfg.baseUrl) === journal.baseUrl;
  };
  if (!sameIdentity() || !confirm) return waiting("returning_project_cleanup_unverified");
  const fresh = await readReturningProjects(ctx, journal, signal);
  const selected = "projects" in fresh ? fresh.projects.find(p => p.id === project.id) : undefined;
  if (!selected?.repositories?.length || selected.repositories.length > 64 || !sameIdentity())
    return waiting("returning_project_cleanup_unverified");
  const linked = async (): Promise<string[] | null> => {
    const names = new Set<string>();
    const boundedRead = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    for (const row of selected.repositories!) {
      const read = await readExistingOnboardJson(ctx, `/api/v1/me/projects/${encodeURIComponent(row.id)}/repositories`, boundedRead);
      if ("reason" in read || !read.body || typeof read.body !== "object") return null;
      const body = read.body as Record<string, unknown>;
      if (!body.project || typeof body.project !== "object" ||
        !("id" in body.project) || body.project.id !== row.id ||
        !("teamId" in body.project) || body.project.teamId !== selected.id ||
        !Array.isArray(body.repositories) || !body.repositories.length || body.repositories.length > 10_000) return null;
      const returnedNames = new Set<string>();
      for (const repository of body.repositories) {
        if (!repository || typeof repository !== "object" || !("fullName" in repository) ||
          typeof repository.fullName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository.fullName)) return null;
        names.add(repository.fullName); returnedNames.add(repository.fullName);
      }
      if (!returnedNames.has(row.name)) return null;
    }
    return [...names].sort();
  };
  const linkedNames = await linked();
  if (!linkedNames || !sameIdentity()) return waiting("returning_project_cleanup_unverified");
  const lines = [
    `Archive ${selected.name} (${selected.key}) in Catalyst.`,
    ...linkedNames.map(name => `Repository affected: ${name}.`),
    "Archiving removes this project’s repository registrations. Mirroring may stop where no other registration keeps a repository active.",
    "The project and its repository links are kept so it can be reactivated. Linear tickets and GitHub repositories are kept.",
    "New work may be held when these repositories are no longer registered for this project.",
  ];
  if (!(await confirm(selected, lines))) return { state: "done", reason: "returning_project_cleanup_declined" };
  if (signal?.aborted || !sameIdentity()) return waiting("returning_project_cleanup_unverified");
  const rechecked = await readReturningProjects(ctx, journal, signal);
  const current = "projects" in rechecked ? rechecked.projects.find(p => p.id === selected.id) : undefined;
  if (!current || signature(current) !== signature(selected) || !sameIdentity())
    return waiting("returning_project_cleanup_changed");
  const recheckedLinks = await linked();
  if (!recheckedLinks || JSON.stringify(recheckedLinks) !== JSON.stringify(linkedNames) || !sameIdentity())
    return waiting("returning_project_cleanup_changed");
  const bearer = cfg?.key || (cfg?.auth && Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() > 30_000
    ? cfg.auth.accessToken : undefined);
  if (!bearer) return waiting("returning_project_cleanup_unverified");
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  for (const row of selected.repositories) {
    if (bounded.aborted || !sameIdentity()) return waiting("returning_project_cleanup_unverified");
    try {
      const response = await ctx.fetch(`${journal.baseUrl}/api/v1/me/repositories/${encodeURIComponent(row.id)}/archive`, {
        method: "POST", redirect: "error", signal: bounded,
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json", "content-type": "application/json" },
        body: "{}",
      });
      if (response.status !== 200) return waiting("returning_project_cleanup_unverified");
      const body: unknown = await response.json();
      const returned = body && typeof body === "object" && "repository" in body ? body.repository : null;
      if (!returned || typeof returned !== "object" || !("id" in returned) || returned.id !== row.id ||
        !("linearTeamId" in returned) || returned.linearTeamId !== selected.id ||
        !("status" in returned) || returned.status !== "archived")
        return waiting("returning_project_cleanup_unverified");
      journal.changes.push({ kind: "project-archive", label: `Archived ${selected.name}: ${row.name}`,
        undo: "Reactivate the project from its Catalyst project page." });
    } catch { return waiting("returning_project_cleanup_unverified"); }
  }
  return { state: "done" };
}
