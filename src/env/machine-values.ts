// machine-values.ts — this computer's values for the names a reviewed `.catalyst/catalyst.toml`
// declares, for `catalyst env import` and `catalyst env draft --import-values`.
//
// ⛔ VALUES ARE HELD IN MEMORY AND RETURNED ONLY TO `src/env-import.ts`, which sends them in request
// bodies and prints names. Nothing here logs, prints or writes a value.
//
// A value can come from four places, in this order, and nowhere else:
//   1. the direnv environment: this process's environment, only when DIRENV_DIR names this
//      repository and only for names `.envrc` exports (direnv has already run the file);
//   2. a static literal in `.envrc`;
//   3. a literal header in `~/.claude.json`, only for a variable the draft derived from that header;
//   4. this process's environment, for a name a `~/.claude.json` header references, since that is
//      where Claude Code itself reads it.
// `.envrc` is never run, `direnv` is never called, and `.env` is never opened. The file's declared
// names are the allowlist: a name this computer has but the file does not declare is never resolved.
import { claudeHeaderLiterals, scanClaudeMcp } from "./scan-claude-mcp.js";
import { envrcLiteralValues, scanEnvrc } from "./scan-envrc.js";
import { readMachineFiles, type MachineOptions } from "./machine.js";

export type ValueSource = ".envrc" | "direnv environment" | "~/.claude.json" | "shell environment";

export interface MachineValues {
  values: Map<string, { value: string; from: ValueSource }>;
  noValue: Array<{ name: string; computed: boolean }>;
}

export function resolveMachineValues(
  root: string,
  options: MachineOptions,
  declared: ReadonlyArray<{ name: string; secret: boolean }>,
): MachineValues {
  const files = readMachineFiles(root, options);
  const wanted = new Set(declared.map(({ name }) => name));
  const envrc = files.envrcText === undefined ? null : scanEnvrc(files.envrcText);
  const exported = new Map((envrc?.exported ?? []).map((entry) => [entry.name, entry]));
  const literals = files.envrcText === undefined ? new Map<string, string>() : envrcLiteralValues(files.envrcText, wanted);
  const direnvDir = options.env.DIRENV_DIR;
  const direnvLoaded = typeof direnvDir === "string" && files.repoRoots.some((path) => direnvDir === `-${path}`);
  // The draft saw the `.envrc` names when it derived header variables; the same set keeps lookups aligned.
  const envrcNames = new Set(exported.keys());
  const headerLiterals = files.claudeText === undefined ? new Map<string, string>() : claudeHeaderLiterals(files.claudeText, files.repoRoots, wanted, envrcNames);
  const referenced = new Set<string>();
  if (files.claudeText !== undefined) {
    for (const server of scanClaudeMcp(files.claudeText, files.repoRoots, envrcNames).servers) {
      const derived = new Set(server.derived.map(({ variable }) => variable));
      for (const name of server.references) if (!derived.has(name)) referenced.add(name);
    }
  }

  const values = new Map<string, { value: string; from: ValueSource }>();
  const noValue: MachineValues["noValue"] = [];
  for (const { name } of declared) {
    const found = pick(
      direnvLoaded && exported.has(name) ? [options.env[name], "direnv environment"] : undefined,
      [literals.get(name), ".envrc"],
      [headerLiterals.get(name), "~/.claude.json"],
      referenced.has(name) ? [options.env[name], "shell environment"] : undefined,
    );
    if (found !== null) values.set(name, found);
    else noValue.push({ name, computed: exported.get(name)?.computed === true });
  }
  return { values, noValue };
}

function pick(...candidates: Array<[string | undefined, ValueSource] | undefined>): { value: string; from: ValueSource } | null {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const [value, from] = candidate;
    if (value !== undefined && value !== "") return { value, from };
  }
  return null;
}
