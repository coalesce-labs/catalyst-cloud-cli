// update-inventory.ts — what this install has, read without changing anything (CTC-6708). Each
// component is installed (with the version or image it runs), absent, or unknown with a reason;
// unknown is never reported as current. Reading it starts no process, contacts no service, and a
// machine with no runner installation never touches Docker.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exactVersion } from "./approved-release.js";
import { loadConfig, packageRoot, readManifest, updatePackageName, type Ctx, type CustomerConfig } from "./config.js";
import { parseEnvText } from "./onboard-runner.js";
import { replicaStatus, writerIsRunning } from "./replica.js";
import {
  readReleaseState,
  RELEASE_COMPONENTS,
  RELEASE_ENV_KEYS,
  releaseReference,
  type ReleaseComponent,
} from "./runner-update.js";
import { installedBundleVersion, resolveSkillsDir, skillsSourceDir } from "./skills.js";
import { cloudPluginInventory, type PluginInventory } from "./update-plugin.js";

export interface CliInventory {
  version: string;
  packageName: string;
  root: string;
}

export type ImageInventory =
  | { installed: false; dir: string }
  | {
      installed: true;
      dir: string;
      /** The digest-pinned reference `.env` names for each image, or null when it names none this CLI accepts. */
      references: Record<ReleaseComponent, string | null>;
      /** The approved generation this machine last applied, from its own release record. */
      generation: number | null;
    };

export type PackInventory =
  | { state: "installed"; version: string; dir: string }
  | { state: "not_installed"; dir: string | null }
  | { state: "unknown"; reason: string; dir: string | null };

export type ReplicaInventory =
  | { state: "not_installed" }
  | { state: "stopped"; dbPath: string }
  /** `version` is what the running writer recorded; null for a writer started by a CLI that did not record it. */
  | { state: "running"; dbPath: string; version: string | null; pid: number | null }
  | { state: "unknown"; reason: string };

export interface Inventory {
  cli: CliInventory;
  images: ImageInventory;
  skills: { cloud: PackInventory; dev: PackInventory };
  /** The Cloud pack installed as the Claude plugin (CTC-6791). */
  plugin: PluginInventory;
  replica: ReplicaInventory;
}

export function imageInventory(dir: string): ImageInventory {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath) || !existsSync(join(dir, "compose.yaml"))) return { installed: false, dir };
  let env: Record<string, string> = {};
  try {
    env = parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    env = {};
  }
  const references = Object.fromEntries(
    RELEASE_COMPONENTS.map((c) => [c, releaseReference(c, env[RELEASE_ENV_KEYS[c]])]),
  ) as Record<ReleaseComponent, string | null>;
  return { installed: true, dir, references, generation: readReleaseState(dir).generation };
}

function bundledSkillNames(): string[] {
  try {
    return readdirSync(skillsSourceDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(skillsSourceDir(), e.name, "SKILL.md")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The Cloud pack as installed in the agent skills directory, read from each skill's provenance line. */
export function cloudPackInventory(ctx: Ctx, cfg: CustomerConfig | null): PackInventory {
  const dir = resolveSkillsDir({}, ctx, cfg);
  const found = installedBundleVersion(dir, bundledSkillNames());
  if (found.version !== null) {
    const version = exactVersion(found.version);
    return version ? { state: "installed", version, dir } : { state: "unknown", reason: "version_unreadable", dir };
  }
  if (found.unstamped.length > 0) return { state: "unknown", reason: "version_unstamped", dir };
  return { state: "not_installed", dir };
}

/** The Dev pack ships from its own repository with no provenance stamp this CLI reads, so its
 *  presence is known (its `research-codebase` skill, as the onboarding guide checks) but its version
 *  is not. Unknown is never reported as current. */
export function devPackInventory(ctx: Ctx, cfg: CustomerConfig | null): PackInventory {
  const dir = resolveSkillsDir({}, ctx, cfg);
  return existsSync(join(dir, "research-codebase", "SKILL.md"))
    ? { state: "unknown", reason: "version_unrecorded", dir }
    : { state: "not_installed", dir };
}

export function replicaInventory(ctx: Ctx, cfg: CustomerConfig | null): ReplicaInventory {
  if (!cfg) return { state: "not_installed" };
  let status;
  try {
    status = replicaStatus(ctx, cfg);
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (status.dbPath === null || status.verdict === "not-configured" || status.verdict === "absent") return { state: "not_installed" };
  if (!writerIsRunning(status)) return { state: "stopped", dbPath: status.dbPath };
  const version = exactVersion(status.writer?.version);
  return { state: "running", dbPath: status.dbPath, version, pid: status.writer?.pid ?? status.lockPid ?? status.pidfilePid };
}

/** Everything this install has. `imagesDir` is the runner installation to read. */
export function readInventory(ctx: Ctx, imagesDir: string): Inventory {
  let cfg: CustomerConfig | null = null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    cfg = null;
  }
  const root = packageRoot();
  return {
    cli: { version: readManifest().version, packageName: updatePackageName(root), root },
    images: imageInventory(imagesDir),
    skills: {
      cloud: cloudPackInventory(ctx, cfg),
      dev: devPackInventory(ctx, cfg),
    },
    plugin: cloudPluginInventory(ctx.home, ctx.env),
    replica: replicaInventory(ctx, cfg),
  };
}
