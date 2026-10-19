// shell.ts — `catalyst env shell [--check]`: open this repository's environment on this computer.
// Every refusal a person can fix in the file or the terminal fires before Docker is touched; the
// cloud is asked only when a credential-free download is refused (shell-pull.ts).
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { flagBool, flagList, flagString, positionals, type ParsedArgs } from "../args.js";
import type { Ctx } from "../config.js";
import { UsageError } from "../errors.js";
import { IMAGE_REF, RUNNER_HOST_IMAGES } from "../onboard-runner.js";
import { readLocalRepositoryName } from "../onboard-settings-context.js";
import { readLocalSettings } from "./settings-authority.js";
import { readShellDeclaration, resolveShellVariables, type ShellToolchain } from "./shell-declaration.js";
import { spawnEnvShellDocker, type EnvShellDocker } from "./shell-docker.js";
import { parseCheckOutput, shellRunArgs, START_EXIT_TOOLCHAIN, toolchainSpecs } from "./shell-plan.js";
import { downloadImage, type ShellRefusal } from "./shell-pull.js";

export interface EnvShellDeps {
  docker?: EnvShellDocker;
  isTty?: () => boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  readRepositoryName?: (root: string) => Promise<string | null>;
  gitTopLevel?: (cwd: string) => Promise<string | null>;
  gitCommonDir?: (root: string) => Promise<string | null>;
}

const DECLARATION = ".catalyst/catalyst.toml";
const IMAGE_UID = 10001;
const run = promisify(execFile);

/** Git with no global or system config, no prompt, bounded: a path, or null. */
async function gitPath(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: 3_000,
      maxBuffer: 16_384,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const path = stdout.trim();
    return path !== "" && isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}
const defaultGitTopLevel = (cwd: string) => gitPath(cwd, ["rev-parse", "--show-toplevel"]);
const defaultGitCommonDir = (root: string) =>
  gitPath(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

/** The digest shortened for a person: `<name>@sha256:<12 hex>…`. */
function shortImage(image: string): string {
  return image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]{52}$/, "@sha256:$1…");
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unmountable(path: string): string | null {
  if (path.includes(",")) return `env shell cannot mount ${path}: the path contains a comma.`;
  if (/[\r\n]/.test(path)) return `env shell cannot mount ${JSON.stringify(path)}: the path contains a line break.`;
  return null;
}

function toolchainLine(toolchains: readonly ShellToolchain[]): string {
  return toolchains.length === 0
    ? "  Toolchain: none declared"
    : `  Toolchain: ${toolchains.map((t) => `${t.name} ${t.version}`).join(", ")} (the first start downloads any version the image lacks)`;
}

