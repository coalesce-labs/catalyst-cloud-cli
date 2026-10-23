// onboard-headless.ts — `catalyst onboard --headless` (CTC-4633): setup for CI, image builds and agent
// VMs, where every browser grant already exists. Inputs come only from flags, env or files; nothing
// prompts, nothing opens a browser, stdout carries one JSON document, and the exit code is 0/10/11/12
// with each missing item named. The key is read from env or a file and never printed.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { ParsedArgs } from "./args.js";
import {
  DEFAULT_BASE_URL,
  loadConfig,
  normalizeBaseUrl,
  type Ctx,
} from "./config.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { onboardReasonText } from "./onboard-next.js";
import { onboardJsonView } from "./setup-onboard-copy.js";
import { fetchMe } from "./transport.js";
import {
  ONBOARD_DEFERRED_STEPS,
  ONBOARD_DEPENDENCIES,
  ONBOARD_STEPS,
  onboardErrorJournal,
  onboardStatePath,
  readOnboardJournal,
  type OnboardAdapter,
  type OnboardDeps,
  type OnboardJournal,
  type OnboardStepId,
} from "./onboard.js";

export const ONBOARD_HEADLESS_SCHEMA = "catalyst-onboard-headless/1";
const EXIT_FAILED = 10;
const EXIT_WAITING = 11;
const EXIT_REFUSED = 12;
const KEY_FILE_MAX_BYTES = 16 * 1024;
const slotPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** One thing standing between this run and exit 0. `text` is a full sentence ending in the fix. */
export interface HeadlessItem {
  id: string;
  kind: "input" | "grant" | "step";
  reason: string;
  text: string;
  flag?: string;
  env?: string;
  url?: string;
}

export interface HeadlessReport {
  schema: typeof ONBOARD_HEADLESS_SCHEMA;
  /** Where each input came from. The key is reported only by its source, never its value. */
  inputs: {
    accountKey: "file" | "env" | "saved" | null;
    baseUrl: string;
    team: string | null;
    repos: string[];
    codingAccount: string | null;
    runner: "yes" | "no" | null;
  };
  /** Exit 11: supply these, then run the same command. */
  missing: HeadlessItem[];
  /** Exit 12: setup will not do what was asked. */
  refused: HeadlessItem[];
  /** Exit 10: a step failed. */
  failed: HeadlessItem[];
  /** Steps that do not hold the exit code; work runs without them. */
  deferred: HeadlessItem[];
  warnings: string[];
}

export function onboardHeadlessRequested(
  args: Pick<ParsedArgs, "flags">,
  env: NodeJS.ProcessEnv,
): boolean {
  return args.flags.headless === true || env.CATALYST_ONBOARD_HEADLESS === "1";
}

/** True for an argv the parser refused that still asked for headless, so it answers in its contract. */
export function argvRequestsHeadless(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    argv.includes("onboard") &&
    (argv.includes("--headless") || env.CATALYST_ONBOARD_HEADLESS === "1")
  );
}

const pages = (baseUrl: string) => {
  const web = normalizeBaseUrl(baseUrl);
  return {
    keys: `${web}/settings/api-keys`,
    connections: `${web}/a/account/connections`,
    personal: `${web}/settings/connected-accounts`,
    teams: `${web}/settings/projects`,
    repos: `${web}/settings/projects`,
    codingAccounts: `${web}/settings/coding-accounts`,
  };
};

const keyItem = (
  reason: string,
  text: string,
  url: string,
): HeadlessItem => ({
  id: "account_key",
  kind: "input",
  reason,
  text,
  env: "CATALYST_CLOUD_TOKEN",
  flag: "--key-file",
  url,
});

