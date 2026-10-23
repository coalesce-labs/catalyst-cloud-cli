// Repository lifecycle commands use the key routes under /api/v1/agent/repos, independent of local checkouts.
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { MeError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

const LIST_ROUTE = "/api/v1/agent/repos";
interface Repository extends Record<string, unknown> {
  id: string;
  owner: string;
  name: string;
  status: string;
}
interface RepositoryList extends Record<string, unknown> {
  repositories: Repository[];
  canManage: boolean;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function repository(value: unknown): value is Repository {
  return object(value) && text(value.id) && text(value.owner) && text(value.name) && text(value.status);
}
function decodeList(value: unknown): RepositoryList {
  if (!object(value) || !Array.isArray(value.repositories) || !value.repositories.every(repository) || typeof value.canManage !== "boolean") {
    throw new MeError(`GET ${LIST_ROUTE} returned an unexpected repository list shape`, "shape");
  }
  return { ...value, repositories: value.repositories, canManage: value.canManage };
}
function elapsedTime(value: unknown, now: Date): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  if (minutes === 0) return "just now";
  const [amount, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}
function renderRow(row: Repository, ctx: Ctx): void {
  let state = row.status;
  if (state === "paused") {
    const actor = text(row.pausedBy) ? row.pausedBy : object(row.pausedBy)
      ? [row.pausedBy.email, row.pausedBy.actor, row.pausedBy.name, row.pausedBy.label].find(text) ?? "an operator"
      : "an operator";
    const time = elapsedTime(row.pausedAt, ctx.now());
    state += ` by ${actor}${time ? ` ${time}` : ""}${text(row.pauseReason) ? `: ${row.pauseReason}` : ""}`;
  }
  ctx.stdout(`${row.owner}/${row.name}: ${state}`);
  const projects = Array.isArray(row.projects) ? row.projects.filter(object).filter((p) => text(p.name)).map((p) => `${p.name}${text(p.teamKey) ? ` (${p.teamKey})` : ""}`) : [];
  ctx.stdout(`  projects: ${projects.length ? projects.join(", ") : "none"}`);
}
function refuse(args: ParsedArgs, ctx: Ctx, message: string, status?: number, body: unknown = {}): number {
  if (args.json) ctx.stdout(JSON.stringify({ ...(object(body) ? body : {}), ...(status === undefined ? {} : { status }), message }));
  else ctx.stdout(`refused${status === undefined ? "" : ` (${status})`}: ${message}`);
  return 1;
}
function serverDetail(body: unknown): string {
  if (!object(body)) return "";
  const details = [body.error, body.code, body.message, body.reason].filter(text);
  return details.length ? ` (${[...new Set(details)].join(": ")})` : "";
}

export async function cmdRepoStatus(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [action, wanted, ...extra] = positionals(args);
  if (action !== "status" && action !== "pause" && action !== "resume") throw new UsageError("repo needs status, pause or resume");
  if (["write", "apply", "with-check"].some((flag) => args.flags[flag] !== undefined)) {
    throw new UsageError(`repo ${action} does not take local write flags`);
  }
  const rawReason = flagString(args, "reason");
  const reason = rawReason?.trim();
  if (action === "status") {
    if (wanted !== undefined || extra.length || rawReason !== undefined) throw new UsageError("repo status takes no arguments or --reason");
  } else {
    if (!wanted || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(wanted) || extra.length) {
      throw new UsageError(`repo ${action} needs one repository as owner/name`);
    }
    if (action === "pause" && reason === undefined) throw new UsageError("repo pause needs --reason with 1 to 500 characters");
    if (reason !== undefined && (reason.length === 0 || reason.length > 500)) throw new UsageError("--reason must contain 1 to 500 characters after trimming");
  }
  const cfg = requireConfig(ctx);
  const client = apiClient(cfg, ctx);
  const accept = [400, 403, 404, 409];
  const response = await client.getJson(LIST_ROUTE, { accept, parseAccepted: true });
  if (response.status >= 400) {
    const message = response.status === 404
      ? "this Catalyst Cloud does not serve repository status yet (needs a newer cloud)"
      : response.status === 403 ? "your login cannot read repository status" : "repository status request failed";
    return refuse(args, ctx, message + serverDetail(response.body), response.status, response.body);
  }
  const result = decodeList(response.body);
  const role = cfg.user?.role ? `; your role is ${cfg.user.role}` : "";
  if (action === "status") {
    if (args.json) ctx.stdout(JSON.stringify(result));
    else {
      for (const row of result.repositories) renderRow(row, ctx);
      if (result.repositories.length === 0) ctx.stdout("No repositories are visible to your login.");
      ctx.stdout(result.canManage
        ? "You can pause or resume repositories as a workspace owner or admin."
        : `Pause or resume requires a workspace owner or admin${role}.`);
    }
    return 0;
  }
  const roleRefusal = `pausing or resuming a repository requires a workspace owner or admin${role}`;
  if (!result.canManage) return refuse(args, ctx, roleRefusal, 403, { error: "forbidden" });
  const matches = result.repositories.filter((row) => `${row.owner}/${row.name}`.toLowerCase() === wanted?.toLowerCase());
  const selected = matches[0];
  if (!selected) return refuse(args, ctx, `no repository ${wanted} is visible to your login; check catalyst repo status`, undefined, { error: "repository-not-visible" });
  if (matches.length !== 1) return refuse(args, ctx, `repository ${wanted} is ambiguous; check catalyst repo status`, undefined, { error: "repository-ambiguous" });
  if (selected.status === "archived") return refuse(args, ctx, `${wanted} is archived and cannot be paused or resumed`, 409, { error: "repository-archived" });
  const written = await client.postJson(`${LIST_ROUTE}/${action}`, reason === undefined ? { repoId: selected.id } : { repoId: selected.id, reason }, { accept });
  if (written.status >= 400) {
    const detail = serverDetail(written.body);
    let message = `could not ${action} ${wanted}`;
    if (written.status === 403) message = roleRefusal;
    else if (written.status === 404) {
      // Use descriptive evidence rather than requiring an undocumented server code spelling.
      if (/route|endpoint/i.test(detail)) message = `this Catalyst Cloud does not serve repository ${action} yet (needs a newer cloud)`;
      else if (/repo(sitory)?/i.test(detail)) message = `repository ${wanted} is no longer available; check catalyst repo status`;
      else message = `${wanted}: the repository or this route is no longer available`;
    }
    return refuse(args, ctx, message + detail, written.status, written.body);
  }
  // POST envelopes are not established by this fixture. Only a fresh read establishes the row.
  // Never repeat a successful POST if verification fails.
  let refreshed: Repository;
  try {
    const after = await client.getJson(LIST_ROUTE);
    const found = decodeList(after.body).repositories.find((row) => row.id === selected.id);
    if (!found) throw new Error("the repository is no longer visible to your login");
    refreshed = found;
  } catch (error) {
    return refuse(args, ctx, `the ${action} write succeeded, but repository status could not be read: ${error instanceof Error ? error.message : String(error)}`, undefined, {
      error: "repository-status-unavailable", writeSucceeded: true, repoId: selected.id,
    });
  }
  if (args.json) ctx.stdout(JSON.stringify(refreshed));
  else renderRow(refreshed, ctx);
  return 0;
}
