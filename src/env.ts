// env.ts — `catalyst env inventory` / `check` / `migrate` / `draft`: a LOCAL, OFFLINE, repo-scoped
// reporter and validator. Unlike every other verb in this file's siblings, those four never call
// `requireConfig` or `apiClient` — they need neither a login nor a network call, which is the whole
// point of the feature: a person reviews what a repository declares without connecting anything first.
// `env shell` (env/shell.ts) talks to Docker, and asks the cloud only when a credential-free download
// of the image is refused; Catalyst's own image needs no login.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { validateSettingsToml } from "./env/settings-toml.js";
import { convertLegacyEnvironmentJson } from "./env/legacy.js";
import { draftEnvironment } from "./env/draft.js";
import { inventoryRepo } from "./env/inventory.js";
import { inventoryToJson, renderInventory } from "./env/render.js";
import { runEnvShell, type EnvShellDeps } from "./env/shell.js";
import type { ScanDeps } from "./env/types.js";
import { UsageError } from "./errors.js";

export type EnvDeps = Partial<ScanDeps> & {
  writeFile?: (path: string, content: string) => void;
  shell?: EnvShellDeps;
};

export async function cmdEnv(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EnvDeps = {},
): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub === undefined)
    throw new UsageError("env needs a subcommand: inventory | check | migrate | draft | shell");

  if (sub === "shell") return await runEnvShell(args, ctx, deps.shell ?? {});

  if (sub === "draft") {
    if (rest.length > 0) throw new UsageError("env draft takes no positional arguments; use --root DIR");
    const root = resolve(flagString(args, "root") ?? ".");
    const target = join(root, ".catalyst/catalyst.toml");
    const draft = draftEnvironment(root, deps);
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
    };
    const write = flagBool(args, "write");
    if (write && existsSync(target)) {
      ctx.stderr(`${summary.destination} already exists; no file was written. Review the draft with --diff and merge it by hand.`);
      return 1;
    }
    if (write) {
      const checked = validateSettingsToml(draft.toml);
      if (checked.state !== "valid") {
        ctx.stderr(`draft failed local validation: ${checked.state === "invalid" ? checked.errors.join("; ") : "no environment table"}`);
        return 1;
      }
      if (deps.writeFile) deps.writeFile(target, draft.toml);
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, draft.toml, { encoding: "utf8", flag: "wx" });
      }
    }
    if (args.json) ctx.stdout(JSON.stringify({ ...summary, written: write }));
    else if (flagBool(args, "diff")) {
      ctx.stdout(`--- /dev/null\n+++ b/${summary.destination} (draft)\n@@\n${draft.toml.split("\n").filter(Boolean).map((line) => `+${line}`).join("\n")}`);
    } else {
      ctx.stdout(`Drafted ${summary.destination} from ${draft.sources.length ? draft.sources.join(", ") : "no environment sources"}.`);
      ctx.stdout(`Names: ${draft.names.length} (${draft.secretNames.length} secret; all optional)`);
      ctx.stdout(`Setup: ${draft.setup.length}; verify: ${draft.verify.length}`);
      ctx.stdout(draft.toml);
    }
    if (write && !args.json) ctx.stdout(`Wrote ${summary.destination}; review and commit it through your repository's pull request.`);
    return 0;
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

  throw new UsageError(`unknown env subcommand "${sub}": inventory | check | migrate | draft | shell`);
}