/** Never prints the path: a key pasted into CATALYST_CLOUD_TOKEN_FILE by mistake must not echo. */
function readKeyFile(
  path: string,
  url: string,
):
  | { key: string; warning?: string }
  | { missing: HeadlessItem }
  | { refused: HeadlessItem } {
  const named = "the file named by --key-file or CATALYST_CLOUD_TOKEN_FILE";
  const unreadable = (): ReturnType<typeof readKeyFile> => ({
    missing: keyItem(
      "account_key_file_unreadable",
      `The key file could not be read: ${named}. Point it at a readable file holding a personal key from ${url}.`,
      url,
    ),
  });
  let fd: number;
  try {
    // Non-blocking, so a FIFO or device named as the key cannot hold the run open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return unreadable();
  }
  const read = (): ReturnType<typeof readKeyFile> => {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      return {
        missing: keyItem(
          "account_key_file_not_regular",
          `The key path is not a regular file: ${named}. Point it at a file holding a personal key from ${url}.`,
          url,
        ),
      };
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid && stat.uid !== 0)
      return {
        refused: keyItem(
          "account_key_file_owner",
          `Another user owns the key file (${named}) and can change it. Use a file owned by this user or by root.`,
          url,
        ),
      };
    if (stat.mode & 0o022)
      return {
        refused: keyItem(
          "account_key_file_permissions",
          `Other users can write the key file (${named}). Run chmod 600 on it, then run the same command.`,
          url,
        ),
      };
    if (stat.size > KEY_FILE_MAX_BYTES)
      return {
        refused: keyItem(
          "account_key_malformed",
          `The key file (${named}) is too large to hold one key.`,
          url,
        ),
      };
    const buffer = Buffer.alloc(KEY_FILE_MAX_BYTES);
    try {
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      const key = buffer.subarray(0, length).toString("utf8").trim();
      if (!key)
        return {
          missing: keyItem(
            "account_key_missing",
            `The key file is empty: ${named}. Put a personal key from ${url} in it.`,
            url,
          ),
        };
      return stat.mode & 0o004
        ? {
            key,
            warning: `The key file (${named}) is readable by other users. Run chmod 600 on it.`,
          }
        : { key };
    } finally {
      buffer.fill(0);
    }
  };
  let result: ReturnType<typeof readKeyFile>;
  try {
    result = read();
  } catch {
    result = unreadable();
  }
  try {
    closeSync(fd);
  } catch {
    // Discard a read key on a close fault; preserve an earlier explicit safety refusal.
    if (!("refused" in result)) result = unreadable();
  }
  return result;
}

export interface HeadlessPlan {
  /** The onboard arguments the run uses: --yes, plus the resolved team, repositories and slot. */
  args: ParsedArgs;
  /** The supplied key, when one was supplied. Held in memory only, never in the report. */
  key?: string;
  report: HeadlessReport;
}

