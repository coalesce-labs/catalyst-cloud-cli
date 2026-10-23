// ready-copy.ts — CTC-4680: what `catalyst ready` says about a team, in words a person can act on.
//
// The check ids, states and reason codes stay in `--json` (`id`) for scripts. The `line`, `fix` and
// `who` a person reads never carry a check id, a reason code, an API route or the word "tenant", and
// every fix is either a full URL or a step in Linear's own settings. `line` keeps its `team KEY: `
// prefix because install.sh strips exactly that before printing a team row.

import type { ContractReadinessCheck } from "./contract-types.js";

/** Who fixes each check: the cloud's CHECK_FIXER (catalyst-cloud packages/types workflow-readiness.ts),
 *  copied as data so an older cloud that sends no fixer still gets a sentence. */
type Fixer =
  | "nobody"
  | "owner_or_admin"
  | "owner_or_admin_in_linear"
  | "host_operator"
  | "repository_admin";

const FIXER: Record<string, Fixer> = {
  oauth_scope: "owner_or_admin",
  token_live: "owner_or_admin",
  team_visible: "owner_or_admin_in_linear",
  mapped_states_exist: "owner_or_admin",
  mapping_total: "owner_or_admin",
  types_compatible: "owner_or_admin",
  labels_present: "nobody",
  writes_land: "owner_or_admin",
  webhook_covers_team: "owner_or_admin",
  hosts_current: "host_operator",
  environment_declared: "owner_or_admin",
  tools_resolvable: "owner_or_admin",
  required_values: "owner_or_admin",
  reviewer_required: "owner_or_admin",
  reviewer_configured: "nobody",
  reviewer_answering: "repository_admin",
  linear_automation_pr_open: "owner_or_admin_in_linear",
  linear_automation_pr_review: "owner_or_admin_in_linear",
  linear_automation_pr_ready: "owner_or_admin_in_linear",
  linear_automation_pr_merge: "owner_or_admin_in_linear",
  merge_queue_configured: "repository_admin",
  coding_account_enrolled: "owner_or_admin",
  github_app_installed: "repository_admin",
  thoughts_reachable: "repository_admin",
};

const WHO: Record<Fixer, string> = {
  nobody: "nobody; it clears on its own",
  owner_or_admin: "an owner or admin of your Catalyst workspace",
  owner_or_admin_in_linear: "an admin of your Linear workspace",
  host_operator: "whoever runs your Catalyst host",
  repository_admin: "an admin of the team's GitHub repository",
};

/** Who fixes a check, as a phrase. An unknown check goes to the workspace's owners and admins. */
export function whoFixes(checkId: string): string {
  return WHO[FIXER[checkId] ?? "owner_or_admin"];
}

const SLOT_WORDS: Record<string, string> = {
  dispatch: "starting work",
  intake: "intake",
  research: "research",
  plan: "planning",
  implement: "writing the code",
  remediate: "fixing review findings",
  verify: "checking the work",
  review: "review",
  pr: "pull requests",
  done: "Done",
  canceled: "Canceled",
};

function wordList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function slotList(slots: readonly string[]): string {
  return wordList(slots.map((s) => SLOT_WORDS[s] ?? s.replaceAll("_", " ")));
}

function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

type ValuesFacts = Pick<ContractReadinessCheck, "names" | "unresolved" | "repos">;
const identifiers = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string" && NAME.test(name))
    : [];
const unresolvedFacts = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((row: { name?: unknown; references?: unknown } | null) =>
        typeof row?.name === "string" && NAME.test(row.name) && identifiers(row.references).length
          ? [{ name: row.name, references: identifiers(row.references) }]
          : [],
      )
    : [];

/** The declared names a failing check carries, kept in the receipt for the fix line: which variables
 * need a value, which refer to a secret with no value, and the same for the team's other
 * repositories. Identifiers and repository names only. */
export function valuesFacts(value: unknown): ValuesFacts {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    names: identifiers(row.names),
    unresolved: unresolvedFacts(row.unresolved),
    repos: Array.isArray(row.repos)
      ? row.repos.flatMap((note: Record<string, unknown> | null) =>
          typeof note?.repo === "string" && REPOSITORY.test(note.repo)
            ? [{ repo: note.repo, names: identifiers(note.names), unresolved: unresolvedFacts(note.unresolved) }]
            : [],
        )
      : [],
  };
}

