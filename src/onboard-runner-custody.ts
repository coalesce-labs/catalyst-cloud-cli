import fs from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalDarwinThoughtsJson,
  parseDarwinThoughtsAuthority,
  parseDarwinThoughtsRequest,
  verifyDarwinThoughtsCustodyResponse,
} from "../vendor/self-host/darwin-thoughts-custody/verifier.mjs";

interface Authority {
  readonly version: 1; readonly installationId: string; readonly publicKey: string;
  readonly nativeUid: number; readonly nativeGid: number; readonly nativeHome: string;
  readonly endpoint: string; readonly daemonId: string; readonly thoughtsRoot: string;
  readonly locksRoot: string; readonly requestsRoot: string; readonly responsesRoot: string;
}
export interface DarwinThoughtsInstallInput {
  readonly dir: string; readonly supervisorImage: string; readonly runnerImage: string;
  readonly deadlineMs: number;
}
export interface DarwinThoughtsInstallResult {
  readonly authority: Authority; readonly envAuthority: string;
  readonly requestsRoot: string; readonly responsesRoot: string;
  readonly configPath: string; readonly serviceLabel: string;
}
interface Principal {
  readonly platform: string; readonly uid: number; readonly euid: number;
  readonly gid: number; readonly home: string;
}
interface Executables { readonly nodeExecutable: string; readonly dockerExecutable: string; }
interface Artifacts {
  readonly producer: Buffer; readonly watchdog: Buffer; readonly deadline: Buffer;
  readonly verifier: Buffer; readonly serviceTemplate: string;
}
interface EngineInput extends Executables {
  readonly [key: string]: unknown;
  readonly principal: Principal; readonly supervisorImage: string;
  readonly runnerImage: string; readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}
interface EngineIdentity {
  readonly endpoint: string; readonly daemonId: string;
  readonly cachedSupervisor: boolean; readonly cachedRunner: boolean;
  readonly runnerCustodyVersion?: string;
}
interface BootstrapInput extends Executables {
  readonly authority: Authority; readonly configPath: string;
  /** The hash-checked verifier copy in custody state, which Docker Desktop shares from the home. */
  readonly verifierPath: string;
  readonly supervisorImage: string; readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}
interface BootstrapReceipt {
  readonly bytes: Buffer; readonly request: unknown;
  readonly engineCheckout: unknown; readonly engineLock: unknown; readonly engineGit?: unknown;
}
interface ServiceInput extends Executables {
  readonly [key: string]: unknown;
  readonly uid: number; readonly serviceLabel: string; readonly plistPath: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}
interface Ports {
  readonly principal: () => Principal; readonly now: () => number;
  readonly stat: (path: string, stat: fs.BigIntStats) => fs.BigIntStats;
  readonly executables: () => Executables; readonly artifacts: () => Artifacts;
  readonly engineIdentity: (input: EngineInput) => Promise<EngineIdentity>;
  readonly service: (input: ServiceInput) => Promise<void>;
  readonly receiveBootstrap: (input: BootstrapInput) => Promise<BootstrapReceipt>;
}
const LABEL = "dev.catalystcloud.runner.darwin-thoughts-custody";
const vendor = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/self-host/darwin-thoughts-custody");
class CustodyInstallError extends Error {
  constructor(readonly reason: string) { super("darwin_thoughts_custody_install:" + reason); this.name = "CustodyInstallError"; }
}
/** Only our fixed installer errors may reach output; never forward command stderr or causes. */
export function darwinThoughtsInstallRefusal(error: unknown): string | undefined {
  return error instanceof CustodyInstallError ? error.reason : undefined;
}
/** Unknown exception text can contain credentials. Keep its class, and explicitly redact it. */
export function darwinThoughtsInstallException(error: unknown): { custodyErrorClass: string; custodyErrorMessage: string; custodyErrorMessageRedacted: boolean } {
  const known = error instanceof CustodyInstallError;
  const classes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "CustodyInstallError"]);
  return { custodyErrorClass: error instanceof Error && classes.has(error.name) ? error.name : "Error",
    custodyErrorMessage: known ? error.message : "Unclassified local storage exception; message withheld to protect credentials.",
    custodyErrorMessageRedacted: !known };
}
function fail(reason: string): never { throw new CustodyInstallError(reason); }
const CREATE_REFUSAL_ADVICE: Readonly<Record<string, string>> = {
  file_sharing: "Docker Desktop refused to share a storage folder with the check container. In Docker Desktop, open Settings, then Resources, then File sharing, make sure your home folder is listed, apply, and run setup again.",
  image_not_cached: "The pinned supervisor image is not in this engine's cache. Run setup again so it fetches the pinned images first.",
};
/** One fixed next step for a known installer refusal; undefined when there is none to give. */
export function darwinThoughtsInstallAdvice(error: unknown): string | undefined {
  const reason = darwinThoughtsInstallRefusal(error);
  const kind = reason?.startsWith("bootstrap_create_refused:") ? reason.slice("bootstrap_create_refused:".length) : undefined;
  return kind === undefined ? undefined : CREATE_REFUSAL_ADVICE[kind];
}
/** Classify the daemon's own create refusal into a closed code; its text never reaches output.
 * Only an HTTP error response from the daemon proves it rejected the create. A CLI or transport
 * failure (unexpected EOF, reset, timeout) is ambiguous: the daemon may still persist the helper,
 * so it returns undefined and cleanup recovers exactly as for an absent ACK. */
