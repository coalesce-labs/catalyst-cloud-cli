import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { main, usageText } from "../src/cli";
import { renderServerStatus } from "../src/mcp-status";
import { readManifest, saveConfig } from "../src/config";
import { buildFixtureContract } from "./fixture-contract";
import { makeCtx, tempHome } from "./helpers";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const input = { name: "linear", url: "https://mcp.linear.app/mcp", auth: { kind: "bearer", secretName: "LINEAR_API_KEY" } };
const server = { id: "srv-1", ...input, status: "pending" };

function setup(body: unknown = { outcome: "registered", server }, status = 201, withRoutes = true) {
  const home = tempHome();
  homes.push(home);
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  const doc = buildFixtureContract();
  if (withRoutes) doc.routes = [...doc.routes,
    { method: "GET", path: "/api/v1/agent/portal-servers", takesWriteBudgetUnit: false, since: "1.18.0" },
    { method: "POST", path: "/api/v1/agent/portal-servers/register", takesWriteBudgetUnit: false, since: "1.18.0" },
    { method: "POST", path: "/api/v1/agent/portal-servers/remove", takesWriteBudgetUnit: false, since: "1.18.0" },
  ];
  const ctx = makeCtx(home, { fetch: async (target, init) => {
    const url = String(target);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, headers: new Headers(init?.headers) });
    if (url.endsWith("/agent/contract")) return Response.json(doc, { headers: { etag: '"mcp"' } });
    return Response.json(body, { status });
  } });
  saveConfig(home, { baseUrl: "https://cloud.example", key: "ctc_acct_test", account: "tenant-test", slug: "test", name: "Test", permissions: ["mirror:read", "mirror:write"], principal: "service", joinedAt: "2026-09-23T00:00:00Z", lastSkillBundleVersion: readManifest().version });
  return { ctx, calls };
}

