import { describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftOnboardSettings } from "../src/env/onboard-draft.js";
import { validateFullSettings } from "../vendor/settings/index.js";
import { envrcText, writeMachine } from "./env-machine-fixture.js";

describe("draftOnboardSettings", () => {
  it("composes the explicit team with the complete value-free environment draft", () => {
    const result = draftOnboardSettings("/repo", "CTC", {
      fileExists: () => false,
      listFiles: () => [
        ".env.example",
        "package.json",
        "bun.lock",
        "src/app.ts",
      ],
      readFile: (path) => {
        if (path.endsWith(".env.example"))
          return "PUBLIC_URL=https://placeholder.invalid\nAPI_TOKEN=sample-secret\n";
        if (path.endsWith("package.json"))
          return JSON.stringify({ scripts: { check: "arbitrary command" } });
        if (path.endsWith("src/app.ts")) return "process.env.DATABASE_URL";
        return undefined;
      },
    });

    expect(result.state).toBe("draft");
    if (result.state !== "draft") throw new Error("expected composed draft");
    expect(result.toml).toMatch(
      /^\[project\]\nlinear_team = "CTC"\n\n\[environment\]/,
    );
    expect(result.names).toEqual(["API_TOKEN", "DATABASE_URL", "PUBLIC_URL"]);
    expect(result.secretNames).toEqual(["API_TOKEN"]);
    expect(result.setup).toHaveLength(1);
    expect(result.verify).toHaveLength(1);
    expect(result.sources).toContain(".env.example");
    expect(result.toml).toContain("required = false");
    expect(result.toml).not.toContain("https://placeholder.invalid");
    expect(result.toml).not.toContain("sample-secret");
    expect(result.toml).not.toContain("arbitrary command");
    expect(validateFullSettings(result.toml)).toEqual({
      ok: true,
      errors: [],
      linearTeam: "CTC",
      variableNames: ["DATABASE_URL", "PUBLIC_URL"],
      secretNames: ["API_TOKEN"],
    });
  });

  it("rejects invalid or TOML-injecting team keys before scanning", () => {
    const listFiles = vi.fn(() => []);
    const result = draftOnboardSettings("/repo", 'CTC"\nmalicious = true', {
      fileExists: () => false,
      listFiles,
      readFile: () => undefined,
    });

    expect(result).toEqual({
      state: "invalid",
      errors: [
        "team key must use uppercase letters and digits and start with a letter",
      ],
    });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("enforces the full contract team-key bound before scanning", () => {
    const listFiles = vi.fn(() => []);
    expect(
      draftOnboardSettings("/repo", "A".repeat(17), {
        fileExists: () => false,
        listFiles,
      }).state,
    ).toBe("invalid");
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("reports an existing settings file without scanning or composing a replacement", () => {
    const listFiles = vi.fn(() => [".env.example"]);
    const result = draftOnboardSettings("/repo", "CTC", {
      fileExists: (path) => path === "/repo/.catalyst/catalyst.toml",
      listFiles,
      readFile: () => "MUST_NOT_BE_INCLUDED=private-value\n",
    });

    expect(result).toEqual({
      state: "existing",
      destination: ".catalyst/catalyst.toml",
    });
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("preserves draftEnvironment scanner failures without returning a partial TOML", () => {
    const result = draftOnboardSettings("/repo", "CTC", {
      fileExists: () => false,
      listFiles: () => ["catalyst.env.json"],
      readFile: (path) =>
        path.endsWith("catalyst.env.json") ? "{broken" : undefined,
    });

    expect(result).toEqual({
      state: "invalid",
      errors: ["legacy declaration is not valid JSON"],
    });
  });

  it("is unchanged by this computer's .envrc and ~/.claude.json: the onboarding draft never runs the machine scan", () => {
    const { root } = writeMachine();
    writeFileSync(join(root, ".env.example"), "PUBLIC_URL=https://placeholder.invalid\n");
    const withMachine = draftOnboardSettings(root, "CTC");
    rmSync(join(root, ".envrc"));
    const without = draftOnboardSettings(root, "CTC");
    expect(withMachine.state).toBe("draft");
    expect(withMachine).toEqual(without);
    if (withMachine.state !== "draft") throw new Error("expected a draft");
    expect(withMachine.toml).not.toContain("mcp_servers");
    expect(withMachine.names).toEqual(["PUBLIC_URL"]);
    expect(envrcText()).toContain("GITHUB_TOKEN");
  });
});
