// env.ts — `catalyst env inventory` / `env check`: a LOCAL, OFFLINE, repo-scoped reporter and
// validator. Unlike every other verb in this file's siblings, `cmdEnv` never calls `requireConfig` or
// `apiClient` — it needs neither a login nor a network call, which is the whole point of the feature:
// a person reviews what a repository declares without connecting anything first.
//
// The two exceptions store values and so sign in: `env import` and `env draft --write`'s offer to
// store this computer's values. Both are delegated to `env-import.ts`; this module itself stays offline.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { cmdEnvImport, offerMachineImport, type EnvImportDeps, type ImportReport } from "./env-import.js";
import { validateSettingsToml } from "./env/settings-toml.js";
import { convertLegacyEnvironmentJson } from "./env/legacy.js";
import { draftEnvironment } from "./env/draft.js";
import { inventoryRepo } from "./env/inventory.js";
import type { MachineScan } from "./env/machine.js";
import { inventoryToJson, renderInventory } from "./env/render.js";
import type { ScanDeps } from "./env/types.js";
import { UsageError } from "./errors.js";
import { stdinIsTty } from "./prompt.js";
import { validateFullSettings } from "../vendor/settings/index.js";

export type EnvDeps = Partial<ScanDeps> & {
  writeFile?: (path: string, content: string) => void;
  /** `env import` and `env draft --write`'s offer to store values. */
  import?: EnvImportDeps;
};

const NEXT_IMPORT_LINE = "Next: catalyst env import stores this computer's values for these names. It signs in and asks first.";

