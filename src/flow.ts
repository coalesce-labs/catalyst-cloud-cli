// flow.ts — a repository's open pull request counts over time, one row per Flow bucket. The cloud
// owns the buckets and their day boundaries; this verb only names the repository and prints what came back.
import type { FlowSeries, TenantClient, TenantClientOptions } from "@catalyst-cloud/sdk";
import { resolve } from "node:path";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import { CliError, UsageError } from "./errors.js";
import { readLocalRepositoryName } from "./onboard-settings-context.js";
import { bearerFor } from "./oauth.js";
import { loadHttpSdk } from "./sdk.js";

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

export interface FlowDeps {
  createClient?: (options: TenantClientOptions) => Promise<Pick<TenantClient, "flow">> | Pick<TenantClient, "flow">;
  /** Default: this directory's GitHub origin, read from local git config only. */
  repoName?: (root: string) => Promise<string | null>;
  /** Default: the workspace contract's merge.repositories. */
  repositories?: () => Promise<ReadonlyArray<{ owner: string; name: string }>>;
}

function repoRequired(why: string): CliError {
  return new CliError(`flow needs a repository: pass --repo owner/name (${why})`, "repo-required", 2);
}

/** The zone the cloud cut the days in, from the answer's `boundary`; UTC when it names none. */
function zoneOf(series: FlowSeries): { timeZone: string } | { offsetMinutes: number } {
  const b = series["boundary"];
  if (b !== null && typeof b === "object" && "kind" in b) {
    if (b.kind === "iana" && "timeZone" in b && typeof b.timeZone === "string") {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: b.timeZone });
        return { timeZone: b.timeZone };
      } catch {
        // An unknown zone name prints in UTC rather than failing the whole read.
      }
    }
    if (b.kind === "fixed-offset" && "offsetMinutes" in b && typeof b.offsetMinutes === "number" && Number.isFinite(b.offsetMinutes)) {
      return { offsetMinutes: b.offsetMinutes };
    }
  }
  return { timeZone: "UTC" };
}

/** One wall-clock formatter per series; a fixed-offset zone reads through shifted UTC. */
function formatterFor(zone: { timeZone: string } | { offsetMinutes: number }): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "timeZone" in zone ? zone.timeZone : "UTC",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  });
}

/** `±HH:MM` for a fixed offset's minutes. */
function offsetText(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

interface Wall { date: string; time: string; offset: string }

function wallClock(ms: number, zone: { timeZone: string } | { offsetMinutes: number }, fmt: Intl.DateTimeFormat): Wall {
  const shifted = "offsetMinutes" in zone ? ms + zone.offsetMinutes * 60_000 : ms;
  const parts = fmt.formatToParts(shifted);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const offset = "offsetMinutes" in zone
    ? offsetText(zone.offsetMinutes)
    : part("timeZoneName").replace(/^GMT$/, "GMT+00:00").replace(/^GMT/, "");
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}`, offset };
}

/** One line per bucket: the start in the boundary's zone (a date when every bucket starts at local
 *  midnight, a local time with its offset otherwise), the open count, and `(now)` on the partial one. */
function rows(series: FlowSeries): string[] {
  const zone = zoneOf(series);
  const fmt = formatterFor(zone);
  const starts = series.columns.map((c) => wallClock(c.startMs, zone, fmt));
  const daily = starts.every((w) => w.time === "00:00");
  const when = starts.map((w) => (daily ? w.date : `${w.date}T${w.time}${w.offset}`));
  const counts = series.columns.map((c) => (c.pr === null ? "unavailable" : String(c.pr.open)));
  const width = Math.max(0, ...counts.map((c) => c.length));
  return series.columns.map((c, i) => `${when[i]}  ${counts[i]!.padStart(width)}${c.partial ? "  (now)" : ""}`);
}

export async function cmdFlow(args: ParsedArgs, ctx: Ctx, deps: FlowDeps = {}): Promise<number> {
  if (positionals(args).length > 0) throw new UsageError("flow takes no positional arguments; name the repository with --repo owner/name");
  const sdk = await loadHttpSdk();
  const rawPeriod = flagString(args, "period");
  const period = rawPeriod === undefined ? undefined : sdk.FLOW_PERIODS.find((p) => p === rawPeriod);
  if (rawPeriod !== undefined && period === undefined) throw new UsageError(`--period must be one of ${sdk.FLOW_PERIODS.join(", ")} (got "${rawPeriod}")`);
  const rawGranularity = flagString(args, "granularity");
  const granularity = rawGranularity === undefined ? undefined : sdk.FLOW_GRANULARITIES.find((g) => g === rawGranularity);
  if (rawGranularity !== undefined && granularity === undefined) throw new UsageError(`--granularity must be ${sdk.FLOW_GRANULARITIES.join(" or ")} (got "${rawGranularity}")`);
  const named = flagString(args, "repo");
  if (named !== undefined && !REPO_RE.test(named)) throw new UsageError(`--repo must be owner/name (got "${named}")`);

  const cfg = requireConfig(ctx);
  let repo = named;
  if (repo === undefined) {
    const local = await (deps.repoName ?? readLocalRepositoryName)(resolve("."));
    if (local === null) throw repoRequired("this directory is not a checkout with a GitHub origin");
    const repositories = await (deps.repositories ?? (async () => (await loadContract(ctx, cfg)).doc.merge.repositories))();
    const match = repositories.find((r) => `${r.owner}/${r.name}`.toLowerCase() === local);
    if (match === undefined) throw repoRequired(`this checkout's origin, ${local}, is not a repository of this workspace`);
    repo = `${match.owner}/${match.name}`;
  }

  const createClient = deps.createClient ?? ((options: TenantClientOptions) => sdk.createTenantClient(options));
  const client = await createClient({ key: await bearerFor(ctx, cfg), baseUrl: cfg.baseUrl, fetch: ctx.fetch });
  const result = await client.flow.series({ repo, period, granularity });
  if (result.outcome !== "ok") throw new CliError(`flow for ${repo}: ${result.reason}`, result.outcome, 2, "status" in result ? result.status : undefined);
  if (args.json) ctx.stdout(JSON.stringify(result.series.columns));
  else for (const line of rows(result.series)) ctx.stdout(line);
  return 0;
}
