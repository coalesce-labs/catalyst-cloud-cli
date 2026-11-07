// waiting-on-me.ts — the self-scoped Waiting-on-me view for `ask list` (CTC-5644). The route's contract
// is not defined anywhere this repository can read, so every reply is checked and anything unproven is
// a fallback reason: the caller walks /api/v1/issues instead, and the answer stays today's.
import { MeError } from "./errors.js";
import { NEXT_CURSOR_HEADER, SERVER_PAGE_CAP } from "./pagination.js";
import type { ApiClient } from "./transport.js";

export const WAITING_ON_ME_PATH = "/api/v1/views/waiting-on-me";
export const VIEW_MAX_PAGES = 10;
const FALLBACK_STATUSES = [400, 403, 404, 405, 409, 410, 422];

export type ViewFallback = "absent" | "refused" | "no-linear-identity" | "shape" | "other-person" | "unpaged" | "stalled" | "overrun";
export type ViewRead = { ok: true; rows: Record<string, unknown>[]; pages: number } | { ok: false; reason: ViewFallback };

type Row = Record<string, unknown>;

/** The rows of a view reply: a bare array, or the first array under a known key. `null` for any other
 *  shape, never `[]`, so an unknown envelope is not read as "no asks". */
export function viewRowsOf(body: unknown): Row[] | null {
  if (Array.isArray(body)) return body as Row[];
  if (body && typeof body === "object") {
    for (const key of ["rows", "items", "issues", "asks", "data"]) {
      const v = (body as Row)[key];
      if (Array.isArray(v)) return v as Row[];
    }
  }
  return null;
}

/** The D4 row rules: anything the CLI cannot prove it can rank like the walk is a fallback reason. */
export function checkViewRows(rows: Row[], linearUserId: string): ViewFallback | null {
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.identifier !== "string") return "shape";
    if (r.assignee_id !== linearUserId) return "other-person";
    if (r.labels !== undefined && !Array.isArray(r.labels)) return "shape";
    if (r.relations !== undefined && !Array.isArray(r.relations)) return "shape";
    for (const rel of (r.relations as Row[] | undefined) ?? []) {
      if (!rel || typeof rel !== "object") return "shape";
      if (rel.type !== "blocks" || rel.issue_identifier !== r.identifier) continue;
      if (!("related_state" in rel) || (rel.related_state !== null && typeof rel.related_state !== "string")) return "shape";
    }
  }
  return null;
}

function statusReason(status: number): ViewFallback {
  if (status === 404 || status === 405 || status === 410) return "absent";
  return "refused";
}

function bodyHasMore(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Row;
  const cursor = b.nextCursor ?? b.next_cursor;
  return (typeof cursor === "string" && cursor !== "") || b.hasMore === true;
}

/** Read the calling member's asks. 401 and 429 throw, as the walk's first page would. */
export async function readWaitingOnMe(api: ApiClient, linearUserId: string): Promise<ViewRead> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let pages = 1; pages <= VIEW_MAX_PAGES; pages++) {
    let res;
    try {
      res = await api.getJson<unknown>(WAITING_ON_ME_PATH, { query: { limit: SERVER_PAGE_CAP, after }, accept: FALLBACK_STATUSES, parseAccepted: true });
    } catch (e) {
      if (e instanceof MeError && e.kind === "shape") return { ok: false, reason: "shape" };
      throw e;
    }
    if (res.status !== 200) {
      const code = (res.body as { error?: unknown } | undefined)?.error;
      return { ok: false, reason: res.status === 409 && code === "no_linear_identity" ? "no-linear-identity" : statusReason(res.status) };
    }
    const page = viewRowsOf(res.body);
    if (page === null) return { ok: false, reason: "shape" };
    const bad = checkViewRows(page, linearUserId);
    if (bad) return { ok: false, reason: bad };
    rows.push(...page);
    const next = res.headers.get(NEXT_CURSOR_HEADER);
    if (next === null || next === "") {
      if (bodyHasMore(res.body)) return { ok: false, reason: "unpaged" };
      return { ok: true, rows, pages };
    }
    if (seen.has(next)) return { ok: false, reason: "stalled" };
    seen.add(next);
    after = next;
  }
  return { ok: false, reason: "overrun" };
}
