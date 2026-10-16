import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  parseMachinePaths,
  resolveCatalystPath,
} from "../vendor/paths/index.js";
import { machinePathsFile } from "../vendor/paths/node.js";
import type { ParsedArgs } from "./args.js";
import { configPathFor, type Ctx } from "./config.js";
import type { OnboardUi } from "./onboard-ui.js";
import { onboardJsonView, TIMED_OUT_REASONS } from "./setup-onboard-copy.js";
import {
  standalonePlan,
  standalonePlanNotes,
} from "./onboard-standalone-copy.js";
import { CliError, UsageError } from "./errors.js";
import { onboardFileSnapshot } from "./onboard-file-snapshot.js";
import {
  dispatchStageName,
  onboardReasonText,
  onboardTeamKey,
  savedOnboardBaseUrl,
} from "./onboard-next.js";
import {
  parseBootstrapPlan,
  bootstrapPlanHash,
  bootstrapPlanLines,
  type OnboardBootstrapPreview,
} from "./onboard-bootstrap.js";

export const ONBOARD_STEPS = [
  "machine",
  "cli",
  "skills",
  "legacy",
  "signin",
  "daemon",
  "housekeeping",
  "linear.workspace",
  "linear.personal",
  "linear.team",
  "linear.adopt",
  "linear.automations",
  "github.install",
  "github.personal",
  "github.repos",
  "projects",
  "accounts",
  "capacity",
  "runner",
  "settings",
  "values",
  "first-ticket",
  "ready",
] as const;

export type OnboardStepId = (typeof ONBOARD_STEPS)[number];
export type OnboardStepState =
  "pending" | "running" | "done" | "skipped" | "failed" | "waiting";

export interface OnboardStep {
  id: OnboardStepId;
  state: OnboardStepState;
  /** A refusal is stored as failed for compatibility, with its distinct exit reason retained. */
  refused?: true;
  at?: string;
  evidence?: Record<string, string | number | boolean | null>;
  reason?: string;
}

export interface OnboardJournal {
  schema: 1;
  runId: string;
  installer: string | null;
  cli: string;
  tenant: string | null;
  exit: number | null;
  /** Present when onboarding stops on a named command error. */
  errorCode?: string;
  scope?: "step" | "onboarding";
  mode?: "plan" | "run";
  complete?: boolean;
  localSync?: boolean;
  /** The installer's daily-update choice, carried so this record keeps it when setup rewrites it. */
  dailyUpdate?: OnboardDailyUpdate;
  account?: string;
  membershipId?: string;
  baseUrl?: string;
  operations?: Partial<Record<OnboardStepId, string>>;
  steps: OnboardStep[];
  changes: Array<{ kind: string; label: string; undo: string }>;
}

export type OnboardDailyUpdate =
  | { state: "on" }
  | { state: "off" }
  | { state: "skipped"; reason: "no_scheduler" };

function dailyUpdateChoice(value: unknown): OnboardDailyUpdate | undefined {
  const row = object(value);
  if (row?.state === "on" || row?.state === "off") return { state: row.state };
  if (row?.state === "skipped" && row.reason === "no_scheduler")
    return { state: "skipped", reason: "no_scheduler" };
  return undefined;
}

export interface OnboardIdentity {
  account: string;
  membershipId: string;
  baseUrl: string;
  role: "owner" | "admin" | "member";
  /** Current /me display data is ephemeral and never supplies receipt authority. */
  display?: {
    personLabel: string;
    email: string | null;
    workspaceName: string;
    workspaceSlug: string;
  };
}

const identityLabel = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

/** CTC-4680: who and where for the lines beside setup's mark, "user: …" and "workspace: …". */
export function onboardHeaderIdentity(identity: OnboardIdentity): {
  user: string;
  workspace: string;
} {
  const display = identity.display;
  return {
    user: identityLabel(
      display?.email || display?.personLabel || identity.membershipId,
    ),
    workspace: identityLabel(display?.workspaceName || identity.account),
  };
}

export function onboardIdentityLines(
  identity: OnboardIdentity | null,
): string[] {
  if (!identity)
    return [
      "Use an existing Catalyst account or accept your invitation before approving sign-in.",
    ];
  const label = identityLabel;
  const display = identity.display;
  const person = label(display?.personLabel || identity.membershipId);
  const email = display?.email ? label(display.email) : "";
  const workspace = label(display?.workspaceName || identity.account);
  // CTC-4680 (Ryan, round 2): "Signed in to Catalyst as …" and "Catalyst workspace: …", with no
  // repeated email and no internal slug.
  return [
    `Signed in to Catalyst as ${person}${email && email !== person ? ` (${email})` : ""}`,
    `Catalyst workspace: ${workspace} · ${identity.role}`,
  ];
}

export interface OnboardStepResult {
  state: "done" | "skipped" | "pending" | "waiting" | "failed" | "refused";
  reason?: string;
  evidence?: OnboardStep["evidence"];
}

export interface OnboardAdapter {
  check: (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ) => Promise<OnboardStepResult>;
  act?: (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ) => Promise<OnboardStepResult>;
}

export interface OnboardDeps {
  /** Only the internal setup continuation retains its renderer after one consent. */
  reviewedSetup?: boolean;
  /** Internal staged installer mode; absent for the normal installed CLI. */
  bootstrap?: OnboardBootstrapPreview;
  ui?: OnboardUi;
  adapters?: Partial<Record<OnboardStepId, OnboardAdapter>>;
  /** Explicitly requested headless steps must finish, even if normally optional. */
  requiredSteps?: readonly OnboardStepId[];
  identity?: (journal?: OnboardJournal) => Promise<OnboardIdentity | null>;
  stageSignin?: (
    signal?: AbortSignal,
  ) => Promise<import("./onboard-login-candidate.js").OnboardLoginCandidate>;
  signal?: AbortSignal;
  /** Runs between steps, never inside one: the CLI refreshes a short OAuth session here so a step's
   *  consent wait cannot outlive its access token. */
  beforeStep?: (id: OnboardStepId) => Promise<void>;
  bindSignals?: boolean;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  token?: () => string;
  isTty?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Runs one implemented onboarding step. M1 registers the local legacy step; later slices add
   *  provider and project steps without changing the journal or resume contract. */
  runStep?: (
    id: OnboardStepId,
    ctx: Ctx,
  ) => Promise<{
    state: "done" | "skipped";
    evidence?: OnboardStep["evidence"];
  }>;
}

const EXIT_FAILED = 10;
const EXIT_WAITING = 11;
const EXIT_REFUSED = 12;
/** The bootstrap exports its actual state role so handoff cannot take a second lock. */
export function onboardStateRoot(
  home: string,
  env: NodeJS.ProcessEnv = {},
): string {
  const bootstrap = env.CATALYST_INSTALL_STATE_DIR;
  if (bootstrap !== undefined) {
    if (!isAbsolute(bootstrap))
      throw new CliError(
        "bootstrap state directory must be absolute",
        "onboard-state-path",
        EXIT_REFUSED,
      );
    return bootstrap;
  }
  try {
    const pathsFile = machinePathsFile({ env: { ...env, HOME: home } });
    const machine =
      pathsFile && existsSync(pathsFile)
        ? parseMachinePaths(JSON.parse(readFileSync(pathsFile, "utf8")))
        : undefined;
    if (env.CATALYST_PATHS_FILE && !machine)
      throw new CliError(
        "the selected machine paths file is missing",
        "onboard-state-path",
        EXIT_REFUSED,
      );
    if (env.CATALYST_STATE_DIR !== undefined || machine)
      return resolveCatalystPath("state", { env, machine });
    return join(
      env.XDG_STATE_HOME ?? join(home, ".local", "state"),
      "catalyst",
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "the selected setup paths are invalid; keep the file and correct it before resuming",
      "onboard-state-path",
      EXIT_REFUSED,
    );
  }
}

export function onboardStatePath(
  home: string,
  env: NodeJS.ProcessEnv = {},
): string {
  return join(onboardStateRoot(home, env), "install", "last-run.json");
}

export function onboardLockPath(
  home: string,
  env: NodeJS.ProcessEnv = {},
): string {
  return join(onboardStateRoot(home, env), "install.lock");
}

