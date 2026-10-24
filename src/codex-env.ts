// codex-env.ts — `catalyst codex-env`: the OTEL_RESOURCE_ATTRIBUTES a Codex launch on this machine
// carries, so every Codex token row names the coding-account slot it ran as and the machine it ran on
// (CTC-6192 phase 2, CTC-6883). The slot comes from the local Codex login's `tokens.account_id`,
// hashed and matched against the `loginSha256` the workspace's coding accounts carry (CTC-6848). The
// account id, raw or hashed, never reaches the printed value: only the slot name does.
// ⛔ `--print` and `--apply` never wait on the network. They answer from the cached map, and a
// missing or stale map starts a detached `--refresh` that is never awaited.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { flagBool, flagString, type ParsedArgs } from "./args.js";
import { cliPath, codexAccountsCachePathFor, loadConfig, requireConfig, type Ctx } from "./config.js";
import { detachSelf } from "./detach.js";
import { CliError, UsageError } from "./errors.js";
import { needsNewerCloud, type CodingAccount } from "./execution.js";
import { apiClient } from "./transport.js";

/** How long a fetched account map answers before a launch starts a background refresh. */
export const CODEX_ACCOUNTS_TTL_SECONDS = 6 * 60 * 60;
/** The runner's wire key (CTC-2786): never a bare `account`, which the collector reads as a workspace. */
export const ACCOUNT_SLOT_ATTRIBUTE = "catalyst.account_slot";
export const HOST_NAME_ATTRIBUTE = "host.name";
/** A Codex login no cached coding account matches. Never a guess, never the account id. */
export const UNREGISTERED_SLOT = "unregistered";
/** No readable Codex login: the runner's `none:<reason>` convention. */
export const NO_LOGIN_SLOT = "none:no-login";

const LOGIN_HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export interface CodexAccount {
  accountSlot: string;
  loginSha256: string;
}

export interface CodexAccountsCache {
  fetchedAt: string;
  /** The workspace the map was fetched for; another workspace's map is a miss. */
  workspace: string;
  accounts: CodexAccount[];
}

export type CacheState = "fresh" | "stale" | "missing";

export type CodexEnvRun = (cmd: string, args: string[]) => { status: number; stderr: string };

export interface CodexEnvDeps {
  /** Process boundary for `launchctl`, so tests use a fake. */
  run?: CodexEnvRun;
  platform?: NodeJS.Platform;
  hostname?: () => string;
  /** Starts the background refresh. Tests record the call instead. */
  detach?: typeof detachSelf;
  argv?: string[];
}

/** A command that could not start (no `launchctl` on PATH) has no status; it fails with its spawn error. */
export const defaultRun: CodexEnvRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stderr: r.error ? r.error.message : r.stderr };
};

export function defaultCodexHome(ctx: Ctx): string {
  const set = ctx.env.CODEX_HOME?.trim();
  return set ? set : join(ctx.home, ".codex");
}

/** The local Codex login's account id: `tokens.account_id`, and no other field. A token is never read
 *  out, logged or printed. A parse error's message can quote the file, so it is dropped unread. */
export function readCodexAccountId(codexHome: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
  } catch {
    return null;
  }
  const id = object(object(parsed)?.tokens)?.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The same hash the cloud stores (lowercase hex SHA-256 of the UTF-8 account id). */
