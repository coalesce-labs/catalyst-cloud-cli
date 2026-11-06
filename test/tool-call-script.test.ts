// tool-call-script.test.ts — CTC-6104: "why did the WorkOS call on ENG-123 fail?" is answered in one
// line from the portal's own record, read through `catalyst mcp status <server> --json` and nothing
// else. Modelled on snapshot-script.test.ts: a real `node` process, a home holding a customer.json,
// and a stand-in CLI at the recorded cliPath that records its argv and answers the verb with a
// configurable JSON body, exit code and stderr.
//
// The call shapes are copied field for field from test/mcp.test.ts (the real route bodies), so the
// script is held to the shape the verb prints.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
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
      "process.exit(answer.code ?? 0);",
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
    expect(line).toContain("Who can fix it: a workspace admin.");
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
      fixer: { named: true, who: "a workspace admin" },
      window: { read: 3, limit: 50, unreadable: 0 },
      verdict: "failed",
    });
  });
});

describe("who can fix it", () => {
  test("no explanation at all gets the labelled fallback, not an invented actor", () => {
    for (const explanation of [null, undefined, "", "   "]) {
      const { dir } = withRawCalls([{ ...PROVIDER_CALL, explanation }]);
      const r = run(dir, ["workos"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        "Who can fix it: the record names no one; a workspace owner or admin manages this workspace's MCP servers.",
      );
      const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { fixer: { named: boolean; who: string | null } };
      expect(json.fixer).toEqual({ named: false, who: null });
    }
  });

  const UNNAMED = "Who can fix it: the explanation does not name one.";
  const whoSays = (explanation: string) => {
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    const r = run(dir, ["workos"]);
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { fixer: { named: boolean; who: string | null } };
    return { r, json };
  };

  test("an explanation that names no role says so, and adds no pointer the explanation may contradict", () => {
    const { dir } = withCalls([PROVIDER_CALL]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(PROVIDER_EXPLANATION);
    expect(r.stdout).toContain(UNNAMED);
    expect(r.stdout).not.toContain("manages this workspace");
    expect(r.stdout).not.toContain("the record names no one");
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { fixer: { named: boolean; who: string | null } };
    expect(json.fixer).toEqual({ named: false, who: null });
  });

  // A role is named only on an affirmative statement about it. A negation or a restriction anywhere in the
  // sentence, or in any sentence that mentions the role, means the explanation does not say it can fix this.
  test.each([
    ["cannot, then only the provider", "A workspace admin cannot fix this; only the provider can restore the service."],
    ["can't", "A workspace admin can't fix this."],
    ["a curly apostrophe", "A workspace admin can\u2019t fix this."],
    ["only if", "A workspace admin can fix this only if the provider restores the service first."],
    ["unless", "A workspace admin can approve it unless the provider has blocked the key."],
    ["no one", "No one can fix this from here; a workspace admin can only wait."],
    ["no admin", "No workspace admin can fix this."],
    ["unable", "A workspace admin is unable to fix this."],
    ["neither nor", "Neither an owner nor an admin can fix this."],
    ["do not ask", "Do not ask a workspace admin; ask the provider instead."],
    ["a role mentioned in passing", "The approval page is managed by a workspace admin."],
    ["a negated sentence anywhere vetoes the role", "A workspace admin can re-approve it. A workspace admin cannot grant new tools."],
    ["the same role under another name is vetoed too", "A workspace admin cannot fix this. Ask your admin."],
    ["one negation covers the whole sentence", "A workspace admin cannot fix this, but an operator can."],
  ])("never names a role the explanation negates or restricts: %s", (_why, explanation) => {
    const { r, json } = whoSays(explanation);
    expect(r.status).toBe(0);
    expect(lines(r.stdout)).toHaveLength(1);
    expect(r.stdout).toContain(UNNAMED);
    expect(r.stdout).not.toMatch(/Who can fix it: (?:an?|the|your) (?:workspace |account )?(?:owner|admin|operator)/);
    expect(json.fixer).toEqual({ named: false, who: null });
  });

  test.each([
    ["Ask your workspace owner to reconnect it.", "your workspace owner"],
    ["An operator can lift the hold.", "an operator"],
    ["A workspace owner or admin can approve it.", "a workspace owner or admin"],
    ["Ask the account admin.", "the account admin"],
    ["Only an owner can re-grant it.", "an owner"],
    ["Contact your workspace admin to re-approve it.", "your workspace admin"],
    ["The workspace owner must reconnect the server.", "the workspace owner"],
    ["An owner or admin can approve it.", "an owner or admin"],
    ["A workspace admin needs to re-approve it.", "a workspace admin"],
    ["A workspace admin is able to fix this.", "a workspace admin"],
    ["Have an admin re-approve it.", "an admin"],
    ["The approval was not granted. A workspace admin can grant it.", "a workspace admin"],
    ["The key is not granted; a workspace admin can grant it.", "a workspace admin"],
  ])("takes the actor the explanation names: %s", (explanation, who) => {
    const { dir } = withCalls([{ ...DENIED_CALL, explanation }]);
    const r = run(dir, ["workos", "--json"]);
    const out = JSON.parse(r.stdout) as { fixer: { named: boolean; who: string } };
    expect(out.fixer).toEqual({ named: true, who });
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
  interface Out { server: string; ticket: string | null; phase: string | null; tool: string | null; outcome: string | null; reason: string | null; explanation: string | null; at: string | null; fixer: { named: boolean; who: string | null }; window: { read: number; limit: number; unreadable: number }; verdict: string }
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
    ["explanation", (bad) => ({ ...DENIED_CALL, explanation: bad }), { explanation: null, fixer: { named: false, who: null } }],
    ["dispatch", (bad) => ({ ...DENIED_CALL, dispatch: bad }), { ticket: null, phase: null }],
    ["dispatch.ticket", (bad) => ({ ...DENIED_CALL, dispatch: { ticket: bad, phase: "implement", generation: 3 } }), { ticket: null }],
    ["dispatch.phase", (bad) => ({ ...DENIED_CALL, dispatch: { ticket: "CTC-1234", phase: bad, generation: 3 } }), { phase: null }],
    ["at", (bad) => ({ ...DENIED_CALL, at: bad }), { at: null }],
  ];
  const EXPECTED: Out = {
    server: "workos", ticket: "CTC-1234", phase: "implement", tool: "workos__list_users", outcome: "denied", reason: "approval-expired",
    explanation: EXPIRED, at: new Date(DENIED_CALL.at).toISOString(), fixer: { named: true, who: "a workspace admin" },
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
    expect(r.stdout).toContain("Who can fix it: a workspace admin.");
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

  test("the verb's rule stands: any outcome but ok is a failure, and the line names the outcome", () => {
    const { dir } = withCalls([{ ...DENIED_CALL, outcome: "pending", denied_reason: null, explanation: null }]);
    const r = run(dir, ["workos"]);
    expect(r.stdout).toContain("failed (pending)");
    expect(r.stdout).toContain("the record gives no reason");
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

  test("CLI exit 2 with a portal refusal is exit 1, not the desk's 'not connected', and carries the CLI's reason", () => {
    const { dir } = setup({ code: 2, stderr: PORTAL_UNAVAILABLE });
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(1);
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).toContain("could not read MCP server workos");
    expect(all).toContain("app_origin_not_portal_fronted");
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

describe("arguments", () => {
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
