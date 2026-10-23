// approved-release.ts — the release Catalyst approved for every component an install keeps, read
// once per release check (CTC-6708). The approved record names each release-train member's exact
// version together, so the CLI's "newest" answer comes from it, never from npm's `latest` tag.
//
// Two transports carry the same record:
//   - a signed-in CLI reads the member route `GET /api/v1/releases/approved`;
//   - an enrolled machine's desired-release answer (`GET /api/v1/hosts/desired-release`, read inside
//     the supervisor container by runner-update.ts) carries it as `release.components`, beside the
//     digest-pinned images it already names. The host credential never leaves Docker.
//
// Parsing is strict: exact stable versions only (no tags, ranges or pre-releases), every version on
// the record's declared train line, skills packs pinned to one of two known repositories at a full
// commit. A record on another train is reported and never applied: automatic moves stay on the
// MAJOR.MINOR line this CLI ships on. The last record read is cached for diagnostics only; a failed
// read never applies a cached record.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDirFor, loadConfig, readManifest, type Ctx } from "./config.js";
import { CliError, MeError } from "./errors.js";
import { isRecord, writePrivateAtomic, type DesiredReleaseRead } from "./runner-update.js";
import { apiClient } from "./transport.js";

export const APPROVED_RELEASE_PATH = "/api/v1/releases/approved";
export const APPROVED_RELEASE_CACHE_FILE = "approved-release.json";

/** Train members the approved record may name. Only some are installed on a customer's machine;
 *  the rest are inventory metadata and never something this CLI installs. */
export const RELEASE_MEMBERS = [
  "cli",
  "forwarder",
  "plugin",
  "sdk",
  "sdk-replica-node",
  "sdk-replica-browser",
  "schema",
  "replicate",
  "read-model",
  "design",
  "installer",
] as const;
export type ReleaseMember = (typeof RELEASE_MEMBERS)[number];

export const SKILL_PACKS = ["cloud", "dev"] as const;
export type SkillPack = (typeof SKILL_PACKS)[number];
/** The only repository each pack may come from. A record naming another is refused whole. */
export const SKILL_PACK_REPOSITORIES: Readonly<Record<SkillPack, string>> = {
  cloud: "coalesce-labs/catalyst-cloud-skills",
  dev: "coalesce-labs/catalyst-dev-skills",
};

export interface ApprovedSkillPack {
  version: string;
  repository: string;
  commit: string;
}

export interface ApprovedRelease {
  approvalId: string;
  generation: number;
  approvedAtMs: number;
  /** MAJOR.MINOR, e.g. "0.16". */
  releaseLine: string;
  members: Partial<Record<ReleaseMember, string>>;
  skills: Partial<Record<SkillPack, ApprovedSkillPack>>;
}

export type ApprovedParse = { ok: true; release: ApprovedRelease } | { ok: false; reason: "response_invalid" };

const STABLE_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const RELEASE_LINE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const APPROVAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const posInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** An exact stable version, or null. Unlike skills.ts's lenient `semverOlder`, this is the authority
 *  check: `0.16.28` passes; `latest`, `^0.16.28`, `0.16.28-rc.1`, `v0.16.28` and `0.16` do not. */
export function exactVersion(value: unknown): string | null {
  return typeof value === "string" && STABLE_VERSION.test(value) ? value : null;
}

