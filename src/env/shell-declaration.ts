// shell-declaration.ts — what `catalyst env shell` reads from `.catalyst/catalyst.toml` (the declared
// toolchains and variables) and how it resolves the variables' values from this terminal and any
// `--env-file`. Pure: no Docker, no network. A value lives only in `ResolvedVariables.values`; no
// error, list or message here ever carries one.
import { parse } from "smol-toml";
import { validateSettingsToml } from "./settings-toml.js";

export interface ShellToolchain {
  name: string;
  version: string;
}
export interface ShellVariable {
  name: string;
  required: boolean;
  secret: boolean;
}
export type ShellDeclaration =
  | { state: "valid"; toolchains: ShellToolchain[]; variables: ShellVariable[] }
  | { state: "invalid"; errors: string[] }
  | { state: "unsupported"; toolchain: ShellToolchain };

// Mirrors vendor/settings DECLARATION_NAME_RE / DECLARATION_VERSION_RE (index.js:607-608).
const NAME_RE = /^[a-z][a-z0-9+._-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9^~*<>=][A-Za-z0-9.+_\-^~*<>=| ]{0,63}$/;
/** What mise takes as one exact or prefix version (measured: 22 → 22.23.3, 1.3.14, 3.12, lts). */
const PREPARABLE_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const MAX_TOOLCHAINS = 32;

/** The toolchains and variables the shell prepares. Variables are validated by `validateSettingsToml`
 *  first, so `env check` and `env shell` refuse the same file the same way. */
export function readShellDeclaration(text: string): ShellDeclaration {
  const checked = validateSettingsToml(text);
  if (checked.state === "invalid") return { state: "invalid", errors: checked.errors };
  if (checked.state === "no-source") return { state: "valid", toolchains: [], variables: [] };
  // validateSettingsToml parsed the same text, so this cannot throw.
  const environment = record(record(parse(text))?.environment) ?? {};
  const toolchains = readToolchains(environment.toolchains);
  if (toolchains.state !== "valid") return toolchains;
  const variables = Array.isArray(environment.variables)
    ? environment.variables.map((raw): ShellVariable => {
        const entry = record(raw) ?? {};
        return {
          name: String(entry.name),
          required: entry.required === true,
          secret: entry.secret === true,
        };
      })
    : [];
  return { state: "valid", toolchains: toolchains.toolchains, variables };
}

function readToolchains(
  raw: unknown,
): { state: "valid"; toolchains: ShellToolchain[] } | Exclude<ShellDeclaration, { state: "valid" }> {
  if (raw === undefined) return { state: "valid", toolchains: [] };
  if (!Array.isArray(raw))
    return { state: "invalid", errors: ["environment.toolchains must be an array of tables"] };
  const errors: string[] = [];
  if (raw.length > MAX_TOOLCHAINS)
    errors.push(`environment.toolchains has more than ${MAX_TOOLCHAINS} entries`);
  const toolchains: ShellToolchain[] = [];
  const names = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const prefix = `environment.toolchains[${index}]`;
    const entry = record(item);
    if (!entry) {
      errors.push(`${prefix} must be a table`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => key !== "name" && key !== "version");
    if (unknown.length > 0) errors.push(`${prefix} has an unknown key: ${unknown.sort().join(", ")}`);
    const { name, version } = entry;
    const nameOk = typeof name === "string" && NAME_RE.test(name);
    const versionOk = typeof version === "string" && VERSION_RE.test(version);
    if (!nameOk) errors.push(`${prefix}.name is not a valid toolchain name`);
    else if (names.has(name)) errors.push(`${prefix}.name duplicates ${name}`);
    if (!versionOk) errors.push(`${prefix}.version is not a valid toolchain version`);
    if (nameOk) names.add(name);
    if (nameOk && versionOk) toolchains.push({ name, version });
  }
  if (errors.length > 0) return { state: "invalid", errors };
  const range = toolchains.find((toolchain) => !PREPARABLE_RE.test(toolchain.version));
  if (range) return { state: "unsupported", toolchain: range };
  return { state: "valid", toolchains };
}

/** Names the shell sets itself; a declared one is skipped with a note rather than overriding them. */
export const RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TERM",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
]);
const RESERVED_PREFIXES = ["MISE_", "OTEL_", "GIT_CONFIG_"];

export function isReservedVariableName(name: string): boolean {
  return RESERVED_VARIABLE_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const TERMINAL_SOURCE = "this terminal";

export interface ResolvedVariables {
  /** Declared, set, not reserved: the ONLY place a value lives. */
  values: Record<string, string>;
  set: string[];
  missingRequired: string[];
  unsetOptional: string[];
  skippedReserved: string[];
  /** "this terminal" and/or each --env-file path that supplied a value, in that order. */
  sources: string[];
}

/** Resolve declared names: env files in order (later wins), then this terminal's own environment,
 *  which wins over every file. Undeclared names are never read into `values`. */
export function resolveShellVariables(
  declared: readonly ShellVariable[],
  input: {
    env: NodeJS.ProcessEnv;
    envFiles: readonly { path: string; values: Record<string, string> }[];
  },
): ResolvedVariables {
  const values: Record<string, string> = {};
  const set: string[] = [];
  const missingRequired: string[] = [];
  const unsetOptional: string[] = [];
  const skippedReserved: string[] = [];
  const used = new Set<string>();
  for (const variable of declared) {
    if (isReservedVariableName(variable.name)) {
      skippedReserved.push(variable.name);
      continue;
    }
    let value: string | undefined;
    let source: string | undefined;
    const fromTerminal = input.env[variable.name];
    if (typeof fromTerminal === "string") {
      value = fromTerminal;
      source = TERMINAL_SOURCE;
    } else {
      for (const file of input.envFiles) {
        if (Object.hasOwn(file.values, variable.name)) {
          value = file.values[variable.name];
          source = file.path;
        }
      }
    }
    if (value === undefined || source === undefined) {
      (variable.required ? missingRequired : unsetOptional).push(variable.name);
      continue;
    }
    values[variable.name] = value;
    set.push(variable.name);
    used.add(source);
  }
  const sources = [
    ...(used.has(TERMINAL_SOURCE) ? [TERMINAL_SOURCE] : []),
    ...input.envFiles.map((file) => file.path).filter((path, index, all) => used.has(path) && all.indexOf(path) === index),
  ];
  return { values, set, missingRequired: missingRequired.sort(), unsetOptional, skippedReserved, sources };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
