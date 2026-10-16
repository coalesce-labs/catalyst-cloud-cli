import { cmdHosts, type HostsDeps } from "./hosts.js";
import { cmdRunner, type RunnerLifecycleDeps } from "./runner.js";
import { cmdSeat } from "./seat.js";
// cli.ts — the `catalyst` dispatcher (npm: @catalyst-cloud/cli). Verbs live in
// their own modules; this file keeps every export the 0.1 tests and the bin import.
import {
  createSetupRenderer,
  setupBanner,
  type SetupStream,
} from "./setup-render.js";
import { existsSync, openSync, closeSync } from "node:fs";
import { ReadStream as TerminalInput } from "node:tty";
import { Writable } from "node:stream";
import { parseArgs, positionals, verbHelp, type ParsedArgs } from "./args.js";
import {
  CONFIG_MODE,
  DEFAULT_BASE_URL,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  cliPath,
  configPathFor,
  contractPathFor,
  defaultCtx,
  defaultReplicaDbFor,
  defaultSkillsDirFor,
  formatMode,
  installerOwnsSkills,
  INSTALL_COMMAND,
  loadConfig,
  modernCliPath,
  normalizeBaseUrl,
  readManifest,
  requireConfig,
  saveConfig,
  writeConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "./config.js";
import { loadContract, pickPath } from "./contract.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { fetchMe } from "./transport.js";
import {
  bearerFor,
  deviceFlowLogin,
  refreshSessionIfShort,
  type DeviceFlowDeps,
  type OauthAuth,
} from "./oauth.js";

const ONBOARD_SESSION_MIN_MS = 20 * 60_000;
// A consent step waits up to 10 minutes, so each step starts with more than that left.
const ONBOARD_STEP_MIN_MS = 11 * 60_000;
import { openBrowserChecked as defaultOpenBrowser } from "./browser.js";
import {
  cmdAccounts,
  cmdExplain,
  cmdHistory,
  cmdQueue,
  cmdRunning,
} from "./execution.js";
import { cmdQuery } from "./query.js";
import { maybePrintPublishedUpdateNotice } from "./cli-update-notice.js";
import { cmdReady } from "./ready.js";
import { cmdReplica, type ReplicaDeps } from "./replica.js";
import { cmdRuntime, type RuntimeVerbDeps } from "./runtime-verb.js";
import { cmdEvents, type EventDeps } from "./events.js";
import { stageOnboardLogin } from "./onboard-login-candidate.js";
import { stdinIsTty } from "./prompt.js";
import { cmdSetup, SETUP_USAGE } from "./setup.js";
import {
  clackSetupAsk,
  clackSetupSpinner,
  openSetupTerminal,
  setupOnboardStreams,
} from "./setup-prompts.js";
import { keepInstalledCliPath, runSetupSignin } from "./setup-signin.js";
import {
  FIRST_STAMPED_VERSION,
  PROVENANCE_MARKER,
  parseProvenanceVersion,
} from "./skill-shape.js";
import {
  installedBundleVersion,
  installSkills,
  parseChangelogEntry,
  readChangelog,
  resolveSkillsDir,
  skillsSourceDir,
  updateNoticeLine,
  type SkillsInstallResult,
} from "./skills.js";
import { cmdWatch, type WatchDeps } from "./watch.js";
import { cmdWrite, type WriteDeps } from "./write.js";
import { cmdAsk } from "./ask.js";
import { cmdMcp } from "./mcp.js";
import { cmdRelease } from "./release.js";
import { cmdStage } from "./stage.js";
import { cmdEnvironment, type EnvironmentDeps } from "./environment.js";
import { cmdEnv, type EnvDeps } from "./env.js";
import { cmdSecret, type SecretDeps } from "./secret.js";
import { cmdVar, type VarDeps } from "./var.js";
import { cmdTeam, type TeamDeps } from "./team.js";
import { cmdCapabilities } from "./capabilities.js";
import { cmdProject } from "./project.js";
import { cmdRepo } from "./repo.js";
import { cmdLegacy, type LegacyDeps } from "./legacy.js";
import { cmdIdentity, type IdentityDeps } from "./identity.js";
import { cmdConnections, type ConnectionsDeps } from "./connections.js";
import {
  cmdOnboard,
  onboardErrorJournal,
  type OnboardDeps,
} from "./onboard.js";
import type { OnboardBootstrapPreview } from "./onboard-bootstrap.js";
import {
  createClackOnboardUi,
  shouldUseOnboardUi,
  type OnboardUi,
} from "./onboard-ui.js";
import { createOnboardRuntime } from "./onboard-runtime.js";
import {
  argvRequestsHeadless,
  headlessOnboardDeps,
  headlessUsageRefusal,
  onboardHeadlessRequested,
  runOnboardHeadless,
  type HeadlessTracker,
} from "./onboard-headless.js";
import { savedOnboardBaseUrl } from "./onboard-next.js";
import {
  onboardingReadyReport,
  onboardReadyStep,
  observeCloudOnboarding,
} from "./onboard-ready.js";
import { selectedOnboardTeam } from "./onboard-existing.js";

export {
  CONFIG_MODE,
  DEFAULT_BASE_URL,
  FIRST_STAMPED_VERSION,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  PROVENANCE_MARKER,
  CliError,
  MeError,
  UsageError,
  configPathFor,
  contractPathFor,
  defaultCtx,
  defaultReplicaDbFor,
  defaultSkillsDirFor,
  fetchMe,
  formatMode,
  installedBundleVersion,
  installSkills,
  loadConfig,
  modernCliPath,
  normalizeBaseUrl,
  parseArgs,
  parseChangelogEntry,
  parseProvenanceVersion,
  readChangelog,
  readManifest,
  resolveSkillsDir,
  saveConfig,
  skillsSourceDir,
  updateNoticeLine,
  writeConfig,
};
export type {
  Ctx,
  CustomerConfig,
  MeIdentity,
  ParsedArgs,
  SkillsInstallResult,
};

export const CUSTOMER_SKILLS = [
  "catalyst-github",
  "catalyst-linear",
  "catalyst-onboard",
  "run-this-project",
  "unstick",
  "what-needs-me",
  "what-this-repo-needs",
  "whats-happening",
] as const;

/** `login` is the verb; `join` is the 0.1 name, kept as a deprecated alias for one minor version. */
const VERB_ALIASES: Record<string, string> = { join: "login" };

/** Verbs whose stdout is for a human, so the update notice may share it. Every other verb's stdout
 *  is machine-read by a skill script and the notice goes to stderr. */
const HUMAN_VERBS = new Set(["login", "install", "status", "notice"]);

export function usageText(): string {
  return [
    `${PACKAGE_NAME} — the Catalyst Cloud customer CLI: connect to your Catalyst workspace, read through the SDK, write through the agent proxy`,
    "",
    "Usage:",
    "  catalyst login [--base-url <url>] [--start-replica]   (keyless: logs you in as yourself)",
    "  catalyst login --key <personal-key> [--base-url <url>]   (or CATALYST_CLOUD_TOKEN, for a key)",
    "  catalyst join ...   (deprecated alias of login; removed in the next minor version)",
    "  catalyst install [--skills-dir <dir>] [--force]   (repair path; your agent's own command installs the skills)",
    "  catalyst onboard [--resume-from <step>] [--only <step>] [--runner|--no-runner] [--yes] [--dry-run] [--json]",
    `  catalyst ${SETUP_USAGE}`,
    "  catalyst status | notice | me | ready | accounts",
    "  catalyst seat checkout --size big|med --harness claude,codex,opencode [--session-id ID] [--stage STAGE]",
    "  catalyst hosts [list] | hosts remove <name-or-id> [--yes] | hosts rename <name-or-id> <new-name>",
    "  catalyst runner [status] | runner stop | runner start | runner uninstall [--yes] [--delete-checkouts]   (this machine's self-hosted runner)",
    "  catalyst mcp add|list|remove (vault references only)",
    "  catalyst contract [--refresh] [--path <a.b.c>]",
    "  catalyst query <issues|issue <id>|pulls|pull <id>|projects|cycles|search <terms>|changes --since <cursor|head>>",
    '  catalyst replica <start [--detach]|stop|status [--probe]|sql "<select>"|schema [table]>',
    "  catalyst runtime <status [--json]|install|path|uninstall>   (a pinned Node this CLI manages itself)",
    "  catalyst events <tail|wait-for|query|status> [--type NAME] [--ticket CTC-N] [--after SEQUENCE] [--from-cache]",
    "  catalyst explain <ticket> | history <ticket> | running [--ticket T --phase P] | queue [--team K]",
    "  catalyst watch [--team K] [--ticket T]... [--project P] [--exec CMD]",
    "  catalyst write <comment|state|label|create|reaction|attachment|session> ...",
    "  catalyst ask <raise|accept|list> ...",
    "  catalyst release <ticket> --because <what changed> [--retry-unchanged] [--dry-run] | release --class <c> --team <K> ...",
    "  catalyst environment [read] | environment propose --file <path>|--stdin [--approve] | environment approve   (your account; needs login)",
    "  catalyst env <inventory [path] | check <file> | migrate [catalyst.env.json] | draft [--root DIR] [--diff] [--write]> [--json]   (this repository, offline — no login, no network)",
    "  catalyst secret set <NAME> --repo <owner/name> [--command '<cmd>'] | secret import <file> --repo <owner/name> [--names NAME[,NAME...]]",
    "  catalyst var set <NAME> | var import <file> [--repo <owner/name>] [--names NAME[,NAME...]]   (plain environment variables)",
    "  catalyst team <list|check|map|adopt|migrate|checklist> ...",
    "  catalyst capabilities [--json]   (what this CLI can do, the role each verb needs, and whether this cloud serves it)",
    "  catalyst project list [--json]   (all workspace projects, including those with no stage mapping)",
    "  catalyst stage <start|renew|done|fail> <ticket> <phase>   (a cloud-claimed local phase)",
    "  catalyst project wip-limit <get|set <n>|set default> [--team K]   (a project's new-start WIP limit; members read, owners and admins set)",
    "  catalyst repo <agents-block <path> [--write]|agent-setup <path> [--apply] [--with-check]>   (a checkout's AGENTS.md block and portable agent layout; working tree only)",
    "  catalyst legacy [--remove [--data] [--yes]]   (leftovers of the old local Catalyst runtime: list them; remove them only on a yes)",
    "  catalyst identity linear <status|options|set> [<linearUserId>] [--json]",
    "  catalyst connections personal <linear|github> <start|status> [--wait <seconds>] [--json]",
    "",
    "Every verb takes --help. --json makes the output machine-readable.",
    "",
    "With no key, login is keyless: it opens a WorkOS device-code flow, prints a short code and a URL,",
    "and connects you as yourself once you approve in the browser — nothing to mint or paste. Pass",
    "--key (or set CATALYST_CLOUD_TOKEN) to use a personal or account key instead. The base URL defaults",
    `to CATALYST_CLOUD_BASE_URL or ${DEFAULT_BASE_URL}.`,
    "",
    "login finds your Catalyst workspace, writes ~/.config/catalyst-cloud/customer.json",
    "(0600) holding your login session (or key) and this CLI's path, and caches the workspace contract",
    "beside it. A keyless session's short-lived token refreshes silently on every request. login does",
    "not install skills: your agent's own install command does that, and `install` is only here to",
    "repair a copy this package made.",
  ].join("\n");
}

export interface MainDeps {
  /** Internal setup continuation. The combined plan was already approved. */
  setupUi?: OnboardUi;
  setupApproved?: boolean;
  /** Internal staged entrypoint passes an owned preview; installed CLI leaves this absent. */
  onboardBootstrap?: OnboardBootstrapPreview;
  onboardSigninTimeoutMs?: number;
  signal?: AbortSignal;
  waitForApproval?: <T>(run: () => Promise<T>) => Promise<T>;
  replica?: ReplicaDeps;
  runtime?: RuntimeVerbDeps;
  events?: EventDeps;
  watch?: WatchDeps;
  write?: WriteDeps;
  environment?: EnvironmentDeps;
  env?: EnvDeps;
  secret?: SecretDeps;
  var?: VarDeps;
  connections?: ConnectionsDeps;
  hosts?: HostsDeps;
  runner?: RunnerLifecycleDeps;
  identity?: IdentityDeps;
  team?: TeamDeps;
  legacy?: LegacyDeps;
  loadSdk?: () => Promise<unknown>;
  /** Injected by the tests so no suite ever touches a real terminal. */
  isTty?: () => boolean;
  /** Injected by the tests: open the browser at the device-flow verification URL. */
  openBrowser?: (url: string) => void;
  /** Injected by the tests: the device-flow poll delay (no real waiting under test). */
  sleep?: (ms: number) => Promise<void>;
  /** CTC-4625: `catalyst setup` draws each device code itself (see DeviceFlowDeps.present). */
  presentCode?: DeviceFlowDeps["present"];
  presentBrowser?: DeviceFlowDeps["presentBrowser"];
}

/**
 * CTC-3479 — a login before the rename recorded bin/catalyst-skills.js as cliPath. Skill scripts
 * spawn that path, and it now prints the deprecated-name notice on every call. Move the record onto
 * the `catalyst` launcher beside it, once, on the next run of either name. Read and write back to
 * back, so the window for racing a concurrent OAuth refresh is as small as the update notice's.
 */
function migrateLegacyCliPath(ctx: Ctx): void {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    return;
  }
  if (!cfg) return;
  let next = modernCliPath(cfg.cliPath);
  // An upgrade from @catalyst-cloud/catalyst-skills to @catalyst-cloud/cli removes the old package
  // folder, so the recorded launcher no longer exists and has no sibling. Point it at the launcher
  // that is running now, so `ready` and every skill script work without another login.
  if (
    next === null &&
    typeof cfg.cliPath === "string" &&
    cfg.cliPath !== "" &&
    !existsSync(cfg.cliPath)
  ) {
    next = cliPath();
  }
  if (next === null || next === cfg.cliPath) return;
  cfg.cliPath = next;
  try {
    saveConfig(ctx.home, cfg);
  } catch {
    // Best effort: the old launcher still works, it only prints the notice.
  }
}

