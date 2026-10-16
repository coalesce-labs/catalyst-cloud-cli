import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packageRoot } from "./config.js";

// CTC-5929: a supervisor in a Docker VM cannot measure the Mac's disk, so it refuses all work
// (`host_disk_unmeasured: physical_host_disk_sample_required`) until a native publisher writes a
// fresh sample into the read-only `host-disk` bind. Setup installs catalyst-cloud's own publisher
// (vendor/self-host, byte for byte) as a LaunchAgent, and names a zero-slot disk reason instead of
// leaving it in the supervisor log. The admission rule itself stays the supervisor's.

export const HOST_DISK_LABEL = "dev.catalystcloud.host-disk";
/** The sample path inside the supervisor; compose binds the runner's `host-disk` directory here. */
export const HOST_DISK_MOUNT = "/var/lib/catalyst/host-disk";
export const HOST_DISK_SAMPLE_FILE = `${HOST_DISK_MOUNT}/space.json`;
/** catalyst-cloud apps/host-agent/src/supervisor/disk/host-space.ts and the compose default. */
const SAMPLE_MAX_AGE_MS = 30_000;
const SAMPLE_FUTURE_MS = 5_000;
const MAX_SAMPLE_BYTES = 4_096;
export const DEFAULT_HOST_FREE_FLOOR_GIB = 25;
const GIB = 1024 ** 3;

export type RunnerDiskUnmeasured =
  | "physical_host_disk_sample_required"
  | "host_disk_sample_missing"
  | "host_disk_sample_stale"
  | "host_disk_sample_invalid"
  | "host_disk_unreadable";
export type RunnerDiskVerdict =
  | { state: "measured"; availableGiB: number; floorGiB: number }
  | { state: "below_floor"; availableGiB: number; floorGiB: number }
  | { state: "unmeasured"; detail: RunnerDiskUnmeasured; floorGiB: number };

const gib = (bytes: number) => Math.floor((bytes / GIB) * 100) / 100;

function floorGiB(saved: Record<string, string> | null): number {
  const value = Number(saved?.CATALYST_HOST_FREE_FLOOR_GIB?.trim() || DEFAULT_HOST_FREE_FLOOR_GIB);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HOST_FREE_FLOOR_GIB;
}

/** The supervisor's sample rules: schema 1, at most 30 seconds old, never ahead of the clock. */
export function hostDiskSampleBytes(text: string, nowMs: number): number | Exclude<RunnerDiskUnmeasured, "physical_host_disk_sample_required" | "host_disk_sample_missing" | "host_disk_unreadable"> {
  let sample: Record<string, unknown>;
  try {
    if (Buffer.byteLength(text) > MAX_SAMPLE_BYTES) return "host_disk_sample_invalid";
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "host_disk_sample_invalid";
    sample = value as Record<string, unknown>;
  } catch {
    return "host_disk_sample_invalid";
  }
  const { observedAtMs, availableBytes, totalBytes, path } = sample;
  if (sample.schemaVersion !== 1 || typeof path !== "string" || !path.startsWith("/") ||
    !Number.isSafeInteger(observedAtMs) || (observedAtMs as number) <= 0 ||
    !Number.isSafeInteger(availableBytes) || (availableBytes as number) < 0 ||
    !Number.isSafeInteger(totalBytes) || (totalBytes as number) <= 0 ||
    (availableBytes as number) > (totalBytes as number)) return "host_disk_sample_invalid";
  if (nowMs - (observedAtMs as number) > SAMPLE_MAX_AGE_MS || (observedAtMs as number) > nowMs + SAMPLE_FUTURE_MS)
    return "host_disk_sample_stale";
  return availableBytes as number;
}

/** Where the supervisor's sample file lives on this machine, or null when it is not in the bind. */
export function hostDiskSamplePath(dir: string, saved: Record<string, string> | null): string | null {
  const file = saved?.CATALYST_HOST_DISK_SAMPLE_FILE?.trim();
  if (!file || !file.startsWith(`${HOST_DISK_MOUNT}/`) || file.split("/").some(part => part === "..")) return null;
  const source = saved?.CATALYST_HOST_DISK_SAMPLE_DIR?.trim() || "./host-disk";
  return join(isAbsolute(source) ? source : resolve(dir, source), file.slice(HOST_DISK_MOUNT.length + 1));
}

