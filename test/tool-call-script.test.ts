// tool-call-script.test.ts — CTC-6104: "why did the WorkOS call on ENG-123 fail?" is answered in one
// line from the portal's own record, read through `catalyst mcp status <server> --json` and nothing
// else. Modelled on snapshot-script.test.ts: a real `node` process, a home holding a customer.json,
// and a stand-in CLI at the recorded cliPath that records its argv and answers the verb with a
// configurable JSON body, exit code and stderr.
//
// The call shapes are copied field for field from test/mcp.test.ts (the real route bodies), so the
// script is held to the shape the verb prints.
import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "skills", "whats-happening", "scripts", "tool-call.mjs");

const STATUS = {
  server: "workos", state: "ready", credentials: [],
  detail: "workos answered and lists 12 tools.", checked_at: 1760712000000,
  tools: { offered: 12, catalog: 12, missing_upstream: [] }, auth: "bearer",
  grants: { key_id: "key_01HZX", granted: 3, cataloged: 12, missing: ["workos__list_users", "workos__get_roles"] },
};
// One recorded call, as the portal's calls route returns it (the fields the verb prints verbatim).
interface Call {
  call_id: string; key_id: string; user_id: string | null; tool_name: string; outcome: string;
  denied_reason: string | null; approval_state: string; latency_ms: number; bytes_in: number;
  bytes_out: number; at: number; explanation: string | null;
  dispatch: { ticket: string; phase: string; generation: number } | null;
}
const OK_CALL: Call = {
  call_id: "call_01HZW", key_id: "key_01HZX", user_id: null, tool_name: "workos__get_user",
  outcome: "ok", denied_reason: null, approval_state: "not-required", latency_ms: 212,
  bytes_in: 1301, bytes_out: 2048, at: 1792230063000,
  dispatch: { ticket: "CTC-1234", phase: "implement", generation: 3 }, explanation: null,
};
const EXPIRED = "Refused: the approval for this call expired before it ran. A workspace admin can re-approve it on the account's Connections page.";
const DENIED_CALL: Call = {
  ...OK_CALL, call_id: "call_01HZX", tool_name: "workos__list_users", outcome: "denied",
  denied_reason: "approval-expired", approval_state: "missing-or-invalid", latency_ms: 14,
  bytes_in: 0, bytes_out: 0, at: 1792229575000,
  explanation: EXPIRED,
};
const PROVIDER_EXPLANATION = "The server failed or refused the call. Retry, or read the server's status.";
const PROVIDER_CALL: Call = {
  ...OK_CALL, call_id: "call_01HZY", tool_name: "workos__get_roles", outcome: "provider_error",
  latency_ms: 1803, at: 1792229412000, dispatch: null,
  explanation: PROVIDER_EXPLANATION,
};

const body = (calls: Call[]) => ({ status: STATUS, calls: { server: "workos", calls } });

// What the real verb prints for the two refusals the script must not pass through verbatim.
const NEEDS_NEWER =
  "recent tool calls for workos needs a newer Catalyst Cloud than https://cloud.example is running — the route answered 404. Nothing is wrong with your tenant; ask your operator when the mirror last deployed.";
const PORTAL_UNAVAILABLE =
  "mcp status cannot reach this workspace's MCP portal: the cloud publishes no portal.url (app_origin_not_portal_fronted). Ask your operator to configure the portal host.";

interface Answer { code?: number; stdout?: string; stderr?: string }

function setup(answer: Answer = {}, config: Record<string, unknown> | null = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tool-call-script-"));
  const cli = join(dir, "fake-cli.mjs");
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  writeFileSync(
    cli,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `const answer = JSON.parse(readFileSync(${JSON.stringify(join(dir, "answer.json"))}, "utf8"));`,
      'if (answer.stderr) process.stderr.write(answer.stderr + "\\n");',
      'if (answer.stdout) process.stdout.write(answer.stdout + "\\n");',
      // exitCode, not exit(): a process.exit() after a large write to a pipe cuts the write at 64 KiB.
      "process.exitCode = answer.code ?? 0;",
    ].join("\n"),
  );
  if (config !== null) {
    mkdirSync(join(dir, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "catalyst-cloud", "customer.json"),
      JSON.stringify({ key: "ctc_acct_test", cliPath: cli, ...config }),
    );
  }
  const calls = (): string[][] => {
    try {
      return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { dir, calls };
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CATALYST_SKILLS_HOME: home },
  });
}

/** A home whose stand-in CLI answers `mcp status workos --json` with these calls. */
function withCalls(calls: Call[]) {
  return setup({ stdout: JSON.stringify(body(calls)) });
}

/** A home whose stand-in CLI answers with these calls verbatim, for shapes the portal's type does not allow. */
function withRawCalls(calls: readonly unknown[]) {
  return setup({ stdout: JSON.stringify({ status: STATUS, calls: { server: "workos", calls } }) });
}

const lines = (s: string) => s.trimEnd().split("\n");
// Exactly one line: no CR, LF, U+2028 or U+2029 before the closing newline.
const ONE_LINE = /^[^\r\n\u2028\u2029]+\n$/;

