// published.ts — "what is the newest release of this package?", read from the npm registry. This is
// the ONLY non-tenant host this package contacts. `ready` has always been an offline command, so the
// answer is cached for six hours, the request is capped at 1500ms, and EVERY failure returns a
// reason instead of throwing: a customer who cannot reach npm must still get a verdict (CTC-2160).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readApprovalCache } from "./approved-release.js";
import { LEGACY_PACKAGE_NAME, publishedCachePathFor, type Ctx } from "./config.js";

/** CTC-3479 — asks about the forwarder package whichever package is installed. The release publishes
 *  @catalyst-cloud/cli first and the forwarder last, at one version, so the forwarder's `latest`
 *  never names a release that either package lacks. The upgrade hint names the installed package
 *  (config.ts updatePackageName). */
export const REGISTRY_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${encodeURIComponent(LEGACY_PACKAGE_NAME)}/dist-tags`;
export const PUBLISHED_TTL_SECONDS = 6 * 60 * 60;
export const PUBLISHED_TIMEOUT_MS = 1500;

export interface PublishedCache {
  fetchedAt: string;
  latest: string;
}

export interface PublishedLookup {
  /** The latest published version, or null when it could not be determined. */
  latest: string | null;
  /** Why not, for the report line. Null on success. */
  reason: string | null;
  source: "cache" | "network" | "stale-cache" | "none" | "approved";
  /** The approved Cloud skills pack version, when `source` is `approved` and the release names one. */
  skills?: string;
}

function readPublishedCache(home: string): PublishedCache | null {
  const path = publishedCachePathFor(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PublishedCache>;
    if (typeof parsed.fetchedAt !== "string" || typeof parsed.latest !== "string") return null;
    return parsed as PublishedCache;
  } catch {
    return null;
  }
}

/** A write failure (read-only home) must not break the lookup — best-effort only. */
function writePublishedCache(home: string, cache: PublishedCache): void {
  try {
    const path = publishedCachePathFor(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best-effort: a stale or missing cache next time is not a new failure mode
  }
}

function fallback(cached: PublishedCache | null, reason: string): PublishedLookup {
  return cached ? { latest: cached.latest, reason: null, source: "stale-cache" } : { latest: null, reason, source: "none" };
}

export async function latestPublishedVersion(ctx: Ctx, opts: { offline?: boolean } = {}): Promise<PublishedLookup> {
  const cached = readPublishedCache(ctx.home);
  const ageSeconds = cached ? Math.max(0, Math.floor((ctx.now().getTime() - Date.parse(cached.fetchedAt)) / 1000)) : Infinity;
  if (cached && ageSeconds < PUBLISHED_TTL_SECONDS) {
    return { latest: cached.latest, reason: null, source: "cache" };
  }
  if (opts.offline) {
    return cached ? { latest: cached.latest, reason: null, source: "cache" } : { latest: null, reason: "offline", source: "none" };
  }

  let res: Response;
  try {
    res = await ctx.fetch(REGISTRY_DIST_TAGS_URL, {
      signal: AbortSignal.timeout(PUBLISHED_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : err instanceof Error ? err.message : String(err);
    return fallback(cached, reason);
  }
  if (!res.ok) return fallback(cached, `registry answered ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fallback(cached, "the registry sent an unreadable body");
  }
  const latest = (body as { latest?: unknown } | null)?.latest;
  if (typeof latest !== "string") return fallback(cached, "the registry sent no dist-tags.latest");

  writePublishedCache(ctx.home, { fetchedAt: ctx.now().toISOString(), latest });
  return { latest, reason: null, source: "network" };
}

/**
 * CTC-6708 — the CLI's "newest" answer is the approved release once this install has read one: every
 * applying release check records it, the 15-minute schedule included. Reading it is local, so this
 * adds no network call. Only an install that has never read an approved release falls back to the
 * npm lookup above, and its answer stays labelled the latest published version, never approved.
 */
export async function newestCliVersion(ctx: Ctx, opts: { offline?: boolean } = {}): Promise<PublishedLookup> {
  const approved = readApprovalCache(ctx.home)?.release;
  const cli = approved?.members.cli;
  if (approved && cli) return { latest: cli, reason: null, source: "approved", ...(approved.skills.cloud ? { skills: approved.skills.cloud.version } : {}) };
  return latestPublishedVersion(ctx, opts);
}
