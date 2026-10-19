// env-draft-machine.test.ts — the acceptance for "the machine's variables and MCP servers become
// declarations": `catalyst env draft --write` over a repository's `.envrc` and Claude Code's
// `~/.claude.json`, with no value in the file or the output.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { draftEnvironment } from "../src/env/draft.js";
import { validateFullSettings } from "../vendor/settings/index.js";
import { ALL_NAMES, claudeJson, envrcText, SENTINEL, STDIO_ENV_VALUE, TOKEN_NAMES, valueFor, writeMachine } from "./env-machine-fixture.js";
import { makeCtx } from "./helpers";

const WHOLE_REF_RE = /^\$([A-Z][A-Z0-9_]*)$/;
const BEARER_REF_RE = /^Bearer \$([A-Z][A-Z0-9_]*)$/;
const noTty = { import: { isTty: () => false } };

interface DraftedFile {
  environment?: {
    variables: Array<{ name: string; secret?: boolean; required: boolean }>;
    mcp_servers?: Array<{ name: string; transport: string; url: string; headers: Record<string, string> }>;
  };
}

describe("Scenario: the machine's variables and MCP servers become declarations", () => {
  it("44 .envrc exports (13 tokens) + 3 HTTP servers referencing them → `env draft --write` writes 44 [[environment.variables]] (13 secret) and 3 [[environment.mcp_servers]] whose headers reference declared names", async () => {
    const { root, home } = writeMachine();
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(0);
    const text = readFileSync(join(root, ".catalyst/catalyst.toml"), "utf8");
    const file: DraftedFile = parse(text);
    if (file.environment === undefined) throw new Error("the draft has no [environment] table");
    const variables = file.environment.variables;
    expect(variables.map(({ name }) => name)).toEqual(ALL_NAMES);
    expect(variables.filter(({ secret }) => secret === true).map(({ name }) => name)).toEqual(TOKEN_NAMES);
    expect(variables.every(({ required }) => required === false)).toBe(true);
    const servers = file.environment.mcp_servers ?? [];
    expect(servers.map(({ name }) => name)).toEqual(["context7", "exa", "linear"]);
    const declared = new Set(variables.map(({ name }) => name));
    for (const server of servers) {
      expect(server.transport).toBe("http");
      for (const value of Object.values(server.headers)) {
        const ref = WHOLE_REF_RE.exec(value) ?? BEARER_REF_RE.exec(value);
        if (ref === null) throw new Error(`header value is not a reference: ${value}`);
        expect(declared.has(ref[1] ?? "")).toBe(true);
      }
    }
    expect(validateFullSettings(`[project]\nlinear_team = "DRAFT"\n\n${text}`).ok).toBe(true);
  });

  it("no value is written or printed: every .envrc and header sentinel is absent from the file, ctx.out, ctx.err and --json (positive control: sentinels present in the fixture files)", async () => {
    const literal = `${SENTINEL}_literal_header`;
    const { root, home } = writeMachine({ claude: claudeJson(join("/", "unused"), { direct: { type: "http", url: "https://mcp.direct.dev/mcp", headers: { Authorization: `Bearer ${literal}` } } }) });
    const envrc = readFileSync(join(root, ".envrc"), "utf8");
    const claude = readFileSync(join(home, ".claude.json"), "utf8");
    expect(envrc).toContain(valueFor("PLAIN_SETTING_00"));
    expect(claude).toContain(literal);
    expect(claude).toContain(STDIO_ENV_VALUE);
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(0);
    const jsonCtx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--json"], jsonCtx, { env: noTty })).toBe(0);
    const file = readFileSync(join(root, ".catalyst/catalyst.toml"), "utf8");
    expect(file).toContain("DIRECT_MCP_TOKEN");
    for (const output of [file, ctx.out.join("\n"), ctx.err.join("\n"), jsonCtx.out.join("\n"), jsonCtx.err.join("\n")]) {
      expect(output).not.toContain(SENTINEL);
    }
  });

  it("a literal header becomes a derived secret variable and a reference; the literal is in neither the file nor the output", async () => {
    const literal = `${SENTINEL}_exa_literal`;
    const { root, home } = writeMachine({ claude: JSON.stringify({ mcpServers: { exa: { type: "http", url: "https://mcp.exa.ai/mcp", headers: { Authorization: `Bearer ${literal}` } } } }) });
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(0);
    const text = readFileSync(join(root, ".catalyst/catalyst.toml"), "utf8");
    expect(text).toContain('name = "EXA_MCP_TOKEN"\nsecret = true\nrequired = false');
    expect(text).toContain('headers = { "Authorization" = "Bearer $EXA_MCP_TOKEN" }');
    expect(ctx.out.join("\n")).toContain("exa: its Authorization header held a value; drafted as $EXA_MCP_TOKEN, which env import reads from ~/.claude.json");
    expect(`${text}${ctx.out.join("\n")}`).not.toContain(literal);
  });

  it("names referenced by an MCP header are marked secret even when their name does not match the secret rule", () => {
    const { root, home } = writeMachine({ envrc: "export SERVICE_HANDLE=abc\n", claude: JSON.stringify({ mcpServers: { svc: { type: "http", url: "https://mcp.svc.dev/mcp", headers: { "X-Handle": "${SERVICE_HANDLE}" } } } }) });
    const draft = draftEnvironment(root, {}, { machine: { home, env: {} } });
    if (draft.state !== "valid") throw new Error("expected a draft");
    expect(draft.secretNames).toEqual(["SERVICE_HANDLE"]);
  });

  it("human output lists the sources (.envrc, ~/.claude.json), the not-read .envrc lines and each not-drafted server with its reason", async () => {
    const { root, home } = writeMachine();
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root], ctx, { env: noTty })).toBe(0);
    const out = ctx.out.join("\n");
    expect(out).toMatch(/^Drafted \.catalyst\/catalyst\.toml from .*\.envrc.*~\/\.claude\.json/m);
    expect(out).toContain("Names: 44 (13 secret; all optional)");
    expect(out).toContain("From this computer:");
    expect(out).toContain("  .envrc: 44 exported names. Not read: line 2 dotenv_if_exists, line 3 PATH_add; names those lines load are not drafted.");
    expect(out).toContain("  ~/.claude.json: 3 HTTP MCP servers (context7, exa, linear). Each header names a variable; no header value is copied.");
    expect(out).toContain("    Not drafted: local-tool (a stdio server runs a command on this computer)");
  });

  it("--json adds mcpServers and machine and keeps every existing field", async () => {
    const { root, home } = writeMachine({ envrc: `${envrcText()}export PATH=/opt/bin:$PATH\n` });
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--json"], ctx, { env: noTty })).toBe(0);
    expect(ctx.out).toHaveLength(1);
    const body = JSON.parse(ctx.out[0]!) as Record<string, unknown>;
    for (const field of ["state", "names", "secretNames", "setupCount", "verifyCount", "sources", "destination", "toml", "written", "mcpServers", "machine"]) {
      expect(body).toHaveProperty(field);
    }
    expect(body.mcpServers).toEqual([
      { name: "context7", configName: "context7", scope: "user", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY" } },
      { name: "exa", configName: "exa", scope: "user", url: "https://mcp.exa.ai/mcp", headers: { Authorization: "Bearer $EXA_API_KEY" } },
      { name: "linear", configName: "linear", scope: "project", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer $LINEAR_API_KEY" } },
    ]);
    const machine = body.machine as { envrc: { exported: string[]; notRead: unknown[]; skippedNames: string[] }; claudeJson: { servers: string[]; notDrafted: unknown[] } };
    expect(machine.envrc.exported).toEqual(ALL_NAMES);
    expect(machine.envrc.notRead).toEqual([{ line: 2, reason: "dotenv_if_exists" }, { line: 3, reason: "PATH_add" }]);
    expect(machine.envrc.skippedNames).toEqual(["PATH"]);
    expect(machine.claudeJson.servers).toEqual(["context7", "exa", "linear"]);
    expect(machine.claudeJson.notDrafted).toEqual([{ name: "local-tool", reason: "a stdio server runs a command on this computer" }]);
  });

  it("--diff shows the mcp_servers blocks as additions", async () => {
    const { root, home } = writeMachine();
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--diff"], ctx, { env: noTty })).toBe(0);
    const out = ctx.out.join("\n");
    expect(out).toContain("+[[environment.mcp_servers]]");
    expect(out).toContain('+name = "linear"');
    expect(out).toContain('+headers = { "Authorization" = "Bearer $LINEAR_API_KEY" }');
  });

  it("a missing ~/.claude.json and a missing .envrc leave today's draft byte-identical (regression against the current env-draft.test.ts fixtures)", async () => {
    const { root, home } = writeMachine({ envrc: null, claude: null });
    writeFileSync(join(root, ".env.example"), "DATABASE_URL=placeholder\nAPI_TOKEN=example\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "echo ok" } }));
    writeFileSync(join(root, "bun.lock"), "");
    const withMachine = draftEnvironment(root, {}, { machine: { home, env: {} } });
    const without = draftEnvironment(root);
    if (withMachine.state !== "valid" || without.state !== "valid") throw new Error("expected drafts");
    expect(withMachine.toml).toBe(without.toml);
    expect(withMachine.names).toEqual(without.names);
    expect(withMachine.sources).toEqual(without.sources);
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root], ctx, { env: noTty })).toBe(0);
    expect(ctx.out.join("\n")).not.toContain("From this computer");
    expect(ctx.out).toContain(without.toml);
  });

  it("an .envrc that links to a .env file is not read, and the output says so", async () => {
    const { root, home } = writeMachine({ envrc: null, claude: null });
    writeFileSync(join(root, ".env"), `export LEAKED=${SENTINEL}_dotenv\n`);
    symlinkSync(join(root, ".env"), join(root, ".envrc"));
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root], ctx, { env: noTty })).toBe(0);
    const out = ctx.out.join("\n");
    expect(out).toContain(".envrc links to a .env file, which is never read; it was not read");
    expect(out).not.toContain("LEAKED");
    expect(out).not.toContain(SENTINEL);
  });

  it("an invalid ~/.claude.json is a note, not a failure: the variables are still drafted", async () => {
    const { root, home } = writeMachine({ claude: "{ this is not json" });
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root], ctx, { env: noTty })).toBe(0);
    const out = ctx.out.join("\n");
    expect(out).toContain("~/.claude.json is not valid JSON; no MCP server was drafted");
    expect(out).toContain("Names: 44 (13 secret; all optional)");
  });

  it("more than 128 names stays the existing `environment has more than 128 names` refusal", async () => {
    const lines = Array.from({ length: 129 }, (_, i) => `export NAME_${i}=x`).join("\n");
    const { root, home } = writeMachine({ envrc: `${lines}\n`, claude: null });
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(1);
    expect(ctx.err).toEqual(["environment has more than 128 names"]);
  });

  it("an oversized or non-regular .envrc becomes a note", async () => {
    const { root, home } = writeMachine({ envrc: null, claude: null });
    mkdirSync(join(root, ".envrc"));
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root], ctx, { env: noTty })).toBe(0);
    expect(ctx.out.join("\n")).toContain(".envrc is not a regular file; it was not read");
    const big = mkdtempSync(join(tmpdir(), "catalyst-machine-big-"));
    writeFileSync(join(big, ".envrc"), "#".repeat(1024 * 1024 + 1));
    const bigCtx = makeCtx(home);
    expect(await main(["env", "draft", "--root", big], bigCtx, { env: noTty })).toBe(0);
    expect(bigCtx.out.join("\n")).toContain(".envrc is larger than 1 MiB; it was not read");
  });

  it("the --write gate refuses a draft the full settings check refuses, and writes nothing", async () => {
    // A 200-character name passes the local name check and fails the full settings check.
    const { root, home } = writeMachine({ envrc: `export ${"A".repeat(200)}=x\n`, claude: null });
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(1);
    expect(ctx.err).toEqual(["draft failed Catalyst's settings check; no file was written"]);
    expect(() => readFileSync(join(root, ".catalyst/catalyst.toml"))).toThrow();
  });

  it("the existing-file refusal names catalyst env import", async () => {
    const { root, home } = writeMachine();
    mkdirSync(join(root, ".catalyst"));
    writeFileSync(join(root, ".catalyst/catalyst.toml"), "[environment]\n");
    const ctx = makeCtx(home);
    expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: noTty })).toBe(1);
    expect(ctx.err).toEqual([
      ".catalyst/catalyst.toml already exists; no file was written. Review the draft with --diff and merge it by hand.",
      "To store this computer's values for the names it declares, run: catalyst env import",
    ]);
  });
});
