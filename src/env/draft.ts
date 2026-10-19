import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertLegacyEnvironmentJson } from "./legacy.js";
import { inventoryRepo } from "./inventory.js";
import { scanMachine, type MachineOptions, type MachineScan } from "./machine.js";
import { mcpServerToml, type DraftedMcpServer } from "./scan-claude-mcp.js";
import type { ScanDeps } from "./types.js";
import { walkRepo } from "./walk.js";

const SECRET_NAME_RE = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARIABLES = 128;

/** The draft's secret rule: a name that says it holds a key, a token, a password or a secret. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export type EnvironmentDraft =
  | {
    state: "valid";
    names: string[];
    secretNames: string[];
    setup: string[];
    verify: string[];
    toml: string;
    sources: string[];
    mcpServers: DraftedMcpServer[];
    /** What this computer added; null when the caller did not ask for the machine scan. */
    machine: MachineScan | null;
  }
  | { state: "invalid"; errors: string[] };

/** Build a stable, value-free environment table from repository evidence. `.env` is never read:
 *  inventoryRepo's walker only opens supported examples and source/config files. The legacy
 *  declaration is parsed for names and explicit secret flags, and no legacy value escapes.
 *  With `options.machine`, the names this computer's `.envrc` exports and Claude Code's HTTP MCP
 *  servers join the draft (`catalyst env draft`); without it (`catalyst onboard`) nothing changes. */
export function draftEnvironment(
  root: string,
  deps: Partial<ScanDeps> = {},
  options: { machine?: MachineOptions } = {},
): EnvironmentDraft {
  const inventory = inventoryRepo(root, deps);
  const files = (deps.listFiles ?? walkRepo)(root);
  const names = new Set<string>();
  const secrets = new Set<string>();
  const sources = new Set<string>();

  for (const entry of inventory.entries) {
    if (entry.group === "bindings" || !entry.needsDeclaration || !ENV_NAME_RE.test(entry.name)) continue;
    names.add(entry.name);
    if (isSecretName(entry.name)) secrets.add(entry.name);
    for (const finding of entry.found) sources.add(finding.file);
  }

  const legacyPath = join(root, "catalyst.env.json");
  const legacy = deps.readFile !== undefined ? deps.readFile(legacyPath) : readOptional(legacyPath);
  if (legacy !== undefined) {
    const converted = convertLegacyEnvironmentJson(legacy);
    if (converted.state === "invalid") return converted;
    for (const name of converted.variableNames) names.add(name);
    for (const name of converted.secretNames) secrets.add(name);
    if (converted.variableNames.length > 0) sources.add("catalyst.env.json");
  }

  const machine = options.machine === undefined ? null : scanMachine(root, options.machine);
  for (const name of machine?.names ?? []) names.add(name);
  for (const name of machine?.secretNames ?? []) secrets.add(name);
  for (const source of machine?.sources ?? []) sources.add(source);
  const mcpServers = machine?.claude?.servers ?? [];

  const sortedNames = [...names].sort((a, b) => a.localeCompare(b, "en"));
  if (sortedNames.length > MAX_VARIABLES) {
    return { state: "invalid", errors: [`environment has more than ${MAX_VARIABLES} names`] };
  }
  const secretNames = [...secrets].filter((name) => names.has(name)).sort((a, b) => a.localeCompare(b, "en"));
  const standard = standardSteps(root, files, deps);
  if (standard.error !== undefined) return { state: "invalid", errors: [standard.error] };
  for (const source of standard.sources) sources.add(source);
  for (const path of files) if (path.startsWith(".github/workflows/")) sources.add(path);

  const chunks = ["[environment]"];
  for (const name of sortedNames) chunks.push([
    "[[environment.variables]]",
    `name = ${JSON.stringify(name)}`,
    ...(secrets.has(name) ? ["secret = true"] : []),
    "required = false",
    "",
  ].join("\n"));
  chunks.push(...mcpServers.map(mcpServerToml), ...standard.setup, ...standard.verify);
  const toml = `${chunks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  return {
    state: "valid",
    names: sortedNames,
    secretNames,
    setup: standard.setup,
    verify: standard.verify,
    toml,
    sources: [...sources].sort((a, b) => a.localeCompare(b, "en")),
    mcpServers,
    machine,
  };
}

/** Conservative package.json/lockfile inference. No repository script is executed. */
function standardSteps(
  root: string,
  files: string[],
  deps: Partial<ScanDeps>,
): { setup: string[]; verify: string[]; sources: string[]; error?: string } {
  if (!files.includes("package.json")) return { setup: [], verify: [], sources: [] };
  const raw = deps.readFile !== undefined ? deps.readFile(join(root, "package.json")) : readOptional(join(root, "package.json"));
  if (raw === undefined) return { setup: [], verify: [], sources: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { setup: [], verify: [], sources: [], error: "package.json is not valid JSON; refusing to guess setup commands" };
  }
  if (!isRecord(parsed)) return { setup: [], verify: [], sources: [], error: "package.json must contain a JSON object; refusing to guess setup commands" };
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  const lock = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].find((name) => files.includes(name));
  const manager = lock?.startsWith("bun.") ? "bun"
    : lock === "pnpm-lock.yaml" ? "pnpm"
      : lock === "yarn.lock" ? "yarn"
        : lock === "package-lock.json" ? "npm" : undefined;
  const setup: string[] = [];
  const verify: string[] = [];
  const sources = ["package.json"];
  if (manager !== undefined && lock !== undefined) {
    const install = manager === "npm" ? ["npm", "ci"]
      : manager === "yarn" ? ["yarn", "install", "--immutable"]
        : [manager, "install", "--frozen-lockfile"];
    setup.push(stepToml("setup", "install-dependencies", install, [lock]));
    sources.push(lock);
  }
  const selected = typeof scripts["check"] === "string"
    ? ["check"]
    : ["typecheck", "test"].filter((name) => typeof scripts[name] === "string");
  if (manager !== undefined) {
    for (const name of selected) verify.push(stepToml("verify", name, [manager, "run", name]));
  }
  return { setup, verify, sources };
}

function stepToml(section: "setup" | "verify", name: string, run: string[], cacheKeyFiles: string[] = []): string {
  return [
    `[[environment.${section}]]`,
    `name = ${JSON.stringify(name)}`,
    `run = [${run.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ...(cacheKeyFiles.length ? [`cache_key_files = [${cacheKeyFiles.map((path) => JSON.stringify(path)).join(", ")}]`] : []),
    "",
  ].join("\n");
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
