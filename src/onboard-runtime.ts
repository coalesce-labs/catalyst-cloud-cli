import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "./args.js";
import { openConsentBrowser } from "./consent-browser.js";
import {
  defaultSkillsDirFor,
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  type Ctx,
} from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { cmdLegacy, findLegacy, type LegacyDeps } from "./legacy.js";
import { personalConsentAdapter } from "./onboard-personal.js";
import { boundedOnboardSignin } from "./onboard-signin.js";
import { existingLinearAdapters } from "./onboard-existing.js";
import { returningWorkspaceAdapters } from "./onboard-returning.js";
import { archiveReturningProject } from "./onboard-project-cleanup.js";
import { CREATE_TEAM_CHOICE } from "./onboard-team-create.js";
import { linearWorkspaceAdapter } from "./onboard-workspace.js";
import { firstProjectAdapters } from "./onboard-projects.js";
import { onboardCapacityAdapter } from "./onboard-capacity.js";
import { onboardRunnerAdapter, type RunnerEngine } from "./onboard-runner.js";
import { onboardAutomationManagementAdapter } from "./onboard-automation-management.js";
import { onboardWorkflowVerificationAdapter } from "./onboard-workflow.js";
import { onboardAccountsAdapter } from "./onboard-accounts.js";
import { onboardFirstTicketAdapter } from "./onboard-first-ticket.js";
import { onboardValuesAdapter } from "./onboard-values.js";
import { githubInstallationAdapter } from "./onboard-github.js";
import {
  connectChecklistAdapter,
  type ConnectPageWait,
} from "./onboard-checklist.js";
import {
  onboardHousekeepingAdapter,
  type HousekeepingOptions,
} from "./onboard-housekeeping.js";
import {
  guardOnboardCapabilities,
  type OnboardCapabilityOptions,
} from "./onboard-capabilities.js";
import {
  onboardSettingsAdapter,
  type OnboardSettingsHooks,
} from "./onboard-settings.js";
import type {
  OnboardDeps,
  OnboardIdentity,
  OnboardJournal,
  OnboardStepResult,
  OnboardStepId,
} from "./onboard.js";
import type { OnboardUi } from "./onboard-ui.js";
import { TIMED_OUT_REASONS } from "./setup-onboard-copy.js";
import { fetchMe } from "./transport.js";
import { enableRunnerAutoUpdate } from "./runner-command.js";

export interface OnboardRuntimeHooks {
  beforeStep?: (id: OnboardStepId) => Promise<void>;
  settings?: OnboardSettingsHooks;
  ui?: OnboardUi;
  login: (ctx: Ctx, signal?: AbortSignal) => Promise<number>;
  stageSignin?: (
    signal?: AbortSignal,
  ) => Promise<import("./onboard-login-candidate.js").OnboardLoginCandidate>;
  signinTimeoutMs?: number;
  ready: (ctx: Ctx, journal?: OnboardJournal) => Promise<OnboardStepResult>;
  legacy?: LegacyDeps;
  openBrowser?: (url: string, signal?: AbortSignal) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  realHome?: () => string;
  skillNames?: readonly string[];
  runnerEngine?: RunnerEngine;
  /** Turns on the runner's update schedule once it runs. Without an injected engine, the real one. */
  runnerAutoUpdate?: (dir: string) => string;
  /** How the daily update step reads this computer's scheduler; tests replace it. */
  scheduler?: HousekeepingOptions;
}