export const ONBOARD_DEPENDENCIES: Partial<
  Record<OnboardStepId, readonly OnboardStepId[]>
> = {
  "linear.workspace": ["signin"],
  "linear.personal": ["signin", "linear.workspace"],
  "linear.team": ["signin", "linear.workspace", "linear.personal"],
  "linear.adopt": ["linear.team"],
  "linear.automations": ["linear.team", "linear.personal"],
  "github.install": ["signin"],
  "github.personal": ["signin"],
  "github.repos": ["github.install", "linear.team"],
  projects: ["linear.team", "github.repos"],
  accounts: ["signin"],
  settings: ["projects"],
  // The cloud's required-values check reads the registered repositories, not a local checkout.
  values: ["projects"],
  capacity: ["projects"],
  // The join token names the selected team's pool.
  runner: ["linear.team"],
  daemon: ["signin"],
  // What dispatch needs. Environment approval gates only implement and pr, and the first phase
  // needs no imported values, so repository settings and local sync do not hold a first ticket.
  "first-ticket": [
    "projects",
    "linear.adopt",
    "linear.automations",
    "accounts",
    "capacity",
    // CTC-4744: no work is offered while the cloud is still reading the settings (dependencySettled).
    "values",
  ],
};

const ADMIN_STEPS = new Set<OnboardStepId>([
  "linear.workspace",
  "linear.adopt",
  "linear.automations",
  "github.install",
  "github.repos",
  "projects",
  "settings",
  // `values` is not here: its check only reads, so a member's run finds missing values too.
  "capacity",
  "runner",
  "first-ticket",
]);

export const ONBOARD_TITLES: Record<OnboardStepId, string> = {
  machine: "Check this computer",
  cli: "Check the catalyst command",
  skills: "Check the Catalyst skills",
  legacy: "Remove earlier Catalyst installs",
  signin: "Sign in to Catalyst",
  "linear.workspace": "Connect your Linear workspace",
  "linear.personal": "Connect your Linear account",
  "linear.team": "Choose a Linear team",
  "linear.adopt": "Apply the Catalyst workflow",
  "linear.automations": "Check Linear's pull request automations",
  "github.install": "Install Catalyst on GitHub",
  "github.personal": "Connect your GitHub account",
  "github.repos": "Choose repositories",
  projects: "Register your projects",
  accounts: "Check AI accounts",
  settings: "Review repository settings",
  values: "Check the repository's values",
  capacity: "Check runner capacity",
  runner: "Run Catalyst's work on this machine",
  daemon: "Check optional local sync",
  housekeeping: "Schedule the daily update",
  "first-ticket": "Start a first ticket",
  ready: "Check onboarding readiness",
};

function isoNow(ctx: Ctx, deps: OnboardDeps): string {
  return (deps.now ?? ctx.now)().toISOString();
}

function safeRead(path: string): unknown | null {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new CliError(
        `the saved setup record at ${path} cannot be a symbolic link`,
        "onboard-state-symlink",
        EXIT_REFUSED,
      );
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null)
      throw new CliError(
        "the saved setup record has an unknown shape; keep it and move it aside before trying again",
        "onboard-state-shape",
        EXIT_REFUSED,
      );
    return value;
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (object(err)?.code === "ENOENT") return null;
    throw new CliError(
      `the saved setup record at ${path} is not valid JSON; keep it and move it aside before trying again`,
      "onboard-state-corrupt",
      EXIT_REFUSED,
    );
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapLegacyStep(id: unknown): OnboardStepId | null {
  if (typeof id !== "string") return null;
  const aliases: Record<string, OnboardStepId> = {
    folders: "machine",
    sign_in: "signin",
    login: "signin",
    housekeeping: "housekeeping",
    ready: "ready",
    daily_updates: "housekeeping",
    final_check: "ready",
  };
  const mapped = aliases[id] ?? id;
  return (ONBOARD_STEPS as readonly string[]).includes(mapped)
    ? (mapped as OnboardStepId)
    : null;
}

function normalizeStep(value: unknown, fallbackAt: string): OnboardStep | null {
  const row = object(value);
  if (!row) return null;
  const id = mapLegacyStep(row.id);
  if (!id) return null;
  const rawState = typeof row.state === "string" ? row.state : row.result;
  const states: Record<string, OnboardStepState> = {
    pending: "pending",
    running: "running",
    done: "done",
    already_done: "done",
    skipped: "skipped",
    failed: "failed",
    interrupted: "failed",
    not_approved: "waiting",
    needs_you: "waiting",
    waiting: "waiting",
  };
  const state = typeof rawState === "string" ? states[rawState] : undefined;
  if (!state) return null;
  const step: OnboardStep = { id, state };
  if (state === "failed" && row.refused === true) step.refused = true;
  if (typeof row.at === "string") step.at = row.at;
  else if (typeof row.updatedAt === "string") step.at = row.updatedAt;
  else step.at = fallbackAt;
  if (
    typeof row.reason === "string" &&
    /^[a-z][a-z0-9_]{1,63}$/.test(row.reason)
  )
    step.reason = row.reason;
  const evidence = object(row.evidence);
  const safeEvidence: NonNullable<OnboardStep["evidence"]> = {};
  for (const key of [
    "principal",
    "role",
    "workspace",
    "found",
    "remaining",
    "count",
    "version",
    "account",
    "membershipId",
    "checkedAt",
    "project",
    "projectCount",
    "repository",
    "installation",
    "ticket",
    // The team's dispatch stage name, as the contract gave it.
    "stage",
    // Admin-owned step ids a member's run found unfinished.
    "admin",
    "cursor",
    "lag",
    "heartbeatAgeMs",
    "supervised",
    "streaming",
    "scheduled",
    "validated",
    "available",
    "phaseStarted",
    "linearComment",
    "fleetActivity",
    "requiredValues",
    "paused",
    "revision",
    "hash",
    "path",
    "provider",
    "scope",
    "checks",
    "passed",
    "team",
    "teamKey",
    "selected",
    "hostName",
    "supervisorImage",
    "hostId",
    "capacity",
    "failing",
    "image",
    "automations",
    "workspaceSlug",
    // CTC-4629: an outdated connection's grant, scopes, action URL and who takes it.
    "grant",
    "granted",
    "missing",
    "org",
    "url",
    "actor",
    // CTC-4716: which AI accounts the workspace may add, so the step's text offers only those.
    "aiAccountKinds",
    "custodyFailureCase",
    "custodyErrorClass",
    "custodyErrorMessage",
    "custodyErrorMessageRedacted",
    "custodyReason",
    "custodyResultInstalled",
    "custodyAuthorityMatched",
    "custodyTelemetry",
    // CTC-5931: the closed proof an existing runner installation failed.
    "installationCheck",
  ] as const) {
    const item = evidence?.[key];
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      safeEvidence[key] = item;
  }
  if (Object.keys(safeEvidence).length > 0) step.evidence = safeEvidence;
  return step;
}

