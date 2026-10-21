// env-import.ts — `catalyst env import` and `catalyst env draft --write --import-values`: store this
// computer's values for the names a reviewed `.catalyst/catalyst.toml` declares. The only `env` code
// that signs in; `env.ts` stays offline and delegates here.
//
// ⛔ A VALUE NEVER REACHES STDOUT, STDERR, THE JSON OR AN ERROR MESSAGE. Values are resolved in
// memory (`env/machine-values.ts`), sent in request bodies, and dropped. Every printed line is built
// from names, counts and the cloud's own name-only answers.
//
// The file is the allowlist: only declared names are sent, and its `secret` flag picks the route.
// Secrets go in one `POST /me/secrets/import` and plain values one `POST /me/env-vars` each, the same
// routes and bodies `catalyst secret import` and `catalyst var import` use. Secrets already stored are
// kept (the import route's `name_exists`); plain variables are replaced, as `var import` does.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import { loadConfig, type Ctx, type CustomerConfig } from "./config.js";
import { loadContract } from "./contract.js";
import { UsageError } from "./errors.js";
import { repositoryNames } from "./env/draft.js";
import type { MachineOptions } from "./env/machine.js";
import { resolveMachineValues, type ValueSource } from "./env/machine-values.js";
import { readDeclaredVariables, validateSettingsToml } from "./env/settings-toml.js";
import { readLocalRepositoryName } from "./onboard-settings-context.js";
import { confirmYesNo, stdinIsTty } from "./prompt.js";
import { ACCEPT, IMPORT_REASONS, refusalLine, SECRETS_IMPORT_PATH, type ImportResponse } from "./secret.js";
import { apiClient, type ApiClient } from "./transport.js";
import { ENV_VARS_PATH } from "./var.js";

const DESTINATION = ".catalyst/catalyst.toml";
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const SOURCE_ORDER: ValueSource[] = [".envrc", "direnv environment", "~/.claude.json", "shell environment"];

/** Shapes a credential has even when its name does not say so. Checked for plain-declared values only. */
const CREDENTIAL_RES = [
  /^gh[pousr]_[A-Za-z0-9]{16,}/,
  /^github_pat_/,
  /^glpat-/,
  /^sk-[A-Za-z0-9_-]{8,}/,
  /^sk_(?:live|test)_/,
  /^xox[a-z]-/,
  /^(?:AKIA|ASIA)[A-Z0-9]{12,}/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /-----BEGIN/,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
];

export interface EnvImportDeps {
  client?: Pick<ApiClient, "postJson">;
  /** Default: the workspace contract's merge.repositories. */
  repositories?: () => Promise<ReadonlyArray<{ repoId: string; owner: string; name: string }>>;
  /** Default: this checkout's GitHub origin, read from local git config only. */
  repoName?: (root: string) => Promise<string | null>;
  isTty?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  machine?: Partial<MachineOptions>;
}

export interface ImportReport {
  state: "stored" | "confirmation_required" | "refused";
  repo: string | null;
  from: string[];
  stored: { secrets: string[]; variables: string[] };
  updated: string[];
  kept: string[];
  noValue: Array<{ name: string; computed: boolean }>;
  notStored: Array<{ name: string; reason: string }>;
  unknown?: string[];
  refusal?: string;
}

interface WriteReply {
  created?: boolean;
  error?: string;
  message?: string;
}

