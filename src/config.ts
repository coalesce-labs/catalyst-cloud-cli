// config.ts — ~/.config/catalyst-cloud/customer.json and its siblings. The ONLY place the base URL
// and the `/api/v1` prefix are joined: the SDK wants the base with the prefix, GET /me without.
import type { NdjsonSink } from "./events-cloud-tail.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

import { parseMachinePaths, resolveCatalystPath } from "../vendor/paths/index.js";
import { machinePathsFile } from "../vendor/paths/node.js";

/** CTC-3479 — the package this CLI publishes as. Its command is `catalyst`. */
export const PACKAGE_NAME = "@catalyst-cloud/cli";
/** The old package name, now a thin forwarder that depends on PACKAGE_NAME at the same version. The
 *  npx login hints keep naming it until CTC-3480/3481 move them; upgrade hints name whichever package
 *  is installed (updatePackageName). `npx @catalyst-cloud/cli`
 *  cannot run a verb: that package has two bins and neither is named `cli`, so npx cannot pick one.
 *  The forwarder has a bin named after itself, so `npx @catalyst-cloud/catalyst-skills` still works. */
export const LEGACY_PACKAGE_NAME = "@catalyst-cloud/catalyst-skills";
export const DEFAULT_BASE_URL = "https://staging.catalystcloud.dev";
export const CONFIG_MODE = 0o600;

/** The person behind a personal key (`ctc_user_`), as `GET /api/v1/me` names them. Absent for an
 *  account (host) key. `linearUserId` is the resolved Linear identity or `null` when the tenant has
 *  not matched it yet — it is what "what needs me" filters on, so it is never guessed. */
export interface MeUser {
  id: string;
  label: string;
  email: string | null;
  role: "owner" | "admin" | "member";
  linearUserId: string | null;
}

export interface MeIdentity {
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
  user?: MeUser;
}

/** CTC-2112 — a person's WorkOS device-flow session, stored in place of a personal key. The access
 *  token is short-lived and rotated silently; `sessionId` is the JWT's `sid`, `expiresAt` its `exp`. */
export interface OauthAuth {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  /** ISO 8601; the access token's `exp`. Refreshed within 60s of it. */
  expiresAt: string;
  sessionId: string;
}

export interface CustomerConfig {
  baseUrl: string;
  /** A personal (or account) key. Present for the key rail; absent when `auth` (OAuth) is present —
   *  a config carries EXACTLY ONE of {key, auth}. */
  key?: string;
  /** CTC-2112 — the keyless (device-flow OAuth) session. Mutually exclusive with `key`. */
  auth?: OauthAuth;
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
  /** Who this machine is connected AS. Present when the key is a personal key; a config written by
   *  an older bundle, or with an account (host) key, has none. */
  user?: MeUser;
  joinedAt: string;
  lastSkillBundleVersion: string;
  /** Where a copy this package made lives. Kept for back-compat: 0.2 no longer copies skills on
   *  login (your agent's own install command does), and the update notice only refreshes what is
   *  already there. Still read, still written, so an older config keeps working. */
  skillsDir?: string;
  /** Absolute path of this CLI's launcher, so a skill script can spawn this exact CLI. Logins since
   *  CTC-3479 record bin/catalyst.js; older ones recorded bin/catalyst-skills.js, which still exists. */
  cliPath?: string;
  /** The replica file (default ~/.config/catalyst-cloud/replica.db). */
  replicaDb?: string;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: (line: string) => void;
  /** The process's own stdout stream, for output that must flush line by line and notice a closed
   *  pipe (`events tail`). Absent in tests, which read `stdout` lines instead. */
  stdoutStream?: NdjsonSink;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  now: () => Date;
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    home: process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/",
    stdout: (line) => console.log(line),
    stdoutStream: process.stdout,
    stderr: (line) => console.error(line),
    fetch: fetch,
    now: () => new Date(),
  };
}

export function configDirFor(home: string): string {
  return join(home, ".config", "catalyst-cloud");
}
export function configPathFor(home: string): string {
  return join(configDirFor(home), "customer.json");
}
export function contractPathFor(home: string): string {
  return join(configDirFor(home), "contract.json");
}
/** CTC-2160 — the cached answer to "what is the newest published release" (src/published.ts). */
export function publishedCachePathFor(home: string): string {
  return join(configDirFor(home), "published.json");
}
export function watchCursorPathFor(home: string): string {
  return join(configDirFor(home), "watch-cursor.json");
}
/** CTC-2112 — where the cached CLI-auth discovery document lives (the `/api/v1/auth/cli` answer). */
export function discoveryCachePathFor(home: string): string {
  return join(configDirFor(home), "auth-discovery.json");
}
export function defaultReplicaDbFor(home: string): string {
  return join(configDirFor(home), "replica.db");
}
export function defaultSkillsDirFor(home: string): string {
  return join(home, ".claude", "skills");
}