function createRefusal(stderr: string): string | undefined {
  if (!/(?:^|\n)(?:docker: )?Error response from daemon: /.test(stderr)) return undefined;
  if (/mounts denied|is not shared from the host|not known to Docker/i.test(stderr)) return "bootstrap_create_refused:file_sharing";
  if (/No such image|pull access denied|manifest unknown/i.test(stderr)) return "bootstrap_create_refused:image_not_cached";
  return "bootstrap_create_refused";
}
const VERIFIER_REFUSALS = new Set([
  "ancestor", "ancestor_identity", "bootstrap_directory", "bootstrap_owner", "bootstrap_path",
  "channel_identity", "cleanup", "deadline", "directory", "engine_identity", "exchange",
  "file_owner", "git_descriptor", "git_path", "invalid", "noncanonical_json", "nonce_collision",
  "path", "producer_refused", "signature", "size", "substituted_file", "substituted_request",
  "unsafe_directory", "unsafe_file",
]);
function path(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value.includes("\0") ||
      value.endsWith("/") || value === "/") fail("principal_path_unsafe");
  return value;
}
function below(value: string, root: string): boolean {
  const rel = relative(root, value);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
function image(value: string) {
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value)) fail("image_pin_invalid");
}
function same(a: fs.BigIntStats, b: fs.BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
    a.gid === b.gid && (a.isDirectory() || (a.nlink === b.nlink && a.size === b.size &&
      a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs));
}
class Custody {
  private readonly held = new Map<string, { fd: number; stat: fs.BigIntStats }>();
  constructor(readonly principal: Principal, private readonly ports: Ports) {}
  hold(value: string, directory: boolean, privateDirectory = false, publicAncestor = false) {
    let held = this.held.get(value);
    if (!held) {
      let fd: number;
      try { fd = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK | (directory ? fs.constants.O_DIRECTORY : 0)); }
      catch { return fail("state_custody_unsafe"); }
      const stat = this.ports.stat(value, fs.fstatSync(fd, { bigint: true }));
      held = { fd, stat }; this.held.set(value, held);
    }
    this.recheck();
    const stat = held.stat; const mode = Number(stat.mode & 0o7777n);
    if (stat.uid !== BigInt(this.principal.uid) || stat.gid !== BigInt(this.principal.gid)) fail("native_owner_mismatch");
    if (directory) {
      if (!stat.isDirectory() || (mode & 0o7022) !== 0 || (mode & 0o700) !== 0o700 ||
          (!publicAncestor && (mode & 0o007) !== 0) || (privateDirectory && mode !== 0o700)) fail("directory_custody_unsafe");
    } else if (!stat.isFile() || stat.nlink !== 1n || mode !== 0o600) fail("file_custody_unsafe");
    return held;
  }
  walk(value: string, create = false, mode = 0o700, privateLeaf = false, publicAncestors = false) {
    path(value);
    if (value !== this.principal.home && !below(value, this.principal.home)) fail("principal_home_authority_mismatch");
    this.hold(this.principal.home, true, false, true);
    let cursor = this.principal.home;
    const levels = relative(cursor, value).split("/").filter(Boolean);
    for (let index = 0; index < levels.length; index++) {
      this.recheck(); cursor = join(cursor, levels[index]!);
      try { fs.lstatSync(cursor); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) fail("state_custody_unsafe");
        try { fs.mkdirSync(cursor, { mode }); }
        catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "EEXIST") fail("state_create_failed"); }
      }
      this.hold(cursor, true, privateLeaf && index === levels.length - 1,
        publicAncestors || index < levels.length - 1);
    }
    return this.hold(value, true, privateLeaf, publicAncestors || value === this.principal.home);
  }
  read(value: string, maximum = 65536) {
    this.walk(dirname(value), false, 0o700, false,
      dirname(value) === join(this.principal.home, "Library", "LaunchAgents"));
    const held = this.hold(value, false);
    if (held.stat.size > BigInt(maximum)) fail("file_custody_unsafe");
    const bytes = Buffer.alloc(Number(held.stat.size));
    if (fs.readSync(held.fd, bytes, 0, bytes.length, 0) !== bytes.length) fail("file_custody_unsafe");
    this.recheck(); return bytes;
  }
  create(value: string, bytes: Buffer) {
    this.walk(dirname(value), false, 0o700, false,
      dirname(value) === join(this.principal.home, "Library", "LaunchAgents"));
    this.recheck();
    const fd = fs.openSync(value, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.hold(value, false);
  }
  /** Atomically re-records an already-held private file. The replacement is created inside the
   * held directory and renamed over the target, then re-held, so every custody invariant
   * (single-owner 0600, nlink 1, no symlinks) is re-verified on the new bytes. */
  replace(value: string, bytes: Buffer) {
    const held = this.hold(value, false);
    this.recheck();
    const temporary = value + "." + randomBytes(16).toString("hex") + ".tmp";
    let renamed = false;
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, value);
      renamed = true;
    } finally {
      if (!renamed) try { fs.unlinkSync(temporary); } catch { /* The original error propagates. */ }
    }
    fs.closeSync(held.fd);
    this.held.delete(value);
    this.hold(value, false);
    this.recheck();
  }
  recheck() {
    for (const [value, held] of this.held) {
      const current = this.ports.stat(value, fs.fstatSync(held.fd, { bigint: true }));
      const named = this.ports.stat(value, fs.lstatSync(value, { bigint: true }));
      if (!same(held.stat, current) || !same(current, named)) fail("descriptor_custody_changed");
    }
  }
  close() { for (const held of this.held.values()) fs.closeSync(held.fd); this.held.clear(); }
}
function parse(bytes: Buffer) {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return fail("state_config_invalid"); }
  if (!Buffer.from(canonicalDarwinThoughtsJson(value)).equals(bytes)) fail("state_config_invalid");
  return value;
}
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("state_config_invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail("state_config_invalid");
  return row;
}
function xml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function executable(value: string, principal: Principal, roots: string[]) {
  path(value);
  if (fs.realpathSync(value) !== value || roots.some(root => value === root || below(value, root))) fail("executable_custody_unsafe");
  const fd = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || (stat.mode & 0o7022n) !== 0n || (stat.mode & 0o111n) === 0n ||
        (stat.uid !== 0n && stat.uid !== BigInt(principal.uid)) || stat.size > 256n * 1024n * 1024n) fail("executable_custody_unsafe");
    const digest = createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
    if (!same(stat, fs.lstatSync(value, { bigint: true }))) fail("executable_custody_changed");
    return digest;
  } finally { fs.closeSync(fd); }
}
function factory(ports: Ports) {
  async function install(input: DarwinThoughtsInstallInput, signal?: AbortSignal): Promise<DarwinThoughtsInstallResult> {
    const alive = () => {
      if (signal?.aborted) fail("installation_cancelled");
      if (ports.now() >= input.deadlineMs) fail("installation_deadline_expired");
    };
    alive();
    const principal = ports.principal(); path(principal.home); path(input.dir);
    if (principal.platform !== "darwin" || !Number.isSafeInteger(principal.uid) || principal.uid <= 0 ||
        principal.euid !== principal.uid || !Number.isSafeInteger(principal.gid) ||
        !below(input.dir, principal.home)) fail("native_principal_authority_mismatch");
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= ports.now() ||
        input.deadlineMs - ports.now() > 30000) fail("deadline_invalid");
    image(input.supervisorImage); image(input.runnerImage);
    const state = join(dirname(input.dir), "darwin-thoughts-custody");
    const requestsRoot = join(dirname(input.dir), "darwin-thoughts-requests");
    const responsesRoot = join(dirname(input.dir), "darwin-thoughts-responses");
    const thoughtsRoot = join(input.dir, "thoughts"); const locksRoot = join(input.dir, "locks");
    const configPath = join(state, "producer.json"); const privateKeyFile = join(state, "private-key.der");
    const custody = new Custody(principal, ports);
    try {
      custody.walk(input.dir);
      for (const root of [thoughtsRoot, locksRoot]) custody.walk(root, true, 0o750);
      for (const root of [requestsRoot, responsesRoot]) custody.walk(root, true, 0o700, true);
      let existing = false;
      try { fs.lstatSync(state); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const executables = ports.executables();
      const roots = [thoughtsRoot, locksRoot, requestsRoot, responsesRoot];
      const nodeHash = executable(executables.nodeExecutable, principal, roots);
      const dockerHash = executable(executables.dockerExecutable, principal, roots);
      let authority: Authority | undefined;
      let enrolledSupervisorImage: string | undefined;
      if (existing) {
        custody.walk(state, false, 0o700, true);
        const runtime = record(parse(custody.read(join(state, "runtime.json"), 4096)),
          ["version", "nodeExecutable", "nodeExecutableSha256"]);
        if (runtime.version !== 1 || runtime.nodeExecutable !== executables.nodeExecutable ||
            runtime.nodeExecutableSha256 !== nodeHash) fail("runtime_custody_mismatch");
        const row = record(parse(custody.read(configPath, 16384)),
          ["version", "authority", "privateKeyFile", "supervisorImage", "dockerExecutable", "dockerExecutableSha256"]);
        authority = parseDarwinThoughtsAuthority(row.authority);
        if (row.version !== 1 || authority.nativeUid !== principal.uid || authority.nativeGid !== principal.gid ||
            authority.nativeHome !== principal.home || authority.thoughtsRoot !== thoughtsRoot ||
            authority.locksRoot !== locksRoot || authority.requestsRoot !== requestsRoot ||
            authority.responsesRoot !== responsesRoot || row.privateKeyFile !== privateKeyFile ||
            row.dockerExecutable !== executables.dockerExecutable ||
            row.dockerExecutableSha256 !== dockerHash) fail("existing_authority_mismatch");
        if (typeof row.supervisorImage !== "string") fail("existing_authority_mismatch");
        image(row.supervisorImage);
        if (row.supervisorImage.split("@sha256:")[0] !== input.supervisorImage.split("@sha256:")[0])
          fail("existing_authority_mismatch");
        let key;
        try { key = createPrivateKey({ key: custody.read(privateKeyFile, 4096), type: "pkcs8", format: "der" }); }
        catch { return fail("private_key_custody_invalid"); }
        if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") !== authority.publicKey) fail("private_key_authority_mismatch");
        // The recorded helper image only authenticates the existing state. When it is not the
        // current pin, the producer is re-attested on the current pin below, before the proof.
        enrolledSupervisorImage = row.supervisorImage;
      }
      custody.recheck();
      alive();
      const engine = await ports.engineIdentity({ ...executables, principal,
        supervisorImage: input.supervisorImage,
        runnerImage: input.runnerImage, deadlineMs: input.deadlineMs, signal });
      alive();
      if (!/^unix:\/\/\/[^,\0]+$/.test(engine.endpoint) || normalize(engine.endpoint.slice(7)) !== engine.endpoint.slice(7) ||
          !engine.cachedSupervisor || !engine.cachedRunner || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(engine.daemonId)) fail("engine_endpoint_or_cache_invalid");
      if (engine.runnerCustodyVersion !== "v1") fail("runner_custody_label_unqualified");
      if (authority && (authority.endpoint !== engine.endpoint || authority.daemonId !== engine.daemonId)) fail("engine_authority_mismatch");
      custody.recheck();
      if (!authority) {
        custody.walk(state, true, 0o700, true);
        custody.create(join(state, "runtime.json"), Buffer.from(canonicalDarwinThoughtsJson({
          version: 1, nodeExecutable: executables.nodeExecutable, nodeExecutableSha256: nodeHash,
        })));
        const key = generateKeyPairSync("ed25519");
        authority = parseDarwinThoughtsAuthority({
          version: 1, installationId: randomBytes(32).toString("hex"),
          publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
          nativeUid: principal.uid, nativeGid: principal.gid, nativeHome: principal.home,
          endpoint: engine.endpoint, daemonId: engine.daemonId, thoughtsRoot, locksRoot, requestsRoot, responsesRoot,
        });
        custody.create(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "der" }));
        custody.create(configPath, Buffer.from(canonicalDarwinThoughtsJson({
          version: 1, authority, privateKeyFile, supervisorImage: input.supervisorImage,
          dockerExecutable: executables.dockerExecutable, dockerExecutableSha256: dockerHash,
        })));
      } else if (enrolledSupervisorImage !== input.supervisorImage) {
        // Re-attest the enrolled producer on the current pinned helper, exactly as first
        // enrollment records it before proving it: same authority, key and executable pins,
        // same repository, cache-only, and the signed bootstrap below runs on the new pin.
        custody.replace(configPath, Buffer.from(canonicalDarwinThoughtsJson({
          version: 1, authority, privateKeyFile, supervisorImage: input.supervisorImage,
          dockerExecutable: executables.dockerExecutable, dockerExecutableSha256: dockerHash,
        })));
      }
      const artifacts = ports.artifacts();
      for (const [name, bytes] of [["producer.mjs", artifacts.producer], ["watchdog.mjs", artifacts.watchdog],
        ["watchdog-deadline.mjs", artifacts.deadline]] as const) {
        const file = join(state, name);
        if (existing) { if (!custody.read(file, 1048576).equals(bytes)) fail("artifact_custody_mismatch"); }
        else custody.create(file, bytes);
      }
      // The helper mounts its verifier from custody state, never from the package: an npm prefix
      // such as /opt/homebrew or /usr/local is outside Docker Desktop's default file sharing.
      // State written before this copy existed receives it once, under the same custody.
      const verifierPath = join(state, "verifier.mjs");
      let verifierPresent = existing;
      if (existing) try { fs.lstatSync(verifierPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("state_custody_unsafe");
        verifierPresent = false;
      }
      if (verifierPresent) { if (!custody.read(verifierPath, 1048576).equals(artifacts.verifier)) fail("artifact_custody_mismatch"); }
      else custody.create(verifierPath, artifacts.verifier);
      const agentDirectory = join(principal.home, "Library", "LaunchAgents");
      custody.walk(agentDirectory, true, 0o700, false, true);
      const plistPath = join(agentDirectory, LABEL + ".plist");
      let template = artifacts.serviceTemplate;
      for (const [key, value] of Object.entries({
        NODE_EXECUTABLE: executables.nodeExecutable, WATCHDOG_FILE: join(state, "watchdog.mjs"),
        PRODUCER_FILE: join(state, "producer.mjs"), CONFIG_FILE: configPath,
      })) template = template.replaceAll("@@" + key + "@@", xml(value));
      if (template.includes("@@")) fail("service_template_invalid");
      if (existing) { if (!custody.read(plistPath).equals(Buffer.from(template))) fail("service_custody_mismatch"); }
      else custody.create(plistPath, Buffer.from(template));
      custody.recheck();
      alive();
      await ports.service({ ...executables, uid: principal.uid, serviceLabel: LABEL, plistPath, deadlineMs: input.deadlineMs, signal });
      alive();
      const receipt = await ports.receiveBootstrap({ ...executables, authority, configPath, verifierPath,
        supervisorImage: input.supervisorImage, deadlineMs: input.deadlineMs, signal });
      alive();
      if (ports.now() >= input.deadlineMs) fail("startup_proof_expired");
      // The canonical verifier compares these observations byte-for-byte with
      // signature-authenticated closed protocol identities before accepting.
      type Observation = Parameters<typeof verifyDarwinThoughtsCustodyResponse>[1]["engineCheckout"];
      verifyDarwinThoughtsCustodyResponse(receipt.bytes, { authority, request: parseDarwinThoughtsRequest(receipt.request),
        nowMs: ports.now(), engineCheckout: receipt.engineCheckout as Observation, engineLock: receipt.engineLock as Observation,
        ...(receipt.engineGit ? { engineGit: receipt.engineGit as Observation } : {}) });
      custody.recheck();
      return { authority, envAuthority: canonicalDarwinThoughtsJson(authority), requestsRoot,
        responsesRoot, configPath, serviceLabel: LABEL };
    } finally { custody.close(); }
  }
  return { install };
}
/** Internal test seam; normal callers cannot supply principal, executable or daemon overrides. */
export const createDarwinThoughtsInstallerTestHarness = factory;
function actualPrincipal(): Principal {
  if (process.platform !== "darwin" || !process.getuid || !process.geteuid || !process.getgid) fail("native_principal_unavailable");
  return { platform: process.platform, uid: process.getuid(), euid: process.geteuid(),
    gid: process.getgid(), home: fs.realpathSync(userInfo().homedir) };
}
function actualExecutables(): Executables {
  const nodeExecutable = fs.realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = fs.realpathSync(join(directory, "docker"));
      if (fs.statSync(candidate).isFile()) return { nodeExecutable, dockerExecutable: candidate };
    } catch { /* Continue to the next actual PATH directory. */ }
  }
  return fail("docker_executable_unavailable");
}
interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string; }
async function command(executable: string, args: string[], deadlineMs: number, maxBuffer = 16384, signal?: AbortSignal): Promise<CommandResult> {
  const budget = deadlineMs - Date.now();
  if (budget <= 0) fail("command_deadline_expired");
  if (signal?.aborted) return { code: 1, stdout: "", stderr: "command_cancelled" };
  const started = performance.now();
  return new Promise(resolve => {
    let child: ReturnType<typeof execFile> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stopping = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      // Kill only the child returned by this invocation. A missing close/callback
      // cannot prevent an independent bounded refusal of this command receipt.
      try { child?.kill("SIGKILL"); } catch { /* The bounded refusal still applies. */ }
      if (!settled) fallbackTimer = setTimeout(() => finish({
        code: 1, stdout: "", stderr: "command_receipt_unreceived",
      }), 250);
    };
    try {
      child = execFile(executable, args, { cwd: "/",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: budget,
        killSignal: "SIGKILL", maxBuffer, encoding: "utf8", signal,
      }, (error, stdout, stderr) => {
        const refused = stopping || signal?.aborted || performance.now() - started >= budget;
        finish({ code: error || refused ? 1 : 0,
          stdout: refused ? "" : stdout.trim(), stderr: refused ? "command_receipt_unreceived" : stderr.trim() });
      });
    } catch {
      finish({ code: 1, stdout: "", stderr: "command_start_unreceived" });
    }
    if (!settled) {
      deadlineTimer = setTimeout(stop, Math.max(0, budget - (performance.now() - started)));
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    }
  });
}
/** Internal receipt seam for controlled child-process fixtures; no production override. */
export const receiveDarwinThoughtsCommandForTest = command;
async function actualEngine(input: EngineInput): Promise<EngineIdentity> {
  const config = join(input.principal.home, ".docker");
  const host = process.env.DOCKER_HOST;
  const context = process.env.DOCKER_CONTEXT;
  if (host !== undefined && context !== undefined) fail("engine_selector_conflict");
  if (context !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context))
    fail("engine_context_selector_invalid");
  let selected = host;
  if (selected === undefined) {
    const received = await command(input.dockerExecutable, ["--config", config,
      "context", "inspect", ...(context === undefined ? [] : [context]),
      "--format", "{{.Endpoints.docker.Host}}"], input.deadlineMs, 16384, input.signal);
    if (received.code !== 0) fail("engine_context_unreceived");
    selected = received.stdout;
  }
  if (!/^unix:\/\/\/[^,\0]+$/.test(selected) ||
      normalize(selected.slice(7)) !== selected.slice(7)) fail("engine_endpoint_invalid");
  const run = (args: string[]) => command(input.dockerExecutable,
    ["--config", config, "--host", selected, ...args], input.deadlineMs, 16384, input.signal);
  const daemon = await run(["info", "--format", "{{.ID}}"]);
  const supervisor = await run(["image", "inspect", "--format", "{{.Id}}", input.supervisorImage]);
  const runner = await run(["image", "inspect", "--format", "{{json .}}", input.runnerImage]);
  if (daemon.code !== 0) fail("engine_identity_unavailable");
  let runnerId: string | undefined;
  let runnerCustodyVersion: string | undefined;
  if (runner.code === 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(runner.stdout); } catch { fail("runner_cache_metadata_unreceived"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("runner_cache_metadata_unreceived");
    const row = parsed as Record<string, unknown>;
    if (typeof row.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.Id) ||
        !row.Config || typeof row.Config !== "object" || Array.isArray(row.Config)) fail("runner_cache_metadata_unreceived");
    runnerId = row.Id;
    const labels = (row.Config as Record<string, unknown>).Labels;
    if (labels !== null && labels !== undefined &&
        (typeof labels !== "object" || Array.isArray(labels))) fail("runner_cache_metadata_unreceived");
    if (labels && Object.hasOwn(labels, LABEL)) {
      const version = (labels as Record<string, unknown>)[LABEL];
      if (typeof version !== "string") fail("runner_cache_metadata_unreceived");
      runnerCustodyVersion = version;
    }
  }
  return { endpoint: selected, daemonId: daemon.stdout,
    cachedSupervisor: supervisor.code === 0 && /^sha256:[a-f0-9]{64}$/.test(supervisor.stdout),
    cachedRunner: runnerId !== undefined,
    ...(runnerCustodyVersion === undefined ? {} : { runnerCustodyVersion }) };
}
function actualArtifacts(): Artifacts {
  const manifest = JSON.parse(fs.readFileSync(join(vendor, "manifest.json"), "utf8"));
  const read = (name: string, expected: string) => {
    const bytes = fs.readFileSync(join(vendor, name));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) fail("vendored_artifact_invalid");
    return bytes;
  };
  const sourceHash = (name: string) => manifest.inputs["deploy/self-host/darwin-thoughts-custody/" + name];
  return { producer: read("producer.mjs", manifest.artifactSha256),
    verifier: read("verifier.mjs", manifest.verifierSha256),
    watchdog: read("watchdog.mjs", sourceHash("watchdog.mjs")),
    deadline: read("watchdog-deadline.mjs", sourceHash("watchdog-deadline.mjs")),
    serviceTemplate: read("service.plist.in", sourceHash("service.plist.in")).toString("utf8") };
}
async function actualService(input: ServiceInput) {
  const target = "user/" + input.uid + "/" + input.serviceLabel;
  const loaded = await command("/bin/launchctl", ["print", target], input.deadlineMs, 16384, input.signal);
  if (loaded.code !== 0) {
    const boot = await command("/bin/launchctl", ["bootstrap", "user/" + input.uid, input.plistPath], input.deadlineMs, 16384, input.signal);
    if (boot.code !== 0) fail("background_service_bootstrap_refused");
  }
  const start = await command("/bin/launchctl", ["kickstart", target], input.deadlineMs, 16384, input.signal);
  if (start.code !== 0 || (await command("/bin/launchctl", ["print", target], input.deadlineMs, 16384, input.signal)).code !== 0) fail("background_service_receiving_refused");
}
async function actualBootstrap(input: BootstrapInput): Promise<BootstrapReceipt> {
  const authority = input.authority;
  const name = "catalyst-custody-bootstrap-" + randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const config = join(dirname(input.configPath), ".bootstrap-docker");
  try { fs.mkdirSync(config, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !fs.lstatSync(config).isDirectory() || fs.lstatSync(config).isSymbolicLink() ||
        fs.lstatSync(config).uid !== authority.nativeUid || fs.lstatSync(config).gid !== authority.nativeGid ||
        (fs.lstatSync(config).mode & 0o7777) !== 0o700 || fs.readdirSync(config).length !== 0) fail("bootstrap_docker_config_unsafe");
  }
  const executableStat = fs.lstatSync(input.dockerExecutable, { bigint: true });
  const installed = JSON.parse(fs.readFileSync(input.configPath, "utf8")) as Record<string, unknown>;
  const digest = executable(input.dockerExecutable, { platform: "darwin", uid: authority.nativeUid,
    euid: authority.nativeUid, gid: authority.nativeGid, home: authority.nativeHome },
    [authority.thoughtsRoot, authority.locksRoot, authority.requestsRoot, authority.responsesRoot]);
  if (installed.dockerExecutable !== input.dockerExecutable || installed.dockerExecutableSha256 !== digest)
    fail("bootstrap_executable_unreceived");
  const verifierSha256 = (JSON.parse(fs.readFileSync(join(vendor, "manifest.json"), "utf8")) as { verifierSha256?: unknown }).verifierSha256;
  if (dirname(input.verifierPath) !== dirname(input.configPath)) fail("bootstrap_verifier_unreceived");
  let verifierFd: number;
  try { verifierFd = fs.openSync(input.verifierPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch { return fail("bootstrap_verifier_unreceived"); }
  try {
    const stat = fs.fstatSync(verifierFd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n ||
        (stat.uid !== 0n && stat.uid !== BigInt(authority.nativeUid)) ||
        createHash("sha256").update(fs.readFileSync(verifierFd)).digest("hex") !== verifierSha256)
      fail("bootstrap_verifier_unreceived");
  } finally { fs.closeSync(verifierFd); }
  const docker = (args: string[], deadlineMs = input.deadlineMs, signal: AbortSignal | null = input.signal ?? null) => {
    if (!same(executableStat, fs.lstatSync(input.dockerExecutable, { bigint: true })))
      fail("bootstrap_executable_changed");
    return command(input.dockerExecutable, ["--config", config, "--host", authority.endpoint, ...args],
      deadlineMs, args[0] === "start" ? 32768 : 16384, signal ?? undefined);
  };
  let id: string | undefined;
  let cachedImage: string | undefined;
  let createAttempted = false;
  let createRefused = false;
  const receiveIdentity = (received: CommandResult, acknowledgedId?: string) => {
    if (received.code !== 0) fail("bootstrap_cleanup_unproved");
    let parsed: unknown;
    try { parsed = JSON.parse(received.stdout); } catch { return fail("bootstrap_cleanup_unproved"); }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] ||
        typeof parsed[0] !== "object" || Array.isArray(parsed[0])) fail("bootstrap_cleanup_unproved");
    const row = parsed[0] as Record<string, unknown>;
    if (!row.Config || typeof row.Config !== "object" || Array.isArray(row.Config)) fail("bootstrap_cleanup_unproved");
    const receivedConfig = row.Config as Record<string, unknown>;
    if (!receivedConfig.Labels || typeof receivedConfig.Labels !== "object" || Array.isArray(receivedConfig.Labels)) fail("bootstrap_cleanup_unproved");
    const labels = receivedConfig.Labels as Record<string, unknown>;
    if (typeof row.Id !== "string" || !/^[a-f0-9]{64}$/.test(row.Id) ||
        (acknowledgedId !== undefined && row.Id !== acknowledgedId) || row.Name !== "/" + name ||
        row.Image !== cachedImage || receivedConfig.Image !== input.supervisorImage ||
        labels["dev.catalystcloud.custody-token"] !== token) fail("bootstrap_cleanup_unproved");
    return row.Id;
  };
  const program = [
    'const fs=require("node:fs"),v=await import("/custody-verifier.mjs"),a=JSON.parse(process.argv[1]);',
    'const tenant="custody-bootstrap",repository="catalyst/custody-probe",t=v.deriveDarwinThoughtsTargets(a.authority,tenant,repository);',
    'let gitPath;try{fs.lstatSync(t.checkoutSource+"/.git");gitPath=t.checkoutSource+"/.git";}catch(e){if(e.code!=="ENOENT")throw e;}',
    'let received;',
    'const proof=await v.requestFreshDarwinThoughtsBootstrap({authority:a.authority,tenant,repository,requestDir:a.authority.requestsRoot,responseDir:a.authority.responsesRoot,checkoutPath:t.checkoutSource,lockPath:t.lockSource,...(gitPath?{gitPath}:{}),deadlineMs:a.deadlineMs,onProof:(receipt)=>{received=receipt.bytes.toString("base64");}});',
    'const identity=(path)=>{const s=fs.lstatSync(path,{bigint:true});return {path,device:String(s.dev),inode:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&4095n),isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()};};',
    'if(!received)throw Error("signed_receipt_unavailable");',
    'console.log(v.canonicalDarwinThoughtsJson({bytes:received,request:proof.request,engineCheckout:identity(t.checkoutSource),engineLock:identity(t.lockSource),...(gitPath?{engineGit:identity(gitPath)}:{})}));',
  ].join("\n");
  let result: { value: BootstrapReceipt } | { error: unknown };
  try {
    const daemon = await docker(["info", "--format", "{{.ID}}"]);
    const image = await docker(["image", "inspect", "--format", "{{.Id}}", input.supervisorImage]);
    if (daemon.code !== 0 || daemon.stdout !== authority.daemonId || image.code !== 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(image.stdout)) fail("bootstrap_engine_unreceived");
    cachedImage = image.stdout;
    // Keep the random name and label before awaiting create: an absent or invalid CLI ACK
    // cannot establish that the selected daemon did not persist the helper.
    createAttempted = true;
    const created = await docker(["create", "--pull=never", "--name", name,
      "--label", "dev.catalystcloud.custody-token=" + token, "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001",
      "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32", "--workdir", "/",
      ...[authority.thoughtsRoot, authority.locksRoot, authority.requestsRoot, authority.responsesRoot]
        .flatMap(root => ["--mount", "type=bind,src=" + root + ",dst=" + root +
          (root === authority.responsesRoot ? ",readonly" : "")]),
      "--mount", "type=bind,src=" + input.verifierPath + ",dst=/custody-verifier.mjs,readonly",
      "--entrypoint", "/usr/bin/timeout", input.supervisorImage, "--signal=KILL",
      Math.max(1, Math.ceil((input.deadlineMs - Date.now()) / 1000)) + "s", "/usr/bin/env", "-i",
      "PATH=/usr/bin:/bin", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "/usr/local/bin/bun", "--config=/dev/null", "--no-env-file", "--cwd=/",
      "-e", program, canonicalDarwinThoughtsJson({ authority, deadlineMs: input.deadlineMs })]);
    const refusal = created.code !== 0 ? createRefusal(created.stderr) : undefined;
    if (refusal !== undefined) {
      // The daemon answered with a refusal. Keep it as a closed code; cleanup still has to
      // prove nothing persisted before that refusal may reach the person.
      createRefused = true;
      fail(refusal);
    }
    if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(created.stdout)) fail("bootstrap_create_unreceived");
    id = created.stdout;
    const beforeStartDaemon = await docker(["info", "--format", "{{.ID}}"]);
    const beforeStartImage = await docker(["image", "inspect", "--format", "{{.Id}}", input.supervisorImage]);
    if (beforeStartDaemon.code !== 0 || beforeStartDaemon.stdout !== authority.daemonId ||
        beforeStartImage.code !== 0 || beforeStartImage.stdout !== cachedImage) fail("bootstrap_cleanup_unproved");
    id = receiveIdentity(await docker(["inspect", name]), id);
    const started = await docker(["start", "--attach", id]);
    if (started.code !== 0) {
      const reported = /darwin_thoughts_custody:([a-z_]+)(?![a-z_])/.exec(started.stderr)?.[1];
      fail("bootstrap_proof_refused" + (reported && VERIFIER_REFUSALS.has(reported) ? ":" + reported : ""));
    }
    const value = JSON.parse(started.stdout) as { bytes?: string; request?: unknown; engineCheckout?: unknown; engineLock?: unknown; engineGit?: unknown };
    if (typeof value.bytes !== "string" || value.bytes.length > 21848 ||
        Buffer.from(value.bytes, "base64").toString("base64") !== value.bytes) fail("bootstrap_signed_receipt_unavailable");
    result = { value: { bytes: Buffer.from(value.bytes, "base64"), request: value.request,
      engineCheckout: value.engineCheckout, engineLock: value.engineLock,
      ...(value.engineGit ? { engineGit: value.engineGit } : {}) } };
  } catch (error) { result = { error }; }
  if (createAttempted) {
    // Cleanup has one independent monotonic budget and ignores caller cancellation. Every
    // recovery and deletion remains scoped to the received executable, daemon and cached image.
    const cleanupStarted = performance.now();
    const cleanupDocker = (args: string[]) => {
      const remaining = 2000 - (performance.now() - cleanupStarted);
      if (remaining <= 0) fail("bootstrap_cleanup_unproved");
      // Pass no caller signal; cancellation of admission cannot cancel disposal of our helper.
      return docker(args, Date.now() + Math.ceil(remaining), null);
    };
    // Set only when a refused create is proved to have persisted nothing; the refusal then stands.
    let refusedAbsent = false;
    try {
      const daemon = await cleanupDocker(["info", "--format", "{{.ID}}"]);
      const image = await cleanupDocker(["image", "inspect", "--format", "{{.Id}}", input.supervisorImage]);
      if (daemon.code !== 0 || daemon.stdout !== authority.daemonId || image.code !== 0 ||
          image.stdout !== cachedImage) fail("bootstrap_cleanup_unproved");
      let received: CommandResult | undefined;
      if (createRefused && id === undefined) {
        // A refused create persists nothing; prove that by our random token label, and only
        // fall back to recovering the exact helper when the Engine lists one anyway.
        const persisted = await cleanupDocker(["ps", "--all", "--no-trunc", "--quiet",
          "--filter", "label=dev.catalystcloud.custody-token=" + token]);
        if (persisted.code !== 0) fail("bootstrap_cleanup_unproved");
        refusedAbsent = persisted.stdout === "";
      }
      for (let attempt = 0; !refusedAbsent && attempt < 32; attempt++) {
        const current = await cleanupDocker(["inspect", name]);
        if (current.code === 0) { received = current; break; }
        if (id !== undefined || performance.now() - cleanupStarted >= 1900) fail("bootstrap_cleanup_unproved");
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      if (!refusedAbsent) {
        if (received === undefined) fail("bootstrap_cleanup_unproved");
        id = receiveIdentity(received, id);
        const list = ["ps", "--all", "--no-trunc", "--quiet", "--filter", "id=" + id];
        const present = await cleanupDocker(list);
        if (present.code !== 0 || present.stdout !== id) fail("bootstrap_cleanup_unproved");
        const removed = await cleanupDocker(["rm", "--force", id]);
        if (removed.code !== 0) fail("bootstrap_cleanup_unproved");
        const absent = await cleanupDocker(list);
        if (absent.code !== 0 || absent.stdout !== "") fail("bootstrap_cleanup_unproved");
      }
    } catch { fail("bootstrap_cleanup_unproved"); }
  }
  if ("error" in result) throw result.error;
  return result.value;
}
/** Internal test seam for the production bootstrap transport, without command overrides. */
export const receiveDarwinThoughtsBootstrapForTest = actualBootstrap;
/** Closed production installer; no principal, key, runtime or Engine override. */
function validateInstallLayout(home: string, dir: string) {
  path(home); path(dir);
  if (dir !== join(home, ".local", "state", "catalyst", "runner")) fail("native_workspace_layout_unqualified");
}
/** Pure internal fixture seam; production always supplies the actual OS home. */
export const validateDarwinThoughtsInstallLayoutForTest = validateInstallLayout;
/** Actual command path for fixed executable fixtures, never an installation override. */
export const inspectDarwinThoughtsEngineForTest = actualEngine;
export function installDarwinThoughtsCustody(input: DarwinThoughtsInstallInput, signal?: AbortSignal) {
  if (signal?.aborted) fail("installation_cancelled");
  validateInstallLayout(actualPrincipal().home, input.dir);
  return factory({ principal: actualPrincipal, now: Date.now, stat: (_path, stat) => stat,
    executables: actualExecutables, artifacts: actualArtifacts, engineIdentity: actualEngine,
    service: actualService, receiveBootstrap: actualBootstrap }).install(input, signal);
}
