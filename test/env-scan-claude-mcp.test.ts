import { describe, expect, it } from "vitest";
import { claudeHeaderLiterals, mcpServerToml, scanClaudeMcp } from "../src/env/scan-claude-mcp.js";
import { validateFullSettings } from "../vendor/settings/index.js";
import { claudeJson, SENTINEL } from "./env-machine-fixture.js";

const ROOT = "/home/dev/src/app";
const LITERAL = `${SENTINEL}_literal_header_token`;

function http(headers: Record<string, unknown> | undefined, url = "https://mcp.example.com/mcp"): Record<string, unknown> {
  return { type: "http", url, ...(headers === undefined ? {} : { headers }) };
}

function scanOf(servers: Record<string, unknown>, declared: string[] = []) {
  return scanClaudeMcp(JSON.stringify({ mcpServers: servers }), [ROOT], new Set(declared));
}

describe("scanClaudeMcp", () => {
  it("drafts the 3 HTTP servers from top-level mcpServers and projects[<repo path>].mcpServers; local wins a name clash", () => {
    const scan = scanClaudeMcp(claudeJson(ROOT), [ROOT], new Set());
    expect(scan.servers.map(({ name, scope }) => [name, scope])).toEqual([["context7", "user"], ["exa", "user"], ["linear", "project"]]);
    expect(scan.notDrafted).toEqual([{ name: "local-tool", reason: "a stdio server runs a command on this computer" }]);
    const clash = JSON.stringify({
      mcpServers: { linear: http({ Authorization: "Bearer ${USER_LINEAR}" }) },
      projects: { [ROOT]: { mcpServers: { linear: http({ Authorization: "Bearer ${LOCAL_LINEAR}" }) } } },
    });
    const local = scanClaudeMcp(clash, [ROOT], new Set());
    expect(local.servers).toHaveLength(1);
    expect(local.servers[0]!.scope).toBe("project");
    expect(local.servers[0]!.headers).toEqual({ Authorization: "Bearer $LOCAL_LINEAR" });
  });

  it("looks up the project entry under both the given root and its realpath", () => {
    const text = JSON.stringify({ projects: { "/real/app": { mcpServers: { linear: http({ Authorization: "Bearer ${LINEAR_API_KEY}" }) } } } });
    expect(scanClaudeMcp(text, ["/link/app"], new Set()).servers).toHaveLength(0);
    expect(scanClaudeMcp(text, ["/link/app", "/real/app"], new Set()).servers.map(({ name }) => name)).toEqual(["linear"]);
  });

  it("turns `Bearer ${NAME}` into `Bearer $NAME` and `${NAME}` / `${NAME:-default}` into `$NAME`, and lists NAME in references", () => {
    const scan = scanOf({
      a: http({ Authorization: "Bearer ${A_TOKEN}" }),
      b: http({ "X-Api-Key": "${B_KEY:-fallback-value}" }),
      c: http({ "X-Api-Key": "$C_KEY" }),
    });
    expect(scan.servers.map(({ headers }) => headers)).toEqual([
      { Authorization: "Bearer $A_TOKEN" },
      { "X-Api-Key": "$B_KEY" },
      { "X-Api-Key": "$C_KEY" },
    ]);
    expect(scan.servers.map(({ references }) => references)).toEqual([["A_TOKEN"], ["B_KEY"], ["C_KEY"]]);
    expect(JSON.stringify(scan)).not.toContain("fallback-value");
  });

  it("derives <SERVER>_MCP_TOKEN for a literal Bearer Authorization, <SERVER>_MCP_AUTHORIZATION for another literal Authorization, <SERVER>_MCP_<HEADER> for other literal headers", () => {
    const scan = scanOf({
      exa: http({ Authorization: `Bearer ${LITERAL}` }),
      basic: http({ Authorization: `Basic ${LITERAL}` }),
      "my-api": http({ "X-Api-Key": LITERAL }),
    });
    expect(scan.servers.map(({ name, headers, derived }) => ({ name, headers, derived }))).toEqual([
      { name: "basic", headers: { Authorization: "$BASIC_MCP_AUTHORIZATION" }, derived: [{ variable: "BASIC_MCP_AUTHORIZATION", header: "Authorization", bearer: false }] },
      { name: "exa", headers: { Authorization: "Bearer $EXA_MCP_TOKEN" }, derived: [{ variable: "EXA_MCP_TOKEN", header: "Authorization", bearer: true }] },
      { name: "my-api", headers: { "X-Api-Key": "$MY_API_MCP_X_API_KEY" }, derived: [{ variable: "MY_API_MCP_X_API_KEY", header: "X-Api-Key", bearer: false }] },
    ]);
  });

  it("skips a server whose derived name collides with an already-declared name", () => {
    const scan = scanOf({ exa: http({ Authorization: `Bearer ${LITERAL}` }) }, ["EXA_MCP_TOKEN"]);
    expect(scan.servers).toEqual([]);
    expect(scan.notDrafted[0]!.name).toBe("exa");
    expect(scan.notDrafted[0]!.reason).toContain("EXA_MCP_TOKEN, is already declared");
  });

  it.each([false, true])("refuses a literal that collides with another header's reference regardless of header order (%s)", (referenceFirst) => {
    const literal = { Authorization: `Bearer ${LITERAL}` };
    const reference = { "X-Api-Key": "${SHARED_MCP_TOKEN}" };
    const headers = referenceFirst ? { ...reference, ...literal } : { ...literal, ...reference };
    const text = JSON.stringify({ mcpServers: { shared: http(headers) } });
    const scan = scanClaudeMcp(text, [ROOT], new Set());
    expect(scan.servers).toEqual([]);
    expect(scan.notDrafted).toEqual([{ name: "shared", reason: expect.stringContaining("SHARED_MCP_TOKEN, is already declared") }]);
    expect(claudeHeaderLiterals(text, [ROOT], new Set(["SHARED_MCP_TOKEN"])).size).toBe(0);
  });

  it("does not draft stdio, sse, header-less http, query/userinfo/fragment URLs, localhost/loopback/private/.local hosts, mixed headers, lowercase ${name} references, or more than 32 headers; each appears in notDrafted with its reason", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-H${i}`, `\${H${i}}`]));
    const scan = scanOf({
      stdio: { command: "npx", args: ["x"] },
      old: { type: "sse", url: "https://old.example.com/sse", headers: { Authorization: "Bearer ${OLD}" } },
      notion: http(undefined, "https://mcp.notion.com/mcp"),
      query: http({ Authorization: "Bearer ${Q}" }, "https://mcp.example.com/mcp?api_key=abc"),
      userinfo: http({ Authorization: "Bearer ${Q}" }, "https://user:pass@mcp.example.com/mcp"),
      fragment: http({ Authorization: "Bearer ${Q}" }, "https://mcp.example.com/mcp#x"),
      devtools: http({ Authorization: "Bearer ${Q}" }, "http://localhost:3000/mcp"),
      loopback: http({ Authorization: "Bearer ${Q}" }, "https://127.0.0.1/mcp"),
      private: http({ Authorization: "Bearer ${Q}" }, "https://192.168.1.10/mcp"),
      lan: http({ Authorization: "Bearer ${Q}" }, "https://printer.local/mcp"),
      ten: http({ Authorization: "Bearer ${Q}" }, "https://10.0.0.2/mcp"),
      ula: http({ Authorization: "Bearer ${Q}" }, "https://[fd00::1]/mcp"),
      plainhttp: http({ Authorization: "Bearer ${Q}" }, "http://mcp.example.com/mcp"),
      bar: http({ "X-Key": "key-${X}" }),
      lower: http({ "X-Key": "${lower_name}" }),
      many: http(many),
      ws: { type: "ws", url: "wss://mcp.example.com" },
    });
    expect(scan.servers).toEqual([]);
    const reasons = Object.fromEntries(scan.notDrafted.map(({ name, reason }) => [name, reason]));
    expect(reasons).toEqual({
      bar: "a header mixes text and a variable",
      devtools: "it points at this computer or a private network",
      fragment: "its URL carries a query string or sign-in details; add it by hand",
      lan: "it points at this computer or a private network",
      loopback: "it points at this computer or a private network",
      lower: "a header references a variable whose name is not upper-case",
      many: "it has more than 32 headers",
      notion: "no header auth; it likely signs in with OAuth, which phases cannot reuse",
      old: "SSE servers are not drafted",
      plainhttp: "its URL does not use https",
      private: "it points at this computer or a private network",
      query: "its URL carries a query string or sign-in details; add it by hand",
      stdio: "a stdio server runs a command on this computer",
      ten: "it points at this computer or a private network",
      ula: "it points at this computer or a private network",
      userinfo: "its URL carries a query string or sign-in details; add it by hand",
      ws: "ws servers are not drafted",
    });
  });

  it("does not draft a URL whose path looks like it carries a key, so the key never reaches the committed file", () => {
    const key = `${SENTINEL}0123456789abcdef`;
    const scan = scanOf({ zapier: http({ Authorization: "Bearer ${ZAP_TOKEN}" }, `https://mcp.zapier.com/api/mcp/s/${key}/mcp`), v1: http({ Authorization: "Bearer ${V1_TOKEN}" }, "https://mcp.example.com/v1/sse-endpoint/mcp") });
    expect(scan.servers.map(({ name }) => name)).toEqual(["v1"]);
    expect(scan.notDrafted).toEqual([{ name: "zapier", reason: "its URL path looks like it carries a key; add it by hand" }]);
    expect(JSON.stringify(scan)).not.toContain(key);
  });

  it("normalizes `My Server` to `my-server` and keeps configName", () => {
    const scan = scanOf({ "My Server": http({ Authorization: "Bearer ${MY_TOKEN}" }), "!!!": http({ Authorization: "Bearer ${MY_TOKEN}" }) });
    expect(scan.servers.map(({ name, configName }) => ({ name, configName }))).toEqual([{ name: "my-server", configName: "My Server" }]);
    expect(scan.notDrafted.map(({ name }) => name)).toEqual(["!!!"]);
  });

  it("runs each drafted server through validateFullSettings in a minimal document and moves a refused one to notDrafted", () => {
    // A header name the scanner accepts but whose literal-looking reference the full check refuses is
    // hard to build by hand; a URL longer than the settings grammar allows is not.
    const long = `https://mcp.example.com/${"a".repeat(2100)}`;
    const scan = scanOf({ long: http({ Authorization: "Bearer ${LONG_TOKEN}" }, long), ok: http({ Authorization: "Bearer ${OK_TOKEN}" }) });
    expect(scan.servers.map(({ name }) => name)).toEqual(["ok"]);
    expect(scan.notDrafted).toEqual([{ name: "long", reason: "Catalyst's settings check refused it; add it by hand" }]);
    const doc = `[project]\nlinear_team = "DRAFT"\n\n[environment]\n[[environment.variables]]\nname = "OK_TOKEN"\nsecret = true\n\n${mcpServerToml(scan.servers[0]!)}`;
    expect(validateFullSettings(doc).ok).toBe(true);
  });

  it("caps at 64 servers", () => {
    const servers = Object.fromEntries(Array.from({ length: 66 }, (_, i) => [`s${String(i).padStart(2, "0")}`, http({ Authorization: `Bearer \${S${i}_TOKEN}` })]));
    const scan = scanOf(servers);
    expect(scan.servers).toHaveLength(64);
    expect(scan.notDrafted.map(({ name }) => name)).toEqual(["s64", "s65"]);
    expect(scan.notDrafted[0]!.reason).toBe("more than 64 servers; add it by hand");
  });

  it("returns a note, not a throw, for invalid JSON, a non-object root, a missing file (undefined text)", () => {
    expect(scanClaudeMcp("{not json", [ROOT], new Set())).toEqual({ servers: [], notDrafted: [], note: "~/.claude.json is not valid JSON; no MCP server was drafted" });
    expect(scanClaudeMcp("[1,2]", [ROOT], new Set()).note).toBe("~/.claude.json does not hold a JSON object; no MCP server was drafted");
    expect(scanClaudeMcp(undefined, [ROOT], new Set()).note).toBe("~/.claude.json was not found");
    expect(scanOf({ odd: "not an object" }).notDrafted).toEqual([{ name: "odd", reason: "its entry is not an object" }]);
  });

  it("never returns a header value: JSON.stringify(scan) has no sentinel (positive control: the literal is in the fixture)", () => {
    const servers = { exa: http({ Authorization: `Bearer ${LITERAL}`, "X-Client": `${SENTINEL}_client` }) };
    expect(JSON.stringify(servers)).toContain(LITERAL);
    const scan = scanOf(servers);
    expect(scan.servers).toHaveLength(1);
    expect(JSON.stringify(scan)).not.toContain(SENTINEL);
    expect(mcpServerToml(scan.servers[0]!)).not.toContain(SENTINEL);
  });
});

