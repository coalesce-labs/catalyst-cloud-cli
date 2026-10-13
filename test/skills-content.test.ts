// skills-content.test.ts — the content gate for the customer skills: the directory set equals
// the CLI's constant, every skill passes the shape validator (frontmatter, provenance, budgets,
// linked references, node-only scripts, the mutating triple), every file under skills/ plus the
// README and the current CHANGELOG entry are free of internal names, each skill's scripts reach the
// cloud only through the catalyst-skills verbs it promises, the README states what a customer
// needs in the order they need it, and no description an agent picks a skill by states a
// readiness-check count the engine does not report (CTC-2560, the last describe in this file).
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { CUSTOMER_SKILLS, PROVENANCE_MARKER } from "../src/cli";
import {
  ADVISORIES,
  EXCLUSION_REASONS,
  UNKNOWN_REASONS,
} from "../src/execution";
import {
  FORBIDDEN_CONTENT,
  MAX_REFERENCE_LINES,
  MAX_SKILL_LINES,
  parseProvenanceVersion,
  validateSkillDir,
} from "../src/skill-shape";
import { parseNodeFloor } from "../src/runtime";
import { buildFixtureContract } from "./fixture-contract";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const skillsRoot = join(pkgRoot, "skills");
const manifest = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  publishConfig: { access: string };
  catalystCloud?: { tenantContractRange?: string; pinnedNode?: string };
  dependencies?: Record<string, string>;
};

// The roster, in one place. Named for what it is, not for how many rows it has — the count that used
// to live in this identifier's name is the same class of defect as a count written into prose.
const ROSTER = [
  "catalyst-github",
  "catalyst-linear",
  "catalyst-onboard",
  "run-this-project",
  "unstick",
  "what-needs-me",
  "what-this-repo-needs",
  "whats-happening",
] as const;

/** The skills whose scripts write something, or that drive a person through writes; their
 *  portability sidecar says `mutating: true` and lists the effects. Writing is not the same as being
 *  manual-only: every skill here may be picked by the model, and each write is governed by the
 *  product's own scoped controls (the write budget, a preview or dry run, the person's own login). */
const MUTATING = new Set([
  "catalyst-linear",
  "catalyst-onboard",
  "what-needs-me",
  "run-this-project",
  "unstick",
]);

/** The per-team readiness checks the engine reports, in wire order. The bundle cannot import the
 *  engine's own READINESS_CHECK_IDS: it lives in @catalyst-cloud/types, which is not published and
 *  is not a dependency of this package (pinned by the dependency test below). This array is the one
 *  place the check vocabulary is written down here — the page's table and the test fixture are both
 *  held to it, so adding a check is one line plus one documented row. */
const TEAM_CHECK_IDS = [
  "oauth_scope",
  "token_live",
  "team_visible",
  "mapped_states_exist",
  "mapping_total",
  "types_compatible",
  "labels_present",
  "writes_land",
  "webhook_covers_team",
  "hosts_current",
  "environment_declared",
  "tools_resolvable",
  "reviewer_required",
  "reviewer_configured",
] as const;

