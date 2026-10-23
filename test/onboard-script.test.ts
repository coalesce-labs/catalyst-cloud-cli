// onboard-script.test.ts — the onboarding report as a customer's agent runs it: a real `node`
// process, a connected home, and a stand-in CLI that answers each verb from a scenario. Holds that
// setup is not reported finished while no coding account is enrolled or no host is connected, and
// that each of those two parts names who fixes it and where, read off the CLI and the contract.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(
  here,
  "..",
  "skills",
  "catalyst-onboard",
  "scripts",
  "where-am-i.mjs",
);

type Check = { id: string; state: string; reason?: string };

interface Scenario {
  /** `accounts --json`. Read on an older cloud whose contract has no `codingAccounts`, and to check
   *  each account's credential when the contract says `enrolled`. Omitted beside a contract
   *  `codingAccounts`, it answers with HEALTHY_ACCOUNTS. `accountsFail` makes the verb fail. */
  accounts?: unknown;
  accountsFail?: boolean;
  /** What the stand-in `gh` says about `<owner>/thoughts`; "absent" takes gh off PATH entirely. */
  thoughts?: "exists" | "missing" | "absent";
  /** When set, every `contract --path` read fails with this stderr, as a refused contract version does. */
  contractError?: string;
  /** Replaces the machine checks `ready --json` prints. */
  readyChecks?: unknown[];
  /** The version `status` prints on its Bundle line; 0.9.1 when omitted. */
  bundleVersion?: string;
  /** What a stand-in `npm view … version` prints, or "fail". Omitted: no npm on PATH. */
  npmLatest?: string;
  /** The contract's `codingAccounts`; omitted is an older cloud. */
  codingAccounts?: unknown;
  hostsCurrent: Check | null;
  readinessStatus?: string;
  /** Extra failing checks on the project (a blocked team's Linear automation conflicts, say). */
  blockingChecks?: Check[];
  /** What `repo agent-setup <path> --json` answers for any path; omitted, the verb is unknown. */
  repoSetup?: unknown;
  /** What `legacy --json` answers; omitted, the stand-in has no such verb. */
  legacy?: unknown;
  hostFixedWhere?: { page: string; command: string | null } | null;
  /** The person's role on `me --json`; owner when omitted. */
  role?: string;
  /** What `capabilities --json` answers; omitted, the verb is unknown (an older CLI). */
  capabilities?: unknown;
  /** No project mapped yet: `contract --path teams` answers `[]`. */
  noProject?: boolean;
  /** The project's `environment_declared` check. Omitted, the contract carries no such check (an
   *  older cloud, or a project never checked), which is not a failing declaration. */
  environmentDeclared?: Check & { repos?: { repo: string; reason?: string }[] };
}

const ENROLLER = "A tenant owner or admin, in Catalyst settings.";
function codingAccounts(
  state: string,
  activeCount: number | null,
  line: string,
) {
  return {
    state,
    activeCount,
    line,
    enrolledBy: "owner_or_admin",
    enrolledByLine: ENROLLER,
    page: "/settings/coding-accounts",
  };
}
const NONE_ENROLLED = codingAccounts(
  "none_enrolled",
  0,
  "No coding account is enrolled for this tenant.",
);
const INACTIVE = codingAccounts(
  "inactive",
  0,
  "This tenant's coding accounts are enrolled but out of rotation, so none is active.",
);
const UNREAD = codingAccounts(
  "unread",
  null,
  "Whether this tenant has a coding account enrolled could not be read.",
);
const CA_ENROLLED = codingAccounts(
  "enrolled",
  1,
  "At least one coding account is enrolled and active for this tenant.",
);
const HEALTHY_ACCOUNTS = {
  accounts: [
    {
      accountSlot: "claude-1",
      provider: "claude",
      status: "active",
      quarantined: false,
      quarantineReason: null,
    },
    {
      accountSlot: "codex-1",
      provider: "codex",
      status: "attested",
      quarantined: false,
      quarantineReason: null,
    },
  ],
  observedAtMs: 1_756_100_000_000,
};

function readinessChecks(hostFixedWhere: Scenario["hostFixedWhere"]) {
  return [
    {
      id: "oauth_scope",
      severity: "blocking",
      needsAnswer: true,
      fixedBy: "owner_or_admin",
      fixedByLine: "A tenant owner or admin, in Catalyst settings.",
    },
    {
      id: "hosts_current",
      severity: "degrading",
      needsAnswer: false,
      fixedBy: "host_operator",
      fixedByLine: "Whoever runs the Catalyst host that is behind.",
      ...(hostFixedWhere === undefined ? {} : { fixedWhere: hostFixedWhere }),
    },
    ...[
      "linear_automation_pr_open",
      "linear_automation_pr_review",
      "linear_automation_pr_ready",
      "linear_automation_pr_merge",
    ].map((id) => ({
      id,
      severity: "blocking",
      needsAnswer: true,
      fixedBy: "owner_or_admin_in_linear",
      fixedByLine: "A tenant owner or admin, in Linear’s own settings.",
      fixedWhere: null,
    })),
    {
      id: "merge_queue_configured",
      severity: "degrading",
      needsAnswer: false,
      fixedBy: "repository_admin",
      fixedByLine: "Whoever administers this team’s GitHub repository.",
      fixedWhere: null,
    },
  ];
}

/** Linear connected, the GitHub App installed, one repository attached to one mapped project. */
function answers(s: Scenario): Record<string, unknown> {
  const checks: Check[] = [{ id: "oauth_scope", state: "pass" }];
  if (s.hostsCurrent) checks.push(s.hostsCurrent);
  if (s.environmentDeclared) checks.push(s.environmentDeclared);
  if (s.blockingChecks) checks.push(...s.blockingChecks);
  return {
    "ready --json": {
      ready: true,
      checks: s.readyChecks ?? [
        { id: "config", ok: true, line: "config: connected" },
      ],
    },
    "me --json": {
      user: {
        label: "Pat Example",
        role: s.role ?? "owner",
        linearUserId: "lin-user-fixture",
      },
    },
    ...(s.capabilities === undefined
      ? {}
      : { "capabilities --json": s.capabilities }),
    // CTC-3212 — both personal grants connected, so the person part is finished in these scenarios.
    "connections personal linear status --json": {
      outcome: "connected",
      status: 200,
    },
    "connections personal github status --json": {
      outcome: "connected",
      status: 200,
    },
    "contract --path account --json": {
      name: "Example Co",
      slug: "example",
      linearWorkspaceSlug: "example-ws",
    },
    "environment read --json": { current: null },
    "contract --path teams --json": s.noProject
      ? []
      : [
          {
            id: "team-1",
            key: "ENG",
            stages: { dispatch: { stateId: "state-1", name: "Todo" } },
            dispatchGate: { status: "open" },
            readiness: {
              status: s.readinessStatus ?? "degraded",
              checks: s.readinessStatus === "unchecked" ? [] : checks,
            },
          },
        ],
    "project list --json": s.noProject
      ? []
      : [
          {
            id: "project-1",
            name: "Example App",
            linearTeamId: "team-1",
            linearTeamKey: "ENG",
            githubRepoOwner: "example",
            githubRepoName: "app",
            status: "active",
          },
        ],
    "contract --path merge.repositories --json": [
      { owner: "example", name: "app" },
    ],
    "contract --path readinessChecks --json": readinessChecks(s.hostFixedWhere),
    ...(s.accountsFail
      ? {}
      : s.accounts !== undefined
        ? { "accounts --all --json": s.accounts }
        : s.codingAccounts !== undefined
          ? { "accounts --all --json": HEALTHY_ACCOUNTS }
          : {}),
    ...(s.codingAccounts === undefined
      ? {}
      : { "contract --path codingAccounts --json": s.codingAccounts }),
  };
}