export interface RunnerDiskInput {
  dir: string;
  saved: Record<string, string> | null;
  /** The Linux engine runs in a VM, so only a native sample measures the physical disk. */
  vm: boolean;
  nowMs: number;
  readSample?: (path: string) => string;
  /** Native Linux: free bytes on the filesystem holding the supervisor's state volume. */
  nativeAvailableBytes?: () => number | null;
}

/** The same verdict the supervisor reaches, read from this machine. Never an admission decision. */
export function runnerDiskVerdict(input: RunnerDiskInput): RunnerDiskVerdict {
  const floor = floorGiB(input.saved);
  const unmeasured = (detail: RunnerDiskUnmeasured): RunnerDiskVerdict => ({ state: "unmeasured", detail, floorGiB: floor });
  let bytes: number | null;
  if (input.saved?.CATALYST_HOST_DISK_SAMPLE_FILE?.trim()) {
    const path = hostDiskSamplePath(input.dir, input.saved);
    if (!path) return unmeasured("host_disk_unreadable");
    let text: string;
    try {
      text = (input.readSample ?? ((file: string) => readFileSync(file, "utf8")))(path);
    } catch {
      return unmeasured("host_disk_sample_missing");
    }
    const read = hostDiskSampleBytes(text, input.nowMs);
    if (typeof read === "string") return unmeasured(read);
    bytes = read;
  } else if (input.vm) {
    return unmeasured("physical_host_disk_sample_required");
  } else {
    try {
      bytes = input.nativeAvailableBytes?.() ?? null;
    } catch {
      bytes = null;
    }
    if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return unmeasured("host_disk_unreadable");
  }
  return { state: bytes >= floor * GIB ? "measured" : "below_floor", availableGiB: gib(bytes), floorGiB: floor };
}

/** Docker's data root, where the supervisor's named state volume lives on native Linux. */
export function dockerRootAvailableBytes(env: NodeJS.ProcessEnv): number | null {
  const read = spawnSync("docker", ["info", "--format", "{{.DockerRootDir}}"], { encoding: "utf8", timeout: 10_000, env });
  const root = read.status === 0 ? read.stdout.trim() : "";
  if (!isAbsolute(root)) return null;
  const space = statfsSync(root);
  return space.bavail * space.bsize;
}

export type SamplerRun = (cmd: string, args: string[], timeoutMs: number) => { status: number; stdout: string; stderr: string };
const defaultRun: SamplerRun = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
};

export interface HostDiskSamplerDeps {
  home: string;
  uid: number;
  now(): number;
  /** The active Docker endpoint (`unix:///…`), from the selected context or DOCKER_HOST. */
  dockerHost: string | null;
  /** CATALYST_HOST_DISK_PATH: the operator names the filesystem backing the engine's disk. */
  explicitPath?: string;
  run?: SamplerRun;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readText?: (path: string) => string;
  /** Blocks while setup waits for the agent's own samples. */
  sleep?: (ms: number) => void;
}
export type HostDiskSamplerStatus =
  | "installed"
  | "missing"
  | "runner_host_disk_sampler_python_missing"
  | "runner_host_disk_location_unverified"
  | "runner_host_disk_sampler_conflict";
export type HostDiskSamplerResult =
  | "ready"
  | "runner_host_disk_sampler_python_missing"
  | "runner_host_disk_location_unverified"
  | "runner_host_disk_sampler_conflict"
  | "runner_host_disk_sampler_failed"
  | "runner_host_disk_sampler_not_repeating";

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** Docker Desktop's disk image folder: the relocated one from its settings, else the default. */
function desktopData(deps: HostDiskSamplerDeps, exists: (path: string) => boolean): string | null {
  const read = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  for (const name of ["settings-store.json", "settings.json"]) {
    let settings: Record<string, unknown>;
    try { settings = JSON.parse(read(join(deps.home, "Library/Group Containers/group.com.docker", name))); }
    catch { continue; }
    const folder = settings.DataFolder ?? settings.dataFolder;
    if (folder !== undefined) return typeof folder === "string" && isAbsolute(folder) && exists(folder) ? folder : null;
  }
  const fallback = join(deps.home, "Library/Containers/com.docker.docker/Data/vms/0/data");
  return exists(fallback) ? fallback : null;
}

