// shell-plan.ts — the container `catalyst env shell` starts: the one `docker run` argv, the in-image
// start script, the home volume's name and the reader for `--check`'s report. Pure: nothing here
// spawns, reads a file or sees a variable's value. Values reach the container only as bare `-e NAME`
// words, which Docker fills from the client process's environment.
import { createHash } from "node:crypto";
import type { ShellToolchain } from "./shell-declaration.js";

/** The start script's exit code when `mise install` could not prepare a declared toolchain. */
export const START_EXIT_TOOLCHAIN = 97;
/** The image's own user, as phases and `catalyst runner` run it. */
export const ENV_SHELL_USER = "10001:10001";
export const ENV_SHELL_WORKSPACE = "/workspace";
const HOME = "/home/catalyst";

/** Runs as `sh -c <this> catalyst-env-shell <shell|check> <name@version>...` inside the image.
 *  Prototyped and run against mise 2026.8.14 in a Catalyst image in the plan phase (see the plan). */
export const ENV_SHELL_START_SCRIPT = [
  "set -u",
  'mode="$1"; shift',
  `if [ "$#" -gt 0 ]; then mise install "$@" >&2 || exit ${START_EXIT_TOOLCHAIN}; fi`,
  'if [ "$mode" = check ]; then',
  '  for spec in "$@"; do printf \'toolchain\\t%s\\t%s\\n\' "$spec" "$(basename "$(mise where "$spec")")"; done',
  "  for name in ${CATALYST_ENV_NAMES:-}; do",
  '    if printenv "$name" >/dev/null 2>&1; then printf \'variable\\t%s\\tset\\n\' "$name"; else printf \'variable\\t%s\\tunset\\n\' "$name"; fi',
  "  done",
  "  exit 0",
  "fi",
  // Not a login shell: that re-reads /etc/profile, which replaces the PATH mise just set, so the
  // declared toolchain would be lost (CTC-6153). Not forced interactive either: bash decides from its
  // stdin, so a terminal gets ~/.bashrc and piped input keeps non-interactive semantics.
  'if [ "$#" -gt 0 ]; then exec mise exec "$@" -- bash; fi',
  "exec bash -l",
].join("\n");

/** One home volume per image digest: downloaded toolchains and history persist, a new image starts fresh. */
export function homeVolumeFor(image: string): string {
  const digest = /@sha256:([0-9a-f]{12})/.exec(image)?.[1];
  return `catalyst-env-home-${digest ?? createHash("sha256").update(image).digest("hex").slice(0, 12)}`;
}

export function toolchainSpecs(toolchains: readonly ShellToolchain[]): string[] {
  return toolchains.map((toolchain) => `${toolchain.name}@${toolchain.version}`);
}

export interface ShellRunInput {
  mode: "shell" | "check";
  image: string;
  /** The repository's real path, mounted at /workspace. */
  root: string;
  /** A worktree's shared git directory outside `root`, mounted at the same path; null otherwise. */
  gitCommonDir: string | null;
  toolchains: readonly ShellToolchain[];
  /** Declared variables that have a value: passed by name only. */
  passNames: readonly string[];
  /** Both stdin and stdout are terminals (shell mode only). */
  tty: boolean;
  /** Every declared variable the check reports on (check mode only). */
  checkNames: readonly string[];
}

/** THE argv builder: `--check` and the shell differ only by mode, -i/-t and CATALYST_ENV_NAMES. */
export function shellRunArgs(input: ShellRunInput): string[] {
  const shell = input.mode === "shell";
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    ...(shell ? ["-i"] : []),
    ...(shell && input.tty ? ["-t"] : []),
    "--user",
    ENV_SHELL_USER,
    "--mount",
    `type=bind,src=${input.root},dst=${ENV_SHELL_WORKSPACE}`,
    ...(input.gitCommonDir ? ["--mount", `type=bind,src=${input.gitCommonDir},dst=${input.gitCommonDir}`] : []),
    "--mount",
    `type=volume,src=${homeVolumeFor(input.image)},dst=${HOME}`,
    "-w",
    ENV_SHELL_WORKSPACE,
    "-e",
    `HOME=${HOME}`,
    "-e",
    "MISE_SYSTEM_DATA_DIR=/opt/catalyst/toolchain",
    "-e",
    "MISE_SHARED_INSTALL_DIRS=/opt/catalyst/toolchain/installs",
    "-e",
    "CLAUDE_CODE_ENABLE_TELEMETRY=0",
    "-e",
    "OTEL_METRICS_EXPORTER=none",
    "-e",
    "OTEL_LOGS_EXPORTER=none",
    "-e",
    "OTEL_TRACES_EXPORTER=none",
    "-e",
    "GIT_CONFIG_COUNT=1",
    "-e",
    "GIT_CONFIG_KEY_0=safe.directory",
    "-e",
    "GIT_CONFIG_VALUE_0=*",
    ...(shell && input.tty ? ["-e", "TERM"] : []),
    ...input.passNames.flatMap((name) => ["-e", name]),
    ...(shell ? [] : ["-e", `CATALYST_ENV_NAMES=${input.checkNames.join(" ")}`]),
    "--entrypoint",
    "/bin/sh",
    input.image,
    "-c",
    ENV_SHELL_START_SCRIPT,
    "catalyst-env-shell",
    input.mode,
    ...toolchainSpecs(input.toolchains),
  ];
}

export interface CheckReport {
  toolchains: { spec: string; resolved: string }[];
  variables: { name: string; set: boolean }[];
}

/** Map the start script's check lines back to the declared specs and names. Null when any declared
 *  spec or name has no line (or an empty version), so a partial report is never shown as ready. */
export function parseCheckOutput(
  stdout: string,
  specs: readonly string[],
  names: readonly string[],
): CheckReport | null {
  const resolved = new Map<string, string>();
  const set = new Map<string, boolean>();
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, key, value, ...extra] = line.split("\t");
    if (extra.length > 0 || key === undefined || value === undefined) continue;
    if (kind === "toolchain" && specs.includes(key) && value.trim() !== "") resolved.set(key, value.trim());
    if (kind === "variable" && names.includes(key) && (value === "set" || value === "unset"))
      set.set(key, value === "set");
  }
  const toolchains: CheckReport["toolchains"] = [];
  for (const spec of specs) {
    const version = resolved.get(spec);
    if (version === undefined) return null;
    toolchains.push({ spec, resolved: version });
  }
  const variables: CheckReport["variables"] = [];
  for (const name of names) {
    const value = set.get(name);
    if (value === undefined) return null;
    variables.push({ name, set: value });
  }
  return { toolchains, variables };
}
