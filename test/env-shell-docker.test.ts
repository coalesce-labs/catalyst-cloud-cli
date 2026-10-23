import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { exitCodeOf, lastLine, spawnEnvShellDocker } from "../src/env/shell-docker";

// The real spawn wrapper, driven against a scripted `docker` placed first on PATH. The fake records
// every call (argv, the Docker selectors it saw, and for a pull the throwaway config file and its
// modes) to FAKE_LOG, then answers from FAKE_* variables, so what is asserted is exactly what the
// module handed to the process it started.

const FAKE_DOCKER = `#!/bin/sh
log="\${FAKE_LOG:?FAKE_LOG is required}"
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
is_pull=0
for a in "$@"; do
  if [ "$a" = pull ]; then is_pull=1; fi
done
{
  for a in "$@"; do printf 'arg=%s\\n' "$a"; done
  printf 'DOCKER_CONFIG=%s\\n' "\${DOCKER_CONFIG-<unset>}"
  printf 'DOCKER_CONTEXT=%s\\n' "\${DOCKER_CONTEXT-<unset>}"
  printf 'DOCKER_AUTH_CONFIG=%s\\n' "\${DOCKER_AUTH_CONFIG-<unset>}"
  printf 'DOCKER_CERT_PATH=%s\\n' "\${DOCKER_CERT_PATH-<unset>}"
  printf 'DEMO_VALUE=%s\\n' "\${DEMO_VALUE-<unset>}"
  if [ "$is_pull" = 1 ]; then
    printf 'config=%s\\n' "$(cat "$DOCKER_CONFIG/config.json")"
    printf 'config_mode=%s\\n' "$(mode_of "$DOCKER_CONFIG/config.json")"
    printf 'dir_mode=%s\\n' "$(mode_of "$DOCKER_CONFIG")"
  fi
  printf '%s\\n' '--end--'
} >> "$log"
sub="$1"
if [ "$is_pull" = 1 ]; then sub=pull; fi
case "$sub" in
  version)
    printf '%s\\n' "\${FAKE_VERSION_OS-}"
    exit "\${FAKE_VERSION_EXIT:-0}" ;;
  context)
    printf '%s\\n' "\${FAKE_CONTEXT_HOST-}"
    exit "\${FAKE_CONTEXT_EXIT:-0}" ;;
  image)
    exit "\${FAKE_INSPECT_EXIT:-0}" ;;
  pull)
    printf '%s\\n' "\${FAKE_PULL_ERR-}" >&2
    exit "\${FAKE_PULL_EXIT:-0}" ;;
  run)
    if [ -n "\${FAKE_RUN_SIGNAL-}" ]; then kill -s "$FAKE_RUN_SIGNAL" $$; sleep 5; fi
    printf 'child-value=%s\\n' "\${DEMO_VALUE-}"
    exit "\${FAKE_RUN_EXIT:-0}" ;;
  *)
    exit 99 ;;
esac
`;

interface Call {
  argv: string[];
  vars: Record<string, string>;
}

let root: string;
let binDir: string;
let emptyDir: string;
let pullTmp: string;
let logFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "env-shell-docker-"));
  binDir = mkdtempSync(join(root, "bin-"));
  emptyDir = mkdtempSync(join(root, "empty-"));
  pullTmp = mkdtempSync(join(root, "tmp-"));
  logFile = join(root, "calls.log");
  const docker = join(binDir, "docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** process.env with the fake first on PATH and no inherited Docker selectors or fake answers. */
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DOCKER_") || key.startsWith("FAKE_") || key === "DEMO_VALUE") delete env[key];
  }
  return { ...env, PATH: `${binDir}:${process.env.PATH ?? ""}`, FAKE_LOG: logFile, ...extra };
}

function calls(): Call[] {
  if (!existsSync(logFile)) return [];
  const records = readFileSync(logFile, "utf8").split("--end--\n").filter((record) => record !== "");
  return records.map((record) => {
    const argv: string[] = [];
    const vars: Record<string, string> = {};
    for (const line of record.split("\n")) {
      if (line === "") continue;
      const at = line.indexOf("=");
      const key = line.slice(0, at);
      const value = line.slice(at + 1);
      if (key === "arg") argv.push(value);
      else vars[key] = value;
    }
    return { argv, vars };
  });
}

function lastCall(): Call {
  const all = calls();
  const call = all.at(-1);
  if (!call) throw new Error("the fake docker was never called");
  return call;
}

const pullDirs = () => readdirSync(pullTmp).filter((name) => name.startsWith("catalyst-env-pull-"));

describe("server", () => {
  test("server(): ENOENT → missing; exit 1 → not_running; 'windows' → not_linux; 'linux' → ok", async () => {
    expect(await spawnEnvShellDocker({ env: { ...baseEnv(), PATH: emptyDir } }).server()).toEqual({ state: "missing" });
    expect(calls()).toHaveLength(0);

    expect(await spawnEnvShellDocker({ env: baseEnv({ FAKE_VERSION_EXIT: "1" }) }).server()).toEqual({ state: "not_running" });
    expect(await spawnEnvShellDocker({ env: baseEnv({ FAKE_VERSION_OS: "windows" }) }).server()).toEqual({
      state: "not_linux",
      os: "windows",
    });
    expect(await spawnEnvShellDocker({ env: baseEnv({ FAKE_VERSION_OS: "linux" }) }).server()).toEqual({ state: "ok" });

    const recorded = calls();
    expect(recorded).toHaveLength(3);
    for (const call of recorded) expect(call.argv).toEqual(["version", "--format", "{{.Server.Os}}"]);
  });
});

