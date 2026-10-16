import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { positionals, type ParsedArgs } from "./args.js";
import { loadConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { onboardStateRoot } from "./onboard.js";
import { dockerRunnerEngine, RUNNER_PROJECT, RUNNER_SESSION_NETWORK, type RunnerEnrollment, type RunnerExec } from "./onboard-runner.js";
import { EGRESS_ARTIFACTS, NATIVE_EGRESS_DIR } from "./onboard-runner-egress.js";
import { stdinIsTty } from "./prompt.js";
import { apiClient } from "./transport.js";

// `catalyst runner stop|start|status|uninstall`: the lifecycle of the self-hosted runner that
// `catalyst setup --runner` installed on this machine (CTC-5930). Stop and start keep the
// registration; uninstall revokes it in the cloud and removes only what setup created, checking
// ownership before each removal, and prints whatever it left behind. A rerun picks up where an
// interrupted uninstall stopped: the cloud identifiers are journaled before anything is removed.

const ATTEMPT_HOST_LABEL = "dev.catalystcloud.attempt.host-id";
const ATTEMPT_ID_LABEL = "dev.catalystcloud.attempt.id";
const NETWORK_LABEL = "dev.catalystcloud.session-network";
const COMPOSE_VOLUMES = ["supervisor-state", "host-credential"].map(v => `${RUNNER_PROJECT}_${v}`);
const COMPOSE_FILES = ["compose.yaml", "compose.darwin-thoughts.yaml"] as const;
/** Files setup writes into the runner directory. The work folders are listed separately. */
const SETUP_FILES = [...COMPOSE_FILES, ".env", "key-request.json"] as const;
const SETUP_DIRS = ["session-egress", "host-disk"] as const;
/** Repository checkouts, the thoughts checkout and their locks: kept unless the owner says so. */
const WORK_DIRS = ["slots", "thoughts", "locks"] as const;
const DARWIN_SIBLINGS = ["darwin-thoughts-custody", "darwin-thoughts-requests", "darwin-thoughts-responses"] as const;
/** The custody service setup installs, and the disk sampler a Mac runner may carry (CTC-5929). */
const LAUNCH_AGENTS = ["dev.catalystcloud.runner.darwin-thoughts-custody", "dev.catalystcloud.host-disk"] as const;
const EGRESS_TABLE = "catalyst_session";
const JOURNAL = "uninstall.json";
const RUNNER_UID = "10001:10001";
const HOST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunnerCommand = (
  file: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number; interactive?: boolean },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RunnerLifecycleDeps {
  /** docker, launchctl, systemctl and sudo. Never a shell. */
  run?: RunnerCommand;
  platform?: NodeJS.Platform;
  uid?: number;
  confirm?: (summary: string[]) => Promise<boolean>;
  isTty?: () => boolean;
}

/** Compose reads `.env` only: an exported CATALYST_ or DOCKER_SOCKET_ value would win over the file. */
const dockerEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("CATALYST_") && !key.startsWith("DOCKER_SOCKET_")));

const spawnCommand: RunnerCommand = (file, args, options = {}) =>
  new Promise((resolve) => {
    const env = file === "docker" ? dockerEnv() : process.env;
    if (options.interactive) {
      // sudo may ask for a password on this terminal.
      const child = spawn(file, args, { env, stdio: "inherit", timeout: options.timeoutMs ?? 300_000 });
      child.on("error", () => resolve({ code: 127, stdout: "", stderr: "" }));
      child.on("close", code => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
      return;
    }
    const child = execFile(file, args, { env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 4_000_000 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === "number" ? error.code : 127) : 0,
        stdout: String(stdout), stderr: String(stderr),
      }));
    child.stdin?.end(options.input ?? "");
  });

type Outcome = "removed" | "revoked" | "stopped" | "absent" | "kept" | "failed";
interface Step { item: string; outcome: Outcome; detail?: string }

interface Installation {
  dir: string;
  files: string[];
  containers: { id: string; service: string; state: string }[];
}

interface UninstallJournal {
  version: 1;
  hostId: string | null;
  team: string | null;
  tenant: string | null;
  requestId: string | null;
  teamId: string | null;
}