/** Reads both the M1 journal and the 0.13.4 install-script receipt without discarding completed steps. */
export function readOnboardJournal(
  path: string,
  cliVersion = "0.13.1",
  now = new Date(),
): OnboardJournal | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const value = object(raw);
  if (!value || !Array.isArray(value.steps))
    throw new CliError(
      `the saved setup record at ${path} has an unknown shape; keep it and move it aside before trying again`,
      "onboard-state-shape",
      EXIT_REFUSED,
    );
  if (value.schema !== 1 && value.schema !== "catalyst-install-last-run/1")
    throw new CliError(
      "the saved setup record uses an unsupported version; keep it before trying again",
      "onboard-state-version",
      EXIT_REFUSED,
    );
  const startedAt =
    typeof value.startedAt === "string" ? value.startedAt : now.toISOString();
  const steps = value.steps
    .map((row) => normalizeStep(row, startedAt))
    .filter((row): row is OnboardStep => row !== null);
  const deduped = new Map<OnboardStepId, OnboardStep>();
  for (const step of steps) deduped.set(step.id, step);
  const state = typeof value.state === "string" ? value.state : null;
  const exit =
    typeof value.exit === "number"
      ? value.exit
      : typeof value.exitCode === "number"
        ? value.exitCode
        : null;
  const dailyUpdate = dailyUpdateChoice(value.dailyUpdate);
  return {
    schema: 1,
    runId: typeof value.runId === "string" ? value.runId : randomUUID(),
    installer:
      typeof value.installer === "string"
        ? value.installer
        : typeof value.revision === "string"
          ? value.revision
          : null,
    cli: typeof value.cli === "string" ? value.cli : cliVersion,
    tenant: typeof value.tenant === "string" ? value.tenant : null,
    exit:
      state === "running" || state === "interrupted" || state === "stopped"
        ? null
        : exit,
    steps: [...deduped.values()],
    ...(typeof value.account === "string" ? { account: value.account } : {}),
    ...(typeof value.membershipId === "string"
      ? { membershipId: value.membershipId }
      : {}),
    ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
    ...(value.scope === "step" || value.scope === "onboarding"
      ? { scope: value.scope }
      : {}),
    ...(value.mode === "plan" || value.mode === "run"
      ? { mode: value.mode }
      : {}),
    ...(typeof value.complete === "boolean"
      ? { complete: value.complete }
      : {}),
    ...(typeof value.localSync === "boolean"
      ? { localSync: value.localSync }
      : {}),
    ...(dailyUpdate ? { dailyUpdate } : {}),
    operations: Object.fromEntries(
      Object.entries(object(value.operations) ?? {}).filter(
        ([key, v]) =>
          (ONBOARD_STEPS as readonly string[]).includes(key) &&
          typeof v === "string" &&
          /^[a-zA-Z0-9_.:-]{1,160}$/.test(v),
      ),
    ),
    changes: Array.isArray(value.changes)
      ? value.changes.flatMap((change) => {
          const row = object(change);
          return row &&
            typeof row.kind === "string" &&
            typeof row.label === "string" &&
            typeof row.undo === "string"
            ? [{ kind: row.kind, label: row.label, undo: row.undo }]
            : [];
        })
      : [],
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CliError(
      `setup state path ${path} must be a real directory`,
      "onboard-state-path",
      EXIT_REFUSED,
    );
  chmodSync(path, 0o700);
  try {
    writeFileSync(join(path, ".mode-check"), "", { mode: 0o600, flag: "wx" });
    rmSync(join(path, ".mode-check"));
  } catch {
    /* existing state permissions are checked by the actual atomic write */
  }
}

export function writeOnboardJournal(
  path: string,
  journal: OnboardJournal,
): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return object(error)?.code !== "ESRCH";
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const raw = readFileSync(join(path, "owner.json"), "utf8");
    const row = object(JSON.parse(raw));
    if (row && Number.isSafeInteger(row.pid) && typeof row.token === "string")
      return { pid: row.pid as number, token: row.token };
  } catch {
    try {
      const pid = Number(readFileSync(join(path, "pid"), "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) return { pid, token: "" };
    } catch {
      /* incomplete stale lock */
    }
  }
  return null;
}

function removeStaleLock(lockPath: string, owner: LockOwner | null): boolean {
  try {
    const before = lstatSync(lockPath);
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const current = readLockOwner(lockPath);
    if (
      (current?.pid ?? null) !== (owner?.pid ?? null) ||
      (current?.token ?? "") !== (owner?.token ?? "")
    )
      return false;
    const stalePath = `${lockPath}.stale-${owner?.pid ?? "unknown"}-${randomBytes(4).toString("hex")}`;
    renameSync(lockPath, stalePath);
    const moved = readLockOwner(stalePath);
    if (
      (moved?.pid ?? null) !== (owner?.pid ?? null) ||
      (moved?.token ?? "") !== (owner?.token ?? "")
    ) {
      try {
        renameSync(stalePath, lockPath);
      } catch {
        /* another installer acquired the canonical path */
      }
      return false;
    }
    rmSync(stalePath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function releaseOwnedLock(lockPath: string, owner: LockOwner): void {
  try {
    const before = lstatSync(lockPath);
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const current = readLockOwner(lockPath);
    if (current?.pid !== owner.pid || current.token !== owner.token) return;
    const releasePath = `${lockPath}.release-${owner.pid}-${randomBytes(4).toString("hex")}`;
    renameSync(lockPath, releasePath);
    const moved = readLockOwner(releasePath);
    if (moved?.pid !== owner.pid || moved.token !== owner.token) {
      try {
        renameSync(releasePath, lockPath);
      } catch {
        /* another installer acquired the canonical path */
      }
      return;
    }
    rmSync(releasePath, { recursive: true, force: false });
  } catch {
    /* leave an uncertain lock in place so a later run can verify its owner */
  }
}

function acquireLock(
  ctx: Ctx,
  deps: OnboardDeps,
): { path: string; owner: LockOwner } {
  const pid = deps.processId ?? process.pid;
  const token = (deps.token ?? randomUUID)();
  const path = onboardLockPath(ctx.home, ctx.env);
  ensurePrivateDirectory(join(path, ".."));
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "pid"), `${pid}\n`, { mode: 0o600, flag: "wx" });
    const owner = { pid, token };
    writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return { path, owner };
  } catch (err) {
    if (object(err)?.code !== "EEXIST") throw err;
  }
  const lockStat = lstatSync(path);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink())
    throw new CliError(
      `setup lock at ${path} is not a real directory; inspect it before trying again`,
      "onboard-lock-path",
      EXIT_REFUSED,
    );
  const current = readLockOwner(path);
  const handoff = ctx.env.CATALYST_INSTALL_LOCK_TOKEN;
  if (current?.pid === pid && current.token !== "" && current.token === handoff)
    return { path, owner: current };
  const ownerIsAlive = current
    ? (deps.isProcessAlive ?? defaultAlive)(current.pid)
    : false;
  if (current && ownerIsAlive)
    throw new CliError(
      `setup is already running (pid ${current.pid}); wait for it to finish, then run the same command`,
      "onboard-locked",
      EXIT_FAILED,
    );
  if (!current)
    throw new CliError(
      "setup lock has no complete owner record; keep it until no setup process is running",
      "onboard-lock-incomplete",
      EXIT_REFUSED,
    );
  if (!removeStaleLock(path, current))
    throw new CliError(
      `setup lock at ${path} could not be safely reclaimed; inspect it and remove it only if no setup process is running`,
      "onboard-lock-stale",
      EXIT_REFUSED,
    );
  return acquireLock(ctx, deps);
}

function releaseLock(lock: { path: string; owner: LockOwner }): void {
  releaseOwnedLock(lock.path, lock.owner);
}

function journalStep(
  journal: OnboardJournal,
  id: OnboardStepId,
): OnboardStep | undefined {
  return journal.steps.find((step) => step.id === id);
}

function setStep(journal: OnboardJournal, step: OnboardStep): void {
  const index = journal.steps.findIndex((existing) => existing.id === step.id);
  if (index === -1) journal.steps.push(step);
  else journal.steps[index] = step;
}

function freshJournal(
  ctx: Ctx,
  cliVersion: string,
  deps: OnboardDeps,
): OnboardJournal {
  const now = isoNow(ctx, deps);
  return {
    schema: 1,
    runId: `${now.replace(/[-:.]/g, "").replace(/Z$/, "Z")}-${randomBytes(2).toString("hex")}`,
    installer: null,
    cli: cliVersion,
    tenant: null,
    exit: null,
    steps: [],
    changes: [],
  };
}

/** A refusal before loading state must not reuse or copy an unreadable receipt. */
export function onboardErrorJournal(
  ctx: Ctx,
  cliVersion: string,
  exit: number,
): OnboardJournal {
  return onboardJsonView(
    {
      ...freshJournal(ctx, cliVersion, {}),
      scope: "onboarding",
      mode: "run",
      exit,
      complete: false,
    },
    savedOnboardBaseUrl(ctx.home),
  );
}

function planJournal(journal: OnboardJournal): OnboardJournal {
  return {
    ...journal,
    exit: null,
    mode: "plan",
    complete: false,
    steps: ONBOARD_STEPS.map(
      (id) =>
        journal.steps.find((step) => step.id === id) ?? {
          id,
          state: "pending",
        },
    ),
  };
}