function connectedHome(s: Scenario): string {
  const home = mkdtempSync(join(tmpdir(), "onboard-script-"));
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      `const answers = ${JSON.stringify(answers(s))};`,
      // `--refresh` is a cache instruction, not a different read: the stand-in answers the same either way.
      "const a = process.argv.slice(2).filter((x) => x !== '--refresh').join(' ');",
      `if (a === "status") { console.log("Tenant: example\\nAPI: https://cloud.example (ok)\\nBundle: @catalyst-cloud/cli ${s.bundleVersion ?? "0.9.1"} (tenant contract range: 1.x)"); process.exit(0); }`,
      `const contractError = ${JSON.stringify(s.contractError ?? null)};`,
      'if (contractError !== null && a.startsWith("contract --path ")) { process.stderr.write(`contract: 2.2.0 from cloud\\n${contractError}\\n`); process.exit(2); }',
      "if (a in answers) { console.log(JSON.stringify(answers[a])); process.exit(0); }",
      `const repoSetup = ${JSON.stringify(s.repoSetup ?? null)};`,
      `const legacy = ${JSON.stringify(s.legacy ?? null)};`,
      'if (a === "legacy --json") { if (legacy === null) { process.stderr.write("unknown verb: legacy\\n"); process.exit(9); } console.log(JSON.stringify(legacy)); process.exit(legacy.found && legacy.found.length ? 1 : 0); }',
      'if (a.startsWith("repo agent-setup ")) { if (repoSetup === null) { process.stderr.write("unknown verb: repo\\n"); process.exit(9); } console.log(JSON.stringify(repoSetup)); process.exit(0); }',
      // what the real CLI prints when the cached contract lacks the path (an older cloud)
      'if (a.startsWith("contract --path ")) { process.stderr.write(`contract: 1.22.0 from cache\\nthe contract has nothing at "${a.split(" ")[2]}"\\n`); process.exit(2); }',
      "process.stderr.write(`unknown verb: ${a}\\n`); process.exit(9);",
    ].join("\n"),
  );
  // A stand-in `gh`, so the thoughts note never reaches the real GitHub from a test.
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (s.thoughts !== "absent") {
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      s.thoughts === "exists"
        ? `#!/bin/sh\necho '{"name":"thoughts"}'\n`
        : `#!/bin/sh\necho "GraphQL: Could not resolve to a Repository with the name '$3'." >&2\nexit 1\n`,
    );
    chmodSync(gh, 0o755);
  }
  if (s.npmLatest !== undefined) {
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      s.npmLatest === "fail"
        ? "#!/bin/sh\necho 'npm ERR! network request failed' >&2\nexit 1\n"
        : `#!/bin/sh\necho '${s.npmLatest}'\n`,
    );
    chmodSync(npm, 0o755);
  }
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({
      baseUrl: "https://cloud.example",
      account: "tenant-fixture",
      cliPath: cli,
      key: "ctc_user_fixture",
    }),
  );
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    // Only the stand-in `gh` is on PATH; the script and the stand-in CLI run on this node by path.
    env: {
      ...process.env,
      CATALYST_SKILLS_HOME: home,
      HOME: home,
      PATH: join(home, "bin"),
    },
  });
}

const NO_HOST: Check = {
  id: "hosts_current",
  state: "unknown",
  reason: "no_host_connected",
};
const ENROLLED = [
  { accountSlot: "slot-1", provider: "claude", status: "active" },
];

type Part = {
  part: string;
  verdict: string;
  lines: string[];
  owner: string | null;
  where: string | null;
  blocking?: boolean;
};
type Doc = {
  parts: Part[];
  next: {
    part: string;
    action: string;
    owner: string | null;
    where: string | null;
    blocking?: boolean;
  } | null;
  finished: boolean;
};
const json = (home: string) => JSON.parse(run(home, ["--json"]).stdout) as Doc;
const part = (doc: Doc, name: string) =>
  doc.parts.find((p) => p.part === name)!;
const PASS: Check = { id: "hosts_current", state: "pass" };

describe("where-am-i.mjs: the two pieces a phase needs", () => {
  test("no coding account and no host: both are the remaining steps, and nothing says ready", () => {
    const home = connectedHome({
      codingAccounts: NONE_ENROLLED,
      hostsCurrent: NO_HOST,
    });

    const out = run(home, ["--json"]);
    expect(out.status, out.stderr).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    // positive control: the parts before these two are all finished, so these two are what is left
    expect(
      doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part),
    ).toEqual(["coding accounts", "host"]);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");

    const report = run(home, []);
    expect(report.stdout).toMatch(/coding accounts {2}\[unfinished\]/);
    expect(report.stdout).toMatch(/host {2}\[unfinished\]/);
    expect(report.stdout).not.toMatch(/nothing left/);
    expect(run(home, ["--next"]).stdout).not.toMatch(/nothing left/);
  });

  test("an account enrolled but no host: the host alone is left, and it is still not finished", () => {
    const doc = json(
      connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: NO_HOST }),
    );
    expect(
      doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part),
    ).toEqual(["host"]);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("host");
  });

  test("a project whose readiness was never checked leaves the host unread, never ok", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: null,
        readinessStatus: "unchecked",
      }),
    );
    expect(part(doc, "host").verdict).toBe("unreadable");
    expect(doc.finished).toBe(false);
  });

  test("an enrolled account and a passing host check: setup is finished and the dispatch step is next", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: PASS,
    });
    const out = run(home, ["--json"]);
    expect(out.status, out.stdout).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      finished: true,
      next: null,
    });
    expect(run(home, ["--next"]).stdout).toMatch(/nothing left/);
  });
});