/** How the named variables get their values: the CLI's own verbs, which read each value from a
 *  hidden prompt. Names only: nothing here reads or prints a value. */
function setValuesFix(names: readonly string[]): string {
  const name = names.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(names[0]!) ? names[0] : "NAME";
  return `set ${names.join(", ")} with catalyst var set ${name} --repo <owner/name> (catalyst secret set ${name} --repo <owner/name> for a secret)`;
}

function nameList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
}

/** Entries whose name and references are both present; anything malformed is dropped, not guessed. */
function unresolvedList(v: unknown): { name: string; references: string[] }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((u) => {
    if (typeof u !== "object" || u === null) return [];
    const { name, references } = u as { name?: unknown; references?: unknown };
    const refs = nameList(references);
    return typeof name === "string" && name.length > 0 && refs.length > 0
      ? [{ name, references: refs }]
      : [];
  });
}

function unresolvedLine(u: { name: string; references: string[] }): string {
  const which = u.references.length === 1 ? "which has" : "which have";
  return `${u.name} refers to ${u.references.join(", ")}, ${which} no value, so Catalyst can't start work there`;
}

/** A team check's fix line. A check that carries `names` (CTC-3561: `required_values`, contract
 *  1.24.0) names them and where to set them. CTC-3606: it also names each `unresolved` variable and
 *  the reference with no value, and each other repository's missing names from `repos[]`. `unresolved`
 *  is a subset of `names` (the variable exists; its reference does not), so those are not told to be
 *  "set". Every field is optional so an older cloud still works. Everything printed is a declared
 *  identifier or a repository name, never a value, and nothing here reads a value. Any other check
 *  keeps the generic line. Shared with setup's values step, which has no web address when the
 *  saved login has none. */
export function valuesFix(
  _base: string | undefined,
  c: Pick<ContractReadinessCheck, "names" | "unresolved" | "repos">,
): string | null {
  const unresolved = unresolvedList(c.unresolved);
  const unresolvedNames = new Set(unresolved.map((u) => u.name));
  const names = nameList(c.names).filter((n) => !unresolvedNames.has(n));
  const parts: string[] = [];
  if (names.length > 0) parts.push(setValuesFix(names));
  for (const u of unresolved) parts.push(unresolvedLine(u));
  for (const note of Array.isArray(c.repos) ? c.repos : []) {
    if (
      typeof note !== "object" ||
      note === null ||
      typeof note.repo !== "string" ||
      note.repo.length === 0
    )
      continue;
    const repoUnresolved = unresolvedList(note.unresolved);
    const skip = new Set(repoUnresolved.map((u) => u.name));
    const missing = nameList(note.names).filter((n) => !skip.has(n));
    if (missing.length > 0)
      parts.push(`${note.repo} is missing ${missing.join(", ")}`);
    for (const u of repoUnresolved)
      parts.push(`in ${note.repo}, ${unresolvedLine(u)}`);
  }
  return parts.length === 0 ? null : parts.join(". ");
}



export interface PlainRow {
  line: string;
  fix?: string;
}

/** The dispatch gate: whether Catalyst may start any ticket in the team. */
export function dispatchGateCopy(
  baseUrl: string,
  key: string,
  status: string,
  missingSlots: readonly string[],
): PlainRow {
  if (status === "open")
    return { line: `team ${key}: Catalyst can start ${key} tickets` };
  // CTC-4708: the cloud says the mapping is saved and its copy of Linear hasn't caught up. That is a
  // wait, not something to fix.
  if (status === "stages_syncing")
    return {
      line: `team ${key}: Catalyst is still copying ${key}'s stages from Linear. It starts ${key} tickets once that finishes.`,
    };
  const slots = missingSlots.length > 0 ? slotList(missingSlots) : "its moves";
  if (status === "mapping_missing")
    return {
      line: `team ${key}: Catalyst doesn't know which ${key} stages to use for ${slots}. Until it does, it starts no ${key} tickets.`,
      fix: `run catalyst team map ${key}`,
    };
  if (status === "mapping_state_unresolved")
    // The gate reads Catalyst's own copy of the team, which can lag Linear by a minute after a team
    // is created or its workflow is set up (CTC-4680 Rerun A). Say that, not "map your stages".
    return {
      line: `team ${key}: Catalyst can't find the stages it uses for ${slots} in its copy of ${key} yet. Until it can, it starts no ${key} tickets.`,
      fix: `if you just set up ${key}, run catalyst ready again in a minute. If this stays, run catalyst team check ${key}`,
    };
  return {
    line: `team ${key}: Catalyst can't start ${key} tickets yet.`,
    fix: `run catalyst team check ${key} to see why`,
  };
}

