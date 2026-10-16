import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig, normalizeBaseUrl, packageRoot, type Ctx } from "./config.js";
import { nativeEgressReady, NATIVE_EGRESS_DIR } from "./onboard-runner-egress.js";
import { runnerAdmission, issueRunnerOrgKey, verifyRunnerRoutes } from "./onboard-runner-cloud.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { liveTeamKey, onboardTeamAdmission } from "./onboard-capacity.js";
import { runnerVmCapabilities, type RunnerVmCapability } from "./onboard-runner-probes.js";
import { darwinThoughtsInstallAdvice, darwinThoughtsInstallException, darwinThoughtsInstallRefusal, installDarwinThoughtsCustody, type DarwinThoughtsInstallResult } from "./onboard-runner-custody.js";
import { emitCustodyFailure, type CustodyFailureCase, type CustodyFailureDetails } from "./onboard-runner-telemetry.js";
import { canonicalDarwinThoughtsJson, parseDarwinThoughtsAuthority } from "../vendor/self-host/darwin-thoughts-custody/verifier.mjs";
import {
  readExistingOnboardJson,
  readOnboardTeamInventory,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import {
  onboardStateRoot,
  type OnboardAdapter,
  type OnboardJournal,
  type OnboardStep,
  type OnboardStepResult,
} from "./onboard.js";

// "Run Catalyst's work on this machine": the self-hosted host from catalyst-cloud's deploy/self-host
// (a supervisor and a deadline watchdog under Compose), enrolled with the person's own owner or
// admin login. Never the operator token. Setup prepares missing pinned images anonymously with an
// empty disposable Docker config; Darwin custody receives only already-cached pinned images.

/** The Compose project name the vendored file declares. */
export const RUNNER_PROJECT = "catalyst-host";
export const RUNNER_SESSION_NETWORK = "catalyst-session-v1";
/** Supervisor from ee729b12 (Host images 38138827750); runner from
 * 91a82214 (Runner image 38133282600). The watchdog retains its reviewed pin.
 * Explicit environment values override these pins; a saved runner image is preserved. */
export const RUNNER_HOST_IMAGES = {
  supervisor:
    "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:3331ebc4204ae3975a4efb2c870c941f9c0f5ab435735e91dc9977941c91e9a8",
  watchdog:
    "ghcr.io/coalesce-labs/catalyst-deadline-watchdog@sha256:a5999dbf229ac432b83c2ed3fe43fa251366baceb73af2f57590890a6a758f0d",
  runner:
    "ghcr.io/coalesce-labs/catalyst-runner@sha256:9db2bf2c5580e2a1459fd076fa32c9af34456cc639ec3ab92b57b6ad98da67fb",
} as const;
const IMAGE_REF = /^[a-z0-9][a-z0-9._:/-]{0,255}@sha256:[0-9a-f]{64}$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const JOIN_TOKEN = /^[A-Za-z0-9._~+/=-]{16,1024}$/;
const ENROLLMENTS = "/api/v1/hosts/enrollments";
const JOIN_TOKENS = "/api/v1/hosts/join-tokens";
const CAPACITY = "/api/v1/me/runner-capacity";
const RUNNER_UID = "10001:10001";
const DIRS = ["slots", "thoughts", "locks"] as const;
const CUSTODY_KEYS = [
  "CATALYST_THOUGHTS_CUSTODY_AUTHORITY",
  "CATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR",
  "CATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR",
] as const;

/** A persisted authority selects bindings, never substitutes for a fresh native proof. */
function persistedCustody(dir: string, values: Record<string, string> | null): "absent" | "invalid" | "installed" {
  const present = CUSTODY_KEYS.map(key => values?.[key] ?? "");
  if (present.every(value => !value)) return "absent";
  if (present.some(value => !value)) return "invalid";
  try {
    const authority = parseDarwinThoughtsAuthority(JSON.parse(present[0]!));
    return canonicalDarwinThoughtsJson(authority) === present[0] &&
      authority.thoughtsRoot === join(dir, "thoughts") && authority.locksRoot === join(dir, "locks") &&
      authority.requestsRoot === present[1] && authority.responsesRoot === present[2] &&
      authority.requestsRoot === join(dir, "..", "darwin-thoughts-requests") &&
      authority.responsesRoot === join(dir, "..", "darwin-thoughts-responses")
      ? "installed" : "invalid";
  } catch { return "invalid"; }
}
const DISK_POLICY_KEYS = [
  "CATALYST_SLOTS",
  "CATALYST_SLOT_DISK_MODE", "CATALYST_SLOT_DISK_BUDGET_GIB", "CATALYST_DISK_BUDGET_GIB",
  "CATALYST_WORKSPACE_STORAGE", "CATALYST_WORKSPACE_RETENTION_HOURS",
  "CATALYST_HOST_FREE_FLOOR_GIB", "CATALYST_HOST_DISK_SAMPLE_DIR", "CATALYST_HOST_DISK_SAMPLE_FILE",
] as const;


export interface RunnerEngineInfo {
  arch: "amd64" | "arm64";
  /** On macOS the Linux engine runs in a VM. Bind mounts must pass the supervisor uid probe. */
  vm: boolean;
  /** A reachable engine whose bind paths/socket ownership cannot be verified locally. */
  unsupported?: true;
  unsupportedReason?: "runner_engine_nonlocal";
}
export interface RunnerEnrollment {
  hostId: string;
  tenant: string;
  team: string;
  enrollmentKind: "self_hosted" | "dedicated";
}
export type RunnerOrgKeyStatus = "valid" | "different" | "missing" | "invalid" | "unavailable";
type VolumeFile = "CATALYST_ORG_KEY_FILE" | "CATALYST_HOST_CREDENTIAL_FILE";
/** One container of the existing Compose project, whatever state it is in. */
export interface RunnerProjectContainer {
  service: string;
  state: string;
}
/** What `compose up` reports back: success, or Compose's own error text. */
export interface RunnerComposeUp {
  ok: boolean;
  error?: string;
}
/** Every Docker call the step makes. Each answers false or null instead of throwing. */
export interface RunnerUnenrolled { unenrolled: true; tokenSpent: boolean }
function isUnenrolled(value: RunnerEnrollment | RunnerUnenrolled | null): value is RunnerUnenrolled {
  return value !== null && "unenrolled" in value;
}

export interface RunnerEngine {
  /** Null when there is no docker command, no reachable Linux engine, or no Compose plugin. */
  info(signal?: AbortSignal): Promise<RunnerEngineInfo | null>;
  /** Existing Compose ownership and public identity, before setup chooses new files or a name. */
  installation?(home: string, supervisorImage: string, signal?: AbortSignal): Promise<
    { dir: string; hostName: string; baseUrl: string; supervisorImage?: string } | "missing" | "unverified"
  >;
  /** Every container of this Compose project in any state, read before Compose is started.
   * Null when the listing itself could not be read; never a guess. */
  projectContainers?(signal?: AbortSignal): Promise<RunnerProjectContainer[] | null>;
  /** Resumes the project's paused containers in place: adoption, never removal. */
  composeUnpause?(dir: string, signal?: AbortSignal): Promise<boolean>;
  /** The architecture of a local image received at this exact digest, or null when unverified. */
  imageArch(ref: string, signal?: AbortSignal): Promise<string | null>;
  pull(ref: string, signal?: AbortSignal): Promise<boolean>;
  network(
    name: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "missing" | "misshaped" | "unavailable">;
  createNetwork(name: string, signal?: AbortSignal): Promise<boolean>;
  socketGid(): Promise<number | null>;
  nativeEgressStatus?(nowMs:number,signal?:AbortSignal):Promise<boolean>;
  /** Verifies bind paths and connectivity before enrollment or starting the supervisor. */
  vmCapabilities(dir: string, image: string, baseUrl: string, signal?: AbortSignal): Promise<RunnerVmCapability>;
  /** Installs the native authority and receives a fresh proof before VM credential work. */
  nativeThoughtsCustody?(
    input: { dir: string; supervisorImage: string; runnerImage: string },
    signal?: AbortSignal,
  ): Promise<DarwinThoughtsInstallResult>;
  /** Native Linux only: hands the host directories to the runner uid through the supervisor image. */
  claimDirs(dir: string, paths: string[], signal?: AbortSignal): Promise<boolean>;
  hasVolumeFile(
    dir: string,
    variable: VolumeFile,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Reads only public enrollment metadata, never the host secret. */
  enrollment(dir: string, signal?: AbortSignal): Promise<RunnerEnrollment | RunnerUnenrolled | null>;
  /** Validates the stored or supplied host key against this tenant. Supplied keys reach stdin only. */
  orgKeyStatus(dir: string, account: string, baseUrl: string, candidate?: string, signal?: AbortSignal): Promise<RunnerOrgKeyStatus>;
  writeVolumeFile(
    dir: string,
    variable: "CATALYST_ORG_KEY_FILE",
    value: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  composeUp(dir: string, signal?: AbortSignal): Promise<RunnerComposeUp>;
  composeRunning(dir: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RunnerExecOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin: the only way a secret reaches a docker process. */
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type RunnerExec = (
  args: string[],
  options: RunnerExecOptions,
) => Promise<{ code: number; stdout: string; stderr?: string }>;

const spawnDocker: RunnerExec = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: options.env,
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs ?? 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk:string)=>{if(stderr.length<1_000_000)stderr+=chunk;});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });

/** Compose's own error lines, reduced to short printable text a person can act on. */
function composeErrorText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
    .filter((line) => line !== "" && !line.startsWith("time="));
  const errors = lines.filter((line) =>
    /error|failed|cannot|conflict|paused|in use|refused|denied|invalid/i.test(line),
  );
  const text = (errors.length > 0 ? errors : lines).slice(0, 3).join(" | ").slice(0, 480);
  return text !== "" ? text : undefined;
}

/** The real engine, through the docker CLI. Compose reads `.env` only: the caller's CATALYST_ and
 * DOCKER_SOCKET_ variables are removed, because Compose prefers an exported value over the file. */
export function dockerRunnerEngine(
  deps: { exec?: RunnerExec; env?: NodeJS.ProcessEnv; socketPath?: string; platform?: NodeJS.Platform } = {},
): RunnerEngine {
  const exec = deps.exec ?? spawnDocker;
  const env = Object.fromEntries(
    Object.entries(deps.env ?? process.env).filter(
      ([key]) => !key.startsWith("CATALYST_") && !key.startsWith("DOCKER_SOCKET_"),
    ),
  );
  const docker = async (
    args: string[],
    options: Omit<RunnerExecOptions, "env"> & { env?: NodeJS.ProcessEnv } = {},
  ): Promise<{ code: number; stdout: string; stderr?: string }> => {
    try {
      return await exec(args, { env, ...options });
    } catch {
      return { code: 1, stdout: "" };
    }
  };
  const compose = (dir: string): string[] | null => {
    const custody = persistedCustody(dir, readEnvFile(join(dir, ".env")));
    if (custody === "invalid") return null;
    return [
      "compose",
      "--project-name",
      RUNNER_PROJECT,
      "--file",
      join(dir, "compose.yaml"),
      ...(custody === "installed" ? ["--file", join(dir, "compose.darwin-thoughts.yaml")] : []),
      "--env-file",
      join(dir, ".env"),
    ];
  };
  const supervisorShell = (dir: string, script: string): string[] | null => {
    const files = compose(dir);
    if (!files) return null;
    return [
      ...files,
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--entrypoint",
      "sh",
      "supervisor",
      "-c",
      script,
    ];
  };
  let nativeLocal = false;
  const endpoint = async (signal?: AbortSignal): Promise<string | null> => {
    // Reject conflicting selectors rather than infer precedence across Docker/Compose versions.
    if (env.DOCKER_CONTEXT && env.DOCKER_HOST) return null;
    if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) return env.DOCKER_HOST;
    const read = await docker(["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
      "--format", '{{(index .Endpoints "docker").Host}}'], { signal });
    return read.code === 0 ? read.stdout.trim() || null : null;
  };
  return {
    async info(signal) {
      nativeLocal = false;
      const read = await docker(["info", "--format", "{{json .}}"], { signal });
      if (read.code !== 0) return null;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(read.stdout) as Record<string, unknown>;
      } catch {
        return null;
      }
      const arches: Record<string, RunnerEngineInfo["arch"]> = {
        x86_64: "amd64",
        amd64: "amd64",
        aarch64: "arm64",
        arm64: "arm64",
      };
      const arch = arches[String(body.Architecture)];
      if (body.OSType !== "linux" || !arch) return null;
      if ((await docker(["compose", "version"], { signal })).code !== 0) return null;
      const host = await endpoint(signal);
      const platform = deps.platform ?? process.platform;
      const vm = platform === "darwin" || /docker desktop|orbstack/i.test(String(body.OperatingSystem));
      const localSocket = host?.startsWith("unix:///") === true;
      nativeLocal = platform === "linux" && !vm && host === "unix:///var/run/docker.sock";
      const supportedVm = platform === "darwin" && localSocket;
      return { arch, vm, ...(!nativeLocal && !supportedVm ? {
        unsupported: true as const, ...(!localSocket ? { unsupportedReason: "runner_engine_nonlocal" as const } : {}),
      } : {}) };
    },
    async installation(home, supervisorImage, signal) {
      const listed = await docker(["ps", "--all", "--filter", `label=com.docker.compose.project=${RUNNER_PROJECT}`,
        "--filter", "label=com.docker.compose.service=supervisor", "--format", "{{.ID}}"], { signal });
      if (listed.code !== 0) return "unverified";
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) return "missing";
      if (ids.length !== 1 || !/^[0-9a-f]{12,64}$/.test(ids[0]!)) return "unverified";
      const read = await docker(["inspect", ids[0]!], { signal });
      if (read.code !== 0) return "unverified";
      try {
        const rows = JSON.parse(read.stdout);
        if (!Array.isArray(rows) || rows.length !== 1) return "unverified";
        const config = rows[0]?.Config;
        const labels = config?.Labels;
        const dir = labels?.["com.docker.compose.project.working_dir"];
        if (labels?.["com.docker.compose.project"] !== RUNNER_PROJECT ||
          labels?.["com.docker.compose.service"] !== "supervisor" || typeof dir !== "string" || !isAbsolute(dir)) return "unverified";
        const inHome = relative(realpathSync(home), realpathSync(dir));
        if (inHome === ".." || inHome.startsWith("../") || isAbsolute(inHome) || !lstatSync(dir).isDirectory()) return "unverified";
        const saved = readEnvFile(join(dir, ".env"));
        const custody = persistedCustody(dir, saved);
        if (custody === "invalid") return "unverified";
        const files = [join(dir, "compose.yaml"), ...(custody === "installed" ? [join(dir, "compose.darwin-thoughts.yaml")] : [])];
        if (labels?.["com.docker.compose.project.config_files"] !== files.join(",")) return "unverified";
        for (const path of [join(dir, "compose.yaml"), join(dir, ".env")]) {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return "unverified";
        }
        if (custody === "installed") {
          for (const path of [join(dir, ".env"), join(dir, "compose.darwin-thoughts.yaml")]) {
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
              (stat.mode & 0o7777) !== 0o600) return "unverified";
          }
          for (const key of CUSTODY_KEYS.slice(1)) {
            const stat = lstatSync(saved![key]!);
            if (!stat.isDirectory() || stat.uid !== process.getuid?.() ||
              (stat.mode & 0o7777) !== 0o700) return "unverified";
          }
        }
        if (!Array.isArray(config.Env) || !config.Env.every((entry: unknown) => typeof entry === "string")) return "unverified";
        const names = config.Env.filter((entry: string) => entry.startsWith("CATALYST_HOST_NAME="));
        const origins = config.Env.filter((entry: string) => entry.startsWith("CATALYST_MIRROR_URL="));
        if (names.length !== 1 || origins.length !== 1) return "unverified";
        const hostName = names[0].slice("CATALYST_HOST_NAME=".length);
        const baseUrl = origins[0].slice("CATALYST_MIRROR_URL=".length);
        if (!HOST_NAME.test(hostName)) return "unverified";
        // An interrupted update can leave saved intent ahead of the actual runtime.
        // A later requested pin still requires the same publisher and installation identity.
        if (config.Image !== supervisorImage) {
          if (!saved || !IMAGE_REF.test(saved.CATALYST_SUPERVISOR_IMAGE ?? "") ||
            typeof config.Image !== "string" || !IMAGE_REF.test(config.Image) ||
            config.Image.split("@sha256:")[0] !== supervisorImage.split("@sha256:")[0] ||
            saved.CATALYST_SUPERVISOR_IMAGE.split("@sha256:")[0] !== supervisorImage.split("@sha256:")[0] ||
            saved.CATALYST_HOST_NAME !== hostName ||
            normalizeBaseUrl(saved.CATALYST_MIRROR_URL ?? "") !== normalizeBaseUrl(baseUrl)) return "unverified";
          if (config.Image !== saved.CATALYST_SUPERVISOR_IMAGE && saved.CATALYST_SUPERVISOR_IMAGE !== supervisorImage) {
            // Prove the configured old digest names this exact cached runtime, without a pull.
            const imageRead = await docker(["image", "inspect", config.Image], { signal });
            if (imageRead.code !== 0 || signal?.aborted) return "unverified";
            const cached = JSON.parse(imageRead.stdout);
            const runtimeImage = rows[0]?.Image;
            if (!Array.isArray(cached) || cached.length !== 1 ||
              typeof runtimeImage !== "string" || !/^sha256:[a-f0-9]{64}$/.test(runtimeImage) ||
              cached[0]?.Id !== runtimeImage || !Array.isArray(cached[0]?.RepoDigests) ||
              !cached[0].RepoDigests.includes(config.Image)) return "unverified";
          }
        }
        return { dir, hostName, baseUrl: normalizeBaseUrl(baseUrl), supervisorImage: config.Image };
      } catch { return "unverified"; }
    },
    async projectContainers(signal) {
      const read = await docker(["ps", "--all",
        "--filter", `label=com.docker.compose.project=${RUNNER_PROJECT}`,
        "--format", '{{.Label "com.docker.compose.service"}}\t{{.State}}'], { signal });
      if (read.code !== 0) return null;
      const rows: RunnerProjectContainer[] = [];
      for (const line of read.stdout.split("\n")) {
        const [service, state] = line.trim().split("\t");
        if (service && state &&
          /^[a-z][a-z0-9_-]{0,63}$/.test(service) && /^[a-z]+$/.test(state))
          rows.push({ service, state });
      }
      return rows;
    },
    async composeUnpause(dir, signal) {
      const files = compose(dir);
      if (!files) return false;
      return (await docker([...files, "unpause"], { cwd: dir, signal, timeoutMs: 120_000 })).code === 0;
    },
    async imageArch(ref, signal) {
      if (!IMAGE_REF.test(ref)) return null;
      const read = await docker(["image", "inspect", ref], { signal });
      if (read.code !== 0) return null;
      try {
        const rows = JSON.parse(read.stdout);
        if (!Array.isArray(rows) || rows.length !== 1) return null;
        const row = object(rows[0]);
        if (typeof row?.Id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(row.Id) ||
          row.Os !== "linux" || typeof row.Architecture !== "string" || !row.Architecture ||
          !Array.isArray(row.RepoDigests) || !row.RepoDigests.includes(ref)) return null;
        return row.Architecture;
      } catch { return null; }
    },
    async pull(ref, signal) {
      const host = await endpoint(signal);
      if (!host?.startsWith("unix:///")) return false;
      let config: string | undefined;
      try {
        config = mkdtempSync(join(tmpdir(), "catalyst-pull-"));
        writeFileSync(join(config, "config.json"), JSON.stringify({ auths: {} }), { mode: 0o600 });
        const anonymousEnv: NodeJS.ProcessEnv = { ...env, DOCKER_CONFIG: config };
        delete anonymousEnv.DOCKER_CONTEXT;
        delete anonymousEnv.DOCKER_AUTH_CONFIG;
        return (
          (await docker(["--host", host, "--config", config, "pull", "--quiet", ref],
          { env: anonymousEnv, signal, timeoutMs: 900_000 },
            )).code === 0);
      } catch { return false; }
      finally { if (config) rmSync(config, { recursive: true, force: true }); }
    },
    async network(name, signal) {
      const read = await docker(["network", "inspect", name], { signal });
      const absent=`Error response from daemon: network ${name} not found`;
      if (read.code !== 0 && (read.stdout.trim()==="" || read.stdout.trim()==="[]") && read.stderr?.trim()===absent) return "missing";
      if (read.code !== 0 || read.stderr?.trim()) return "unavailable";
      try {
        const [net] = JSON.parse(read.stdout) as Array<Record<string, unknown>>;
        const options = (net?.Options ?? {}) as Record<string, unknown>;
        const labels = (net?.Labels ?? {}) as Record<string, unknown>;
        return net?.Driver === "bridge" &&
          net.Internal !== true &&
          net.EnableIPv6 !== true &&
          options["com.docker.network.bridge.enable_icc"] === "false" &&
          options["com.docker.network.bridge.name"] === "catalyst-sess0" &&
          labels["dev.catalystcloud.session-network"] === "v1"
          ? "ready"
          : "misshaped";
      } catch {
        return "misshaped";
      }
    },
    async createNetwork(name, signal) {
      const args = [
        "network",
        "create",
        "--driver=bridge",
        "--opt",
        "com.docker.network.bridge.enable_icc=false",
        "--opt",
        "com.docker.network.bridge.name=catalyst-sess0",
        "--label",
        "dev.catalystcloud.session-network=v1",
        name,
      ];
      return (await docker(args, { signal })).code === 0;
    },
    async nativeEgressStatus(nowMs,signal) {
      return nativeLocal && (await nativeEgressReady(nowMs, signal));
    },
    async vmCapabilities(dir, image, baseUrl, signal) {
      return runnerVmCapabilities({ paths: DIRS.map(sub => join(dir, sub)), image, baseUrl,
        exec: docker, env, signal });
    },
    async nativeThoughtsCustody(input, signal) {
      return installDarwinThoughtsCustody({ ...input, deadlineMs: Date.now() + 30_000 }, signal);
    },
    async socketGid() {
      if (!nativeLocal) return null;
      try {
        return statSync(deps.socketPath ?? "/var/run/docker.sock").gid;
      } catch {
        return null;
      }
    },
    async claimDirs(dir, paths, signal) {
      const files = compose(dir);
      if (!files) return false;
      const args = [
        ...files,
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "--user",
        "0",
        // The service drops every capability; root needs CHOWN back to hand over a folder.
        "--cap-add",
        "CHOWN",
        "--entrypoint",
        "chown",
        "supervisor",
        RUNNER_UID,
        ...paths,
      ];
      return (
        (await docker(args, { cwd: dir, signal, timeoutMs: 120_000 })).code ===
        0
      );
    },
    async hasVolumeFile(dir, variable, signal) {
      const args = supervisorShell(dir, `test -s "$${variable}"`);
      if (!args) return false;
      return (
        (
          await docker(args, {
            cwd: dir,
            signal,
            timeoutMs: 120_000,
          })
        ).code === 0
      );
    },
    async enrollment(dir, signal) {
      const files = compose(dir);
      if (!files) return null;
      const script = `(() => { const {readFileSync}=require("node:fs");
        try { const state=JSON.parse(readFileSync(process.env.CATALYST_HOST_CREDENTIAL_FILE,"utf8"));
          if (state.version!==1 || typeof state.secret!=="string" || !/^[A-Za-z0-9_-]{32,256}$/.test(state.secret)) process.exit(1);
          if (state.enrollment===null) {
            if (!Array.isArray(state.spentJoinTokens) || !state.spentJoinTokens.every(v=>typeof v==="string" && /^[0-9a-f]{64}$/.test(v))) process.exit(1);
            const token=process.env.CATALYST_HOST_JOIN_TOKEN;
            const hash=token ? require("node:crypto").createHash("sha256").update(token).digest("hex") : null;
            process.stdout.write(JSON.stringify({unenrolled:true,tokenSpent:!hash || state.spentJoinTokens.includes(hash)})); return;
          }
          const e=state.enrollment;
          if (!e) process.exit(1);
          process.stdout.write(JSON.stringify({hostId:e.hostId,tenant:e.tenant,team:e.team,enrollmentKind:e.enrollmentKind}));
        } catch { process.exit(1); } })();`;
      const read = await docker([...files, "run", "--rm", "-T", "--no-deps", "--entrypoint", "bun", "supervisor", "-e", script],
        { cwd: dir, signal, timeoutMs: 120_000 });
      if (read.code !== 0) return null;
      try {
        const parsed = JSON.parse(read.stdout);
        const e = object(parsed);
        if (e?.unenrolled === true && typeof e.tokenSpent === "boolean") return { unenrolled: true, tokenSpent: e.tokenSpent };
        return e && [e.hostId, e.tenant, e.team].every((v) => typeof v === "string" && v.length > 0) &&
          (e.enrollmentKind === "self_hosted" || e.enrollmentKind === "dedicated")
          ? { hostId: e.hostId as string, tenant: e.tenant as string, team: e.team as string, enrollmentKind: e.enrollmentKind } : null;
      } catch { return null; }
    },
    async orgKeyStatus(dir, account, baseUrl, candidate, signal) {
      const files = compose(dir);
      if (!files) return "unavailable";
      // Only a status leaves the container. No stored key or provider response is printed.
      const script = `(async () => {
        const {readFileSync,lstatSync}=require("node:fs");
        let input=""; for await (const chunk of process.stdin) input+=chunk;
        let stored="", storedInvalid=false;
        try {
          const info=lstatSync(process.env.CATALYST_ORG_KEY_FILE);
          if (!info.isFile() || (info.mode & 0o077)!==0) storedInvalid=true;
          else stored=readFileSync(process.env.CATALYST_ORG_KEY_FILE,"utf8").trim();
        } catch (error) { if (error.code!=="ENOENT") storedInvalid=true; }
        const proposed=input.trim(), key=proposed||stored;
        const status=(s)=>process.stdout.write(s);
        if (!proposed && storedInvalid) return status("invalid");
        if (!key) return status("missing");
        if (!/^[\x21-\x7e]{16,1024}$/.test(key)) return status("invalid");
        try {
          const response=await fetch(process.argv[1]+"/api/v1/me", {redirect:"error",signal:AbortSignal.timeout(10000),
            headers:{authorization:"Bearer "+key,accept:"application/json"}});
          if (response.status===429 || response.status>=500) return status("unavailable");
          if (!response.ok) return status("invalid");
          const body=await response.json();
          if (body.account!==process.argv[2] || body.principal!=="service" || body.user!==undefined ||
            !Array.isArray(body.permissions) || body.permissions.length!==3 ||
            !["mirror:read","mirror:write","mirror:feed"].every(p=>body.permissions.includes(p)))
            return status("invalid");
          return status(proposed && proposed!==stored ? "different" : "valid");
        } catch { return status("unavailable"); }
      })().catch(()=>process.stdout.write("unavailable"));`;
      const read = await docker([...files, "run", "--rm", "-T", "--no-deps", "--entrypoint", "bun", "supervisor", "-e", script, baseUrl, account],
        { cwd: dir, input: candidate ? `${candidate}\n` : undefined, signal, timeoutMs: 120_000 });
      const status = read.stdout.trim();
      return read.code === 0 && ["valid", "different", "missing", "invalid", "unavailable"].includes(status)
        ? (status as RunnerOrgKeyStatus) : "unavailable";
    },
    async writeVolumeFile(dir, variable, value, signal) {
      if (variable !== "CATALYST_ORG_KEY_FILE") return false;
      const script = `umask 077 && tmp=$(mktemp "$${variable}.onboard.XXXXXX") && trap 'rm -f "$tmp"' EXIT && cat > "$tmp" && test -s "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$${variable}"`;
      const args = supervisorShell(dir, script);
      if (!args) return false;
      return (
        (
          await docker(args, {
            cwd: dir,
            input: `${value}\n`,
            signal,
            timeoutMs: 120_000,
          })
        ).code === 0
      );
    },
    async composeUp(dir, signal) {
      const files = compose(dir);
      if (!files) return { ok: false };
      const read = await docker([...files, "up", "--detach"], { cwd: dir, signal, timeoutMs: 600_000 });
      return read.code === 0
        ? { ok: true }
        : { ok: false, error: composeErrorText(read.stderr || read.stdout) };
    },
    async composeRunning(dir, signal) {
      const files = compose(dir);
      if (!files) return false;
      const read = await docker(
        [...files, "ps", "--status", "running", "--services"],
        { cwd: dir, signal },
      );
      return (
        read.code === 0 &&
        read.stdout.split("\n").some((line) => line.trim() === "supervisor")
      );
    },
  };
}