describe("where-am-i.mjs: the coding account is read from the contract", () => {
  test("none_enrolled: prints the contract's line and page, and names the enroller the contract gives", () => {
    const home = connectedHome({
      codingAccounts: NONE_ENROLLED,
      hostsCurrent: PASS,
    });
    const accounts = part(json(home), "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain(NONE_ENROLLED.line);
    expect(accounts.owner).toBe(ENROLLER);
    expect(accounts.where).toBe(
      "https://cloud.example/settings/coding-accounts",
    );
    const report = run(home, []).stdout;
    expect(report).toContain(NONE_ENROLLED.line);
    expect(report).toContain(`who: ${ENROLLER}`);
    expect(report).toContain(
      "where: https://cloud.example/settings/coding-accounts",
    );
  });

  test("the page and the enroller come from the contract, not from a fixed pattern", () => {
    const moved = {
      ...NONE_ENROLLED,
      page: "/settings/ai-accounts",
      enrolledByLine: "Someone else entirely.",
    };
    const accounts = part(
      json(connectedHome({ codingAccounts: moved, hostsCurrent: PASS })),
      "coding accounts",
    );
    expect(accounts.where).toBe("https://cloud.example/settings/ai-accounts");
    expect(accounts.owner).toBe("Someone else entirely.");
  });

  test("inactive: says the account is out of rotation and should be reactivated, never to enroll another", () => {
    const home = connectedHome({
      codingAccounts: INACTIVE,
      hostsCurrent: PASS,
    });
    const doc = json(home);
    expect(part(doc, "coding accounts").verdict).toBe("unfinished");
    expect(doc.next?.action).toMatch(/reactivate/i);
    const report = run(home, []).stdout;
    const next = run(home, ["--next"]).stdout;
    expect(report).toMatch(/out of rotation/);
    expect(next).toMatch(/reactivate/i);
    // the one mention of enrolling is the instruction not to
    expect(report).toContain("Do not enroll another account.");
    const ENROL_ONE = /enrol+ (a|an|one|another)\b/i;
    const withoutNegations = (t: string) =>
      t
        .replaceAll("Do not enroll another account.", "")
        .replaceAll("do not enroll another one", "");
    expect(withoutNegations(report)).not.toMatch(ENROL_ONE);
    expect(withoutNegations(next)).not.toMatch(ENROL_ONE);
  });

  test("unread: says it could not be read, and does not tell them to enroll one", () => {
    const home = connectedHome({ codingAccounts: UNREAD, hostsCurrent: PASS });
    const doc = json(home);
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unreadable");
    expect(accounts.lines).toContain(UNREAD.line);
    expect(accounts.where).toBeNull();
    expect(doc.finished).toBe(false);
    const next = run(home, ["--next"]).stdout;
    expect(next).toMatch(/could not read/);
    const report = run(home, []).stdout;
    expect(report).toContain("Do not enroll one on this reading.");
    for (const text of [
      next,
      report.replace("Do not enroll one on this reading.", ""),
    ])
      expect(text).not.toMatch(/enrol+ (a|an|one)\b/i);
  });

  test("an older contract with no codingAccounts: falls back to the account list and says the cloud is older", () => {
    const home = connectedHome({ accounts: [], hostsCurrent: PASS });
    const accounts = part(json(home), "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines[0]).toMatch(/cloud is older than the bundle/);
    expect(accounts.lines).toContain("0 enrolled, 0 able to take work");
    expect(accounts.owner).toBe("a workspace owner or admin");
    expect(accounts.where).toBe(
      "https://cloud.example/settings/coding-accounts",
    );
  });

  test("an older contract: an account that is only expired or revoked does not count as enrolled", () => {
    const home = connectedHome({
      accounts: {
        accounts: [{ accountSlot: "slot-1", status: "expired-or-revoked" }],
      },
      hostsCurrent: PASS,
    });
    expect(part(json(home), "coding accounts").verdict).toBe("unfinished");
  });

  test("an older contract with an enrolled account still finishes", () => {
    const home = connectedHome({ accounts: ENROLLED, hostsCurrent: PASS });
    expect(json(home)).toMatchObject({ finished: true });
  });
});

describe("where-am-i.mjs: the host names where only when the contract does", () => {
  test("fixedWhere null: the owner sentence alone, no page and no invented step", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: NO_HOST,
      hostFixedWhere: null,
    });
    const host = part(json(home), "host");
    expect(host.owner).toMatch(/host_operator/);
    expect(host.where).toBeNull();
    expect(run(home, []).stdout).not.toMatch(/^ {2}(where|do): /m);
  });

  test("fixedWhere absent (an older cloud) reads the same as null", () => {
    const host = part(
      json(
        connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: NO_HOST }),
      ),
      "host",
    );
    expect(host.where).toBeNull();
  });

  test("fixedWhere non-null: prints its page and its command", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: NO_HOST,
      hostFixedWhere: {
        page: "/settings/hosts",
        command: "catalyst-host join --token <token>",
      },
    });
    const host = part(json(home), "host");
    expect(host.where).toBe("https://cloud.example/settings/hosts");
    expect(host.lines).toContain(
      "the owner runs: catalyst-host join --token <token>",
    );
  });
});

