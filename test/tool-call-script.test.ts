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
const OK_CALL = {
  call_id: "call_01HZW", key_id: "key_01HZX", user_id: null, tool_name: "workos__get_user",
  outcome: "ok", denied_reason: null, approval_state: "not-required", latency_ms: 212,
  bytes_in: 1301, bytes_out: 2048, at: 1792230063000,
  dispatch: { ticket: "CTC-1234", phase: "implement", generation: 3 }, explanation: null,
};
const EXPIRED = "Refused: the approval for this call expired before it ran. A workspace admin can re-approve it on the account's Connections page.";
const DENIED_CALL = {
  ...OK_CALL, call_id: "call_01HZX", tool_name: "workos__list_users", outcome: "denied",
  denied_reason: "approval-expired", approval_state: "missing-or-invalid", latency_ms: 14,
  bytes_in: 0, bytes_out: 0, at: 1792229575000,
  explanation: EXPIRED,
};
const PROVIDER_EXPLANATION = "The server failed or refused the call. Retry, or read the server's status.";
const PROVIDER_CALL = {
  ...OK_CALL, call_id: "call_01HZY", tool_name: "workos__get_roles", outcome: "provider_error",
  latency_ms: 1803, at: 1792229412000, dispatch: null,
  explanation: PROVIDER_EXPLANATION,
};

type Call = typeof OK_CALL | typeof DENIED_CALL | typeof PROVIDER_CALL;
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

const lines = (s: string) => s.trimEnd().split("\n");

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
      window: { read: 3, limit: 50 },
      verdict: "failed",
    });
  });
});

describe("who can fix it", () => {
  test("an explanation that names no one gets the labelled fallback, not an invented actor", () => {
    const { dir } = withCalls([PROVIDER_CALL]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "the record names no one; a workspace owner or admin manages this workspace's MCP servers",
    );
    const json = JSON.parse(run(dir, ["workos", "--json"]).stdout) as { fixer: { named: boolean; who: string | null } };
    expect(json.fixer.named).toBe(false);
  });

  test.each([
    ["Ask your workspace owner to reconnect it.", "your workspace owner"],
    ["An operator can lift the hold.", "an operator"],
    ["A workspace owner or admin can approve it.", "a workspace owner or admin"],
    ["Ask the account admin.", "the account admin"],
    ["Only an owner can re-grant it.", "an owner"],
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
    expect(json.window).toEqual({ read: 3, limit: 50 });
  });

  test("a server with no recorded calls is inconclusive too", () => {
    const { dir } = withCalls([]);
    const r = run(dir, ["workos"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cannot say why");
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