interface ListedHost {
  hostId: string;
  hostName: string;
  team: string;
  revoked: boolean;
  capacity: number | null;
  failing: string[];
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const waiting = (
  reason: string,
  evidence?: OnboardStep["evidence"],
): OnboardStepResult => ({ state: "waiting", reason, ...(evidence ? { evidence } : {}) });

function parseHosts(body: unknown): ListedHost[] | null {
  const hosts = object(body)?.hosts;
  if (!Array.isArray(hosts) || hosts.length > 1_000) return null;
  const parsed: ListedHost[] = [];
  for (const value of hosts) {
    const host = object(value);
    const capability = host?.capability === null ? null : object(host?.capability);
    if (
      !host ||
      typeof host.hostId !== "string" ||
      typeof host.hostName !== "string" ||
      typeof host.team !== "string" ||
      !(host.revokedAtMs === null || typeof host.revokedAtMs === "number") ||
      (host.capability !== null &&
        (!capability ||
          !Number.isSafeInteger(capability.placeableCapacity) ||
          (capability.placeableCapacity as number) < 0 ||
          typeof capability.runtimeLive !== "boolean" ||
          !Array.isArray(capability.failingRequired) ||
          !capability.failingRequired.every((id) => typeof id === "string")))
    )
      return null;
    parsed.push({
      hostId: host.hostId,
      hostName: host.hostName,
      team: host.team,
      revoked: host.revokedAtMs !== null,
      capacity: capability ? capability.runtimeLive
          ? (capability.placeableCapacity as number)
          : 0 : null,
      failing: capability ? (capability.failingRequired as string[]) : [],
    });
  }
  return parsed;
}

/** `KEY=value` lines; a single-quoted value is unquoted. Anything else is ignored. */
function readEnvFile(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    values[match[1]!] = /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return values;
}

function renderEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[\n\r']/.test(value)) throw new Error("runner_env_value_invalid");
      return `${key}=${/^[A-Za-z0-9._:/@+=,-]*$/.test(value) ? value : `'${value}'`}\n`;
    })
    .join("");
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Enrollment uses the stored host id and exact team/name. Two machines with one hostname must not
 * share it: a random suffix, kept in `.env` from the first write on. */