// CTC-2014 Tier 2 (route half): the tenant settings routes this bundle's customer-facing prose is
// allowed to write. The bundle cannot import them — the web app that owns these routes is a separate
// repository and is not a dependency here — so this is a VENDORED roster, held in both directions by
// the gate below: an entry no page uses is as much a defect as a page route that is not on the
// roster. `$repoId` is a literal placeholder, matched after normalising any `$`-prefixed URL segment.
// Compiled by grepping this repository's own tree (`grep -rhno "/settings/[a-zA-Z0-9$/_-]*"
// skills/*/SKILL.md skills/*/references/*.md README.md`), compiled 2026-09-19 (CTC-2014). Two
// routes the ticket's own source research named — `/settings/members` and `/settings/api-keys` —
// are deliberately NOT here: every page that names those two screens already does so as prose
// ("Settings → Members", "Settings → API keys"), the bundle's existing convention for a page with
// no ticket-mandated literal-route rule, and an unused entry would fail the reverse-direction gate
// below on day one. Add either the day a rule needs its literal route written down.
// `/settings/linear-teams/$teamKey` left the roster when the guides switched to `catalyst team
// check|map|adopt <KEY>`: no page names that route any more, so the reverse gate would fail on it.
const SETTINGS_ROUTES = [
  "/settings/connections",
  "/settings/projects",
  "/settings/projects/$projectId/repositories/$repoId/environment/declaration",
  "/settings/projects/$projectId/repositories/$repoId/merging",
  "/settings/projects/$projectId/repositories/$repoId/code-reviews",
  "/settings/coding-accounts",
  "/settings/secrets",
  "/settings/environment",
  "/settings/profile",
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const skill = (name: string) =>
  readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
const scriptsOf = (name: string) =>
  walk(join(skillsRoot, name, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
const referencesOf = (name: string) => {
  const dir = join(skillsRoot, name, "references");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
};
const lineCount = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

describe("the customer skills ship, with provenance", () => {
  test("exactly the skills the design names are present, sorted, and equal the CLI's constant", () => {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...ROSTER]);
    expect([...CUSTOMER_SKILLS]).toEqual([...ROSTER]);
  });

  for (const name of ROSTER) {
    test(`${name}: passes the shape validator with no findings`, () => {
      expect(validateSkillDir(join(skillsRoot, name))).toEqual([]);
    });

    test(`${name}: frontmatter name matches, description present, provenance comment on the line after the fence`, () => {
      const md = skill(name);
      expect(md.startsWith("---\n")).toBe(true);
      expect(md).toContain(`name: ${name}\n`);
      expect(md).toMatch(/^description:\n? +\S/m);
      expect(md).toContain(PROVENANCE_MARKER);
      const lines = md.split("\n");
      const close = lines.indexOf("---", 1);
      expect(close).toBeGreaterThan(0);
      expect(lines[close + 1]).toMatch(
        /^<!--.*vendored-from: @catalyst-cloud\/catalyst-skills/,
      );
    });

    test(`${name}: SKILL.md stays inside ${MAX_SKILL_LINES} lines and every reference inside ${MAX_REFERENCE_LINES}, each linked by its literal path`, () => {
      const md = skill(name);
      expect(lineCount(md)).toBeLessThanOrEqual(MAX_SKILL_LINES);
      const refs = referencesOf(name);
      expect(
        refs.length,
        `${name} must carry at least one reference`,
      ).toBeGreaterThan(0);
      expect(md).toMatch(/^## Load on demand\s*$/m);
      for (const f of refs) {
        expect(
          lineCount(
            readFileSync(join(skillsRoot, name, "references", f), "utf8"),
          ),
        ).toBeLessThanOrEqual(MAX_REFERENCE_LINES);
        expect(md, `${name} must link references/${f}`).toContain(
          `references/${f}`,
        );
      }
    });

    test(`${name}: every script is a node script with --help that reaches the cloud only by spawning the CLI`, () => {
      const files = walk(join(skillsRoot, name, "scripts")).filter((f) =>
        f.endsWith(".mjs"),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const rel = relative(skillsRoot, f);
        expect(
          src.startsWith("#!/usr/bin/env node"),
          `${rel} must start with #!/usr/bin/env node`,
        ).toBe(true);
        expect(src, `${rel} must print --help`).toContain("--help");
        expect(src, `${rel} must not call the cloud itself`).not.toMatch(
          /\bfetch\s*\(/,
        );
        expect(src, `${rel} must not import an HTTP client`).not.toMatch(
          /["']node:https?["']/,
        );
        expect(src, `${rel} must not import a package`).not.toMatch(
          /from\s+["'](?!node:|\.\.?\/)[^"']+["']/,
        );
      }
      expect(
        existsSync(join(skillsRoot, name, "scripts", "lib", "cli.mjs")),
      ).toBe(true);
      const lib = readFileSync(
        join(skillsRoot, name, "scripts", "lib", "cli.mjs"),
        "utf8",
      );
      expect(lib).toContain("customer.json");
      expect(lib).toContain("cliPath");
      // The fallback when no CLI path is recorded: npx, with this package as the target. Some libs
      // build that argv from a constant, so assert the two parts rather than one joined literal.
      expect(lib, `${name} lib must fall back to npx`).toMatch(/["']npx["']/);
      expect(lib, `${name} lib must name this package`).toContain(
        "@catalyst-cloud/cli",
      );
    });

    test(`${name}: the model may pick it, and it is ${MUTATING.has(name) ? "marked as writing" : "marked read-only"}`, () => {
      const md = skill(name);
      const portability = readFileSync(
        join(skillsRoot, name, "agents", "portability.yaml"),
        "utf8",
      );
      const openai = readFileSync(
        join(skillsRoot, name, "agents", "openai.yaml"),
        "utf8",
      );
      expect(portability).toMatch(/^effects:\s*\[.*\]\s*$/m);
      expect(portability).toMatch(/^exposure:\s*\[\s*"?catalog"?\s*\]\s*$/m);
      expect(openai).toMatch(/^policy:\s*$/m);
      // Invocation is not authorization: no Cloud skill is manual-only, in any of the three places.
      expect(md).not.toMatch(/^disable-model-invocation:/m);
      expect(openai).toMatch(/allow_implicit_invocation:\s*true/);
      expect(portability).toMatch(/^invocation:\s*implicit\s*$/m);
      expect(/^mutating:\s*true\s*$/m.test(portability)).toBe(
        MUTATING.has(name),
      );
      if (MUTATING.has(name))
        expect(portability).not.toMatch(/^effects:\s*\[\s*\]\s*$/m);
      else expect(portability).toMatch(/^effects:\s*\[\s*\]\s*$/m);
    });
  }

  test("no *.log file anywhere under skills/", () => {
    expect(walk(skillsRoot).filter((f) => /\.log$/i.test(f))).toEqual([]);
  });
});

describe("no internal name reaches a customer", () => {
  const CUSTOMER_TEXT: { label: string; text: string }[] = [
    ...walk(skillsRoot).map((f) => ({
      label: relative(pkgRoot, f),
      text: readFileSync(f, "utf8"),
    })),
    {
      label: "README.md",
      text: readFileSync(join(pkgRoot, "README.md"), "utf8"),
    },
    {
      label: `CHANGELOG.md ## ${manifest.version}`,
      text: changelogEntry(manifest.version),
    },
  ];

  function changelogEntry(version: string): string {
    const md = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    const start = md.indexOf(`## ${version}\n`);
    expect(
      start,
      `CHANGELOG.md must carry a ## ${version} entry`,
    ).toBeGreaterThanOrEqual(0);
    const rest = md.slice(start + `## ${version}\n`.length);
    const next = rest.indexOf("\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  }

  test("positive control: the same matcher finds every planted string in a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-skills-planted-"));
    const planted = join(dir, "planted.md");
    writeFileSync(
      planted,
      [
        "tenant-0",
        "coalesce-labs/catalyst",
        "thoughts/shared",
        "CTC-1",
        "CTL-22",
        "Linearis",
        "catalyst-replica",
        "LINEAR_API_TOKEN",
        "https://api.linear.app/graphql",
      ].join("\n"),
    );
    const text = readFileSync(planted, "utf8");
    const hits = FORBIDDEN_CONTENT.filter((f) => f.re.test(text)).map(
      (f) => f.name,
    );
    expect(hits).toHaveLength(FORBIDDEN_CONTENT.length);
  });

  for (const f of FORBIDDEN_CONTENT) {
    test(`nothing customer-facing mentions ${f.name}`, () => {
      const offenders = CUSTOMER_TEXT.filter((t) => f.re.test(t.text)).map(
        (t) => t.label,
      );
      expect(offenders).toEqual([]);
    });
  }

  test("no skill text composes a request itself: no curl, no fetch, no node:http anywhere under skills/", () => {
    const offenders = walk(skillsRoot)
      .filter((f) => !f.endsWith(".json"))
      .filter((f) =>
        /\bcurl\s|\bfetch\s*\(|node:https?\b/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(pkgRoot, f));
    expect(offenders).toEqual([]);
  });

  test("the desk's fact references restate no account value: no state id and no team key from the contract fixture", () => {
    const contract = buildFixtureContract();
    const stateIds = contract.teams.flatMap((t) =>
      Object.values(t.stages).map((s) => s.stateId),
    );
    const teamKeys = contract.teams.map((t) => t.key);
    expect(stateIds.length).toBeGreaterThan(0);
    expect(teamKeys.length).toBeGreaterThan(0);
    const text = referencesOf("whats-happening")
      .map((f) =>
        readFileSync(
          join(skillsRoot, "whats-happening", "references", f),
          "utf8",
        ),
      )
      .join("\n");
    for (const id of stateIds) expect(text).not.toContain(id);
    for (const key of teamKeys)
      expect(text).not.toMatch(new RegExp(`\\b${key}\\b`));
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});

describe("each skill's scripts spawn the catalyst verbs it teaches", () => {
  const verbs: Record<(typeof ROSTER)[number], RegExp[]> = {
    // Each grain by its own instrument: the machine by `status` and `ready`, the person by `me`, and
    // the account, the projects and the repositories by three DIFFERENT `contract --path` reads. A
    // regression that folded any of these into one call would take this assertion with it.
    "catalyst-onboard": [
      /"status"/,
      /"ready",\s*"--json"/,
      /"replica",\s*"status",\s*"--probe",\s*"--json"/,
      /"events",\s*"status",\s*"--from-cache",\s*"--probe",\s*"--json"/,
      /"replica",\s*"start",\s*"--detach"/,
      /"me",\s*"--json"/,
      /"connections",\s*"personal"/,
      /"contract",\s*"--path",\s*"account"/,
      /"contract",\s*"--refresh",\s*"--path",\s*"teams"/,
      /"contract",\s*"--path",\s*"merge\.repositories"/,
      /"environment",\s*"read"/,
      /"accounts",\s*"--json"/,
      /"contract",\s*"--path",\s*"readinessChecks"/,
    ],
    "catalyst-github": [
      /"query",\s*"pull"/,
      /"contract"/,
      /"replica",\s*"status"/,
    ],
    "catalyst-linear": [
      /"query",\s*"issue"/,
      /"query",\s*"search"/,
      /"write",\s*"comment"/,
      /"write",\s*"state"/,
      /"write",\s*"label"/,
      /"write",\s*"create"/,
    ],
    "run-this-project": [
      /"watch"/,
      /"write",\s*"state"/,
      /"write",\s*"comment"/,
    ],
    "what-needs-me": [
      /"ask",\s*"list"/,
      /"ask",\s*"raise"/,
      /"ask",\s*"accept"/,
    ],
    "what-this-repo-needs": [/"env",\s*"inventory"/, /"env",\s*"check"/],
    "whats-happening": [
      /"contract"/,
      /"running"/,
      /"queue"/,
      /"ask",\s*"list"/,
      /"replica",\s*"status"/,
      /"explain"/,
      /"accounts"/,
      /"contract",\s*"--path"/,
    ],
    unstick: [/"explain"/, /"--history"/, /"release"/, /"--dry-run"/],
  };
  for (const name of ROSTER) {
    test(`${name}`, () => {
      const src = scriptsOf(name);
      for (const re of verbs[name])
        expect(src, `${name} scripts must spawn ${re}`).toMatch(re);
      expect(
        src,
        "every script passes --json to the CLI for machine-read output",
      ).toContain("--json");
    });
  }

  test("onboarding keeps local sync optional and waits for the first ticket event honestly", () => {
    const onboard = skill("catalyst-onboard");
    const path = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "the-one-path.md"),
      "utf8",
    );
    const localSync = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "local-sync.md"),
      "utf8",
    );
    expect(onboard).toContain("Local sync is opt-in");
    expect(onboard).toContain("references/local-sync.md");
    expect(path).toContain(
      "optional first-event check in `references/local-sync.md`",
    );
    // CTC-4554 — the cloud wait is the default first-ticket wait; the cache wait is the opt-in.
    expect(localSync).toContain(
      "catalyst events wait-for --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300",
    );
    expect(localSync).toContain(
      "catalyst events wait-for --from-cache --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300",
    );
    for (const [capture, wait] of [
      ["record its `head`", "events wait-for --ticket"],
      ["record its `cursor`", "events wait-for --from-cache --ticket"],
    ]) {
      const cursorCapture = localSync.indexOf(capture);
      const cardMove = localSync.indexOf("Move the card", cursorCapture);
      const eventWait = localSync.indexOf(wait, cardMove);
      expect(cursorCapture).toBeGreaterThanOrEqual(0);
      expect(cardMove).toBeGreaterThan(cursorCapture);
      expect(eventWait).toBeGreaterThan(cardMove);
    }
    expect(localSync).toContain("Exit 4 means the cloud event service was unreachable");
    expect(localSync).toContain(
      "Exit 1 means no matching cached event arrived within five minutes",
    );
    expect(localSync).toContain("without inferring a cloud or webhook failure");
    expect(localSync).toContain("replica status --probe --json");
    expect(localSync).toContain("events status --from-cache --probe --json");
    expect(localSync).toContain(
      "replica freshness alone does not prove event freshness",
    );
  });

  test("skills that write move cards by slot or state type, never by a stage name literal", () => {
    for (const name of [
      "catalyst-linear",
      "run-this-project",
      "what-needs-me",
    ]) {
      const src = scriptsOf(name);
      expect(src).toMatch(/--slot|--state-type/);
      expect(src).not.toMatch(/--state-id",\s*"[0-9a-f-]{20,}/);
    }
  });

  test("the asking skills point at their neighbours instead of restating them", () => {
    expect(skill("whats-happening")).toContain("catalyst-onboard");
    expect(skill("whats-happening")).toContain("catalyst-linear");
    expect(skill("whats-happening")).toContain("catalyst-github");
    expect(skill("whats-happening")).toContain("what-needs-me");
    expect(skill("catalyst-onboard")).toContain("whats-happening");
    expect(skill("run-this-project")).toContain("what-needs-me");
  });

  test("no skill text names a retired skill", () => {
    const RETIRED = /\b(?:connect-me|catalyst-setup|how-catalyst-works)\b/;
    expect("run the `connect-me` skill").toMatch(RETIRED); // positive control
    const offenders = walk(skillsRoot)
      .filter((f) => RETIRED.test(readFileSync(f, "utf8")))
      .map((f) => relative(pkgRoot, f));
    expect(offenders).toEqual([]);
  });
});

describe("the install page (README) states what a customer needs, in the order they need it", () => {
  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  const contributing = readFileSync(join(pkgRoot, "CONTRIBUTING.md"), "utf8");

  const installBlock = readFileSync(
    join(pkgRoot, ".agents", "install-block.md"),
    "utf8",
  );

  test("the install section leads, and it is the ecosystem's own command per tool, never ours", () => {
    const install = readme.indexOf("\n## Install\n");
    expect(install, "README must carry an ## Install section").toBeGreaterThan(
      0,
    );
    // Nothing may sit between the title and the install block. A what-it-is preamble first is the
    // failure this asserts against: the headline IS the install command, never an explanation.
    const firstSection = readme.indexOf("\n## ");
    expect(
      firstSection,
      "## Install must be the FIRST section in the README",
    ).toBe(install);
    const beforeInstall = readme.slice(0, install);
    expect(
      beforeInstall.split("\n").filter((l) => l.trim().length > 0),
      "only the title and the badge precede ## Install",
    ).toHaveLength(2);
    for (const later of [
      "## What this is",
      "## Requirements",
      "## The skills",
    ]) {
      expect(
        readme.indexOf(`\n${later}\n`),
        `${later} must come after ## Install`,
      ).toBeGreaterThan(install);
    }
    for (const cmd of [
      "/plugin marketplace add coalesce-labs/catalyst-cloud-skills",
      "/plugin install catalyst@catalyst-cloud",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills -a codex",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills -a cursor",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g",
    ]) {
      expect(readme, `the install block must carry ${cmd}`).toContain(cmd);
      expect(
        installBlock,
        `.agents/install-block.md must carry ${cmd}`,
      ).toContain(cmd);
    }
    expect(
      readme,
      "two rails without an exclusivity sentence leave every skill installed twice",
    ).toMatch(/installing both leaves you with every skill twice/i);
    expect(installBlock).toMatch(
      /installing both leaves you with every skill twice/i,
    );
    expect(
      readme,
      "the copied rail does not auto-update and the README must say so",
    ).toMatch(/do not auto-update/i);
    expect(readme).toContain("skills.sh/b/coalesce-labs/catalyst-cloud-skills");
  });

  test("the credential step sits inside the install block, named login, keyless first and the key forms second", () => {
    const install = readme.indexOf("\n## Install\n");
    // Keyless is the preferred rail: the bare `catalyst-skills login` triple leads.
    const keyless =
      "npm install -g @catalyst-cloud/cli\ncatalyst login\ncatalyst ready";
    const envForm = "CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst login";
    // "Beside the install commands" is the property: the connect step is a sub-heading of Install,
    // and the login command lands before the next top-level section starts.
    const connect = readme.indexOf(
      "\n### Then connect to your cloud account\n",
    );
    expect(
      connect,
      "the connect step must be a ### inside ## Install",
    ).toBeGreaterThan(install);
    const nextSection = readme.indexOf("\n## ", install + 1);
    expect(nextSection).toBeGreaterThan(0);
    expect(
      readme.indexOf(keyless),
      "the keyless login command must be inside the install section",
    ).toBeGreaterThan(install);
    expect(readme.indexOf(keyless)).toBeLessThan(nextSection);
    expect(connect).toBeLessThan(nextSection);
    // The README claims to quote the canonical block; that claim has to be checkable.
    expect(installBlock).toContain("### Then connect to your cloud account");
    expect(readme).toContain(keyless);
    expect(installBlock).toContain(keyless);
    expect(readme).toContain(envForm);
    expect(installBlock).toContain(envForm);
    // Keyless leads; the key forms (env, then --key) come after it.
    expect(
      readme.indexOf(keyless),
      "keyless login must come before the key fallback",
    ).toBeLessThan(readme.indexOf(envForm));
    expect(
      readme.indexOf("--key <your-personal-key>"),
      "the env form must come before the --key form",
    ).toBeGreaterThan(readme.indexOf(envForm));
    // The 0.1 verb must not lead, and `install` is a repair path that never appears as a headline step.
    expect(readme).not.toMatch(/^.*catalyst-skills join\b/m);
    expect(
      readme.indexOf("catalyst install"),
      "install is a repair path, never part of the install headline",
    ).toBe(-1);
  });

  test("tenant discovery from the key alone via GET /api/v1/me; config path, mode and the contract cache stated", () => {
    expect(readme).toContain("GET /api/v1/me");
    expect(readme).toContain("~/.config/catalyst-cloud/customer.json");
    expect(readme).toContain("0600");
    expect(readme).toContain("~/.config/catalyst-cloud/contract.json");
    expect(readme).toContain("GET /api/v1/agent/contract");
  });

  test("every skill is linked, and the reader is never told to read the skills before installing", () => {
    for (const name of CUSTOMER_SKILLS) {
      expect(readme, `README must link skills/${name}/SKILL.md`).toContain(
        `skills/${name}/SKILL.md`,
      );
    }
    expect(readme).not.toMatch(/read the skills first/i);
    expect(readme).not.toMatch(
      /marketplace add[^\n]*is how (customers|you) install/,
    );
  });

  test("states the minimum versions: Node 22 with its built-in SQLite, better-sqlite3 if it resolves, Bun optional", () => {
    expect(readme).toMatch(/^## Requirements$/m);
    expect(readme).toMatch(/Node 22/);
    expect(readme).not.toMatch(/Node 18/);
    expect(readme).toMatch(/built-in SQLite/);
    expect(readme).toMatch(/better-sqlite3/);
    expect(readme).toMatch(/Bun is optional/);
  });

  test("states the pinned tenant contract range in present tense, with no internal ticket ids anywhere", () => {
    expect(readme).toContain("`1.x || 2.x`");
    expect(readme).not.toContain("`0.x`");
    expect(readme).toContain("tenantContractRange");
    expect(readme, "a customer README names no internal ticket").not.toMatch(
      /\bC[TL]C-\d+\b/,
    );
    expect(readme).toContain("vendored-from");
  });

  test("says what has to be running: nothing by default, the optional replica with its four exit codes, the watch", () => {
    expect(readme).toMatch(/^## What has to be running$/m);
    expect(readme).toContain("catalyst replica start");
    expect(readme).toContain("--detach");
    expect(readme).toContain("catalyst replica status");
    expect(readme).toContain("catalyst events status --from-cache --probe");
    expect(readme).toContain("read from the cloud by default, with no local file");
    expect(readme).toContain("A fresh replica does not prove event freshness");
    expect(readme).toMatch(
      /`0` for fresh, `1` for present but stale, `2` for not connected, `3` for absent/,
    );
    expect(readme).toContain("catalyst watch");
    expect(readme).toContain("seven days or 256 MiB");
  });

  test("names what a key cannot see yet and where those facts live, and the one connect step", () => {
    expect(readme).toMatch(/^## What a key cannot see yet$/m);
    expect(readme).toContain("settings/coding-accounts");
    expect(readme).toContain("explain --history");
    // A person releases a park themselves now; the README names the verb and the skill, never an operator.
    expect(readme).toContain("catalyst release");
    expect(readme).not.toMatch(
      /Release a park\. When a ticket is parked after repeated failures, an operator releases it/,
    );
    expect(readme).toContain("setup skill");
    expect(readme).toContain("the only connect step a customer runs");
    // CTC-2077 — a person connects with their OWN key; the account key is named once, as the host
    // credential it is; "API keys" is the settings page's name, so it may appear in that phrase only.
    expect(readme).toContain("personal key");
    expect(readme).toContain("<your-personal-key>");
    expect(readme).not.toContain("<your-account-key>");
    expect(readme).toContain("Settings → API keys");
    expect(
      readme.match(/\bAPI keys?\b/g)?.every((m) => m === "API keys") ?? true,
    ).toBe(true);
    expect(readme).not.toMatch(/not visible to an account key yet/);
  });

  test("documents the one-line update notice and the uninstall of everything it wrote; the publish secret lives in CONTRIBUTING", () => {
    expect(readme).toContain("[catalyst] updated");
    expect(readme).toContain("npm install -g @catalyst-cloud/cli@latest");
    // The install alone does not rewrite customer.json.cliPath — the re-login step must be documented.
    expect(readme).toMatch(
      /npm install -g @catalyst-cloud\/cli@latest && catalyst login/,
    );
    expect(readme).not.toMatch(/npm update -g/);
    for (const name of CUSTOMER_SKILLS)
      expect(readme, `uninstall must name ${name}`).toContain(`\`${name}\``);
    for (const f of [
      "customer.json",
      "contract.json",
      "published.json",
      "replica.db",
      "replica.db.pid",
      "replica.db.writer.lock",
      "replica.db.writer.state",
      "watch-cursor.json",
    ]) {
      expect(readme, `uninstall must name ${f}`).toContain(f);
    }
    expect(readme).not.toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("skills-bundle-v<version>");
  });

  test("the replica reference explains that the writer stops after repeated snapshot failures", () => {
    const ref = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "local-sync.md"),
      "utf8",
    );
    expect(ref).toContain("consecutive snapshot failures");
    expect(ref).toContain("replica status");
  });

  test("the machine-check table documents every id ready can emit, including the version-drift notes", () => {
    const ref = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "reading-ready.md"),
      "utf8",
    );
    const start = ref.indexOf("\n## The machine checks the CLI adds\n");
    const end = ref.indexOf("\n## ", start + 1);
    const section = ref.slice(start, end === -1 ? undefined : end);
    for (const id of [
      "runtime",
      "config",
      "contract",
      "bundle",
      "cliPath",
      "skills",
      "cliRelease",
      "skillsRelease",
      "sdk",
      "replica",
    ]) {
      expect(section, `the machine table must document ${id}`).toMatch(
        new RegExp(`\`${id}\``),
      );
    }
  });
});

test("onboarding inventories teams without running every team's readiness check", () => {
  const guide = readFileSync(
    join(skillsRoot, "catalyst-onboard", "references", "the-one-path.md"),
    "utf8",
  );
  const reporter = readFileSync(
    join(skillsRoot, "catalyst-onboard", "scripts", "where-am-i.mjs"),
    "utf8",
  );
  expect(guide).toContain("team list");
  expect(guide).toContain("only for the selected team");
  expect(guide).not.toContain("team check --all` to list teams");
  expect(guide).toContain("--yes --plan-hash <hash>");
  expect(reporter).toContain("project list");
  expect(reporter).toContain("projectCoverageLines");
  expect(reporter).not.toContain("team check --all to inspect the live list");
});

describe("the package manifest", () => {
  test("is the documented name, public, and carries the SDK plus yaml (env inventory's workflow reader) as its runtime dependencies", () => {
    expect(manifest.name).toBe("@catalyst-cloud/cli");
    expect(manifest.publishConfig.access).toBe("public");
    // yaml moved here from devDependencies: a hand-written line scanner over a GitHub workflow
    // silently loses names written in flow style, which is exactly the failure `env inventory`
    // exists to avoid — the real parser costs one dependency with zero transitive dependencies of
    // its own. `test/smoke-publish.test.ts` packs and installs the real tarball, so this is exercised
    // end to end, not just asserted here.
    // CTC-4625: fast-wrap-ansi is the wrapper @clack/prompts itself ships with (already in the
    // tree); `catalyst setup` wraps with it directly, so it is declared at the same pinned version.
    expect(manifest.dependencies).toEqual({
      "@catalyst-cloud/sdk": "0.16.5",
      "@catalyst-cloud/sdk-replica-node": "0.16.5",
      "@clack/prompts": "1.8.1",
      "fast-wrap-ansi": "0.2.2",
      "fast-string-width": "3.0.2",
      yaml: expect.stringMatching(/^\^2\./),
      "smol-toml": expect.stringMatching(/^\^1\./),
    });
  });

  test("bin, shipped files, engines, and the pinned contract range are wired", () => {
    expect(manifest.bin.catalyst).toBe("bin/catalyst.js");
    expect(manifest.bin["catalyst-skills"]).toBe("bin/catalyst-skills.js");
    for (const f of [
      "bin",
      "dist",
      "skills",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
    ]) {
      expect(manifest.files).toContain(f);
    }
    for (const file of Object.values(manifest.bin))
      expect(existsSync(join(pkgRoot, file))).toBe(true);
    // CTC-2158: the floor is 22.15, not 22. Measured: Node 22.14.0 has no node:module.registerHooks,
    // so `ready` reported `ok node: 22` on a runtime where `sdk` could not load. `>=22` was a promise
    // this package does not keep.
    expect(manifest.engines.node).toBe(">=22.15");
    expect(manifest.catalystCloud?.tenantContractRange).toBe("1.x || 2.x");
    expect(manifest.catalystCloud?.pinnedNode).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the pinned runtime satisfies the declared engines range", () => {
    const floor = parseNodeFloor(manifest.engines.node);
    const [maj, min, pat] = manifest
      .catalystCloud!.pinnedNode!.split(".")
      .map(Number);
    expect(
      maj! > floor.major ||
        (maj === floor.major &&
          (min! > floor.minor || (min === floor.minor && pat! >= floor.patch))),
    ).toBe(true);
  });
});

describe("CTC-2158: CI derives its Node matrix and exercises bun in both directions", () => {
  const ci = readFileSync(
    join(pkgRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const publish = readFileSync(
    join(pkgRoot, ".github", "workflows", "publish.yml"),
    "utf8",
  );

  test("ci.yml derives its Node matrix from the script and hard-codes no Node major", () => {
    expect(ci).toContain("scripts/node-support-matrix.mjs");
    // CTC-2158/D9: a literal list is exactly what the recorded decision says not to repeat.
    expect(ci).not.toMatch(/node-version:\s*\[/);
    expect(ci).toMatch(/matrix\.node/);
    expect(ci).not.toMatch(/node-version:\s*22\b/);
  });

  test("ci.yml runs the built CLI under a real bun, in both directions", () => {
    expect(ci).toMatch(/bun-version:\s*1\.3\.14/); // the version that must FAIL FRIENDLY
    expect(ci).toMatch(/bun-version:\s*(\$\{\{\s*matrix\.bun\s*\}\}|latest)/); // the version that must LOAD THE SDK
    expect(ci).toMatch(/bin\/catalyst-skills\.js ready/);
    expect(ci).toMatch(/friendly-refusal/);
    expect(ci).toMatch(/sdk-loads/);
  });

  test("publish.yml derives its Node from engines too, not a literal major", () => {
    expect(publish).not.toMatch(/node-version:\s*22\b/);
    expect(publish).toMatch(/node-version-file:\s*package\.json/);
  });

  test("the plugin manifests make this repository its own marketplace, at the package's version", () => {
    const marketplace = JSON.parse(
      readFileSync(join(pkgRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string; description?: string }[];
    };
    expect(marketplace.name).toBe("catalyst-cloud");
    expect(marketplace.owner.name).toBe("Coalesce Labs");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "catalyst",
      source: "./",
    });
    expect(
      marketplace.plugins[0]!.description,
      "the gallery row needs a one-liner",
    ).toBeTruthy();

    const plugin = JSON.parse(
      readFileSync(join(pkgRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      name: string;
      description: string;
      version: string;
      author: { name: string };
      skills: string[];
    };
    expect(plugin.name).toBe("catalyst");
    expect(plugin.author.name).toBe("Coalesce Labs");
    expect(plugin.description).toBeTruthy();
    // A plugin whose version never moves looks to Claude Code like a bundle that never shipped;
    // `npm run version:sync` is what keeps these two equal, and --check fails CI on drift.
    expect(plugin.version, "run: npm run version:sync").toBe(manifest.version);
    expect(plugin.skills).toEqual(CUSTOMER_SKILLS.map((n) => `./skills/${n}`));
    for (const p of plugin.skills) {
      expect(existsSync(join(pkgRoot, p, "SKILL.md")), `${p} must exist`).toBe(
        true,
      );
    }
  });

  test("the ticket-reading reference names --all as the way past the first page (CTC-2010)", () => {
    const md = readFileSync(
      join(pkgRoot, "skills/catalyst-linear/references/reading-a-ticket.md"),
      "utf8",
    );
    expect(md).toContain("--all");
  });

  test("the version matches the CHANGELOG's top entry", () => {
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${manifest.version}\n`);
    expect(changelog.match(/^## (\d+\.\d+\.\d+)$/m)?.[1]).toBe(manifest.version);
  });

  test("every shipped skill stamps the package version on its provenance line", () => {
    for (const name of CUSTOMER_SKILLS) {
      const md = skill(name);
      const lines = md.split("\n");
      const close = lines.indexOf("---", 1);
      const line = lines[close + 1] ?? "";
      expect(
        parseProvenanceVersion(line),
        `${name} — run: npm run version:sync`,
      ).toBe(manifest.version);
    }
  });

  test("the sync script's --check agrees with the committed tree", () => {
    const r = spawnSync(
      process.execPath,
      [join(pkgRoot, "scripts", "sync-plugin-version.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  // A skills/ subdirectory with no SKILL.md is a state installSkills (src/skills.ts) skips on purpose;
  // the stamping loop used to read it unguarded and die with an uncaught ENOENT, taking down both
  // `npm run version:sync` (a release step) and the --check above.
  test("the sync script skips a skills/ subdirectory with no SKILL.md instead of crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "catalyst-version-sync-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    mkdirSync(join(root, "skills", "references-only"), { recursive: true }); // no SKILL.md
    copyFileSync(
      join(pkgRoot, "scripts", "sync-plugin-version.mjs"),
      join(root, "scripts", "sync-plugin-version.mjs"),
    );
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ version: manifest.version }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ version: manifest.version }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "skills", "alpha", "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: x",
        "---",
        `<!-- ${PROVENANCE_MARKER}@${manifest.version} -->`,
        "",
      ].join("\n"),
    );
    const r = spawnSync(
      process.execPath,
      [join(root, "scripts", "sync-plugin-version.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain("ENOENT");
  });

  test("CTC-2158: the 0.8.0 changelog entry records the Node 26 fix and the runtime contract", () => {
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    const top = changelog
      .split(/^## /m)
      .find((entry) => entry.startsWith("0.8.0\n"))!;
    expect(top).toMatch(/^0\.8\.0/);
    expect(top).toMatch(/Node 26/);
    expect(top).toMatch(/22\.15/);
    expect(top).toMatch(/bun/);
    expect(top).toMatch(/runtime install/);
  });
});

// A customer's agent read `gitAutomation: "off"` as the reason nothing started. No Catalyst code reads
// that field; an unmapped team is the cause, and it never clears on the next pass.
describe("the dispatch gate is the stage mapping, not git automation", () => {
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");

  test("stages-and-mapping no longer claims git automation deletes anything, and says nothing reads it", () => {
    const text = read("whats-happening/references/stages-and-mapping.md");
    expect(text).not.toMatch(/can delete a team's own review automation/);
    expect(text).toMatch(/`teams\[\]\.gitAutomation`[^\n]*nothing reads it/);
  });

  test("the reason table carves an unmapped team out of 'clears on the next pass'", () => {
    for (const rel of ["whats-happening/references/why-is-it-stuck.md"]) {
      expect(read(rel)).toMatch(
        /`workflow_mapping_unknown`[^\n]*(does not|never) clear/,
      );
    }
  });

  test("the readiness guide describes setting up one team as the pilot", () => {
    const text = read("catalyst-onboard/references/reading-ready.md");
    expect(text).toMatch(/one team/i);
    expect(text).toMatch(/no other team/i);
    // Headless first: the guide names the command, never the page's button.
    expect(text).toContain("catalyst team map <KEY>");
    expect(text).not.toContain("Map my stages");
  });
});

// CTC-2542: the page documents every readiness check the engine reports, and nothing hand-writes a
// count of them. What this gate actually holds is the PAGE against `TEAM_CHECK_IDS` above — this
// repository's own vendored roster — so a row dropped, renamed, duplicated or left out of wire order
// reddens here, as does a hand-written count coming back. It cannot notice the engine adding a
// fifteenth check: nothing in this repository imports `READINESS_CHECK_IDS` (see the array's comment
// at the top of this file), so a new check is one line there plus one documented row, by hand. That
// is why the page itself names the contract's `readinessChecks[]` as the list of record.
describe("the readiness guide documents every readiness check, and no file counts them", () => {
  const pagePath = "catalyst-onboard/references/reading-ready.md";
  const page = () => readFileSync(join(skillsRoot, pagePath), "utf8");
  const HEADING = "## The checks";

  /** Rows of the table directly under `heading`, up to the next `## ` heading. Each row is its
   *  trimmed cells, in file order; the header and separator rows are excluded. */
  function tableRows(text: string, heading: string): string[][] {
    const lines = text.split("\n");
    const start = lines.indexOf(heading);
    expect(
      start,
      `heading "${heading}" must be present`,
    ).toBeGreaterThanOrEqual(0);
    const rows: string[][] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("## ")) break;
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
      if (cells[0] === "check id") continue; // header row
      rows.push(cells);
    }
    return rows;
  }

  test("the table lists exactly the fourteen check ids, in wire order", () => {
    const rows = tableRows(page(), HEADING);
    expect(rows.map((r) => r[0])).toEqual(
      TEAM_CHECK_IDS.map((id) => `\`${id}\``),
    );
  });

  test("every row carries all four columns, none empty", () => {
    const rows = tableRows(page(), HEADING);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      for (const cell of row) expect(cell.length).toBeGreaterThan(0);
    }
  });

  test("no file under skills/ or the README states a hand-written count of the readiness checks", () => {
    const COUNT_WORD = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)`;
    const CHECK_PHRASE = String.raw`(?:readiness|per-team|team)\s+checks?`;
    const wideRule = new RegExp(
      String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+${CHECK_PHRASE}\b`,
      "i",
    );
    const dashCheckRule = new RegExp(
      String.raw`\b${COUNT_WORD}-checks?\b`,
      "i",
    );
    // The count can also sit BEFORE a bare "checks" with the readiness noun AFTER it — "fourteen
    // checks per team", "fourteen checks for each team". The pre-noun rule above walks straight past
    // those, so the name of this test would have promised coverage it did not have.
    const postNounRule = new RegExp(
      String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+checks?\s+(?:per|for|on|against)\s+(?:each\s+|every\s+|the\s+|a\s+)?team`,
      "i",
    );
    const RULES = [wideRule, dashCheckRule, postNounRule];
    // The page rule: the whole page is about readiness checks, so any count word before a bare
    // "check"/"checks" here is this defect, even without "readiness"/"per-team"/"team" beside it.
    // It stays scoped to the page — a bare "the two checks" is ordinary prose anywhere else.
    const pageRule = new RegExp(
      String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+checks?\b`,
      "i",
    );

    // ⭐ positive control, on fixed strings only, so it still fires when the pages are broken: each
    // phrasing this gate claims to cover must match at least one of its rules. The last two are the
    // post-noun form a mutation proved was walking through (CTC-2542 validate attempt 1, finding 3).
    for (const stale of [
      "the ten per-team readiness checks the cloud runs",
      "The engine always reports all eleven checks",
      "## The eleven checks",
      "tenant readiness from the contract's ten per-team checks",
      "a ten-check readiness vector",
      "The engine reports fourteen checks per team.",
      "fourteen readiness checks for each team",
    ]) {
      expect(
        [...RULES, pageRule].some((r) => r.test(stale)),
        `no rule matches "${stale}"`,
      ).toBe(true);
    }

    const mdFiles = [
      join(pkgRoot, "README.md"),
      ...walk(skillsRoot).filter((f) => f.endsWith(".md")),
    ];
    for (const f of mdFiles) {
      const text = readFileSync(f, "utf8");
      const rel = relative(pkgRoot, f);
      for (const rule of RULES) {
        expect(
          text,
          `${rel} must not name a readiness-check count`,
        ).not.toMatch(rule);
      }
    }

    expect(page(), `${pagePath} must not name any check count`).not.toMatch(
      pageRule,
    );
  });

  test("the fixture contract's readinessChecks ids equal the documented list", () => {
    const contract = buildFixtureContract();
    expect(contract.readinessChecks.map((c) => c.id)).toEqual([
      ...TEAM_CHECK_IDS,
    ]);
  });
});

// CTC-2014 Tier 1 ② + Tier 2 (reason half): `src/execution.ts`'s EXCLUSION_REASONS, UNKNOWN_REASONS
// and ADVISORIES are this bundle's vendored copy of the cloud's eligibility-evaluator vocabulary —
// `test/execution.test.ts:161-162` already pins their lengths (38 / 11 / 1). This describe block is
// what "cites the enforcing code path" for that vocabulary: every row on the two customer-facing pages
// traces back to the same constants a script actually prints, not to a hand-typed guess. It gates two
// things at once: (1) every reason the CLI can print has a row on both pages a customer is sent to, in
// both directions — a stray reason string that drifted off the live roster reddens here exactly as a
// missing one does; (2) every EXCLUSION_REASONS row on `why-is-it-stuck.md` names who acts, in the
// ticket's own three-actor vocabulary plus the fourth honest answer, "no one acts".
describe("the stuck-state catalogue is complete and every exclusion reason names who acts", () => {
  const HOW = "whats-happening/references/what-runs-next.md";
  const STUCK = "whats-happening/references/why-is-it-stuck.md";
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");

  const REASON_TOKEN = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
  const ACTOR_VOCAB =
    /the person, with their own login|a workspace owner or admin, in settings|\ban operator\b|no one acts/;
  // A routing outcome, not an eligibility exclusion reason: measured at `what-runs-next.md:40`. The
  // one documented allowance a stray reason string needs to be added deliberately, not by drift.
  const ALLOWED_NON_ROSTER = ["no_eligible_account_slot"];

  test("⭐ positive control: the reason matcher reads a row and rejects a header, on fixed strings", () => {
    expect(
      [..."| `claim_storm` | waits out the hour |".matchAll(REASON_TOKEN)].map(
        (m) => m[1],
      ),
    ).toEqual(["claim_storm"]);
    expect([..."| -- | -- |".matchAll(REASON_TOKEN)]).toHaveLength(0);
    expect([..."| reason | meaning |".matchAll(REASON_TOKEN)]).toHaveLength(0);
    expect(
      ACTOR_VOCAB.test("the person, with their own login, releases it"),
    ).toBe(true);
    expect(
      ACTOR_VOCAB.test(
        "a workspace owner or admin, in settings, maps the team",
      ),
    ).toBe(true);
    expect(ACTOR_VOCAB.test("an operator resumes it")).toBe(true);
    expect(ACTOR_VOCAB.test("no one acts; it clears on its own")).toBe(true);
    expect(ACTOR_VOCAB.test("someone will look into it")).toBe(false);
  });

  test("every reason the CLI can print has a row on the one reason table", () => {
    for (const [id] of [
      ...Object.entries(EXCLUSION_REASONS),
      ...Object.entries(UNKNOWN_REASONS),
      ...Object.entries(ADVISORIES),
    ]) {
      expect({ id, onStuck: read(STUCK).includes(`\`${id}\``) }).toEqual({
        id,
        onStuck: true,
      });
    }
  });

  // One reason table: the desk's why-is-it-stuck reference. Any other page that tables the reasons
  // row by row is the duplicate that drifted three ways before the consolidation.
  test("no other page under skills/ tables the exclusion reasons row by row", () => {
    const firstCellReasons = (text: string): number =>
      text
        .split("\n")
        .filter(
          (l) =>
            /^\|/.test(l) &&
            [...(l.split("|")[1] ?? "").matchAll(REASON_TOKEN)].some(
              (m) => m[1]! in EXCLUSION_REASONS,
            ),
        ).length;
    // ⭐ positive control on fixed strings: a planted five-row reason table is counted as five.
    const planted = [
      "| `claim_storm` | x |",
      "| `lease_held` | x |",
      "| `retry_backoff` | x |",
      "| `wip_limit` | x |",
      "| `repo_paused` | x |",
      "| reason | x |",
    ].join("\n");
    expect(firstCellReasons(planted)).toBe(5);
    const offenders = walk(skillsRoot)
      .filter(
        (f) =>
          f.endsWith(".md") &&
          !f.endsWith(
            join("whats-happening", "references", "why-is-it-stuck.md"),
          ),
      )
      .filter((f) => firstCellReasons(readFileSync(f, "utf8")) >= 5)
      .map((f) => relative(pkgRoot, f));
    expect(
      offenders,
      "point at whats-happening/references/why-is-it-stuck.md instead of repeating its rows",
    ).toEqual([]);
  });

  test("no page names a reason string the CLI cannot print", () => {
    const roster = new Set([
      ...Object.keys(EXCLUSION_REASONS),
      ...Object.keys(UNKNOWN_REASONS),
      ...Object.keys(ADVISORIES),
    ]);
    for (const rel of [HOW, STUCK]) {
      const tokens = new Set(
        [...read(rel).matchAll(REASON_TOKEN)].map((m) => m[1]),
      );
      const extra = [...tokens].filter((t) => !roster.has(t));
      expect({ rel, extra }).toEqual({
        rel,
        extra: rel === HOW ? ALLOWED_NON_ROSTER : [],
      });
    }
  });

  // CTC-2014 validate attempt 9, code-review finding 2: the "Reasons a release clears once the cause
  // is fixed" section's own lede says "These do not release themselves: once the recorded cause is
  // fixed, the person's own login releases them" — so a row in it whose who-acts cell reads "no one
  // acts" tells the desk two opposite things about the same reason id. The reasons that genuinely
  // need nobody have a section of their own; this holds the two apart.
  test("no row under the release-clears lede says 'no one acts', which that lede contradicts", () => {
    const RELEASE_CLEARS =
      "\n## Reasons a release clears once the cause is fixed\n";
    const sectionOf = (text: string, heading: string): string => {
      const start = text.indexOf(heading);
      expect(
        start,
        `heading "${heading.trim()}" must be present`,
      ).toBeGreaterThanOrEqual(0);
      const end = text.indexOf("\n## ", start + heading.length);
      return text.slice(start, end === -1 ? undefined : end);
    };

    // ⭐ positive control, on fixed strings: the slicer stops at the next heading, and a planted
    // contradicting row is caught while a legitimate one is not.
    const fixture = [
      "## Reasons a release clears once the cause is fixed",
      "| `a_reason` | means | note | the person, with their own login |",
      "| `b_reason` | means | note | no one acts |",
      "## Reasons that are not problems",
      "| `c_reason` | means | note | no one acts |",
    ].join("\n");
    const control = sectionOf(`\n${fixture}`, RELEASE_CLEARS);
    expect(
      control
        .split("\n")
        .filter((l) => l.startsWith("|") && l.includes("no one acts")),
    ).toEqual(["| `b_reason` | means | note | no one acts |"]);

    const section = sectionOf(read(STUCK), RELEASE_CLEARS);
    const contradicting = section
      .split("\n")
      .filter((l) => l.startsWith("|") && l.includes("no one acts"));
    expect(
      contradicting,
      "move these rows to 'Reasons that release themselves'",
    ).toEqual([]);
  });

  test("every exclusion reason's row on the human-facing page names who acts", () => {
    const lines = read(STUCK).split("\n");
    for (const id of Object.keys(EXCLUSION_REASONS)) {
      const rows = lines.filter((l) => l.includes(`\`${id}\``));
      expect({ id, hasRow: rows.length > 0 }).toEqual({ id, hasRow: true });
      const named = rows.some((l) => ACTOR_VOCAB.test(l));
      expect({ id, named }).toEqual({ id, named: true });
    }
  });

  // CTC-2014 remediate (validate attempt 10, code-review finding 1): `review_not_converging` and
  // `round_threshold` shipped under the "Reasons a release clears once the cause is fixed" lede,
  // whose own words are "the person's own login releases them with `catalyst-skills release
  // <ticket>`" — while `unstick/references/playbook.md`'s refusal table lists BOTH as refusals, and
  // that playbook's step 6 says "a refusal is terminal for that attempt: nothing was released". The
  // desk would read the row, route the human to `unstick`, and the cloud would refuse: the exact
  // "relay instead of guide" failure this ticket exists to remove. The sibling `human_owned_pr` was
  // filed correctly under "Reasons that need a human" with that note and these two were left
  // behind, which neither the row-presence gate nor the "no one acts" gate above can see — both
  // ask whether a row EXISTS, not whether it promises a command the cloud refuses. The refusal
  // roster is vendored prose in this repository, so the two pages can be held to each other.
  test("no reason under the release-clears lede is one the release command refuses terminally", () => {
    const RELEASE_CLEARS =
      "\n## Reasons a release clears once the cause is fixed\n";
    const REFUSALS = "\n## What a refusal means and who fixes it\n";
    const sectionOf = (text: string, heading: string): string => {
      const start = text.indexOf(heading);
      expect(
        start,
        `heading "${heading.trim()}" must be present`,
      ).toBeGreaterThanOrEqual(0);
      const end = text.indexOf("\n## ", start + heading.length);
      return text.slice(start, end === -1 ? undefined : end);
    };
    // The reason id is a row's FIRST cell; a later cell may name other ids in prose, and a
    // separator or header row names none.
    const firstCellIds = (section: string): string[] =>
      section
        .split("\n")
        .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l))
        .flatMap((l) =>
          [...(l.split("|")[1] ?? "").matchAll(REASON_TOKEN)].map((m) => m[1]),
        );

    // ⭐ positive control, on fixed strings: the first-cell reader skips the header and separator,
    // ignores an id named only in a later cell, and the overlap between the two tables is found.
    const refusalFixture = [
      "## What a refusal means and who fixes it",
      "| refusal | what it means | who acts |",
      "| -- | -- | -- |",
      "| `bad_reason` | means | a person |",
    ].join("\n");
    const clearsFixture = [
      "## Reasons a release clears once the cause is fixed",
      "| reason | what it means | note | who acts |",
      "| -- | -- | -- | -- |",
      "| `bad_reason` | means | note | the person, with their own login |",
      "| `ok_reason` | means | not `bad_reason` | the person, with their own login |",
    ].join("\n");
    const refusedControl = new Set(
      firstCellIds(sectionOf(`\n${refusalFixture}`, REFUSALS)),
    );
    expect([...refusedControl]).toEqual(["bad_reason"]);
    expect(
      firstCellIds(sectionOf(`\n${clearsFixture}`, RELEASE_CLEARS)),
    ).toEqual(["bad_reason", "ok_reason"]);
    expect(
      firstCellIds(sectionOf(`\n${clearsFixture}`, RELEASE_CLEARS)).filter(
        (id) => refusedControl.has(id),
      ),
    ).toEqual(["bad_reason"]);

    const refused = new Set(
      firstCellIds(sectionOf(read("unstick/references/playbook.md"), REFUSALS)),
    );
    expect(
      refused.size,
      "the playbook's refusal table must still be readable by this gate",
    ).toBeGreaterThan(0);
    const refusedButPromised = firstCellIds(
      sectionOf(read(STUCK), RELEASE_CLEARS),
    ).filter((id) => refused.has(id));
    expect(
      refusedButPromised,
      "the release command refuses these terminally; file them under 'Reasons that need a human' with that note, as `human_owned_pr` is",
    ).toEqual([]);
  });
});

// CTC-2014 Tier 1 ①: the settings reference names the screen, the route and the rule, instead of the
// concierge relaying from memory. `how-catalyst-works/references/settings-and-where-they-live.md`
// carries the in-scope rules from the 2026-09-10 account/profile/repository-settings research.
describe("the settings reference names the screen, the route and the rule", () => {
  const SETTINGS_PAGE =
    "whats-happening/references/settings-and-where-they-live.md";
  const ROUTE_TOKEN = /\/settings\/[a-zA-Z0-9$/_-]*/g;
  const normalizeRoute = (route: string): string =>
    route.replace(
      /^(\/settings\/projects)\/[^/]+(\/repositories)\/[^/]+(\/.+)$/,
      "$1/$projectId$2/$repoId$3",
    );
  const routesIn = (text: string): string[] =>
    [...text.matchAll(ROUTE_TOKEN)].map((m) => normalizeRoute(m[0]));

  test("⭐ positive control: the route matcher extracts a settings route and normalises an id segment, on fixed strings", () => {
    expect(routesIn("`<their cloud>/settings/projects`")).toEqual([
      "/settings/projects",
    ]);
    expect(routesIn("Settings → Your projects")).toEqual([]);
    expect(
      routesIn(
        "`<their cloud>/settings/projects/$projectId/repositories/$repoId/merging`",
      ),
    ).toEqual(["/settings/projects/$projectId/repositories/$repoId/merging"]);
  });

  test("the reference exists, is non-empty, and is linked from SKILL.md by its literal path", () => {
    expect(skill("whats-happening")).toContain(
      "references/settings-and-where-they-live.md",
    );
    const text = readFileSync(join(skillsRoot, SETTINGS_PAGE), "utf8");
    expect(text.length).toBeGreaterThan(500);
  });

  test("every settings route on the page is on the vendored roster", () => {
    const text = readFileSync(join(skillsRoot, SETTINGS_PAGE), "utf8");
    for (const route of routesIn(text)) {
      expect({
        route,
        onRoster: (SETTINGS_ROUTES as readonly string[]).includes(route),
      }).toEqual({ route, onRoster: true });
    }
  });

  test("the reference states each of the in-scope rules", () => {
    const text = readFileSync(join(skillsRoot, SETTINGS_PAGE), "utf8");
    const RULES = [
      /Connecting Linear/,
      /binds to exactly one account/,
      /personal GitHub grant comes first/,
      /Removing the App on GitHub self-heals the registry/,
      /Each Catalyst project pairs one Linear team with its registered GitHub repositories/,
      /choose the team's default repository/,
      /Merge policy/,
      /Post review requests as/,
      // CTC-2014 validate attempt 10, code-review finding 4: this rule used to be pinned as the
      // literal "Mergify configuration", which is what made the page name one vendor and claim a
      // repository without it "fails closed" — refuted by `catalyst-github/references/what-a-pr-accumulates.md`
      // and by `is-it-mergeable.mjs`'s generic `queue:` prefix. Pin the vendor-neutral consequence.
      /the merge itself is whatever the repository's own setup does with it/,
      /runner cap/i,
      /never both/,
      /nothing reaches a runner, and the failure is silent/,
      /no settings page for this/,
    ];
    for (const re of RULES)
      expect({ re: re.source, present: re.test(text) }).toEqual({
        re: re.source,
        present: true,
      });
  });
});

// CTC-2014 remediate (validate attempt 10, code-review finding 2): the settings page shipped the
// runner cap as "the tenant page is display-only — lowering it is an operator action", while
// `whats-happening/references/reprioritising.md` said the opposite — "a concurrency cap the tenant
// admin can set in settings". One bundle, two skills, opposite answers to "can I lower the cap for
// this repo?", and the rule this same ticket added at `how-catalyst-works/SKILL.md` routes every
// settings question to the settings page. The 2026-09-10 repository-settings research settles which
// is false: `/settings/projects/$projectId/repositories/$repoId/runner` is READ-ONLY because no GET exists
// (`repo-runner-view.tsx`), and the only writes are the operator-only
// `PUT|DELETE /admin/repos/concurrency-limit` (`repo-concurrency-routes.ts`), over
// `DEFAULT_REPO_CONCURRENCY_LIMIT = 20` (`repo-concurrency-store.ts`), with a paused repo resolving
// to 0 without touching the stored row. `what-runs-next.md`'s concurrency section already said
// operator; `reprioritising.md` was the lone dissenter, so it is the sentence that changed.
//
// ⛔ WHY A GATE AND NOT JUST THE EDIT. A settings fact restated in three references drifts the
// moment one of them is rewritten alone, and that is precisely how this contradiction arrived: the
// author of the new page had no way to see the older sibling's claim. This holds every page that
// names the cap to the same answer.
describe("the runner cap has one answer everywhere the bundle names it", () => {
  const mdFiles = [
    join(pkgRoot, "README.md"),
    ...walk(skillsRoot).filter((f) => f.endsWith(".md")),
  ];
  const CAP_LINE = /concurrency cap|runner cap/i;
  const OPERATOR_ACTS = /\boperator\b/i;
  // The retired claim, plus the shapes a rewrite would most likely reintroduce it in.
  const TENANT_SETS_IT =
    /(?:tenant )?(?:admin|owner)s?\b[^.|]{0,40}?\b(?:can |could |may )?(?:set|sets|raise|raises|lower|lowers|change|changes)\b/i;

  test("⭐ positive control: the matchers read the retired sentence and the one that replaced it, on fixed strings", () => {
    const retired =
      "dispatch is bounded per repository (a concurrency cap the tenant admin can set in settings, and a paused repository resolves to zero)";
    const replacement =
      "a concurrency cap of 20 running phases by default that an operator raises or lowers — the tenant's own settings page displays it and does not change it";
    expect(CAP_LINE.test(retired)).toBe(true);
    expect(TENANT_SETS_IT.test(retired)).toBe(true);
    expect(OPERATOR_ACTS.test(retired)).toBe(false);
    expect(CAP_LINE.test(replacement)).toBe(true);
    expect(TENANT_SETS_IT.test(replacement)).toBe(false);
    expect(OPERATOR_ACTS.test(replacement)).toBe(true);
    // "a tenant owner or admin, in settings, reruns the environment check" is a different subject
    // and not a cap line at all; the gate only ever reads lines that name the cap.
    expect(
      CAP_LINE.test(
        "a tenant owner or admin, in settings, reruns the environment check",
      ),
    ).toBe(false);
  });

  const capLines = mdFiles.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({
        rel: relative(pkgRoot, file),
        line: i + 1,
        text: line,
      }))
      .filter((l) => CAP_LINE.test(l.text)),
  );

  test("the cap is named on more than one page, so the two gates below cannot pass vacuously", () => {
    expect(new Set(capLines.map((l) => l.rel)).size).toBeGreaterThan(1);
  });

  test("no page says a tenant admin or owner sets the cap", () => {
    const offenders = capLines
      .filter((l) => TENANT_SETS_IT.test(l.text))
      .map((l) => `${l.rel}:${l.line}`);
    expect(
      offenders,
      "the tenant's runner page is read-only (no GET exists); the cap is written only by the operator-only /admin/repos/concurrency-limit route",
    ).toEqual([]);
  });

  test("every page that names the cap names the operator as the one who changes it", () => {
    const silent = capLines
      .filter((l) => !OPERATOR_ACTS.test(l.text))
      .map((l) => `${l.rel}:${l.line}`);
    expect(
      silent,
      "a page that names the cap must also name who can change it, or the human is left to guess",
    ).toEqual([]);
  });
});

