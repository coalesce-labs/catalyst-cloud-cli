import { realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMachineValues } from "../src/env/machine-values.js";
import { ALL_NAMES, DIRENV_GITHUB_TOKEN, SENTINEL, valueFor, writeMachine } from "./env-machine-fixture.js";

const declare = (names: string[], secret = false) => names.map((name) => ({ name, secret }));

describe("resolveMachineValues", () => {
  it("direnv environment: ctx.env value used only when DIRENV_DIR is `-<repo root>` (or its realpath) and .envrc exports the name", () => {
    const { root, home } = writeMachine({ claude: null });
    const env = { DIRENV_DIR: `-${root}`, GITHUB_TOKEN: DIRENV_GITHUB_TOKEN, NOT_EXPORTED: `${SENTINEL}_x` };
    const loaded = resolveMachineValues(root, { home, env }, declare(["GITHUB_TOKEN", "NOT_EXPORTED"]));
    expect(loaded.values.get("GITHUB_TOKEN")).toEqual({ value: DIRENV_GITHUB_TOKEN, from: "direnv environment" });
    expect(loaded.values.has("NOT_EXPORTED")).toBe(false);

    const other = resolveMachineValues(root, { home, env: { ...env, DIRENV_DIR: "-/somewhere/else" } }, declare(["GITHUB_TOKEN"]));
    expect(other.values.has("GITHUB_TOKEN")).toBe(false);

    const link = join(tmpdir(), `catalyst-machine-link-${process.pid}-${Date.now()}`);
    symlinkSync(root, link);
    const viaLink = resolveMachineValues(link, { home, env: { ...env, DIRENV_DIR: `-${realpathSync(root)}` } }, declare(["GITHUB_TOKEN"]));
    expect(viaLink.values.get("GITHUB_TOKEN")?.from).toBe("direnv environment");
  });

  it("falls back to the .envrc static literal; a computed value with no direnv environment is noValue {computed: true}", () => {
    const { root, home } = writeMachine({ claude: null });
    const resolved = resolveMachineValues(root, { home, env: {} }, declare(ALL_NAMES));
    expect(resolved.values.size).toBe(43);
    expect(resolved.values.get("PLAIN_SETTING_00")).toEqual({ value: valueFor("PLAIN_SETTING_00"), from: ".envrc" });
    expect(resolved.noValue).toEqual([{ name: "GITHUB_TOKEN", computed: true }]);
  });

  it("a derived MCP variable takes its value from the ~/.claude.json header literal (without `Bearer `)", () => {
    const literal = `${SENTINEL}_exa_literal`;
    const { root, home } = writeMachine({ envrc: null, claude: JSON.stringify({ mcpServers: { exa: { type: "http", url: "https://mcp.exa.ai/mcp", headers: { Authorization: `Bearer ${literal}` } } } }) });
    const resolved = resolveMachineValues(root, { home, env: {} }, declare(["EXA_MCP_TOKEN"], true));
    expect(resolved.values.get("EXA_MCP_TOKEN")).toEqual({ value: literal, from: "~/.claude.json" });
  });

  it("a name a header references as ${NAME} takes ctx.env[NAME]", () => {
    const { root, home } = writeMachine({ envrc: null });
    const env = { LINEAR_API_KEY: `${SENTINEL}_linear_shell`, UNREFERENCED: `${SENTINEL}_other` };
    const resolved = resolveMachineValues(root, { home, env }, declare(["LINEAR_API_KEY", "UNREFERENCED"], true));
    expect(resolved.values.get("LINEAR_API_KEY")).toEqual({ value: env.LINEAR_API_KEY, from: "shell environment" });
    expect(resolved.noValue).toEqual([{ name: "UNREFERENCED", computed: false }]);
  });

  it("an empty value is noValue; a name declared but found nowhere is noValue {computed: false}", () => {
    const { root, home } = writeMachine({ envrc: "export EMPTY=\nexport SET=1\n", claude: null });
    const resolved = resolveMachineValues(root, { home, env: { DIRENV_DIR: `-${root}`, EMPTY: "" } }, declare(["EMPTY", "SET", "NOWHERE"]));
    expect([...resolved.values.keys()]).toEqual(["SET"]);
    expect(resolved.noValue).toEqual([{ name: "EMPTY", computed: false }, { name: "NOWHERE", computed: false }]);
  });

  it("an undeclared machine name is never resolved (the file is the allowlist)", () => {
    const { root, home } = writeMachine();
    const resolved = resolveMachineValues(root, { home, env: { DIRENV_DIR: `-${root}`, GITHUB_TOKEN: DIRENV_GITHUB_TOKEN } }, declare(["PLAIN_SETTING_01"]));
    expect([...resolved.values.keys()]).toEqual(["PLAIN_SETTING_01"]);
    expect(resolved.noValue).toEqual([]);
  });

  it("reads through an injected machine-file reader", () => {
    const resolved = resolveMachineValues("/repo", {
      home: "/home/dev",
      env: {},
      readMachineFile: (path) => (path === "/repo/.envrc" ? "export A=1\n" : undefined),
    }, declare(["A"]));
    expect(resolved.values.get("A")).toEqual({ value: "1", from: ".envrc" });
  });
});