describe("endpoint", () => {
  test("endpoint(): DOCKER_HOST + DOCKER_CONTEXT → conflict; DOCKER_HOST alone → it; else docker context inspect's answer", async () => {
    const conflict = spawnEnvShellDocker({ env: baseEnv({ DOCKER_HOST: "tcp://x:2376", DOCKER_CONTEXT: "foo" }) });
    expect(await conflict.endpoint()).toEqual({ ok: false, reason: "conflict" });
    expect(calls()).toHaveLength(0);

    const hostOnly = spawnEnvShellDocker({ env: baseEnv({ DOCKER_HOST: "tcp://x:2376" }) });
    expect(await hostOnly.endpoint()).toEqual({ ok: true, host: "tcp://x:2376" });
    expect(calls()).toHaveLength(0);

    const inspected = spawnEnvShellDocker({ env: baseEnv({ FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock" }) });
    expect(await inspected.endpoint()).toEqual({ ok: true, host: "unix:///var/run/docker.sock" });
    expect(lastCall().argv).toEqual(["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}']);

    const named = spawnEnvShellDocker({ env: baseEnv({ DOCKER_CONTEXT: "foo", FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock" }) });
    expect(await named.endpoint()).toEqual({ ok: true, host: "unix:///var/run/docker.sock" });
    expect(lastCall().argv).toEqual(["context", "inspect", "foo", "--format", '{{(index .Endpoints "docker").Host}}']);
  });

  test("endpoint(): a failing or empty context inspect → unreadable", async () => {
    const failing = spawnEnvShellDocker({ env: baseEnv({ FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock", FAKE_CONTEXT_EXIT: "1" }) });
    expect(await failing.endpoint()).toEqual({ ok: false, reason: "unreadable" });
    const empty = spawnEnvShellDocker({ env: baseEnv({ FAKE_CONTEXT_HOST: "" }) });
    expect(await empty.endpoint()).toEqual({ ok: false, reason: "unreadable" });
    expect(calls()).toHaveLength(2);
  });
});

describe("imagePresent", () => {
  test("imagePresent(): exit 0 → true, exit 1 → false", async () => {
    const ref = "ghcr.io/example/env@sha256:" + "1".repeat(64);
    expect(await spawnEnvShellDocker({ env: baseEnv({ FAKE_INSPECT_EXIT: "0" }) }).imagePresent(ref)).toBe(true);
    expect(await spawnEnvShellDocker({ env: baseEnv({ FAKE_INSPECT_EXIT: "1" }) }).imagePresent(ref)).toBe(false);
    for (const call of calls()) expect(call.argv).toEqual(["image", "inspect", "--format", "{{.Id}}", ref]);
  });
});

describe("pull", () => {
  const REF = "docker.io/library/alpine:3.20";
  const HOST = "unix:///var/run/docker.sock";
  const CONFIG = { auths: { "https://index.docker.io/v1/": {} } };

  test("pull(): --host <endpoint> --config <tmp> pull <ref>; the file is 0600 in a 0700 dir; DOCKER_CONTEXT and DOCKER_AUTH_CONFIG absent; dir removed after success AND failure", async () => {
    const selectors = { DOCKER_CONTEXT: "desktop-linux", DOCKER_AUTH_CONFIG: '{"x":1}', HOME: "/h" };

    const ok = spawnEnvShellDocker({ env: baseEnv({ ...selectors, FAKE_PULL_EXIT: "0" }), tmpdir: () => pullTmp });
    expect((await ok.pull(REF, HOST, CONFIG)).ok).toBe(true);
    expect(pullDirs()).toEqual([]);

    const success = lastCall();
    expect(success.argv).toHaveLength(6);
    const [hostFlag, host, configFlag, configDir, verb, ref] = success.argv;
    expect([hostFlag, host, configFlag, verb, ref]).toEqual(["--host", HOST, "--config", "pull", REF]);
    expect(configDir?.startsWith(join(pullTmp, "catalyst-env-pull-"))).toBe(true);
    expect(success.vars.DOCKER_CONFIG).toBe(configDir);
    expect(success.vars.config).toBe(JSON.stringify(CONFIG));
    expect(success.vars.config_mode).toBe("600");
    expect(success.vars.dir_mode).toBe("700");
    expect(success.vars.DOCKER_CONTEXT).toBe("<unset>");
    expect(success.vars.DOCKER_AUTH_CONFIG).toBe("<unset>");
    // A TLS endpoint keeps the developer's own certificates although the config moved.
    expect(success.vars.DOCKER_CERT_PATH).toBe("/h/.docker");

    const failing = spawnEnvShellDocker({
      env: baseEnv({ ...selectors, FAKE_PULL_EXIT: "1", FAKE_PULL_ERR: "line one\nError response from daemon: denied" }),
      tmpdir: () => pullTmp,
    });
    expect(await failing.pull(REF, HOST, CONFIG)).toEqual({ ok: false, detail: "Error response from daemon: denied" });
    expect(pullDirs()).toEqual([]);

    const failure = lastCall();
    expect(failure.vars.config_mode).toBe("600");
    expect(failure.vars.dir_mode).toBe("700");
    expect(failure.vars.DOCKER_CONTEXT).toBe("<unset>");
    expect(failure.vars.DOCKER_AUTH_CONFIG).toBe("<unset>");
    expect(failure.argv[3]).not.toBe(configDir);
  });

  test("pull(): DOCKER_CERT_PATH keeps an explicit value, else the developer's DOCKER_CONFIG", async () => {
    const explicit = spawnEnvShellDocker({
      env: baseEnv({ HOME: "/h", DOCKER_CONFIG: "/cfg", DOCKER_CERT_PATH: "/certs" }),
      tmpdir: () => pullTmp,
    });
    await explicit.pull(REF, HOST, CONFIG);
    expect(lastCall().vars.DOCKER_CERT_PATH).toBe("/certs");

    const fromConfig = spawnEnvShellDocker({ env: baseEnv({ HOME: "/h", DOCKER_CONFIG: "/cfg" }), tmpdir: () => pullTmp });
    await fromConfig.pull(REF, HOST, CONFIG);
    const call = lastCall();
    expect(call.vars.DOCKER_CERT_PATH).toBe("/cfg");
    expect(call.vars.DOCKER_CONFIG).not.toBe("/cfg");
    expect(pullDirs()).toEqual([]);
  });

  test("pull(): the credential is in the file only, never in argv", async () => {
    const auth = Buffer.from("x-catalyst-pull:ctcpull_SECRETVALUE").toString("base64");
    const config = { auths: { "registry.example.dev": { auth } } };
    const docker = spawnEnvShellDocker({ env: baseEnv(), tmpdir: () => pullTmp });
    expect((await docker.pull("registry.example.dev/env:1", HOST, config)).ok).toBe(true);

    const call = lastCall();
    const argv = call.argv.join("\n");
    expect(argv).not.toContain("ctcpull_SECRETVALUE");
    expect(argv).not.toContain(auth);
    expect(call.vars.config).toContain(auth);
    expect(call.vars.config).toBe(JSON.stringify(config));
    expect(pullDirs()).toEqual([]);
  });

  test("pull(): no docker on PATH → not installed, and the directory is still removed", async () => {
    const docker = spawnEnvShellDocker({ env: { ...baseEnv(), PATH: emptyDir }, tmpdir: () => pullTmp });
    expect(await docker.pull(REF, HOST, CONFIG)).toEqual({ ok: false, detail: "docker is not installed" });
    expect(pullDirs()).toEqual([]);
  });
});

describe("run", () => {
  const ARGV = ["run", "--rm", "-e", "DEMO_VALUE", "img"];

  test("run(interactive): the declared variable's value reaches the child env, not argv; exit code and signal (128+n) come back", async () => {
    const docker = spawnEnvShellDocker({ env: baseEnv() });
    const exited = await docker.run(ARGV, baseEnv({ DEMO_VALUE: "s3cr3t", FAKE_RUN_EXIT: "3" }), "interactive");
    expect(exited).toEqual({ code: 3, stdout: "" });
    const call = lastCall();
    expect(call.argv).toEqual(ARGV);
    expect(call.argv.join("\n")).not.toContain("s3cr3t");
    expect(call.vars.DEMO_VALUE).toBe("s3cr3t");

    const signalled = await docker.run(ARGV, baseEnv({ DEMO_VALUE: "s3cr3t", FAKE_RUN_SIGNAL: "TERM" }), "interactive");
    expect(signalled).toEqual({ code: 143, stdout: "" });
  });

  test("run(capture): stdout captured for the check; stderr passes through", async () => {
    const docker = spawnEnvShellDocker({ env: baseEnv() });
    const result = await docker.run(ARGV, baseEnv({ DEMO_VALUE: "v" }), "capture");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("child-value=v");
    expect(lastCall().argv).toEqual(ARGV);
  });

  test("run(): no docker on PATH → 127", async () => {
    const docker = spawnEnvShellDocker({ env: baseEnv() });
    expect(await docker.run(ARGV, { ...baseEnv(), PATH: emptyDir }, "capture")).toEqual({ code: 127, stdout: "" });
  });
});

describe("exitCodeOf and lastLine", () => {
  test("exitCodeOf: a status wins; a signal is 128+n; neither is 1", () => {
    expect(exitCodeOf(3, null)).toBe(3);
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(null, "SIGKILL")).toBe(137);
    expect(exitCodeOf(null, null)).toBe(1);
  });

  test("lastLine: the last non-empty line, or empty", () => {
    expect(lastLine("first\nsecond\n\n")).toBe("second");
    expect(lastLine("first\r\nsecond\r\n")).toBe("second");
    expect(lastLine("")).toBe("");
  });
});