function printPlan(
  ctx: Ctx,
  journal: OnboardJournal,
  identity?: OnboardIdentity | null,
  options?: {
    localSync: boolean;
    scope: readonly OnboardStepId[];
    runner?: boolean;
    runnerDeclinedBy?: string;
  },
): void {
  ctx.stdout("Catalyst setup plan");
  if (identity !== undefined)
    for (const line of onboardIdentityLines(identity)) ctx.stdout(line);
  let group: string | undefined;
  // Beside --json and headless output: the numbers JSON actions carry (CTC-4680).
  for (const row of standalonePlan(
    journal,
    options?.scope,
    options?.runner,
    "json",
    options?.runnerDeclinedBy,
  )) {
    if (row.group !== group) {
      ctx.stdout("");
      ctx.stdout(row.group);
      group = row.group;
    }
    ctx.stdout(`  ${row.number} ${row.title}  ${row.detail}`);
  }
  ctx.stdout(
    standalonePlanNotes(options?.localSync ?? journal.localSync === true),
  );
}

async function confirmContinue(
  ctx: Ctx,
  args: ParsedArgs,
  deps: OnboardDeps,
): Promise<boolean> {
  if (args.flags.yes === true) return true;
  if (
    args.json ||
    !(
      deps.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
    )()
  ) {
    ctx.stderr(
      args.json
        ? "JSON mode needs --yes to accept the displayed setup plan. Pass --dry-run to inspect it."
        : "No terminal is attached. Pass --yes to accept the displayed setup plan, or --dry-run to inspect it.",
    );
    return false;
  }
  if (deps.confirm) return deps.confirm("Continue? [Y/n] ");
  try {
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    const readline = createInterface({ input, output, terminal: true });
    try {
      const answer = (await readline.question("Continue? [Y/n] "))
        .trim()
        .toLowerCase();
      return answer === "" || answer === "y" || answer === "yes";
    } finally {
      readline.close();
      input.destroy();
      output.end();
    }
  } catch {
    return false;
  }
}

function sanitizedResult(
  id: OnboardStepId,
  result: OnboardStepResult,
  at: string,
): OnboardStep {
  const row = normalizeStep(
    {
      id,
      ...result,
      state: result.state === "refused" ? "failed" : result.state,
      ...(result.state === "refused" ? { refused: true } : {}),
    },
    at,
  )!;
  row.at = at;
  return row;
}

/** CTC-4744: whether a step a later one depends on has settled. Only the cloud actively reading
 *  the settings (`required_values_unread`, after setup's own one-minute wait) holds a first
 *  ticket. A finished check that found missing values has settled: the first phase needs no
 *  values, and the missing ones are named. So has one that could not be checked at all (an older
 *  cloud, a cached contract): holding work on it would hold it for good. */
export function dependencySettled(step: OnboardStep | undefined): boolean {
  return (
    stepSatisfied(step) ||
    (step?.id === "values" &&
      step.state === "waiting" &&
      step.reason !== "required_values_unread" &&
      step.reason !== "interrupted")
  );
}

export function stepSatisfied(step: OnboardStep | undefined): boolean {
  return (
    step?.state === "done" ||
    (step?.state === "skipped" &&
      (step.id === "legacy" ||
        // Optional: a computer without the daily update still runs work.
        step.id === "housekeeping" ||
        step.reason === "member_scope" ||
        step.reason === "returning_workspace_move_on" ||
        (step.id === "daemon" && step.reason === "local_sync_not_selected") ||
        (step.id === "runner" && step.reason === "runner_not_selected") ||
        (step.id === "first-ticket" && step.reason === "first_ticket_skipped") ||
        (step.id === "linear.automations" &&
          step.reason === "automation_management_unavailable")))
  );
}

/** Optional work this computer or checkout cannot do. Work runs without it, so its wait never holds
 * a complete setup. */
const OPTIONAL_WAITS: ReadonlySet<string> = new Set([
  "settings_checkout_unverified",
  "settings_approval_unverified",
]);

/** Satisfied, or an optional wait. What a complete setup needs of every step. */
export function stepSettled(step: OnboardStep | undefined): boolean {
  return (
    stepSatisfied(step) ||
    (step?.state === "waiting" && OPTIONAL_WAITS.has(step.reason ?? ""))
  );
}

/** Steps whose wait does not hold a full run's exit code: work runs without them. A failure still
 * fails the run, and the receipt's `complete` still needs them settled. Never used for gating. */
export const ONBOARD_DEFERRED_STEPS: ReadonlySet<OnboardStepId> = new Set([
  "settings",
  "values",
  // Optional: work also runs on the workspace's other runner hosts.
  "runner",
  "housekeeping",
  "first-ticket",
]);

/** Readiness repeats earlier steps' checks. While a required step still waits, a failing readiness
 * check is that same wait, so readiness waits too instead of reporting a new failure. */
export function onboardRequiredStepsWaiting(
  journal: Pick<OnboardJournal, "steps"> | undefined,
): boolean {
  return !!journal?.steps.some(
    (step) =>
      step.id !== "ready" &&
      (!ONBOARD_DEFERRED_STEPS.has(step.id) ||
        (step.id === "runner" && step.evidence?.selected === true)) &&
      step.state !== "failed" &&
      !stepSatisfied(step),
  );
}

/** A full run that exited 0 with deferred steps still open: ready for work, not complete. */
export function onboardReadyForWork(
  journal: OnboardJournal,
  only?: OnboardStepId,
): boolean {
  return !only && journal.exit === 0 && !journal.complete &&
    !journal.steps.some(step => step.reason === "returning_workspace_move_on");
}

/** A recorded step's next action; a prerequisite wait names the first unfinished step it needs. */
export function onboardStepAction(
  journal: OnboardJournal | undefined,
  step: OnboardStep,
  baseUrl?: string,
): string {
  if (!step.reason) return "Not checked yet. Run catalyst onboard.";
  const waitsFor =
    journal &&
    (ONBOARD_DEPENDENCIES[step.id] ?? []).find(
      (parent) => !stepSatisfied(journalStep(journal, parent)),
    );
  return onboardReasonText(step, {
    baseUrl,
    journal,
    ...(waitsFor ? { waitsFor: ONBOARD_TITLES[waitsFor] } : {}),
  });
}

/** "<title>: <action>" for each recorded step still blocking onboarding, then the first-ticket hint
 * once the steps a ticket needs are done. Display only: completeness and exits stay with the engine. */
export function onboardNextActions(
  journal: OnboardJournal,
  baseUrl?: string,
  only?: OnboardStepId,
): string[] {
  const lines = journal.steps
    .filter((step) => (!only || step.id === only) && !stepSatisfied(step))
    .sort((a, b) => ONBOARD_STEPS.indexOf(a.id) - ONBOARD_STEPS.indexOf(b.id))
    .map(
      (step) =>
        `${ONBOARD_TITLES[step.id]}: ${onboardStepAction(journal, step, baseUrl)}`,
    );
  // A waiting first ticket already says to move a ticket, in its own line.
  const firstTicket = journalStep(journal, "first-ticket");
  if (
    (["projects", "accounts", "linear.adopt", "capacity"] as const).every(
      (id) => journalStep(journal, id)?.state === "done",
    ) &&
    firstTicket?.state !== "waiting"
  )
    lines.push(
      `Move a ticket in ${onboardTeamKey(journal) ?? "<TEAM KEY>"} to ${dispatchStageName(firstTicket?.evidence?.stage)}; \`catalyst explain <ticket>\` says why it is or is not starting.`,
    );
  return lines;
}

function requireMatchingIdentity(
  journal: OnboardJournal,
  identity: OnboardIdentity | null,
): void {
  const account = journal.account ?? journal.tenant;
  if (
    (account && (!identity || account !== identity.account)) ||
    (journal.membershipId && journal.membershipId !== identity?.membershipId) ||
    (journal.baseUrl && journal.baseUrl !== identity?.baseUrl)
  )
    throw new CliError(
      "this setup belongs to another workspace or member; sign in with the original account to resume",
      "onboard-identity-mismatch",
      EXIT_REFUSED,
    );
  if (identity) {
    journal.account = identity.account;
    journal.tenant = identity.account;
    journal.membershipId = identity.membershipId;
    journal.baseUrl = identity.baseUrl;
  }
}