const HOLD_ON_TIMEOUT: readonly OnboardStepId[] = [
  "linear.workspace",
  "linear.personal",
  "github.install",
  "github.personal",
  "accounts",
];
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
function sameHome(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Only existing bearer routes are registered here. Missing server capabilities stay unfinished. */
export function createOnboardRuntime(
  args: ParsedArgs,
  ctx: Ctx,
  hooks: OnboardRuntimeHooks,
): OnboardDeps {
  if (args.flags.runner === true && args.flags["no-runner"] === true)
    throw new UsageError("choose one of --runner and --no-runner");
  const identity = async (
    stepCtx = ctx,
    journal?: OnboardJournal,
  ): Promise<OnboardIdentity | null> => {
    const cfg = loadConfig(stepCtx.home);
    if (!cfg) return null;
    const requested = args.baseUrl ?? stepCtx.env.CATALYST_CLOUD_BASE_URL;
    if (
      requested &&
      normalizeBaseUrl(requested) !== normalizeBaseUrl(cfg.baseUrl)
    )
      throw new CliError(
        "the saved login uses another cloud; resume against that cloud",
        "onboard-base-url-mismatch",
        12,
      );
    if (!cfg.user)
      throw new CliError(
        "sign in as yourself to set up Catalyst",
        "onboard-person-required",
        12,
      );
    if (
      journal &&
      (((journal.account ?? journal.tenant) &&
        (journal.account ?? journal.tenant) !== cfg.account) ||
        (journal.membershipId && journal.membershipId !== cfg.user.id) ||
        (journal.baseUrl &&
          normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)))
    )
      throw new CliError(
        "the saved setup belongs to another workspace or member",
        "onboard-identity-mismatch",
        12,
      );
    // The Q1 preview reads the current token directly; stopping setup must not rotate saved credentials.
    const expiry = cfg.auth
      ? Date.parse(cfg.auth.expiresAt) - stepCtx.now().getTime()
      : 0;
    const bearer =
      cfg.key ||
      (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
        ? cfg.auth.accessToken
        : undefined);
    if (!bearer)
      throw new CliError(
        "Renew your login with catalyst login, then run catalyst onboard.",
        "onboard-login-refresh-required",
        11,
      );
    const owned = new AbortController();
    const signal = hooks.ui
      ? AbortSignal.any([owned.signal, hooks.ui.signal])
      : owned.signal;
    const timer = setTimeout(() => owned.abort(), 30_000);
    let remove = () => {};
    let me: Awaited<ReturnType<typeof fetchMe>>;
    try {
      me = await new Promise<Awaited<ReturnType<typeof fetchMe>>>(
        (resolve, reject) => {
          const stopped = () =>
            reject(
              new CliError(
                "Your membership could not be checked. Run catalyst onboard to retry.",
                "onboard-membership-unavailable",
                11,
              ),
            );
          if (signal.aborted) {
            stopped();
            return;
          }
          signal.addEventListener("abort", stopped, { once: true });
          remove = () => signal.removeEventListener("abort", stopped);
          const boundedFetch = ((
            url: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ) => {
            if (signal.aborted)
              return Promise.reject(new Error("membership_read_stopped"));
            return stepCtx.fetch(url, {
              ...init,
              redirect: "error",
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            });
          }) as typeof fetch;
          fetchMe(cfg.baseUrl, bearer, boundedFetch).then(
            (value) => (signal.aborted ? stopped() : resolve(value)),
            reject,
          );
        },
      );
    } finally {
      clearTimeout(timer);
      remove();
    }
    const current = loadConfig(stepCtx.home);
    if (
      !current?.user ||
      current.account !== cfg.account ||
      current.user.id !== cfg.user.id ||
      normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
    )
      throw new CliError(
        "Your saved login changed while membership was checked. Run catalyst onboard again.",
        "onboard-identity-mismatch",
        12,
      );
    if (!me.user || me.account !== cfg.account || me.user.id !== cfg.user.id)
      throw new CliError(
        "the saved login and live member do not match",
        "onboard-identity-mismatch",
        12,
      );
    // /me names a person within the account, not an independently exposed membership-row ID.
    return {
      account: me.account,
      membershipId: me.user.id,
      baseUrl: normalizeBaseUrl(cfg.baseUrl),
      role: me.user.role,
      display: {
        personLabel: me.user.label,
        email: me.user.email,
        workspaceName: me.name,
        workspaceSlug: me.slug,
      },
    };
  };
  const legacyCheck = async (stepCtx: Ctx): Promise<OnboardStepResult> => {
    const found = findLegacy(
      stepCtx.home,
      hooks.legacy?.platform ?? process.platform,
    ).filter((item) => !item.data).length;
    if (
      !sameHome(stepCtx.home, (hooks.realHome ?? (() => userInfo().homedir))())
    )
      return {
        state: "skipped",
        reason: "fake_home_report_only",
        evidence: { found, remaining: found },
      };
    return {
      state: found ? "pending" : "done",
      evidence: { found, remaining: found },
    };
  };
  const interactiveWait =
    hooks.ui &&
    hooks.ui.interactive !== false &&
    !args.json &&
    args.flags.yes !== true &&
    args.flags.headless !== true;
  // CTC-4680 round 5: whether the step now acting ran a browser wait, so a timed-out wait can be
  // re-offered with a fresh link instead of moving on to steps that need it.
  let waited = false;
  const waitFor = <T>(
    message: string,
    run: () => Promise<T>,
    page?: ConnectPageWait,
  ): Promise<T> => {
    waited = true;
    return hooks.ui!.wait(message, run, page);
  };
  // CTC-4680: the Connect accounts page opens once per run, whichever step needs it first.
  const connectPage = { openedBy: null as OnboardStepId | null };
  const checklistOptions = {
    openBrowser: hooks.openBrowser ?? openConsentBrowser,
    wait: interactiveWait
      ? <T>(message: string, work: () => Promise<T>, page: ConnectPageWait) =>
          waitFor(message, work, page)
      : undefined,
    note: (text: string) =>
      hooks.ui?.note ? hooks.ui.note(text) : hooks.ui ? hooks.ui.message(text) : ctx.stderr(text),
    sleep: hooks.sleep,
    page: connectPage,
    cache: { last: null },
  };
  const personalAdapter = (provider: "linear" | "github") =>
    personalConsentAdapter({
      provider,
      openBrowser: hooks.openBrowser ?? openConsentBrowser,
      sleep: hooks.sleep,
      wait: interactiveWait
        ? (message, run) => waitFor(message, run)
        : undefined,
    });
  let newProjectRequested = false;
  const linear = existingLinearAdapters(
    args,
    hooks.ui?.chooseTeam
      ? async (teams, create) => {
          if (newProjectRequested) { newProjectRequested = false; return CREATE_TEAM_CHOICE; }
          return hooks.ui!.chooseTeam!(teams.map(team => ({ ...team })), create);
        }
      : undefined,
    hooks.ui?.nameNewTeam
      ? (question) => hooks.ui!.nameNewTeam!(question)
      : undefined,
    (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
  );
  const adapters: NonNullable<OnboardDeps["adapters"]> = {
    machine: {
      check: async () =>
        process.platform === "darwin" || process.platform === "linux"
          ? { state: "done", evidence: { provider: process.platform } }
          : waiting("machine_platform_unsupported"),
    },
    cli: {
      check: async () => ({
        state: "done",
        evidence: { version: readManifest().version },
      }),
    },
    skills: {
      check: async (stepCtx) => {
        const cfg = loadConfig(stepCtx.home);
        const dir =
          stepCtx.env.CATALYST_SKILLS_DIR ??
          cfg?.skillsDir ??
          defaultSkillsDirFor(stepCtx.home);
        const names = hooks.skillNames ?? [];
        const count = names.filter((name) =>
          existsSync(join(dir, name, "SKILL.md")),
        ).length;
        return names.length > 0 && count === names.length
          ? { state: "done", evidence: { count, path: dir } }
          : waiting("skills_install_unverified");
      },
    },
    legacy: {
      check: legacyCheck,
      act: async (stepCtx) => {
        const before = await legacyCheck(stepCtx);
        if (before.state !== "pending") return before;
        // Provider/process output is not trusted to be secret-free; keep it out of the receipt/log.
        const quiet = { ...stepCtx, stdout: () => {}, stderr: () => {} };
        const code = await cmdLegacy(
          {
            ...args,
            command: "legacy",
            subcommand: null,
            rest: [],
            flags: { remove: true, yes: true },
            json: false,
          },
          quiet,
          hooks.legacy,
        );
        return code === 0
          ? legacyCheck(stepCtx)
          : { state: "failed", reason: "legacy_cleanup_failed" };
      },
    },
    signin: {
      check: async (stepCtx, journal) => {
        const who = await identity(stepCtx, journal);
        return who
          ? {
              state: "done",
              evidence: {
                account: who.account,
                membershipId: who.membershipId,
                role: who.role,
              },
            }
          : { state: "pending" };
      },
      act: async (stepCtx, _journal, signal) => {
        return boundedOnboardSignin(
          { ...stepCtx, stdout: stepCtx.stderr },
          hooks.login,
          signal,
          hooks.signinTimeoutMs,
        );
      },
    },
    ...linear,
    "linear.workspace": linearWorkspaceAdapter({
      fallback: linear["linear.workspace"],
      openBrowser: hooks.openBrowser ?? openConsentBrowser,
      wait: interactiveWait
        ? (message, work) => waitFor(message, work)
        : undefined,
      sleep: hooks.sleep,
    }),
    "github.install": connectChecklistAdapter({
      ...checklistOptions,
      step: "github.install",
      item: "github-app",
      fallback: githubInstallationAdapter({
        openBrowser: hooks.openBrowser ?? openConsentBrowser,
        wait: interactiveWait
          ? (message, work) => waitFor(message, work)
          : undefined,
        sleep: hooks.sleep,
      }),
    }),
    settings: onboardSettingsAdapter({
      ...hooks.settings,
      review: hooks.ui?.reviewSettings
        ? (summaries) => hooks.ui!.reviewSettings!(summaries)
        : hooks.settings?.review,
      message: hooks.ui
        ? (text) => hooks.ui!.message(text)
        : (text) => ctx.stderr(text),
    }),
    ...firstProjectAdapters(args, {
      chooseExisting: hooks.ui?.chooseRepositories
        ? (rows) =>
            hooks.ui!.chooseRepositories!(rows.map((row) => ({ ...row })))
        : undefined,
      chooseFirst: hooks.ui?.chooseFirstRepository
        ? (rows) =>
            hooks.ui!.chooseFirstRepository!(rows.map((row) => ({ ...row })))
        : undefined,
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    accounts: connectChecklistAdapter({
      ...checklistOptions,
      step: "accounts",
      item: "ai-account",
      // A named account is checked on its own: the checklist answers for the whole workspace.
      enabled: typeof args.flags["coding-account"] !== "string",
      fallback: onboardAccountsAdapter({
        ...(interactiveWait
          ? {
              waitForAccount: <T>(work: () => Promise<T>) =>
                waitFor("Waiting for an AI account", work),
              sleep: hooks.sleep,
            }
          : {}),
        ...(typeof args.flags["coding-account"] === "string"
          ? { slot: args.flags["coding-account"] }
          : {}),
      }),
    }),
    capacity: onboardCapacityAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    runner: onboardRunnerAdapter({
      selected:
        args.flags.runner === true
          ? true
          : args.flags["no-runner"] === true
            ? false
            : undefined,
      choose: hooks.ui?.chooseRunner
        ? () => hooks.ui!.chooseRunner!()
        : undefined,
      engine: hooks.runnerEngine,
      hostName:
        typeof args.flags["machine-name"] === "string"
          ? () => String(args.flags["machine-name"])
          : undefined,
      chooseName:
        interactiveWait &&
        hooks.ui?.nameMachine &&
        args.flags["machine-name"] === undefined
          ? (name) => hooks.ui!.nameMachine!(name)
          : undefined,
      sleep: hooks.sleep,
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
      autoUpdate: hooks.runnerAutoUpdate ?? (hooks.runnerEngine ? undefined : (dir) => enableRunnerAutoUpdate(ctx, dir)),
    }),
    "linear.adopt": onboardWorkflowVerificationAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
      ...(hooks.ui?.confirmWorkflowAdoption
        ? {
            confirm: (team: string, lines: readonly string[]) =>
              hooks.ui!.confirmWorkflowAdoption!(team, lines),
          }
        : {}),
      yes: args.flags.yes === true,
    }),
    "linear.automations": onboardAutomationManagementAdapter(),
    "linear.personal": personalAdapter("linear"),
    "github.personal": personalAdapter("github"),
    daemon: {
      check: async (_stepCtx, journal) =>
        (journal.localSync ?? args.flags["local-sync"] === true)
          ? waiting("local_sync_capability_unavailable")
          : {
              state: "skipped",
              reason: "local_sync_not_selected",
              evidence: { provider: "cloud" },
            },
    },
    housekeeping: onboardHousekeepingAdapter(hooks.scheduler),
    // CTC-4744: a settings read the cloud has not finished is waited on here, on one line.
    values: onboardValuesAdapter({
      message: (text) =>
        hooks.ui?.note ? hooks.ui.note(text) : hooks.ui ? hooks.ui.message(text) : ctx.stderr(text),
      sleep: hooks.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    }),
    // Only a person at a terminal picks a ticket; --yes, JSON and headless runs leave it waiting.
    "first-ticket": onboardFirstTicketAdapter(
      interactiveWait && hooks.ui?.chooseFirstTicket
        ? {
            choose: (tickets, where) =>
              hooks.ui!.chooseFirstTicket!(
                tickets.map((ticket) => ({ ...ticket })),
                { ...where },
              ),
          }
        : {},
    ),
    ready: { check: hooks.ready },
  };
  const get = (path: string) => ({ method: "GET" as const, path });
  const capabilities: Partial<Record<OnboardStepId, OnboardCapabilityOptions>> =
    {
      "linear.workspace": {
        check: [get("/api/v1/me/connections/linear/workspace")],
        act: [
          get("/api/v1/me/connections/linear/workspace"),
          get("/api/v1/me/connections/linear/workspace/start"),
        ],
        fallback: "connections",
      },
      "linear.personal": {
        check: [get("/api/v1/me/connections/linear/personal")],
        act: [
          get("/api/v1/me/connections/linear/personal"),
          get("/connect/linear/personal/start"),
        ],
        fallback: "personalConnections",
      },
      "github.install": {
        check: [get("/api/v1/me/connections/github/workspace")],
        act: [
          get("/api/v1/me/connections/github/workspace"),
          get("/api/v1/me/connections/github/workspace/start"),
        ],
        fallback: "connections",
      },
      "github.personal": {
        check: [get("/api/v1/me/connections/github/personal")],
        act: [
          get("/api/v1/me/connections/github/personal"),
          get("/connect/github/personal/start"),
        ],
        fallback: "personalConnections",
      },
      "linear.team": {
        check: [
          get("/api/v1/agent/teams"),
          get("/api/v1/agent/tenant/readiness"),
        ],
        fallback: "connections",
      },
      "github.repos": {
        check: [get("/api/v1/repos"), get("/api/v1/agent/contract")],
        fallback: "connections",
      },
      settings: {
        check: [
          get("/api/v1/agent/teams"),
          get("/api/v1/repos"),
          get("/api/v1/agent/contract"),
        ],
        fallback: "connections",
      },
      projects: {
        check: [get("/api/v1/repos"), get("/api/v1/agent/contract")],
        fallback: "connections",
      },
      values: {
        check: [get("/api/v1/agent/contract")],
        fallback: "connections",
      },
      ready: {
        check: [get("/api/v1/agent/contract")],
        fallback: "connections",
      },
    };
  for (const [id, options] of Object.entries(capabilities)) {
    const step = id as OnboardStepId;
    const adapter = adapters[step];
    if (adapter)
      adapters[step] = guardOnboardCapabilities(adapter, {
        ...options,
        message: (text) =>
          hooks.ui ? hooks.ui.message(text) : ctx.stderr(text),
      });
  }
  // CTC-4680 round 5: a browser link that ran out of time holds the step. The person gets a fresh
  // link on yes; on stop the UI pauses setup, so nothing that depends on the step runs.
  const retry = interactiveWait ? hooks.ui?.retryTimedOut?.bind(hooks.ui) : undefined;
  if (retry)
    for (const step of HOLD_ON_TIMEOUT) {
      const adapter = adapters[step];
      if (!adapter?.act) continue;
      const act = adapter.act;
      adapters[step] = {
        ...adapter,
        act: async (stepCtx, journal, signal) => {
          for (;;) {
            waited = false;
            const result = await act(stepCtx, journal, signal);
            const timedOut =
              result.state === "waiting" &&
              (TIMED_OUT_REASONS.has(result.reason ?? "") ||
                (step === "accounts" &&
                  (result.reason === "account_enrollment_required" ||
                    result.reason === "ai_account_not_usable")));
            if (!timedOut || !waited || signal?.aborted || hooks.ui?.signal.aborted)
              return result;
            if (!(await retry(step))) return result;
          }
        },
      };
    }
  // Round 5: the runner question waits until Catalyst is on GitHub; asking it earlier left people
  // answering later steps while nothing could work.
  const runner = adapters.runner;
  if (runner?.act && hooks.ui?.chooseRunner && args.flags.runner !== true && args.flags["no-runner"] !== true) {
    const { check, act } = runner;
    const githubPending = (journal: OnboardJournal): boolean => {
      const github = journal.steps.find((step) => step.id === "github.install");
      return Boolean(github && github.state !== "done" && github.state !== "skipped");
    };
    // Both: the engine runs check before act, and the runner's check is where the question is asked.
    adapters.runner = {
      ...runner,
      check: async (stepCtx, journal, signal) =>
        githubPending(journal) ? waiting("github_install_pending") : check(stepCtx, journal, signal),
      act: async (stepCtx, journal, signal) =>
        githubPending(journal) ? waiting("github_install_pending") : act(stepCtx, journal, signal),
    };
  }
  // Public auth discovery and the existing /me sign-in bootstrap establish identity before the
  // tenant-bound step guards can run. Unsupported/local-only steps make no endpoint requests.
  let reviewActive = false;
  returningWorkspaceAdapters(adapters, args, hooks.ui?.reviewProjects?.bind(hooks.ui),
    text => hooks.ui ? hooks.ui.message(text) : ctx.stderr(text),
    () => { newProjectRequested = true; }, () => reviewActive,
    (project, stepCtx, journal, signal) => archiveReturningProject(project, stepCtx, journal,
      hooks.ui?.confirmProjectCleanup?.bind(hooks.ui), signal));
  return {
    beforeStep: async id => {
      await hooks.beforeStep?.(id);
      if (id === "linear.workspace") reviewActive = true;
    },
    identity: (journal) => identity(ctx, journal),
    ...(hooks.stageSignin ? { stageSignin: hooks.stageSignin } : {}),
    bindSignals: true,
    ui: hooks.ui,
    adapters,
  };
}