/** The CLI launcher this very package ships, recorded by login so skill scripts can spawn it. It is
 *  the `catalyst` launcher, so a skill script's call does not print the deprecated-name line. */
export function cliPath(): string {
  return fileURLToPath(new URL("../bin/catalyst.js", import.meta.url));
}

/** This package's root directory (the one holding package.json, bin/ and dist/). */
export function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function packageNameAt(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    return typeof raw.name === "string" ? raw.name : null;
  } catch {
    return null;
  }
}

/**
 * CTC-3479 — the package whose `npm install -g <name>@latest` updates this install. Both packages
 * ship the `catalyst` and `catalyst-skills` bins, so npm refuses to install one over the other
 * (EEXIST). An upgrade hint must therefore name the package this machine already has.
 *
 * The forwarder carries this package as its dependency, in one of two layouts:
 * - nested, as `npm install -g` lays it out: `<forwarder>/node_modules/@catalyst-cloud/cli`;
 * - flat, as npx and a project install lay it out: `node_modules/@catalyst-cloud/catalyst-skills`
 *   sits beside `node_modules/@catalyst-cloud/cli`.
 * Anything else is a direct install of this package (or a checkout of this repository).
 */
export function updatePackageName(root: string = packageRoot()): string {
  const scopeDir = dirname(root);
  const nested = dirname(dirname(scopeDir));
  if (packageNameAt(nested) === LEGACY_PACKAGE_NAME) return LEGACY_PACKAGE_NAME;
  if (packageNameAt(join(scopeDir, "catalyst-skills")) === LEGACY_PACKAGE_NAME) return LEGACY_PACKAGE_NAME;
  return PACKAGE_NAME;
}

/** The Catalyst installer, which owns skill placement and switches a machine between packages. */
export const INSTALL_COMMAND = "curl -fsSL https://staging.catalystcloud.dev/install.sh | sh";

/** The one upgrade command every hint prints: update the installed package, then log in again so
 *  customer.json records the new launcher path. */
export function upgradeCommand(root?: string): string {
  return `npm install -g ${updatePackageName(root)}@latest && catalyst login`;
}

/**
 * CTC-3479 — logins before this release recorded bin/catalyst-skills.js as cliPath. That launcher is
 * now the deprecated name and prints a notice, so every skill script call through it would carry
 * the notice. When the recorded launcher has a `catalyst.js` beside it (any 0.8.0-or-later install of
 * either package), point cliPath at that instead. Returns the new path, or null when nothing changes.
 */
export function modernCliPath(recorded: string | undefined): string | null {
  if (typeof recorded !== "string" || !recorded.endsWith("catalyst-skills.js")) return null;
  const sibling = join(dirname(recorded), "catalyst.js");
  return existsSync(sibling) ? sibling : null;
}

export function normalizeBaseUrl(url: string): string {
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

/** The origin WITH the versioned prefix — what the SDK and every API read/write take. */
export function apiBase(cfg: Pick<CustomerConfig, "baseUrl">): string {
  return `${normalizeBaseUrl(cfg.baseUrl)}/api/v1`;
}

/** True when the Catalyst installer owns skill placement on this machine: it marks the current
 *  install, exports CATALYST_SKILLS_DIR, or wrote the machine paths file (every v1 record carries a skills role).
 *  The CLI then never refreshes skill folders itself; the installer's own refresh does. */
export function installerOwnsSkills(home: string, env: NodeJS.ProcessEnv = {}): boolean {
  if (env.CATALYST_INSTALL_SKILLS_OWNER === "1") return true;
  if (env.CATALYST_SKILLS_DIR !== undefined && env.CATALYST_SKILLS_DIR !== "") return true;
  try {
    const file = machinePathsFile({ env: { ...env, HOME: home } });
    return Boolean(file && machineFilePresent(file));
  } catch {
    return false;
  }
}

function machineFilePresent(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** The machine paths record, or null on a machine that has not run paths setup. */
function declaredMachinePaths(home: string, env: NodeJS.ProcessEnv): ReturnType<typeof parseMachinePaths> | null {
  const file = machinePathsFile({ env: { ...env, HOME: home } });
  if (!file || (env.CATALYST_PATHS_FILE === undefined && !machineFilePresent(file))) return null;
  return parseMachinePaths(JSON.parse(readFileSync(file, "utf8")));
}

/** True only when this machine opted in to the local replica: CATALYST_REPLICA_DB is set, or the
 *  machine paths file declares replicaDb. Every other machine reads the cloud (CTC-4508). */
export function replicaOptedIn(home: string, env: NodeJS.ProcessEnv = {}): boolean {
  if (env.CATALYST_REPLICA_DB !== undefined) return true;
  return declaredMachinePaths(home, env)?.paths.replicaDb !== undefined;
}

export function replicaDbPath(cfg: Pick<CustomerConfig, "replicaDb">, home: string, env: NodeJS.ProcessEnv = {}): string {
  if (env.CATALYST_REPLICA_DB !== undefined) return resolveCatalystPath("replicaDb", { env });
  const machine = declaredMachinePaths(home, env);
  if (machine) {
    if (machine.paths.replicaDb === undefined) throw new CliError("optional replica is not configured; set CATALYST_REPLICA_DB or declare replicaDb in the machine paths file", "replica-not-configured");
    return resolveCatalystPath("replicaDb", { env, machine });
  }
  // Compatibility for machines that have not run paths setup. Keep the existing DB in place.
  return resolveCatalystPath("replicaDb", { overrides: { replicaDb: cfg.replicaDb ?? defaultReplicaDbFor(home) } });
}

export function loadConfig(home: string): CustomerConfig | null {
  const path = configPathFor(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`config at ${path} is not valid JSON — re-run login to rewrite it`, "config-corrupt");
  }
  const cfg = parsed as Partial<CustomerConfig>;
  if (typeof cfg.account !== "string" || typeof cfg.baseUrl !== "string") {
    throw new CliError(`config at ${path} is missing required fields — re-run login to rewrite it`, "config-corrupt");
  }
  const hasKey = typeof cfg.key === "string" && cfg.key !== "";
  const hasOauth = isOauthAuth(cfg.auth);
  if (hasKey === hasOauth) {
    throw new CliError(
      `config at ${path} must hold exactly one of a personal key or an OAuth session — re-run login to rewrite it`,
      "config-corrupt",
    );
  }
  return cfg as CustomerConfig;
}

/** Load the config or refuse with the one line every verb prints when the machine is not connected. */
export function requireConfig(ctx: Ctx): CustomerConfig {
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    throw new CliError(
      `not connected yet — run: npx ${LEGACY_PACKAGE_NAME} login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN for a key)`,
      "not-configured",
    );
  }
  return cfg;
}