/** Resolves every headless input without a network call, a lock or a file write. */
export function planOnboardHeadless(args: ParsedArgs, ctx: Ctx): HeadlessPlan {
  const env = ctx.env;
  let saved: ReturnType<typeof loadConfig> = null;
  try {
    saved = loadConfig(ctx.home);
  } catch {
    saved = null;
  }
  const baseUrl = normalizeBaseUrl(
    args.baseUrl ??
      env.CATALYST_CLOUD_BASE_URL ??
      saved?.baseUrl ??
      DEFAULT_BASE_URL,
  );
  const url = pages(baseUrl);
  const missing: HeadlessItem[] = [];
  const refused: HeadlessItem[] = [];
  const warnings: string[] = [];
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  let key: string | undefined;
  let accountKey: HeadlessReport["inputs"]["accountKey"] = null;
  const keyFile = text(args.flags["key-file"]) ?? text(env.CATALYST_CLOUD_TOKEN_FILE);
  if (args.key !== undefined)
    refused.push(
      keyItem(
        "account_key_on_command_line",
        "A key on the command line is visible to every process on this machine. Pass it in CATALYST_CLOUD_TOKEN or in a file named by --key-file, then run the same command.",
        url.keys,
      ),
    );
  else if (keyFile) {
    const read = readKeyFile(keyFile, url.keys);
    if ("missing" in read) missing.push(read.missing);
    else if ("refused" in read) refused.push(read.refused);
    else {
      key = read.key;
      accountKey = "file";
      if (read.warning) warnings.push(read.warning);
    }
  } else if (text(env.CATALYST_CLOUD_TOKEN)) {
    key = text(env.CATALYST_CLOUD_TOKEN)!;
    accountKey = "env";
  } else if (saved?.user) accountKey = "saved";
  else if (saved) {
    accountKey = "saved";
    refused.push(
      keyItem(
        "account_key_not_personal",
        `This machine's saved login is the account's host key. Onboarding acts as a person: supply a personal key from ${url.keys} in CATALYST_CLOUD_TOKEN or --key-file.`,
        url.keys,
      ),
    );
  } else
    missing.push(
      keyItem(
        "account_key_missing",
        `No account key. Set CATALYST_CLOUD_TOKEN, or name a key file with --key-file or CATALYST_CLOUD_TOKEN_FILE. Mint a personal key at ${url.keys}.`,
        url.keys,
      ),
    );
  if (key !== undefined && (key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key))) {
    refused.push(
      keyItem(
        "account_key_malformed",
        "The supplied key is not a single-line key. Copy the key again from the API keys page.",
        url.keys,
      ),
    );
    key = undefined;
    accountKey = null;
  }

  const team = text(args.flags.team) ?? text(env.CATALYST_ONBOARD_TEAM);
  if (!team)
    missing.push({
      id: "linear_team",
      kind: "input",
      reason: "team_input_missing",
      text: `Name the Linear team with --team <ID or key> or CATALYST_ONBOARD_TEAM. The workspace's teams are at ${url.teams}.`,
      flag: "--team",
      env: "CATALYST_ONBOARD_TEAM",
      url: url.teams,
    });

  const flagRepos = args.flags.repo;
  const repos = (
    Array.isArray(flagRepos)
      ? flagRepos
      : typeof flagRepos === "string"
        ? [flagRepos]
        : (env.CATALYST_ONBOARD_REPOS ?? "").split(/[\s,]+/)
  )
    .map((repo) => repo.trim())
    .filter(Boolean);
  if (!repos.length)
    missing.push({
      id: "repositories",
      kind: "input",
      reason: "repositories_input_missing",
      text: `Name the repositories with --repo <owner/name> (repeatable) or CATALYST_ONBOARD_REPOS=owner/a,owner/b. Accessible repositories are at ${url.repos}.`,
      flag: "--repo",
      env: "CATALYST_ONBOARD_REPOS",
      url: url.repos,
    });

  const codingAccount =
    text(args.flags["coding-account"]) ?? text(env.CATALYST_ONBOARD_CODING_ACCOUNT);
  if (!codingAccount)
    missing.push({
      id: "coding_account",
      kind: "input",
      reason: "coding_account_input_missing",
      text: `Name the AI account with --coding-account <slot> or CATALYST_ONBOARD_CODING_ACCOUNT. catalyst accounts lists them; add one at ${url.codingAccounts}.`,
      flag: "--coding-account",
      env: "CATALYST_ONBOARD_CODING_ACCOUNT",
      url: url.codingAccounts,
    });
  else if (!slotPattern.test(codingAccount))
    refused.push({
      id: "coding_account",
      kind: "input",
      reason: "coding_account_input_invalid",
      text: "The AI account name given to --coding-account may hold only letters, digits, - and _. catalyst accounts lists them.",
      flag: "--coding-account",
      env: "CATALYST_ONBOARD_CODING_ACCOUNT",
    });

  const runnerText = args.flags.runner === true ? "true" : text(args.flags.runner) ?? (args.flags["no-runner"] === true ? "no" : text(env.CATALYST_ONBOARD_RUNNER));
  const runnerValue = runnerText?.toLowerCase();
  const runner = runnerValue === "yes" || runnerValue === "no" ? runnerValue : null;
  const runnerItem = (reason: string, sentence: string): HeadlessItem => ({
    id: "runner",
    kind: "input",
    reason,
    text: sentence,
    flag: "--runner",
    env: "CATALYST_ONBOARD_RUNNER",
  });
  if (!runnerText)
    missing.push(
      runnerItem(
        "runner_input_missing",
        "Say whether this machine runs agent work with --runner yes|no or CATALYST_ONBOARD_RUNNER.",
      ),
    );
  else if (!runner)
    refused.push(
      runnerItem("runner_input_invalid", "--runner takes yes or no."),
    );
  if (args.flags.runner !== undefined && args.flags["no-runner"] === true)
    refused.push(runnerItem("runner_input_invalid", "Choose one of --runner yes|no and --no-runner."));

  const flags = { ...args.flags, yes: true } as ParsedArgs["flags"];
  if (team) flags.team = team;
  if (repos.length) flags.repo = repos;
  if (codingAccount) flags["coding-account"] = codingAccount;
  delete flags["key-file"];
  delete flags.runner;
  delete flags["no-runner"];
  // CATALYST_ONBOARD_HEADLESS=1 alone leaves the flag unset; the plan names the headless input
  // rather than a --no-runner nobody typed (CTC-4739).
  flags.headless = true;
  if (runner === "yes") flags.runner = true;
  if (runner === "no") flags["no-runner"] = true;
  return {
    args: { ...args, key: undefined, baseUrl, flags },
    key,
    report: {
      schema: ONBOARD_HEADLESS_SCHEMA,
      inputs: {
        accountKey,
        baseUrl,
        team,
        repos,
        codingAccount,
        runner,
      },
      missing,
      refused,
      failed: [],
      deferred: [],
      warnings,
    },
  };
}