export async function cmdEnv(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EnvDeps = {},
): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub === undefined)
    throw new UsageError("env needs a subcommand: inventory | check | migrate | draft | import");

  if (sub === "import") return cmdEnvImport(args, ctx, deps.import ?? {});

  if (sub === "draft") {
    if (rest.length > 0) throw new UsageError("env draft takes no positional arguments; use --root DIR");
    const importValues = flagBool(args, "import-values");
    if (importValues && !flagBool(args, "write")) {
      throw new UsageError("--import-values needs --write; for an existing .catalyst/catalyst.toml run: catalyst env import");
    }
    const root = resolve(flagString(args, "root") ?? ".");
    const target = join(root, ".catalyst/catalyst.toml");
    const draft = draftEnvironment(root, deps, { machine: { home: ctx.home, env: ctx.env } });
    if (draft.state === "invalid") {
      if (args.json) ctx.stdout(JSON.stringify(draft));
      else for (const error of draft.errors) ctx.stderr(error);
      return 1;
    }
    const summary = {
      state: "valid" as const,
      names: draft.names,
      secretNames: draft.secretNames,
      setupCount: draft.setup.length,
      verifyCount: draft.verify.length,
      sources: draft.sources,
      destination: ".catalyst/catalyst.toml",
      toml: draft.toml,
      mcpServers: draft.mcpServers.map(({ name, configName, scope, url, headers }) => ({ name, configName, scope, url, headers })),
      machine: machineJson(draft.machine),
    };
    const write = flagBool(args, "write");
    if (write && existsSync(target)) {
      ctx.stderr(`${summary.destination} already exists; no file was written. Review the draft with --diff and merge it by hand.`);
      ctx.stderr("To store this computer's values for the names it declares, run: catalyst env import");
      return 1;
    }
    if (write) {
      const checked = validateSettingsToml(draft.toml);
      if (checked.state !== "valid") {
        ctx.stderr(`draft failed local validation: ${checked.state === "invalid" ? checked.errors.join("; ") : "no environment table"}`);
        return 1;
      }
      if (!validateFullSettings(`[project]\nlinear_team = "DRAFT"\n\n${draft.toml}`).ok) {
        ctx.stderr("draft failed Catalyst's settings check; no file was written");
        return 1;
      }
      if (deps.writeFile) deps.writeFile(target, draft.toml);
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, draft.toml, { encoding: "utf8", flag: "wx" });
      }
    }
    if (args.json) {
      // The import's answer joins the one JSON object, so it runs first; its lines go to stderr.
      const offered = write ? await afterWrite(root, draft, args, ctx, deps, importValues) : { code: 0 };
      ctx.stdout(JSON.stringify({ ...summary, written: write, ...(offered.report === undefined ? {} : { import: offered.report }) }));
      return offered.code;
    }
    if (flagBool(args, "diff")) {
      ctx.stdout(`--- /dev/null\n+++ b/${summary.destination} (draft)\n@@\n${draft.toml.split("\n").filter(Boolean).map((line) => `+${line}`).join("\n")}`);
    } else {
      ctx.stdout(`Drafted ${summary.destination} from ${draft.sources.length ? draft.sources.join(", ") : "no environment sources"}.`);
      ctx.stdout(`Names: ${draft.names.length} (${draft.secretNames.length} secret; all optional)`);
      for (const line of machineLines(draft.machine, draft.mcpServers)) ctx.stdout(line);
      ctx.stdout(`Setup: ${draft.setup.length}; verify: ${draft.verify.length}`);
      ctx.stdout(draft.toml);
    }
    if (!write) return 0;
    ctx.stdout(`Wrote ${summary.destination}; review and commit it through your repository's pull request.`);
    return (await afterWrite(root, draft, args, ctx, deps, importValues)).code;
  }

  if (sub === "migrate") {
    if (rest.length > 1)
      throw new UsageError(
        `env migrate takes at most one file (got an extra "${rest[1]}")`,
      );
    const file = rest[0] ?? "catalyst.env.json";
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      ctx.stderr(`could not read legacy declaration ${file}`);
      return 1;
    }
    const result = convertLegacyEnvironmentJson(text);
    if (result.state === "invalid") {
      if (args.json) ctx.stdout(JSON.stringify(result));
      else for (const error of result.errors) ctx.stderr(error);
      return 1;
    }
    if (args.json) ctx.stdout(JSON.stringify(result));
    else ctx.stdout(result.toml);
    return 0;
  }

  if (sub === "inventory") {
    if (rest.length > 1)
      throw new UsageError(
        `env inventory takes at most one path (got an extra "${rest[1]}")`,
      );
    const root = resolve(rest[0] ?? ".");
    // C-3: walkRepo swallows a readdir failure and returns [], so without this an unreadable or
    // mistyped path printed three empty groups and exited 0 — a typo that reads as "declares nothing".
    let stat: Stats;
    try {
      stat = statSync(root);
    } catch {
      ctx.stderr(
        `${root} does not exist — env inventory takes a path to a repository`,
      );
      return 1;
    }
    if (!stat.isDirectory()) {
      ctx.stderr(
        `${root} is not a directory — env inventory takes a path to a repository`,
      );
      return 1;
    }
    const inv = inventoryRepo(root, deps);
    if (args.json) ctx.stdout(JSON.stringify(inventoryToJson(inv)));
    else for (const line of renderInventory(inv)) ctx.stdout(line);
    return 0;
  }

  if (sub === "check") {
    const file = rest[0] ?? ".catalyst/catalyst.toml";
    if (rest.length > 1)
      throw new UsageError(
        `env check takes exactly one file (got an extra "${rest[1]}")`,
      );
    if (file.endsWith("catalyst.env.json")) {
      const message =
        "catalyst.env.json is a legacy declaration and is no longer read; validate .catalyst/catalyst.toml instead";
      if (args.json)
        ctx.stdout(JSON.stringify({ state: "invalid", errors: [message] }));
      else ctx.stderr(message);
      return 1;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (rest[0] === undefined && !existsSync("catalyst.env.json")) {
        if (args.json)
          ctx.stdout(JSON.stringify({ state: "no-source", errors: [] }));
        else ctx.stdout("no .catalyst/catalyst.toml found in this repository");
        return 0;
      }
      if (rest[0] === undefined && existsSync("catalyst.env.json")) {
        const message =
          "No .catalyst/catalyst.toml found; this repository has a legacy catalyst.env.json, which is no longer read. Convert it to the [environment] table in .catalyst/catalyst.toml.";
        if (args.json)
          ctx.stdout(JSON.stringify({ state: "invalid", errors: [message] }));
        else ctx.stderr(message);
        return 1;
      }
      ctx.stderr(
        `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    const result = validateSettingsToml(text);
    if (args.json) ctx.stdout(JSON.stringify(result));
    else if (result.state === "valid")
      ctx.stdout(
        `valid — ${file} contains ${result.variableNames.length} environment variable names`,
      );
    else if (result.state === "no-source")
      ctx.stdout(`no [environment] table in ${file}`);
    else for (const error of result.errors) ctx.stderr(`${file}: ${error}`);
    return result.state === "invalid" ? 1 : 0;
  }

  throw new UsageError(`unknown env subcommand "${sub}": inventory | check | migrate | draft | import`);
}

/** After a successful write: store now (`--import-values`), ask in a terminal, or name the next command. */
async function afterWrite(
  root: string,
  draft: { names: string[]; toml: string },
  args: ParsedArgs,
  ctx: Ctx,
  deps: EnvDeps,
  importValues: boolean,
): Promise<{ code: number; report?: ImportReport }> {
  if (draft.names.length === 0) return { code: 0 };
  const toml = draft.toml;
  const importDeps = deps.import ?? {};
  if (importValues) return offerMachineImport({ root, toml, args, ctx, deps: importDeps, mode: "yes" });
  if (!args.json && (importDeps.isTty ?? stdinIsTty)()) return offerMachineImport({ root, toml, args, ctx, deps: importDeps, mode: "ask" });
  if (args.json) ctx.stderr(NEXT_IMPORT_LINE);
  else ctx.stdout(NEXT_IMPORT_LINE);
  return { code: 0 };
}

function machineJson(machine: MachineScan | null) {
  if (machine === null) return null;
  return {
    envrc: machine.envrc === null ? null : {
      exported: machine.envrc.exported.map(({ name }) => name),
      notRead: machine.envrc.notRead,
      skippedNames: machine.envrc.skippedNames,
    },
    claudeJson: machine.claude === null ? null : {
      servers: machine.claude.servers.map(({ name }) => name),
      notDrafted: machine.claude.notDrafted,
      ...(machine.claude.note === undefined ? {} : { note: machine.claude.note }),
    },
    notes: machine.notes,
  };
}

/** What came from this computer and what was left out, names and reasons only. */
function machineLines(machine: MachineScan | null, servers: ReadonlyArray<{ name: string; configName: string; derived: ReadonlyArray<{ variable: string; header: string }> }>): string[] {
  if (machine === null || (machine.envrc === null && machine.claude === null && machine.notes.length === 0)) return [];
  const lines = ["From this computer:"];
  if (machine.envrc !== null) {
    const notRead = machine.envrc.notRead.length === 0
      ? ""
      : ` Not read: ${machine.envrc.notRead.map(({ line, reason }) => `line ${line} ${reason}`).join(", ")}; names those lines load are not drafted.`;
    lines.push(`  .envrc: ${machine.envrc.exported.length} exported names.${notRead}`);
    if (machine.envrc.skippedNames.length > 0) lines.push(`    Not drafted (settings of this computer): ${machine.envrc.skippedNames.join(", ")}`);
  }
  if (machine.claude !== null) {
    if (machine.claude.note !== undefined) lines.push(`  ${machine.claude.note}`);
    else {
      const names = servers.map(({ name, configName }) => (name === configName ? name : `${name} (from ${JSON.stringify(configName)})`));
      lines.push(`  ~/.claude.json: ${servers.length} HTTP MCP servers${names.length ? ` (${names.join(", ")})` : ""}. Each header names a variable; no header value is copied.`);
    }
    for (const server of servers) {
      for (const { variable, header } of server.derived) {
        lines.push(`    ${server.name}: its ${header} header held a value; drafted as $${variable}, which env import reads from ~/.claude.json`);
      }
    }
    for (const { name, reason } of machine.claude.notDrafted) lines.push(`    Not drafted: ${name} (${reason})`);
  }
  for (const note of machine.notes) lines.push(`  ${note}`);
  return lines;
}
