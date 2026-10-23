// ready.ts — `ready`: the machine checks plus the tenant's own readiness vector from the contract,
// one verdict, and per failure the fix and who can apply it. The replica is optional, so its absence
// is a note, never a failure; the HTTP SDK loading is a check for cloud reads.
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { ParsedArgs } from "./args.js";
import {
  DEFAULT_BASE_URL,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  defaultSkillsDirFor,
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  upgradeCommand,
  type Ctx,
  type CustomerConfig,
} from "./config.js";
import { contractVersionInRange, readContractCache } from "./contract.js";
import { CliError } from "./errors.js";
import { latestPublishedVersion, type PublishedLookup } from "./published.js";
import {
  replicaStatus,
  writerIsRunning,
  type ReplicaStatus,
} from "./replica.js";
import { loadHttpSdk } from "./sdk.js";
import {
  FIX_COMMAND,
  detectRuntime,
  runtimeVerdict,
  supportedRangeText,
  type RuntimeFacts,
} from "./runtime.js";
import { semverOlder } from "./semver.js";
import { FIRST_STAMPED_VERSION } from "./skill-shape.js";
import { installedBundleVersion } from "./skills.js";
import {
  onboardingReadyReport,
  observeCloudOnboarding,
  type OnboardingReadyDeps,
} from "./onboard-ready.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import { dispatchGateCopy, teamCheckCopy, valuesFix, whoFixes } from "./ready-copy.js";
import { onboardStatePath, readOnboardJournal } from "./onboard.js";

export { semverOlder };

export interface ReadyCheck {
  id: string;
  ok: boolean;
  /** true when the check is informational and never flips the verdict. */
  note?: boolean;
  line: string;
  fix?: string;
  who?: string;
}

export interface ReadyReport {
  ready: boolean;
  checks: ReadyCheck[];
  /** The replica document `replica status --json` prints, so `ready --json` carries the writer's
   *  stopped state, failure count and last error without a second shape to keep in step. */
  replica: ReplicaStatus;
}

/** `ready`'s own wording for the replica. It never recommends adopting the replica — until the
 *  mirror's snapshot path is safe for a large tenant, a customer following that advice is the
 *  failure mode. It DOES name the restart command when the writer gave up, because that is an
 *  instruction about a thing already running, not a nudge to adopt one (CTC-2499). */
function readyReplicaLine(s: ReplicaStatus): string {
  const w = s.writer;
  if (w?.stopped) {
    return (
      `replica: the writer stopped ${new Date(w.stopped.at).toISOString()}: ${w.stopped.reason} ` +
      `(last error: ${w.lastError}) — the replica is optional and every read ` +
      `still works through the API; restart it with: ${w.stopped.restartWith}`
    );
  }
  if (w && w.consecutiveFailures > 0) {
    // Present tense only for a writer that is actually running: the record survives a SIGKILL, and
    // "is backing off" about a dead process promises a retry that will never come (CTC-2499).
    if (!writerIsRunning(s)) {
      return `replica: the writer recorded ${w.consecutiveFailures} failed snapshot pulls and is no longer running (last error: ${w.lastError}) — the replica is optional and every read still works through the API`;
    }
    return `replica: the writer has failed ${w.consecutiveFailures} snapshot pulls in a row and is backing off (last error: ${w.lastError}) — reads fall back to the API`;
  }
  switch (s.verdict) {
    case "not-configured":
      return "replica: not configured — run login first";
    case "absent":
      return `replica: absent at ${s.dbPath} — optional, and off by default for large workspaces while the snapshot path is being made safe; every read works through the API`;
    case "fresh":
      return `replica: fresh at ${s.dbPath} (cursor ${s.cursor}, heartbeat ${s.heartbeatAgeMs}ms ago${s.lag !== undefined ? `, ${s.lag} behind head ${s.head}` : ""})`;
    case "stale":
      return `replica: stale at ${s.dbPath} (${s.reasons.join("; ")}${s.cursor !== null ? `; cursor ${s.cursor}` : ""}) — reads fall back to the API`;
  }
}

/** The first executable file called `name` on `env.PATH`, or null. */
export function firstOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here, or not executable: keep looking, as a shell would
    }
  }
  return null;
}