/** The filesystem backing the ACTIVE engine's VM disk, from its socket; null when it cannot be
 * verified, so setup asks for CATALYST_HOST_DISK_PATH instead of measuring the wrong disk. */
export function engineDiskPath(deps: HostDiskSamplerDeps): string | null {
  const exists = deps.exists ?? existsSync;
  if (deps.explicitPath !== undefined && deps.explicitPath.trim() !== "")
    return isAbsolute(deps.explicitPath) && exists(deps.explicitPath) ? deps.explicitPath : null;
  if (!deps.dockerHost?.startsWith("unix://")) return null;
  let socket: string;
  try { socket = (deps.realpath ?? realpathSync)(deps.dockerHost.slice("unix://".length)); }
  catch { return null; }
  const home = deps.home;
  if (within(socket, join(home, ".docker")) || within(socket, join(home, "Library/Containers/com.docker.docker")))
    return desktopData(deps, exists);
  if (within(socket, join(home, ".orbstack"))) {
    const data = join(home, "Library/Group Containers/HUAQ24HBR6.dev.orbstack/data");
    return exists(data) ? data : null;
  }
  // Lima and Colima keep each instance's disk in the instance directory that holds its socket.
  const lima = /^(.*)\/sock\/docker\.sock$/.exec(socket)?.[1];
  if (lima && within(lima, join(home, ".lima")) && exists(lima)) return lima;
  const colima = /^(.*)\/docker\.sock$/.exec(socket)?.[1];
  if (colima && within(colima, join(home, ".colima"))) {
    const instance = join(home, ".colima", "_lima", `colima${colima.endsWith(`${sep}default`) ? "" : `-${colima.split(sep).at(-1)}`}`);
    return exists(instance) ? instance : null;
  }
  return null;
}

/** A stable interpreter. /usr/bin/python3 is a stub that opens an install dialog until the
 * Command Line Tools exist, so it is used only after xcode-select confirms them. */