/**
 * The Tier-2 update path: when the bundle on disk is newer than the version the config last
 * recorded, refresh the copied skills FIRST and record the new version only once that succeeded.
 */
function maybePrintUpdateNotice(args: ParsedArgs, ctx: Ctx): void {
  const say = HUMAN_VERBS.has(args.command ?? "") ? ctx.stdout : ctx.stderr;
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    return;
  }
  if (!cfg) return;
  const manifest = readManifest();
  if (cfg.lastSkillBundleVersion === manifest.version) return;
  const previous = cfg.lastSkillBundleVersion;
  if (previous) {
    const entry = parseChangelogEntry(readChangelog(), manifest.version);
    say(updateNoticeLine(previous, manifest.version, entry));
  }
  if (installerOwnsSkills(ctx.home, ctx.env)) {
    cfg.lastSkillBundleVersion = manifest.version;
    try {
      saveConfig(ctx.home, cfg);
    } catch {
      // Best effort: the notice prints again next time, and nothing else depends on it.
    }
    return;
  }
  const skillsDir = resolveSkillsDir(args, ctx, cfg);
  let refreshed: SkillsInstallResult;
  try {
    refreshed = installSkills(skillsDir, { force: false, onlyExisting: true });
  } catch (err) {
    ctx.stderr(
      `[catalyst] could not refresh the skills at ${skillsDir} (${err instanceof Error ? err.message : String(err)}) — the ${manifest.version} skills are not installed yet; re-run the install command: ${INSTALL_COMMAND}`,
    );
    return;
  }
  if (refreshed.installed.length > 0)
    say(
      `[catalyst] refreshed ${refreshed.installed.join(", ")} at ${skillsDir} to ${manifest.version}`,
    );
  if (refreshed.removed.length > 0)
    say(
      `[catalyst] removed retired skills ${refreshed.removed.join(", ")} from ${skillsDir}; their work moved into the skills this bundle ships`,
    );
  for (const s of refreshed.skipped) {
    say(
      `[catalyst] left "${s.name}" alone: ${skillsDir}/${s.name} was not installed by this package (catalyst install --force to replace)`,
    );
  }
  cfg.lastSkillBundleVersion = manifest.version;
  cfg.skillsDir = skillsDir;
  saveConfig(ctx.home, cfg);
}