const GRANTS: Partial<
  Record<OnboardStepId, { reason: string; page: "connections" | "personal"; what: string }>
> = {
  "linear.workspace": {
    reason: "linear_workspace_grant_missing",
    page: "connections",
    what: "Linear is not connected for this workspace. A workspace owner or administrator connects it",
  },
  "github.install": {
    reason: "github_app_grant_missing",
    page: "connections",
    what: "The GitHub App is not installed for this workspace. A workspace owner or administrator installs it",
  },
  "linear.personal": {
    reason: "linear_personal_grant_missing",
    page: "personal",
    what: "This person's Linear account is not connected. Connect it",
  },
  "github.personal": {
    reason: "github_personal_grant_missing",
    page: "personal",
    what: "This person's GitHub account is not connected. Connect it",
  },
};
const GRANT_BY_REASON = new Map(
  Object.entries(GRANTS).map(([id, grant]) => [grant!.reason, id as OnboardStepId]),
);

/** Check-only browser steps: an absent grant waits with a named reason instead of opening a browser.
 * Sign-in has no action either, so the device flow can never start. */
export function headlessOnboardAdapters(
  adapters: Partial<Record<OnboardStepId, OnboardAdapter>>,
): Partial<Record<OnboardStepId, OnboardAdapter>> {
  const out = { ...adapters };
  const checkOnly = (id: OnboardStepId, reason: string) => {
    const adapter = adapters[id];
    if (!adapter) return;
    out[id] = {
      check: async (ctx, journal, signal) => {
        const result = await adapter.check(ctx, journal, signal);
        return result.state === "pending" ? { state: "waiting", reason } : result;
      },
    };
  };
  for (const [id, grant] of Object.entries(GRANTS))
    checkOnly(id as OnboardStepId, grant!.reason);
  checkOnly("signin", "account_key_missing");
  return out;
}

function headlessLoginGuidance(reason: string, keys: string): string | undefined {
  if (reason.endsWith("_login_refresh_required"))
    return `The saved login expired. Supply a personal key from ${keys} in CATALYST_CLOUD_TOKEN or --key-file, then run the same headless setup command.`;
  if (reason === "runner_identity_unverified")
    return `A workspace owner or administrator enrolls a runner. Supply a personal key from ${keys} for that owner or administrator in CATALYST_CLOUD_TOKEN or --key-file, then run the same headless setup command.`;
  return undefined;
}

/** Shared by all rendered channels; the raw journal and internal stop classification stay intact. */
function headlessRetryText(text: string, keys: string): string {
  const key = `Supply a personal key from ${keys} in CATALYST_CLOUD_TOKEN or --key-file`;
  return text
    .replace(/\b(?:Renew your login with|Sign in as one with|Sign in with|[Rr]un) catalyst login\b/g, key)
    .replace(/\bRenew your login with catalyst onboard\b/g, key)
    // CTC-4680: `catalyst setup` is the same flow as `catalyst onboard`, and bare, it drops the
    // headless flags and inputs just the same.
    .replace(/\bcatalyst (?:onboard|setup)\b(?! --help\b)(?: --runner)?(?: again)?/g, "the same headless setup command");
}