/** True when `path` resolves to the `catalyst` launcher of this CLI or of its forwarder package. */
export function isThisCliLauncher(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  if (basename(real) !== "catalyst.js" || basename(dirname(real)) !== "bin")
    return false;
  try {
    const raw = JSON.parse(
      readFileSync(join(dirname(dirname(real)), "package.json"), "utf8"),
    ) as { name?: unknown };
    return raw.name === PACKAGE_NAME || raw.name === LEGACY_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * CTC-3479 — the name `catalyst` is also the catalyst-dev router, which install-cli.sh links into
 * ~/.catalyst/bin and puts at the front of PATH. Where it wins, `catalyst ready` runs the router, not
 * this CLI. `ready` cannot fix that, but it can say so: a note (never a failure, because
 * `catalyst-skills` still reaches this CLI) naming the program that answers to `catalyst`. Nothing
 * on PATH is normal while the old name is still the one installed, so that emits nothing. POSIX
 * only: on Windows npm installs `.cmd` shims, and PATHEXT lookup is not worth guessing at here.
 */
export function catalystCommandCheck(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ReadyCheck | null {
  if (platform === "win32") return null;
  const found = firstOnPath("catalyst", env);
  if (found === null) return null;
  if (isThisCliLauncher(found))
    return {
      id: "command",
      ok: true,
      line: `command: catalyst on PATH is this CLI (${found})`,
    };
  return {
    id: "command",
    ok: false,
    note: true,
    line:
      `command: catalyst on PATH is ${found}, a different program with the same name, so \`catalyst <verb>\` does not reach this CLI. ` +
      "Keep using catalyst-skills on this machine, or put the npm global bin directory ahead of that one on PATH.",
  };
}

export interface ReadyDeps {
  onboarding?: OnboardingReadyDeps;
  /** CTC-2158: replaces `nodeMajor`. A check called `node` cannot honestly describe bun, and under
   *  bun it used to print bun's Node-*compat* major as if it were Node. Test seam; defaults to the
   *  real process's runtime. */
  runtime?: RuntimeFacts;
  skillNames: readonly string[];
  /** Test seam for the SDK-loads check. */
  loadSdk?: () => Promise<unknown>;
  /** Test seam for the published-release lookup (CTC-2160). NO test may reach the real registry. */
  fetchLatestRelease?: () => Promise<PublishedLookup>;
  /** Skip the published-release lookup entirely (--offline / CATALYST_SKILLS_OFFLINE=1). */
  offline?: boolean;
}

export async function readyReport(
  ctx: Ctx,
  deps: ReadyDeps,
): Promise<ReadyReport> {
  const checks: ReadyCheck[] = [];
  const facts = deps.runtime ?? detectRuntime();
  const verdict = runtimeVerdict(facts, readManifest().enginesNode);
  checks.push({
    id: "runtime",
    ok: verdict.supported,
    line: verdict.line,
    ...(verdict.supported ? {} : { fix: verdict.fix, who: "you" }),
  });

  let cfg: CustomerConfig | null = null;
  try {
    cfg = loadConfig(ctx.home);
    checks.push(
      cfg
        ? {
            id: "config",
            ok: true,
            // `principal` is "service" for every api key (it means "a key, not a browser session"); it
            // never names a person. Since CTC-2076 a personal key's /me carries a `user` block, so name
            // the connected person when there is one, and fall back to the account for a host key.
            line: cfg.user
              ? `config: joined ${cfg.name} as ${cfg.user.label} (${cfg.user.role})`
              : `config: joined ${cfg.name} (${cfg.slug}) as ${cfg.principal}`,
          }
        : {
            id: "config",
            ok: false,
            line: "config: not connected",
            fix: "npx -p @catalyst-cloud/cli catalyst login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN)",
            who: "you (approve the login in your browser)",
          },
    );
  } catch (err) {
    checks.push({
      id: "config",
      ok: false,
      line: `config: ${err instanceof CliError ? err.message : String(err)}`,
      fix: "re-run login to rewrite it",
      who: "you",
    });
  }

  const cache = readContractCache(ctx.home);
  const range = readManifest().tenantContractRange;
  if (!cache) {
    checks.push({
      id: "contract",
      ok: false,
      line: "contract: not cached",
      fix: "catalyst contract --refresh",
      who: "you",
    });
  } else if (contractVersionInRange(cache.contractVersion, range) !== true) {
    checks.push({
      id: "contract",
      ok: false,
      line: `contract: version ${cache.contractVersion} is outside this bundle's range ${range}`,
      fix: upgradeCommand(),
      who: "you",
    });
  } else {
    checks.push({
      id: "contract",
      ok: true,
      line: `contract: ${cache.contractVersion} cached ${cache.fetchedAt} (range ${range})`,
    });
  }

  // The cloud MAY publish the bundle it expects (catalyst-cloud#3746). Read it defensively: warn (never
  // refuse) when this installed bundle is older than the minimum, and emit nothing when the field is
  // absent (an older cloud) — a stale bundle is a degrading note, so `ready` still returns READY.
  const minVersion = cache?.doc.skillsBundle?.minVersion;
  if (minVersion) {
    const installed = readManifest().version;
    if (semverOlder(installed, minVersion)) {
      checks.push({
        id: "bundle",
        ok: false,
        note: true,
        line: `bundle: ${installed} installed is older than your workspace's minimum ${minVersion} — upgrade: ${upgradeCommand()}`,
      });
    }
  }

  // CTC-2160 — the two artefacts a customer installs drift apart: the CLI comes from npm, the skill
  // files come from `npx skills add` (GitHub) or the plugin, and only the CLI's own version was ever
  // knowable here. Both are NOTES: being behind a publish is a degrading fact about an install that
  // still works, so `ready` stays READY. This is the one place `ready` touches the network, and it is
  // capped, cached and skippable — see src/published.ts.
  const skillsDir = cfg?.skillsDir ?? defaultSkillsDirFor(ctx.home);
  const offline =
    deps.offline === true || ctx.env.CATALYST_SKILLS_OFFLINE === "1";
  if (!offline) {
    const pub = await (
      deps.fetchLatestRelease ?? (() => latestPublishedVersion(ctx))
    )();
    if (pub.latest === null) {
      checks.push({
        id: "cliRelease",
        ok: false,
        note: true,
        line: `cliRelease: could not check for a newer release (${pub.reason}) — nothing about this install is known to be wrong; re-run when the network is back`,
      });
    } else {
      // clause 2 — the CLI. Suppressed when the tenant-minimum note already named this binary (D9).
      const installedCli = readManifest().version;
      const bundleNoteFired = checks.some((c) => c.id === "bundle");
      if (!bundleNoteFired && semverOlder(installedCli, pub.latest)) {
        checks.push({
          id: "cliRelease",
          ok: false,
          note: true,
          line: `cliRelease: ${installedCli} installed is older than the latest published ${pub.latest} — upgrade: ${upgradeCommand()}`,
        });
      }
      // clause 1 — the skill files on disk, read independently of whichever CLI is answering. Both
      // facts can hold at once: a machine that pulled at different hours carries some skills stamped
      // behind AND some old enough to carry no stamp at all — the field report's own mixed install.
      // So they are ADDITIVE, not exclusive: an unstamped file's real version is unknown and may be
      // older than any stamp, which is why the stamped half says "oldest STAMPED" and the unstamped
      // names are always printed rather than hidden behind whichever branch happened to win.
      const found = installedBundleVersion(skillsDir, deps.skillNames);
      const stampBehind =
        found.version !== null && semverOlder(found.version, pub.latest);
      const unstampedBehind =
        found.unstamped.length > 0 &&
        !semverOlder(pub.latest, FIRST_STAMPED_VERSION);
      if (stampBehind || unstampedBehind) {
        const facts: string[] = [];
        if (stampBehind)
          facts.push(
            `the oldest stamped skill is ${found.version} (${found.skill})`,
          );
        if (unstampedBehind) {
          const one = found.unstamped.length === 1;
          facts.push(
            `${found.unstamped.join(", ")} ${one ? "carries" : "carry"} no version and so ${one ? "predates" : "predate"} ${FIRST_STAMPED_VERSION}`,
          );
        }
        checks.push({
          id: "skillsRelease",
          ok: false,
          note: true,
          line: `skillsRelease: in ${skillsDir} ${facts.join(", and ")}, while the published bundle is ${pub.latest} — update: npx skills update -y`,
        });
      }
    }
  }

  if (cfg) {
    checks.push(
      cfg.cliPath && existsSync(cfg.cliPath)
        ? { id: "cliPath", ok: true, line: `cliPath: ${cfg.cliPath}` }
        : {
            id: "cliPath",
            ok: false,
            line: `cliPath: ${cfg.cliPath ? `${cfg.cliPath} does not exist` : "not recorded"}`,
            fix: "re-run login so the skill scripts can find this CLI",
            who: "you",
          },
    );
  }

  const command = catalystCommandCheck(ctx.env);
  if (command) checks.push(command);

  // The skills are installed by the customer's own agent (a plugin, or `npx skills add`), so an
  // empty copy directory is the normal case and must not read as NOT READY. A PARTIAL copy is the
  // one broken state this check can see: half a set this package put there and never finished.
  const present = deps.skillNames.filter((n) =>
    existsSync(join(skillsDir, n, "SKILL.md")),
  );
  const missing = deps.skillNames.filter((n) => !present.includes(n));
  if (present.length === 0) {
    checks.push({
      id: "skills",
      ok: true,
      note: true,
      line: `skills: none copied to ${skillsDir} — you are reading one, so your agent installed them its own way`,
    });
  } else if (missing.length === 0) {
    checks.push({
      id: "skills",
      ok: true,
      line: `skills: all ${deps.skillNames.length} present in ${skillsDir}`,
    });
  } else {
    checks.push({
      id: "skills",
      ok: false,
      line: `skills: ${present.length} of ${deps.skillNames.length} in ${skillsDir}, missing ${missing.join(", ")}`,
      fix: "catalyst install",
      who: "you",
    });
  }

  try {
    await (deps.loadSdk ?? loadHttpSdk)();
    checks.push({
      id: "sdk",
      ok: true,
      line: "sdk: loads (cloud HTTP reads are available)",
    });
  } catch (err) {
    checks.push({
      id: "sdk",
      ok: false,
      line: `sdk: ${err instanceof Error ? err.message : String(err)}`,
      fix: `${verdict.fix ?? FIX_COMMAND} — supported: ${supportedRangeText(readManifest().enginesNode)}; every read still works through the API meanwhile`,
      who: "you",
    });
  }

  const replica = replicaStatus(ctx, cfg);
  checks.push({
    id: "replica",
    ok: replica.verdict === "fresh",
    note: true,
    line: readyReplicaLine(replica),
  });

  if (cache) {
    const doc = cache.doc;
    const base = (cfg?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    for (const team of doc.teams) {
      const label = team.key ?? team.id;
      // The team's dispatch gate, straight off the cached contract: an older cloud omits it and this
      // emits nothing (the `skillsBundle` precedent above). A shut gate means NOTHING in the team can
      // start, so it is a FAIL carrying the cloud's own remedy as the fix — never an informational
      // note. It is emitted before the `unchecked` branch below so a team whose readiness was never
      // checked still reports its gate, which is exactly the team most likely to be unmapped.
      const dg = team.dispatchGate;
      if (dg && typeof dg.status === "string") {
        // CTC-4680: the cloud's own remedy text names an API route and says "tenant", so the words
        // come from ready-copy; the status and slots stay readable in the check id's JSON neighbours.
        const copy = dispatchGateCopy(base, label, dg.status, dg.missingSlots ?? []);
        checks.push(
          dg.status === "stages_syncing"
            ? {
                id: `team:${label}:dispatchGate`,
                ok: false,
                note: true,
                line: copy.line,
              }
            : dg.status === "open"
            ? {
                id: `team:${label}:dispatchGate`,
                ok: true,
                line: copy.line,
              }
            : {
                id: `team:${label}:dispatchGate`,
                ok: false,
                line: copy.line,
                ...(copy.fix ? { fix: copy.fix } : {}),
                who: whoFixes("mapping_total"),
              },
        );
      }
      if (team.readiness.status === "unchecked") {
        checks.push({
          id: `team:${label}`,
          ok: true,
          note: true,
          line: `team ${label}: Catalyst hasn't checked this team yet`,
        });
        continue;
      }
      const bad = team.readiness.checks.filter((c) => c.state !== "pass");
      if (bad.length === 0 && team.readiness.status === "ready") {
        checks.push({
          id: `team:${label}`,
          ok: true,
          line: `team ${label}: ready`,
        });
        continue;
      }
      for (const c of bad) {
        const meta = doc.readinessChecks.find((r) => r.id === c.id);
        const needsAnswer = meta?.needsAnswer ?? true;
        const copy = teamCheckCopy(
          base,
          label,
          c.id,
          c.state === "fail" ? "fail" : "unknown",
          valuesFix(base, c),
        );
        checks.push({
          id: `team:${label}:${c.id}`,
          ok: !needsAnswer && c.state !== "fail",
          note: !needsAnswer,
          line: copy.line,
          ...(copy.fix ? { fix: copy.fix } : {}),
          who: needsAnswer ? whoFixes(c.id) : "nobody yet; it is informational",
        });
      }
      if (bad.length === 0 && team.readiness.status !== "ready") {
        checks.push({
          id: `team:${label}`,
          ok: team.readiness.status !== "blocked",
          note: team.readiness.status === "degraded",
          line:
            team.readiness.status === "degraded"
              ? `team ${label}: works, with some optional settings still missing`
              : `team ${label}: not ready for work yet`,
          fix: `run catalyst team check ${label} to see what is missing`,
          who: whoFixes("mapping_total"),
        });
      }
    }
  }

  const ready = checks.every((c) => c.ok || c.note);
  return { ready, checks, replica };
}

export async function cmdReady(
  args: ParsedArgs,
  ctx: Ctx,
  deps: ReadyDeps,
): Promise<number> {
  if (args.flags.onboarding === true) {
    let onboarding = deps.onboarding;
    if (!onboarding) {
      const cfg = loadConfig(ctx.home);
      const journal = readOnboardJournal(
        onboardStatePath(ctx.home, ctx.env),
        readManifest().version,
        ctx.now(),
      );
      const bound =
        cfg?.user &&
        journal &&
        (journal.account ?? journal.tenant) === cfg.account &&
        journal.membershipId === cfg.user.id &&
        typeof journal.baseUrl === "string" &&
        normalizeBaseUrl(journal.baseUrl) === normalizeBaseUrl(cfg.baseUrl);
      const team = bound ? selectedOnboardTeam(journal) : undefined;
      onboarding = {
        teamIds: team ? [team] : undefined,
        localSync:
          args.flags["local-sync"] === true ||
          Boolean(bound && journal.localSync),
        observe: observeCloudOnboarding,
      };
    }
    const report = await onboardingReadyReport(ctx, onboarding);
    if (args.json) ctx.stdout(JSON.stringify(report));
    else {
      for (const check of report.checks)
        ctx.stdout(
          `${check.state === "pass" ? "ok" : check.state === "fail" ? "needs attention" : "waiting for evidence"}  ${check.id}${check.reason ? `: ${check.reason}` : ""}`,
        );
      if (report.work.state === "observed")
        ctx.stdout(
          `Work observed${report.work.ticket ? ` on ${report.work.ticket}` : ""}.`,
        );
      else
        ctx.stdout("Fresh project work has not been verified by this check.");
      ctx.stdout(
        report.state === "complete"
          ? "Onboarding complete."
          : "Setup still needs checks. Resume: catalyst onboard",
      );
    }
    return report.state === "complete"
      ? 0
      : report.checks.some((check) => check.required && check.state === "fail")
        ? 10
        : 11;
  }
  const report = await readyReport(ctx, deps);
  if (args.json) {
    ctx.stdout(JSON.stringify(report));
  } else {
    for (const c of report.checks) {
      ctx.stdout(`${c.note ? "note" : c.ok ? "ok " : "FAIL"}  ${c.line}`);
      if (!c.ok && !c.note) {
        if (c.fix) ctx.stdout(`      fix: ${c.fix}`);
        if (c.who) ctx.stdout(`      who: ${c.who}`);
      }
    }
    ctx.stdout(report.ready ? "READY" : "NOT READY");
  }
  return report.ready ? 0 : 1;
}