function joinSources(sources: readonly string[]): string {
  return sources.length <= 1 ? (sources[0] ?? "") : `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
}

export async function runEnvShell(args: ParsedArgs, ctx: Ctx, deps: EnvShellDeps = {}): Promise<number> {
  // 1. Flags.
  const [, ...rest] = positionals(args);
  if (rest.length > 0) throw new UsageError(`env shell takes no positional arguments (got "${rest[0]}"); use --root DIR`);
  const check = flagBool(args, "check");
  const json = args.json;
  if (json && !check) throw new UsageError("env shell --json needs --check: the shell itself is interactive");
  const imageFlag = flagString(args, "image");
  if (imageFlag !== undefined && !IMAGE_REF.test(imageFlag))
    throw new UsageError("env shell --image needs a digest-pinned reference, such as ghcr.io/owner/image@sha256:<64 hex>");
  const image = imageFlag ?? RUNNER_HOST_IMAGES.runner;

  const say = (line: string) => {
    if (!json) ctx.stdout(line);
  };
  const notice = (line: string) => (json ? ctx.stderr(line) : ctx.stdout(line));
  const refuse = (refusal: ShellRefusal): number => {
    if (json) ctx.stdout(JSON.stringify({ ok: false, refusal }));
    else for (const line of refusal.message.split("\n")) ctx.stderr(line);
    return 1;
  };

  // 2. Root.
  const rootFlag = flagString(args, "root");
  const start = resolve(rootFlag ?? ".");
  const requested = rootFlag !== undefined ? start : ((await (deps.gitTopLevel ?? defaultGitTopLevel)(start)) ?? start);
  let root: string;
  try {
    root = realpathSync(requested);
  } catch {
    return refuse({
      code: "declaration_missing",
      message: `No ${DECLARATION} in ${requested}. Draft one with: catalyst env draft --write`,
    });
  }
  const rootProblem = unmountable(root);
  if (rootProblem) return refuse({ code: "repository_path_unsupported", message: rootProblem });

  // 3. Declaration.
  const text = await readLocalSettings(root);
  if (text === null)
    return refuse({
      code: "declaration_missing",
      message: `No ${DECLARATION} in ${root}. Draft one with: catalyst env draft --write`,
    });
  const declaration = readShellDeclaration(text);
  if (declaration.state === "invalid")
    return refuse({
      code: "declaration_invalid",
      message: [...declaration.errors.map((error) => `${DECLARATION}: ${error}`), "Fix the file, then run catalyst env check."].join("\n"),
    });
  if (declaration.state === "unsupported") {
    const { name, version } = declaration.toolchain;
    return refuse({
      code: "toolchain_version_unsupported",
      message: `${name} ${JSON.stringify(version)} is a version range. env shell prepares an exact or prefix version, such as 22 or 22.23.3. Change it in ${DECLARATION}.`,
    });
  }

  // 4. Variables.
  const envFiles: { path: string; values: Record<string, string> }[] = [];
  for (const path of flagList(args, "env-file")) {
    try {
      envFiles.push({ path, values: parseEnv(readFileSync(resolve(path), "utf8")) as Record<string, string> });
    } catch {
      return refuse({ code: "env_file_unreadable", message: `could not read --env-file ${path}` });
    }
  }
  const variables = resolveShellVariables(declaration.variables, { env: ctx.env, envFiles });
  if (variables.missingRequired.length > 0)
    return refuse({
      code: "variables_missing",
      message: `These required variables are not set in this terminal or an --env-file: ${variables.missingRequired.join(", ")}. Set them, then run catalyst env shell again.`,
      names: variables.missingRequired,
    });

  // 5. Engine.
  const docker = deps.docker ?? spawnEnvShellDocker({ env: ctx.env });
  const server = await docker.server();
  if (server.state === "missing")
    return refuse({
      code: "docker_missing",
      message: "Docker is not installed on this computer. Install Docker Desktop, OrbStack or Docker Engine, then run catalyst env shell again.",
    });
  if (server.state === "not_running")
    return refuse({
      code: "docker_not_running",
      message: "Docker is installed but not running. Start Docker Desktop, OrbStack or Docker Engine, then run catalyst env shell again.",
    });
  if (server.state === "not_linux")
    return refuse({
      code: "docker_not_linux",
      message: `Docker is running ${server.os} containers. Switch it to Linux containers, then run catalyst env shell again.`,
    });

  // 6. Image.
  const readRepositoryName = deps.readRepositoryName ?? readLocalRepositoryName;
  const repository = (await readRepositoryName(root)) ?? basename(root);
  say(`Environment for ${repository}, from ${DECLARATION}`);
  const present = await docker.imagePresent(image);
  say(`  Image: ${shortImage(image)} (${present ? "already on this computer" : "not on this computer yet"})`);
  let credential: "none" | "issued" = "none";
  if (!present) {
    const endpoint = await docker.endpoint();
    if (!endpoint.ok)
      return refuse(
        endpoint.reason === "conflict"
          ? {
              code: "docker_endpoint_conflict",
              message: "DOCKER_HOST and DOCKER_CONTEXT are both set. Unset one, then run catalyst env shell again.",
            }
          : {
              code: "docker_endpoint_unreadable",
              message: "Docker's current context could not be read. Check it with docker context ls, then run catalyst env shell again.",
            },
      );
    const downloaded = await downloadImage({ ref: image, host: endpoint.host, root, ctx, docker, notify: notice, readRepositoryName });
    if (!downloaded.ok) return refuse(downloaded.refusal);
    credential = downloaded.credential;
  }

  // 7. Git common directory: a worktree's shared .git outside the root is mounted at its own path.
  const commonDir = await (deps.gitCommonDir ?? defaultGitCommonDir)(root);
  let gitCommonDir: string | null = null;
  if (commonDir !== null) {
    let real = commonDir;
    try {
      real = realpathSync(commonDir);
    } catch {
      // Not there any more: git inside the shell reports it; nothing is mounted.
    }
    if (!inside(real, root)) {
      const problem = unmountable(real);
      if (problem) return refuse({ code: "repository_path_unsupported", message: problem });
      gitCommonDir = real;
    }
  }

  // 8. Run.
  const tty = !check && (deps.isTty?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true));
  const checkNames = declaration.variables.map((v) => v.name).filter((name) => !variables.skippedReserved.includes(name));
  const argv = shellRunArgs({
    mode: check ? "check" : "shell",
    image,
    root,
    gitCommonDir,
    toolchains: declaration.toolchains,
    passNames: variables.set,
    tty,
    checkNames,
  });
  const runEnv: NodeJS.ProcessEnv = { ...ctx.env, ...variables.values };
  if (tty) runEnv.TERM = ctx.env.TERM || "xterm-256color";
  if (variables.skippedReserved.length > 0)
    notice(`  Note: env shell sets ${variables.skippedReserved.join(", ")} itself, so the declared value is not used.`);
  const uid = deps.uid ?? process.getuid?.();
  if ((deps.platform ?? process.platform) === "linux" && uid !== undefined && uid !== IMAGE_UID)
    notice(
      `Note: the shell runs as uid ${IMAGE_UID}, as Catalyst's agents do. Files here belong to uid ${uid}, so on Docker Engine for Linux the shell may not be able to write them.`,
    );
  const toolchainNotPrepared: ShellRefusal = {
    code: "toolchain_not_prepared",
    message: `The shell did not start: a declared toolchain could not be prepared (mise's message above says which). Check the name and version in ${DECLARATION}, then run catalyst env shell --check.`,
  };
  const secret = new Set(declaration.variables.filter((v) => v.secret).map((v) => v.name));

  if (!check) {
    say(toolchainLine(declaration.toolchains));
    const set = variables.set.map((name) => (secret.has(name) ? `${name} (secret)` : name));
    const parts = [
      ...(set.length > 0 ? [`${set.join(", ")} set from ${joinSources(variables.sources)}`] : []),
      ...(variables.unsetOptional.length > 0 ? [`not set: ${variables.unsetOptional.map((name) => `${name} (optional)`).join(", ")}`] : []),
    ];
    say(`  Variables: ${parts.length > 0 ? parts.join("; ") : "none declared"}`);
    say(`  Your repository is at /workspace. Type exit to leave.`);
    const result = await docker.run(argv, runEnv, "interactive");
    if (result.code === START_EXIT_TOOLCHAIN) return refuse(toolchainNotPrepared);
    return result.code;
  }

  const result = await docker.run(argv, runEnv, "capture");
  if (result.code === START_EXIT_TOOLCHAIN) return refuse(toolchainNotPrepared);
  const specs = toolchainSpecs(declaration.toolchains);
  const report = result.code === 0 ? parseCheckOutput(result.stdout, specs, checkNames) : null;
  if (report === null)
    return refuse({
      code: "check_incomplete",
      message: `The environment check did not finish (exit ${result.code}). Run catalyst env shell --check again; if it repeats, open the shell and run mise doctor.`,
    });
  const byName = new Map(declaration.variables.map((v) => [v.name, v]));
  if (json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        repository,
        declaration: DECLARATION,
        image: { reference: image, source: present ? "present" : "downloaded", credential },
        toolchains: declaration.toolchains.map((t, index) => ({ name: t.name, version: t.version, resolved: report.toolchains[index]!.resolved })),
        variables: report.variables.map((v) => ({
          name: v.name,
          required: byName.get(v.name)?.required === true,
          secret: byName.get(v.name)?.secret === true,
          set: v.set,
        })),
      }),
    );
    return 0;
  }
  say(
    declaration.toolchains.length === 0
      ? "  Toolchain: none declared"
      : `  Toolchain: ${declaration.toolchains.map((t, index) => `${t.name} ${t.version} → ${report.toolchains[index]!.resolved}`).join(", ")}`,
  );
  say(
    `  Variables: ${
      report.variables.length === 0
        ? "none declared"
        : report.variables
            .map((v) => {
              const notes = [...(secret.has(v.name) ? ["secret"] : []), ...(!v.set && byName.get(v.name)?.required !== true ? ["optional"] : [])];
              return `${v.name} ${v.set ? "set" : "not set"}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
            })
            .join(", ")
    }`,
  );
  say("Ready: catalyst env shell opens this environment.");
  return 0;
}