describe("catalyst-skills mcp", () => {
  it("registers a bearer reference and explains pending approval", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--bearer", "LINEAR_API_KEY"], ctx)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "POST", body: input });
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer ctc_acct_test");
    expect(ctx.out.join(" ")).toContain("waiting for admin approval");
    expect(ctx.out.join(" ")).toContain("srv-1");
  });

  it("shows catalog readiness and preserves machine-readable server status", async () => {
    const { ctx } = setup({ outcome: "registered", server: { ...server, status: "ready" } });
    expect(await main(["mcp", "add", "catalog", "--url", input.url, "--auth", "none", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "{}").server.status).toBe("ready");
  });

  it("passes a header bundle as named references", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "hyperdx", "--url", "https://hyperdx.example/mcp", "--header", "CF-Access-Client-Id=ACCESS_ID", "--header", "CF-Access-Client-Secret=ACCESS_SECRET", "--header", "Authorization=HYPERDX_AUTH"], ctx)).toBe(0);
    expect(calls[1]?.body).toMatchObject({ auth: { kind: "headers", headers: [
      { name: "CF-Access-Client-Id", secretName: "ACCESS_ID" },
      { name: "CF-Access-Client-Secret", secretName: "ACCESS_SECRET" },
      { name: "Authorization", secretName: "HYPERDX_AUTH" },
    ] } });
  });

  it("lists metadata and removes by name through the SDK", async () => {
    const a = setup({ outcome: "ok", servers: [server] }, 200);
    expect(await main(["mcp", "list"], a.ctx)).toBe(0);
    expect(a.calls[1]?.method).toBe("GET");
    expect(a.ctx.out.join(" ")).toContain(input.url);
    expect(a.ctx.out.join(" ")).toContain("LINEAR_API_KEY");
    expect(a.ctx.out.join(" ")).toContain("waiting for admin approval");
    const b = setup({ outcome: "removed", removed: false }, 200);
    expect(await main(["mcp", "remove", "linear", "--json"], b.ctx)).toBe(0);
    expect(b.calls[1]?.body).toEqual({ name: "linear" });
    expect(JSON.parse(b.ctx.out[0] ?? "{}")).toMatchObject({ outcome: "removed", removed: false });
  });

  it("names a missing secret and returns a failure exit", async () => {
    const { ctx } = setup({ error: "secret_not_found", reason: "vault secret NOPE is absent" }, 400);
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--bearer", "NOPE"], ctx)).toBe(2);
    expect(ctx.err.join(" ")).toContain("NOPE");
    expect(ctx.out).toHaveLength(0);
  });

  it("does not write when the cloud does not advertise the route", async () => {
    const { ctx, calls } = setup({}, 200, false);
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--auth", "none"], ctx)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(ctx.err.join(" ")).toContain("portal-servers/register");
  });

  it.each([
    ["--bearer", "literal-secret-with-dashes"],
    ["--bearer", "KEY", "--auth", "none"],
    ["--header", "X-Key=KEY", "--header", "x-key=OTHER"],
    ["--header", "Host=HOST"],
    ["--header", "Proxy-Authorization=KEY"],
    ["--header", "Connection=KEY"],
    ["--header", "Transfer-Encoding=KEY"],
    ["--header", "Content-Length=KEY"],
  ])("refuses unsafe or conflicting auth before a request: %j", async (...flags) => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "linear", "--url", input.url, ...flags], ctx)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(ctx.err.join(" ")).not.toContain("literal-secret-with-dashes");
  });

  it.each([
    ["mcp", "list", "extra"],
    ["mcp", "list", "--bearer", "KEY"],
    ["mcp", "remove"],
    ["mcp", "remove", "linear", "--url", input.url],
    ["mcp", "add", "linear", "--url", "https://user:secret@example.com", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/#secret", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "http://example.com", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/?user_id=someone", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/?", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/#", "--auth", "none"],
  ])("rejects invalid command input before any request: %j", async (...argv) => {
    const { ctx, calls } = setup();
    expect(await main(argv, ctx)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("documents all four verbs", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "--help"], ctx)).toBe(0);
    expect(ctx.out.join(" ")).toContain("mcp <add");
    expect(ctx.out.join(" ")).toContain("status <name>");
    expect(ctx.out.join(" ")).toContain("--header");
    expect(calls).toHaveLength(0);
  });
  it("does not describe an egress-held custom server as ready", async () => {
    const { ctx } = setup({ outcome: "ok", servers: [{ ...server, status: "pending_egress_guard" }] }, 200);
    expect(await main(["mcp", "list"], ctx)).toBe(0);
    expect(ctx.out.join(" ")).toContain("waiting for public egress guard");
    expect(ctx.out.join(" ")).not.toContain(": ready");
  });

});

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
const DENIED_CALL = {
  ...OK_CALL, call_id: "call_01HZX", tool_name: "workos__list_users", outcome: "denied",
  denied_reason: "approval-expired", approval_state: "missing-or-invalid", latency_ms: 14,
  bytes_in: 0, bytes_out: 0, at: 1792229575000,
  explanation: "Refused: the approval for this call expired before it ran. A workspace admin can re-approve it on the account's Connections page.",
};
const PROVIDER_CALL = {
  ...OK_CALL, call_id: "call_01HZY", tool_name: "workos__get_roles", outcome: "provider_error",
  latency_ms: 1803, at: 1792229412000, dispatch: null,
  explanation: "The server failed or refused the call. Retry, or read the server's status.",
};
const CALLS = { server: "workos", calls: [OK_CALL, DENIED_CALL, PROVIDER_CALL] };