const AUTOMATION_RULES: Record<string, { rule: string; when: string }> = {
  linear_automation_pr_open: { rule: "On PR open", when: "when a pull request opens" },
  linear_automation_pr_review: {
    rule: "On PR review request or activity",
    when: "when a pull request gets a review",
  },
  linear_automation_pr_ready: {
    rule: "On PR ready for merge",
    when: "when a pull request is ready to merge",
  },
  linear_automation_pr_merge: { rule: "On PR merge", when: "when a pull request merges" },
};

/** Plain names for checks with no sentence of their own below. */
const CHECK_NAMES: Record<string, string> = {
  labels_present: "Catalyst's labels in Linear",
  writes_land: "Catalyst's changes to Linear",
  webhook_covers_team: "events from Linear and GitHub for this team",
  hosts_current: "your connected Catalyst hosts",
  environment_declared: "the repository's settings file",
  tools_resolvable: "the tools the repository's settings name",
  reviewer_required: "the required code reviewer",
  reviewer_configured: "a code reviewer",
  reviewer_answering: "the code reviewer's answers",
  merge_queue_configured: "the repository's merge queue",
  github_app_installed: "Catalyst on GitHub",
  thoughts_reachable: "the thoughts repository",
};

/** The names above that read as plural ("labels need attention"). */
const PLURAL = new Set([
  "labels_present",
  "writes_land",
  "webhook_covers_team",
  "hosts_current",
  "tools_resolvable",
  "reviewer_answering",
]);

/** The settings page that owns each check, from the cloud's CHECK_COPY settingsPath. */
const CHECK_PAGES: Record<string, string> = {
  oauth_scope: "/settings/connections",
  token_live: "/settings/connections",
  webhook_covers_team: "/settings/projects",
  hosts_current: "/settings/projects",
  environment_declared: "/settings/projects",
  tools_resolvable: "/settings/environment",
  required_values: "/settings/projects",
  reviewer_required: "/settings/projects",
  reviewer_configured: "/settings/projects",
  reviewer_answering: "/settings/projects",
  merge_queue_configured: "/settings/projects",
  coding_account_enrolled: "/settings/coding-accounts",
  github_app_installed: "/settings/projects",
  thoughts_reachable: "/settings/projects",
};

/** The command that fixes a check, offered before its page. A check with no command keeps the page. */
const CHECK_COMMANDS: Record<string, (key: string) => string> = {
  webhook_covers_team: (key) => `an owner or admin registers the repository with catalyst onboard --team ${key} --repo <owner/name>`,
  hosts_current: () => "run catalyst onboard --runner on the machine that runs the work",
  tools_resolvable: () => "set the missing secret with catalyst secret set NAME --repo <owner/name>, or fix the repository's .catalyst/catalyst.toml",
  reviewer_required: () => "relax the merge policy with catalyst var set CATALYST_MERGE_EVIDENCE_POLICY --repo <owner/name> (if .catalyst/catalyst.toml declares the policy, change it there instead, because the declaration wins), or configure a reviewer",
};

const AGAIN = "run catalyst ready again in a few minutes";

/** One failing or unknown team check, in plain words. `valuesFix` is the variable-naming fix the
 *  caller already built for `required_values`, or null when the cloud named no variable. */