// CTC-2014 Tier 1 (individual profile settings): the one profile-settings rule with a recorded live
// failure — an agent told "an admin matches it in Settings → Members" cannot explain why the match is
// wrong when the human insists they already connected Linear, because the identity and the personal
// grant are two different stored facts.
describe("the identity is distinguished from the personal Linear grant", () => {
  const INBOX = "what-needs-me/references/reading-the-inbox.md";
  const MATCHER =
    /identity[^.]*is not the same as[^.]*grant|identity[^.]*two different stored facts/i;

  test("⭐ positive control: the matcher finds the identity/grant distinction in a literal sentence and rejects the bare admin-match sentence alone", () => {
    expect(
      MATCHER.test(
        "The identity is not the same as the personal Linear grant.",
      ),
    ).toBe(true);
    expect(MATCHER.test("an admin matches it in Settings → Members")).toBe(
      false,
    );
  });

  test("the inbox reference distinguishes the declared identity from the proven grant, and says which to check first", () => {
    const text = readFileSync(join(skillsRoot, INBOX), "utf8");
    expect(text).toMatch(/\*\*identity\*\*/);
    expect(text).toMatch(/\*\*personal Linear grant\*\*/);
    expect(text).toMatch(
      /checked first, then the grant|check the identity first, then the grant/i,
    );
    expect(text).toContain(
      "Connecting Linear personally does **not** set the identity",
    );
  });

  test("the connect reference says connecting Linear personally does not set the identity, and the person matches it", () => {
    const ref = readFileSync(
      join(
        skillsRoot,
        "catalyst-onboard",
        "references",
        "connecting-this-machine.md",
      ),
      "utf8",
    );
    expect(ref).toMatch(
      /connecting Linear personally does not (set|match) the identity/i,
    );
    expect(ref).toContain("catalyst identity linear set");
  });
});