export async function main(
  argv: string[],
  ctx: Ctx = defaultCtx(),
  deps: MainDeps = {},
): Promise<number> {
  // CTC-4625: setup passes the install options through to its engine untouched, so they never meet
  // this CLI's own flag tables. CTC-4680: without --engine, `setup` is the name a person types for
  // the onboard flow, so it runs exactly that.
  const viaSetup = drawsMark(argv);
  if (argv[0] === "setup") {
    const rest = argv.slice(1);
    const own = rest.indexOf("--") === -1 ? rest : rest.slice(0, rest.indexOf("--"));
    if (own.includes("--engine") || own.includes("--help") || own.includes("-h"))
      return runSetup(rest, ctx, deps);
    argv = ["onboard", ...rest];
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(
      argv.map((a, i) => (i === 0 && VERB_ALIASES[a] ? VERB_ALIASES[a] : a)),
    );
    if (args.command && VERB_ALIASES[args.command])
      args.command = VERB_ALIASES[args.command];
  } catch (err) {
    if (argvRequestsHeadless(argv, ctx.env))
      return headlessUsageRefusal(
        ctx,
        err instanceof Error ? err.message : String(err),
        argv.includes("--json"),
        readManifest().version,
      );
    ctx.stderr(err instanceof Error ? err.message : String(err));
    ctx.stderr(usageText());
    return 1;
  }
  const manifest = readManifest();
  if (
    args.json &&
    (args.help || args.version) &&
    args.command === "onboard" &&
    onboardHeadlessRequested(args, ctx.env)
  )
    return headlessUsageRefusal(
      ctx,
      "--help and --version print text, not the headless document; run them without --json",
      true,
      manifest.version,
    );
  if (args.version) {
    ctx.stdout(
      // Machine-read: install.sh and catalyst-cloud's onboarding harness match this exact line.
      `${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`,
    );
    return 0;
  }
  if (args.command === null) {
    ctx.stdout(usageText());
    return 0;
  }
  if (args.help) {
    ctx.stdout(verbHelp(args.command));
    return 0;
  }
  await maybePrintPublishedUpdateNotice(ctx, {
    interactive: deps.isTty?.() ?? process.stdout.isTTY === true,
    json: args.json,
    command: args.command,
    version: manifest.version,
  });
  try {
    if (args.command !== "onboard") {
      migrateLegacyCliPath(ctx);
      maybePrintUpdateNotice(args, ctx);
    }
    switch (args.command) {
      case "login":
        return await cmdLogin(args, ctx, deps);
      case "install":
        return cmdInstall(args, ctx);
      case "onboard": {
        // Setup may already own signal handlers; release them before any headless early exit.
        if (onboardHeadlessRequested(args, ctx.env)) deps.setupUi?.dispose();
        for (const flag of ["key-file"])
          if (args.flags[flag] !== undefined && !onboardHeadlessRequested(args, ctx.env))
            throw new UsageError(`--${flag} needs --headless`);
        if (typeof args.flags.runner === "string" && !onboardHeadlessRequested(args, ctx.env))
          throw new UsageError("--runner yes|no needs --headless; use --runner or --no-runner interactively");
        // Headless runs drop the terminal UI, browser sign-in and every browser action (CTC-4633).
        const runOnboard = async (
          args: ParsedArgs,
          ctx: Ctx,
          headless: HeadlessTracker | null,
        ): Promise<number> => {
        let ui: OnboardUi | undefined = headless ? undefined : deps.setupUi;
        // --no-color reaches the renderer as NO_COLOR, so the banner and every step row go plain.
        const noColor = args.flags["no-color"] === true;
        const rendererEnv = noColor ? { ...ctx.env, NO_COLOR: "1" } : ctx.env;
        let terminal: TerminalInput | undefined;
        let input: TerminalInput = process.stdin;
        const originalRaw = Boolean(input.isRaw);
        if (!headless && !ui && shouldUseOnboardUi(args, Boolean(process.stdout.isTTY))) {
          if (!input.isTTY) {
            try {
              const fd = openSync("/dev/tty", "r");
              try {
                terminal = new TerminalInput(fd);
                input = terminal;
              } catch (error) {
                closeSync(fd);
                throw error;
              }
            } catch {
              ctx.stderr(
                "No controlling terminal is available; using the displayed defaults.",
              );
            }
          }
          if (input.isTTY) {
            try {
              const banner = await setupBanner({
                setup: viaSetup,
                env: rendererEnv,
                input,
                stdout: process.stdout,
                stream: bannerStream(ctx),
                noColor,
              });
              ui = createClackOnboardUi(
                await import("@clack/prompts"),
                { input, output: process.stdout },
                {
                  baseUrl: () => savedOnboardBaseUrl(ctx.home),
                  verbose: args.flags.verbose === true,
                  renderer: createSetupRenderer(process.stdout, rendererEnv, banner),
                  disposeRenderer: true,
                  signinTimeoutMs: deps.onboardSigninTimeoutMs,
                  version: manifest.version,
                },
              );
            } catch (error) {
              terminal?.destroy();
              throw error;
            }
          }
        }
        if (!headless && !ui && !args.json && args.flags["dry-run"] !== true) {
          const output =
            process.stdout.isTTY === true
              ? process.stdout
              : new Writable({
                  write(chunk, _encoding, callback) {
                    ctx.stdout(chunk.toString().replace(/\n$/, ""));
                    callback();
                  },
                });
          ui = createClackOnboardUi(
            await import("@clack/prompts"),
            { input: process.stdin, output },
            {
              baseUrl: () => savedOnboardBaseUrl(ctx.home),
              renderer: createSetupRenderer(
                output,
                rendererEnv,
                await setupBanner({
                  setup: viaSetup,
                  env: rendererEnv,
                  input: process.stdin,
                  stdout: process.stdout,
                  stream: bannerStream(ctx),
                  noColor,
                }),
              ),
              disposeRenderer: true,
              signinTimeoutMs: deps.onboardSigninTimeoutMs,
              version: manifest.version,
              interactive: false,
              verbose: args.flags.verbose === true,
            },
          );
        }
        // Start with a full access token: a session saved long ago would otherwise expire part way
        // through, or send the person back through the device sign-in. A dry run changes nothing.
        if (args.flags["dry-run"] !== true)
          await refreshSessionIfShort(ctx, ONBOARD_SESSION_MIN_MS);
        const jsonLines: string[] = [];
        const onboardCtx = args.json
          ? {
              ...ctx,
              stdout: (line: string) => {
                jsonLines.push(line);
              },
            }
          : ctx;
        let code: number;
        try {
          code = await cmdOnboard(
            args,
            onboardCtx,
            ((value: OnboardDeps) => (headless ? headlessOnboardDeps(value, headless, args.flags.runner === true) : value))({
              ...(deps.setupApproved
                ? { reviewedSetup: true, confirm: async () => true }
                : {}),
              ...createOnboardRuntime(args, ctx, {
                beforeStep: async () => {
                  if (args.flags["dry-run"] !== true)
                    await refreshSessionIfShort(ctx, ONBOARD_STEP_MIN_MS);
                },
                ui,
                signinTimeoutMs: deps.onboardSigninTimeoutMs,
                stageSignin: (signal) => {
                  if (args.key || ctx.env.CATALYST_CLOUD_TOKEN)
                    throw new CliError(
                      "Connect your personal key with catalyst login, then run catalyst onboard. Setup will not replace a supplied key with browser sign-in.",
                      "onboard-person-required",
                      12,
                    );
                  return stageOnboardLogin(
                    {
                      ...ctx,
                      stdout: ui
                        ? (line: string) => ui.message(line)
                        : ctx.stderr,
                    },
                    {
                      baseUrl: args.baseUrl,
                      signal,
                      timeoutMs: deps.onboardSigninTimeoutMs,
                      device: {
                        isTty:
                          deps.isTty ?? (() => Boolean(process.stdout.isTTY)),
                        openBrowser: deps.openBrowser ?? defaultOpenBrowser,
                        sleep: deps.sleep,
                        waitForApproval: ui
                          ? (run) =>
                              ui.wait("Waiting for Catalyst approval", run)
                          : undefined,
                      },
                    },
                  );
                },
                login: (stepCtx, signal) =>
                  cmdLogin(
                    { ...args, command: "login", flags: {}, json: false },
                    stepCtx,
                    {
                      ...deps,
                      signal,
                      isTty: () => true,
                      waitForApproval: ui
                        ? (run) => ui.wait("Waiting for Catalyst approval", run)
                        : undefined,
                    },
                    true,
                  ),
                ready: async (stepCtx, journal) => {
                  const team = selectedOnboardTeam(journal);
                  const report = await onboardingReadyReport(stepCtx, {
                    teamIds: team ? [team] : undefined,
                    localSync:
                      journal?.localSync ?? args.flags["local-sync"] === true,
                    observe: observeCloudOnboarding,
                  });
                  return onboardReadyStep(report, journal);
                },
                legacy: deps.legacy,
                openBrowser: deps.openBrowser,
                sleep: deps.sleep,
                skillNames: CUSTOMER_SKILLS,
              }),
              ...(deps.onboardBootstrap
                ? { bootstrap: deps.onboardBootstrap }
                : {}),
              ...(deps.isTty ? { isTty: deps.isTty } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
            }),
            readManifest().version,
          );
        } finally {
          ui?.dispose();
          if (input.isTTY && input.isRaw !== originalRaw)
            input.setRawMode(originalRaw);
          terminal?.destroy();
        }
        for (const line of jsonLines) ctx.stdout(line);
        return code;
        };
        if (!onboardHeadlessRequested(args, ctx.env))
          return await runOnboard(args, ctx, null);
        return await runOnboardHeadless(
          args,
          ctx,
          {
            login: (key, baseUrl, loginCtx) =>
              cmdLogin(
                { ...args, command: "login", key, baseUrl, flags: {}, json: false },
                loginCtx,
                { ...deps, isTty: () => false },
                true,
              ),
            onboard: (onboardArgs, onboardCtx, tracker) =>
              runOnboard(onboardArgs, onboardCtx, tracker),
          },
          readManifest().version,
        );
      }
      case "notice":
        return 0;
      case "status":
        return cmdStatus(ctx);
      case "me":
        return await cmdMe(args, ctx);
      case "contract":
        return await cmdContract(args, ctx);
      case "query":
        return await cmdQuery(args, ctx, {
          engineDeps: deps.replica?.engineDeps,
        });
      case "replica":
        return await cmdReplica(args, ctx, deps.replica);
      case "runtime":
        return await cmdRuntime(args, ctx, deps.runtime);
      case "events":
        return await cmdEvents(args, ctx, deps.events);
      case "explain":
        return await cmdExplain(args, ctx);
      case "history":
        return await cmdHistory(args, ctx);
      case "running":
        return await cmdRunning(args, ctx);
      case "queue":
        return await cmdQueue(args, ctx);
      case "watch":
        return await cmdWatch(args, ctx, deps.watch);
      case "write":
        return await cmdWrite(args, ctx, deps.write);
      case "ask":
        return await cmdAsk(args, ctx);
      case "ready":
        return await cmdReady(args, ctx, {
          skillNames: CUSTOMER_SKILLS,
          loadSdk: deps.loadSdk,
          offline: args.flags.offline === true,
        });
      case "mcp":
        return await cmdMcp(args, ctx);
      case "accounts":
        return await cmdAccounts(args, ctx);
      case "seat":
        return await cmdSeat(args, ctx);
      case "release":
        return await cmdRelease(args, ctx);
      case "stage":
        return await cmdStage(args, ctx);
      case "environment":
        return await cmdEnvironment(args, ctx, deps.environment ?? {});
      case "env":
        return await cmdEnv(args, ctx, deps.env ?? {});
      case "secret":
        return await cmdSecret(args, ctx, deps.secret ?? {});
      case "var":
        return await cmdVar(args, ctx, deps.var ?? {});
      case "team":
        return await cmdTeam(args, ctx, deps.team);
      case "capabilities":
        return await cmdCapabilities(args, ctx);
      case "project":
        return await cmdProject(args, ctx);
      case "repo":
        return await cmdRepo(args, ctx);
      case "legacy":
        return await cmdLegacy(args, ctx, deps.legacy ?? {});
      case "identity":
        return await cmdIdentity(args, ctx, deps.identity ?? {});
      case "hosts":
        return await cmdHosts(args, ctx, deps.hosts);
      case "runner":
        return await cmdRunner(args, ctx, deps.runner);
      case "connections":
        return await cmdConnections(args, ctx, deps.connections ?? {});
      default:
        ctx.stderr(`unknown command: ${args.command}`);
        ctx.stderr(usageText());
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr(err.message);
      ctx.stderr(
        args.command && args.command in VERB_HELP_KNOWN
          ? verbHelp(args.command)
          : usageText(),
      );
      return 1;
    }
    if (err instanceof CliError) {
      if (args.command === "onboard" && args.json)
        ctx.stdout(
          JSON.stringify(
            onboardErrorJournal(ctx, manifest.version, err.exitCode),
          ),
        );
      ctx.stderr(`catalyst: ${err.message}`);
      return err.exitCode;
    }
    if (err instanceof MeError) {
      ctx.stderr(`catalyst: ${err.message}`);
      return 2;
    }
    if (args.command === "onboard" && args.json) {
      ctx.stdout(
        JSON.stringify(onboardErrorJournal(ctx, manifest.version, 10)),
      );
      ctx.stderr(
        "catalyst: onboarding could not finish. Run catalyst onboard to try again.",
      );
      return 10;
    }
    throw err;
  }
}

const VERB_HELP_KNOWN: Record<string, true> = Object.fromEntries(
  [
    "login",
    "join",
    "install",
    "status",
    "notice",
    "me",
    "contract",
    "query",
    "replica",
    "runtime",
    "events",
    "explain",
    "running",
    "queue",
    "watch",
    "write",
    "ask",
    "ready",
    "accounts",
    "release",
    "secret",
    "env",
    "environment",
    "connections",
    "identity",
    "mcp",
    "team",
    "capabilities",
    "project",
    "repo",
    "legacy",
    "onboard",
  ].map((v) => [v, true]),
);

/** CTC-4680: the Pixel Nucleus mark belongs to `catalyst setup` alone. `setup` runs the onboard
 *  flow, so this is read from the verb typed, before setup becomes onboard. */
export function drawsMark(argv: readonly string[]): boolean {
  return argv[0] === "setup";
}

/** CTC-4680: the banner goes to stderr, through ctx when stderr is not a terminal. */
function bannerStream(ctx: Ctx): SetupStream {
  if (process.stderr.isTTY === true) return process.stderr;
  return {
    write(chunk: string) {
      for (const line of chunk.replace(/\n$/, "").split("\n")) ctx.stderr(line);
      return true;
    },
  };
}

/** CTC-4625: `catalyst setup`, wired to this terminal, @clack/prompts and the keyless login. */
async function runSetup(
  argv: string[],
  ctx: Ctx,
  deps: MainDeps,
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    ctx.stdout(verbHelp("setup"));
    return 0;
  }
  const clack = await import("@clack/prompts");
  const terminal = openSetupTerminal(process.stdout);
  const spinner = clackSetupSpinner(clack, Boolean(process.stdin.isTTY));
  try {
    return await cmdSetup(argv, ctx, {
      stdout: process.stdout,
      stderr: process.stderr,
      writeJson: (chunk) => process.stdout.write(chunk),
      interactive: terminal !== null,
      ...(terminal ? { ask: clackSetupAsk(clack, terminal) } : {}),
      spinner,
      onboard: async (renderer, flags) => {
        // This returns through the dispatcher without launching another CLI or frame.
        const onboardArgs = [
          "onboard",
          ...(flags.json ? ["--json"] : []),
          ...(flags.verbose ? ["--verbose"] : []),
          ...(flags.localSync ? ["--local-sync"] : []),
          ...(flags.runner === undefined ? [] : [flags.runner ? "--runner" : "--no-runner"]),
          ...(flags.yes || flags.json || !terminal ? ["--yes"] : []),
        ];
        let ui: OnboardUi | undefined;
        if (!flags.json) {
          ui = createClackOnboardUi(clack, setupOnboardStreams(terminal), {
            baseUrl: () => savedOnboardBaseUrl(ctx.home),
            renderer,
            logPath: () => flags.logPath,
            verbose: flags.verbose,
            signinTimeoutMs: deps.onboardSigninTimeoutMs,
            introduced: true,
            consentGiven: true,
            interactive: terminal !== null && !flags.yes,
          });
        }
        return main(onboardArgs, ctx, {
          ...deps,
          setupUi: ui,
          setupApproved: true,
        });
      },
      signin: (seconds, r, stop, spin) =>
        runSetupSignin(ctx, r, seconds, {
          interrupted: stop,
          spinner: spin,
          login: async (loginCtx, login) => {
            const code = await cmdLogin(parseArgs(["login"]), loginCtx, {
              ...deps,
              isTty: deps.isTty ?? (() => terminal !== null),
              signal: login.signal,
              waitForApproval: login.waitForApproval,
              presentCode: login.present,
              presentBrowser: login.presentBrowser,
            });
            if (code === 0) keepInstalledCliPath(ctx, cliPath());
            return code;
          },
        }),
    });
  } finally {
    terminal?.close();
  }
}