export function saveConfig(home: string, cfg: CustomerConfig): string {
  return writeConfig(home, cfg).path;
}

/** True when `v` is a well-formed OAuth session block. */
export function isOauthAuth(v: unknown): v is OauthAuth {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.kind === "oauth" &&
    typeof a.accessToken === "string" &&
    typeof a.refreshToken === "string" &&
    typeof a.expiresAt === "string" &&
    typeof a.sessionId === "string"
  );
}

/**
 * Write the config atomically (a rotated token must never be half-written under a crash) and return
 * the mode the file ACTUALLY carries afterwards. Write to a sibling `.tmp` at 0600, then rename over
 * the target — rename is atomic within a directory — and chmod once more (a pre-existing target keeps
 * its own mode through the rename on some platforms).
 */
export function writeConfig(home: string, cfg: CustomerConfig): { path: string; mode: number } {
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  // A UNIQUE sibling temp per write (pid + randomness): two concurrent CLI processes reaching the
  // OAuth refresh window must not share `customer.json.tmp`, or one renames/removes it out from under
  // the other and the second write fails with ENOENT or lands the wrong contents (Codex P2).
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: CONFIG_MODE });
    chmodSync(tmp, CONFIG_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup of the temp file
    }
    throw err;
  }
  chmodSync(path, CONFIG_MODE);
  return { path, mode: statSync(path).mode & 0o777 };
}

export function formatMode(mode: number): string {
  return "0" + mode.toString(8);
}

interface Manifest {
  version: string;
  tenantContractRange: string;
  /** The one declared supported Node range (`engines.node`), e.g. ">=22.15". CTC-2158: every runtime
   *  message reads this instead of writing the floor a second time. Missing is a named error — the
   *  range is not optional. */
  enginesNode: string;
  /** CTC-2158, Tier 2: the Node version `runtime install` downloads and pins. Must satisfy `enginesNode`. */
  pinnedNode: string;
}

let manifestCache: Manifest | null = null;

export function readManifest(): Manifest {
  if (manifestCache) return manifestCache;
  const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    engines?: { node?: string };
    catalystCloud?: { tenantContractRange?: string; pinnedNode?: string };
  };
  if (!raw.engines?.node) {
    throw new CliError("package.json is missing engines.node — the supported Node range is not optional", "manifest-corrupt");
  }
  if (!raw.catalystCloud?.pinnedNode) {
    throw new CliError("package.json is missing catalystCloud.pinnedNode — the pinned runtime version is not optional", "manifest-corrupt");
  }
  manifestCache = {
    version: raw.version,
    tenantContractRange: raw.catalystCloud?.tenantContractRange ?? "unpinned",
    enginesNode: raw.engines.node,
    pinnedNode: raw.catalystCloud.pinnedNode,
  };
  return manifestCache;
}

/** Test seam: forget the cached manifest. */
export function resetManifestCache(): void {
  manifestCache = null;
}