/** The receipt records progress; adapters verify the current state before any resumed action. */
export async function cmdOnboard(
  args: ParsedArgs,
  ctx: Ctx,
  deps: OnboardDeps = {},
  cliVersion = "0.13.1",
): Promise<number> {
  if (args.subcommand !== null || args.rest.length > 0)
    throw new UsageError("onboard takes no positional arguments");
  if (
    args.json ||
    (args.flags.yes === true &&
      !deps.reviewedSetup &&
      deps.ui?.interactive !== false) ||
    args.flags["dry-run"] === true
  )
    deps = { ...deps, ui: undefined };
  const interactiveUi = Boolean(deps.ui && deps.ui.interactive !== false);
  let activeRunSignal: AbortSignal | undefined;
  if (args.json) {
    const output = ctx.stdout;
    ctx = {
      ...ctx,
      stdout: (line: string) => {
        const value = JSON.parse(line) as OnboardJournal;
        const paused = Boolean(
          activeRunSignal?.aborted ||
          deps.signal?.aborted ||
          deps.ui?.signal.aborted,
        );
        output(
          JSON.stringify(
            onboardJsonView(value, savedOnboardBaseUrl(ctx.home), paused, {
              requiredSteps: args.flags.runner === true ? ["runner"] : [],
              only:
                typeof args.flags.only === "string"
                  ? (args.flags.only as OnboardStepId)
                  : undefined,
            }),
          ),
        );
      },
    };
  }
  const only =
    typeof args.flags.only === "string"
      ? (args.flags.only as OnboardStepId)
      : undefined;
  // A member's values check reads the selected team, so without --team it waits on the same skip.
  const memberScopeSkips = (id: OnboardStepId) =>
    ADMIN_STEPS.has(id) ||
    ((id === "linear.team" || id === "values") &&
      only !== id &&
      typeof args.flags.team !== "string");
  const resume =
    typeof args.flags["resume-from"] === "string"
      ? args.flags["resume-from"]
      : undefined;
  const resumeFrom =
    resume === "install" ? "signin" : (resume as OnboardStepId | undefined);
  for (const id of [only, resumeFrom])
    if (id && !(ONBOARD_STEPS as readonly string[]).includes(id))
      throw new UsageError(`unknown onboarding step: ${id}`);
  const reviewedScope = new Set<OnboardStepId>();
  const includeReviewed = (id: OnboardStepId): void => {
    if (reviewedScope.has(id)) return;
    reviewedScope.add(id);
    for (const dependency of ONBOARD_DEPENDENCIES[id] ?? [])
      includeReviewed(dependency);
  };
  if (only) includeReviewed(only);
  else for (const id of ONBOARD_STEPS) reviewedScope.add(id);
  const planOptions = (journal: OnboardJournal) => ({
    runner:
      args.flags.runner === true
        ? true
        : args.flags["no-runner"] === true
          ? false
          : undefined,
    // Headless turns --runner no and CATALYST_ONBOARD_RUNNER=no into --no-runner; say which.
    runnerDeclinedBy:
      args.flags.headless === true
        ? "the headless runner input is no"
        : "--no-runner was passed",
    localSync: args.flags["local-sync"] === true || journal.localSync === true,
    scope: ONBOARD_STEPS.filter((id) => reviewedScope.has(id)),
  });
  const bootstrap = deps.bootstrap;
  const bootstrapPlan = bootstrap
    ? parseBootstrapPlan(bootstrap.plan)
    : undefined;
  const reviewedBootstrapHash = bootstrapPlan
    ? bootstrapPlanHash(bootstrapPlan)
    : undefined;
  if (
    bootstrapPlan &&
    (only ||
      resumeFrom ||
      bootstrapPlan.home !== ctx.home ||
      bootstrapPlan.statePath !== onboardStatePath(ctx.home, ctx.env))
  )
    throw new CliError(
      "The staged installation belongs to another setup path. Run setup again.",
      "onboard-bootstrap-binding",
      EXIT_REFUSED,
    );
  const requireBootstrapIdentity = (identity: OnboardIdentity | null) => {
    if (
      bootstrapPlan &&
      (!identity || identity.baseUrl !== bootstrapPlan.origin)
    )
      throw new CliError(
        "The staged installation and verified person use different clouds. Run setup again.",
        "onboard-bootstrap-binding",
        EXIT_REFUSED,
      );
  };
  const showBootstrap = () => {
    if (!bootstrapPlan) return;
    for (const line of bootstrapPlanLines(bootstrapPlan)) {
      if (deps.ui) deps.ui.message(line);
      else ctx.stderr(line);
    }
  };
  const recheckBootstrap = async () => {
    if (!bootstrap || !bootstrapPlan) return;
    if (bootstrapPlanHash(bootstrap.plan) !== reviewedBootstrapHash)
      throw new CliError(
        "The installation plan changed during review. Run setup again.",
        "onboard-bootstrap-changed",
        EXIT_WAITING,
      );
    await bootstrap.recheck();
    if (bootstrapPlanHash(bootstrap.plan) !== reviewedBootstrapHash)
      throw new CliError(
        "The installation plan changed during review. Run setup again.",
        "onboard-bootstrap-changed",
        EXIT_WAITING,
      );
  };
  const statePath = onboardStatePath(ctx.home, ctx.env);
  const reviewedReceipt = deps.stageSignin
    ? onboardFileSnapshot(statePath)
    : undefined;
  const scopeNeedsSignin = (id: OnboardStepId): boolean =>
    id === "signin" || (ONBOARD_DEPENDENCIES[id] ?? []).some(scopeNeedsSignin);
  const personalScope = !only || scopeNeedsSignin(only);
  const plainSigninAllowed =
    personalScope &&
    (args.flags.yes === true ||
      (!args.json &&
        (
          deps.isTty ??
          (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
        )()));
  let journal =
    readOnboardJournal(statePath, cliVersion, (deps.now ?? ctx.now)()) ??
    freshJournal(ctx, cliVersion, deps);
  const originalBinding = {
    account: journal.account,
    tenant: journal.tenant,
    membershipId: journal.membershipId,
    baseUrl: journal.baseUrl,
  };
  const wasBound = Boolean(
    journal.account ||
    journal.tenant ||
    journal.membershipId ||
    journal.baseUrl,
  );
  if (args.flags["dry-run"] === true) {
    if (args.json) ctx.stdout(JSON.stringify(planJournal(journal)));
    else printPlan(ctx, journal, undefined, planOptions(journal));
    showBootstrap();
    if (!args.json)
      ctx.stdout(`Next: run catalyst onboard${only ? ` --only ${only}` : ""}`);
    return 0;
  }
  // Check tenant binding before even a local cleanup mutation. Never overwrite a mismatched receipt.
  let identity: OnboardIdentity | null = null;
  try {
    if (deps.identity) {
      identity = await deps.identity(journal);
      requireMatchingIdentity(journal, identity);
    }
  } catch (error) {
    const canRenew =
      error instanceof CliError &&
      error.code === "onboard-login-refresh-required" &&
      deps.stageSignin &&
      (interactiveUi || plainSigninAllowed);
    if (!canRenew) {
      const code = error instanceof CliError ? error.exitCode : EXIT_FAILED;
      ctx.stderr(
        error instanceof CliError &&
          error.code === "onboard-login-refresh-required"
          ? "Renew your login with catalyst login, then run catalyst onboard. Setup was not changed."
          : "Could not verify your Catalyst membership. Setup was not changed. Sign in with the original account to resume.",
      );
      if (args.json)
        ctx.stdout(
          JSON.stringify({
            ...journal,
            mode: "run",
            exit: code,
            errorCode: error instanceof CliError ? error.code : undefined,
            complete: false,
          }),
        );
      return code;
    }
    const renewalMessage =
      "Your saved login needs renewal. Sign in before reviewing this plan.";
    if (deps.ui) deps.ui.message(renewalMessage);
    else ctx.stderr(renewalMessage);
  }
  const identityTuple = (value: OnboardIdentity | null) =>
    value
      ? Object.freeze({
          account: value.account,
          membershipId: value.membershipId,
          baseUrl: value.baseUrl,
          role: value.role,
        })
      : null;
  let reviewedIdentity = identityTuple(identity);
  if (identity) requireBootstrapIdentity(identity);
  if (deps.ui) deps.ui.plan(journal, identity, planOptions(journal));
  else if (!args.json) printPlan(ctx, journal, identity, planOptions(journal));
  else
    printPlan(
      { ...ctx, stdout: ctx.stderr },
      journal,
      identity,
      planOptions(journal),
    );
  showBootstrap();
  let localSync =
    args.flags["local-sync"] === true || journal.localSync === true;
  let candidate:
    import("./onboard-login-candidate.js").OnboardLoginCandidate | null = null;
  // A fresh interactive sign-in needs browser approval, then one review of the verified
  // person and workspace. Do not ask to approve a plan whose identity is still unknown.
  if (
    !identity &&
    deps.stageSignin &&
    !interactiveUi &&
    personalScope &&
    !plainSigninAllowed
  ) {
    ctx.stderr(
      "Sign in with catalyst login, then run catalyst onboard, or use --yes to allow browser sign-in before the displayed setup plan.",
    );
    if (args.json)
      ctx.stdout(
        JSON.stringify({ ...planJournal(journal), exit: EXIT_WAITING }),
      );
    return EXIT_WAITING;
  }
  const stageFirst = Boolean(
    deps.stageSignin && !identity && (interactiveUi || plainSigninAllowed),
  );
  if (stageFirst) {
    const message = deps.reviewedSetup
      ? "Sign in in your browser to continue setup."
      : "Sign in in your browser first. Then review your person, workspace and setup plan. Your saved connection stays unchanged until you approve that plan.";
    if (deps.ui) deps.ui.message(message);
    else ctx.stderr(message);
  }
  let consent:
    boolean | { proceed: boolean; localSync: boolean; signin?: boolean } =
    stageFirst
      ? { proceed: false, localSync, signin: true }
      : deps.ui && interactiveUi
        ? await deps.ui.confirmPlan(
            localSync,
            deps.stageSignin
              ? identity
                ? "saved"
                : "required"
              : "unavailable",
          )
        : await confirmContinue(ctx, args, deps);
  if (typeof consent !== "boolean" && consent.signin) {
    if (!deps.stageSignin) throw new Error("onboard_signin_stage_unavailable");
    try {
      const stagingSignals = [
        ...(deps.ui ? [deps.ui.signal] : []),
        ...(deps.signal ? [deps.signal] : []),
      ];
      const stagingSignal =
        stagingSignals.length > 1
          ? AbortSignal.any(stagingSignals)
          : stagingSignals[0];
      if (stagingSignal?.aborted)
        throw new CliError(
          "Sign-in was cancelled. Your saved connection was not changed.",
          "onboard-signin-cancelled",
          EXIT_WAITING,
        );
      candidate = await deps.stageSignin(stagingSignal);
      // A saved receipt may renew only its existing identity. A fresh preview can change it.
      if (wasBound)
        requireMatchingIdentity(
          { ...journal, ...originalBinding },
          candidate.identity,
        );
      else
        Object.assign(journal, {
          account: undefined,
          tenant: null,
          membershipId: undefined,
          baseUrl: undefined,
        });
      identity = candidate.identity;
      reviewedIdentity = identityTuple(identity);
      requireMatchingIdentity(journal, identity);
      requireBootstrapIdentity(identity);
      deps.ui?.stagedSigninEnd?.("done");
      if (deps.ui) deps.ui.plan(journal, identity, planOptions(journal));
      else if (!args.json)
        printPlan(ctx, journal, identity, planOptions(journal));
      else
        printPlan(
          { ...ctx, stdout: ctx.stderr },
          journal,
          identity,
          planOptions(journal),
        );
      showBootstrap();
      consent =
        deps.ui && interactiveUi
          ? await deps.ui.confirmPlan(localSync, "unavailable")
          : await confirmContinue(ctx, args, deps);
    } catch (error) {
      const message =
        error instanceof CliError
          ? error.message
          : "Sign-in could not be verified. Your saved connection was not changed.";
      const code = error instanceof CliError ? error.exitCode : EXIT_WAITING;
      const rendered = deps.ui?.stagedSigninEnd?.(
        code === EXIT_WAITING ? "waiting" : "failed",
        message,
      );
      if (!rendered) {
        if (deps.ui) deps.ui.message(message);
        else ctx.stderr(message);
      }
      deps.ui?.dispose();
      if (args.json)
        ctx.stdout(JSON.stringify({ ...planJournal(journal), exit: code }));
      return code;
    }
  }
  if (typeof consent !== "boolean") localSync = consent.localSync;
  if (!(typeof consent === "boolean" ? consent : consent.proceed)) {
    const missingConsent =
      !interactiveUi &&
      args.flags.yes !== true &&
      (args.json ||
        !(
          deps.isTty ??
          (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
        )());
    const code = deps.ui?.signal.aborted || missingConsent ? EXIT_WAITING : 0;
    ctx.stderr(
      missingConsent
        ? "Setup is waiting for your approval. Run with --yes to accept the displayed plan."
        : "Nothing was changed. Run the same command when ready.",
    );
    if (args.json)
      ctx.stdout(JSON.stringify({ ...journal, exit: code, complete: false }));
    return code;
  }
  if (bootstrap) requireBootstrapIdentity(identity);
  await recheckBootstrap();
  let lock: { path: string; owner: LockOwner };
  try {
    lock = acquireLock(ctx, deps);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.stderr(error.message);
    if (args.json)
      ctx.stdout(
        JSON.stringify({ ...planJournal(journal), exit: error.exitCode, errorCode: error.code }),
      );
    return error.exitCode;
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([
    stop.signal,
    ...(deps.signal ? [deps.signal] : []),
    ...(deps.ui ? [deps.ui.signal] : []),
  ]);
  activeRunSignal = signal;
  const stepCtx = {
    ...ctx,
    stdout: deps.ui
      ? (line: string) => deps.ui!.message(line)
      : args.json
        ? ctx.stderr
        : ctx.stdout,
    stderr: deps.ui ? (line: string) => deps.ui!.message(line) : ctx.stderr,
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      ctx.fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      })) as typeof fetch,
  };
  let current: OnboardStepId | null = null;
  let mayRecordProgress = candidate === null;
  const recordStep = (next: OnboardStep) => {
    const prior = journalStep(journal, next.id);
    // Once a create was sent, generic capability, identity, scope and interruption results
    // cannot erase the recovery key. Only a verified selection or explicit team evidence can
    // replace it. This also retains a confirmed team's ID while adoption remains unfinished.
    if (
      next.id === "linear.team" &&
      next.state !== "done" &&
      !next.evidence?.teamKey &&
      (prior?.reason === "team_create_unverified" ||
        prior?.reason === "team_created_not_adopted") &&
      prior.evidence?.teamKey
    )
      setStep(journal, { ...prior, state: "waiting", at: next.at });
    else setStep(journal, next);
  };
  const interruptStep = (id: OnboardStepId) =>
    recordStep({
      id,
      state: "failed",
      reason: "interrupted",
      at: isoNow(ctx, deps),
    });
  const interrupted = () => {
    stop.abort();
    if (!mayRecordProgress) return;
    if (current) interruptStep(current);
    journal.exit = EXIT_WAITING;
    journal.complete = false;
    try {
      writeOnboardJournal(statePath, journal);
    } catch {
      /* keep the last atomic receipt */
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  if (deps.bindSignals !== false && deps.ui?.handlesSignals !== true)
    for (const name of signals) process.on(name, interrupted);
  const finish = (code: number) => {
    journal.exit = code;
    journal.complete =
      !only &&
      code === 0 &&
      ONBOARD_STEPS.every((id) => stepSettled(journalStep(journal, id)));
    writeOnboardJournal(statePath, journal);
    if (args.json) ctx.stdout(JSON.stringify(journal));
    else if (deps.ui) deps.ui.finish(journal, only);
    else {
      if (journal.complete && journal.steps.some(step => step.reason === "returning_workspace_move_on")) {
        ctx.stdout("This computer is set up. Existing projects were kept in place.");
        ctx.stdout("Next: run catalyst ready to review their checks.");
      } else if (journal.complete) ctx.stdout("Onboarding complete.");
      else if (
        onboardReadyForWork(journal, only) &&
        (deps.requiredSteps ?? []).every((id) => journalStep(journal, id)?.state === "done")
      ) {
        ctx.stdout("Ready for work.");
        ctx.stdout("Next, when you want:");
        for (const line of onboardNextActions(
          journal,
          savedOnboardBaseUrl(ctx.home),
        ))
          ctx.stdout(line);
      } else if (only && code === 0)
        ctx.stdout(
          `${ONBOARD_TITLES[only]} finished. Onboarding still has other steps.`,
        );
      else {
        ctx.stdout(
          `Setup still needs ${journal.steps.filter((step) => !stepSatisfied(step) ||
            (deps.requiredSteps?.includes(step.id) && step.state !== "done")).length} checks.`,
        );
        for (const line of onboardNextActions(
          journal,
          savedOnboardBaseUrl(ctx.home),
          only,
        ))
          ctx.stdout(line);
      }
      ctx.stdout(
        bootstrap && journalStep(journal, "machine")?.state !== "done"
          ? "resume: run the original setup command"
          : "resume: catalyst onboard",
      );
    }
    return code;
  };
  try {
    await recheckBootstrap();
    if (candidate) {
      // Re-read while holding the receipt lock before accepting the staged connection. Config
      // and receipt publication are ordered, not a promised transaction against other writers.
      if (onboardFileSnapshot(statePath) !== reviewedReceipt)
        throw new CliError(
          "Your setup record changed during review. Run catalyst onboard again.",
          "onboard-receipt-changed",
          EXIT_WAITING,
        );
      const currentReceipt = readOnboardJournal(
        statePath,
        cliVersion,
        (deps.now ?? ctx.now)(),
      );
      if (currentReceipt)
        requireMatchingIdentity(currentReceipt, candidate.identity);
      try {
        await candidate.accept(signal, () => {
          if (onboardFileSnapshot(statePath) !== reviewedReceipt)
            throw new CliError(
              "Your setup record changed during sign-in. Run catalyst onboard again.",
              "onboard-receipt-changed",
              EXIT_WAITING,
            );
        });
      } catch (error) {
        ctx.stderr(
          candidate.accepted
            ? "Your connection was accepted, but setup could not be recorded. Run catalyst onboard to resume."
            : error instanceof CliError
              ? error.message
              : "Sign-in was not accepted. Your saved connection was not changed.",
        );
        if (args.json)
          ctx.stdout(
            JSON.stringify({ ...planJournal(journal), exit: EXIT_WAITING }),
          );
        return EXIT_WAITING;
      }
    }
    if (candidate && onboardFileSnapshot(statePath) !== reviewedReceipt)
      throw new CliError(
        "Your setup record changed during sign-in. Run catalyst onboard again.",
        "onboard-receipt-changed",
        EXIT_WAITING,
      );
    journal =
      readOnboardJournal(statePath, cliVersion, (deps.now ?? ctx.now)()) ??
      journal;
    if (deps.identity) requireMatchingIdentity(journal, identity);
    journal.cli = cliVersion;
    journal.scope = only ? "step" : "onboarding";
    journal.mode = "run";
    journal.localSync = localSync;
    for (const id of ONBOARD_STEPS)
      if (!journalStep(journal, id)) setStep(journal, { id, state: "pending" });
    journal.steps.sort(
      (a, b) => ONBOARD_STEPS.indexOf(a.id) - ONBOARD_STEPS.indexOf(b.id),
    );
    journal.operations ??= {};
    if (candidate) {
      writeOnboardJournal(statePath, journal);
      mayRecordProgress = true;
    }
    if (bootstrap && bootstrapPlan && reviewedBootstrapHash) {
      if (!identity || identity.baseUrl !== bootstrapPlan.origin)
        throw new CliError(
          "The staged installation and verified person use different clouds. Run setup again.",
          "onboard-bootstrap-binding",
          EXIT_REFUSED,
        );
      if (signal.aborted) return finish(EXIT_WAITING);
      await recheckBootstrap();
      if (!deps.identity || !reviewedIdentity)
        throw new CliError(
          "The verified person could not be checked before installation. Run setup again.",
          "onboard-bootstrap-identity",
          EXIT_WAITING,
        );
      const beforeConfig = onboardFileSnapshot(configPathFor(ctx.home));
      const freshIdentity = await deps.identity(journal);
      if (
        !freshIdentity ||
        beforeConfig !== onboardFileSnapshot(configPathFor(ctx.home)) ||
        freshIdentity.account !== reviewedIdentity.account ||
        freshIdentity.membershipId !== reviewedIdentity.membershipId ||
        freshIdentity.baseUrl !== reviewedIdentity.baseUrl ||
        freshIdentity.role !== reviewedIdentity.role
      )
        throw new CliError(
          "Your person or workspace changed during review. Run setup again.",
          "onboard-bootstrap-identity",
          EXIT_REFUSED,
        );
      requireMatchingIdentity(journal, freshIdentity);
      identity = freshIdentity;
      if (signal.aborted) return finish(EXIT_WAITING);
      bootstrap.assertCurrent();
      // The capability stays in native memory; the child protocol must transport it over a private FD.
      // The continuation contract joins owned children before returning, so finally cannot release early.
      current = "machine";
      setStep(journal, {
        id: "machine",
        state: "running",
        at: isoNow(ctx, deps),
      });
      writeOnboardJournal(statePath, journal);
      try {
        await bootstrap.continue(
          Object.freeze({
            plan: bootstrapPlan,
            planHash: reviewedBootstrapHash,
            account: identity.account,
            person: identity.membershipId,
            origin: identity.baseUrl,
            role: identity.role,
            localSync,
            runId: journal.runId,
            lockPath: lock.path,
            ownerPid: lock.owner.pid,
            ownerToken: lock.owner.token,
          }),
          signal,
        );
      } catch {
        setStep(journal, {
          id: "machine",
          state: signal.aborted ? "waiting" : "failed",
          reason: signal.aborted ? "interrupted" : "bootstrap_install_failed",
          at: isoNow(ctx, deps),
        });
        ctx.stderr(
          "Installation stopped. Completed files remain. Run the original setup command to resume.",
        );
        return finish(signal.aborted ? EXIT_WAITING : EXIT_FAILED);
      }
      current = null;
      if (signal.aborted) {
        setStep(journal, {
          id: "machine",
          state: "waiting",
          reason: "interrupted",
          at: isoNow(ctx, deps),
        });
        return finish(EXIT_WAITING);
      }
      if (deps.identity) {
        const refreshed = await deps.identity(journal);
        requireMatchingIdentity(journal, refreshed);
        identity = refreshed;
      }
    }
    const needed = new Set<OnboardStepId>();
    const include = (id: OnboardStepId): void => {
      if (needed.has(id)) return;
      needed.add(id);
      for (const parent of ONBOARD_DEPENDENCIES[id] ?? []) include(parent);
    };
    if (only) include(only);
    else for (const id of ONBOARD_STEPS) needed.add(id);
    const fromIndex = resumeFrom ? ONBOARD_STEPS.indexOf(resumeFrom) : 0;
    let rerun: ReadonlySet<OnboardStepId> | null = null;
    for (;;) {
      let refused = false;
      for (const id of ONBOARD_STEPS.filter(
        (id) => needed.has(id) && (!rerun || rerun.has(id)),
      )) {
        if (signal.aborted) return finish(EXIT_WAITING);
        // No step is running while the session refreshes, so an interrupt here marks none of them.
        current = null;
        await deps.beforeStep?.(id);
        if (signal.aborted) return finish(EXIT_WAITING);
        current = id;
        deps.ui?.stepStart(id);
        const stepSignal = deps.ui?.stepSignal
          ? AbortSignal.any([signal, deps.ui.stepSignal])
          : signal;
        // Member onboarding keeps administration outside its scope, with an explicit recorded reason.
        if (identity?.role === "member" && memberScopeSkips(id)) {
          recordStep({
            id,
            state: "skipped",
            reason: "member_scope",
            ...(id === "runner" && args.flags.runner === true
              ? { evidence: { selected: true } }
              : {}),
            at: isoNow(ctx, deps),
          });
          deps.ui?.stepEnd(journalStep(journal, id)!, journal);
          continue;
        }
        const missing = (ONBOARD_DEPENDENCIES[id] ?? []).find(
          (parent) => !dependencySettled(journalStep(journal, parent)),
        );
        if (missing) {
          recordStep({
            id,
            state: "waiting",
            reason: "prerequisite_not_ready",
            at: isoNow(ctx, deps),
          });
          writeOnboardJournal(statePath, journal);
          deps.ui?.stepEnd(journalStep(journal, id)!, journal);
          continue;
        }
        let adapter = deps.adapters?.[id];
        // Compatibility for the initial legacy adapter, which performs its own before/after checks.
        if (!adapter && id === "legacy") {
          let result: OnboardStepResult = deps.runStep
            ? { state: "pending" }
            : { state: "skipped", reason: "legacy_not_selected" };
          adapter = {
            check: async () => result,
            act: deps.runStep
              ? async () => (result = await deps.runStep!(id, stepCtx))
              : undefined,
          };
        }
        if (!adapter) {
          recordStep({
            id,
            state: "waiting",
            reason: "step_not_available_in_this_release",
            at: isoNow(ctx, deps),
          });
          writeOnboardJournal(statePath, journal);
          deps.ui?.stepEnd(journalStep(journal, id)!, journal);
          continue;
        }
        try {
          let result = await adapter.check(stepCtx, journal, stepSignal);
          if (
            result.state === "pending" &&
            adapter.act &&
            (!only || id === only) &&
            ONBOARD_STEPS.indexOf(id) >= fromIndex
          ) {
            if (deps.identity) {
              identity = await deps.identity(journal);
              requireMatchingIdentity(journal, identity);
              if (identity?.role === "member" && memberScopeSkips(id)) {
                recordStep({
                  id,
                  state: "skipped",
                  reason: "member_scope",
                  at: isoNow(ctx, deps),
                });
                writeOnboardJournal(statePath, journal);
                deps.ui?.stepEnd(journalStep(journal, id)!, journal);
                continue;
              }
            }
            journal.operations[id] ??= `${journal.runId}:${id}`;
            const prior = journalStep(journal, id);
            const recoveringTeam =
              id === "linear.team" &&
              (prior?.reason === "team_create_unverified" ||
                prior?.reason === "team_created_not_adopted");
            recordStep({
              ...(recoveringTeam ? prior : {}),
              id,
              state: "running",
              at: isoNow(ctx, deps),
            });
            journal.exit = null;
            writeOnboardJournal(statePath, journal);
            const action = await adapter.act(stepCtx, journal, stepSignal);
            if (action.state === "done") {
              result = await adapter.check(stepCtx, journal, stepSignal);
              if (result.state === "pending")
                result = { state: "waiting", reason: "verification_pending" };
            } else result = action;
            if (id === "signin" && result.state === "done" && deps.identity) {
              identity = await deps.identity(journal);
              requireMatchingIdentity(journal, identity);
              if (identity?.role === "member" && memberScopeSkips(id)) {
                recordStep({
                  id,
                  state: "skipped",
                  reason: "member_scope",
                  at: isoNow(ctx, deps),
                });
                writeOnboardJournal(statePath, journal);
                deps.ui?.stepEnd(journalStep(journal, id)!, journal);
                continue;
              }
            }
          }
          if (id === "signin" && result.state === "done" && deps.identity) {
            identity = await deps.identity(journal);
            requireMatchingIdentity(journal, identity);
            if (!identity)
              result = { state: "failed", reason: "membership_not_verified" };
            else
              for (const line of onboardIdentityLines(identity))
                stepCtx.stdout(line);
          }
          if (result.state === "refused") refused = true;
          if (result.state === "pending")
            result = {
              ...result,
              state: "waiting",
              reason: result.reason ?? "action_required",
            };
          recordStep(sanitizedResult(id, result, isoNow(ctx, deps)));
        } catch (error) {
          if (error instanceof CliError && error.exitCode === EXIT_REFUSED)
            refused = true;
          const reason = stepSignal.aborted
            ? "interrupted"
            : error instanceof CliError &&
                /^[a-z][a-z0-9_-]{1,63}$/.test(error.code)
              ? error.code.replaceAll("-", "_")
              : "step_failed";
          const renewLogin =
            error instanceof CliError &&
            error.code === "onboard-login-refresh-required";
          recordStep({
            id,
            state: renewLogin || stepSignal.aborted ? "waiting" : "failed",
            ...(error instanceof CliError && error.exitCode === EXIT_REFUSED && !stepSignal.aborted ? { refused: true as const } : {}),
            reason,
            at: isoNow(ctx, deps),
          });
          stepCtx.stderr(
            renewLogin
              ? "Renew your login with catalyst login, then run catalyst onboard to resume."
              : `✗ ${ONBOARD_TITLES[id]}: ${reason}. The safe reason is saved; run the same command to resume.`,
          );
        }
        if (signal.aborted) {
          const settled = journalStep(journal, id);
          // CTC-4680 round 5: a person who stopped at "Ready to try again?" stopped a step whose link
          // timed out; keep that reason so the summary says so, not "skipped for now".
          if (
            settled?.state !== "done" &&
            settled?.state !== "failed" &&
            !TIMED_OUT_REASONS.has(settled?.reason ?? "")
          )
            recordStep({
              id,
              state: "waiting",
              reason: "interrupted",
              at: isoNow(ctx, deps),
            });
          deps.ui?.stepEnd(journalStep(journal, id)!, journal);
          return finish(EXIT_WAITING);
        }
        deps.ui?.stepEnd(journalStep(journal, id)!, journal);
        writeOnboardJournal(statePath, journal);
        // Later steps share the same login; preserve the actionable cause instead of cascading failures.
        if (
          journalStep(journal, id)?.reason?.endsWith("_login_refresh_required")
        )
          return finish(EXIT_WAITING);
        if (refused) break;
      }
      current = null;
      const scope = only ? [only] : [...ONBOARD_STEPS];
      const requiredStepRefused = scope.some(
        (id) => deps.requiredSteps?.includes(id) && journalStep(journal, id)?.reason === "member_scope",
      );
      const required = new Set(deps.requiredSteps ?? []);
      if (args.flags.runner === true || journalStep(journal, "runner")?.evidence?.selected === true)
        required.add("runner");
      const code = refused || requiredStepRefused
        ? EXIT_REFUSED
        : [...needed].some((id) => journalStep(journal, id)?.state === "failed")
          ? EXIT_FAILED
          : scope.every(
                (id) =>
                  (stepSatisfied(journalStep(journal, id)) &&
                    !(required.has(id) && journalStep(journal, id)?.state !== "done")) ||
                  (!only &&
                    ONBOARD_DEFERRED_STEPS.has(id) &&
                    !required.has(id)),
              )
            ? 0
            : EXIT_WAITING;
      journal.exit = code;
      journal.complete =
        !only &&
        code === 0 &&
        ONBOARD_STEPS.every((id) => stepSettled(journalStep(journal, id)));
      const unfinished = journal.steps.filter((step) => !stepSatisfied(step));
      if (
        !only &&
        !refused &&
        unfinished.length &&
        !signal.aborted &&
        (await deps.ui?.checkAgain?.(journal))
      ) {
        rerun = new Set([...unfinished.map((step) => step.id), "ready"]);
        continue;
      }
      return finish(signal.aborted ? EXIT_WAITING : code);
    }
  } catch (error) {
    if (candidate?.accepted && !mayRecordProgress) {
      ctx.stderr(
        "Your connection was accepted, but setup could not be recorded. Run catalyst onboard to resume.",
      );
      if (args.json)
        ctx.stdout(
          JSON.stringify({ ...planJournal(journal), exit: EXIT_WAITING }),
        );
      return EXIT_WAITING;
    }
    // Identity can change while the lock is held; stop before the next action.
    if (error instanceof CliError) {
      ctx.stderr(error.message);
      if (args.json)
        ctx.stdout(
          JSON.stringify({ ...planJournal(journal), exit: error.exitCode, errorCode: error.code }),
        );
      return error.exitCode;
    }
    throw error;
  } finally {
    if (deps.bindSignals !== false && deps.ui?.handlesSignals !== true)
      for (const name of signals) process.off(name, interrupted);
    releaseLock(lock);
    deps.ui?.dispose();
  }
}