function emptyReport(state: ImportReport["state"], repo: string | null, refusal?: string): ImportReport {
  return {
    state,
    repo,
    from: [],
    stored: { secrets: [], variables: [] },
    updated: [],
    kept: [],
    noValue: [],
    notStored: [],
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** A secret value the dotenv import line carries unchanged under every parser that reads it. */
export function lineSafe(value: string): boolean {
  return !/[\r\n]/.test(value) && value === value.trim() && !/^["']/.test(value) && !/\s#/.test(value);
}

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_RES.some((re) => re.test(value));
}

async function resolveRepo(root: string, flag: string | undefined, deps: EnvImportDeps): Promise<string | null> {
  if (flag !== undefined) {
    if (!REPO_RE.test(flag)) throw new UsageError(`--repo must be owner/name (got "${flag}")`);
    return flag;
  }
  return (deps.repoName ?? readLocalRepositoryName)(root);
}

function sourceText(from: readonly string[]): string {
  const words = from.map((source) => (source === "direnv environment" && from.includes(".envrc") ? "its direnv environment" : source));
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** One line per name that has a value: the name, secret or plain, and where the value came from. No value. */
export function valueLines(
  withValue: ReadonlyArray<{ name: string; secret: boolean }>,
  values: ReadonlyMap<string, { from: ValueSource }>,
): string[] {
  return withValue.map(({ name, secret }) => `  ${name} (${secret ? "secret" : "plain"}) from ${values.get(name)?.from ?? "?"}`);
}

interface ImportInput {
  root: string;
  repo: string;
  cfg: CustomerConfig;
  ctx: Ctx;
  deps: EnvImportDeps;
  declared: ReadonlyArray<{ name: string; secret: boolean }>;
  confirm: "ask" | "yes";
  json: boolean;
}

/** Resolve, ask, send, report. Human lines go to stdout unless `json`; the caller prints the JSON. */
async function importValues(input: ImportInput): Promise<{ code: number; report: ImportReport }> {
  const { root, repo, cfg, ctx, deps, declared } = input;
  const say = (line: string) => { if (!input.json) ctx.stdout(line); };
  const machine: MachineOptions = { home: ctx.home, env: ctx.env, ...deps.machine };
  // The same repository names the draft saw, so a header variable resolves only where it was drafted.
  const repository = repositoryNames(root);
  const resolved = resolveMachineValues(root, machine, declared, repository.state === "valid" ? repository.names : new Set());
  const fromSet = new Set<ValueSource>();
  for (const { from } of resolved.values.values()) {
    if (from === "direnv environment") fromSet.add(".envrc");
    fromSet.add(from);
  }
  const from = SOURCE_ORDER.filter((source) => fromSet.has(source));
  const report: ImportReport = { ...emptyReport("stored", repo), from, noValue: resolved.noValue };
  const secretFlag = new Map(declared.map(({ name, secret }) => [name, secret]));
  const withValue = declared.filter(({ name }) => resolved.values.has(name));
  const secretCount = withValue.filter(({ secret }) => secret).length;

  say(`This computer has values for ${withValue.length} of the ${declared.length} declared names${withValue.length > 0 ? ` (${sourceText(from)})` : ""}.`);
  if (withValue.length === 0) {
    renderNoValue(say, report, repo, secretFlag);
    return { code: 0, report };
  }
  for (const line of valueLines(withValue, resolved.values)) say(line);
  if (input.confirm === "ask") {
    if (input.json || !(deps.isTty ?? stdinIsTty)()) {
      say("env import stores values in Catalyst; pass --yes to confirm without a terminal. Nothing was stored.");
      return { code: 1, report: { ...report, state: "confirmation_required" } };
    }
    const question = `Store them for ${repo} now? ${secretCount} as secrets, ${withValue.length - secretCount} as plain variables. Values go to Catalyst and are never printed. Secrets already stored are kept; plain variables already stored are replaced. [y/N] `;
    if (!(await (deps.confirm ?? confirmYesNo)(question))) {
      say("Nothing was stored. Next: catalyst env import stores this computer's values for these names. It signs in and asks first.");
      return { code: 0, report: { ...emptyReport("refused", repo, "declined"), from, noValue: resolved.noValue } };
    }
  }

  const repositories = await (deps.repositories ?? (async () => (await loadContract(ctx, cfg)).doc.merge.repositories))();
  const [owner, name] = repo.toLowerCase().split("/");
  const entry = repositories.find((r) => r.owner.toLowerCase() === owner && r.name.toLowerCase() === name);
  if (entry === undefined) {
    const refusal = `${repo} is not a repository of this workspace; nothing was stored. Register it first with catalyst onboard --team <KEY> --repo ${repo}`;
    say(refusal);
    return { code: 1, report: { ...report, state: "refused", refusal } };
  }

  const secretLines: string[] = [];
  const plain: Array<{ name: string; value: string }> = [];
  for (const { name: declaredName, secret } of withValue) {
    const found = resolved.values.get(declaredName);
    if (found === undefined) continue;
    const value = found.value;
    if (secret) {
      if (lineSafe(value)) secretLines.push(`${declaredName}=${value}`);
      else report.notStored.push({ name: declaredName, reason: `its value has a line break, spaces at either end, a leading quote or " #", which an import line cannot carry; store it with: catalyst secret set ${declaredName} --repo ${repo}` });
    } else if (looksLikeCredential(value)) {
      report.notStored.push({ name: declaredName, reason: "its value looks like a credential, but the file declares it plain; set secret = true for it and run catalyst env import again" });
    } else plain.push({ name: declaredName, value });
  }

  const client = deps.client ?? apiClient(cfg, ctx);
  if (secretLines.length > 0) {
    const res = await client.postJson<ImportResponse>(
      SECRETS_IMPORT_PATH,
      { repo, text: `${secretLines.join("\n")}\n`, rotateExisting: [], source: `env import: ${from.join(", ")}` },
      { accept: ACCEPT },
    );
    if (res.status !== 200) {
      const refusal = refusalLine(res.status, res.body, repo);
      say(refusal);
      return { code: 1, report: { ...report, state: "refused", refusal } };
    }
    report.stored.secrets.push(...(res.body.created ?? []), ...(res.body.rotated ?? []));
    for (const error of res.body.errors ?? []) {
      if (error.reason === "name_exists") report.kept.push(error.name);
      else report.notStored.push({ name: error.name, reason: IMPORT_REASONS[error.reason] ?? error.reason });
    }
  }
  for (const [index, item] of plain.entries()) {
    let reply: { status: number; body: WriteReply };
    try {
      reply = await client.postJson<WriteReply>(ENV_VARS_PATH, { scope: "repo", repoId: entry.repoId, name: item.name, value: item.value }, { accept: ACCEPT });
    } catch {
      report.unknown = plain.slice(index).map(({ name: unknownName }) => unknownName);
      break;
    }
    if (reply.status !== 200 && reply.status !== 201) {
      report.notStored.push({ name: item.name, reason: reply.body.message ?? reply.body.error ?? `HTTP ${reply.status}` });
      continue;
    }
    report.stored.variables.push(item.name);
    if (!reply.body.created) report.updated.push(item.name);
  }

  const storedCount = report.stored.secrets.length + report.stored.variables.length;
  say(storedCount === 0
    ? `Stored nothing for ${repo}.`
    : `Stored ${storedCount} values for ${repo}: ${report.stored.secrets.length} secrets, ${report.stored.variables.length} plain variables.`);
  if (report.updated.length > 0) say(`  updated (were already stored): ${report.updated.join(", ")}`);
  if (report.kept.length > 0) say(`Kept ${report.kept.length} secrets already stored for ${repo}: ${report.kept.join(", ")} (replace one with: catalyst secret set NAME --repo ${repo})`);
  for (const item of report.notStored) say(`Not stored: ${item.name} (${item.reason})`);
  if (report.unknown !== undefined) say(`Stopped: the write did not answer, so these are not confirmed: ${report.unknown.join(", ")}. Run catalyst env import again.`);
  renderNoValue(say, report, repo, secretFlag);
  return { code: report.notStored.length > 0 || report.unknown !== undefined ? 1 : 0, report };
}

function renderNoValue(say: (line: string) => void, report: ImportReport, repo: string, secretFlag: ReadonlyMap<string, boolean>): void {
  if (report.noValue.length === 0) {
    say("Every declared name had a value on this computer.");
    return;
  }
  const count = report.noValue.length;
  say(`No value on this computer for ${count} declared ${count === 1 ? "name" : "names"} (looked in .envrc, its direnv environment and ~/.claude.json):`);
  for (const { name, computed } of report.noValue) {
    const store = secretFlag.get(name) ? `catalyst secret set ${name} --repo ${repo}` : `catalyst var set ${name} --repo ${repo}`;
    say(computed
      ? `  ${name}: .envrc computes it. Run catalyst env import in a shell where direnv has loaded this repository, or store it with: ${store}`
      : `  ${name}: store it with: ${store}`);
  }
}

/** `catalyst env import`: store this computer's values for the names the reviewed file declares. */
export async function cmdEnvImport(args: ParsedArgs, ctx: Ctx, deps: EnvImportDeps = {}): Promise<number> {
  const rest = positionals(args).slice(1);
  if (rest.length > 0) throw new UsageError("env import takes no positional arguments; use --root DIR");
  const json = Boolean(args.json);
  const refuse = (refusal: string, state: ImportReport["state"] = "refused", repo: string | null = null): number => {
    if (json) ctx.stdout(JSON.stringify(emptyReport(state, repo, refusal)));
    else ctx.stderr(refusal);
    return 1;
  };
  const root = resolve(flagString(args, "root") ?? ".");
  const cfg = loadConfig(ctx.home);
  if (cfg === null) return refuse("env import stores values in Catalyst; sign in with catalyst login first. Nothing was stored.");
  const repo = await resolveRepo(root, flagString(args, "repo"), deps);
  if (repo === null) throw new UsageError("env import needs --repo owner/name: this checkout has no GitHub origin to read it from");

  let text: string;
  try {
    text = readFileSync(join(root, DESTINATION), "utf8");
  } catch {
    return refuse(`no ${DESTINATION} found in this repository; draft one with catalyst env draft --write`, "refused", repo);
  }
  const declared = readDeclaredVariables(text);
  if (declared === null) {
    const checked = validateSettingsToml(text);
    const errors = checked.state === "invalid" ? checked.errors : [`no [environment] table in ${DESTINATION}`];
    return refuse(errors.map((error) => `${DESTINATION}: ${error}`).join("\n"), "refused", repo);
  }
  if (!json) ctx.stdout(`Reading ${DESTINATION}: ${declared.length} declared names (${declared.filter(({ secret }) => secret).length} secret).`);
  const result = await importValues({ root, repo, cfg, ctx, deps, declared, confirm: flagBool(args, "yes") ? "yes" : "ask", json });
  if (json) ctx.stdout(JSON.stringify(result.report));
  return result.code;
}

/** After `env draft --write`: store the values now (`yes`), or ask first in a terminal (`ask`). */
export async function offerMachineImport(input: {
  root: string;
  toml: string;
  args: ParsedArgs;
  ctx: Ctx;
  deps?: EnvImportDeps;
  mode: "ask" | "yes";
}): Promise<{ code: number; report?: ImportReport }> {
  const { root, args, ctx, mode } = input;
  const deps = input.deps ?? {};
  const json = Boolean(args.json);
  const failCode = mode === "yes" ? 1 : 0;
  const declared = readDeclaredVariables(input.toml) ?? [];
  if (declared.length === 0) return { code: 0 };
  const say = (line: string) => { if (json) ctx.stderr(line); else ctx.stdout(line); };
  const cfg = loadConfig(ctx.home);
  if (cfg === null) {
    const refusal = "To store this computer's values for these names, sign in with catalyst login, then run: catalyst env import";
    say(refusal);
    return { code: failCode, report: emptyReport("refused", null, refusal) };
  }
  const repo = await resolveRepo(root, flagString(args, "repo"), deps);
  if (repo === null) {
    const refusal = "To store this computer's values, run: catalyst env import --repo owner/name (this checkout has no GitHub origin to read the repository from)";
    say(refusal);
    return { code: failCode, report: emptyReport("refused", null, refusal) };
  }
  if (!json) ctx.stdout("");
  return importValues({ root, repo, cfg, ctx, deps, declared, confirm: mode, json });
}
