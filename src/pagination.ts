// pagination.ts — the mirror's keyset contract, followed. `/issues` and `/pulls` answer a page plus
// three headers: X-Mirror-Cursor (the head seq the page is consistent with), X-Mirror-Total (the
// WHOLE scope's count, independent of the page) and X-Mirror-Next-Cursor — present ONLY while rows
// remain, ABSENT on the last page. A caller that ignores them gets a page and believes it is the
// answer, which is the whole of CTC-2010.
//
// The SDK's createTenantClient parses these same three headers into a typed KeysetPageMeta, and this
// module deliberately does not use it: that client takes a STATIC `key`, while this bundle resolves
// its bearer fresh per request through `bearerFor` (an OAuth session refreshes mid-walk), and `ask`
// must keep working on a runtime where the SDK cannot load (src/sdk.ts). Adopting it is the CTC-2004
// Tier 2 migration that also deletes transport.ts — not this change.
import { CliError } from "./errors.js";
import type { ApiClient, GetOptions } from "./transport.js";

export const NEXT_CURSOR_HEADER = "x-mirror-next-cursor";
export const TOTAL_HEADER = "x-mirror-total";
/** CTC-4556 — the `/issues` params that narrowed the page, comma-separated; absent on older mirrors. */
export const SCOPE_HEADER = "x-mirror-scope";
/** The server clamps every page to this regardless of the requested `limit` (MAX_VIEW_LIMIT). */
export const SERVER_PAGE_CAP = 500;
/** 100 pages × 500 rows = 50,000. Reaching it is a refusal, not an ending. */
export const MAX_PAGES = 100;

export interface Page {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  total: number | null;
  /** The params the cloud says narrowed this page, or null when it did not say. */
  scope: string[] | null;
}

/** The API answers a list route with either a bare array or `{rows|items|issues|...: []}`. */
export function rowsOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    for (const key of ["rows", "items", "issues", "pulls", "projects", "cycles", "results", "changes", "data"]) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function readScope(headers: Headers): string[] | null {
  const raw = headers.get(SCOPE_HEADER);
  if (raw === null) return null;
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

export function readTotal(headers: Headers): number | null {
  const raw = headers.get(TOTAL_HEADER);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export async function fetchPage(api: ApiClient, path: string, query: GetOptions["query"]): Promise<Page> {
  const res = await api.getJson<unknown>(path, { query });
  const next = res.headers.get(NEXT_CURSOR_HEADER);
  return {
    rows: rowsOf(res.body),
    nextCursor: next === null || next === "" ? null : next,
    total: readTotal(res.headers),
    scope: readScope(res.headers),
  };
}

export async function fetchAllPages(
  api: ApiClient,
  path: string,
  query: GetOptions["query"],
): Promise<{ rows: Record<string, unknown>[]; total: number | null; pages: number; scope: string[] | null }> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let total: number | null = null;
  let scope: string[] | null = null;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const page = await fetchPage(api, path, { ...query, limit: SERVER_PAGE_CAP, after });
    rows.push(...page.rows);
    if (page.total !== null) total = page.total;
    // A param counts as applied only if every page says so.
    scope = pages === 1 ? page.scope : scope && page.scope && scope.filter((p) => page.scope?.includes(p));
    if (page.nextCursor === null) return { rows, total, pages, scope };
    // ⛔ A cursor that does not advance is an infinite loop, not a long read.
    if (seen.has(page.nextCursor)) {
      throw new CliError(
        `GET ${path} repeated a page cursor after ${rows.length} rows — the cloud is not advancing the keyset, so --all cannot finish`,
        "pagination-stalled",
        1,
      );
    }
    seen.add(page.nextCursor);
    after = page.nextCursor;
  }
  throw new CliError(
    `GET ${path} still had pages after ${MAX_PAGES} of them (${rows.length} rows) — narrow the scope with --team/--project/--state, or read this through the replica`,
    "pagination-overrun",
    1,
  );
}

/** ⛔ N IS WHAT THE SERVER SENT, not what a client-side filter left. `--team ZZZ` over a capped page
 *  would otherwise read "truncated at 0 of 120", which names the filter, not the truncation. */
export function truncationNotice(page: Page): string | null {
  if (page.nextCursor === null) return null;
  const of = page.total === null ? `an unknown total (the cloud sent no ${TOTAL_HEADER})` : String(page.total);
  return `truncated at ${page.rows.length} of ${of} — re-run with --all to read the whole scope`;
}
