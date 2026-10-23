// secret.ts — `catalyst secret set|import`: put a repository's secrets into the cloud from the
// terminal, as the person who is logged in (CTC-3549). The cloud gates both on an admin or owner seat,
// encrypts the value, and records who wrote it and where it came from, never the value itself.
//
// ⛔ A VALUE NEVER REACHES STDOUT, STDERR OR AN ERROR MESSAGE. It is read (stdin, a hidden prompt, or
// the output of a local command), sent in one request body, and dropped. The cloud's responses carry
// names and versions only, and every line this verb prints is built from those. A command's own
// stdout is the value, so it is captured and never echoed; its stderr passes through untouched (a
// sign-in prompt from `op` has to reach the person).
//
// ⭐ `--command` RUNS ON THIS MACHINE, in the person's own shell, with their own environment. That is
// the point: `op read op://…` resolves against the 1Password session on the laptop, and the cloud
// only ever sees the result. The command TEXT goes to the cloud as the audit `source`, so the log can
// say where a value came from without holding it. Do not put a value in the command line itself.
//
// The routes are the browser's own (`/me/secrets`, `/me/secrets/import`): the cloud admits a personal
// key or CLI login on them under the same gates as a session. They are not in the contract's
// `routes[]` table (that table is the /api/v1/agent/* family), so the path is fixed here, and an
// older cloud that still wants a session answers 401 — which this verb names as "needs a newer cloud".
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { promptSecret, stdinIsTty } from "./prompt.js";
import { apiClient } from "./transport.js";
import { filterEnvFileNames } from "./env/parse-env.js";

export const SECRETS_PATH = "/me/secrets";
export const SECRETS_IMPORT_PATH = "/me/secrets/import";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** What the cloud says about the repo's approved declaration after a write. Names only. */
export interface DeclaredStatus {
  declared: string[];
  missing: string[];
}

interface SetResponse {
  secret?: { name?: string };
  version?: number;
  created?: boolean;
  declared?: DeclaredStatus | null;
  error?: string;
  message?: string;
}

export interface ImportResponse {
  created?: string[];
  rotated?: string[];
  errors?: Array<{ name: string; reason: string }>;
  declared?: DeclaredStatus | null;
  error?: string;
  message?: string;
}

export interface SecretDeps {
  readStdin?: () => Promise<string>;
  isTty?: () => boolean;
  prompt?: (question: string) => Promise<string>;
  /** Run a command on this machine and return its stdout. Injected by tests only when they must. */
  runCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Why an import line was not stored, in words a person can act on. */
export const IMPORT_REASONS: Record<string, string> = {
  name_exists: "already set for this repository; pass --rotate <NAME> to replace it",
  name_taken_by_env_var: "already a plain environment variable; a name is a secret or a variable, never both",
  invalid_name: "not an env-style name (A-Z, 0-9 and _, starting with a letter)",
  invalid_value: "the value is empty",
  config_rotation_unconfirmed: "the existing entry is a plain variable; change it with catalyst var set",
  probe_refused: "the value failed this kind's check",
};

/** A command's stdout, minus the one trailing newline almost every command prints after a value. */
export function trimOneNewline(s: string): string {
  return s.endsWith("\r\n") ? s.slice(0, -2) : s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Run `command` through the person's shell. Stdout is captured (it is the value); stderr passes
 *  through so an interactive sign-in can reach them. A non-zero exit stores nothing. */
export function runLocalCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
    const child = spawn(shell, ["-c", command], { env, stdio: ["inherit", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => reject(new CliError(`could not run the command: ${err.message}; nothing was stored`, "command-failed", 1)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new CliError(`the command ${signal ? `was killed by ${signal}` : `exited ${code}`}; nothing was stored`, "command-failed", 1));
    });
  });
}

function requireRepo(args: ParsedArgs, verb: string): string {
  const repo = flagString(args, "repo");
  if (repo === undefined) throw new UsageError(`secret ${verb} needs --repo <owner/name>`);
  if (!REPO_RE.test(repo)) throw new UsageError(`--repo must be owner/name (got "${repo}")`);
  return repo;
}

/** The cloud's refusal, in its own words, plus what to do for the two we can explain. */
export function refusalLine(status: number, body: { error?: string; message?: string }, repo: string): string {
  if (status === 401) {
    return "refused (401): the cloud did not accept your credential here. If `catalyst me` works, this cloud predates secret writes from the CLI and needs a newer release; otherwise log in again.";
  }
  if (status === 404) return `refused (404): ${repo} is not a repository of this workspace. Register it first with catalyst onboard --team <KEY> --repo ${repo}`;
  if (status === 409 && body.error === "registry_not_migrated") {
    return "refused (409): the cloud's secret audit is not set up yet, so nothing was stored. Tell your Catalyst operator.";
  }
  return `refused (${status}): ${body.message ?? body.error ?? "no reason given"}`;
}

function renderDeclared(declared: DeclaredStatus | null | undefined, repo: string): string[] {
  if (declared === undefined) return [];
  if (declared === null) return [`${repo} has no approved environment declaration, so there is no declared list to check against`];
  if (declared.declared.length === 0) return [`${repo}'s approved declaration names no secrets`];
  if (declared.missing.length === 0) return [`every declared secret has a value (${declared.declared.length})`];
  return [`declared but still without a value (${declared.missing.length}): ${declared.missing.join(", ")}`];
}