export function teamCheckCopy(
  baseUrl: string,
  key: string,
  id: string,
  state: "fail" | "unknown",
  valuesFix: string | null,
): PlainRow {
  const team = (text: string): string => `team ${key}: ${text}`;
  const base = origin(baseUrl);
  const unknown = state === "unknown";
  const automation = AUTOMATION_RULES[id];
  if (automation)
    return unknown
      ? {
          line: team(`Catalyst couldn't read ${key}'s pull request automations in Linear.`),
          fix: AGAIN,
        }
      : {
          line: team(
            `Linear moves ${key}'s tickets by itself ${automation.when}. That fights Catalyst, which moves them itself.`,
          ),
          fix: `in Linear, open Settings → Teams → ${key} → Workflow → Pull request and commit automations and set "${automation.rule}" to No action, including any branch overrides. Then run catalyst ready again`,
        };
  switch (id) {
    case "oauth_scope":
      return unknown
        ? { line: team("Catalyst couldn't check its Linear connection."), fix: "run catalyst onboard to check the Linear connection" }
        : {
            line: team("Catalyst's Linear connection is missing a permission it needs."),
            fix: "run catalyst onboard and have an owner or admin approve the Linear link it prints",
          };
    case "token_live":
      return unknown
        ? { line: team("Catalyst couldn't reach Linear to check its connection."), fix: AGAIN }
        : {
            line: team("Linear stopped accepting Catalyst's connection. It was revoked or expired."),
            fix: "run catalyst onboard and have an owner or admin approve the Linear link it prints",
          };
    case "team_visible":
      return unknown
        ? { line: team(`Catalyst hasn't confirmed it can see ${key} in Linear yet.`), fix: AGAIN }
        : {
            line: team(`Catalyst can't see ${key} in Linear, usually because the team is private.`),
            fix: `in Linear, open Settings → API → Catalyst Cloud → Team access and add ${key}`,
          };
    case "mapped_states_exist":
    case "mapping_total":
    case "types_compatible":
      if (unknown)
        return { line: team(`Catalyst is still reading ${key}'s stages from Linear.`), fix: "run catalyst ready again in a minute" };
      if (id === "mapped_states_exist")
        return {
          line: team(`A stage Catalyst uses in ${key} was deleted or renamed in Linear.`),
          fix: `pick its replacement with catalyst team map ${key}`,
        };
      if (id === "mapping_total")
        return {
          line: team(`${key}'s stages aren't all mapped yet, so Catalyst doesn't know where to move its tickets.`),
          fix: `map them with catalyst team map ${key}, or set up Catalyst's workflow with catalyst team adopt ${key}`,
        };
      return {
        line: team(`A stage mapped in ${key} is the wrong kind, for example a Done stage that Linear treats as in progress.`),
        fix: `choose the right stages with catalyst team map ${key}`,
      };
    case "required_values":
      return unknown
        ? {
            line: team(`Catalyst hasn't finished reading the settings of ${key}'s repositories yet.`),
            fix: "nothing to do; Catalyst reads them on its own. Run catalyst ready again in a minute to see the result",
          }
        : {
            line: team(`A variable ${key}'s repository needs has no value, so Catalyst can't run its work.`),
            fix: valuesFix ?? setValuesFix(["the missing values"]),
          };
    case "coding_account_enrolled":
      return unknown
        ? { line: team("Catalyst couldn't check your AI accounts."), fix: AGAIN }
        : {
            line: team("Catalyst has no AI account to do the work with."),
            fix: `an owner or admin adds one at ${base}/settings/coding-accounts; there is no command for that yet`,
          };
  }
  const name = CHECK_NAMES[id] ?? id.replaceAll("_", " ");
  const page = CHECK_PAGES[id];
  const command = CHECK_COMMANDS[id]?.(key);
  return unknown
    ? { line: team(`Catalyst hasn't checked ${name} yet.`), fix: AGAIN }
    : {
        line: team(`${name.charAt(0).toUpperCase()}${name.slice(1)} ${PLURAL.has(id) ? "need" : "needs"} attention.`),
        fix: command
          ? page ? `${command}, or open ${base}${page}` : command
          : page ? `open ${base}${page}` : `run catalyst team check ${key} to see why`,
      };
}