/** The report's view of a finished journal: each unsatisfied step as one named item. */
export function headlessStepItems(
  journal: Pick<OnboardJournal, "steps"> & Partial<OnboardJournal>,
  baseUrl: string,
  requireRunner = false,
  only?: OnboardStepId,
): Pick<HeadlessReport, "missing" | "failed" | "deferred" | "refused"> {
  const url = pages(baseUrl);
  const refused: HeadlessItem[] = [];
  const scope = new Set<OnboardStepId>();
  const include = (id: OnboardStepId): void => {
    if (scope.has(id)) return;
    scope.add(id);
    for (const parent of ONBOARD_DEPENDENCIES[id] ?? []) include(parent);
  };
  if (only) include(only);
  const missing: HeadlessItem[] = [];
  const failed: HeadlessItem[] = [];
  const deferred: HeadlessItem[] = [];
  const steps = [...journal.steps].sort(
    (a, b) => ONBOARD_STEPS.indexOf(a.id) - ONBOARD_STEPS.indexOf(b.id),
  );
  for (const step of steps) {
    if (only && !scope.has(step.id)) continue;
    if (step.state === "done" || (step.state === "skipped" && !(requireRunner && step.id === "runner"))) continue;
    // A prerequisite wait repeats an earlier item; the earlier one is what to fix.
    if (step.reason === "prerequisite_not_ready") continue;
    // Unreached rows have no action yet; retain them only in the raw journal.
    if (step.state === "pending" && !step.reason) continue;
    const reason = step.reason ?? "not_checked";
    const grantStep = GRANT_BY_REASON.get(reason);
    const grant = grantStep ? GRANTS[grantStep] : undefined;
    const item: HeadlessItem = grant
      ? {
          id: step.id,
          kind: "grant",
          reason,
          text: `${grant.what} at ${url[grant.page]}, then run the same command.`,
          url: url[grant.page],
        }
      : reason === "account_key_missing"
        ? keyItem(
            reason,
            `No usable login. Supply a personal key from ${url.keys} in CATALYST_CLOUD_TOKEN or --key-file.`,
            url.keys,
          )
        : {
            id: step.id,
            kind: "step",
            reason,
            text: onboardReasonText(step, {
              baseUrl,
              journal: journal as OnboardJournal,
            }),
          };
    const loginGuidance = headlessLoginGuidance(reason, url.keys);
    item.text = loginGuidance ?? headlessRetryText(item.text, url.keys);
    if (loginGuidance) item.url = url.keys;
    if (step.refused || (requireRunner && step.id === "runner" && reason === "member_scope")) refused.push(item);
    else if (step.state === "failed") failed.push(item);
    else if (!only && ONBOARD_DEFERRED_STEPS.has(step.id) && !(requireRunner && step.id === "runner") &&
      !reason.endsWith("_login_refresh_required") && reason !== "interrupted") deferred.push(item);
    else missing.push(item);
  }
  return { missing, failed, deferred, refused };
}

/** Set by the headless deps when cmdOnboard reaches its first step. */
export interface HeadlessTracker {
  stepsRan: boolean;
}

export interface HeadlessHooks {
  /** Saves the supplied key as this machine's login, as `catalyst login` does. */
  login: (key: string, baseUrl: string, ctx: Ctx) => Promise<number>;
  /** Runs onboarding with the headless deps (built with this tracker) and the planned arguments. */
  onboard: (args: ParsedArgs, ctx: Ctx, tracker: HeadlessTracker) => Promise<number>;
}

function contractCode(code: number): number {
  return [0, EXIT_FAILED, EXIT_WAITING, EXIT_REFUSED].includes(code)
    ? code
    : EXIT_FAILED;
}

const notPersonal = (keys: string) =>
  keyItem(
    "account_key_not_personal",
    `This is the account's host key. Onboarding acts as a person: mint a personal key at ${keys} and supply that instead.`,
    keys,
  );