export function runnerDefaultHostName(): string {
  const base = (hostname().split(".")[0] ?? "machine")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 63);
  return HOST_NAME.test(base) ? base : "machine";
}

export interface OnboardRunnerInput {
  /** `--runner` (true) or `--no-runner` (false); undefined asks, or skips without a terminal. */
  selected?: boolean;
  /** The terminal question; null is a cancelled answer. */
  choose?: () => Promise<boolean | null>;
  engine?: RunnerEngine;
  hostName?: () => string;
  chooseName?: (defaultName: string) => Promise<string | null>;
  message?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long a check waits for the host to enroll and advertise. */
  waitMs?: number;
  pollMs?: number;
}

interface Prepared {
  installedName?: string;
  account: string;
  baseUrl: string;
  teamKey: string;
  teamId: string;
  cloud: boolean;
  dir: string;
  info: RunnerEngineInfo;
  images: { supervisor: string; watchdog: string; runner: string };
  installedSupervisorImage?: string;
}

/** Setup's image-preparation boundary, also runnable before an installation is changed.
 * Native custody receives these cached bytes independently and never pulls images itself. */
export async function prepareRunnerImages(
  engine: Pick<RunnerEngine, "imageArch" | "pull">,
  images: readonly string[],
  nativeArch: RunnerEngineInfo["arch"],
  signal?: AbortSignal,
): Promise<{ reason: "interrupted" | "runner_images_unavailable" | "runner_image_emulated"; image?: string } | null> {
  for (const ref of images) {
    if (signal?.aborted) return { reason: "interrupted" };
    const cached = await engine.imageArch(ref, signal);
    if (signal?.aborted) return { reason: "interrupted" };
    if (!cached && !(await engine.pull(ref, signal)))
      return signal?.aborted ? { reason: "interrupted" } : { reason: "runner_images_unavailable", image: ref };
    if (signal?.aborted) return { reason: "interrupted" };
    const arch = await engine.imageArch(ref, signal);
    if (signal?.aborted) return { reason: "interrupted" };
    if (!arch) return { reason: "runner_images_unavailable", image: ref };
    if (arch !== nativeArch) return { reason: "runner_image_emulated", image: ref };
  }
  return null;
}