function statusSetup(options: { portal?: { url: string | null; unavailable?: string | null } | null; status?: [number, unknown]; calls?: [number, unknown] } = {}) {
  const home = tempHome();
  homes.push(home);
  const requests: string[] = [];
  const doc = { ...buildFixtureContract(), portal: "portal" in options ? options.portal : { url: "https://cloud.example/mcp/test" } };
  const ctx = makeCtx(home, { fetch: async (target, init) => {
    const url = new URL(String(target));
    requests.push(`${init?.method ?? "GET"} ${url} ${new Headers(init?.headers).get("authorization")}`);
    if (url.pathname.endsWith("/agent/contract")) return Response.json(doc, { headers: { etag: '"status"' } });
    const response = url.pathname.endsWith("/servers/workos/status") ? options.status ?? [200, STATUS]
      : url.pathname.endsWith("/servers/workos/calls") ? options.calls ?? [200, CALLS] : undefined;
    if (!response) throw new Error(`unexpected request: ${url}`);
    return Response.json(response[1], { status: response[0] });
  } });
  saveConfig(home, { baseUrl: "https://cloud.example", key: "ctc_acct_test", account: "tenant-test", slug: "deliberately-not-the-portal", name: "Test", permissions: ["portal:access"], principal: "service", joinedAt: "2026-09-23T00:00:00Z", lastSkillBundleVersion: readManifest().version });
  return { ctx, requests, doc };
}