async function cmdLogin(
  args: ParsedArgs,
  ctx: Ctx,
  deps: MainDeps,
  personalOnly = false,
): Promise<number> {
  const checkCancelled = () => {
    if (deps.signal?.aborted)
      throw new CliError(
        "Sign-in paused. Run the same command to resume.",
        "login-cancelled",
        11,
      );
  };
  checkCancelled();
  const manifest = readManifest();
  const key = (args.key ?? ctx.env.CATALYST_CLOUD_TOKEN ?? "").trim();
  const baseUrl = normalizeBaseUrl(
    args.baseUrl ?? ctx.env.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL,
  );
  // Keyless is the preferred rail: with no key in flag or env, run the WorkOS device flow and log in
  // as the person. A key (flag or CATALYST_CLOUD_TOKEN) still takes the token rail unchanged.
  let auth: OauthAuth | undefined;
  const bearer = key
    ? key
    : (auth = await deviceFlowLogin(ctx, baseUrl, {
        isTty: deps.isTty ?? stdinIsTty,
        openBrowser: deps.openBrowser ?? defaultOpenBrowser,
        sleep: deps.sleep,
        signal: deps.signal,
        waitForApproval: deps.waitForApproval,
        present: deps.presentCode,
        presentBrowser: deps.presentBrowser,
      })).accessToken;
  checkCancelled();
  const me = await fetchMe(baseUrl, bearer, ctx.fetch);
  checkCancelled();
  if (personalOnly && !me.user)
    throw new CliError(
      "onboarding needs your personal login; sign in as yourself",
      "onboard-person-required",
      12,
    );
  let existing: CustomerConfig | null;
  try {
    existing = loadConfig(ctx.home);
  } catch {
    existing = null;
  }
  const previous = existing?.lastSkillBundleVersion ?? null;
  const skillsDir = resolveSkillsDir(args, ctx, existing);
  const config: CustomerConfig = {
    baseUrl,
    ...(key ? { key } : {}),
    ...(auth ? { auth } : {}),
    account: me.account,
    slug: me.slug,
    name: me.name,
    permissions: me.permissions,
    principal: me.principal,
    ...(me.user ? { user: me.user } : {}),
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: manifest.version,
    skillsDir,
    cliPath: cliPath(),
    replicaDb: existing?.replicaDb ?? defaultReplicaDbFor(ctx.home),
  };
  checkCancelled();
  const written = writeConfig(ctx.home, config);
  ctx.stdout(`Catalyst workspace: ${me.name} (${me.slug})`);
  if (me.user) {
    ctx.stdout(
      `Signed in to Catalyst as ${me.user.label} (${me.user.role})${
        me.user.linearUserId
          ? ""
          : ' — your Linear identity is not matched yet, so "what needs me" will show everyone\'s asks until an admin matches it in Settings'
      }`,
    );
  } else {
    ctx.stderr(
      `[catalyst] this is your Catalyst workspace's shared key (a host credential), not your own. The skills work, but nothing your agent writes will carry your name, and "what needs me" cannot mean you. Run catalyst login to sign in as yourself; for an unattended machine, make a personal key at Settings → API keys and sign in with that.`,
    );
  }
  ctx.stdout(
    `Config written to ${written.path} (mode ${formatMode(written.mode)}, holds your ${auth ? "login session" : "key"} and the CLI path)${
      written.mode === CONFIG_MODE
        ? ""
        : ` — expected ${formatMode(CONFIG_MODE)}; chmod it by hand`
    }`,
  );
  try {
    const loaded = await loadContract(ctx, config, {
      refresh: true,
      signal: deps.signal,
    });
    checkCancelled();
    ctx.stdout(
      `Saved your workspace settings (version ${loaded.doc.contractVersion}) to ${loaded.path}`,
    );
  } catch (err) {
    checkCancelled();
    if (
      err instanceof CliError &&
      (err.code === "contract-forbidden" || err.code === "contract-version")
    ) {
      ctx.stderr(`[catalyst] ${err.message}`);
    } else {
      throw err;
    }
  }
  checkCancelled();
  if (previous && previous !== manifest.version) {
    const entry = parseChangelogEntry(readChangelog(), manifest.version);
    ctx.stdout(updateNoticeLine(previous, manifest.version, entry));
  }
  if (args.flags["start-replica"] === true) {
    const code = await cmdReplica(
      parseArgs(["replica", "start", "--detach"]),
      ctx,
      {
        ...deps.replica,
        argv: deps.replica?.argv ?? [cliPath(), "replica", "start"],
      },
    );
    if (code !== 0) return code;
  }
  return 0;
}