export const ACCEPT = [400, 401, 403, 404, 409, 422];

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function cmdSecret(args: ParsedArgs, ctx: Ctx, deps: SecretDeps = {}): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub !== "set" && sub !== "import") throw new UsageError(`unknown secret subcommand "${sub ?? ""}": set | import`);
  if (rest.length !== 1) {
    throw new UsageError(sub === "set" ? "secret set takes one NAME" : "secret import takes one file (a .env file)");
  }
  const repo = requireRepo(args, sub);
  return sub === "set" ? setOne(args, ctx, deps, rest[0], repo) : importFile(args, ctx, rest[0], repo, requestedNames(args));
}

function requestedNames(args: ParsedArgs): string[] | undefined {
  const raw = flagList(args, "names");
  if (raw.length === 0) return undefined;
  const names = [...new Set(raw.flatMap((part) => part.split(",").map((name) => name.trim())).filter(Boolean))].sort();
  if (names.length === 0) throw new UsageError("--names needs one or more variable names");
  const invalid = names.find((name) => !NAME_RE.test(name));
  if (invalid !== undefined) throw new UsageError(`--names includes an invalid env-style name: ${invalid}`);
  return names;
}

async function setOne(args: ParsedArgs, ctx: Ctx, deps: SecretDeps, name: string, repo: string): Promise<number> {
  if (!NAME_RE.test(name)) throw new UsageError(`"${name}" is not an env-style name (A-Z, 0-9 and _, starting with a letter)`);
  if (flagList(args, "rotate").length > 0) throw new UsageError("--rotate belongs to secret import; secret set always replaces the value");
  const command = flagString(args, "command");
  const cfg = requireConfig(ctx);

  let value: string;
  let source: string;
  if (command !== undefined) {
    if (command.trim() === "") throw new UsageError("--command is empty");
    value = trimOneNewline(await (deps.runCommand ?? runLocalCommand)(command, ctx.env));
    source = `command: ${command}`;
  } else if ((deps.isTty ?? stdinIsTty)()) {
    value = await (deps.prompt ?? ((q: string) => promptSecret(q)))(`Value for ${name} (input hidden): `);
    source = "prompt";
  } else {
    value = trimOneNewline(await (deps.readStdin ?? readStdinText)());
    source = "stdin";
  }
  if (value === "") throw new CliError(`the value for ${name} is empty; nothing was stored`, "empty-value", 1);

  const res = await apiClient(cfg, ctx).postJson<SetResponse>(
    SECRETS_PATH,
    { name, value, scope: "repo", repo, source },
    { accept: ACCEPT },
  );
  const body = res.body;
  if (res.status !== 200 && res.status !== 201) {
    if (args.json) ctx.stdout(JSON.stringify({ status: res.status, error: body.error ?? null, message: body.message ?? null }));
    else ctx.stdout(refusalLine(res.status, body, repo));
    return 1;
  }
  if (args.json) {
    ctx.stdout(JSON.stringify({ name, repo, version: body.version ?? null, created: body.created ?? null, declared: body.declared ?? null }));
    return 0;
  }
  ctx.stdout(`stored ${name} for ${repo} (version ${body.version ?? "?"}, ${body.created ? "new" : "replaced"}; from ${command !== undefined ? "the command" : source})`);
  for (const line of renderDeclared(body.declared, repo)) ctx.stdout(line);
  return 0;
}

async function importFile(args: ParsedArgs, ctx: Ctx, file: string, repo: string, names?: string[]): Promise<number> {
  if (flagString(args, "command") !== undefined) throw new UsageError("--command belongs to secret set");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const filtered = names === undefined ? { text, found: [] as string[] } : filterEnvFileNames(text, new Set(names));
  if (names !== undefined) text = filtered.text;
  const cfg = requireConfig(ctx);
  const rotate = flagList(args, "rotate");
  const res = await apiClient(cfg, ctx).postJson<ImportResponse>(
    SECRETS_IMPORT_PATH,
    { repo, text, rotateExisting: rotate, source: `import: ${basename(file)}` },
    { accept: ACCEPT },
  );
  const body = res.body;
  if (res.status !== 200) {
    if (args.json) ctx.stdout(JSON.stringify({ status: res.status, error: body.error ?? null, message: body.message ?? null }));
    else ctx.stdout(refusalLine(res.status, body, repo));
    return 1;
  }
  const created = body.created ?? [];
  const rotated = body.rotated ?? [];
  const errors = body.errors ?? [];
  if (args.json) {
    ctx.stdout(JSON.stringify({ repo, created, rotated, errors, declared: body.declared ?? null, ...(names === undefined ? {} : { requested: names, notFoundInFile: names.filter((name) => !filtered.found.includes(name)) }) }));
    return errors.length > 0 ? 1 : 0;
  }
  const stored = created.length + rotated.length;
  ctx.stdout(stored === 0 ? `stored nothing for ${repo}` : `stored ${stored} for ${repo}: ${[...created, ...rotated].join(", ")}`);
  if (rotated.length > 0) ctx.stdout(`  replaced: ${rotated.join(", ")}`);
  if (names !== undefined) {
    const missing = names.filter((name) => !filtered.found.includes(name));
    if (missing.length > 0) ctx.stdout(`not found in ${basename(file)}: ${missing.join(", ")}`);
  }
  for (const e of errors) ctx.stdout(`not stored: ${e.name} (${IMPORT_REASONS[e.reason] ?? e.reason})`);
  for (const line of renderDeclared(body.declared, repo)) ctx.stdout(line);
  return errors.length > 0 ? 1 : 0;
}