// CTC-2014 Tier 1 ③: readiness already names the check, its severity and who can click what
// (`what-each-check-means.md`, gated by CTC-2542 above). This block PINS that fact for both setup
// skills instead of rewriting the page — tests here are expected to land green immediately against
// the current tree, converting an undefended fact into a defended one, and adds the one honest
// health-signal sentence (flow metrics are not computed) the bundle was missing.
describe("readiness is pinned for both setup skills, and the flow-metrics gap is named", () => {
  test("the onboarding skill ends every readiness answer with the verdict and the who-can-click-what list", () => {
    expect(skill("catalyst-onboard")).toMatch(
      /verdict and the who-can-click-what list/,
    );
    expect(
      readFileSync(
        join(skillsRoot, "catalyst-onboard", "references", "reading-ready.md"),
        "utf8",
      ),
    ).toMatch(/verdict and the who-can-click-what list/);
  });

  test("the onboarding skill routes a not-ready answer to its one readiness guide", () => {
    expect(skill("catalyst-onboard")).toMatch(
      /not ready[^\n|]*\|\s*`references\/reading-ready\.md`/,
    );
  });

  test("every readiness check id's row on the page names a non-empty who-clicks cell", () => {
    const page = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "reading-ready.md"),
      "utf8",
    );
    const start = page.indexOf("\n## The checks\n");
    const end = page.indexOf("\n## ", start + 1);
    const section = page.slice(start, end);
    for (const id of TEAM_CHECK_IDS) {
      const row = section
        .split("\n")
        .find((l) => l.startsWith(`| \`${id}\` |`));
      const cells =
        row
          ?.split("|")
          .slice(1, -1)
          .map((c) => c.trim()) ?? [];
      expect({ id, whoClicks: cells[3] ?? "" }).toEqual({
        id,
        whoClicks: expect.stringMatching(/.+/),
      });
    }
  });

  test("the README says flow metrics are not computed", () => {
    const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
    expect(readme).toMatch(
      /cycle time, throughput, or how long pull requests have been open/,
    );
    expect(readme).toMatch(/not computed/);
  });

  // CTC-2014 validate attempt 9, code-review finding 1: the README's lede claims "the skills say so
  // by name rather than guess" for BOTH bullets, but a skill session loads SKILL.md plus its
  // references/ and never the README. Pinning the README alone let that claim ship with nothing
  // under skills/ behind its flow-metrics half, so a "what's our cycle time?" question reached a
  // desk with no reference naming the gap. This gate holds the sentence where an agent reads it.
  test("a reference a skill session actually loads names the flow-metrics gap, so the README's claim holds", () => {
    const PHRASE =
      /cycle time, throughput, or how long pull requests have been open/;
    const carriers = walk(skillsRoot)
      .filter((f) => f.endsWith(".md"))
      .filter(
        (f) =>
          PHRASE.test(readFileSync(f, "utf8")) &&
          /not computed/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(pkgRoot, f).replaceAll("\\", "/"));
    expect(
      carriers,
      "the README is not loaded by a skill session; a reference must carry this too",
    ).toContain("skills/whats-happening/references/status-reply.md");
  });
});