describe("claudeHeaderLiterals", () => {
  it("returns the literal (without `Bearer `) for each derived variable requested, and nothing for referenced ones", () => {
    const text = JSON.stringify({
      mcpServers: {
        exa: http({ Authorization: `Bearer ${LITERAL}` }),
        key: http({ "X-Api-Key": `${SENTINEL}_x_api_key` }),
        ref: http({ Authorization: "Bearer ${REF_TOKEN}" }),
        stdio: { command: "x" },
      },
    });
    const values = claudeHeaderLiterals(text, [ROOT], new Set(["EXA_MCP_TOKEN", "REF_TOKEN", "OTHER"]));
    expect(Object.fromEntries(values)).toEqual({ EXA_MCP_TOKEN: LITERAL });
    expect(claudeHeaderLiterals("{bad", [ROOT], new Set(["EXA_MCP_TOKEN"])).size).toBe(0);
  });

  it("returns nothing for a server the draft refuses or whose derived name clashes with a declared name", () => {
    const text = JSON.stringify({
      mcpServers: {
        dev: http({ Authorization: `Bearer ${LITERAL}` }, "http://localhost:3000/mcp"),
        foo: http({ Authorization: `Bearer ${LITERAL}` }),
      },
    });
    const wanted = new Set(["DEV_MCP_TOKEN", "FOO_MCP_TOKEN"]);
    expect(Object.fromEntries(claudeHeaderLiterals(text, [ROOT], wanted))).toEqual({ FOO_MCP_TOKEN: LITERAL });
    expect(claudeHeaderLiterals(text, [ROOT], wanted, new Set(["FOO_MCP_TOKEN"])).size).toBe(0);
  });
});
