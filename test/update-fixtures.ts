// update-fixtures.ts — shared builders for the CTC-6708 release-check tests: an approved component
// record, the host desired-release answer that carries it, a fake image engine that counts its calls,
// a runner installation, a signed-in config, an installed Cloud skills pack and an SDK project.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathFor, readManifest, type CustomerConfig } from "../src/config";
import type { DesiredReleaseRead, ReleaseComponent, RunnerUpdateEngine } from "../src/runner-update";
import type { SdkExec } from "../src/update-sdk";

const hex = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);
export const REPO = {
  runner: "ghcr.io/coalesce-labs/catalyst-runner",
  supervisor: "ghcr.io/coalesce-labs/catalyst-supervisor",
  watchdog: "ghcr.io/coalesce-labs/catalyst-deadline-watchdog",
} as const;
export const ref = (component: ReleaseComponent, c: string) => `${REPO[component]}@sha256:${hex(c)}`;

/** This CLI's own version, and one patch past it on the same train: the "approved" fixture target. */
export const CLI_VERSION = readManifest().version;
const [major, minor, patch] = CLI_VERSION.split(".").map(Number) as [number, number, number];
export const TRAIN = `${major}.${minor}`;
export const NEXT = `${major}.${minor}.${patch + 2}`;
export const OLD = `${major}.${minor}.${Math.max(0, patch - 3)}`;

/** The approved component record (`schemaVersion: 1`), as the member route and the host envelope carry it. */
export function approved(over: { generation?: number; mutate?: (r: Record<string, unknown>) => void } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    approvalId: `example-${over.generation ?? 89}`,
    generation: over.generation ?? 89,
    approvedAtMs: 1_792_755_646_000,
    releaseLine: TRAIN,
    members: {
      cli: NEXT,
      forwarder: NEXT,
      plugin: NEXT,
      sdk: NEXT,
      "sdk-replica-node": `${TRAIN}.1`,
      "sdk-replica-browser": NEXT,
      schema: `${TRAIN}.16`,
      installer: NEXT,
    },
    skills: {
      cloud: { version: NEXT, repository: "coalesce-labs/catalyst-cloud-skills", commit: sha("1") },
      dev: { version: NEXT, repository: "coalesce-labs/catalyst-dev-skills", commit: sha("2") },
    },
  };
  over.mutate?.(body);
  return body;
}

/** A host desired-release body for images `digits`, optionally carrying `components`. */
export function hostRelease(over: { generation?: number; digits?: [string, string, string]; components?: unknown } = {}): Record<string, unknown> {
  const [r, s, w] = over.digits ?? ["1", "2", "3"];
  const image = (component: ReleaseComponent, c: string, src: string) => ({
    reference: ref(component, c),
    digest: `sha256:${hex(c)}`,
    tag: `${REPO[component]}:${sha(src)}${component === "runner" ? "-multiarch" : ""}`,
    sourceSha: sha(src),
  });
  return {
    version: 1,
    releaseId: `hr-${hex(r).slice(0, 16)}-${hex(s).slice(0, 16)}-${hex(w).slice(0, 16)}`,
    generation: over.generation ?? 89,
    approvedAtMs: 1_792_755_646_000,
    runner: image("runner", r, "a"),
    supervisor: image("supervisor", s, "b"),
    watchdog: image("watchdog", w, "b"),
    ...(over.components !== undefined ? { components: over.components } : {}),
  };
}

export const answered = (release: unknown, status = 200): DesiredReleaseRead => ({
  kind: "answered",
  status,
  body: status === 200 ? { ok: true, release } : release,
  hostId: "host_abc",
});

export interface CountingEngine extends RunnerUpdateEngine {
  calls: Record<string, number>;
}

/** An engine that answers `read` and records every call. Anything past the read is a fake success
 *  that leaves the containers on `running` images, so a test can see whether the update ran. */