describe("scenario: the desk explains a failed tool call in one line", () => {
  test("names the ticket, the tool, the reason and who can fix it, in exactly one line", () => {
    const { dir } = withCalls([OK_CALL, DENIED_CALL, PROVIDER_CALL]);
    const r = run(dir, ["WorkOS", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    const line = r.stdout;
    expect(line).toContain("CTC-1234");
    expect(line).toContain("implement");
    expect(line).toContain("workos__list_users");
    expect(line).toContain("approval-expired");
    expect(line).toContain(EXPIRED);
    expect(line).toContain("Who can fix it: see the explanation above, which mentions a workspace admin; read it as written.");
    expect(r.stderr).toBe("");
  });

  test("the line names the server it read, so a wrong guess of the name is visible", () => {
    const { dir } = withCalls([DENIED_CALL]);
    const r = run(dir, ["WorkOS", "--ticket", "CTC-1234"]);
    expect(r.stdout).toContain("on workos");
  });
});

describe("scenario: the desk reads the same facts as the terminal verb", () => {
  test("it spawns exactly one invocation, `mcp status <server> --json`, with the server normalised", () => {
    const { dir, calls } = withCalls([DENIED_CALL]);
    run(dir, ["WorkOS", "--ticket", "CTC-1234"]);
    expect(calls()).toEqual([["mcp", "status", "workos", "--json"]]);
  });

  test("the verb is asked for the server and nothing else: no ticket or tool flag reaches it", () => {
    const { dir, calls } = withCalls([DENIED_CALL]);
    run(dir, ["workos", "--ticket", "CTC-1234", "--tool", "list_users"]);
    expect(calls()).toEqual([["mcp", "status", "workos", "--json"]]);
  });

  test("whitespace and dots in the name the person used become hyphens", () => {
    const { dir, calls } = withCalls([]);
    run(dir, ["  Work.OS  Cloud "]);
    expect(calls()).toEqual([["mcp", "status", "work-os-cloud", "--json"]]);
  });
});

describe("--json", () => {
  test("prints the answer's fields and a verdict", () => {
    const { dir } = withCalls([OK_CALL, DENIED_CALL, PROVIDER_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      server: "workos",
      ticket: "CTC-1234",
      phase: "implement",
      tool: "workos__list_users",
      outcome: "denied",
      reason: "approval-expired",
      explanation: EXPIRED,
      at: new Date(DENIED_CALL.at).toISOString(),
      fixer: { mentioned: ["a workspace admin"], basis: "mentioned in the explanation" },
      window: { read: 3, limit: 50, unreadable: 0 },
      verdict: "failed",
    });
  });
});

// The script does not decide who can fix a failure: that is free prose, and no rule over it is sound. The line shows
// the explanation as the cloud wrote it and says only what is true by construction: which listed roles the
// explanation mentions, that it mentions none, or that there is no explanation.
describe("who can fix it: the line says what the explanation mentions and decides nothing", () => {
  const MENTIONS = (roles: string) => `Who can fix it: see the explanation above, which mentions ${roles}; read it as written.`;
  const UNNAMED = "Who can fix it: this script found no workspace owner, admin or operator in the explanation above; read it as written.";
  const NO_ONE_LINE = "Who can fix it: the record has no explanation, so it names no one.";
  interface Fixer { mentioned: string[]; basis: string | null }
  const fixerOf = (dir: string) => (JSON.parse(run(dir, ["workos", "--json"]).stdout) as { fixer: Fixer }).fixer;
  const say = (explanation: string) => {
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    return { r: run(dir, ["workos"]), fixer: fixerOf(dir) };
  };

  test("form 1, the canonical explanation: it mentions a workspace admin, and the line claims no more", () => {
    const { dir } = withCalls([DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(EXPIRED);
    expect(r.stdout).toContain(MENTIONS("a workspace admin"));
    expect(fixerOf(dir)).toEqual({ mentioned: ["a workspace admin"], basis: "mentioned in the explanation" });
  });

  test("form 2, an explanation that mentions no listed role: the line says what this script found, with no pointer of its own", () => {
    const { dir } = withCalls([PROVIDER_CALL]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(PROVIDER_EXPLANATION);
    expect(r.stdout).toContain(UNNAMED);
    expect(r.stdout).not.toContain("manages this workspace");
    expect(r.stdout).not.toContain("names no one");
    expect(fixerOf(dir)).toEqual({ mentioned: [], basis: "explanation names none" });
  });

  test("form 3, no explanation at all (null, absent, blank or not a string): the labelled fallback", () => {
    for (const explanation of [null, undefined, "", "   ", 42]) {
      const { dir } = withRawCalls([{ ...PROVIDER_CALL, explanation }]);
      const r = run(dir, ["workos"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(NO_ONE_LINE);
      // Nothing the record does not say: not who manages MCP servers, not a pointer to anyone.
      expect(r.stdout).not.toMatch(/manages|owner or admin/);
      expect(fixerOf(dir)).toEqual({ mentioned: [], basis: "no explanation" });
    }
  });

  // Every adversarial sentence the five rounds produced. None may make the line say a role can fix it: the line says
  // "mentions" or "found no ... in the explanation", always on one line, with the explanation in it as written.
  const ADVERSARIAL = [
    "A workspace admin cannot fix this; only the provider can restore the service.",
    "A workspace admin can retry the call, but the upstream server is still down. The provider must restore it.",
    "Only the provider can fix this; an admin can retry it.",
    "Nobody can fix it. Ask your workspace admin.",
    "The upstream server's owner can fix it.",
    "You have admin rights, but the provider must restore the service.",
    "A workspace admin can't fix this.",
    "A workspace admin can’t fix this.",
    "A workspace admin can fix this only if the provider restores the service first.",
    "A workspace admin can approve it unless the provider has blocked the key.",
    "No one can fix this from here; a workspace admin can only wait.",
    "No workspace admin can fix this.",
    "A workspace admin is unable to fix this.",
    "Neither an owner nor an admin can fix this.",
    "Do not ask a workspace admin; ask the provider instead.",
    "The approval page is managed by a workspace admin.",
    "A workspace admin can re-approve it. A workspace admin cannot grant new tools.",
    "A workspace admin cannot fix this. Ask your admin.",
    "A workspace admin cannot fix this, but an operator can.",
    "A workspace admin can re-approve it. Only the provider can fix this failure.",
    "Only the provider can restore the service. A workspace admin can re-approve the key.",
    "A workspace admin can re-approve it on v1.2. Only the provider can fix this.",
    "A workspace admin can re-approve it. An operator can restore the service.",
    "An admin can see this call in the audit list.",
    "A workspace admin can list the calls.",
    "Have an admin re-approve it.",
    "A workspace admin is able to fix this.",
    "Ask your workspace admin, who may know.",
    "The provider’s operator can fix it.",
    "The approval was not granted. A workspace admin can grant it.",
  ];
  test.each(ADVERSARIAL)("never says a role can fix it: %s", (explanation) => {
    const { r, fixer } = say(explanation);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(explanation);
    for (const claim of ["Who can fix it: a workspace admin", "Who can fix it: an admin", "Who can fix it: an owner", "Who can fix it: an operator", "Who can fix it: your", "Who can fix it: the workspace"])
      expect(r.stdout).not.toContain(claim);
    expect(r.stdout).toMatch(
      /Who can fix it: (?:see the explanation above, which mentions [^;]+; read it as written|this script found no workspace owner, admin or operator in the explanation above; read it as written)\./,
    );
    expect(fixer.basis).toBe(fixer.mentioned.length > 0 ? "mentioned in the explanation" : "explanation names none");
    // Nothing in the object a reader could take for "this role can fix it".
    expect(Object.keys(fixer).sort()).toEqual(["basis", "mentioned"]);
  });

  // The roles listed are the roles the explanation mentions, each once, in order of first mention, as written.
  test.each([
    ["A workspace admin can re-approve it. An operator can restore the service.", ["a workspace admin", "an operator"], "a workspace admin and an operator"],
    ["Ask your workspace owner to reconnect it.", ["your workspace owner"], "your workspace owner"],
    ["A workspace admin can re-approve it. Ask your workspace admin.", ["a workspace admin"], "a workspace admin"],
    ["An owner or admin can approve it.", ["an owner or admin"], "an owner or admin"],
    ["The upstream server's owner can fix it.", ["an owner"], "an owner"],
    ["Ask the ACCOUNT ADMIN.", ["the account admin"], "the account admin"],
    ["A workspace owner, an admin and an operator are listed.", ["a workspace owner", "an admin", "an operator"], "a workspace owner, an admin and an operator"],
  ])("form 1 lists what is mentioned: %s", (explanation, roles, phrase) => {
    const { r, fixer } = say(explanation);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(`Who can fix it: see the explanation above, which mentions ${phrase}; read it as written.`);
    expect(fixer).toEqual({ mentioned: roles, basis: "mentioned in the explanation" });
  });

  // --json carries what the explanation mentions and nothing a reader could take for "this role can fix it": no `who`,
  // no `named`, only `mentioned` and `basis`, even when the first role mentioned is the one the explanation rules out.
  test("--json: a role that can only retry is listed as mentioned, and no field says who can fix it", () => {
    const explanation = "A workspace admin can retry the call, but the upstream server is still down. The provider must restore it.";
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    const out = run(dir, ["workos", "--json"]).stdout;
    const { fixer } = JSON.parse(out) as { fixer: Fixer };
    expect(fixer).toEqual({ mentioned: ["a workspace admin"], basis: "mentioned in the explanation" });
    expect(out).not.toMatch(/"(?:who|named|roles)"/);
  });

  test("--json: the mentioned roles are in order of first mention, and basis is null when the call did not fail", () => {
    const { dir } = withCalls([{ ...DENIED_CALL, explanation: "An operator can look first; then a workspace owner or admin decides." }]);
    expect(fixerOf(dir)).toEqual({ mentioned: ["an operator", "a workspace owner or admin"], basis: "mentioned in the explanation" });
    for (const calls of [[OK_CALL], []]) {
      const { dir: other } = withCalls(calls);
      expect(fixerOf(other)).toEqual({ mentioned: [], basis: null });
    }
  });
});

describe("the reason", () => {
  test("no denied_reason and no explanation: the outcome stands and the line says the record gives no reason", () => {
    const { dir } = withCalls([{ ...PROVIDER_CALL, denied_reason: null, explanation: null }]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("provider_error");
    expect(r.stdout).toContain("the record gives no reason");
    expect(r.stdout).not.toContain(PROVIDER_EXPLANATION);
    expect(lines(r.stdout)).toHaveLength(1);
  });

  test("an explanation with newlines and repeated spaces is still one line", () => {
    const { dir } = withCalls([{ ...DENIED_CALL, explanation: "Refused:\n\nthe approval   expired.\r\nA workspace  admin can re-approve it." }]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("Refused: the approval expired. A workspace admin can re-approve it.");
  });
});

describe("the answer is one line whatever the flags and the record hold", () => {
  test("a --ticket value with a newline, no call for it: the inconclusive line is still one line", () => {
    const { dir } = withCalls([OK_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-9999\nSecond line"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(ONE_LINE);
    expect(r.stdout).toContain("CTC-9999 Second line has no call to workos");
  });

  test("--ticket and --tool values with newlines, calls that all succeeded: the no-failure line is one line", () => {
    const ok = { ...OK_CALL, tool_name: "workos__get\n_user", dispatch: { ticket: "CTC-1234\nX", phase: "implement", generation: 3 } };
    const { dir } = withCalls([ok]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234\nX", "--tool", "get\n_user"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no failed call to workos on CTC-1234 X matching get _user");
    expect(r.stdout).toMatch(ONE_LINE);
  });

  test("a recorded ticket, phase, tool and outcome with line breaks: the failed-call line is one line", () => {
    const odd = {
      ...DENIED_CALL,
      tool_name: "workos__list\n\u2028users",
      outcome: "denied\r\nagain",
      dispatch: { ticket: "CTC-\n1234", phase: "imple\nment", generation: 3 },
    };
    const { dir } = withCalls([odd]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(ONE_LINE);
    expect(r.stdout).toContain("CTC- 1234 imple ment: workos__list users on workos failed (denied again)");
  });
});

describe("which call is reported", () => {
  const NEWER = { ...DENIED_CALL, call_id: "call_new", tool_name: "workos__delete_user", denied_reason: "not-granted", explanation: "Refused: this key has no grant for the tool. A workspace admin can grant it.", at: 1792230000000 };

  test("the newest failed call wins: the earlier array element", () => {
    const { dir } = withCalls([NEWER, DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.stdout).toContain("workos__delete_user");
    expect(r.stdout).toContain("not-granted");
    expect(r.stdout).not.toContain("approval-expired");
  });

  test("--tool narrows by name or by substring", () => {
    const { dir } = withCalls([NEWER, DENIED_CALL]);
    expect(run(dir, ["workos", "--tool", "list_users"]).stdout).toContain("workos__list_users");
    expect(run(dir, ["workos", "--tool", "workos__list_users"]).stdout).toContain("approval-expired");
  });

  test("--tool with no match is not-in-window", () => {
    const { dir } = withCalls([NEWER, DENIED_CALL]);
    const out = JSON.parse(run(dir, ["workos", "--tool", "nope", "--json"]).stdout) as { verdict: string };
    expect(out.verdict).toBe("not-in-window");
  });

  test("another ticket's failure is not reported for this one", () => {
    const other = { ...DENIED_CALL, dispatch: { ticket: "CTC-9999", phase: "plan", generation: 1 } };
    const { dir } = withCalls([other, OK_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no failed call");
    expect(r.stdout).not.toContain("approval-expired");
    expect(r.stdout).not.toContain("CTC-9999");
  });

  test("the ticket matches case-insensitively", () => {
    const { dir } = withCalls([DENIED_CALL]);
    const out = JSON.parse(run(dir, ["workos", "--ticket", "ctc-1234", "--json"]).stdout) as { verdict: string };
    expect(out.verdict).toBe("failed");
  });

  test("without --ticket the newest failed call overall is reported, and a call with no dispatch says no ticket", () => {
    const { dir } = withCalls([OK_CALL, PROVIDER_CALL, DENIED_CALL]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no ticket");
    expect(r.stdout).toContain("workos__get_roles");
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { ticket: string | null; phase: string | null };
    expect(json.ticket).toBeNull();
    expect(json.phase).toBeNull();
  });
});

describe("when the record cannot name a failure, it says so and does not guess", () => {
  test("the ticket's calls all succeeded: exit 0, no failed call, the newest ok time", () => {
    const { dir } = withCalls([OK_CALL, DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234", "--tool", "get_user"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("no failed call");
    expect(r.stdout).toContain("CTC-1234");
    expect(r.stdout).toContain(new Date(OK_CALL.at).toISOString());
    const json = JSON.parse(run(dir, ["workos", "--ticket", "CTC-1234", "--tool", "get_user", "--json"]).stdout) as { verdict: string };
    expect(json.verdict).toBe("no-failure");
  });

  test("the ticket is not in the window: inconclusive, never a success", () => {
    const { dir } = withCalls([OK_CALL, DENIED_CALL, PROVIDER_CALL]);
    const r = run(dir, ["workos", "--ticket", "ENG-123"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("ENG-123");
    expect(r.stdout).toContain("among the newest 50");
    expect(r.stdout).toContain("cannot say why");
    expect(r.stdout).not.toMatch(/\bok\b/);
    expect(r.stdout).not.toMatch(/succe/i);
    const json = JSON.parse(run(dir, ["workos", "--ticket", "ENG-123", "--json"]).stdout) as { verdict: string; window: unknown };
    expect(json.verdict).toBe("not-in-window");
    expect(json.window).toEqual({ read: 3, limit: 50, unreadable: 0 });
  });

  test.each([
    ["null", null],
    ["absent", undefined],
    ["a string", "yesterday"],
    ["false", false],
    ["true", true],
  ])("a call whose at is %s has an unrecorded time, never the epoch", (_name, at) => {
    const { dir } = withRawCalls([{ ...OK_CALL, at }]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("was ok at an unrecorded time.");
    expect(r.stdout).not.toContain("1970");
    const json = JSON.parse(run(dir, ["workos", "--ticket", "CTC-1234", "--json"]).stdout) as { verdict: string; at: string | null };
    expect(json.verdict).toBe("no-failure");
    expect(json.at).toBeNull();
  });

  test("a server with no recorded calls is inconclusive too", () => {
    const { dir } = withCalls([]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot say why");
  });
});

describe("a record with elements that are not calls", () => {
  test.each([
    ["null", null],
    ["a string", "oops"],
    ["a number", 42],
    ["a boolean", true],
    ["an array", []],
  ])("%s among the calls is skipped, and the real call after it is still explained", (_name, bad) => {
    const { dir } = withRawCalls([bad, DENIED_CALL]);
    for (const args of [["workos"], ["workos", "--ticket", "CTC-1234"], ["workos", "--tool", "list_users"]]) {
      const r = run(dir, args);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(lines(r.stdout)).toHaveLength(1);
      expect(r.stdout).toContain("workos__list_users");
      expect(r.stdout).toContain("approval-expired");
    }
  });

  test("a record of nothing but non-calls is inconclusive, not a crash and not a failure", () => {
    const { dir } = withRawCalls([null, "oops"]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("cannot say why");
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { verdict: string; window: unknown };
    expect(json.verdict).toBe("not-in-window");
    expect(json.window).toEqual({ read: 2, limit: 50, unreadable: 2 });
  });
});

// The verb checks that `calls` is an array and nothing about what is in it, so every field the script
// reads can arrive with the wrong type. A usable call is a plain object whose tool_name and outcome are
// non-empty strings; any other call is skipped like a non-object element (it still counts in window.read,
// and never poses as a failure, a success or the newest ok call). Every other field is read by type and
// treated as absent when it is not the type the route sends.
describe("a recorded call with a field of the wrong type", () => {
  const WRONG: [string, unknown][] = [
    ["null", null],
    ["a number", 42],
    ["a boolean", true],
    ["an array", [1, "a"]],
    ["an object with a non-callable toString", { toString: 5 }],
    ["a nested object", { a: { b: 1 } }],
  ];
  interface Out { server: string; ticket: string | null; phase: string | null; tool: string | null; outcome: string | null; reason: string | null; explanation: string | null; at: string | null; fixer: { mentioned: string[]; basis: string | null }; window: { read: number; limit: number; unreadable: number }; verdict: string }
  const json = (dir: string, args: string[] = []) => JSON.parse(run(dir, ["workos", ...args, "--json"]).stdout) as Out;
  // Nothing but a clean exit and one line of text: no crash, no stack trace, no value printed raw.
  const clean = (r: ReturnType<typeof run>, why: string) => {
    expect(r.stderr, `${why}: stderr`).toBe("");
    expect(r.status, `${why}: exit`).toBe(0);
    expect(r.stdout, `${why}: one line`).toMatch(ONE_LINE);
    expect(r.stdout, `${why}: no field posing as a value`).not.toMatch(/failed \(null\)|\[object|undefined|NaN/);
  };

  // tool_name and outcome decide whether a call is usable at all.
  const REQUIRED = [
    ...WRONG,
    ["an empty string", ""],
    ["blank", "   "],
  ];
  const GOOD = { ...DENIED_CALL, call_id: "call_good", tool_name: "workos__good", denied_reason: "not-granted", explanation: "Refused: this key has no grant for the tool. A workspace admin can grant it." };
  const NEWER_AT = OK_CALL.at + 60_000;
  test.each(["tool_name", "outcome"].flatMap((field) => REQUIRED.map(([name, bad]) => [field, name, bad] as const)))(
    "%s as %s: the call is skipped, never a failure, a success or the newest ok",
    (field, _name, bad) => {
      // Alone, it is an unreadable record: inconclusive, the same words as an empty window.
      const alone = withRawCalls([{ ...DENIED_CALL, [field]: bad }]);
      for (const args of [[], ["--ticket", "CTC-1234"]]) {
        const r = run(alone.dir, ["workos", ...args]);
        clean(r, `alone ${args.join(" ")}`);
        expect(r.stdout, "alone: inconclusive").toContain("cannot say why");
        expect(r.stdout, "alone: no failure").not.toContain("failed (");
        expect(r.stdout, "alone: no success").not.toContain("no failed call");
        expect(json(alone.dir, args)).toMatchObject({ verdict: "not-in-window", window: { read: 1, limit: 50, unreadable: 1 } });
      }
      // Beside a usable failed call, that one is the call reported.
      const beside = withRawCalls([{ ...DENIED_CALL, [field]: bad }, GOOD]);
      for (const args of [[], ["--ticket", "CTC-1234"]]) {
        const r = run(beside.dir, ["workos", ...args]);
        clean(r, `beside ${args.join(" ")}`);
        expect(r.stdout, "beside: the usable call").toContain("workos__good");
        expect(r.stdout, "beside: its reason").toContain("not-granted");
        expect(r.stdout, "beside: not the unusable call").not.toContain("approval-expired");
        expect(r.stdout, "beside: not the unusable call's tool").not.toContain("workos__list_users");
      }
      // A newer ok-looking record that is unusable is not the newest ok call.
      const oks = withRawCalls([{ ...OK_CALL, at: NEWER_AT, [field]: bad }, OK_CALL]);
      const r = run(oks.dir, ["workos", "--ticket", "CTC-1234"]);
      clean(r, "newest ok");
      expect(r.stdout, "newest ok: the usable call's time").toContain(new Date(OK_CALL.at).toISOString());
      expect(r.stdout, "newest ok: not the unusable call's time").not.toContain(new Date(NEWER_AT).toISOString());
    },
  );

  // The other fields are read by type: a value of the wrong type is absent, and the call is still reported.
  const OPTIONAL: [string, (bad: unknown) => unknown, Partial<Out>][] = [
    ["denied_reason", (bad) => ({ ...DENIED_CALL, denied_reason: bad }), { reason: "denied" }],
    ["explanation", (bad) => ({ ...DENIED_CALL, explanation: bad }), { explanation: null, fixer: { mentioned: [], basis: "no explanation" } }],
    ["dispatch", (bad) => ({ ...DENIED_CALL, dispatch: bad }), { ticket: null, phase: null }],
    ["dispatch.ticket", (bad) => ({ ...DENIED_CALL, dispatch: { ticket: bad, phase: "implement", generation: 3 } }), { ticket: null }],
    ["dispatch.phase", (bad) => ({ ...DENIED_CALL, dispatch: { ticket: "CTC-1234", phase: bad, generation: 3 } }), { phase: null }],
    ["at", (bad) => ({ ...DENIED_CALL, at: bad }), { at: null }],
  ];
  const EXPECTED: Out = {
    server: "workos", ticket: "CTC-1234", phase: "implement", tool: "workos__list_users", outcome: "denied", reason: "approval-expired",
    explanation: EXPIRED, at: new Date(DENIED_CALL.at).toISOString(), fixer: { mentioned: ["a workspace admin"], basis: "mentioned in the explanation" },
    window: { read: 1, limit: 50, unreadable: 0 }, verdict: "failed",
  };
  test.each(
    OPTIONAL.flatMap(([field, make, expected]) =>
      WRONG.filter(([name]) => !(field === "at" && name === "a number")).map(([name, bad]) => [field, name, bad, make, expected] as const),
    ),
  )("%s as %s: read as absent, the call is still explained", (_field, _name, bad, make, expected) => {
    const { dir } = withRawCalls([make(bad)]);
    const r = run(dir, ["workos"]);
    clean(r, "line");
    expect(r.stdout).toContain("workos__list_users on workos failed (denied)");
    expect(json(dir)).toEqual({ ...EXPECTED, ...expected });
  });
});

// A record the script cannot read is counted, and every sentence that would otherwise claim to know the
// whole window says it does not. A failed readable call is still reported as failed.
describe("records the script could not read are counted and never hidden", () => {
  const NO_TOOL = { ...DENIED_CALL, tool_name: undefined };
  const unreadable = (dir: string, args: string[] = []) =>
    (JSON.parse(run(dir, ["workos", ...args, "--json"]).stdout) as { window: { read: number; limit: number; unreadable: number } }).window;

  test("a clean record says nothing about unreadable calls", () => {
    for (const calls of [[DENIED_CALL, OK_CALL], [OK_CALL], []]) {
      const { dir } = withCalls(calls);
      for (const args of [[], ["--ticket", "CTC-1234"], ["--ticket", "ENG-123"]]) {
        const r = run(dir, ["workos", ...args]);
        expect(r.stdout, args.join(" ")).not.toMatch(/could not be read|readable/);
      }
      expect(unreadable(dir).unreadable).toBe(0);
    }
  });

  test("no readable call matches: the line does not say there is none, and says what could not be read", () => {
    const { dir } = withRawCalls([NO_TOOL, null, OK_CALL]);
    const r = run(dir, ["workos", "--ticket", "ENG-123"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("ENG-123 has no readable call to workos");
    expect(r.stdout).toContain("among the newest 50");
    expect(r.stdout).toContain("2 recorded calls could not be read");
    expect(r.stdout).toContain("cannot say why");
    expect(r.stdout).not.toMatch(/\bhas no call\b/);
    expect(unreadable(dir, ["--ticket", "ENG-123"])).toEqual({ read: 3, limit: 50, unreadable: 2 });
    const none = withRawCalls([NO_TOOL]);
    const alone = run(none.dir, ["workos"]);
    expect(alone.stdout).toContain("there is no readable call to workos");
    expect(alone.stdout).toContain("1 recorded call could not be read");
  });

  test("no failed readable call: the line does not claim the whole window, and says what could not be read", () => {
    const { dir } = withRawCalls([NO_TOOL, OK_CALL]);
    for (const args of [[], ["--ticket", "CTC-1234"]]) {
      const r = run(dir, ["workos", ...args]);
      expect(r.status).toBe(0);
      expect(lines(r.stdout)).toHaveLength(1);
      expect(r.stdout, args.join(" ")).toContain("no failed call to workos");
      expect(r.stdout).toContain("the 1 readable of its newest 2 recorded calls");
      expect(r.stdout).toContain(new Date(OK_CALL.at).toISOString());
      expect(r.stdout).toContain("1 recorded call could not be read, so this may not be the whole picture");
      expect(r.stdout).not.toContain("in its newest 2 recorded calls");
    }
    expect(unreadable(dir)).toEqual({ read: 2, limit: 50, unreadable: 1 });
  });

  test("a failed readable call is still reported as failed, with the count beside it", () => {
    const { dir } = withRawCalls([null, "oops", DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("workos__list_users on workos failed (denied)");
    expect(r.stdout).toContain("Who can fix it: see the explanation above, which mentions a workspace admin; read it as written.");
    expect(r.stdout).toContain("2 other recorded calls could not be read, so this may not be the newest failure");
    const json = JSON.parse(run(dir, ["workos", "--ticket", "CTC-1234", "--json"]).stdout) as { verdict: string; window: unknown };
    expect(json.verdict).toBe("failed");
    expect(json.window).toEqual({ read: 3, limit: 50, unreadable: 2 });
  });
});

// Every claim in the line is read from the record by type, or hedged. These hold the claims the review of
// the line found open: what "the newest" refers to when a filter is on, and values with stray spaces.
describe("the line claims only what the record supports", () => {
  test("with a filter on, 'the newest' is the newest match, not the newest call to the server", () => {
    const otherTicketFailure = { ...DENIED_CALL, call_id: "call_other", at: OK_CALL.at + 60_000, dispatch: { ticket: "CTC-9999", phase: "plan", generation: 1 } };
    const { dir } = withCalls([otherTicketFailure, OK_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("no failed call to workos on CTC-1234");
    expect(r.stdout).toContain("the newest one that matches was ok at " + new Date(OK_CALL.at).toISOString());
    expect(r.stdout).not.toContain("CTC-9999");
    const tool = run(dir, ["workos", "--tool", "get_user"]);
    expect(tool.stdout).toContain("the newest one that matches was ok at");
    // With no filter the newest call is the newest call.
    expect(run(withCalls([OK_CALL]).dir, ["workos"]).stdout).toContain("the newest was ok at " + new Date(OK_CALL.at).toISOString());
  });

  test.each([
    ["an outcome of ' ok '", { ...OK_CALL, outcome: " ok " }, "no failed call"],
    ["an outcome with spaces around a failure", { ...DENIED_CALL, outcome: "  denied " }, "failed (denied)"],
    ["a tool name with spaces around it", { ...DENIED_CALL, tool_name: "  workos__list_users  " }, "workos__list_users on workos failed"],
    ["a recorded ticket with spaces around it", { ...DENIED_CALL, dispatch: { ticket: " CTC-1234 ", phase: " implement ", generation: 3 } }, "CTC-1234 implement: workos__list_users"],
  ])("%s is read as the value without the spaces", (_name, call, line) => {
    const { dir } = withCalls([call]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(line);
    expect(r.stdout).not.toMatch(/\( | \)/);
  });

  test("the verb's rule stands: an outcome that is neither ok nor in flight is a failure, and the line names it", () => {
    for (const outcome of ["timeout", "Pending", "PENDING", "OK", "cancelled"]) {
      const { dir } = withCalls([{ ...DENIED_CALL, outcome, denied_reason: null, explanation: null }]);
      const r = run(dir, ["workos"]);
      expect(r.stdout, outcome).toContain(`failed (${outcome})`);
      expect(r.stdout, outcome).toContain("the record gives no reason");
    }
  });

  test("an older failure is reported although the newest call was ok: the line says only that this call failed", () => {
    const { dir } = withCalls([{ ...OK_CALL, at: DENIED_CALL.at + 60_000 }, DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.stdout).toContain("workos__list_users on workos failed (denied)");
    expect(r.stdout).not.toContain("no failed call");
    expect(r.stdout).not.toMatch(/\bnewest\b/);
  });

  test("a --tool that matches several tools reports the newest failure and names the tool that failed", () => {
    const listRoles = { ...DENIED_CALL, call_id: "call_roles", tool_name: "workos__list_roles", at: DENIED_CALL.at + 1000, denied_reason: "not-granted", explanation: "Refused: no grant. A workspace admin can grant it." };
    const { dir } = withCalls([{ ...OK_CALL, tool_name: "workos__list_orgs", at: DENIED_CALL.at + 2000 }, listRoles, DENIED_CALL]);
    const r = run(dir, ["workos", "--tool", "list_"]);
    expect(r.stdout).toContain("workos__list_roles on workos failed (denied)");
    expect(r.stdout).toContain("not-granted");
    expect(r.stdout).not.toContain("workos__list_users");
  });

  test("a ticket given in another case is matched, and the line spells it as the record does", () => {
    const { dir } = withCalls([DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "ctc-1234"]);
    expect(r.stdout.startsWith("CTC-1234 implement: ")).toBe(true);
  });
});

// The verb treats ok as the only success and never classifies the rest, so the script does: ok is success, a
// small closed set of in-flight outcomes means the call has not finished, and every other outcome is a failure.
// An unfinished call is never reported as a failure, and is never the newest ok call.
describe("a call that has not finished is neither a failure nor a success", () => {
  const IN_FLIGHT = ["pending", "in_flight", "in-flight", "in_progress", "in-progress", "running", "queued", "started", "awaiting_approval", "awaiting-approval", "approval_pending"];
  const answerOf = (dir: string, args: string[]) => JSON.parse(run(dir, ["workos", ...args, "--json"]).stdout) as { verdict: string; outcome: string | null; reason: string | null; explanation: string | null; ticket: string | null };

  test.each(IN_FLIGHT)("%s alone: no failed call, and the line says it has not finished", (outcome) => {
    const { dir } = withCalls([{ ...OK_CALL, outcome }]);
    for (const args of [[], ["--ticket", "CTC-1234"]]) {
      const r = run(dir, ["workos", ...args]);
      expect(r.status).toBe(0);
      expect(lines(r.stdout)).toHaveLength(1);
      expect(r.stdout).toContain("no failed call to workos");
      expect(r.stdout).toContain(`is still ${outcome}, so it has not finished`);
      expect(r.stdout).not.toMatch(/failed \(|was ok/);
      expect(answerOf(dir, args)).toMatchObject({ verdict: "no-failure", outcome, reason: null, explanation: null });
    }
  });

  test("an outcome is trimmed before it is compared, and compared case-sensitively", () => {
    const spaced = run(withCalls([{ ...OK_CALL, outcome: "  running " }]).dir, ["workos"]);
    expect(spaced.stdout).toContain("is still running, so it has not finished");
    const upper = run(withCalls([{ ...OK_CALL, outcome: "RUNNING" }]).dir, ["workos"]);
    expect(upper.stdout).toContain("failed (RUNNING)");
  });

  test("the newest match is unfinished and an older one was ok: it is not reported as the newest ok", () => {
    const { dir } = withCalls([{ ...OK_CALL, outcome: "pending", at: OK_CALL.at + 1000 }, OK_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(r.stdout).toContain("the newest one that matches is still pending, so it has not finished");
    expect(r.stdout).not.toContain("was ok");
    expect(r.stdout).not.toContain(new Date(OK_CALL.at).toISOString());
  });

  test("an unfinished call older than an ok one does not change what the newest was", () => {
    const { dir } = withCalls([OK_CALL, { ...OK_CALL, outcome: "pending", at: OK_CALL.at - 1000 }]);
    const r = run(dir, ["workos"]);
    expect(r.stdout).toContain("the newest was ok at " + new Date(OK_CALL.at).toISOString());
    expect(r.stdout).not.toContain("pending");
  });

  test("a filter that matches only unfinished calls says they have not finished", () => {
    const { dir } = withCalls([DENIED_CALL, { ...OK_CALL, tool_name: "workos__sync", outcome: "queued" }]);
    const r = run(dir, ["workos", "--tool", "sync"]);
    expect(r.stdout).toContain("no failed call to workos matching sync");
    expect(r.stdout).toContain("the newest one that matches is still queued, so it has not finished");
  });

  test("with unreadable records too, both facts are said", () => {
    const { dir } = withRawCalls([{ ...OK_CALL, tool_name: undefined }, { ...OK_CALL, outcome: "pending" }]);
    const r = run(dir, ["workos"]);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("the 1 readable of its newest 2 recorded calls");
    expect(r.stdout).toContain("the newest readable one is still pending, so it has not finished");
    expect(r.stdout).toContain("1 recorded call could not be read, so this may not be the whole picture");
  });

  test("a failed call is still the one reported beside a newer unfinished call, and the line says the newer one has not finished", () => {
    const { dir } = withCalls([{ ...OK_CALL, outcome: "running", at: DENIED_CALL.at + 1000 }, DENIED_CALL]);
    const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain("workos__list_users on workos failed (denied)");
    expect(r.stdout).toContain("read it as written. A newer call is still running, so it has not finished.");
    expect(answerOf(dir, ["--ticket", "CTC-1234"])).toMatchObject({ verdict: "failed", outcome: "denied" });
  });

  test("no newer unfinished call, no clause about one", () => {
    const { dir } = withCalls([DENIED_CALL, { ...OK_CALL, outcome: "running", at: DENIED_CALL.at - 1000 }]);
    expect(run(dir, ["workos"]).stdout).not.toContain("has not finished");
  });
});

// A reason or an explanation can be any length. The line keeps the record's own words whole and stays one line;
// nothing is cut, so --json and the line agree.
describe("a very long explanation", () => {
  test("stays one line, verbatim, and is not truncated", () => {
    const filler = "the approval for this call expired before it ran ".repeat(400).trim();
    const explanation = `Refused: ${filler}. A workspace admin can re-approve it.`;
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    const r = run(dir, ["workos"]);
    expect(r.stdout).toMatch(ONE_LINE);
    expect(r.stdout).toContain(explanation);
    expect(r.stdout).toContain("Who can fix it: see the explanation above, which mentions a workspace admin; read it as written.");
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { explanation: string };
    expect(json.explanation).toBe(explanation);
  });

  test("beyond the 64 KiB a pipe holds, the line and the JSON are still whole", () => {
    const explanation = `Refused: ${"the approval for this call expired before it ran ".repeat(3000).trim()}. A workspace admin can re-approve it.`;
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(2 * 65536);
    expect(r.stdout).toMatch(ONE_LINE);
    expect(r.stdout).toContain(explanation);
    expect(r.stdout.endsWith("which mentions a workspace admin; read it as written.\n")).toBe(true);
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { explanation: string };
    expect(json.explanation).toBe(explanation);
  });
});

// A --ticket filter can only be answered for a call whose ticket the script can read. The route sends dispatch as
// null or as an object with a string ticket; a call with anything else may belong to the ticket, so it is counted
// as unreadable, not read as "no ticket".
describe("under --ticket, a call whose ticket cannot be read is counted and never dropped", () => {
  const WRONG: [string, unknown][] = [
    ["a number", 42], ["a boolean", true], ["an array", [1]], ["an object with a non-callable toString", { toString: 5 }],
    ["an empty object", {}], ["null", null], ["a blank string", "  "],
  ];
  const makers: [string, (bad: unknown) => unknown][] = [
    ["dispatch", (bad) => ({ ...DENIED_CALL, dispatch: bad })],
    ["dispatch.ticket", (bad) => ({ ...DENIED_CALL, dispatch: { ticket: bad, phase: "implement", generation: 3 } })],
  ];
  // dispatch null is the route's own "not dispatched", so it is the one row that is not unreadable.
  test.each(
    makers.flatMap(([field, make]) => WRONG.filter(([name]) => !(field === "dispatch" && name === "null")).map(([name, bad]) => [field, name, bad, make] as const)),
  )(
    "%s as %s",
    (_field, _name, bad, make) => {
      const { dir } = withRawCalls([make(bad), OK_CALL]);
      const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
      expect(r.status).toBe(0);
      expect(lines(r.stdout)).toHaveLength(1);
      expect(r.stdout).toContain("no failed call to workos on CTC-1234 in the 1 readable of its newest 2 recorded calls");
      expect(r.stdout).toContain("1 recorded call could not be read, so this may not be the whole picture");
      const json = JSON.parse(run(dir, ["workos", "--ticket", "CTC-1234", "--json"]).stdout) as { window: unknown };
      expect(json.window).toEqual({ read: 2, limit: 50, unreadable: 1 });
    },
  );

  test("a call with no dispatch is known to name no ticket: nothing is unreadable", () => {
    for (const dispatch of [null, undefined]) {
      const { dir } = withRawCalls([{ ...DENIED_CALL, dispatch }, OK_CALL]);
      const r = run(dir, ["workos", "--ticket", "CTC-1234"]);
      expect(r.stdout, JSON.stringify(dispatch)).toContain("in its newest 2 recorded calls");
      expect(r.stdout, JSON.stringify(dispatch)).not.toContain("could not be read");
    }
  });

  test("without --ticket the same call is explained as a failure with no ticket, and nothing is unreadable", () => {
    const { dir } = withRawCalls([{ ...DENIED_CALL, dispatch: 42 }, OK_CALL]);
    const r = run(dir, ["workos"]);
    expect(r.stdout).toContain("no ticket: workos__list_users on workos failed (denied)");
    expect(r.stdout).not.toContain("could not be read");
  });
});

describe("a read that fails", () => {
  test("CLI exit 3 (older cloud, or a name the workspace did not register) is exit 1, names the server and `catalyst mcp list`, and relays none of the CLI's own text", () => {
    const { dir } = setup({ code: 3, stderr: NEEDS_NEWER });
    const r = run(dir, ["WorkOS", "--ticket", "CTC-1234"]);
    expect(r.status).toBe(1);
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).toContain("workos");
    expect(all).toContain("catalyst mcp list");
    expect(all).not.toMatch(/tenant/i);
    expect(all).not.toMatch(/mirror/i);
  });

  test("a body that is not JSON is a failed check", () => {
    const { dir } = setup({ stdout: "this is not json" });
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not parse");
  });

  test("a machine with no customer.json is the desk's 'not connected', exit 2", () => {
    const { dir, calls } = setup({}, null);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(2);
    expect(calls()).toEqual([]);
  });
});

// The script relays none of the CLI's words: what the CLI wrote can hold a banned word, a route, an address or an
// instruction the skill must never give (check logs). Every refusal is a fixed sentence that names only the server it
// validated and the CLI's exit code.
describe("a refusal never relays a word the CLI wrote", () => {
  const DIRTY = "the tenant contract refused this key; check container logs at GET /api/v1/mcp/servers/workos/calls or https://portal.example/api/v1/x";
  const LEAKS = [/tenant/i, /container logs/i, /check .*logs/i, /\/api\//, /portal\.example/, /https?:\/\//, /refused this key/, /contract/];
  const READ = (code: number) => `could not read MCP server workos: \`catalyst mcp status workos\` refused the read (exit ${code}); run it in a terminal to see the reason.\n`;
  const clean = (r: ReturnType<typeof run>, status: number) => {
    expect(r.status).toBe(status);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(ONE_LINE);
    for (const leak of LEAKS) expect(`${r.stdout}${r.stderr}`).not.toMatch(leak);
  };

  test.each([1, 2, 4, 127])("a CLI that exits %i with those words on stderr and stdout: one fixed sentence, exit 1", (code) => {
    const { dir } = setup({ code, stderr: DIRTY, stdout: DIRTY });
    const r = run(dir, ["workos"]);
    clean(r, 1);
    expect(r.stderr).toBe(READ(code));
  });

  test("a CLI that exits 2 with a portal refusal is exit 1, not the desk's 'not connected', and relays none of its reason", () => {
    const { dir } = setup({ code: 2, stderr: PORTAL_UNAVAILABLE });
    const r = run(dir, ["workos"]);
    clean(r, 1);
    expect(r.stderr).toBe(READ(2));
    expect(r.stderr).not.toContain("app_origin_not_portal_fronted");
  });

  test("a CLI that exits 0 with an answer that is not JSON: one fixed sentence, no excerpt of the answer", () => {
    const { dir } = setup({ code: 0, stdout: DIRTY });
    const r = run(dir, ["workos"]);
    clean(r, 1);
    expect(r.stderr).toBe("could not read MCP server workos: could not parse the answer of `catalyst mcp status workos` as JSON (exit 0); run it in a terminal to see what it says.\n");
  });

  test("a CLI that exits 3: the fixed older-cloud sentence, none of the CLI's words, no route", () => {
    const { dir } = setup({ code: 3, stderr: DIRTY, stdout: DIRTY });
    const r = run(dir, ["workos"]);
    clean(r, 1);
    expect(r.stderr).not.toMatch(/\/\S/);
    expect(r.stderr).toContain("catalyst mcp list");
  });

  test("a CLI that exits 2 saying the machine is not connected: the desk's exit 2 with one fixed sentence that says how to connect", () => {
    const { dir } = setup({ code: 2, stderr: `not connected: ${DIRTY}\nrun the join command`, stdout: DIRTY });
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(ONE_LINE);
    for (const leak of LEAKS) expect(r.stderr).not.toMatch(leak);
    expect(r.stderr).toMatch(/^not connected \([^)]*\) — run: npx -p @catalyst-cloud\/cli catalyst login/);
    expect(r.stderr).not.toContain("join command");
  });

  test("a CLI error on several lines, and one far longer than a pipe holds, is still one fixed line", () => {
    const long = "the portal refused the key ".repeat(8000).trim();
    for (const stderr of ["first\n\nsecond\r\nthird", long]) {
      const { dir } = setup({ code: 1, stderr });
      const r = run(dir, ["workos"]);
      clean(r, 1);
      expect(r.stderr).toBe(READ(1));
    }
  });
});

describe("a refusal is one line on stderr, whole, and nothing on stdout", () => {
  const oneStderrLine = (r: ReturnType<typeof run>) => {
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(ONE_LINE);
  };

  test("a body that is not JSON and has line breaks in it", () => {
    const { dir } = setup({ stdout: "this is\nnot json\r\nat all" });
    const r = run(dir, ["workos"]);
    oneStderrLine(r);
    expect(r.stderr).toContain("could not parse the answer of `catalyst mcp status workos` as JSON");
    expect(r.stderr).not.toContain("this is not json");
  });

  test("a name that is not a server name and has a line break in it", () => {
    const { dir } = withCalls([]);
    const r = run(dir, ["9\n!"]);
    oneStderrLine(r);
    expect(r.stderr).toContain("is not a server name");
  });

  test("a status that is not the shape the script knows", () => {
    const { dir } = setup({ stdout: JSON.stringify({ status: {}, calls: { calls: "no" } }) });
    oneStderrLine(run(dir, ["workos"]));
  });
});

// A reader that closes early (`| head -c 20`) must not turn the script's own output into a stack trace and exit 1.
describe("a reader that closes the pipe early", () => {
  test("is not an error: exit 0, nothing on stderr", async () => {
    const { dir } = withCalls([DENIED_CALL]);
    const child = spawn(process.execPath, [script, "workos"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CATALYST_SKILLS_HOME: dir } });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.stdout.destroy();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});

describe("arguments", () => {
  test("an invalid server argument is never echoed in the refusal", () => {
    const { dir, calls } = withCalls([]);
    const r = run(dir, ["9 /admin/ tenant"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("that is not a server name (lowercase letters, digits, - and _, starting with a letter)\n");
    expect(calls()).toEqual([]);
  });

  test("a name that is not a server name is refused before the CLI runs", () => {
    const { dir, calls } = withCalls([]);
    const r = run(dir, ["9!"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a server name");
    expect(calls()).toEqual([]);
  });

  test("a missing server is refused before the CLI runs", () => {
    const { dir, calls } = withCalls([]);
    const r = run(dir, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage: node scripts/tool-call.mjs");
    expect(calls()).toEqual([]);
  });

  test("--help exits 0 and documents --ticket, --tool and --json", () => {
    const { dir, calls } = withCalls([]);
    const r = run(dir, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--ticket");
    expect(r.stdout).toContain("--tool");
    expect(r.stdout).toContain("--json");
    expect(calls()).toEqual([]);
  });
});

describe("the output never sends anyone to logs", () => {
  const LOGS = /\blogs?\b/i;
  test("not in a failed answer, an inconclusive one, a refusal or --help", () => {
    const failed = withCalls([DENIED_CALL, PROVIDER_CALL]);
    const refused = setup({ code: 3, stderr: NEEDS_NEWER });
    const outputs = [
      run(failed.dir, ["workos", "--ticket", "CTC-1234"]),
      run(failed.dir, ["workos", "--ticket", "ENG-123"]),
      run(failed.dir, ["workos"]),
      run(refused.dir, ["workos"]),
      run(failed.dir, ["--help"]),
    ];
    for (const r of outputs) {
      expect(`${r.stdout}\n${r.stderr}`).not.toMatch(LOGS);
      expect(r.stdout + r.stderr).not.toContain("Cannot find module");
    }
  });
});