function python(run: SamplerRun, exists: (path: string) => boolean): string | null {
  if (exists("/usr/bin/python3") && run("/usr/bin/xcode-select", ["-p"], 5_000).status === 0) return "/usr/bin/python3";
  return ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find(exists) ?? null;
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Plan {
  script: string;
  plist: string;
  output: string;
  scriptBytes: Buffer;
  plistText: string;
  /** The agent's command, unescaped: the template's ProgramArguments with the values filled in. */
  command: string[];
  /** Seconds between the agent's samples: the template's `--interval`. */
  interval: number;
}

function plan(dir: string, deps: HostDiskSamplerDeps): Plan | "runner_host_disk_sampler_python_missing" | "runner_host_disk_location_unverified" {
  const run = deps.run ?? defaultRun;
  const exists = deps.exists ?? existsSync;
  const measured = engineDiskPath(deps);
  if (!measured) return "runner_host_disk_location_unverified";
  const interpreter = python(run, exists);
  if (!interpreter) return "runner_host_disk_sampler_python_missing";
  const vendor = join(packageRoot(), "vendor", "self-host");
  const script = join(dir, "host-disk-sampler", "host-disk-sample.py");
  const output = join(dir, "host-disk", "space.json");
  const values: Record<string, string> = {
    __PYTHON__: interpreter, __SCRIPT__: script, __PATH__: measured, __OUTPUT__: output,
  };
  const template = readFileSync(join(vendor, "launchd", `${HOST_DISK_LABEL}.plist`), "utf8");
  const plistText = template.replace(/<string>(__[A-Z]+__)<\/string>/g, (whole, key: string) =>
    key in values ? `<string>${xml(values[key]!)}</string>` : whole);
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(template)?.[1] ?? "";
  const command = [...program.matchAll(/<string>([^<]*)<\/string>/g)].map(m => values[m[1]!] ?? m[1]!);
  const at = command.indexOf("--interval");
  return {
    script, output, plistText, command, interval: Number(command[at + 1]),
    plist: join(deps.home, "Library", "LaunchAgents", `${HOST_DISK_LABEL}.plist`),
    scriptBytes: readFileSync(join(vendor, "host-disk-sample.py")),
  };
}

const readOr = (path: string): Buffer | null => {
  try { return readFileSync(path); } catch { return null; }
};

/** A plist with this label that publishes somewhere else belongs to its operator. */
function foreign(existing: Buffer, output: string): boolean {
  const target = /<string>--output<\/string>\s*<string>([^<]*)<\/string>/.exec(existing.toString("utf8"))?.[1];
  return target !== xml(output);
}

/** Where a same-label agent this setup does not own publishes, as the two settings that would
 * point the runner at it: the bind directory and the in-container file name. */
export function foreignHostDiskSample(home: string): { sampleDir: string; sampleFile: string } | Record<string, never> {
  const text = readOr(join(home, "Library", "LaunchAgents", `${HOST_DISK_LABEL}.plist`))?.toString("utf8");
  const output = text && /<string>--output<\/string>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
    ?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  if (!output || !isAbsolute(output) || !/^[^\x00-\x1f'"]+$/.test(output)) return {};
  return { sampleDir: dirname(output), sampleFile: `${HOST_DISK_MOUNT}/${output.split("/").at(-1)}` };
}

/** The launchd domain holding the agent: gui when someone is logged in at the console, else user. */
function loadedIn(run: SamplerRun, uid: number): string | null {
  for (const domain of [`gui/${uid}`, `user/${uid}`])
    if (run("/bin/launchctl", ["print", `${domain}/${HOST_DISK_LABEL}`], 5_000).status === 0) return domain;
  return null;
}

function writeAtomic(path: string, bytes: Buffer | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function observedAt(output: string): number | null {
  try {
    const value: unknown = JSON.parse(readOr(output)?.toString("utf8") ?? "");
    const at = (value as Record<string, unknown> | null)?.observedAtMs;
    return Number.isSafeInteger(at) ? at as number : null;
  } catch {
    return null;
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The positive cadence check: the agent itself publishes two new samples, one interval apart.
 * Loaded is not running: launchd held every launch of an agent bootstrapped over SSH (CTC-5929). */
function repeats(p: Plan, deps: HostDiskSamplerDeps): boolean {
  const sleep = deps.sleep ?? sleepSync;
  const seen = new Set<number>();
  const before = observedAt(p.output);
  const deadline = deps.now() + (2 * p.interval + 5) * 1_000;
  while (deps.now() < deadline) {
    const at = observedAt(p.output);
    if (at !== null && at !== before && sampleFresh(p.output, deps.now())) seen.add(at);
    if (seen.size >= 2) return true;
    sleep(1_000);
  }
  return false;
}

function sampleFresh(output: string, nowMs: number): boolean {
  const text = readOr(output);
  return text !== null && typeof hostDiskSampleBytes(text.toString("utf8"), nowMs) === "number";
}

export function hostDiskSamplerStatus(dir: string, deps: HostDiskSamplerDeps): HostDiskSamplerStatus {
  const p = plan(dir, deps);
  if (typeof p === "string") return p;
  const plist = readOr(p.plist);
  if (plist && !plist.equals(Buffer.from(p.plistText)) && foreign(plist, p.output)) return "runner_host_disk_sampler_conflict";
  return plist?.equals(Buffer.from(p.plistText)) && readOr(p.script)?.equals(p.scriptBytes) &&
    loadedIn(deps.run ?? defaultRun, deps.uid) && sampleFresh(p.output, deps.now()) ? "installed" : "missing";
}

/** Installs or repairs the agent in place. Idempotent: an unchanged, loaded agent is left running.
 * A same-label agent publishing elsewhere is never replaced. */
export function installHostDiskSampler(dir: string, deps: HostDiskSamplerDeps): HostDiskSamplerResult {
  const run = deps.run ?? defaultRun;
  const p = plan(dir, deps);
  if (typeof p === "string") return p;
  const existing = readOr(p.plist);
  const plistChanged = !existing?.equals(Buffer.from(p.plistText));
  if (existing && plistChanged && foreign(existing, p.output)) return "runner_host_disk_sampler_conflict";
  try {
    if (!readOr(p.script)?.equals(p.scriptBytes)) writeAtomic(p.script, p.scriptBytes, 0o644);
    // One synchronous sample proves the interpreter and the measured path before launchd owns it.
    // Without --interval the script publishes once and exits; with it, it loops.
    const loop = p.command.indexOf("--interval");
    const oneShot = loop < 0 ? p.command : [...p.command.slice(0, loop), ...p.command.slice(loop + 2)];
    const once = run(oneShot[0]!, oneShot.slice(1), 15_000);
    if (once.status !== 0 || !sampleFresh(p.output, deps.now())) return "runner_host_disk_sampler_failed";
    if (plistChanged) writeAtomic(p.plist, p.plistText, 0o644);
    let domain = loadedIn(run, deps.uid);
    if (domain && plistChanged) {
      run("/bin/launchctl", ["bootout", `${domain}/${HOST_DISK_LABEL}`], 15_000);
      domain = null;
    }
    if (!domain) {
      const gui = run("/bin/launchctl", ["bootstrap", `gui/${deps.uid}`, p.plist], 15_000).status === 0;
      if (!gui && run("/bin/launchctl", ["bootstrap", `user/${deps.uid}`, p.plist], 15_000).status !== 0)
        return "runner_host_disk_sampler_failed";
    }
    domain = loadedIn(run, deps.uid);
    if (!domain) return "runner_host_disk_sampler_failed";
    // A demand start: launchd ran a kickstarted agent on mini-2 while it held RunAtLoad and the
    // timer. The script loops by itself once started, and a running agent is left as it is.
    run("/bin/launchctl", ["kickstart", `${domain}/${HOST_DISK_LABEL}`], 15_000);
    return repeats(p, deps) ? "ready" : "runner_host_disk_sampler_not_repeating";
  } catch {
    return "runner_host_disk_sampler_failed";
  }
}

export const isRunnerDiskUnmeasured = (value: string): value is RunnerDiskUnmeasured => value in UNMEASURED_WHY;

const UNMEASURED_WHY: Record<RunnerDiskUnmeasured, string> = {
  physical_host_disk_sample_required: "no disk sampler is set up for it",
  host_disk_sample_missing: "the disk sample file is missing",
  host_disk_sample_stale: "the last disk sample is more than 30 seconds old",
  host_disk_sample_invalid: "the disk sample cannot be read",
  host_disk_unreadable: "setup cannot read the disk it measures",
};

/** One wording for setup and `catalyst ready`: the reason for zero free slots, then the fix. */
export function runnerDiskCopy(verdict: Exclude<RunnerDiskVerdict, { state: "measured" }>, vm: boolean): { line: string; fix: string } {
  if (verdict.state === "below_floor")
    return {
      line: `The runner advertises zero free slots: ${verdict.availableGiB} GiB of disk is free and it needs ${verdict.floorGiB} GiB.`,
      fix: `Free at least ${Math.ceil(verdict.floorGiB - verdict.availableGiB)} GiB on ${vm ? "this Mac" : "the disk that holds Docker's data"}, for example with docker system prune. The runner takes work again by itself; run catalyst ready to confirm.`,
    };
  const line = `The runner advertises zero free slots: it has no fresh measurement of ${vm ? "this Mac's" : "this machine's"} disk, because ${UNMEASURED_WHY[verdict.detail]}.`;
  return vm
    ? { line, fix: `Run catalyst setup --runner. It installs and starts the ${HOST_DISK_LABEL} LaunchAgent, which measures the disk every 10 seconds. If it is already installed, run launchctl print gui/$(id -u)/${HOST_DISK_LABEL}, or user/$(id -u)/${HOST_DISK_LABEL} when no one is logged in at the console, to see why it stopped. If you publish your own sample with CATALYST_HOST_DISK_SAMPLE_DIR and CATALYST_HOST_DISK_SAMPLE_FILE, restart that publisher.` }
    : { line, fix: "Run docker compose -p catalyst-host logs supervisor and look for host_disk_admission_refused, then run catalyst ready." };
}