// CTC-2014 Tier 2 (route half): a settings route in customer prose that is not on the vendored
// roster fails the gate, in both directions — an unused roster entry is as much a defect as an
// unrostered route, or the roster rots into a wishlist nobody checks against the live product.
describe("every settings route in customer prose is on the vendored roster, and every roster entry is used", () => {
  const ROUTE_TOKEN = /\/settings\/[a-zA-Z0-9$/_-]*/g;
  const normalizeRoute = (route: string): string =>
    route.replace(
      /^(\/settings\/projects)\/[^/]+(\/repositories)\/[^/]+(\/.+)$/,
      "$1/$projectId$2/$repoId$3",
    );
  const mdFiles = [
    join(pkgRoot, "README.md"),
    ...walk(skillsRoot).filter((f) => f.endsWith(".md")),
  ];

  test("⭐ positive control: the route matcher reads a route and normalises an id segment, on fixed strings", () => {
    expect(
      normalizeRoute(
        "/settings/projects/$projectId/repositories/$repoId/merging",
      ),
    ).toBe("/settings/projects/$projectId/repositories/$repoId/merging");
    expect(
      normalizeRoute("/settings/projects/abc123/repositories/xyz/merging"),
    ).toBe("/settings/projects/$projectId/repositories/$repoId/merging");
    expect([..."Settings → Your projects".matchAll(ROUTE_TOKEN)]).toHaveLength(
      0,
    );
    expect(
      (SETTINGS_ROUTES as readonly string[]).includes("/settings/nope"),
    ).toBe(false);
  });

  test("every settings route in customer prose is on the roster", () => {
    const used = new Set<string>();
    for (const f of mdFiles) {
      const text = readFileSync(f, "utf8");
      const rel = relative(pkgRoot, f);
      for (const m of text.matchAll(ROUTE_TOKEN)) {
        const route = normalizeRoute(m[0]);
        used.add(route);
        expect({
          rel,
          route,
          onRoster: (SETTINGS_ROUTES as readonly string[]).includes(route),
        }).toEqual({ rel, route, onRoster: true });
      }
    }
    // ⭐ negative control on the positive path: the walk actually found routes, so an empty roster
    // could not have passed the loop above vacuously.
    expect(used.size).toBeGreaterThan(0);
  });

  test("every roster entry is used by at least one page", () => {
    const text = mdFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    const used = new Set(
      [...text.matchAll(ROUTE_TOKEN)].map((m) => normalizeRoute(m[0])),
    );
    for (const route of SETTINGS_ROUTES)
      expect({ route, used: used.has(route) }).toEqual({ route, used: true });
  });

  test("no page invents an API route: the only /api/v1 literal under skills/ is GET /api/v1/agent/contract", () => {
    const offenders: string[] = [];
    for (const f of walk(skillsRoot).filter((p) => p.endsWith(".md"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\/api\/v1\/[a-zA-Z/_-]*/g)) {
        if (m[0] === "/api/v1/agent/contract") continue;
        offenders.push(`${relative(pkgRoot, f)}: ${m[0]}`);
      }
    }
    // Measured allowance, not a blanket ban: `how-catalyst-works/SKILL.md:13` states `GET
    // /api/v1/agent/contract` and is load-bearing (CTC-2014 plan, "What I ran"). An unconditional
    // ban on any /api/v1 literal would redden on day one; this allowlist of exactly one does not.
    expect(offenders).toEqual([]);
  });
});