export function countingEngine(read: DesiredReleaseRead, running: Record<"supervisor" | "watchdog", string> | null = null): CountingEngine {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  let live = running;
  return {
    calls,
    desiredRelease: async () => (count("desiredRelease"), read),
    attemptContainers: async () => (count("attemptContainers"), 0),
    prepare: async () => (count("prepare"), null),
    custody: async () => (count("custody"), null),
    services: async () => {
      count("services");
      return live
        ? { supervisor: { image: live.supervisor, running: true, startedAtMs: 1 }, watchdog: { image: live.watchdog, running: true, startedAtMs: 1 } }
        : null;
    },
    stopSupervisor: async () => (count("stopSupervisor"), true),
    composeUp: async () => {
      count("composeUp");
      if (read.kind === "answered" && read.status === 200) live = { supervisor: ref("supervisor", "2"), watchdog: ref("watchdog", "3") };
      return true;
    },
    supervisorReadySinceStart: async () => (count("supervisorReadySinceStart"), true),
    removeImages: async () => void count("removeImages"),
  };
}

/** A runner installation whose `.env` names the images built from `digits`. */
export function runnerInstall(digits: [string, string, string] = ["7", "8", "9"], generation: number | null = 88): string {
  const dir = mkdtempSync(join(tmpdir(), "update-runner-"));
  const [r, s, w] = digits;
  writeFileSync(
    join(dir, ".env"),
    `CATALYST_SLOTS=1\nCATALYST_RUNNER_IMAGE=${ref("runner", r)}\nCATALYST_SUPERVISOR_IMAGE=${ref("supervisor", s)}\nCATALYST_WATCHDOG_IMAGE=${ref("watchdog", w)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  if (generation !== null)
    writeFileSync(
      join(dir, "release-state.json"),
      JSON.stringify({ version: 1, generation, releaseId: "hr-old", appliedAtMs: 1, previous: null, last: null }),
    );
  return dir;
}

/** A signed-in config pointing at `baseUrl`, with a personal key. */
export function signIn(home: string, baseUrl = "https://cloud.example.test", over: Partial<CustomerConfig> = {}): CustomerConfig {
  const cfg: CustomerConfig = {
    baseUrl,
    key: "ctc_user_fixturekey",
    account: "acct_fixture",
    slug: "fixture",
    name: "Fixture",
    permissions: null,
    principal: "session",
    joinedAt: "2026-09-01T00:00:00Z",
    lastSkillBundleVersion: CLI_VERSION,
    ...over,
  };
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(configPathFor(home), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

/** A fetch that answers the approved-release route with `status` and `body`, and counts calls. */
export function memberFetch(status: number, body: unknown): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return Object.assign(impl, { calls });
}

/** Install the Cloud pack's skills, stamped `version`, into a fresh skills directory. */
export function cloudPack(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "update-skills-"));
  for (const name of ["catalyst-onboard", "unstick"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills@${version} — fixture -->\n\n# ${name}\n`,
    );
  }
  return dir;
}

/** An npm project that pins `sdk` (and, when given, the Node replica module) exactly. */
export function sdkProject(sdk: string, opts: { replicaNode?: string; dev?: boolean; lockfiles?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "update-project-"));
  const group = opts.dev ? "devDependencies" : "dependencies";
  const deps: Record<string, string> = { "@catalyst-cloud/sdk": sdk };
  if (opts.replicaNode) deps["@catalyst-cloud/sdk-replica-node"] = opts.replicaNode;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", [group]: deps }, null, 2));
  const lockPackages: Record<string, unknown> = { "": { name: "app" } };
  for (const [name, version] of Object.entries(deps)) lockPackages[`node_modules/${name}`] = { version };
  for (const file of opts.lockfiles ?? ["package-lock.json"])
    writeFileSync(join(dir, file), file === "package-lock.json" ? JSON.stringify({ lockfileVersion: 3, packages: lockPackages }) : "lock\n");
  return dir;
}


/** Stands in for npm: records each argv, and writes the versions it was asked for into package.json,
 *  the lockfile and node_modules the way a real install would. */
export function fakeNpm(calls: string[][], opts: { fail?: boolean } = {}): SdkExec {
  return (argv, cwd) => {
    calls.push([...argv]);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    const lock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
    for (const spec of argv.filter((a) => a.startsWith("@catalyst-cloud/"))) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const group = argv.includes("--save-dev") ? "devDependencies" : "dependencies";
      manifest[group] = { ...manifest[group], [name]: version };
      lock.packages[`node_modules/${name}`] = { version };
      mkdirSync(join(cwd, "node_modules", ...name.split("/")), { recursive: true });
      writeFileSync(join(cwd, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version }));
    }
    writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
    return opts.fail ? { status: 1, stderr: "npm ERR! network" } : { status: 0, stderr: "" };
  };
}