function owned(path: string, uid: number, kind: "file" | "directory"): boolean {
  try {
    const stat = lstatSync(path);
    return (kind === "file" ? stat.isFile() : stat.isDirectory()) && stat.uid === uid && (stat.mode & 0o022) === 0;
  } catch { return false; }
}
const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/** The onboarding engine's reads, through this command's own runner. */
function dockerEnvRun(run: RunnerCommand): RunnerExec {
  return (args, options) => run("docker", args, { input: options.input, timeoutMs: options.timeoutMs });
}

export function runnerComposeArgs(inst: Pick<Installation, "dir" | "files">): string[] {
  return ["compose", "--project-name", RUNNER_PROJECT, ...inst.files.flatMap(file => ["--file", file]),
    "--env-file", join(inst.dir, ".env")];
}

/** The installation this machine's Compose project names, verified before anything acts on it.
 * Null when there is none: no project containers and no runner directory setup wrote. */
async function locate(ctx: Ctx, run: RunnerCommand, uid: number): Promise<Installation | null> {
  const listed = await run("docker", ["ps", "--all", "--no-trunc",
    "--filter", `label=com.docker.compose.project=${RUNNER_PROJECT}`, "--format",
    '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project.config_files"}}']);
  if (listed.code !== 0)
    throw new CliError("Docker is not reachable, so the runner could not be read. Start Docker and run this again.", "runner_docker_unavailable", 1);
  const rows = listed.stdout.split("\n").map(line => line.trim()).filter(Boolean).map(line => line.split("\t"));
  let dir: string | undefined;
  let files: string[] | undefined;
  const containers: Installation["containers"] = [];
  for (const [id, service, state, workingDir, configFiles] of rows) {
    if (!id || !service || !state || !workingDir || !configFiles || !/^[0-9a-f]{12,64}$/.test(id))
      throw new CliError(`The ${RUNNER_PROJECT} Compose project has a container this command cannot read. Nothing was changed.`, "runner_installation_unverified", 1);
    if ((dir !== undefined && dir !== workingDir) || (files !== undefined && files.join(",") !== configFiles))
      throw new CliError(`The ${RUNNER_PROJECT} Compose project was started from more than one folder. Nothing was changed.`, "runner_installation_unverified", 1);
    dir = workingDir;
    files = configFiles.split(",");
    containers.push({ id, service, state });
  }
  if (dir === undefined) {
    let state: string;
    try { state = onboardStateRoot(ctx.home, ctx.env); } catch { return null; }
    const fallback = join(state, "runner");
    if (!exists(join(fallback, ".env")) && !exists(join(fallback, "compose.yaml")) && !exists(join(fallback, JOURNAL))) return null;
    dir = fallback;
    files = COMPOSE_FILES.map(name => join(fallback, name)).filter(path => exists(path));
  }
  // Only a folder under this person's home, holding files they own, is setup's.
  const unverified = () => new CliError(
    `The runner folder ${dir} is not one setup created for you (it must be yours and inside your home). Nothing was changed.`,
    "runner_installation_unverified", 1);
  if (!isAbsolute(dir)) throw unverified();
  try {
    const inHome = relative(realpathSync(ctx.home), realpathSync(dir));
    if (inHome === "" || inHome === ".." || inHome.startsWith("../") || isAbsolute(inHome) || !owned(dir, uid, "directory")) throw unverified();
  } catch (error) { if (error instanceof CliError) throw error; throw unverified(); }
  for (const file of files!)
    if (dirname(file) !== dir || !(COMPOSE_FILES as readonly string[]).includes(basename(file)) || !owned(file, uid, "file")) throw unverified();
  if (exists(join(dir, ".env")) && !owned(join(dir, ".env"), uid, "file")) throw unverified();
  return { dir, files: files!, containers };
}