// A person releases a parked or held ticket from their own seat now (`catalyst-skills release`, the
// `unstick` skill); the references that sent every park to an operator are rewritten, not left beside it.
describe("releasing a park is a verb the person's agent runs, not an operator action", () => {
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");
  // Every retired phrasing of "only an operator releases a park", checked against EVERY Markdown
  // file under skills/, because the sentence survived in five places while a test watched one.
  const OPERATOR_ONLY = [
    /your key has no unpark verb/i,
    /releasing (?:the|a cloud) park is an operator action/i,
    /a park is released only by an operator/i,
    /unparking a phase[^.]{0,120}\boperator actions?\b/i,
    /an operator or a callback releases it/i,
    /operator-only park release/i,
    /an operator can release it directly/i,
  ];
  const RELEASE_NAMED = [
    "whats-happening/references/why-is-it-stuck.md",
    "run-this-project/references/stalls-and-escalation.md",
    "run-this-project/references/making-work-ready.md",
    "whats-happening/SKILL.md",
  ];

  test("positive control: the matchers find every old sentence in the text it was written against", () => {
    const old = [
      "an operator unparks it; your key has no unpark verb, so",
      "file an ask; releasing the park is an operator action",
      "releasing a cloud park is an operator action, not a card move",
      "PR labels and reactions are not mirrored, and a park is released only by an operator;",
      "unparking a phase, clearing a repair hold, resetting a validate budget and re-pinning a base are operator actions today",
      "the offered phase is parked; an operator or a callback releases it, not a clock",
      "(PR labels and reactions, which are not mirrored; an operator-only park release)",
      "no one acts; an operator can release it directly if the callback stalls",
    ];
    for (const line of old)
      expect({
        line,
        caught: OPERATOR_ONLY.some((re) => re.test(line)),
      }).toEqual({ line, caught: true });
  });

  test("no Markdown file under skills/ says releasing a park is an operator's", () => {
    const offenders = walk(skillsRoot)
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, line, i })),
      )
      .filter(({ line }) => OPERATOR_ONLY.some((re) => re.test(line)))
      .map(({ f, i }) => `${relative(pkgRoot, f)}:${i + 1}`);
    expect(offenders).toEqual([]);
  });

  for (const rel of RELEASE_NAMED) {
    test(`${rel} names the person's own release`, () => {
      expect(read(rel)).toMatch(/`unstick`|catalyst release/);
    });
  }

  test("the unstick playbook runs explain, then history, then a dry run, then the release, and files an ask only for a refusal a person must fix", () => {
    const playbook = read("unstick/references/playbook.md");
    const order = [
      "catalyst explain",
      "--history",
      "--dry-run",
      "--because",
    ].map((s) => playbook.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(playbook).toMatch(/--retry-unchanged/);
    expect(playbook).toContain("what-needs-me");
    expect(playbook).toMatch(/never close a person's pull request/i);
  });
});

// ⭐ THE CHECK COUNT IS THE CLOUD'S, NOT OURS — so customer-facing prose here may not state it.
// `catalyst-setup`'s description said "ten per-team checks", this reference said "eleven" twice and
// tabled eleven rows, and the live engine has fourteen (catalyst-cloud
// `packages/types/src/workflow-readiness.ts`, READINESS_CHECK_IDS). `src/ready.ts` never hardcodes a
// count — it iterates whatever the contract sends — so the drift only ever lived in the prose, which
// is exactly where a type checker cannot reach. The skill's own SKILL.md already states the rule
// ("The live check ids, severities, states and the people who can answer come from the contract");
// its description contradicted it.
//
// ⛔ WHY THIS GATE IS ABOUT THE COUNT, NOT THE TABLE. Completeness IS asserted — by a different
// gate, below: "every readiness check the engine reports has exactly one row on the page a customer
// is sent to" loops `DOCUMENTED_CHECKS` requiring exactly one row per id and then asserts sorted
// equality, so a missing row and an extra row both fail. `DOCUMENTED_CHECKS` is `TEAM_CHECK_IDS`
// (the roster at the top of this file), and `test/fixture-contract.ts` is held to that same roster
// by "the fixture contract's readinessChecks ids equal the documented list" — one list of record,
// three consumers.
//
// What THIS gate holds is narrower and separate: no customer-facing prose may state a COUNT. A
// count is the one claim that cannot be kept true by adding a row, because it goes stale the moment
// a check is added while every table entry is still correct. So the page names the contract as the
// list of record and never says how long it is.
//
// ⚠️ This paragraph previously said the opposite — that this gate does not assert completeness, that
// no roster exists here, and that the fixture is shorter than the live list. All three were false
// when written (PR #20 added the comment alongside its own literal roster and a completeness test),
// and the repair commit that replaced that literal with `TEAM_CHECK_IDS` left the prose behind.
// Corrected against the code, line by line (CTC-2542 validate round 3, code-review finding 1).
//
// Modelled on catalyst-cloud's `apps/mirror/test/agent-guide.test.ts` ("never hard-codes the number
// of team checks"), written after CTC-2028's eleventh check reddened a hard-coded "ten".
// ⭐ CTC-2542 round 3 — the header above describes THIS FILE, so it is drift-gated like the customer
// pages are. The three retired claims are named literally: a future edit that reinstates any of them
// fails here instead of shipping a comment that contradicts the code eight lines below it.
describe("this file's own header does not contradict the gates it heads", () => {
  // ⛔ SCOPED TO THE HEADER, NOT THE WHOLE FILE. The retired phrases are quoted literally below, so
  // a whole-file search matches this gate's own source and fails on itself — the first run did
  // exactly that. The header is everything before this describe, which is the text the claims live
  // in and the only text they can go stale in.
  const FULL = readFileSync(new URL(import.meta.url).pathname, "utf8");
  const MARKER =
    'describe("this file\'s own header does not contradict the gates it heads"';
  const SELF = FULL.slice(0, FULL.indexOf(MARKER));

  // ⛔ AND THE INVERSE TRAP, WHICH ROUND 4 WALKED INTO. The gate below names three things it claims
  // exist elsewhere. Searching `FULL` for them cannot fail: the assertion lines ARE those literals,
  // so the needle is always found in the gate's own source. Same self-reference as the warning
  // above, opposite direction — that one failed on itself, this one PASSED on itself.
  //
  // `ELSEWHERE` is the file minus two regions: this describe block (the assertions' own text) and
  // the header comment immediately above it (the prose under audit — it QUOTES one of the two test
  // titles at "…by \"the fixture contract's readinessChecks ids…\"", so a header-inclusive search
  // would let the header vouch for itself). What remains is code this gate does not write, which is
  // the only place a claim about the gates below can be honestly confirmed.
  const END_SENTINEL =
    "END OF THE SELF-DRIFT GATE — the assertions above may not see past here.";
  const ELSEWHERE = ((): string => {
    const lines = FULL.split("\n");
    const gateStart = lines.findIndex((line) => line.startsWith(MARKER));
    if (gateStart < 0)
      throw new Error("self-drift gate: could not locate its own describe");
    let headerStart = gateStart;
    while (
      headerStart > 0 &&
      lines[headerStart - 1].trimStart().startsWith("//")
    )
      headerStart -= 1;
    const gateEnd =
      lines.length -
      1 -
      [...lines].reverse().findIndex((l) => l.includes(END_SENTINEL));
    if (gateEnd < gateStart)
      throw new Error("self-drift gate: could not locate its end sentinel");
    return [...lines.slice(0, headerStart), ...lines.slice(gateEnd + 1)].join(
      "\n",
    );
  })();

  test("⭐ the three retired false claims never come back", () => {
    // Positive control: the matcher finds a claim that IS present, so an empty result means absent
    // rather than a dead search.
    expect(SELF).toContain("Completeness IS asserted");
    for (const retired of [
      "WHY THIS GATE DOES NOT ASSERT THE TABLE IS COMPLETE",
      "There is no roster in this repository",
      "SHORTER than the live list",
    ]) {
      expect({ retired, present: SELF.includes(retired) }).toEqual({
        retired,
        present: false,
      });
    }
  });

  test("⭐ and the gates the header now points at actually exist", () => {
    // The header says completeness is asserted by a gate below, that DOCUMENTED_CHECKS is the
    // roster, and that the fixture is held to the same list. If any of those stops being true the
    // header is wrong again — so each is pinned by name here, against `ELSEWHERE` rather than the
    // whole file, so that renaming the thing named makes this red.
    //
    // Positive control: a literal that genuinely lives outside both excluded regions is found, so a
    // miss below means the needle is absent rather than the region being empty or mis-sliced.
    expect(ELSEWHERE).toContain("const TEAM_CHECK_IDS = [");
    for (const claimed of [
      "const DOCUMENTED_CHECKS = TEAM_CHECK_IDS;",
      "every readiness check the engine reports has exactly one row on the page a customer is sent to",
      "the fixture contract's readinessChecks ids equal the documented list",
    ]) {
      expect({ claimed, present: ELSEWHERE.includes(claimed) }).toEqual({
        claimed,
        present: true,
      });
    }
  });

  // END OF THE SELF-DRIFT GATE — the assertions above may not see past here.
});

