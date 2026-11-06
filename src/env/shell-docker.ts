// shell-docker.ts — the docker CLI as `catalyst env shell` uses it: is an engine running, where is
// it, is the image here, one download through a throwaway config, and the container itself. Modelled
// on onboard-runner.ts's spawnDocker, endpoint rule and anonymous pull.
import { spawn, type StdioOptions } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants, homedir, tmpdir as osTmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Exactly what the download's throwaway Docker config holds. */
export interface DockerConfigJson {
  auths: Record<string, { auth?: string }>;
}

export type EnvShellServer =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "not_running" }
  | { state: "not_linux"; os: string };

/** Where the engine is: a host for DOCKER_HOST or the default context, plus the name of a named context. */
export interface EnvShellEndpoint {
  host: string;
  context?: string;
}

export interface EnvShellDocker {
  server(): Promise<EnvShellServer>;
  endpoint(): Promise<({ ok: true } & EnvShellEndpoint) | { ok: false; reason: "conflict" | "unreadable" }>;
  imagePresent(ref: string): Promise<boolean>;
  /** One pull through a throwaway config holding exactly `config`; the directory is removed in `finally`. A named
   *  context is pulled through by name, with the developer's context store linked in, so Docker applies its TLS. */
  pull(ref: string, endpoint: EnvShellEndpoint, config: DockerConfigJson): Promise<{ ok: boolean; detail: string }>;
  run(argv: string[], env: NodeJS.ProcessEnv, mode: "interactive" | "capture"): Promise<{ code: number; stdout: string }>;
}

const OUTPUT_CAP = 1_000_000;

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** Spawn docker and wait for it. SIGINT reaches the child through the terminal's process group, so
 *  this process only has to survive it; SIGTERM and SIGHUP are forwarded. Handlers go in `finally`. */
function spawnWait(
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: StdioOptions; timeoutMs?: number },
): Promise<Spawned> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("docker", args, { env: options.env, stdio: options.stdio, timeout: options.timeoutMs });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "", missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk;
    });
    const onInterrupt = () => {};
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const onTerm = forward("SIGTERM");
    const onHup = forward("SIGHUP");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    const done = (result: Spawned) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      resolve(result);
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      done({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr, missing: error.code === "ENOENT" }),
    );
    child.on("close", (status, signal) =>
      done({ code: exitCodeOf(status, signal), stdout, stderr, missing: false }),
    );
  });
}

export function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  return signal ? 128 + (constants.signals[signal] ?? 0) : 1;
}

/** Docker's last non-empty error line, printable characters only. */
export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
    .filter((line) => line !== "");
  return (lines.at(-1) ?? "").slice(0, 400);
}

export function spawnEnvShellDocker(deps: { env: NodeJS.ProcessEnv; tmpdir?: () => string }): EnvShellDocker {
  const env = deps.env;
  const quiet = (args: string[], timeoutMs = 30_000) =>
    spawnWait(args, { env, stdio: ["ignore", "pipe", "pipe"], timeoutMs });
  return {
    async server() {
      const read = await quiet(["version", "--format", "{{.Server.Os}}"]);
      if (read.missing) return { state: "missing" };
      if (read.code !== 0) return { state: "not_running" };
      const os = read.stdout.trim();
      return os === "linux" ? { state: "ok" } : { state: "not_linux", os: os.replace(/[^\x20-\x7e]/g, "").slice(0, 40) || "unknown" };
    },
    async endpoint() {
      // Reject conflicting selectors rather than infer precedence across Docker versions.
      if (env.DOCKER_CONTEXT && env.DOCKER_HOST) return { ok: false, reason: "conflict" };
      if (env.DOCKER_HOST) return { ok: true, host: env.DOCKER_HOST };
      const read = await quiet([
        "context",
        "inspect",
        ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
        "--format",
        // The name, a tab, then the host. Docker context names cannot contain a tab.
        '{{.Name}}{{"\\t"}}{{(index .Endpoints "docker").Host}}',
      ]);
      const [name = "", host = ""] = read.stdout.trim().split("\t").map((part) => part.trim());
      if (read.code !== 0 || host === "") return { ok: false, reason: "unreadable" };
      // `default` is Docker's built-in context, resolved from the environment: the explicit-host pull covers it.
      return name !== "" && name !== "default" ? { ok: true, host, context: name } : { ok: true, host };
    },
    async imagePresent(ref) {
      return (await quiet(["image", "inspect", "--format", "{{.Id}}", ref])).code === 0;
    },
    async pull(ref, endpoint, config) {
      let dir: string | undefined;
      try {
        // mkdtemp creates the directory 0700; the file is 0600 and holds nothing else.
        dir = mkdtempSync(join((deps.tmpdir ?? osTmpdir)(), "catalyst-env-pull-"));
        writeFileSync(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
        const developerConfig = env.DOCKER_CONFIG || join(env.HOME || homedir(), ".docker");
        if (endpoint.context) {
          // `--config` moves Docker's context store with it, and `--host` would mean the default context: link the
          // developer's own store in and pull through the context by name, so its endpoint, TLS files and
          // SkipTLSVerify apply exactly as for every other docker command. rmSync removes the link, never the store.
          symlinkSync(resolve(developerConfig, "contexts"), join(dir, "contexts"), "junction");
        }
        const pullEnv: NodeJS.ProcessEnv = {
          ...env,
          DOCKER_CONFIG: dir,
          // An explicit host is Docker's default context, whose TLS comes from DOCKER_TLS_VERIFY and DOCKER_CERT_PATH:
          // keep the developer's certificates although the config moved.
          DOCKER_CERT_PATH: env.DOCKER_CERT_PATH || developerConfig,
        };
        delete pullEnv.DOCKER_CONTEXT;
        delete pullEnv.DOCKER_AUTH_CONFIG;
        const selector = endpoint.context ? ["--context", endpoint.context] : ["--host", endpoint.host];
        // Progress goes to our stderr, so `--json` stdout stays one line; the error stream is kept.
        const result = await spawnWait([...selector, "--config", dir, "pull", ref], {
          env: pullEnv,
          stdio: ["ignore", 2, "pipe"],
          timeoutMs: 3_600_000,
        });
        if (result.missing) return { ok: false, detail: "docker is not installed" };
        return { ok: result.code === 0, detail: lastLine(result.stderr) };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? lastLine(error.message) : "the download could not start" };
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
    async run(argv, runEnv, mode) {
      const result = await spawnWait(argv, {
        env: runEnv,
        stdio: mode === "interactive" ? "inherit" : ["ignore", "pipe", "inherit"],
      });
      return { code: result.code, stdout: result.stdout };
    },
  };
}