describe("where-am-i.mjs: an enrolled contract still checks each account's credential", () => {
  const CLAUDE_OK = {
    accountSlot: "claude-1",
    provider: "claude",
    status: "active",
    quarantined: false,
    quarantineReason: null,
  };
  const codexFailing = (
    pollFailureCount: number,
    lastPollErrorCode = "no_access_token",
  ) => ({
    accountSlot: "codex-7",
    provider: "codex",
    // What the cloud reports for this account today: healthy-looking, not quarantined.
    status: "attested",
    quarantined: false,
    quarantineReason: null,
    pollFailureCount,
    lastPollErrorCode,
  });
  const ENROL_ONE = /enrol+ (a|an|one|another)\b/i;
  const withoutNegations = (t: string) =>
    t
      .replaceAll("Do not enroll another account.", "")
      .replaceAll("Do not enroll one on this reading.", "");

  test("a quarantined but CANCELLED Claude account is kept for reporting, never re-credentialed, and does not make setup unfinished", () => {
    const cancelled = {
      accountSlot: "claude-465ad266",
      provider: "claude",
      status: "ended",
      observedStatus: "dead",
      renewalStatus: "canceled",
      quarantined: true,
      quarantineReason: "credential conflict",
    };
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      accounts: { accounts: [CLAUDE_OK, cancelled] },
      hostsCurrent: PASS,
    });
    const out = run(home, ["--json"]);
    const doc = JSON.parse(out.stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("ok");
    expect(accounts.lines.join("\n")).not.toMatch(
      /claude-465ad266 needs a new credential/,
    );
    expect(accounts.lines.join("\n")).toMatch(
      /claude-465ad266 \(claude\)\): kept for reporting, not used, and not counted here\. Never replace their credential/,
    );
    expect(accounts.lines.join("\n")).not.toMatch(/retire|delete/i);
    expect(doc.next?.part).not.toBe("coding accounts");
  });

  test("a live quarantined account names its own login and says to mint from THAT account", () => {
    const stuck = {
      accountSlot: "claude-9",
      provider: "claude",
      status: "active",
      renewalStatus: "active",
      email: "ops@example.com",
      quarantined: true,
      quarantineReason: "auth mismatch",
    };
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      accounts: { accounts: [stuck] },
      hostsCurrent: PASS,
    });
    const doc = JSON.parse(run(home, ["--json"]).stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain(
      "claude account claude-9 (ops@example.com) needs a new credential: quarantined: auth mismatch",
    );
    expect(accounts.lines.join("\n")).toContain("minted from THAT account");
  });

  test("a healthy Claude account and a Codex account failing with no_access_token: the Codex account is the next step", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      accounts: { accounts: [CLAUDE_OK, codexFailing(7)] },
      hostsCurrent: PASS,
    });
    const out = run(home, ["--json"]);
    expect(out.status, out.stderr).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain(
      "codex account codex-7 needs a new credential: its last 7 polls failed with no_access_token",
    );
    expect(accounts.lines.join("\n")).not.toMatch(
      /claude account claude-1 needs/,
    );
    expect(accounts.owner).toBe(ENROLLER);
    expect(accounts.where).toBe(
      "https://cloud.example/settings/coding-accounts",
    );
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");
    expect(doc.next?.action).toMatch(
      /^codex account codex-7 needs a new credential\./,
    );
    expect(doc.next?.action).toContain("Replace credential");

    const next = run(home, ["--next"]).stdout;
    expect(next).toContain("codex account codex-7 needs a new credential");
    expect(next).not.toMatch(/nothing left/);
    const report = run(home, []).stdout;
    expect(report).toContain("references/replacing-a-credential.md");
    for (const text of [next, report])
      expect(withoutNegations(text)).not.toMatch(ENROL_ONE);
  });

  test("every credential error the poller writes counts, once the streak reaches three", () => {
    for (const code of ["no_access_token", "no_credential"]) {
      const doc = json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          accounts: [codexFailing(3, code)],
          hostsCurrent: PASS,
        }),
      );
      expect(part(doc, "coding accounts").verdict, code).toBe("unfinished");
    }
  });

  test("the cloud's needsCredential verdict wins over the poll fields, and an ended or revoked account is never flagged", () => {
    const cases = [
      [{ ...codexFailing(9), needsCredential: false }, "ok"],
      [
        { ...codexFailing(0), lastPollErrorCode: null, needsCredential: true },
        "unfinished",
      ],
      [{ ...codexFailing(9), status: "ended" }, "ok"],
      [{ ...codexFailing(9), revokedAtMs: 1 }, "ok"],
    ];
    for (const [row, verdict] of cases) {
      const doc = json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          accounts: [CLAUDE_OK, row],
          hostsCurrent: PASS,
        }),
      );
      expect(part(doc, "coding accounts").verdict, JSON.stringify(row)).toBe(
        verdict,
      );
    }
  });

  test("a streak below three, or a failure that is not about the credential, stays ok", () => {
    // CTC-4174: a usage-endpoint refusal is not a verdict on the credential.
    for (const row of [
      codexFailing(2),
      codexFailing(9, "network_error"),
      codexFailing(9, "exception:TypeError"),
      codexFailing(9, "usage_unauthorized"),
      codexFailing(9, "usage_forbidden"),
      codexFailing(9, "http_403"),
    ]) {
      const doc = json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          accounts: [CLAUDE_OK, row],
          hostsCurrent: PASS,
        }),
      );
      expect(part(doc, "coding accounts").verdict, JSON.stringify(row)).toBe(
        "ok",
      );
    }
  });

  test("a quarantined or an expired-or-revoked account needs a new credential too", () => {
    const quarantined = {
      ...CLAUDE_OK,
      accountSlot: "claude-2",
      quarantined: true,
      quarantineReason: "observed dead (http_401)",
    };
    const expired = {
      ...CLAUDE_OK,
      accountSlot: "claude-3",
      status: "expired-or-revoked",
    };
    const accounts = part(
      json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          accounts: [CLAUDE_OK, quarantined, expired],
          hostsCurrent: PASS,
        }),
      ),
      "coding accounts",
    );
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain(
      "claude account claude-2 needs a new credential: quarantined: observed dead (http_401)",
    );
    expect(accounts.lines).toContain(
      "claude account claude-3 needs a new credential: expired or revoked",
    );
  });

  test("every account healthy: ok, and it says how many it checked", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: PASS,
    });
    const doc = json(home);
    expect(part(doc, "coding accounts")).toMatchObject({ verdict: "ok" });
    expect(part(doc, "coding accounts").lines).toContain(
      "2 checked, none needs a new credential",
    );
    expect(doc).toMatchObject({ finished: true, next: null });
  });

  test("the account list cannot be read: never silently ok, and it does not tell them to enroll one", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      accountsFail: true,
      hostsCurrent: PASS,
    });
    const out = run(home, ["--json"]);
    expect(out.status).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unreadable");
    expect(accounts.lines.join("\n")).toMatch(/could not be checked in detail/);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");
    const next = run(home, ["--next"]).stdout;
    expect(next).toMatch(/could not be checked/);
    expect(withoutNegations(next)).not.toMatch(ENROL_ONE);
  });

  test("a contract that says needs_credential is never ok, even when no row says which account", () => {
    const needs = codingAccounts(
      "needs_credential",
      0,
      "A coding account needs a new credential.",
    );
    const doc = json(
      connectedHome({ codingAccounts: needs, hostsCurrent: PASS }),
    );
    expect(part(doc, "coding accounts").verdict).toBe("unfinished");
    expect(doc.next?.action).toMatch(/replace the credential/);
  });
});

describe("where-am-i.mjs: the thoughts repository is a note, never proof of App access", () => {
  test("gh sees <owner>/thoughts: says it exists, and that App access is not verifiable from here", () => {
    const repositories = part(
      json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          hostsCurrent: PASS,
          thoughts: "exists",
        }),
      ),
      "repositories",
    );
    expect(repositories.verdict).toBe("ok");
    expect(repositories.lines).toContain(
      "note example/thoughts: exists; App access not verifiable from here. Confirm the GitHub App installation includes it (step 5a).",
    );
  });

  test("gh cannot see it: says it may not exist, and points at step 5a without changing the verdict", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        thoughts: "missing",
      }),
    );
    const line = part(doc, "repositories").lines.find((l) =>
      l.startsWith("note example/thoughts:"),
    );
    expect(line).toMatch(
      /gh could not see it .*Could not resolve to a Repository/,
    );
    expect(line).toMatch(/step 5a/);
    expect(part(doc, "repositories").verdict).toBe("ok");
    expect(doc.finished).toBe(true);
  });

  test("no gh on this machine: says it was not checked", () => {
    const repositories = part(
      json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          hostsCurrent: PASS,
          thoughts: "absent",
        }),
      ),
      "repositories",
    );
    expect(
      repositories.lines.find((l) => l.startsWith("note example/thoughts:")),
    ).toMatch(/not checked/);
  });

  test("no line anywhere claims the App can reach the thoughts repository", () => {
    const report = run(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        thoughts: "exists",
      }),
      [],
    ).stdout;
    expect(report).not.toMatch(
      /App (?:access|can reach)[^.\n]*(?:verified|confirmed)/i,
    );
  });
});