function loginItem(
  error: unknown,
  baseUrl: string,
  source: "env" | "file",
  keyFileFlag: boolean,
  savedPersonalLogin: boolean,
): { item: HeadlessItem; code: number } {
  const url = pages(baseUrl);
  if (error instanceof CliError && error.code === "onboard-person-required")
    return { code: EXIT_REFUSED, item: notPersonal(url.keys) };
  if (error instanceof MeError && error.kind === "http" && (error.status === 401 || error.status === 403))
    return {
      code: EXIT_WAITING,
      item: keyItem(
        "account_key_rejected",
        `Catalyst did not accept the key from ${source === "env" ? "CATALYST_CLOUD_TOKEN" : keyFileFlag ? "the file named by --key-file" : "the file named by CATALYST_CLOUD_TOKEN_FILE"}. ${savedPersonalLogin ? `This machine has a saved personal login for ${baseUrl}. ${source === "env" ? "Unset CATALYST_CLOUD_TOKEN" : keyFileFlag ? "Remove --key-file" : "Unset CATALYST_CLOUD_TOKEN_FILE"} and run the same command to try it.` : `Mint a personal key at ${url.keys} and supply it again.`}`,
        url.keys,
      ),
    };
  return {
    code: EXIT_FAILED,
    item: {
      id: "signin",
      kind: "step",
      reason: error instanceof MeError && error.kind === "network" ? "cloud_unreachable" : "key_login_failed",
      text: `Signing in with the supplied key did not finish against ${baseUrl}. Check the address and the network, then run the same command.`,
    },
  };
}

/** Why onboarding stopped before its first step, from the one line it wrote and its exit code. */
function stopItem(code: number, said: string, baseUrl: string, errorCode?: string): HeadlessItem {
  const url = pages(baseUrl);
  if (errorCode === "onboard-login-refresh-required" || /Renew your login|login needs renewal/.test(said))
    return keyItem(
      "saved_login_expired",
      `The saved login expired. Supply a personal key from ${url.keys} in CATALYST_CLOUD_TOKEN or --key-file.`,
      url.keys,
    );
  if (errorCode === "onboard-person-required" || /sign in as yourself|personal login|personal key/i.test(said)) return notPersonal(url.keys);
  if (errorCode === "onboard-identity-mismatch" || /belongs to another workspace or member/.test(said))
    return keyItem(
      "account_key_other_login",
      "This machine's setup record belongs to another workspace or person. Supply that person's key.",
      url.keys,
    );
  return {
    id: "onboard",
    kind: "step",
    reason: errorCode ?? (code === EXIT_REFUSED ? "onboard_refused" : code === EXIT_FAILED ? "onboard_failed" : "onboard_waiting"),
    text: headlessRetryText(said, url.keys) || "Onboarding stopped before its first step. Run the same command to retry.",
  };
}