export function onboardRunnerAdapter(input: OnboardRunnerInput = {},
): OnboardAdapter {
  const engine = input.engine ?? dockerRunnerEngine();
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = input.waitMs ?? 120_000;
  const pollMs = input.pollMs ?? 5_000;
  // One question per run: the engine checks again after acting, and the receipt row is "running"
  // in between, so the answer lives here too.
  let decided: boolean | null | undefined;
  // Only `--runner` or a yes in this run starts or repairs the runner. A yes saved by an earlier run
  // only reports on it, so an unattended check never restarts a runner the person stopped.
  let mayAct = false;
  let acted = false;
  let chosenName: string | undefined;
  let receivedCustody: { dir: string; result: DarwinThoughtsInstallResult } | undefined;
  const selected = { selected: true };

  async function decide(journal: OnboardJournal): Promise<boolean | null> {
    if (decided !== undefined) return decided;
    if (input.selected !== undefined) {
      mayAct = input.selected;
      return (decided = input.selected);
    }
    const prior = journal.steps.find((step) => step.id === "runner")?.evidence?.selected;
    if (typeof prior === "boolean") return (decided = prior);
    if (input.choose) {
      mayAct = (await input.choose()) === true;
      return (decided = mayAct);
    }
    return (decided = null);
  }

  /** Everything both check and act need, verified before any local change. */
  async function prepare(
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ): Promise<Prepared | OnboardStepResult> {
    const choice = await decide(journal);
    if (choice !== true)
      return {
        state: "skipped",
        reason: "runner_not_selected",
        ...(choice === false ? { evidence: { selected: false } } : {}),
      };
    const info = await engine.info(signal);
    if (!info) return { state: "skipped", reason: "runner_docker_missing", evidence: selected };
    if (info.unsupported) return waiting(info.unsupportedReason ?? "runner_engine_unsupported", selected);
    const cfg = loadConfig(ctx.home);
    const account = journal.account ?? journal.tenant;
    if (
      !cfg?.user ||
      !["owner", "admin"].includes(cfg.user.role) ||
      !account ||
      cfg.account !== account ||
      cfg.user.id !== journal.membershipId ||
      !journal.baseUrl ||
      normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
    )
      return waiting("runner_identity_unverified", selected);
    const support = await verifyOnboardRoutes(
      ctx,
      journal,
      [
        { method: "GET", path: ENROLLMENTS },
        { method: "POST", path: JOIN_TOKENS },
        { method: "GET", path: CAPACITY },
      ],
      signal,
    );
    if ("reason" in support) return waiting(support.reason, selected);
    let state: string;
    try { state = onboardStateRoot(ctx.home, ctx.env); }
    catch { return waiting("runner_directory_unavailable", selected); }
    let dir = join(state, "runner");
    const installation = await engine.installation?.(ctx.home, ctx.env.CATALYST_SUPERVISOR_IMAGE ?? RUNNER_HOST_IMAGES.supervisor, signal);
    if (installation === "unverified") return waiting("runner_installation_unverified", selected);
    let credential: RunnerEnrollment | RunnerUnenrolled | null = null;
    if (installation && installation !== "missing") {
      if (installation.baseUrl !== normalizeBaseUrl(cfg.baseUrl)) return waiting("runner_identity_unverified", selected);
      dir = installation.dir;
      credential = await engine.enrollment(dir, signal);
      if (!credential) return waiting("runner_credential_unverified", selected);
      if (!isUnenrolled(credential) && (credential.tenant !== account || credential.enrollmentKind !== "self_hosted"))
        return waiting("runner_identity_unverified", selected);
    }
    let teamId = selectedOnboardTeam(journal);
    if (!teamId && credential && !isUnenrolled(credential)) {
      // Moving on retains the verified installation's project scope. Never choose the first team.
      const teams = await readOnboardTeamInventory(ctx, signal);
      if (!("reason" in teams)) {
        const installedTeam = credential.team;
        const matching = teams.teams.filter(team => team.key === installedTeam);
        if (matching.length === 1) teamId = matching[0]!.id;
      }
    }
    const teamKey = teamId ? await liveTeamKey(ctx, teamId, signal ?? new AbortController().signal) : null;
    if (!teamId || !teamKey) return waiting("runner_context_unverified", selected);
    if (credential && !isUnenrolled(credential) && credential.team !== teamKey)
      return waiting("runner_enrolled_for_other_team", selected);
    const runnerSupport=await verifyRunnerRoutes(ctx,journal,[{method:"GET",path:"/api/v1/agent/runner-admission"}],signal);
    if("reason" in runnerSupport && runnerSupport.reason!=="cloud_capability_unavailable") return waiting(runnerSupport.reason,selected);
    const cloud=!("reason" in runnerSupport);
    const saved = readEnvFile(join(dir, ".env"));
    const images = {
      supervisor: ctx.env.CATALYST_SUPERVISOR_IMAGE ?? RUNNER_HOST_IMAGES.supervisor,
      watchdog: ctx.env.CATALYST_WATCHDOG_IMAGE ?? RUNNER_HOST_IMAGES.watchdog,
      runner: ctx.env.CATALYST_RUNNER_IMAGE ?? saved?.CATALYST_RUNNER_IMAGE ?? RUNNER_HOST_IMAGES.runner,
    };
    if (!Object.values(images).every((ref) => IMAGE_REF.test(ref)))
      return waiting("runner_image_unpinned", selected);
    if(!info.vm && !(await engine.nativeEgressStatus?.(ctx.now().getTime(),signal)))return waiting("runner_native_egress_setup_required",selected);
    return { account, baseUrl: normalizeBaseUrl(cfg.baseUrl), teamKey, teamId, cloud, dir, info, images,
      ...(installation && installation !== "missing" ? { installedName: installation.hostName,
        installedSupervisorImage: installation.supervisorImage } : {}) };
  }

  async function desiredEnv(
    p: Prepared,
    ctx: Ctx,
    joinToken?: string,
  ): Promise<Record<string, string> | null> {
    const saved = readEnvFile(join(p.dir, ".env")) ?? {};
    const name = p.installedName || saved.CATALYST_HOST_NAME || chosenName || (input.hostName ?? runnerDefaultHostName)();
    const gid = p.info.vm ? 0 : await engine.socketGid();
    if (!HOST_NAME.test(name) || gid === null) return null;
    return {
      DOCKER_SOCKET_PATH: "/var/run/docker.sock",
      DOCKER_SOCKET_GID: String(gid),
      CATALYST_WATCHDOG_IMAGE: p.images.watchdog,
      CATALYST_SUPERVISOR_IMAGE: p.images.supervisor,
      CATALYST_MIRROR_URL: p.baseUrl,
      CATALYST_HOST_NAME: name,
      CATALYST_HOST_JOIN_TOKEN: joinToken ?? saved.CATALYST_HOST_JOIN_TOKEN ?? "",
      CATALYST_RUNNER_IMAGE: p.images.runner,
      CATALYST_SLOTS_DIR: join(p.dir, "slots"),
      CATALYST_THOUGHTS_DIR: join(p.dir, "thoughts"),
      CATALYST_POOL_LOCK_DIR: join(p.dir, "locks"),
      ...(p.info.vm && receivedCustody?.dir === p.dir ? {
        CATALYST_THOUGHTS_CUSTODY_AUTHORITY: receivedCustody.result.envAuthority,
        CATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR: receivedCustody.result.requestsRoot,
        CATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR: receivedCustody.result.responsesRoot,
      } : {}),
      CATALYST_SESSION_EGRESS_DIR: p.info.vm ? join(p.dir, "session-egress") : NATIVE_EGRESS_DIR,
      // Saved policy stays in merged(). An explicit value in this run overrides it.
      ...Object.fromEntries(DISK_POLICY_KEYS.flatMap(key =>
        ctx.env[key] === undefined ? [] : [[key, ctx.env[key]!]],
      )),
    };
  }
  /** The step owns its own keys only; a person's tuning (CATALYST_SLOTS and the rest) is kept. */
  const merged = (saved: Record<string, string> | null, want: Record<string, string>) => ({
    ...want,
    ...Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => !(key in want))),
  });

  async function refuseCustody(ctx: Ctx, journal: OnboardJournal, failureCase: CustodyFailureCase,
    message: string, details: Omit<CustodyFailureDetails, "custodyFailureCase"> = {}, signal?: AbortSignal): Promise<OnboardStepResult> {
    if (signal?.aborted) return waiting("interrupted", selected);
    input.message?.(message);
    const evidence = { custodyFailureCase: failureCase, ...details };
    const delivered = await emitCustodyFailure(ctx, journal, evidence, signal);
    return waiting("runner_thoughts_custody_unavailable", { ...selected, ...evidence,
      custodyTelemetry: delivered ? "sent" : "unavailable" });
  }

  async function listHosts(
    ctx: Ctx,
    p: Prepared,
    signal?: AbortSignal,
  ): Promise<ListedHost[] | null> {
    const read = await readExistingOnboardJson(
      ctx,
      `${ENROLLMENTS}?account=${encodeURIComponent(p.account)}`,
      signal,
    );
    return "reason" in read ? null : parseHosts(read.body);
  }

  async function mintJoinToken(
    ctx: Ctx,
    p: Prepared,
    hostName: string,
    signal?: AbortSignal,
  ): Promise<string | OnboardStepResult> {
    const cfg = loadConfig(ctx.home);
    const expiry = cfg?.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
    const bearer =
      cfg?.key ||
      (cfg?.auth && Number.isFinite(expiry) && expiry > 30_000 ? cfg.auth.accessToken : undefined);
    if (!bearer) return waiting("runner_login_refresh_required", selected);
    try {
      const response = await ctx.fetch(
        `${p.baseUrl}${JOIN_TOKENS}?account=${encodeURIComponent(p.account)}`,
        {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            version: 1,
            team: p.teamKey,
            enrollmentKind: "self_hosted",
            hostName,
            ttlMs: 3_600_000,
          }),
        },
      );
      const body = object(await response.json().catch(() => null));
      if (body?.refusal === "not_tenant_admin") return waiting("runner_identity_unverified", selected);
      if (response.status !== 201 || body?.ok !== true || typeof body.joinToken !== "string" || !JOIN_TOKEN.test(body.joinToken))
        return waiting("runner_join_token_unavailable", selected);
      return body.joinToken;
    } catch {
      return waiting(signal?.aborted ? "interrupted" : "runner_join_token_unavailable", selected);
    }
  }

  function orgKeyFromFile(ctx: Ctx): string | null | undefined {
    const path = ctx.env.CATALYST_RUNNER_ORG_KEY_FILE;
    if (!path) return undefined;
    try {
      if (!lstatSync(path).isFile()) return null;
      const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.length === 1 && /^[\x21-\x7e]{16,1024}$/.test(lines[0]!) ? lines[0]! : null;
    } catch {
      return null;
    }
  }

  return {
    check: async (ctx, journal, signal) => {
      // Only the check right after this run's own act waits for the host to appear.
      const afterAct = acted;
      acted = false;
      const p = await prepare(ctx, journal, signal);
      if (!("dir" in p)) return p;
      const saved = readEnvFile(join(p.dir, ".env"));
      const want = await desiredEnv(p, ctx);
      if (!want) return waiting("runner_docker_socket_unreadable", selected);
      const name = want.CATALYST_HOST_NAME!;
      if (p.info.vm && persistedCustody(p.dir, saved) !== "installed")
        return mayAct && !afterAct ? { state: "pending" } : waiting(
          mayAct ? "runner_thoughts_custody_unavailable" : "runner_needs_runner_flag", { ...selected, hostName: name });
      let enrolled: RunnerEnrollment | null = null;
      const live = (hosts: ListedHost[] | null) =>
        hosts?.find(
          (host) =>
            host.hostId === enrolled?.hostId && host.team === p.teamKey && !host.revoked,
        );
      let hosts = await listHosts(ctx, p, signal);
      if (!hosts) return waiting("runner_enrollment_unavailable", selected);
      const existingCredential = await engine.enrollment(p.dir, signal);
      if (
        (!existingCredential || isUnenrolled(existingCredential)) &&
        hosts.some(
          (host) =>
            host.hostName === name && !host.revoked && host.team !== p.teamKey,
        )
      )
        return waiting("runner_enrolled_for_other_team", {
          ...selected,
          hostName: name,
        });
      if (
        existingCredential &&
        !isUnenrolled(existingCredential) &&
        hosts.some(
          (host) =>
            host.hostId === existingCredential.hostId &&
            !host.revoked &&
            host.team !== p.teamKey,
        )
      )
        return waiting("runner_enrolled_for_other_team", { ...selected, hostName: name });
      const running = await engine.composeRunning(p.dir, signal);
      let composeMatches = false;
      try {
        composeMatches = readFileSync(join(p.dir, "compose.yaml")).equals(
          readFileSync(join(packageRoot(), "vendor", "self-host", "compose.yaml")),
        );
        if (p.info.vm) composeMatches = composeMatches && readFileSync(join(p.dir, "compose.darwin-thoughts.yaml")).equals(
          readFileSync(join(packageRoot(), "vendor", "self-host", "compose.darwin-thoughts.yaml")),
        );
      } catch {
        /* A missing or unreadable compose needs an explicitly authorized repair. */
      }
      const changed = !saved || !composeMatches || Object.entries(want).some(([key, value]) => saved[key] !== value) ||
        (p.installedSupervisorImage !== undefined && p.installedSupervisorImage !== p.images.supervisor);
      const hostEvidence = { ...selected, hostName: name, supervisorImage: p.images.supervisor };
      const pending = (): OnboardStepResult =>
        mayAct ? { state: "pending" } : waiting("runner_needs_runner_flag", hostEvidence);
      if (!running || changed)
        return afterAct ? waiting("runner_compose_not_running", hostEvidence) : pending();
      // The supervisor enrolls on its first start and advertises shortly after.
      for (let attempt = 1; ; attempt++) {
        const credential = await engine.enrollment(p.dir, signal);
        enrolled = isUnenrolled(credential) ? null : credential;
        // Enrollment can complete while the container metadata read is running. The cloud
        // snapshot must follow that read before a missing credential ID can be called stale.
        hosts = await listHosts(ctx, p, signal);
        if (!hosts) return waiting("runner_enrollment_unavailable", hostEvidence);
        if (enrolled && (enrolled.tenant !== p.account || enrolled.enrollmentKind !== "self_hosted"))
          return waiting("runner_identity_unverified", hostEvidence);
        if (enrolled && enrolled.team !== p.teamKey)
          return waiting("runner_enrolled_for_other_team", hostEvidence);
        if (enrolled) {
          const exact = hosts.find((host) => host.hostId === enrolled!.hostId);
          if (exact?.revoked) return waiting("runner_enrollment_revoked", { ...hostEvidence, hostId: enrolled.hostId });
          if (!exact || exact.team !== p.teamKey) return waiting("runner_enrollment_unverified", hostEvidence);
        }
        const host = live(hosts);
        if (host && host.capacity !== null) break;
        if (!host && !afterAct) return pending();
        if (attempt >= Math.max(1, Math.ceil(waitMs / pollMs)) || signal?.aborted)
          return waiting(host ? "runner_capability_pending" : "runner_enrollment_unverified", hostEvidence);
        await sleep(pollMs);
      }
      const host = live(hosts)!;
      const evidence = { ...hostEvidence, hostName: host.hostName, hostId: host.hostId, capacity: host.capacity! };
      const orgKey = orgKeyFromFile(ctx);
      if (orgKey === null) return waiting("runner_org_key_file_invalid", evidence);
      const keyStatus = await engine.orgKeyStatus(p.dir, p.account, p.baseUrl, orgKey, signal);
      if (keyStatus === "different")
        return !afterAct ? pending() : waiting("runner_org_key_write_failed", evidence);
      if(keyStatus==="missing" && p.cloud && mayAct && !afterAct)return pending();
      if (keyStatus !== "valid")
        return waiting(keyStatus === "missing" ? "runner_org_key_missing" : keyStatus === "invalid" ? "runner_org_key_invalid" : "runner_org_key_unavailable", evidence);
      if (host.capacity === 0 || host.failing.length > 0)
        return waiting("runner_host_not_ready", { ...evidence, failing: host.failing.join(",") });
      if(p.cloud){
        const admission=await runnerAdmission(ctx,journal,p.teamId,false,signal);
        if("reason" in admission)return waiting(admission.reason,evidence);
        if(!admission.ready)return mayAct && !afterAct ? pending() : waiting("runner_admission_disabled",evidence);
      } else {
        // Legacy capacity only names repo-mapped teams. The supported personal route above
        // verifies runner admission independently of repository setup.
        const admission = await onboardTeamAdmission(ctx, p.teamKey, signal);
        if (admission !== true)
          return waiting(admission === false ? "runner_admission_operator" : "runner_admission_unverified", evidence);
      }
      input.message?.(
        `This machine runs Catalyst's work as host ${name}, with ${host.capacity} slots free.`,
      );
      return { state: "done", evidence };
    },
    act: async (ctx, journal, signal) => {
      const p = await prepare(ctx, journal, signal);
      if (!("dir" in p)) return p;
      if(!mayAct)return waiting("runner_needs_runner_flag",selected);
      let replacingContainers = false;
      try {
        mkdirSync(p.dir, { recursive: true, mode: 0o700 });
        if (lstatSync(p.dir).isSymbolicLink()) throw new Error("runner_directory_unsafe");
        if (!p.info.vm) chmodSync(p.dir, 0o700);
        for (const sub of DIRS) {
          mkdirSync(join(p.dir, sub), { recursive: true, mode: 0o700 });
          // On native Linux the runner uid owns these after the first run; leave them alone.
          // The native Darwin installer must receive existing thoughts custody without adoption.
          if ((!p.info.vm || sub === "slots") && statSync(join(p.dir, sub)).uid === process.getuid?.()) chmodSync(join(p.dir, sub), 0o700);
        }
        // Mounted read-only into the supervisor (uid 10001), which reads the egress attestation.
        mkdirSync(join(p.dir, "session-egress"), { recursive: true, mode: 0o755 });
        // The canonical compose binds host-native disk samples read-only. A custom sample
        // directory belongs to its operator; only create the install's default directory.
        mkdirSync(join(p.dir, "host-disk"), { recursive: true, mode: 0o755 });
        const compose = readFileSync(join(packageRoot(), "vendor", "self-host", "compose.yaml"));
        let current: Buffer | null = null;
        try {
          current = readFileSync(join(p.dir, "compose.yaml"));
        } catch {
          /* first run */
        }
        if (!current?.equals(compose)) {
          replacingContainers = current !== null;
          writeFileSync(join(p.dir, "compose.yaml"), compose, { mode: 0o644 });
        }
      } catch {
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      }
      if (
        !p.installedName &&
        !readEnvFile(join(p.dir, ".env"))?.CATALYST_HOST_NAME &&
        chosenName === undefined
      ) {
        const suggested = (input.hostName ?? runnerDefaultHostName)();
        const name = input.chooseName
          ? await input.chooseName(suggested)
          : suggested;
        if (name === null || !HOST_NAME.test(name))
          return waiting("runner_name_required", selected);
        chosenName = name;
      }
      let want = await desiredEnv(p, ctx);
      if (!want) return waiting("runner_docker_socket_unreadable", selected);
      const writeEnv = (values: Record<string, string>): boolean => {
        try {
          const saved = readEnvFile(join(p.dir, ".env"));
          if (saved && Object.entries(values).every(([key, value]) => saved[key] === value))
            return true;
          writePrivate(join(p.dir, ".env"), renderEnv(merged(saved, values)));
          return true;
        } catch {
          return false;
        }
      };
      const imagesRefused = await prepareRunnerImages(engine, Object.values(p.images), p.info.arch, signal);
      if (imagesRefused) return waiting(
        imagesRefused.reason === "runner_images_unavailable" && imagesRefused.image === p.images.supervisor
          ? "runner_supervisor_image_unavailable" : imagesRefused.reason,
        { ...selected, supervisorImage: p.images.supervisor,
          ...(imagesRefused.image ? { image: imagesRefused.image } : {}) });
      if (p.info.vm) {
        const capability = await engine.vmCapabilities(p.dir, p.images.supervisor, p.baseUrl, signal);
        if (capability !== "ready") return waiting(capability, selected);
        if (!engine.nativeThoughtsCustody) return refuseCustody(ctx, journal, "capability_missing",
          "Setup could not verify local storage: this engine has no native storage-check capability.", {}, signal);
        let custodyReturned = false;
        try {
          const result = await engine.nativeThoughtsCustody({ dir: p.dir,
            supervisorImage: p.images.supervisor, runnerImage: p.images.runner }, signal);
          custodyReturned = true;
          if (signal?.aborted) return waiting("interrupted", selected);
          const values = {
            CATALYST_THOUGHTS_CUSTODY_AUTHORITY: result.envAuthority,
            CATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR: result.requestsRoot,
            CATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR: result.responsesRoot,
          };
          const custodyResultInstalled = persistedCustody(p.dir, values) === "installed";
          const custodyAuthorityMatched = canonicalDarwinThoughtsJson(result.authority) === result.envAuthority;
          if (!custodyResultInstalled || !custodyAuthorityMatched)
            return refuseCustody(ctx, journal, "result_unverified",
              "Setup could not verify local storage: the returned installation or authority did not match.",
              { custodyResultInstalled, custodyAuthorityMatched }, signal);
          writePrivate(join(p.dir, "compose.darwin-thoughts.yaml"),
            readFileSync(join(packageRoot(), "vendor", "self-host", "compose.darwin-thoughts.yaml"), "utf8"));
          receivedCustody = { dir: p.dir, result };
          want = (await desiredEnv(p, ctx))!;
        } catch (error) {
          const custodyReason = darwinThoughtsInstallRefusal(error);
          const failureCase = custodyReturned ? "result_unverified" : "call_threw";
          const details = { ...darwinThoughtsInstallException(error), ...(custodyReason ? { custodyReason } : {}) };
          const advice = darwinThoughtsInstallAdvice(error);
          return refuseCustody(ctx, journal, failureCase,
            `Setup could not verify local storage: ${custodyReturned ? "recording the result failed" : "the native check threw"} (${details.custodyErrorClass}: ${details.custodyErrorMessage}).` +
              (advice ? " " + advice : ""),
            details, signal);
        }
      }
      if (!writeEnv(want))
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      const network = await engine.network(RUNNER_SESSION_NETWORK, signal);
      if (network === "misshaped") return waiting("runner_session_network_misshaped", selected);
      if (network === "unavailable") return waiting("runner_session_network_unavailable",selected);
      if (network === "missing" && !(await engine.createNetwork(RUNNER_SESSION_NETWORK, signal)))
        return { state: "failed", reason: "runner_session_network_failed", evidence: selected };
      if (!p.info.vm && !(await engine.claimDirs(p.dir, DIRS.map((sub) => join(p.dir, sub)), signal)))
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      const name = want.CATALYST_HOST_NAME!;
      const hasCredential = await engine.hasVolumeFile(p.dir, "CATALYST_HOST_CREDENTIAL_FILE", signal);
      const credential = hasCredential ? await engine.enrollment(p.dir, signal) : null;
      const enrolled = isUnenrolled(credential) ? null : credential;
      const hosts = await listHosts(ctx, p, signal);
      if (!hosts) return waiting("runner_enrollment_unavailable", selected);
      if (!enrolled &&
        hosts.some((host) => host.hostName === name && !host.revoked && host.team !== p.teamKey,
        ))
        return waiting("runner_enrolled_for_other_team", { ...selected, hostName: name });
      if (enrolled && (enrolled.tenant !== p.account || enrolled.enrollmentKind !== "self_hosted"))
        return waiting("runner_identity_unverified", { ...selected, hostName: name });
      if (enrolled && enrolled.team !== p.teamKey)
        return waiting("runner_enrolled_for_other_team", { ...selected, hostName: name });
      if (hasCredential && !isUnenrolled(credential)) {
        if (!enrolled) return waiting("runner_credential_unverified", { ...selected, hostName: name });
        const exact = hosts.find((host) => host.hostId === enrolled.hostId);
        if (exact?.revoked) return waiting("runner_enrollment_revoked", { ...selected, hostName: name, hostId: enrolled.hostId });
        if (!exact || exact.team !== p.teamKey) return waiting("runner_enrollment_unverified", { ...selected, hostName: name });
      }
      // A lost volume also lost the secret that redeemed the old token. Mint a new token and match
      // the new host id from the supervisor's credential, never an old advertisement with this name.
      // A lost reply must retry the same token and retained secret: a new token would be
      // refused as identity_invalid after the cloud committed that secret's enrollment.
      // Only a token known refused/spent (or missing) can be replaced for an unenrolled file.
      if (!hasCredential || (isUnenrolled(credential) && credential.tokenSpent)) {
        const token = await mintJoinToken(ctx, p, name, signal);
        if (typeof token !== "string") return token;
        want = (await desiredEnv(p, ctx, token))!;
        if (!writeEnv(want))
          return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      }
      const orgKey = orgKeyFromFile(ctx);
      if (orgKey === null) return waiting("runner_org_key_file_invalid", selected);
      let keyStatus = await engine.orgKeyStatus(p.dir, p.account, p.baseUrl, orgKey, signal);
      if (keyStatus === "invalid" || keyStatus === "unavailable")
        return waiting(keyStatus === "invalid" ? "runner_org_key_invalid" : "runner_org_key_unavailable", selected);
      if (orgKey && keyStatus === "different")
        if (!(await engine.writeVolumeFile(p.dir, "CATALYST_ORG_KEY_FILE", orgKey, signal)))
          return { state: "failed", reason: "runner_org_key_write_failed", evidence: selected };
      if(keyStatus==="missing" && p.cloud){
        const issued=await issueRunnerOrgKey(ctx,journal,{dir:p.dir,teamId:p.teamId,hostName:name},value=>engine.writeVolumeFile(p.dir,"CATALYST_ORG_KEY_FILE",value,signal),signal);
        if("reason" in issued)return waiting(issued.reason,selected);
        keyStatus=await engine.orgKeyStatus(p.dir,p.account,p.baseUrl,undefined,signal);
        if(keyStatus!=="valid")return waiting(keyStatus==="invalid"?"runner_org_key_invalid":"runner_org_key_unavailable",selected);
      }
      if(p.cloud){
        const read=await runnerAdmission(ctx,journal,p.teamId,false,signal);
        if("reason" in read)return waiting(read.reason,selected);
        if(!read.ready){const enabled=await runnerAdmission(ctx,journal,p.teamId,true,signal);if("reason" in enabled)return waiting(enabled.reason,selected);if(!enabled.ready)return waiting("runner_admission_unverified",selected);}
      }
      // CTC-5721: an older catalyst-host project must never meet Compose as a surprise exit.
      // Its paused containers cannot be started by Compose: adopt them, or name the exact command.
      const containers = (await engine.projectContainers?.(signal)) ?? null;
      const paused = containers?.filter((row) => row.state === "paused") ?? [];
      const pausedNames = [...new Set(paused.map((row) => row.service))];
      if (paused.length > 0) {
        const resumed = (await engine.composeUnpause?.(p.dir, signal)) === true;
        if (!resumed)
          return waiting("runner_compose_paused", { ...selected, hostName: name,
            project: RUNNER_PROJECT, services: pausedNames.join(",") });
        input.message?.(`Resumed the paused containers (${pausedNames.join(", ")}) of the existing ${RUNNER_PROJECT} project; setup adopts it.`);
      } else if (containers && containers.length > 0 && replacingContainers) {
        input.message?.(`Replacing the existing ${RUNNER_PROJECT} project's containers (${[...new Set(containers.map((row) => row.service))].join(", ")}) with this release's Compose definitions.`);
      } else if (containers && containers.some((row) => row.state !== "running")) {
        const stopped = [...new Set(containers.filter((row) => row.state !== "running").map((row) => row.service))];
        input.message?.(`Starting the existing ${RUNNER_PROJECT} project's stopped containers (${stopped.join(", ")}); setup adopts it.`);
      }
      const up = await engine.composeUp(p.dir, signal);
      if (!up.ok)
        return { state: "failed", reason: "runner_compose_failed", evidence: { ...selected,
          project: RUNNER_PROJECT, ...(up.error ? { composeError: up.error } : {}) } };
      acted = true;
      return { state: "done" };
    },
  };
}