describe("the onboarding guide walks a dead credential and the thoughts repository", () => {
  const onboard = join(here, "..", "skills", "catalyst-onboard");
  const read = (rel: string) => readFileSync(join(onboard, rel), "utf8");

  test("replacing-a-credential.md sends the person to the account's own page, says never to enroll a second account, and names no subscription", () => {
    const ref = read("references/replacing-a-credential.md");
    for (const text of [
      "Settings → AI accounts",
      "Replace credential",
      "Do not enroll a second account.",
      "billed per token",
      "`node scripts/where-am-i.mjs`",
    ]) {
      expect(ref, text).toContain(text);
    }
    // CTC-4715: public text never teaches a subscription login.
    expect(ref).not.toMatch(
      /subscription|setup.token|auth\.json|ChatGPT|Pro or Max|5-hour|7-day/i,
    );
    expect(ref).not.toContain("—");
    expect(read("SKILL.md")).toContain("references/replacing-a-credential.md");
    expect(read("references/what-a-phase-needs.md")).toContain(
      "references/replacing-a-credential.md",
    );
  });

  test("what-a-phase-needs.md describes token-billed AI accounts and names no subscription (CTC-4715)", () => {
    const ref = read("references/what-a-phase-needs.md");
    expect(ref).toContain("billed per token");
    expect(ref).not.toMatch(
      /subscription|setup.token|auth\.json|ChatGPT|Pro or Max|5-hour|7-day|plain Anthropic/i,
    );
  });

  test("enrolled no longer means nothing to do", () => {
    const row = read("references/what-a-phase-needs.md")
      .split("\n")
      .find((l) => l.startsWith("| `enrolled` |"));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/\| nothing \|$/);
    expect(row).toContain("needs a new credential");
  });

  test("the thoughts repository is handled inside the App install step, before registering the repository", () => {
    const path = read("references/the-one-path.md");
    const five = path.indexOf("## 5. Install the GitHub App");
    const six = path.indexOf("## 6. Register the repository");
    expect(five).toBeGreaterThanOrEqual(0);
    expect(six).toBeGreaterThan(five);
    const stepFive = path.slice(five, six);
    expect(stepFive).toContain("`<org>/thoughts`");
    for (const text of [
      "private repository named `thoughts`",
      "initialized with a README",
      "All repositories",
      "never that the App can reach it",
    ]) {
      expect(stepFive, text).toContain(text);
    }
    const browser = read("references/what-the-browser-owns.md");
    expect(browser).toContain("`<your GitHub org>/thoughts`");
    expect(browser).toContain("All repositories");
  });

  test("the CLI's account status and the fact skill say Replace credential, never re-enrol", () => {
    const execution = readFileSync(
      join(here, "..", "src", "execution.ts"),
      "utf8",
    );
    expect(execution).not.toMatch(/re-enrol/);
    expect(execution).toContain(
      "Settings → AI accounts → the account → Replace credential",
    );
    const facts = readFileSync(
      join(
        here,
        "..",
        "skills",
        "whats-happening",
        "references",
        "coding-accounts.md",
      ),
      "utf8",
    );
    expect(facts).not.toContain("only an operator clears it");
    expect(facts).toContain(
      "Replace credential on the account's page clears it",
    );
  });
});

describe("where-am-i.mjs: no next step without a basis", () => {
  const REFUSED =
    "the tenant serves contract version 2.2.0 but this bundle accepts 1.x — update the bundle (npm install -g @catalyst-cloud/cli@latest && catalyst-skills login) or ask your tenant admin which version is live";
  const READY_REFUSED = [
    { id: "config", ok: true, line: "config: connected" },
    {
      id: "contract",
      ok: false,
      line: "contract: version 2.2.0 is outside this bundle's range 1.x",
      fix: "npm install -g @catalyst-cloud/cli@latest && catalyst-skills login",
      who: "you",
    },
  ];
  const refusedHome = (npmLatest?: string, bundleVersion?: string) =>
    connectedHome({
      contractError: REFUSED,
      readyChecks: READY_REFUSED,
      hostsCurrent: PASS,
      npmLatest,
      bundleVersion,
    });
  const NOT_PUBLISHED =
    "A newer Catalyst CLI isn't published yet. Tell the Catalyst team; nothing on this machine needs to change.";

  test("a refused contract names no Linear or GitHub step, and no update the CLI suggested", () => {
    const home = refusedHome("0.9.1");
    const doc = json(home);
    expect(part(doc, "account").verdict).toBe("unreadable");
    expect(doc.finished).toBe(false);
    expect(doc.next).not.toBeNull();
    for (const text of [
      doc.next!.action,
      run(home, ["--next"]).stdout,
      run(home, [])
        .stdout.split("\n")
        .find((l) => l.startsWith("next:"))!,
    ]) {
      expect(text).not.toMatch(/linear|github/i);
      expect(text).not.toContain("npm install -g");
      expect(text).toContain(
        "the tenant serves contract 2.2.0 and this CLI accepts 1.x",
      );
    }
  });

  test("an unreadable contract, with no version refusal, says to read it again rather than connect Linear", () => {
    const home = connectedHome({
      contractError: "network error: could not reach https://cloud.example",
      hostsCurrent: PASS,
    });
    const doc = json(home);
    // Every contract read failed. The first part in the person's order is the coding account, and its
    // unreadable step is reading it again; no part after it names a Linear or GitHub step.
    expect(doc.next?.part).toBe("coding accounts");
    expect(doc.next?.action).toMatch(/read the coding accounts again/);
    expect(doc.next?.action).not.toMatch(/connect Linear|GitHub App/);
    expect(part(doc, "account").verdict).toBe("unreadable");
    for (const p of doc.parts.filter((x) => x.verdict === "unreadable"))
      expect(p.lines.join("\n")).not.toMatch(
        /connect Linear|install the GitHub App/,
      );
  });

  test("installed CLI is npm's latest: a newer CLI is not published yet, and nothing here changes", () => {
    const doc = json(refusedHome("0.9.1", "0.9.1"));
    expect(doc.next?.action).toContain(NOT_PUBLISHED);
    expect(doc.next?.owner).toBe("the Catalyst team");
    expect(doc.next?.action).not.toMatch(/re-run the install script/);
  });

  test("installed CLI is older than npm's latest: update the CLI", () => {
    const doc = json(refusedHome("0.10.0", "0.9.1"));
    expect(doc.next?.action).toContain(
      "Update the CLI: run npm install -g @catalyst-cloud/cli@latest, or re-run the install script at https://cloud.example/install.sh.",
    );
    expect(doc.next?.action).not.toContain(NOT_PUBLISHED);
    expect(doc.next?.action).not.toContain("catalyst-skills install");
  });

  test("npm cannot be asked: a neutral hint, never a claim either way", () => {
    for (const npmLatest of ["fail", undefined]) {
      const action = json(refusedHome(npmLatest)).next?.action ?? "";
      expect(action, String(npmLatest)).toContain(
        "Whether a newer Catalyst CLI is published could not be checked.",
      );
      expect(action).not.toContain(NOT_PUBLISHED);
      expect(action).not.toContain("Update the CLI:");
    }
  });
});