/** The whole headless run. Whatever happens, stdout gets exactly one document in --json mode. */
export async function runOnboardHeadless(
  args: ParsedArgs,
  ctx: Ctx,
  hooks: HeadlessHooks,
  cliVersion: string,
): Promise<number> {
  const plan = planOnboardHeadless(args, ctx);
  const report = plan.report;
  const baseUrl = report.inputs.baseUrl;
  const keys = pages(baseUrl).keys;
  const emit = (journal: OnboardJournal & { verdict?: string }, code: number): number => {
    for (const warning of report.warnings) ctx.stderr(`! ${warning}`);
    if (args.json) {
      const only = typeof plan.args.flags.only === "string" &&
        ONBOARD_STEPS.includes(plan.args.flags.only as OnboardStepId)
        ? plan.args.flags.only as OnboardStepId : undefined;
      const paused = code === EXIT_WAITING && (typeof journal.verdict === "string"
        ? journal.verdict === "paused"
        : [...report.missing, ...report.failed].some((item) => item.reason === "interrupted"));
      const view = onboardJsonView(journal.mode === "plan" ? journal : { ...journal, exit: code }, baseUrl, paused, {
        only,
        requiredSteps: report.inputs.runner === "yes" ? ["runner"] : [],
      });
      const actions = view.actions.map((action) => {
        const loginGuidance = headlessLoginGuidance(journal.steps.find((step) => step.id === action.step)?.reason ?? "", keys);
        return { ...action, text: loginGuidance ?? headlessRetryText(action.text, keys), ...(loginGuidance ? { url: keys } : {}) };
      });
      const next = headlessRetryText(view.next.replace(/(?:run )?catalyst (?:onboard|setup)(?: --runner)?(?: again)?/g, "run the same headless setup command"), keys);
      ctx.stdout(JSON.stringify({ ...view, actions, next, headless: report }));
    } else
      for (const [label, items] of [
        ["Refused", report.refused],
        ["Missing", report.missing],
        ["Failed", report.failed],
      ] as const)
        for (const item of items) ctx.stderr(`${label}: ${item.text}`);
    return code;
  };
  const early = (code: number, item?: HeadlessItem) => {
    if (item)
      (code === EXIT_REFUSED ? report.refused : code === EXIT_WAITING ? report.missing : report.failed).push(item);
    return emit(onboardErrorJournal(ctx, cliVersion, code), code);
  };
  if (report.refused.length) return early(EXIT_REFUSED);
  if (report.missing.length) return early(EXIT_WAITING);
  const dryRun = args.flags["dry-run"] === true;

  // A supplied key replaces the saved login only for the same person, and a dry run saves nothing.
  if (plan.key !== undefined && !dryRun) {
    let saved: ReturnType<typeof loadConfig> = null;
    try {
      saved = loadConfig(ctx.home);
    } catch {
      saved = null;
    }
    const savedPersonalLogin = Boolean(saved?.user && normalizeBaseUrl(saved.baseUrl) === baseUrl);
    const current =
      saved?.key === plan.key && normalizeBaseUrl(saved.baseUrl) === baseUrl;
    if (!current) {
      let me: Awaited<ReturnType<typeof fetchMe>>;
      try {
        me = await fetchMe(baseUrl, plan.key, ctx.fetch);
      } catch (error) {
        const { item, code } = loginItem(error, baseUrl, report.inputs.accountKey === "file" ? "file" : "env", typeof args.flags["key-file"] === "string", savedPersonalLogin);
        return early(code, item);
      }
      if (!me.user) return early(EXIT_REFUSED, notPersonal(pages(baseUrl).keys));
      let receipt: OnboardJournal | null = null;
      try {
        receipt = readOnboardJournal(onboardStatePath(ctx.home, ctx.env), cliVersion, ctx.now());
      } catch {
        receipt = null;
      }
      const receiptAccount = receipt?.account ?? receipt?.tenant;
      if (
        (saved &&
          (saved.account !== me.account ||
            (saved.user?.id !== undefined && saved.user.id !== me.user.id) ||
            normalizeBaseUrl(saved.baseUrl) !== baseUrl)) ||
        (receiptAccount && receiptAccount !== me.account) ||
        (receipt?.membershipId && receipt.membershipId !== me.user.id)
      )
        return early(
          EXIT_REFUSED,
          keyItem(
            "account_key_other_login",
            "The supplied key belongs to another workspace or person than this machine's saved login or setup record. Supply that person's key, or set this machine up from a clean home.",
            pages(baseUrl).keys,
          ),
        );
      try {
        // Login output is not the run's result; it never reaches stdout.
        const loginOutput = (line: string) => ctx.stderr(headlessRetryText(line, keys));
        const code = await hooks.login(plan.key, baseUrl, { ...ctx, stdout: loginOutput, stderr: loginOutput });
        if (code !== 0) throw new CliError("key login failed", "key-login-failed", EXIT_FAILED);
      } catch (error) {
        const { item, code } = loginItem(error, baseUrl, report.inputs.accountKey === "file" ? "file" : "env", typeof args.flags["key-file"] === "string", savedPersonalLogin);
        return early(code, item);
      }
    }
  }

  // The steps never need the key itself; keep it out of every child process they start.
  const env = { ...ctx.env };
  delete env.CATALYST_CLOUD_TOKEN;
  delete env.CATALYST_CLOUD_TOKEN_FILE;
  if (ctx.env === process.env) {
    delete process.env.CATALYST_CLOUD_TOKEN;
    delete process.env.CATALYST_CLOUD_TOKEN_FILE;
  }
  const captured: string[] = [];
  const said: string[] = [];
  const runCtx: Ctx = {
    ...ctx,
    env,
    stdout: args.json ? (line) => captured.push(line) : (line) =>
      ctx.stdout(line === "resume: catalyst onboard" ? "resume: run the same headless setup command" :
        headlessRetryText(line, keys)),
    stderr: (line) => {
      said.push(line);
      ctx.stderr(headlessRetryText(line, keys));
    },
  };
  const tracker: HeadlessTracker = { stepsRan: false };
  let code: number;
  let errorCode: string | undefined;
  try {
    code = contractCode(await hooks.onboard(plan.args, runCtx, tracker));
  } catch (error) {
    code = contractCode(error instanceof CliError ? error.exitCode : EXIT_FAILED);
    if (error instanceof CliError) errorCode = error.code;
    if (error instanceof UsageError) code = EXIT_REFUSED;
    const line =
      error instanceof CliError || error instanceof UsageError
        ? `catalyst: ${error.message}`
        : "catalyst: onboarding stopped on an unexpected error. Run the same command to resume.";
    said.push(line);
    ctx.stderr(headlessRetryText(line, keys));
  }
  let journal: OnboardJournal | null = null;
  for (const line of captured) {
    try {
      const value = JSON.parse(line) as OnboardJournal;
      if (value && value.schema === 1 && Array.isArray(value.steps)) {
        journal = value;
        continue;
      }
    } catch {
      /* not the result document */
    }
    ctx.stderr(headlessRetryText(line, keys));
  }
  if (!args.json && !journal) {
    try {
      journal = readOnboardJournal(onboardStatePath(ctx.home, ctx.env), cliVersion, ctx.now());
    } catch {
      journal = null;
    }
  }
  if (tracker.stepsRan && journal) {
    const items = headlessStepItems(
      journal, baseUrl, report.inputs.runner === "yes",
      typeof plan.args.flags.only === "string" ? plan.args.flags.only as OnboardStepId : undefined,
    );
    report.refused.push(...items.refused);
    report.missing.push(...items.missing);
    report.failed.push(...items.failed);
    report.deferred.push(...items.deferred);
  } else if (code !== 0) {
    // Stopped before any step: an older receipt's steps are not this run's reasons.
    const item = stopItem(code, said.filter(Boolean).at(-1) ?? "", baseUrl, errorCode ?? journal?.errorCode);
    (code === EXIT_REFUSED ? report.refused : code === EXIT_WAITING ? report.missing : report.failed).push(item);
  }
  return emit(journal ?? onboardErrorJournal(ctx, cliVersion, code), code);
}

