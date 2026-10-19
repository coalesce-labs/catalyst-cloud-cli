import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isReservedVariableName,
  readShellDeclaration,
  RESERVED_VARIABLE_NAMES,
  resolveShellVariables,
} from "../src/env/shell-declaration";

const toolchains = (body: string) => `[environment]\ntoolchains = ${body}\n`;

describe("readShellDeclaration", () => {
  test("this repository's own file: toolchains node 22 and bun 1.3.14, no variables", () => {
    const text = readFileSync(".catalyst/catalyst.toml", "utf8");
    expect(readShellDeclaration(text)).toEqual({
      state: "valid",
      toolchains: [
        { name: "node", version: "22" },
        { name: "bun", version: "1.3.14" },
      ],
      variables: [],
    });
  });

  test("variables keep required and secret (default false), in file order", () => {
    const text = [
      "[environment]",
      "[[environment.variables]]",
      'name = "DATABASE_URL"',
      "required = true",
      "[[environment.variables]]",
      'name = "STRIPE_SECRET_KEY"',
      "required = true",
      "secret = true",
      "[[environment.variables]]",
      'name = "SENTRY_DSN"',
    ].join("\n");
    expect(readShellDeclaration(text)).toEqual({
      state: "valid",
      toolchains: [],
      variables: [
        { name: "DATABASE_URL", required: true, secret: false },
        { name: "STRIPE_SECRET_KEY", required: true, secret: true },
        { name: "SENTRY_DSN", required: false, secret: false },
      ],
    });
  });

  test("no [environment] table → valid with no toolchains and no variables", () => {
    expect(readShellDeclaration('[project]\nlinear_team = "CTC"\n')).toEqual({
      state: "valid",
      toolchains: [],
      variables: [],
    });
  });

  test("an invalid variables table reports validateSettingsToml's own errors", () => {
    const result = readShellDeclaration(
      '[environment]\n[[environment.variables]]\nname = "X"\nvalue = "never-print-this"\n',
    );
    expect(result).toEqual({
      state: "invalid",
      errors: ["environment.variables[0].value is not allowed; store values in the cloud"],
    });
    expect(JSON.stringify(result)).not.toContain("never-print-this");
    expect(readShellDeclaration("[environment\n")).toEqual({
      state: "invalid",
      errors: ["TOML could not be parsed at line 1"],
    });
  });

  test("toolchains: not an array, a non-table entry, an unknown key, a bad name, a duplicate name, 33 entries → invalid, one error each", () => {
    expect(readShellDeclaration(toolchains('"node"'))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains must be an array of tables"],
    });
    expect(readShellDeclaration(toolchains('["node"]'))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains[0] must be a table"],
    });
    expect(readShellDeclaration(toolchains('[{ name = "node", version = "22", url = "x" }]'))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains[0] has an unknown key: url"],
    });
    expect(readShellDeclaration(toolchains('[{ name = "Node", version = "22" }]'))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains[0].name is not a valid toolchain name"],
    });
    expect(readShellDeclaration(toolchains('[{ name = "node", version = "" }]'))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains[0].version is not a valid toolchain version"],
    });
    expect(
      readShellDeclaration(toolchains('[{ name = "node", version = "22" }, { name = "node", version = "24" }]')),
    ).toEqual({ state: "invalid", errors: ["environment.toolchains[1].name duplicates node"] });
    const many = Array.from({ length: 33 }, (_, i) => `{ name = "t${i}", version = "1" }`).join(", ");
    expect(readShellDeclaration(toolchains(`[${many}]`))).toEqual({
      state: "invalid",
      errors: ["environment.toolchains has more than 32 entries"],
    });
  });

  test('a range version (">=20 <22", "^22", "22.x || 24", "*") → { state: "unsupported", toolchain: { name, version } }', () => {
    for (const version of [">=20 <22", "^22", "22.x || 24", "*", "~1.3"]) {
      expect(readShellDeclaration(toolchains(`[{ name = "node", version = ${JSON.stringify(version)} }]`))).toEqual({
        state: "unsupported",
        toolchain: { name: "node", version },
      });
    }
  });

  test("lts, latest, 22, 22.23.3, 3.12, temurin-21 are accepted", () => {
    const versions = ["lts", "latest", "22", "22.23.3", "3.12", "temurin-21"];
    const body = versions.map((version, i) => `{ name = "t${i}", version = "${version}" }`).join(", ");
    const result = readShellDeclaration(toolchains(`[${body}]`));
    expect(result.state).toBe("valid");
    if (result.state === "valid") expect(result.toolchains.map((t) => t.version)).toEqual(versions);
  });
});