describe("where-am-i.mjs: the steps come in the order a person can act on them", () => {
  const ORDER = [
    "machine",
    "coding accounts",
    "account",
    "projects",
    "repositories",
    "person",
    "repository declarations",
    "host",
  ];

  test("nothing beyond the machine is done: the coding account is the first question, not the project", () => {
    const doc = json(
      connectedHome({
        codingAccounts: NONE_ENROLLED,
        noProject: true,
        hostsCurrent: null,
      }),
    );
    expect(doc.parts.map((p) => p.part)).toEqual(ORDER);
    expect(doc.next?.part).toBe("coding accounts");
    expect(doc.finished).toBe(false);
  });

  test("an account enrolled and no project mapped: the project is next, and nothing after it is named", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      noProject: true,
      hostsCurrent: null,
    });
    const doc = json(home);
    expect(doc.next?.part).toBe("projects");
    expect(run(home, ["--next"]).stdout).toMatch(/^projects: pick ONE project/);
    // the declaration and the host wait on a project; neither is called a failure of its own
    expect(part(doc, "repository declarations").verdict).toBe("unreadable");
    expect(part(doc, "repository declarations").lines[0]).toMatch(
      /no project is mapped yet/,
    );
  });

  test("the report prints the parts in that order", () => {
    const report = run(
      connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS }),
      [],
    ).stdout;
    const at = (name: string) => report.indexOf(`${name}  [`);
    for (let i = 1; i < ORDER.length; i++)
      expect(
        at(ORDER[i]!),
        `${ORDER[i - 1]} before ${ORDER[i]}`,
      ).toBeGreaterThan(at(ORDER[i - 1]!));
  });
});

describe("where-am-i.mjs: the repository declaration is read from the project's environment_declared check", () => {
  type Note = { repo: string; reason?: string };
  const decl = (state: string, reason?: string, repos?: Note[]) => ({
    id: "environment_declared",
    state,
    ...(reason ? { reason } : {}),
    ...(repos ? { repos } : {}),
  });
  const REPOS = "https://cloud.example/settings/projects";

  test("no declaration committed yet: unfinished, names .catalyst/catalyst.toml, and is the next step", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: PASS,
      environmentDeclared: decl("fail", "no_environment_declaration"),
    });
    const doc = json(home);
    const d = part(doc, "repository declarations");
    expect(d.verdict).toBe("unfinished");
    expect(d.lines.join("\n")).toContain(
      "ENG: no .catalyst/catalyst.toml on its default branch yet",
    );
    expect(d.lines.join("\n")).toContain("never a value");
    expect(d.where).toBe(
      "write .catalyst/catalyst.toml with references/declaring-a-repository.md, then open a pull request",
    );
    expect(doc.next).toMatchObject({
      part: "repository declarations",
      blocking: true,
    });
    expect(doc.next?.action).toMatch(/catalyst\.toml/);
    expect(doc.finished).toBe(false);
    // a command gets "do", a page gets "where"
    expect(run(home, []).stdout).toMatch(
      /^ {2}do: write \.catalyst\/catalyst\.toml/m,
    );
  });

  test("awaiting approval: names Approve this revision and the repositories page, owned by an owner or admin", () => {
    const d = part(
      json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          hostsCurrent: PASS,
          environmentDeclared: decl("fail", "declaration_awaiting_approval"),
        }),
      ),
      "repository declarations",
    );
    expect(d.verdict).toBe("unfinished");
    expect(d.lines.join("\n")).toContain("Approve this revision");
    expect(d.owner).toBe("a workspace owner or admin");
    expect(d.where).toBe(REPOS);
  });

  test("an invalid file names the fix, not the approval", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        environmentDeclared: decl("fail", "declaration_invalid"),
      }),
    );
    expect(doc.next?.action).toMatch(/fix the file/);
    expect(doc.next?.action).not.toMatch(/Approve/);
  });

  test("no default repository: register one first, on the repositories page", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        environmentDeclared: decl("fail", "no_team_repo_default"),
      }),
    );
    expect(doc.next?.action).toMatch(/register one and make it the default/);
    expect(doc.next?.where).toBe(REPOS);
  });

  test("the project's other repositories are read per repository, off the check's own notes", () => {
    const d = part(
      json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          hostsCurrent: PASS,
          environmentDeclared: decl("pass", undefined, [
            { repo: "example/api", reason: "no_environment_declaration" },
          ]),
        }),
      ),
      "repository declarations",
    );
    expect(d.verdict).toBe("unfinished");
    expect(d.lines[0]).toBe(
      "ENG: a declaration is in effect for the project's default repository",
    );
    expect(d.lines[1]).toMatch(
      /^ENG, example\/api: no \.catalyst\/catalyst\.toml/,
    );
  });

  test("in effect: ok, and setup can finish", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        environmentDeclared: decl("pass"),
      }),
    );
    expect(part(doc, "repository declarations")).toMatchObject({
      verdict: "ok",
      owner: null,
      where: null,
    });
    expect(doc.finished).toBe(true);
  });

  test("unknown: unreadable, never ok, and the step is a re-check, not a file", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: PASS,
      environmentDeclared: decl("unknown", "declaration_unread"),
    });
    const doc = json(home);
    expect(part(doc, "repository declarations").verdict).toBe("unreadable");
    expect(doc.finished).toBe(false);
    expect(doc.next?.action).toMatch(/catalyst team check/);
    expect(doc.next?.action).not.toMatch(/Re-check|catalyst\.toml/);
  });

  test("a cloud that carries no such check: nothing is read, said so, and it does not block", () => {
    const doc = json(
      connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS }),
    );
    const d = part(doc, "repository declarations");
    expect(d.verdict).toBe("ok");
    expect(d.lines[0]).toMatch(/reports no repository declaration check/);
    expect(doc.finished).toBe(true);
  });
});

describe("where-am-i.mjs: a logged-out machine keeps its installed CLI", () => {
  test("a config with a recorded cliPath and no credential reads status through that CLI, and the next step is connecting", () => {
    const home = mkdtempSync(join(tmpdir(), "onboard-logged-out-"));
    const cli = join(home, "fake-cli.mjs");
    writeFileSync(
      cli,
      'const a = process.argv.slice(2).join(" ");\nif (a === "status") { console.log("Not connected to a tenant."); process.exit(2); }\nprocess.stderr.write(`not connected — run: catalyst-skills login\\n`); process.exit(2);\n',
    );
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(
      join(home, ".config", "catalyst-cloud", "customer.json"),
      JSON.stringify({
        baseUrl: "https://cloud.example",
        account: "example",
        cliPath: cli,
      }),
    );
    const out = spawnSync(process.execPath, [script, "--json"], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        CATALYST_SKILLS_HOME: home,
        HOME: home,
        PATH: "/usr/bin:/bin",
      },
    });
    expect(out.status, out.stderr).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc & {
      cli: string;
      connected: boolean;
    };
    expect(doc.connected).toBe(false);
    expect(doc.cli).toBe(`node ${cli}`);
    expect(doc.next?.part).toBe("machine");
    expect(doc.next?.action).toBe("connect this machine");
    // the keyless login alone, by the installed CLI's own name: no npx line for a machine that holds the
    // CLI, and no key form for a person who has not said they hold one
    expect(doc.next?.where).toBe("catalyst login");
  });
});