describe("no customer-facing prose states a readiness check count", () => {
  const COUNTED_CHECKS =
    // `{0,3}` because the stale wording put two qualifiers between the count and the noun ("ten
    // per-team readiness checks"). The positive control below is what caught a tighter first draft.
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+)\s+(?:[a-z-]+\s+){0,3}checks\b/i;
  const PAGES = [
    "catalyst-onboard/SKILL.md",
    "catalyst-onboard/references/reading-ready.md",
  ] as const;
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");

  test("⭐ positive control: the matcher finds every count this gate was written against", () => {
    for (const stale of [
      "tenant readiness from the contract's ten per-team checks",
      "the ten per-team readiness checks the cloud runs",
      "The engine always reports all eleven checks",
      "Three checks are informational by design",
      "## The eleven checks",
    ]) {
      expect(stale).toMatch(COUNTED_CHECKS);
    }
    // Not `.every()` — an empty list satisfies that vacuously, and a mistyped path would read as a pass.
    expect(PAGES).toHaveLength(2);
    for (const rel of PAGES) expect(read(rel).length).toBeGreaterThan(500);
  });

  for (const rel of PAGES) {
    test(`${rel} states no check count`, () => {
      expect(read(rel)).not.toMatch(COUNTED_CHECKS);
    });
  }

  test("the reference names the contract as the list of record, so a newer check reads as missing here rather than as a wrong total", () => {
    const page = read("catalyst-onboard/references/reading-ready.md");
    expect(page).toContain("`readinessChecks[]` is the list of record");
    expect(page).toMatch(/newer than this page/);
    expect(page).toMatch(/severity/);
  });

  // CTC-2542 asks for a gate that IMPORTS `READINESS_CHECK_IDS` and asserts one documented row per
  // id, so that the next check added to the engine reddens this bundle instead of shipping an
  // incomplete page. That import does not exist from here yet, measured both ways:
  //   • `@catalyst-cloud/types` is not published — `npm view @catalyst-cloud/types version` → E404.
  //   • `@catalyst-cloud/sdk`, our transport SDK dependency, carries no check id at all:
  //     a search of node_modules/@catalyst-cloud/sdk for `oauth_scope|READINESS_CHECK_IDS|
  //     reviewer_configured` returns nothing, while the same search for `TenantContract` hits four
  //     files including dist/tenant-contract.d.ts — so the instrument reaches the tree.
  // Until one of those carries the ids, the roster below is VENDORED, the way catalyst-cloud's own
  // `apps/mirror/test/fixtures/skills-bundle-verbs.ts` vendors this bundle's surface in the other
  // direction. It catches a row being dropped, renamed or duplicated — the regression this page
  // already suffered twice (the 0.3.0 changelog records the previous manual correction). It CANNOT
  // notice a fifteenth check appearing upstream, which is exactly why the page above also tells the
  // reader the contract is the list of record and that `check.mjs` prints whatever it sends.
  // Upstream: catalyst-cloud `packages/types/src/workflow-readiness.ts`, READINESS_CHECK_IDS, read
  // at origin/main e0b790eb (2026-09-17). Declaration order there IS wire order.
  // One roster, not two: `TEAM_CHECK_IDS` at the top of this file IS the vendored list described
  // above, and the merge that brought these two gates together is exactly when a second hand-written
  // copy would have started drifting from the first.
  const DOCUMENTED_CHECKS = TEAM_CHECK_IDS;

  /**
   * The first cell of every backtick-quoted row in the READINESS table, in page order — scoped to
   * the `## The checks` section, because `## The machine checks the CLI adds` further down carries
   * rows of the same shape for a different set (`node`, `config`, `sdk`…). A first draft of this
   * parser read both tables and the equality below is what caught it.
   */
  const readinessSection = () => {
    const page = read("catalyst-onboard/references/reading-ready.md");
    const start = page.indexOf("\n## The checks\n");
    if (start === -1)
      throw new Error("skills-content test: no `## The checks` section");
    const end = page.indexOf("\n## ", start + 1);
    if (end === -1)
      throw new Error(
        "skills-content test: `## The checks` runs to end of file",
      );
    return page.slice(start, end);
  };
  const tabledCheckIds = () =>
    readinessSection()
      .split("\n")
      .map((l) => /^\| `([a-z_]+)` \|/.exec(l)?.[1])
      .filter((id): id is string => id !== undefined);

  // ⭐ This control asserts ONLY against literals, so it still fires when the page is broken. An
  // earlier draft also asserted against the live page and therefore went red along with the fix it
  // was meant to vouch for — a control that dies with its subject proves nothing about the subject.
  test("⭐ positive control: the row matcher reads a row and rejects a header, on fixed strings", () => {
    expect(
      /^\| `([a-z_]+)` \|/.exec("| `oauth_scope` | proves | fix | who |")?.[1],
    ).toBe("oauth_scope");
    expect(/^\| `([a-z_]+)` \|/.exec("| id | proves | fix | who |")).toBeNull();
    expect(/^\| `([a-z_]+)` \|/.exec("| -- | -- | -- | -- |")).toBeNull();
    expect(DOCUMENTED_CHECKS.length).toBe(14);
    expect(new Set(DOCUMENTED_CHECKS).size).toBe(DOCUMENTED_CHECKS.length); // the roster has no duplicate
  });

  test("every readiness check the engine reports has exactly one row on the page a customer is sent to", () => {
    const tabled = tabledCheckIds();
    expect(tabled.length).toBeGreaterThan(0); // the section was found and parsed
    for (const id of DOCUMENTED_CHECKS) {
      expect({ id, rows: tabled.filter((t) => t === id).length }).toEqual({
        id,
        rows: 1,
      });
    }
    // And nothing extra: a row for an id the engine does not report is its own kind of wrong. This
    // equality is what caught a first parser that also swallowed the machine-check table below.
    expect([...tabled].sort()).toEqual([...DOCUMENTED_CHECKS].sort());
  });

  test("the readiness section stops before the machine checks, which carry rows of the same shape", () => {
    expect(readinessSection()).not.toContain("The machine checks the CLI adds");
    for (const machine of ["`cliPath`", "`sdk`", "`node`"])
      expect(readinessSection()).not.toContain(machine);
  });
});

// The ticket's fourth acceptance criterion: "The skill text explains why before the scan and asks for
// review after it. A test pins both." Three of the assertions below are indexOf orderings, and an
// ordering assertion over a string containing neither substring passes for the wrong reason — hence
// the planted-string positive control, the idiom this file already uses elsewhere.
describe("what-this-repo-needs explains before it scans and asks for review after", () => {
  const md = skill("what-this-repo-needs");
  const WHY =
    /builds and tests[\s\S]*in a\s+container that has only what (is |you )declared/i;
  const REVIEW = /keep it, drop it, or move it|keep, drop or move/i;
  const scanAt = (text: string) =>
    text.search(/scripts\/inventory\.mjs|env inventory/);

  test("the why comes BEFORE the scan step, in plain words", () => {
    const why = md.search(WHY);
    const scan = scanAt(md);
    expect(
      why,
      "SKILL.md must explain why the container needs these names",
    ).toBeGreaterThan(-1);
    expect(scan, "SKILL.md must name the scan").toBeGreaterThan(-1);
    expect(why, "the explanation must precede the scan").toBeLessThan(scan);
  });

  test("the review ask comes AFTER the scan, and names keep / drop / move", () => {
    expect(md.search(REVIEW)).toBeGreaterThan(scanAt(md));
  });

  test("it says the tool never reads a value", () => {
    expect(md).toMatch(/never (reads|shows|prints) (a |any )?value/i);
  });

  test("it keeps visible reasoning short", () => {
    expect(md).toMatch(/short|brief|few words/i);
  });

  test("positive control: the same probes find their strings in a planted file, in order", () => {
    const planted =
      "the fleet builds and tests your repository in a container that has only what you declared\n" +
      "run scripts/inventory.mjs\nask them to keep, drop or move each name";
    expect(planted.search(WHY)).toBeGreaterThan(-1);
    expect(planted.search(WHY)).toBeLessThan(scanAt(planted));
    expect(planted.search(REVIEW)).toBeGreaterThan(scanAt(planted));
  });

  test("negative control: a skill text in the wrong order fails the same probes", () => {
    const wrongOrder =
      "run scripts/inventory.mjs\n" +
      "the fleet builds and tests your repository in a container that has only what you declared";
    expect(wrongOrder.search(WHY)).toBeGreaterThan(scanAt(wrongOrder));
    expect(wrongOrder.search(REVIEW)).toBe(-1);
  });

  // C-5: the reference page described a `package.json` script scanner that was deliberately cut, so
  // it told a reviewer a name would be grouped that the scan never looks for.
  test("the group reference does not promise a scanner the tool does not have", () => {
    const ref = readFileSync(
      join(
        skillsRoot,
        "what-this-repo-needs",
        "references",
        "what-each-group-means.md",
      ),
      "utf8",
    );
    expect(ref).not.toMatch(/a name a `package\.json` script .* uses/);
    expect(ref).toMatch(/does not read `package\.json` scripts/);
  });
});