function readJournal(dir: string): UninstallJournal | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, JOURNAL), "utf8")) as Record<string, unknown>;
    const field = (key: string, shape: RegExp) => typeof value[key] === "string" && shape.test(value[key] as string) ? value[key] as string : null;
    return value.version === 1 ? { version: 1, hostId: field("hostId", HOST_ID), team: field("team", /^[A-Za-z0-9_-]{1,32}$/),
      tenant: field("tenant", /^[A-Za-z0-9._-]{1,128}$/), requestId: field("requestId", UUID), teamId: field("teamId", /^[A-Za-z0-9-]{1,64}$/) } : null;
  } catch { return null; }
}
function writeJournal(dir: string, journal: UninstallJournal): void {
  const temporary = join(dir, `${JOURNAL}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(journal) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, join(dir, JOURNAL));
}
function readKeyRequest(dir: string): { requestId: string; teamId: string; account: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, "key-request.json"), "utf8")) as Record<string, unknown>;
    return typeof value.requestId === "string" && UUID.test(value.requestId) && typeof value.teamId === "string" && typeof value.account === "string"
      ? { requestId: value.requestId, teamId: value.teamId, account: value.account } : null;
  } catch { return null; }
}

async function supervisorRunning(run: RunnerCommand, inst: Installation): Promise<boolean | null> {
  const read = await run("docker", [...runnerComposeArgs(inst), "ps", "--status", "running", "--services"]);
  if (read.code !== 0) return null;
  return read.stdout.split("\n").some(line => line.trim() === "supervisor");
}

async function confirmUninstall(summary: string[]): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (const line of summary) process.stderr.write(`${line}\n`);
    return /^(y|yes)$/i.test((await prompt.question("Uninstall the runner from this machine? [y/N] ")).trim());
  } finally { prompt.close(); }
}

export async function cmdRunner(args: ParsedArgs, ctx: Ctx, deps: RunnerLifecycleDeps = {}): Promise<number> {
  const parts = positionals(args);
  const action = parts[0] ?? "status";
  if (parts.length > 1 || !["status", "stop", "start", "uninstall"].includes(action))
    throw new UsageError("runner takes: status | stop | start | uninstall [--yes] [--delete-checkouts]");
  if ((args.flags.yes === true || args.flags["delete-checkouts"] === true) && action !== "uninstall")
    throw new UsageError("--yes and --delete-checkouts are only valid with runner uninstall");
  const run = deps.run ?? spawnCommand;
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const platform = deps.platform ?? process.platform;
  const say = (line: string) => { if (!args.json) ctx.stdout(line); };
  const inst = await locate(ctx, run, uid);

  if (action === "status") {
    if (!inst) {
      if (args.json) ctx.stdout(JSON.stringify({ installed: false }));
      else ctx.stdout("No Catalyst runner is installed on this machine.");
      return 0;
    }
    const supervisor = inst.containers.find(c => c.service === "supervisor")?.state ?? "absent";
    const state = supervisor === "running" ? "running" : inst.containers.length === 0 ? "not started" : "stopped";
    if (args.json) ctx.stdout(JSON.stringify({ installed: true, state, dir: inst.dir, containers: inst.containers.map(({ service, state }) => ({ service, state })) }));
    else {
      ctx.stdout(`Runner: ${state} (folder ${inst.dir})`);
      for (const c of inst.containers) ctx.stdout(`  ${c.service}: ${c.state}`);
    }
    return 0;
  }

  if (action === "stop" || action === "start") {
    if (!inst || inst.containers.length === 0 && action === "stop")
      throw new CliError("No Catalyst runner is running on this machine. Set one up with: catalyst setup --runner", "runner_not_installed", 1);
    if (!exists(join(inst.dir, ".env")) || inst.files.length === 0)
      throw new CliError(`The runner folder ${inst.dir} is missing its settings. Repair it with: catalyst setup --runner`, "runner_installation_unverified", 1);
    const before = await supervisorRunning(run, inst);
    if (before === null) throw new CliError("Compose could not read the runner's state. Nothing was changed.", "runner_compose_failed", 1);
    if (action === "stop") {
      if (before) {
        // Only the supervisor: it stops taking work and advertises draining. The deadline watchdog
        // keeps running so an attempt already started still ends at its deadline.
        const stopped = await run("docker", [...runnerComposeArgs(inst), "stop", "supervisor"], { timeoutMs: 180_000 });
        if (stopped.code !== 0 || (await supervisorRunning(run, inst)) !== false)
          throw new CliError(`The runner did not stop: ${(stopped.stderr || stopped.stdout).trim().split("\n").slice(-1)[0] ?? "compose failed"}`, "runner_compose_failed", 1);
      }
      const attempts = await run("docker", ["ps", "--filter", `label=${ATTEMPT_ID_LABEL}`, "--format", "{{.ID}}"]);
      const running = attempts.code === 0 ? attempts.stdout.split("\n").filter(Boolean).length : null;
      if (args.json) ctx.stdout(JSON.stringify({ stopped: true, alreadyStopped: !before, runningAttempts: running }));
      else {
        say(before ? "Stopped the runner. This machine takes no new work, and keeps its registration." : "The runner was already stopped. This machine takes no new work.");
        if (running) say(`${running} attempt container(s) already started keep running until they finish or reach their deadline.`);
        say("Start it again with: catalyst runner start");
      }
      return 0;
    }
    if (exists(join(inst.dir, JOURNAL)))
      throw new CliError("An uninstall of this runner has started, so it cannot be started again. Finish it with: catalyst runner uninstall", "runner_uninstall_pending", 1);
    if (!before) {
      const up = await run("docker", [...runnerComposeArgs(inst), "up", "--detach"], { timeoutMs: 600_000 });
      if (up.code !== 0 || (await supervisorRunning(run, inst)) !== true)
        throw new CliError(`The runner did not start: ${(up.stderr || up.stdout).trim().split("\n").slice(-1)[0] ?? "compose failed"}`, "runner_compose_failed", 1);
    }
    const enrollment = await dockerRunnerEngine({ exec: dockerEnvRun(run), platform }).enrollment(inst.dir);
    const hostId = enrollment && !("unenrolled" in enrollment) ? enrollment.hostId : null;
    if (args.json) ctx.stdout(JSON.stringify({ started: true, alreadyRunning: before, hostId }));
    else {
      say(before ? "The runner is already running." : "Started the runner. It takes work again with the same registration.");
      if (hostId) say(`Host: ${hostId}`);
    }
    return 0;
  }

  return uninstall(args, ctx, { ...deps, run, uid, platform }, inst);
}

async function uninstall(
  args: ParsedArgs, ctx: Ctx,
  deps: Required<Pick<RunnerLifecycleDeps, "run" | "uid" | "platform">> & RunnerLifecycleDeps,
  inst: Installation | null,
): Promise<number> {
  const { run, uid, platform } = deps;
  const steps: Step[] = [];
  const record = (item: string, outcome: Outcome, detail?: string) => {
    steps.push({ item, outcome, ...(detail ? { detail } : {}) });
  };
  const deleteCheckouts = args.flags["delete-checkouts"] === true;
  const darwinAgents = platform === "darwin" ? LAUNCH_AGENTS.map(label => ({ label, plist: join(ctx.home, "Library", "LaunchAgents", `${label}.plist`) })).filter(a => exists(a.plist)) : [];
  const egressPresent = platform === "linux" && (EGRESS_ARTIFACTS.some(a => exists(a.path)) || exists(NATIVE_EGRESS_DIR));
  let runnerDir = inst?.dir;
  if (!runnerDir) try { runnerDir = join(onboardStateRoot(ctx.home, ctx.env), "runner"); } catch { /* no state root */ }
  const darwinDirs = runnerDir && platform === "darwin" ? DARWIN_SIBLINGS.map(name => join(dirname(runnerDir), name)).filter(exists) : [];
  if (!inst && darwinAgents.length === 0 && darwinDirs.length === 0 && !egressPresent) {
    if (args.json) ctx.stdout(JSON.stringify({ installed: false, steps: [] }));
    else ctx.stdout("No Catalyst runner is installed on this machine. Nothing to remove.");
    return 0;
  }

  // The cloud identity first, while the credential volume still exists. A journal from an earlier,
  // interrupted run supplies it after the volume is gone.
  let journal: UninstallJournal = inst ? readJournal(inst.dir) ?? { version: 1, hostId: null, team: null, tenant: null, requestId: null, teamId: null }
    : { version: 1, hostId: null, team: null, tenant: null, requestId: null, teamId: null };
  if (inst && !journal.hostId && exists(join(inst.dir, ".env")) && inst.files.length > 0) {
    const enrollment = await dockerRunnerEngine({ exec: dockerEnvRun(run), platform }).enrollment(inst.dir);
    if (enrollment && !("unenrolled" in enrollment)) {
      const e = enrollment as RunnerEnrollment;
      journal = { ...journal, hostId: e.hostId, team: e.team, tenant: e.tenant };
    }
  }
  const keyRequest = inst ? readKeyRequest(inst.dir) : null;
  if (keyRequest && !journal.requestId) journal = { ...journal, requestId: keyRequest.requestId, teamId: keyRequest.teamId, tenant: journal.tenant ?? keyRequest.account };

  const summary = [
    inst ? `Runner folder: ${inst.dir}` : "Runner folder: none",
    `Host registration: ${journal.hostId ?? "none found"}${journal.team ? ` (team ${journal.team})` : ""}`,
    `Runner key: ${journal.requestId ? "will be revoked" : "none issued by setup"}`,
    `Checkouts and thoughts: ${deleteCheckouts ? "deleted" : "kept"}`,
  ];
  if (args.flags.yes !== true) {
    const tty = deps.isTty ?? stdinIsTty;
    const confirmed = tty() && await (deps.confirm ?? confirmUninstall)(summary);
    if (!confirmed) {
      ctx.stdout(args.json ? JSON.stringify({ removed: false, reason: "confirmation_required" })
        : "Runner kept. Use --yes to confirm the uninstall without a terminal.");
      return 2;
    }
  }
  if (inst) writeJournal(inst.dir, journal);

  // 1. No new work: stop the supervisor before the cloud forgets it.
  if (inst && inst.containers.some(c => c.service === "supervisor" && c.state === "running")) {
    const stopped = await run("docker", [...runnerComposeArgs(inst), "stop", "supervisor"], { timeoutMs: 180_000 });
    record("supervisor", stopped.code === 0 ? "stopped" : "failed", stopped.code === 0 ? undefined : "compose stop failed");
  }

  // 2. The cloud: the host registration, the runner key, and admission when no other machine needs it.
  let cloudFailed = false;
  if (journal.hostId || journal.requestId) {
    const cfg = loadConfig(ctx.home);
    if (!cfg) {
      record("host registration", "failed", "not logged in: run catalyst login as an owner or admin, then run this again");
      cloudFailed = true;
    } else if (journal.tenant && cfg.account !== journal.tenant) {
      record("host registration", "failed", `this runner belongs to account ${journal.tenant}, but you are logged in to ${cfg.account}`);
      cloudFailed = true;
    } else {
      const client = apiClient(cfg, ctx);
      const account = encodeURIComponent(cfg.account);
      const call = async (label: string, request: () => Promise<{ status: number }>, done: Outcome, statuses: Record<number, [Outcome, string?]>) => {
        try {
          const { status } = await request();
          const [outcome, detail] = status >= 200 && status < 300 ? [done] : statuses[status] ?? ["failed", `the cloud answered ${status}`];
          record(label, outcome, detail);
          if (outcome === "failed") cloudFailed = true;
        } catch (error) {
          record(label, "failed", error instanceof Error ? error.message : "the cloud could not be reached");
          cloudFailed = true;
        }
      };
      if (journal.hostId)
        await call("host registration", () => client.deleteJson(`/api/v1/hosts/${encodeURIComponent(journal.hostId!)}?account=${account}`, { accept: [403, 404] }),
          "revoked", { 404: ["absent", "already revoked"], 403: ["failed", "admin access is required"] });
      else record("host registration", "absent", "this machine never enrolled");
      if (journal.requestId)
        await call("runner key", () => client.deleteJson(`/api/v1/agent/runner-keys/${journal.requestId}?account=${account}`, { accept: [403, 404, 409, 503] }),
          "revoked", { 404: ["absent", "no key was issued for this machine"], 403: ["failed", "admin access is required"],
            409: ["failed", "the key's issue is still settling; run this again shortly"], 503: ["failed", "the key service is unavailable; run this again shortly"] });
      if (journal.teamId && journal.team && !cloudFailed) {
        // Admission is the team's, not the machine's: switch it off only when no machine remains.
        try {
          const listed = await client.getJson<{ hosts?: { team?: unknown; revokedAtMs?: unknown; hostId?: unknown }[] }>(`/api/v1/hosts/enrollments?account=${account}`);
          const others = (listed.body.hosts ?? []).filter(h => h.team === journal.team && h.revokedAtMs === null && h.hostId !== journal.hostId);
          if (others.length > 0) record("team runner admission", "kept", `${others.length} other machine(s) still run team ${journal.team}`);
          else {
            const put = await client.putJson(`/api/v1/agent/runner-admission?account=${account}&team=${encodeURIComponent(journal.teamId)}`, { admissionEnabled: false }, { accept: [403, 404, 409] });
            record("team runner admission", put.status === 200 ? "removed" : "kept", put.status === 200 ? "switched off: no machine runs this team" : `left as it was (the cloud answered ${put.status})`);
          }
        } catch { record("team runner admission", "kept", "left as it was: the machine list could not be read"); }
      }
    }
  }
  if (cloudFailed) return finish(args, ctx, steps, inst, true,
    "The runner is stopped, but its registration is not fully revoked, so its local files and credential are kept. Fix the line above and run: catalyst runner uninstall");

  // 3. Attempt containers and workspace volumes this host's supervisor created, by label.
  if (journal.hostId) {
    const containers = await run("docker", ["ps", "--all", "--no-trunc", "--filter", `label=${ATTEMPT_HOST_LABEL}=${journal.hostId}`, "--format", `{{.ID}}\t{{.Label "${ATTEMPT_HOST_LABEL}"}}`]);
    const ids = containers.code === 0 ? containers.stdout.split("\n").map(l => l.split("\t")).filter(([id, host]) => id && host === journal.hostId).map(([id]) => id!) : null;
    if (ids === null) record("attempt containers", "failed", "could not be listed");
    else if (ids.length === 0) record("attempt containers", "absent");
    else {
      const removed = await run("docker", ["rm", "--force", ...ids], { timeoutMs: 300_000 });
      record("attempt containers", removed.code === 0 ? "removed" : "failed", `${ids.length}`);
    }
    const volumes = await run("docker", ["volume", "ls", "--filter", `label=${ATTEMPT_HOST_LABEL}=${journal.hostId}`, "--format", `{{.Name}}\t{{.Label "${ATTEMPT_HOST_LABEL}"}}`]);
    const names = volumes.code === 0 ? volumes.stdout.split("\n").map(l => l.split("\t")).filter(([name, host]) => name && /^catalyst-[A-Za-z0-9_.-]+$/.test(name) && host === journal.hostId).map(([name]) => name!) : null;
    if (names === null) record("attempt volumes", "failed", "could not be listed");
    else if (names.length === 0) record("attempt volumes", "absent");
    else {
      const removed = await run("docker", ["volume", "rm", ...names], { timeoutMs: 300_000 });
      record("attempt volumes", removed.code === 0 ? "removed" : "failed", names.join(", "));
    }
  }

  // 4. Work folders, before Compose goes: on native Linux the runner uid owns them, and the
  // supervisor image is how setup handed them over, so it is how they are emptied.
  if (inst && deleteCheckouts) {
    const present = WORK_DIRS.map(name => join(inst.dir, name)).filter(exists);
    const foreign = present.filter(path => !owned(path, uid, "directory"));
    if (foreign.length > 0 && inst.files.length > 0) {
      const emptied = await run("docker", [...runnerComposeArgs(inst), "run", "--rm", "-T", "--no-deps", "--user", RUNNER_UID,
        "--entrypoint", "find", "supervisor", ...foreign, "-mindepth", "1", "-delete"], { timeoutMs: 600_000 });
      if (emptied.code !== 0) record("checkouts", "failed", "the runner's files could not be emptied");
    }
    for (const path of present) {
      try { if (owned(path, uid, "directory")) rmSync(path, { recursive: true, force: true }); else rmdirSync(path); record(basename(path), "removed"); }
      catch { record(basename(path), "failed", `${path} is not empty`); }
    }
  }

  // 5. The Compose project: both services and their two volumes (the host secret and journal).
  if (inst && inst.files.length > 0 && exists(join(inst.dir, ".env"))) {
    const down = await run("docker", [...runnerComposeArgs(inst), "down", "--volumes", "--remove-orphans", "--timeout", "30"], { timeoutMs: 300_000 });
    record("compose project", down.code === 0 ? "removed" : "failed", down.code === 0 ? undefined : (down.stderr || down.stdout).trim().split("\n").slice(-1)[0]);
  }
  for (const volume of COMPOSE_VOLUMES) {
    const inspect = await run("docker", ["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', volume]);
    if (inspect.code !== 0) continue;
    if (inspect.stdout.trim() !== RUNNER_PROJECT) { record(volume, "kept", "not labelled as this project's"); continue; }
    const removed = await run("docker", ["volume", "rm", volume]);
    record(volume, removed.code === 0 ? "removed" : "failed");
  }

  // 6. Linux session egress: the root units and the nftables table setup's commands installed.
  if (egressPresent) linuxEgress: {
    const hash = (path: string) => { try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; } };
    const changed = EGRESS_ARTIFACTS.filter(a => exists(a.path) && hash(a.path) !== a.digest);
    if (changed.length > 0) {
      for (const a of changed) record(a.path, "kept", "changed since setup installed it");
      break linuxEgress;
    }
    const sudo = deps.isTty?.() ?? stdinIsTty() ? [] : ["-n"];
    const commands: string[][] = [
      ["systemctl", "disable", "--now", "catalyst-session-egress-attest.timer", "catalyst-session-egress.service"],
      ["systemctl", "stop", "catalyst-session-egress-attest.service"],
      ["rm", "-f", ...EGRESS_ARTIFACTS.map(a => a.path)],
      ["systemctl", "daemon-reload"],
      ["nft", "delete", "table", "inet", EGRESS_TABLE],
      ["rm", "-rf", NATIVE_EGRESS_DIR],
      ["rmdir", "--ignore-fail-on-non-empty", "/usr/lib/catalyst", "/var/lib/catalyst"],
    ];
    const failed: string[] = [];
    for (const command of commands) {
      const result = await run("sudo", [...sudo, ...command], { interactive: sudo.length === 0, timeoutMs: 120_000 });
      // The table is already gone when an earlier run removed it.
      if (result.code !== 0 && !(command[0] === "nft" && /no such file|does not exist/i.test(result.stderr)) && !(command[0] === "systemctl" && /not (be )?(loaded|found)|does not exist/i.test(result.stderr)))
        failed.push(`sudo ${command.join(" ")}`);
    }
    const left: string[] = EGRESS_ARTIFACTS.filter(a => exists(a.path)).map(a => a.path);
    if (exists(NATIVE_EGRESS_DIR)) left.push(NATIVE_EGRESS_DIR);
    if (failed.length === 0 && left.length === 0) record("session-egress units and nftables table", "removed");
    else record("session-egress units and nftables table", "failed", `run these yourself: ${failed.join("; ") || left.map(p => `sudo rm -rf ${p}`).join("; ")}`);
  }

  // 7. The session network, only when it carries setup's label; after the egress units, whose
  // boot service would create it again.
  const network = await run("docker", ["network", "inspect", "--format", `{{index .Labels "${NETWORK_LABEL}"}}`, RUNNER_SESSION_NETWORK]);
  if (network.code === 0) {
    if (network.stdout.trim() !== "v1") record(RUNNER_SESSION_NETWORK, "kept", "not created by setup");
    else {
      const removed = await run("docker", ["network", "rm", RUNNER_SESSION_NETWORK]);
      record(RUNNER_SESSION_NETWORK, removed.code === 0 ? "removed" : "failed", removed.code === 0 ? undefined : "still in use by a container");
    }
  }

  // 8. macOS: the storage custody service (and a disk sampler, when one was installed) and its folders.
  for (const agent of darwinAgents) {
    let ours = false;
    try { ours = owned(agent.plist, uid, "file") && readFileSync(agent.plist, "utf8").includes(`<string>${agent.label}</string>`); } catch { /* unreadable */ }
    if (!ours) { record(agent.plist, "kept", "not the file setup installed"); continue; }
    for (const domain of [`gui/${uid}`, `user/${uid}`]) await run("launchctl", ["bootout", `${domain}/${agent.label}`]);
    const loaded = (await run("launchctl", ["print", `user/${uid}/${agent.label}`])).code === 0 ||
      (await run("launchctl", ["print", `gui/${uid}/${agent.label}`])).code === 0;
    if (loaded) { record(agent.label, "failed", `still loaded: run launchctl bootout user/${uid}/${agent.label}`); continue; }
    try { rmSync(agent.plist); record(agent.label, "removed"); } catch { record(agent.plist, "failed", "could not be deleted"); }
  }
  for (const path of darwinDirs) {
    if (!owned(path, uid, "directory")) { record(path, "kept", "not yours"); continue; }
    try { rmSync(path, { recursive: true, force: true }); record(basename(path), "removed"); } catch { record(path, "failed", "could not be deleted"); }
  }

  // 9. The files setup wrote. The key-request marker and the .env (which holds the spent join token)
  // go only now that the cloud has revoked what they name.
  if (inst) {
    const before = steps.length;
    for (const name of SETUP_DIRS) {
      const path = join(inst.dir, name);
      if (!exists(path)) continue;
      if (!owned(path, uid, "directory")) { record(path, "kept", "not yours"); continue; }
      try { rmSync(path, { recursive: true, force: true }); } catch { record(path, "failed", "could not be deleted"); }
    }
    for (const name of SETUP_FILES) {
      const path = join(inst.dir, name);
      if (!exists(path)) continue;
      try { rmSync(path); } catch { record(path, "failed", "could not be deleted"); }
    }
    if (steps.length === before) record("runner settings", "removed", inst.dir);
  }
  const failed = steps.some(s => s.outcome === "failed");
  if (inst && !failed) {
    try { rmSync(join(inst.dir, JOURNAL), { force: true }); rmdirSync(inst.dir); } catch { /* kept checkouts remain */ }
  }
  return finish(args, ctx, steps, inst, failed, failed
    ? "Some of the runner is left on this machine (above). Fix those lines and run catalyst runner uninstall again; it picks up where this run stopped."
    : undefined);
}

function finish(args: ParsedArgs, ctx: Ctx, steps: Step[], inst: Installation | null, failed: boolean, note?: string): number {
  const left: string[] = steps.filter(s => s.outcome === "failed" || s.outcome === "kept").map(s => `${s.item}${s.detail ? `: ${s.detail}` : ""}`);
  if (inst) {
    for (const name of WORK_DIRS) {
      const path = join(inst.dir, name);
      if (!exists(path)) continue;
      let entries = 0;
      try { entries = readdirSync(path).length; } catch { /* unreadable: the runner uid owns it */ entries = -1; }
      left.push(`${path}${name === "slots" ? " (repository checkouts)" : name === "thoughts" ? " (thoughts checkout)" : ""}${entries === 0 ? ", empty" : ""}: delete with catalyst runner uninstall --delete-checkouts`);
    }
    if (exists(join(inst.dir, JOURNAL))) left.push(`${join(inst.dir, JOURNAL)} (lets the next run finish the uninstall)`);
  }
  if (args.json) {
    ctx.stdout(JSON.stringify({ removed: !failed, steps, leftBehind: left }));
    return failed ? 1 : 0;
  }
  for (const s of steps) ctx.stdout(`${s.outcome.padEnd(7)} ${s.item}${s.detail ? ` (${s.detail})` : ""}`);
  if (left.length > 0) {
    ctx.stdout("Left behind on this machine:");
    for (const line of left) ctx.stdout(`  ${line}`);
  }
  ctx.stdout(note ?? "Uninstalled the runner from this machine.");
  return failed ? 1 : 0;
}