describe("where-am-i.mjs: leftovers of the old local runtime, from the CLI's own list", () => {
  const CAPS = {
    capabilities: [
      { verb: "legacy", needs: "member", availability: "available" },
    ],
  };
  const found = [
    { kind: "plugin", name: "catalyst-dev@catalyst", path: "/x" },
    { kind: "job", name: "com.catalyst.agent", path: "/y" },
    { kind: "data", name: "~/.config/catalyst", path: "/z", data: true },
  ];
  test("found: a machine line and a --next note that offer catalyst legacy --remove, never blocking the next step", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: PASS,
      capabilities: CAPS,
      legacy: { sourceCommit: "abc", found, removed: [], remaining: found },
    });
    const doc = json(home) as Doc & { notes: string[] };
    expect(part(doc, "machine").verdict).toBe("ok");
    expect(part(doc, "machine").lines.at(-1)).toBe(
      "note leftovers of the old local Catalyst runtime (3): plugin catalyst-dev@catalyst, job com.catalyst.agent, data ~/.config/catalyst; removing them is strongly recommended: catalyst legacy --remove (all data folders are kept)",
    );
    expect(doc.notes).toContain(
      "this machine still carries 3 pieces of the old local Catalyst runtime (plugin catalyst-dev@catalyst, job com.catalyst.agent, data ~/.config/catalyst); offer catalyst legacy --remove once, strongly recommended, keep all shared data folders",
    );
    expect(doc.next?.part).not.toBe("machine");
    expect(run(home, ["--next"]).stdout).toMatch(
      /^note: this machine still carries 3 pieces/m,
    );
  });
  test("nothing found, or an older CLI without the verb: no line and no note", () => {
    for (const s of [
      { capabilities: CAPS, legacy: { found: [] } },
      { capabilities: { capabilities: [] } },
    ]) {
      const doc = json(
        connectedHome({
          codingAccounts: CA_ENROLLED,
          hostsCurrent: PASS,
          ...s,
        }),
      ) as Doc & { notes: string[] };
      expect(part(doc, "machine").lines.join("\n")).not.toContain(
        "old local Catalyst runtime",
      );
      expect(doc.notes.join("\n")).not.toContain("old local Catalyst runtime");
    }
  });
});

describe("where-am-i.mjs --repo: the checkout's agent setup, read through the CLI, never blocking", () => {
  const CAPS = {
    capabilities: [
      { verb: "repo agent-setup", needs: "member", availability: "available" },
      { verb: "repo agents-block", needs: "member", availability: "available" },
    ],
  };
  const convertible = {
    path: "/tmp/app",
    agentsMd: { present: false, block: "absent" },
    claudeMd: { present: true, importsAgentsMd: false, otherLines: 3 },
    verdict: "convertible",
    plan: [
      "create AGENTS.md from CLAUDE.md's content and leave CLAUDE.md as the thin importer (`@AGENTS.md`)",
    ],
    blockers: [],
  };
  const portable = {
    path: "/tmp/app",
    agentsMd: { present: true, block: "current" },
    claudeMd: { present: true, importsAgentsMd: true, otherLines: 0 },
    verdict: "portable",
    plan: [],
    blockers: [],
  };
  const ready = {
    codingAccounts: CA_ENROLLED,
    hostsCurrent: PASS,
    environmentDeclared: { id: "environment_declared", state: "pass" },
    capabilities: CAPS,
  };

  test("a convertible checkout is an unfinished, non-blocking part with the offers named, a note on --next, and the part's do line", () => {
    const home = connectedHome({ ...ready, repoSetup: convertible });
    const out = spawnSync(
      process.execPath,
      [script, "--json", "--repo", "/tmp/app"],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          CATALYST_SKILLS_HOME: home,
          HOME: home,
          PATH: "/usr/bin:/bin",
        },
      },
    );
    const doc = JSON.parse(out.stdout) as Doc & { notes: string[] };
    const p = part(doc, "repository agent setup");
    expect(p.verdict).toBe("unfinished");
    expect(p.blocking).toBe(false);
    expect(p.lines).toEqual([
      "AGENTS.md: absent",
      "CLAUDE.md: 3 lines of its own guidance, no @AGENTS.md import",
      "layout: convertible — create AGENTS.md from CLAUDE.md's content and leave CLAUDE.md as the thin importer (`@AGENTS.md`)",
    ]);
    expect(p.where).toBe("catalyst repo agent-setup /tmp/app");
    expect(doc.notes).toEqual([
      "repository /tmp/app: Catalyst block absent, layout convertible — offer the Catalyst block for AGENTS.md (catalyst repo agents-block /tmp/app --write) and the portable layout (catalyst repo agent-setup /tmp/app --apply) after a yes (references/repository-agent-setup.md)",
    ]);
    // everything else is done, so this is the next step, and it says it does not block
    expect(doc.next?.part).toBe("repository agent setup");
    expect(doc.next?.blocking).toBe(false);
    expect(doc.next?.action).toMatch(
      /^say in one clause what the checkout holds, then offer the Catalyst block for AGENTS\.md .* and the portable layout .*, each after a yes, on a branch for the pull request the person opens$/,
    );
    const next = spawnSync(
      process.execPath,
      [script, "--next", "--repo", "/tmp/app"],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          CATALYST_SKILLS_HOME: home,
          HOME: home,
          PATH: "/usr/bin:/bin",
        },
      },
    );
    expect(next.stdout).toMatch(/\(does not block the steps below\)/);
    expect(next.stdout).toMatch(
      /^note: repository \/tmp\/app: Catalyst block absent/m,
    );
  });

  test("a portable checkout with the block current is ok, with no note; without --repo the part does not exist", () => {
    const home = connectedHome({ ...ready, repoSetup: portable });
    const env = {
      ...process.env,
      CATALYST_SKILLS_HOME: home,
      HOME: home,
      PATH: "/usr/bin:/bin",
    };
    const doc = JSON.parse(
      spawnSync(process.execPath, [script, "--json", "--repo", "/tmp/app"], {
        encoding: "utf8",
        timeout: 20_000,
        env,
      }).stdout,
    ) as Doc & { notes: string[] };
    expect(part(doc, "repository agent setup").verdict).toBe("ok");
    expect(doc.notes).toEqual([]);
    const plain = JSON.parse(
      spawnSync(process.execPath, [script, "--json"], {
        encoding: "utf8",
        timeout: 20_000,
        env,
      }).stdout,
    ) as Doc;
    expect(
      plain.parts.find((p) => p.part === "repository agent setup"),
    ).toBeUndefined();
  });

  test("an older CLI without the verb reads unreadable and non-blocking, naming the update", () => {
    const home = connectedHome({
      ...ready,
      capabilities: { capabilities: [] },
    });
    const doc = JSON.parse(
      spawnSync(process.execPath, [script, "--json", "--repo", "/tmp/app"], {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          CATALYST_SKILLS_HOME: home,
          HOME: home,
          PATH: "/usr/bin:/bin",
        },
      }).stdout,
    ) as Doc;
    const p = part(doc, "repository agent setup");
    expect(p.verdict).toBe("unreadable");
    expect(p.blocking).toBe(false);
    expect(p.lines[0]).toContain("update the CLI");
  });
});