/** cmdOnboard's dependencies for a headless run: no terminal UI, no browser sign-in, check-only
 * browser steps, and a confirmation that can only decline (--yes means it is never reached). */
export function headlessOnboardDeps(
  deps: OnboardDeps,
  tracker?: HeadlessTracker,
  requireRunner = false,
): OnboardDeps {
  const { stageSignin: _stageSignin, ui: _ui, ...rest } = deps;
  return {
    ...rest,
    adapters: headlessOnboardAdapters(deps.adapters ?? {}),
    ...(requireRunner ? { requiredSteps: [...(deps.requiredSteps ?? []), "runner" as const] } : {}),
    beforeStep: async (id) => {
      if (tracker) tracker.stepsRan = true;
      await deps.beforeStep?.(id);
    },
    isTty: () => false,
    confirm: async () => false,
  };
}

/** A command line the parser refused under --headless still gets the headless exit and document. */
export function headlessUsageRefusal(
  ctx: Ctx,
  message: string,
  json: boolean,
  cliVersion: string,
): number {
  const item: HeadlessItem = {
    id: "command_line",
    kind: "input",
    reason: "usage",
    text: `${message}. Run catalyst onboard --help for the options.`,
  };
  ctx.stderr(`Refused: ${item.text}`);
  if (json)
    ctx.stdout(
      JSON.stringify({
        ...onboardJsonView(onboardErrorJournal(ctx, cliVersion, EXIT_REFUSED)),
        next: "run the same headless setup command",
        headless: {
          schema: ONBOARD_HEADLESS_SCHEMA,
          inputs: null,
          missing: [],
          refused: [item],
          failed: [],
          deferred: [],
          warnings: [],
        },
      }),
    );
  return EXIT_REFUSED;
}