// ⭐ CTC-2560 — THE `description:` FIELD IS THE ONE PLACE A STALE COUNT IS READ FIRST AND CHECKED
// LAST. An agent picks a skill from its description, so a number written there is load-bearing prose
// with no reader downstream to contradict it. Two gates above already cover counts: the repo-wide
// rule needs a "readiness"/"per-team"/"team" word beside the noun, and the bare-count rule is scoped
// to two `catalyst-setup` `.md` files. A bare count in ANY OTHER skill's description falls between
// them — planted live in this repository, `whats-happening`'s description reading "the team's
// readiness from its ten checks" passed the whole suite — and `agents/openai.yaml`, the OpenAI
// catalog's copy of the same field, is read by NO gate here at all: neither the repo-wide rule (it
// walks `README.md` and `**/*.md` under `skills/`) nor the two-file rule ever opens a `.yaml`.
//
// This gate closes that seam at FIELD granularity, for every skill in the roster and both catalogs,
// and ties the verdict to `TEAM_CHECK_IDS` — the list of record at the top of this file — so a count
// is a defect exactly when it disagrees with the engine's own list. That is CTC-2560's acceptance
// criterion read literally: a description "does not name a check count at all, or names one a test
// pins to the engine's own list".
//
// ⛔ WHY IT TRIGGERS ON READINESS VOCABULARY RATHER THAN ON "checks" ALONE. A repo-wide bare-count
// rule was tried and rejected in CTC-2542 because "checks" is not one concept here: `catalyst-github`
// describes a pull request's CI checks, and "the four required checks" is true prose no gate should
// redden. So the count rules run only over descriptions that are ABOUT readiness, and then only over
// counts whose nearest population word is the tenant's, not the machine's or a pull request's.
// Measured against the twenty shipped description fields, the readiness trigger selects
// `catalyst-setup`'s two and nothing else, with 0 false positives. Deliberately NOT part of the
// trigger: the word "contract", which five of the ten `SKILL.md` descriptions already use.
//
// ⛔ WHY EACH COUNT IS ATTRIBUTED TO ITS NEAREST POPULATION WORD. `catalyst-setup`'s description
// names TWO populations of checks in one sentence — the machine's (Node, the connection, the cached
// contract, the CLI path, the skills, the SDK, the optional replica) and the tenant's per-team ones.
// Judging every count in the field against the team total would report a true statement about the
// machine checks as a stale team count, which is the same false-positive class as the `catalyst-github`
// case. So a count is judged only when the last population MARKER before it is the tenant's
// ("tenant readiness", "the team's readiness", "per-team", "team checks", "readinessChecks"); a count
// that follows "machine", "CI", "PR", "pull request" or "status" belongs to a different population
// and is left alone (CTC-2560 validate round 1, code-review finding 3). A marker is a phrase and not
// a bare noun for a reason measured on the shipped field: `catalyst-setup`'s machine parenthetical
// names "the tenant connection", and reading that bare "tenant" as a population handed every machine
// count straight back to the team total (validate round 2, code-review finding 1).
//
// ⛔ AND WHY THE FILLER MAY NOT SWALLOW A COUNT, AND WHY EVERY MATCH IS EXAMINED. Two defects the
// first cut of this gate shipped, both caught in validate round 1 and both fixed here with a control
// apiece: (1) the ≤3-word filler between the count and the noun used to match count words too, so
// "readiness in one verdict from fourteen checks" latched onto "one" and reddened a CORRECT total
// (finding 1) — the filler now refuses a count word, and the count itself may not sit inside a
// hyphenated compound, so "twenty-one checks" reads as 21 rather than as 1; (2) only the first match
// per rule was examined, so "…fourteen checks, and the ten per-team checks…" returned no defect at
// all (finding 2) — the rules are global now and every match is judged.
describe("no skill description names a readiness-check count the engine does not report", () => {
  const COUNT_WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const TENS: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
  };
  const ONES = "one|two|three|four|five|six|seven|eight|nine";
  /** "twenty-one", "thirty five" — a compound the plain word list would otherwise read as its tail. */
  const COMPOUND = `(?:${Object.keys(TENS).join("|")})[- ](?:${ONES})`;
  const COUNT = `(?:\\d+|${COMPOUND}|${Object.keys(COUNT_WORDS).join("|")})`;
  /** A filler word may be anything EXCEPT a count — otherwise the rule latches onto the wrong number. */
  const NOT_A_COUNT = `(?!${COUNT}(?![\\w-]))`;
  /** A description is about readiness when it uses the vocabulary of the tenant's readiness vector. */
  const READINESS_CONTEXT =
    /\breadiness\b|\bper-team\b|\bteam checks?\b|readinessChecks/i;
  // Global, because a stale count can follow a correct one in the same field. The compact
  // "<count>-check" form needs its own rule: its noun is glued to the count by a hyphen, so the
  // trailing "not inside a hyphenated word" guard the first rule carries cannot apply to it.
  // A post-noun phrasing ("fourteen checks per team", "eleven checks for each team") needs no rule of
  // its own: inside a readiness description the bare noun already means the readiness checks, so the
  // first rule matches it. The positive control below pins that, so a future tightening that breaks it
  // fails here.
  const COUNT_RULES = [
    new RegExp(
      `(?<![\\w-])(${COUNT})(?![\\w-])(?:\\s+${NOT_A_COUNT}[\\w'-]+){0,3}\\s+checks?\\b`,
      "gi",
    ),
    new RegExp(`(?<![\\w-])(${COUNT})-checks?\\b`, "gi"),
  ];
  // The populations a description can count. Only the tenant's are this gate's business.
  //
  // ⛔ A MARKER IS A PHRASE, NOT A BARE NOUN. The first cut listed bare `tenant` and `team`, and the
  // SHIPPED `catalyst-setup` description says "the tenant connection" INSIDE its machine
  // parenthetical — so every count written in that machine clause was attributed to the team and
  // judged against `TEAM_CHECK_IDS.length`, reddening a true sentence about the machine checks
  // (validate round 2, code-review finding 1). The tenant's population is therefore recognised only
  // where the word actually names a population of readiness checks — "tenant readiness", "the team's
  // readiness", "per-team", "team checks", `readinessChecks` — and a noun used for anything else (a
  // connection, a name, a URL) is not a marker at all. The control below splices a machine count into
  // the real description and pins this.
  const TEAM_MARKER =
    /\b(?:tenants?|teams?)(?:['’]s)?\s+readiness\b|\bper-team\b|\bteams?\s+checks?\b|\breadinessChecks\b/;
  const OTHER_MARKER =
    /\bmachine\b|\bCI\b|\bpull requests?\b|\bPRs?\b|\bstatus\b/;
  const POPULATION = new RegExp(
    `${TEAM_MARKER.source}|${OTHER_MARKER.source}`,
    "gi",
  );
  const TEAM_POPULATION = new RegExp(`^(?:${TEAM_MARKER.source})$`, "i");
  // ⛔ NO REVERSE RULE ("checks … fourteen"). Measured, not assumed: the loose form
  // /checks?\b[^.]{0,30}?\b<count>\b/ matches the SHIPPED `catalyst-setup` description at
  // "checks, in one verdict" — a false positive on correct prose. A count placed after the noun in
  // some other phrasing is the residual this gate does not catch, and it is written down rather than
  // implied. Same for a readiness count written with no readiness word anywhere in the field: for
  // `catalyst-setup`'s SKILL.md that residual is covered by the bare-count gate above, but for a
  // sidecar `short_description` nothing covers it, because no other gate in this repository reads a
  // `.yaml` at all.

  const countOf = (word: string): number => {
    if (/^\d+$/.test(word)) return Number(word);
    const w = word.toLowerCase();
    if (COUNT_WORDS[w] !== undefined) return COUNT_WORDS[w];
    const [tens, ones] = w.split(/[- ]/);
    return TENS[tens] + COUNT_WORDS[ones];
  };

  /** The last population MARKER before `at`, or "" when the count stands before any of them. */
  const populationBefore = (text: string, at: number): string => {
    let last = "";
    for (const m of text.matchAll(POPULATION)) {
      if (m.index >= at) break;
      last = m[0];
    }
    return last;
  };

  type CountDefect = { phrase: string; stated: number; engine: number };
  /**
   * The rule, as a function of the engine's list, so that "the engine gains or loses a check" is a
   * thing this gate can be asked about rather than a thing only a human could notice.
   */
  function staleCount(
    description: string,
    checkIds: readonly string[],
  ): CountDefect | null {
    if (!READINESS_CONTEXT.test(description)) return null;
    for (const rule of COUNT_RULES) {
      for (const m of description.matchAll(rule)) {
        if (!TEAM_POPULATION.test(populationBefore(description, m.index)))
          continue;
        const stated = countOf(m[1]);
        if (stated !== checkIds.length)
          return { phrase: m[0], stated, engine: checkIds.length };
      }
    }
    return null;
  }

  /** The `description:` as a TOOL reads it — the real YAML parser, not a line scanner. */
  const descriptionOf = (name: string): string => {
    const lines = skill(name).split("\n");
    const close = lines.indexOf("---", 1);
    const fm = parseYaml(lines.slice(1, close).join("\n")) as {
      description?: unknown;
    };
    return typeof fm.description === "string" ? fm.description : "";
  };

  /** The OpenAI sidecar's `short_description` — the same job in the other catalog an agent reads. */
  const shortDescriptionOf = (name: string): string => {
    const sidecar = parseYaml(
      readFileSync(join(skillsRoot, name, "agents", "openai.yaml"), "utf8"),
    ) as {
      interface?: { short_description?: unknown };
    };
    const text = sidecar.interface?.short_description;
    return typeof text === "string" ? text : "";
  };

  /** Every field an agent picks this skill from, as (where, text) pairs. */
  const descriptionFields = (
    name: string,
  ): ReadonlyArray<readonly [string, string]> => [
    [`skills/${name}/SKILL.md description`, descriptionOf(name)],
    [
      `skills/${name}/agents/openai.yaml short_description`,
      shortDescriptionOf(name),
    ],
  ];

  test("⭐ positive control: every skill in the roster yields a non-empty description to read", () => {
    // A parser that quietly returned "" would make every assertion below pass on nothing.
    for (const name of ROSTER) {
      for (const [where, text] of descriptionFields(name)) {
        expect({ where, read: text.length > 50 }).toEqual({
          where,
          read: true,
        });
      }
    }
    expect(ROSTER).toHaveLength(
      readdirSync(skillsRoot, { withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      ).length,
    );
  });

  test("⭐ positive control: the rule flags every stale phrasing it claims to cover", () => {
    const ctx = "Tenant readiness in one verdict. ";
    for (const stale of [
      "tenant readiness from the contract's ten checks",
      "tenant readiness from the contract's ten per-team checks",
      ctx + "The team always reports all eleven checks",
      ctx + "a ten-check vector per team",
      ctx + "the team runs fourteen checks per team",
      ctx + "the team runs eleven checks for each team",
      ctx + "The team runs twenty-one checks.",
    ]) {
      const defect = staleCount(stale, ["a", "b"]); // a two-id engine: every count above is stale
      expect({ stale, flagged: defect !== null }).toEqual({
        stale,
        flagged: true,
      });
    }
    // The compound is read as itself, not as its tail — "twenty-one" is 21, never 1.
    expect(
      staleCount(ctx + "The team runs twenty-one checks.", ["a", "b"])?.stated,
    ).toBe(21);
  });

  test("⭐ negative control: the engine gaining a check reddens a description that named the old total", () => {
    // Written FROM the roster, not beside it: when the engine really does gain a check and
    // `TEAM_CHECK_IDS` grows, this control still tests the thing it claims to test.
    const total = TEAM_CHECK_IDS.length;
    const named = `Tenant readiness from the contract's ${total} checks, in one verdict.`;
    // Today's engine list: the description agrees with it, so the gate passes it.
    expect(staleCount(named, TEAM_CHECK_IDS)).toBeNull();
    // A further check arrives upstream and the roster above learns about it: the same sentence,
    // untouched, is now wrong — and this gate is what says so.
    expect(staleCount(named, [...TEAM_CHECK_IDS, "a_further_check"])).toEqual({
      phrase: `${total} checks`,
      stated: total,
      engine: total + 1,
    });
    // And losing one is the same defect in the other direction.
    expect(staleCount(named, TEAM_CHECK_IDS.slice(0, -1))?.engine).toBe(
      total - 1,
    );
  });

  test("⭐ a count of something that is not a readiness check is not this defect", () => {
    // `catalyst-github`'s description is about a pull request's CI checks. Counting those is true
    // prose; reddening it would be a false positive, and CTC-2542 rejected a rule that did.
    const pr = `${descriptionOf("catalyst-github")} It shows the four required checks.`;
    expect(READINESS_CONTEXT.test(pr)).toBe(false);
    expect(staleCount(pr, TEAM_CHECK_IDS)).toBeNull();
    // And inside a readiness description, a count of the MACHINE checks is a different population.
    expect(
      staleCount(
        "Machine readiness (seven checks) plus tenant readiness from the contract's per-team checks, in one verdict.",
        TEAM_CHECK_IDS,
      ),
    ).toBeNull();
    // ⛔ THE SAME CASE ON THE REAL FIELD, SPLICED OUT OF IT RATHER THAN RETYPED BESIDE IT. Round 2's
    // version of this control quoted a hand-written sentence and CALLED it the shipped wording; it
    // was not. It had replaced the shipped machine parenthetical — "(Node, the tenant connection,
    // the cached contract, the CLI path, the skills, the SDK, the optional replica)" — with
    // "(seven checks)", and the replacement dropped exactly the "the tenant connection" that made the
    // real field fail: attribution read that bare "tenant" as the tenant population, so a true machine
    // count in the shipped description WAS reddened while this control stayed green (validate round 2,
    // code-review findings 1 and 2). A control built from `descriptionOf` cannot drift off its subject.
    // The readiness description is now catalyst-onboard's, which names the machine in its own clause.
    const shipped = descriptionOf("catalyst-onboard");
    const anchor = shipped.indexOf("logs this machine in");
    // The shape the splice needs. If the description loses its machine clause, this control is no
    // longer testing what it says it tests, and that must be a failure rather than a silent pass.
    expect({
      where: "catalyst-onboard description",
      spliceable: anchor > 0 && READINESS_CONTEXT.test(shipped),
    }).toEqual({
      where: "catalyst-onboard description",
      spliceable: true,
    });
    const at = anchor + "logs this machine in".length;
    const machineCounted = `${shipped.slice(0, at)} (seven checks)${shipped.slice(at)}`;
    expect(machineCounted).toContain("seven checks)");
    expect(staleCount(machineCounted, TEAM_CHECK_IDS)).toBeNull();
    // And pinned independently of how the shipped field happens to be worded today: a machine clause
    // that names the tenant in passing must not hand its count to the team…
    const machineClauseNamingTheTenant =
      "Machine readiness (Node, the tenant connection, the SDK — seven checks) plus tenant readiness from the contract's per-team checks, in one verdict.";
    expect(staleCount(machineClauseNamingTheTenant, TEAM_CHECK_IDS)).toBeNull();
    // …while the tenant's own count in that very sentence is still judged, so the fix for the false
    // positive did not buy itself a false negative.
    expect(
      staleCount(
        "Machine readiness (Node, the tenant connection, the SDK) plus tenant readiness from the contract's ten per-team checks, in one verdict.",
        TEAM_CHECK_IDS,
      ),
    ).toEqual({
      phrase: "ten per-team checks",
      stated: 10,
      engine: TEAM_CHECK_IDS.length,
    });
  });

  test("⭐ a correct total is not reddened by an unrelated number beside it, and a stale count after it is still caught", () => {
    const total = TEAM_CHECK_IDS.length;
    // The filler may not swallow a count: "one verdict" must not be read as the stated total.
    expect(
      staleCount(
        `Machine and tenant readiness in one verdict from ${total} checks.`,
        TEAM_CHECK_IDS,
      ),
    ).toBeNull();
    // Every match is judged, not just the first: the stale one here follows a correct one.
    expect(
      staleCount(
        `Tenant readiness from the contract's ${total} checks, and the ten per-team checks that are still waiting.`,
        TEAM_CHECK_IDS,
      ),
    ).toEqual({ phrase: "ten per-team checks", stated: 10, engine: total });
  });

  for (const name of ROSTER) {
    test(`${name}: every description an agent chooses it by names no stale readiness-check count`, () => {
      for (const [where, text] of descriptionFields(name)) {
        const defect = staleCount(text, TEAM_CHECK_IDS);
        expect(
          defect,
          defect
            ? `${where} says "${defect.phrase}" but the engine reports ${defect.engine} checks — say what the checks are, not how many; the scripts print the live list.`
            : "",
        ).toBeNull();
      }
    });
  }
});