describe("catalyst mcp status", () => {
  it("reads status and the last 50 calls under the contract's portal.url, with the login's bearer", async () => {
    const { ctx, requests } = statusSetup();
    expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(0);
    expect(requests.slice(1).sort()).toEqual([
      "GET https://cloud.example/mcp/test/servers/workos/calls?limit=50 Bearer ctc_acct_test",
      "GET https://cloud.example/mcp/test/servers/workos/status Bearer ctc_acct_test",
    ]);
  });

  it("--json prints the two route bodies verbatim: out.status equals the status body, out.calls the calls body", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0] ?? "null")).toEqual({ status: STATUS, calls: CALLS });
    expect(ctx.err).toEqual([]);
  });

  it("--json passes fields this CLI does not know straight through", async () => {
    const status = { ...STATUS, future_field: { live: true } };
    const calls = { ...CALLS, future_field: 3, calls: [{ ...OK_CALL, future_field: [1, 2] }] };
    const { ctx } = statusSetup({ status: [200, status], calls: [200, calls] });
    expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "null")).toEqual({ status, calls });
  });

  it("--json exits 0 when a reported call failed", async () => {
    const { ctx } = statusSetup({ calls: [200, { server: "workos", calls: [DENIED_CALL] }] });
    expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "null").calls.calls[0].outcome).toBe("denied");
  });

  it("a contract with no portal.url refuses with exit 3, after exactly one revalidation, and never calls the portal", async () => {
    const { ctx, requests } = statusSetup({ portal: undefined });
    for (let run = 0; run < 2; run++) {
      requests.length = 0;
      expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(3);
      expect(requests).toEqual(["GET https://cloud.example/api/v1/agent/contract Bearer ctc_acct_test"]);
      expect(ctx.out).toEqual([]);
      expect(ctx.err.join("\n")).toContain("portal.url");
    }
  });

  it("a current cloud with portal.url null names the unavailable reason instead of asking for an upgrade", async () => {
    const { ctx, requests } = statusSetup({ portal: { url: null, unavailable: "app_origin_not_portal_fronted" } });
    expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("app_origin_not_portal_fronted");
    expect(ctx.err.join("\n")).not.toContain("newer Catalyst Cloud");
    expect(requests).toEqual(["GET https://cloud.example/api/v1/agent/contract Bearer ctc_acct_test"]);
    expect(ctx.out).toEqual([]);
  });

  it("a portal.url on another origin is refused before any portal request", async () => {
    const { ctx, requests } = statusSetup({ portal: { url: "https://evil.example/mcp/test" } });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("https://evil.example");
    expect(ctx.err.join("\n")).toContain("https://cloud.example");
    // The contract read is the only request: nothing reached the other origin.
    expect(requests).toEqual(["GET https://cloud.example/api/v1/agent/contract Bearer ctc_acct_test"]);
    expect(ctx.out).toEqual([]);
  });

  it("a portal.url that is not a URL is a contract-shape refusal", async () => {
    const { ctx, requests } = statusSetup({ portal: { url: "not a URL" } });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("portal.url is not a URL");
    expect(requests).toHaveLength(1);
    expect(ctx.out).toEqual([]);
  });

  it.each([ ["calls", "recent tool calls"], ["status", "MCP server status"] ] as const)(
    "a 404 on the %s route says the cloud is older, naming %s", async (route, label) => {
      const { ctx } = statusSetup({ [route]: [404, { error: "not_found" }] });
      expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(3);
      expect(ctx.out).toEqual([]);
      expect(ctx.err.join("\n")).toContain(`${label} for workos needs a newer Catalyst Cloud`);
    });

  it("a 403 names the portal's key rule and the refusal's reason, not the host/person rule", async () => {
    const { ctx } = statusSetup({ status: [403, { error: "forbidden", reason: "missing-scope" }] });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("portal:access");
    expect(ctx.err.join("\n")).toContain("missing-scope");
    expect(ctx.err.join("\n")).not.toContain("acts as a host");
    expect(ctx.out).toEqual([]);
  });

  it.each([{ server: "workos" }, { state: "ready" }, [], null])(
    "a status body without server and state is a shape error: %j", async (body) => {
      const { ctx } = statusSetup({ status: [200, body] });
      expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(2);
      expect(ctx.out).toEqual([]);
      expect(ctx.err.join("\n")).toContain("/status returned an unexpected shape");
    });

  it.each([{ server: "workos" }, { calls: [] }, { server: "workos", calls: {} }])(
    "a calls body without a server and calls array is a shape error: %j", async (body) => {
      const { ctx } = statusSetup({ calls: [200, body] });
      expect(await main(["mcp", "status", "workos", "--json"], ctx)).toBe(2);
      expect(ctx.out).toEqual([]);
      expect(ctx.err.join("\n")).toContain("/calls returned an unexpected shape");
    });

  it.each([
    ["mcp", "status"], ["mcp", "status", "workos", "extra"], ["mcp", "status", "WorkOS"],
    ["mcp", "status", "../x"], ["mcp", "status", "workos", "--url", "https://x.example"],
    ["mcp", "status", "workos", "--bearer", "KEY"], ["mcp", "status", "workos", "--auth", "none"],
    ["mcp", "status", "workos", "--header", "X-Key=KEY"], ["mcp", "status", "workos", "--limit", "10"],
  ])("rejects invalid status input before any request: %j", async (...argv) => {
    const { ctx, requests } = statusSetup();
    expect(await main(argv, ctx)).toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("catalyst mcp status human output", () => {
  it("prints the server's status, auth kind, grant health and tool count, then one line per call", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out.slice(0, 6)).toEqual([
      "workos — ready", "  workos answered and lists 12 tools.", "auth: bearer",
      "tools: 12 offered, 12 in catalog",
      "grants for this key: 3 of 12 (missing: workos__list_users, workos__get_roles)",
      "last 3 calls (newest first, up to 50):",
    ]);
    expect(ctx.out.slice(6)).toHaveLength(3);
    for (const [index, call] of CALLS.calls.entries()) {
      const line = ctx.out[index + 6];
      expect(line).toContain(new Date(call.at).toISOString());
      expect(line).toContain(call.outcome);
      expect(line).toContain(call.tool_name);
      expect(line).toContain(`${call.latency_ms}ms`);
      if (call.dispatch) expect(line).toContain("CTC-1234 implement");
    }
  });

  it("a failed call's own line names the reason the portal recorded and its explanation, and the read exits 0", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    const lines = ctx.out.filter((line) => line.includes("CTC-1234") && line.includes("denied"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`approval-expired: ${DENIED_CALL.explanation}`);
  });

  it("a failure with no denied_reason ends with the explanation alone", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    const line = ctx.out.find((line) => line.includes("provider_error"));
    expect(line?.endsWith(`  ${PROVIDER_CALL.explanation}`)).toBe(true);
    expect(line).not.toContain("null");
    expect(line).not.toContain(": ");
  });

  it("a call made without a phase credential shows - for ticket and phase", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out.find((line) => line.includes("provider_error"))).toMatch(/1803ms  - +The server/);
  });

  it("an ok call's line ends after its phase", async () => {
    const { ctx } = statusSetup();
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    const line = ctx.out.find((line) => line.includes(OK_CALL.tool_name));
    expect(line?.endsWith("CTC-1234 implement")).toBe(true);
    expect(line).toBe(line?.trimEnd());
    expect(line).not.toContain(": ");
  });

  it("an unregistered server with no calls prints the not-reported lines and exits 0", async () => {
    const { ctx } = statusSetup({ status: [200, { server: "workos", state: "not_registered", detail: "workos is not registered for this account." }], calls: [200, { server: "workos", calls: [] }] });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      "workos — not_registered", "  workos is not registered for this account.",
      "auth: not reported (no registration)", "tools: not reported (not_registered)",
      "grants for this key: not reported (no registration)", "No tool calls recorded for workos.",
    ]);
  });

  it("a registered server with zero calls says no tool calls are recorded", async () => {
    const { ctx } = statusSetup({ calls: [200, { server: "workos", calls: [] }] });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out).toContain("auth: bearer");
    expect(ctx.out.at(-1)).toBe("No tool calls recorded for workos.");
  });

  it("names tools missing upstream", async () => {
    const { ctx } = statusSetup({ status: [200, { ...STATUS, tools: { ...STATUS.tools, missing_upstream: ["workos__old_tool"] } }] });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out).toContain("tools: 12 offered, 12 in catalog (missing upstream: workos__old_tool)");
  });

  it("prints 50 calls as 50 lines in the route's order", async () => {
    const calls = Array.from({ length: 50 }, (_, index) => ({ ...OK_CALL, tool_name: `workos__call_${index}`, at: OK_CALL.at - index * 1000 }));
    const { ctx } = statusSetup({ calls: [200, { server: "workos", calls }] });
    expect(await main(["mcp", "status", "workos"], ctx)).toBe(0);
    expect(ctx.out[5]).toBe("last 50 calls (newest first, up to 50):");
    expect(ctx.out.slice(6)).toHaveLength(50);
    for (const [index, call] of calls.entries()) {
      expect(ctx.out[index + 6]).toContain(`${call.tool_name} `);
      expect(ctx.out[index + 6]).toContain(new Date(call.at).toISOString());
    }
  });

  it("never throws on a status with only server and state, or a call with a non-numeric at or latency", () => {
    const lines = renderServerStatus({ server: "x", state: "unreachable" }, [{ ...OK_CALL, at: "bad", latency_ms: null }]);
    expect(lines).toContain("tools: not reported (unreachable)");
    expect(lines.at(-1)).toMatch(/^  \?  ok  workos__get_user  \?ms  CTC-1234 implement$/);
  });

  it("aligns the outcome, tool, duration and ticket columns", () => {
    const lines = renderServerStatus(STATUS, CALLS.calls).slice(6);
    expect(new Set(lines.map((line) => line.indexOf("workos__"))).size).toBe(1);
    expect(new Set(lines.map((line) => line.indexOf("ms"))).size).toBe(1);
    expect(new Set(lines.map((line, index) => line.indexOf(index === 2 ? "- " : "CTC-1234"))).size).toBe(1);
    expect(new Set(lines.map((line, index) => line.indexOf(CALLS.calls[index]?.outcome ?? "missing"))).size).toBe(1);
  });

  it("prints credentials by their field name and treats omitted missing lists as empty", () => {
    const lines = renderServerStatus({ server: "x", state: "new_state", credentials: ["KEY"], auth: "headers", tools: { offered: 1, catalog: 1 }, grants: { granted: 1, cataloged: 1 } }, []);
    expect(lines).toContain("x — new_state");
    expect(lines).toContain("credentials: KEY");
    expect(lines).toContain("tools: 1 offered, 1 in catalog");
    expect(lines).toContain("grants for this key: 1 of 1");
  });
});

it("the top-level usage names mcp status", () => {
  expect(usageText()).toContain("mcp status <name>");
});