function cmdInstall(args: ParsedArgs, ctx: Ctx): number {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    cfg = null;
  }
  const skillsDir = resolveSkillsDir(args, ctx, cfg);
  const result = installSkills(skillsDir, { force: args.force });
  ctx.stdout(
    result.installed.length > 0
      ? `Skills installed to ${skillsDir}: ${result.installed.join(", ")}`
      : `No skills installed — ${skillsDir} already had them`,
  );
  for (const s of result.skipped) {
    ctx.stdout(
      `Skipped "${s.name}": ${skillsDir}/${s.name} exists and was not installed by this package (use --force to replace)`,
    );
  }
  if (result.removed.length > 0)
    ctx.stdout(
      `Removed retired skills from ${skillsDir}: ${result.removed.join(", ")}`,
    );
  return 0;
}

function cmdStatus(ctx: Ctx): number {
  const manifest = readManifest();
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    ctx.stdout(
      `Not connected yet — run: npx ${LEGACY_PACKAGE_NAME} login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN)`,
    );
    return 0;
  }
  ctx.stdout(`Tenant: ${cfg.name} (${cfg.slug}) — account ${cfg.account}`);
  ctx.stdout(`API: ${cfg.baseUrl} (principal: ${cfg.principal})`);
  ctx.stdout(
    cfg.user
      ? `As: ${cfg.user.label} (${cfg.user.role})`
      : "As: the tenant's account key (a host credential — no person)",
  );
  ctx.stdout(
    cfg.auth
      ? `Credential: your login (expires ${relativeExpiry(cfg.auth.expiresAt, ctx.now())})`
      : "Credential: personal key",
  );
  ctx.stdout(
    `Bundle: ${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`,
  );
  if (cfg.cliPath)
    ctx.stdout(
      `CLI: ${cfg.cliPath}${existsSync(cfg.cliPath) ? "" : " (missing — re-run login)"}`,
    );
  ctx.stdout(
    `Contract: ${existsSync(contractPathFor(ctx.home)) ? contractPathFor(ctx.home) : "not cached (run: catalyst contract --refresh)"}`,
  );
  return 0;
}

