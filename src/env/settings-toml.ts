import { parse, TomlError } from "smol-toml";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SettingsCheck =
  | { state: "no-source"; errors: [] }
  | { state: "valid"; errors: []; variableNames: string[] }
  | { state: "invalid"; errors: string[] };

/** Validate TOML syntax and the repo declaration's environment variable table without printing values. */
export function validateSettingsToml(text: string): SettingsCheck {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const line =
      error instanceof TomlError && typeof error.line === "number"
        ? ` at line ${error.line}`
        : "";
    return { state: "invalid", errors: [`TOML could not be parsed${line}`] };
  }
  if (!isRecord(parsed))
    return {
      state: "invalid",
      errors: ["the settings file must have a TOML table at its root"],
    };
  if (parsed.environment === undefined)
    return { state: "no-source", errors: [] };
  if (!isRecord(parsed.environment))
    return { state: "invalid", errors: ["environment must be a table"] };

  const section = parsed.environment;
  if (section.variables === undefined)
    return { state: "valid", errors: [], variableNames: [] };
  if (!Array.isArray(section.variables))
    return {
      state: "invalid",
      errors: ["environment.variables must be an array of tables"],
    };
  const errors: string[] = [];
  const names = new Set<string>();
  const variableNames: string[] = [];
  if (section.variables.length > 128)
    errors.push("environment.variables has more than 128 entries");
  for (const [index, raw] of section.variables.entries()) {
    const prefix = `environment.variables[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${prefix} must be a table`);
      continue;
    }
    const name = raw.name;
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) {
      errors.push(`${prefix}.name is not a valid environment variable name`);
    } else {
      variableNames.push(name);
      if (names.has(name)) errors.push(`${prefix}.name duplicates ${name}`);
      names.add(name);
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean")
      errors.push(`${prefix}.required must be a boolean`);
    if (raw.secret !== undefined && typeof raw.secret !== "boolean")
      errors.push(`${prefix}.secret must be a boolean`);
    if ("value" in raw)
      errors.push(`${prefix}.value is not allowed; store values in the cloud`);
  }
  return errors.length > 0
    ? { state: "invalid", errors }
    : { state: "valid", errors: [], variableNames };
}

/** The declared variables and their secret flags, or null unless the file passes `validateSettingsToml`.
 *  Names and flags only: the check refuses a `value` key, so none can be read here. */
export function readDeclaredVariables(text: string): Array<{ name: string; secret: boolean }> | null {
  if (validateSettingsToml(text).state !== "valid") return null;
  const parsed = parse(text) as { environment?: { variables?: Array<Record<string, unknown>> } };
  return (parsed.environment?.variables ?? []).map((raw) => ({ name: String(raw.name), secret: raw.secret === true }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