/** MAJOR.MINOR of an exact version. */
export function trainOf(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

/** Compare two exact versions: negative when `a` is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The train this CLI ships on; automatic updates never leave it. */
export function supportedReleaseLine(): string {
  return trainOf(readManifest().version);
}

/** Parse the approved record from an unknown body. Any malformed field refuses the whole record. */
export function parseApprovedRelease(input: unknown): ApprovedParse {
  const invalid: ApprovedParse = { ok: false, reason: "response_invalid" };
  if (!isRecord(input) || input.schemaVersion !== 1) return invalid;
  if (typeof input.approvalId !== "string" || !APPROVAL_ID.test(input.approvalId)) return invalid;
  if (!posInt(input.generation) || !posInt(input.approvedAtMs)) return invalid;
  if (typeof input.releaseLine !== "string" || !RELEASE_LINE.test(input.releaseLine)) return invalid;
  const releaseLine = input.releaseLine;
  if (!isRecord(input.members)) return invalid;
  const members: ApprovedRelease["members"] = {};
  for (const member of RELEASE_MEMBERS) {
    const value = input.members[member];
    if (value === undefined) continue;
    const version = exactVersion(value);
    if (version === null || trainOf(version) !== releaseLine) return invalid;
    members[member] = version;
  }
  if (members.cli === undefined) return invalid;
  const skills: ApprovedRelease["skills"] = {};
  if (input.skills !== undefined) {
    if (!isRecord(input.skills)) return invalid;
    for (const pack of SKILL_PACKS) {
      const value = input.skills[pack];
      if (value === undefined) continue;
      if (!isRecord(value)) return invalid;
      const version = exactVersion(value.version);
      if (version === null || trainOf(version) !== releaseLine) return invalid;
      if (value.repository !== SKILL_PACK_REPOSITORIES[pack]) return invalid;
      if (typeof value.commit !== "string" || !COMMIT.test(value.commit)) return invalid;
      skills[pack] = { version, repository: value.repository, commit: value.commit };
    }
  }
  return {
    ok: true,
    release: { approvalId: input.approvalId, generation: input.generation, approvedAtMs: input.approvedAtMs, releaseLine, members, skills },
  };
}

/** Why no approved record is usable for components. */
export type ApprovalUnavailable =
  | "signed_out"
  | "credential_refused"
  | "unreachable"
  | "not_provided"
  | "response_invalid"
  | "envelope_mismatch";

export type ApprovedRead =
  | { kind: "approved"; release: ApprovedRelease; source: "network" | "host" }
  | { kind: "unavailable"; reason: ApprovalUnavailable };

/** Read the member route with this machine's sign-in. Never throws; every failure is a reason. */
export async function readMemberApproval(ctx: Ctx): Promise<ApprovedRead> {
  let cfg;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    return { kind: "unavailable", reason: "signed_out" };
  }
  if (!cfg) return { kind: "unavailable", reason: "signed_out" };
  try {
    const res = await apiClient(cfg, ctx).getJson(APPROVED_RELEASE_PATH, { accept: [404] });
    if (res.status === 404) return { kind: "unavailable", reason: "not_provided" };
    const body = isRecord(res.body) && res.body.ok === true ? res.body.release : res.body;
    const parsed = parseApprovedRelease(body);
    return parsed.ok ? { kind: "approved", release: parsed.release, source: "network" } : { kind: "unavailable", reason: parsed.reason };
  } catch (err) {
    if (err instanceof MeError && err.kind === "network") return { kind: "unavailable", reason: "unreachable" };
    if (err instanceof CliError && (err.status === 401 || err.status === 403)) return { kind: "unavailable", reason: "credential_refused" };
    if (err instanceof MeError && err.kind === "shape") return { kind: "unavailable", reason: "response_invalid" };
    return { kind: "unavailable", reason: "unreachable" };
  }
}

/** The component record a host's desired-release answer carries, from the same read the image
 *  update used. A legacy answer with images only reads `not_provided`; a record whose generation is
 *  not the image generation reads `envelope_mismatch`, so the two halves never mix snapshots. */
export function hostApproval(read: DesiredReleaseRead): ApprovedRead {
  if (read.kind === "no_credential") return { kind: "unavailable", reason: "signed_out" };
  if (read.kind === "unreachable") return { kind: "unavailable", reason: "unreachable" };
  if (read.status === 401 || read.status === 403) return { kind: "unavailable", reason: "credential_refused" };
  // 404 and 503 are the cloud saying it has no approved release to name; anything else failed.
  if (read.status === 404 || read.status === 503) return { kind: "unavailable", reason: "not_provided" };
  if (read.status !== 200) return { kind: "unavailable", reason: "unreachable" };
  if (!isRecord(read.body) || read.body.ok !== true || !isRecord(read.body.release)) return { kind: "unavailable", reason: "response_invalid" };
  const release = read.body.release;
  if (release.components === undefined) return { kind: "unavailable", reason: "not_provided" };
  const parsed = parseApprovedRelease(release.components);
  if (!parsed.ok) return { kind: "unavailable", reason: parsed.reason };
  if (parsed.release.generation !== release.generation) return { kind: "unavailable", reason: "envelope_mismatch" };
  return { kind: "approved", release: parsed.release, source: "host" };
}

export interface ApprovalCache {
  observedAtMs: number;
  release: ApprovedRelease;
}

export function approvalCachePathFor(home: string): string {
  return join(configDirFor(home), APPROVED_RELEASE_CACHE_FILE);
}

/** The last approved record an applying check read, for an offline diagnostic. Never applied. */
export function readApprovalCache(home: string): ApprovalCache | null {
  const path = approvalCachePathFor(home);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !posInt(parsed.observedAtMs)) return null;
    const release = parseApprovedRelease(parsed.release);
    return release.ok ? { observedAtMs: parsed.observedAtMs, release: release.release } : null;
  } catch {
    return null;
  }
}

/** Best effort: a read-only home keeps working without its diagnostic cache. */
export function writeApprovalCache(home: string, cache: ApprovalCache): void {
  try {
    const path = approvalCachePathFor(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateAtomic(path, `${JSON.stringify({ observedAtMs: cache.observedAtMs, release: { schemaVersion: 1, ...cache.release } }, null, 2)}\n`);
  } catch {
    // the diagnostic cache is optional
  }
}