describe("where-am-i.mjs: a mapped project whose readiness is blocked", () => {
  test("a Linear automation conflict keeps the projects part unfinished with the gate open, and the next step is that rule's fix in Linear, then a re-check", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        environmentDeclared: { id: "environment_declared", state: "pass" },
        readinessStatus: "blocked",
        blockingChecks: [
          {
            id: "linear_automation_pr_open",
            state: "fail",
            reason: "automation_conflict",
          },
          {
            id: "linear_automation_pr_merge",
            state: "fail",
            reason: "automation_conflict",
          },
          {
            id: "merge_queue_configured",
            state: "fail",
            reason: "merge_queue_unconfigured",
          },
        ],
      }),
    );
    const p = part(doc, "projects");
    expect(p.verdict).toBe("unfinished");
    // the degrading check is listed as failing but never as the blocker
    expect(p.lines.join("\n")).toMatch(
      /ENG: BLOCKED — linear_automation_pr_open, linear_automation_pr_merge; in Linear, open Settings → Teams → ENG → Workflow → Workflows & automations → Pull request and commit automations and set On PR open, On PR merge to No action/,
    );
    expect(doc.next?.part).toBe("projects");
    expect(doc.next?.action).toMatch(
      /^fix ENG's blocking checks \(linear_automation_pr_open, linear_automation_pr_merge\): in Linear, open Settings → Teams → ENG → Workflow → Workflows & automations → Pull request and commit automations and set On PR open, On PR merge to No action \(Catalyst does not yet offer to change these rules\); then run catalyst team check ENG and run this again$/,
    );
    expect(doc.next?.owner).toBe(
      "A tenant owner or admin, in Linear’s own settings.",
    );
    expect(doc.next?.where).toBeNull();
    expect(doc.next?.action).not.toMatch(/team map|team list/);
    expect(doc.finished).toBe(false);
  });

  test("a degraded project with its gate open stays set up (the blocked rule does not widen)", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: PASS,
        environmentDeclared: { id: "environment_declared", state: "pass" },
        readinessStatus: "degraded",
        blockingChecks: [
          {
            id: "merge_queue_configured",
            state: "fail",
            reason: "merge_queue_unconfigured",
          },
        ],
      }),
    );
    expect(part(doc, "projects").verdict).toBe("ok");
    expect(doc.next?.part).not.toBe("projects");
  });
});

describe("where-am-i.mjs: a mapped project that was never checked", () => {
  test("leaves the repository declaration unread and asks for a team check, never ok", () => {
    const doc = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        hostsCurrent: null,
        readinessStatus: "unchecked",
      }),
    );
    const d = part(doc, "repository declarations");
    expect(d.verdict).toBe("unreadable");
    expect(d.lines[0]).toMatch(/no project has a readiness check yet/);
    // An older CLI with no capabilities verb is told to update, never sent to a page.
    expect(d.where).toBe("npm install -g @catalyst-cloud/cli@latest");
    expect(doc.next?.part).toBe("repository declarations");
    expect(doc.next?.action).toMatch(/update the CLI .*catalyst team check ENG/);
    expect(doc.next?.action).not.toMatch(/Re-check/);
    expect(doc.finished).toBe(false);
  });
});

describe("where-am-i.mjs: a step is a command when this person's CLI can run it, else the command with who can", () => {
  const cap = (verb: string, needs: string, availability = "available") => ({
    verb,
    needs,
    availability,
    routes: [],
    missing: [],
  });
  const TEAM_VERBS = {
    capabilities: [
      cap("team check", "admin"),
      cap("team map", "admin"),
      cap("ready", "member"),
    ],
  };
  const unchecked = (extra: Partial<Scenario>) => ({
    codingAccounts: CA_ENROLLED,
    hostsCurrent: null,
    readinessStatus: "unchecked",
    ...extra,
  });

  test("an admin with `team check` available is told to run it, as a command, not sent to the page", () => {
    const home = connectedHome(unchecked({ capabilities: TEAM_VERBS }));
    const doc = json(home);
    expect(doc.next?.action).toMatch(
      /^run catalyst team check ENG, then run this again$/,
    );
    expect(doc.next?.where).toBe("catalyst team check ENG");
    expect(doc.next?.owner).toBe(
      "you, the assistant: run it now with the person's login, without asking",
    );
    expect(run(home, []).stdout).toMatch(/^ {2}do: catalyst team check ENG$/m);
    expect(run(home, ["--next"]).stdout).not.toMatch(/settings\/linear-teams/);
  });

  test("a member is told which role can run it, and the command is named rather than a page", () => {
    const doc = json(
      connectedHome(unchecked({ capabilities: TEAM_VERBS, role: "member" })),
    );
    expect(doc.next?.action).toMatch(
      /^a workspace owner or admin runs catalyst team check ENG/,
    );
    expect(doc.next?.owner).toBe("a workspace owner or admin");
    expect(doc.next?.where).toBe("catalyst team check ENG");
    expect(doc.next?.action).not.toMatch(/Re-check/);
  });

  test("an older CLI (no capabilities verb) is told to update; only a cloud that does not serve the route keeps the page", () => {
    const older = json(connectedHome(unchecked({})));
    expect(older.next?.action).toBe(
      "update the CLI (npm install -g @catalyst-cloud/cli@latest), then a workspace owner or admin runs catalyst team check ENG; then run this again",
    );
    expect(older.next?.where).toBe("npm install -g @catalyst-cloud/cli@latest");
    const olderCloud = json(
      connectedHome(
        unchecked({
          capabilities: {
            capabilities: [cap("team check", "admin", "needs_newer_cloud")],
          },
        }),
      ),
    );
    expect(olderCloud.next?.action).toBe(
      "this cloud does not serve catalyst team check yet, so a workspace owner or admin re-checks the project on the projects page; then run this again",
    );
    expect(olderCloud.next?.where).toBe(
      "https://cloud.example/settings/projects",
    );
  });

  test("mapping a project becomes `team list` then `team map` for an admin whose CLI has it", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      noProject: true,
      hostsCurrent: null,
      capabilities: TEAM_VERBS,
    });
    const doc = json(home);
    expect(doc.next?.part).toBe("projects");
    expect(doc.next?.action).toMatch(
      /run catalyst team list, then catalyst team map <KEY>/,
    );
    expect(doc.next?.where).toBe("catalyst team list");
    const member = json(
      connectedHome({
        codingAccounts: CA_ENROLLED,
        noProject: true,
        hostsCurrent: null,
        capabilities: TEAM_VERBS,
        role: "member",
      }),
    );
    expect(member.next?.action).toMatch(
      /^a workspace owner or admin maps ONE project/,
    );
  });
});