/** A short human relative time for an ISO expiry, e.g. "in 14m", "in 2h", "in 6d", or "now" once past. */
function relativeExpiry(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

async function cmdMe(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const me = await fetchMe(cfg.baseUrl, await bearerFor(ctx, cfg), ctx.fetch);
  if (args.json) ctx.stdout(JSON.stringify(me));
  else {
    ctx.stdout(`${me.name} (${me.slug}) — account ${me.account}`);
    ctx.stdout(
      `principal: ${me.principal}; permissions: ${me.permissions ? me.permissions.join(", ") : "unrestricted"}`,
    );
    if (me.user)
      ctx.stdout(
        `user: ${me.user.label} (${me.user.role}); linear: ${me.user.linearUserId ?? "unmatched"}`,
      );
  }
  return 0;
}

async function cmdContract(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const [sub] = positionals(args);
  if (sub)
    throw new UsageError(
      `contract takes no positional argument (got "${sub}"); use --path <a.b.c>`,
    );
  const refresh = args.flags.refresh === true;
  const loaded = await loadContract(ctx, cfg, { refresh });
  ctx.stderr(
    `contract: ${loaded.doc.contractVersion} from ${loaded.source}${loaded.source === "cache" ? ` (${loaded.ageSeconds}s old)` : ""}`,
  );
  const path =
    typeof args.flags.path === "string" ? args.flags.path : undefined;
  const value = path ? pickPath(loaded.doc, path) : loaded.doc;
  if (path && value === undefined)
    throw new CliError(
      `the contract has nothing at "${path}"`,
      "contract-path",
    );
  ctx.stdout(
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, args.json ? 0 : 2),
  );
  return 0;
}