export function loginSha256(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

export function resolveSlot(accountId: string | null, cache: CodexAccountsCache | null): string {
  if (accountId === null) return NO_LOGIN_SLOT;
  const hash = loginSha256(accountId);
  return cache?.accounts.find((a) => a.loginSha256 === hash)?.accountSlot ?? UNREGISTERED_SLOT;
}

/** The runner's value rule (catalyst-cloud apps/runner/src/executors/harness-otel-env.ts:82-96): a
 *  blank value is the literal `unknown`, and `,` and `=` are structure, so each becomes `_`. */
export function attrValue(value: string): string {
  const trimmed = value.trim();
  return (trimmed.length > 0 ? trimmed : "unknown").replace(/[,=]/g, "_");
}

/** `os.hostname()` up to its first `.`, as `hostname -s` prints it. */
export function shortHostName(name: string): string {
  return name.split(".")[0]!;
}

/** Every pair already in `existing` is kept, in order and verbatim, except an earlier copy of a key
 *  set here and any `account` key (CTC-2786), which this never passes on. The slot and the host name
 *  are appended once each. */
export function mergeResourceAttributes(existing: string | undefined, set: { slot: string; hostName: string }): string {
  const ours: [string, string][] = [
    [ACCOUNT_SLOT_ATTRIBUTE, attrValue(set.slot)],
    [HOST_NAME_ATTRIBUTE, attrValue(set.hostName)],
  ];
  const dropped = new Set<string>([...ours.map(([key]) => key), "account"]);
  const kept = (existing ?? "").split(",").filter((pair) => {
    if (pair.trim() === "") return false;
    const eq = pair.indexOf("=");
    return !dropped.has((eq === -1 ? pair : pair.slice(0, eq)).trim());
  });
  return [...kept, ...ours.map(([key, value]) => `${key}=${value}`)].join(",");
}

/** Only the slot and its login hash survive into the cache; every other account field is left out. */
function codexAccounts(rows: readonly unknown[]): CodexAccount[] {
  return rows.flatMap((row) => {
    const a = object(row);
    return a && typeof a.accountSlot === "string" && typeof a.loginSha256 === "string" && LOGIN_HASH.test(a.loginSha256)
      ? [{ accountSlot: a.accountSlot, loginSha256: a.loginSha256 }]
      : [];
  });
}

export function readCodexAccountsCache(home: string): CodexAccountsCache | null {
  try {
    const parsed = object(JSON.parse(readFileSync(codexAccountsCachePathFor(home), "utf8")));
    if (!parsed || typeof parsed.fetchedAt !== "string" || typeof parsed.workspace !== "string" || !Array.isArray(parsed.accounts))
      return null;
    return { fetchedAt: parsed.fetchedAt, workspace: parsed.workspace, accounts: codexAccounts(parsed.accounts) };
  } catch {
    return null;
  }
}

function writeCodexAccountsCache(home: string, cache: CodexAccountsCache): string {
  const path = codexAccountsCachePathFor(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    throw new CliError(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`, "codex-env-cache-write");
  }
  return path;
}

/** The workspace this machine is logged in to, or null. A broken config is the login verb's to report. */
function configuredWorkspace(ctx: Ctx): string | null {
  try {
    return loadConfig(ctx.home)?.account ?? null;
  } catch {
    return null;
  }
}

function cacheState(ctx: Ctx, cache: CodexAccountsCache | null): CacheState {
  if (cache === null) return "missing";
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return "stale";
  const ageSeconds = Math.max(0, Math.floor((ctx.now().getTime() - fetchedMs) / 1000));
  return ageSeconds < CODEX_ACCOUNTS_TTL_SECONDS ? "fresh" : "stale";
}

/** Spawned detached and let go: the launch never waits for it, and a failed spawn is not a failed launch. */
function startRefresh(ctx: Ctx, deps: CodexEnvDeps): boolean {
  try {
    (deps.detach ?? detachSelf)(deps.argv ?? [cliPath(), "codex-env", "--refresh"], ctx.env);
    return true;
  } catch {
    return false;
  }
}

export interface CodexLaunchEnv {
  value: string;
  slot: string;
  hostName: string;
  cache: CacheState;
  refreshStarted: boolean;
}

/** The value for one Codex home, from the cache only. Logged out, there is no map and no refresh. */
export function codexLaunchEnv(ctx: Ctx, codexHome: string, deps: CodexEnvDeps = {}): CodexLaunchEnv {
  const workspace = configuredWorkspace(ctx);
  const cached = workspace === null ? null : readCodexAccountsCache(ctx.home);
  const cache = cached !== null && cached.workspace === workspace ? cached : null;
  const state = cacheState(ctx, cache);
  const refreshStarted = state !== "fresh" && workspace !== null && startRefresh(ctx, deps);
  const slot = resolveSlot(readCodexAccountId(codexHome), cache);
  const hostName = shortHostName((deps.hostname ?? osHostname)());
  return {
    value: mergeResourceAttributes(ctx.env.OTEL_RESOURCE_ATTRIBUTES, { slot, hostName }),
    slot: attrValue(slot),
    hostName: attrValue(hostName),
    cache: state,
    refreshStarted,
  };
}

async function refreshCodexAccounts(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const res = await apiClient(cfg, ctx).getJson<{ accounts?: CodingAccount[] } | CodingAccount[]>("/api/v1/coding-accounts", {
    accept: [404],
  });
  if (res.status === 404) throw needsNewerCloud("codex-env --refresh", cfg);
  const rows = Array.isArray(res.body) ? res.body : (res.body?.accounts ?? []);
  const cache: CodexAccountsCache = { fetchedAt: ctx.now().toISOString(), workspace: cfg.account, accounts: codexAccounts(rows) };
  const path = writeCodexAccountsCache(ctx.home, cache);
  const n = cache.accounts.length;
  if (args.json) ctx.stdout(JSON.stringify({ path, fetchedAt: cache.fetchedAt, accounts: n }));
  else
    ctx.stdout(
      `Cached ${n} Codex coding account${n === 1 ? "" : "s"} for this workspace in ${path}. Launches read it for ${CODEX_ACCOUNTS_TTL_SECONDS / 3600} hours, then refresh it in the background.`,
    );
  return 0;
}

export async function cmdCodexEnv(args: ParsedArgs, ctx: Ctx, deps: CodexEnvDeps = {}): Promise<number> {
  const modes = (["print", "apply", "refresh"] as const).filter((m) => flagBool(args, m));
  if (modes.length !== 1) throw new UsageError("codex-env needs exactly one of --print, --apply or --refresh");
  const mode = modes[0]!;
  const codexHome = flagString(args, "codex-home");
  if (mode === "refresh") {
    if (codexHome !== undefined) throw new UsageError("--codex-home goes with --print; --refresh reads only the workspace");
    return await refreshCodexAccounts(args, ctx);
  }
  if (mode === "apply") {
    if (codexHome !== undefined)
      throw new UsageError("--apply sets the environment for apps started from the Dock, which use the default Codex home; --codex-home goes with --print");
    const platform = deps.platform ?? process.platform;
    if (platform !== "darwin")
      throw new CliError(
        `codex-env --apply sets the macOS login environment with launchctl, and this machine runs ${platform}. Export the output of catalyst codex-env --print instead.`,
        "codex-env-unsupported-platform",
      );
  }
  const env = codexLaunchEnv(ctx, codexHome ?? defaultCodexHome(ctx), deps);
  if (mode === "apply") {
    const r = (deps.run ?? defaultRun)("launchctl", ["setenv", "OTEL_RESOURCE_ATTRIBUTES", env.value]);
    if (r.status !== 0) throw new CliError(`launchctl setenv failed (exit ${r.status}): ${r.stderr.trim()}`, "codex-env-launchctl");
  }
  if (args.json)
    ctx.stdout(
      JSON.stringify({
        OTEL_RESOURCE_ATTRIBUTES: env.value,
        slot: env.slot,
        hostName: env.hostName,
        cache: env.cache,
        refreshStarted: env.refreshStarted,
        applied: mode === "apply",
      }),
    );
  else if (mode === "print") ctx.stdout(env.value);
  else ctx.stdout(`Apps started from now on carry OTEL_RESOURCE_ATTRIBUTES=${env.value}`);
  return 0;
}