describe("resolveShellVariables", () => {
  const decl = [
    { name: "DATABASE_URL", required: true, secret: false },
    { name: "STRIPE_SECRET_KEY", required: true, secret: true },
    { name: "SENTRY_DSN", required: false, secret: false },
  ];

  test("terminal values win over env files; later env files win over earlier ones", () => {
    const r = resolveShellVariables(decl, {
      env: { DATABASE_URL: "from-terminal" },
      envFiles: [
        { path: ".env", values: { DATABASE_URL: "from-file", STRIPE_SECRET_KEY: "first", SENTRY_DSN: "dsn" } },
        { path: ".env.local", values: { STRIPE_SECRET_KEY: "second" } },
      ],
    });
    expect(r.values).toEqual({ DATABASE_URL: "from-terminal", STRIPE_SECRET_KEY: "second", SENTRY_DSN: "dsn" });
    expect(r.set).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY", "SENTRY_DSN"]);
    expect(r.sources).toEqual(["this terminal", ".env", ".env.local"]);
  });

  test("only declared names are returned: an undeclared CLOUDFLARE_API_TOKEN in the terminal is never in values", () => {
    const r = resolveShellVariables(decl, {
      env: { DATABASE_URL: "a", STRIPE_SECRET_KEY: "b", CLOUDFLARE_API_TOKEN: "cf-token" },
      envFiles: [{ path: ".env", values: { WRANGLER_TOKEN: "w" } }],
    });
    expect(Object.keys(r.values)).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
    expect(JSON.stringify(r)).not.toContain("cf-token");
    expect(r.sources).toEqual(["this terminal"]);
  });

  test("a required name with no value is in missingRequired, sorted; an optional one is in unsetOptional", () => {
    const r = resolveShellVariables(decl, { env: {}, envFiles: [] });
    expect(r.missingRequired).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
    expect(r.unsetOptional).toEqual(["SENTRY_DSN"]);
    expect(r.set).toEqual([]);
    const reversed = resolveShellVariables([...decl].reverse(), { env: {}, envFiles: [] });
    expect(reversed.missingRequired).toEqual(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
  });

  test("an empty string counts as set (it is a value)", () => {
    const r = resolveShellVariables(decl, { env: { DATABASE_URL: "", STRIPE_SECRET_KEY: "x" }, envFiles: [] });
    expect(r.missingRequired).toEqual([]);
    expect(r.values.DATABASE_URL).toBe("");
    expect(r.set).toContain("DATABASE_URL");
  });

  test("PATH, HOME, TERM, MISE_DATA_DIR, OTEL_SERVICE_NAME, GIT_CONFIG_COUNT are skipped and listed in skippedReserved", () => {
    const names = ["PATH", "HOME", "TERM", "MISE_DATA_DIR", "OTEL_SERVICE_NAME", "GIT_CONFIG_COUNT"];
    const r = resolveShellVariables(
      names.map((name) => ({ name, required: true, secret: false })),
      { env: { PATH: "/bin", HOME: "/h", TERM: "x", MISE_DATA_DIR: "/m", OTEL_SERVICE_NAME: "s", GIT_CONFIG_COUNT: "1" }, envFiles: [] },
    );
    expect(r.skippedReserved).toEqual(names);
    expect(r.values).toEqual({});
    expect(r.missingRequired).toEqual([]);
    expect(RESERVED_VARIABLE_NAMES.has("CLAUDE_CODE_ENABLE_TELEMETRY")).toBe(true);
    expect(isReservedVariableName("DATABASE_URL")).toBe(false);
  });

  // CTC-6152: Windows environment names are case-insensitive, so docker_host reaches the docker client as DOCKER_HOST.
  test("reserved names and prefixes match case-insensitively: docker_host, Path and mise_data_dir are skipped", () => {
    const names = ["docker_host", "Docker_Context", "Path", "home", "mise_data_dir", "otel_service_name", "git_config_count"];
    const r = resolveShellVariables(
      names.map((name) => ({ name, required: true, secret: false })),
      { env: {}, envFiles: [{ path: ".env", values: Object.fromEntries(names.map((n) => [n, "x"])) }] },
    );
    expect(r.skippedReserved).toEqual(names);
    expect(r.values).toEqual({});
    expect(isReservedVariableName("database_url")).toBe(false);
  });

  test("DOCKER_HOST and DOCKER_CONTEXT from an env file are skipped: they would move the docker client itself", () => {
    const r = resolveShellVariables(
      [{ name: "DOCKER_HOST", required: true, secret: false }, { name: "DOCKER_CONTEXT", required: false, secret: false }],
      { env: {}, envFiles: [{ path: ".env", values: { DOCKER_HOST: "tcp://docker:2375", DOCKER_CONTEXT: "other" } }] },
    );
    expect(r.skippedReserved).toEqual(["DOCKER_HOST", "DOCKER_CONTEXT"]);
    expect(r.values).toEqual({});
    expect(r.missingRequired).toEqual([]);
  });

  test("no value appears in any returned list or message", () => {
    const r = resolveShellVariables(decl, { env: { DATABASE_URL: "postgres://secret" }, envFiles: [] });
    expect(JSON.stringify({ ...r, values: undefined })).not.toContain("postgres://secret");
  });
});
