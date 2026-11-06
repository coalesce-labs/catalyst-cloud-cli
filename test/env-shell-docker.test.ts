import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { exitCodeOf, lastLine, redactSecrets, spawnEnvShellDocker } from "../src/env/shell-docker";
import { makeCtx } from "./helpers";

// The real spawn wrapper, driven against a scripted `docker` placed first on PATH. The fake records
// every call (argv, the Docker selectors it saw, and for a pull the throwaway config file and its
// modes) to FAKE_LOG, then answers from FAKE_* variables, so what is asserted is exactly what the
// module handed to the process it started.
//
// For a pull the fake also resolves, by Docker's own rules, which engine and which TLS files the
// pull would end up with (the eff_* lines): `--host` means Docker's default context, whose TLS comes
// only from DOCKER_TLS_VERIFY and DOCKER_CERT_PATH; `--context` (or DOCKER_CONTEXT) names a context
// whose host, TLS files and SkipTLSVerify come from the context store under the config directory
// (`--config`, else DOCKER_CONFIG, else $HOME/.docker); and `--host` together with `--context` is an
// error. So the tests assert the outcome, not which flag or variable was chosen.

const FAKE_DOCKER = `#!/bin/sh
log="\${FAKE_LOG:?FAKE_LOG is required}"
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
is_pull=0
for a in "$@"; do
  if [ "$a" = pull ]; then is_pull=1; fi
done
effective() {
  host_flag=; ctx_flag=; cfg_flag=; prev=
  for a in "$@"; do
    case "$prev" in
      --host) host_flag=$a ;;
      --context) ctx_flag=$a ;;
      --config) cfg_flag=$a ;;
    esac
    prev=$a
  done
  cfg="\${cfg_flag:-\${DOCKER_CONFIG:-$HOME/.docker}}"
  eff_host=; eff_tls=off; pem_dir=; eff_err=
  if [ -n "$host_flag" ] && [ -n "$ctx_flag" ]; then
    eff_err="conflicting options: cannot specify both --host and --context"
  elif [ -n "$host_flag" ] || [ -n "\${DOCKER_HOST-}" ] || [ "\${ctx_flag:-\${DOCKER_CONTEXT:-default}}" = default ]; then
    eff_host="\${host_flag:-\${DOCKER_HOST:-unix:///var/run/docker.sock}}"
    if [ -n "\${DOCKER_TLS_VERIFY-}" ]; then eff_tls=verify; elif [ -n "\${DOCKER_TLS-}" ]; then eff_tls=noverify; fi
    pem_dir="\${DOCKER_CERT_PATH:-$cfg}"
  else
    name="\${ctx_flag:-$DOCKER_CONTEXT}"
    meta=$(grep -lF '"Name":"'"$name"'"' "$cfg"/contexts/meta/*/meta.json 2>/dev/null | head -n 1)
    if [ -z "$meta" ]; then
      eff_err="context \\"$name\\" does not exist"
    else
      id=$(basename "$(dirname "$meta")")
      eff_host=$(sed -n 's/.*"Host":"\\([^"]*\\)".*/\\1/p' "$meta")
      pem_dir="$cfg/contexts/tls/$id/docker"
      if grep -q '"SkipTLSVerify":true' "$meta"; then eff_tls=noverify; elif [ -d "$pem_dir" ]; then eff_tls=verify; fi
    fi
  fi
  eff_pems=; eff_ca=
  if [ "$eff_tls" != off ]; then
    for f in ca.pem cert.pem key.pem; do
      if [ -f "$pem_dir/$f" ]; then eff_pems="$eff_pems\${eff_pems:+ }$f"; fi
    done
    if [ -f "$pem_dir/ca.pem" ]; then eff_ca=$(cat "$pem_dir/ca.pem"); fi
  fi
}
if [ "$is_pull" = 1 ]; then effective "$@"; fi
{
  for a in "$@"; do printf 'arg=%s\\n' "$a"; done
  printf 'DOCKER_CONFIG=%s\\n' "\${DOCKER_CONFIG-<unset>}"
  printf 'DOCKER_CONTEXT=%s\\n' "\${DOCKER_CONTEXT-<unset>}"
  printf 'DOCKER_AUTH_CONFIG=%s\\n' "\${DOCKER_AUTH_CONFIG-<unset>}"
  printf 'DOCKER_CERT_PATH=%s\\n' "\${DOCKER_CERT_PATH-<unset>}"
  printf 'DOCKER_TLS_VERIFY=%s\\n' "\${DOCKER_TLS_VERIFY-<unset>}"
  printf 'DEMO_VALUE=%s\\n' "\${DEMO_VALUE-<unset>}"
  if [ "$is_pull" = 1 ]; then
    printf 'config=%s\\n' "$(cat "$cfg/config.json")"
    printf 'config_mode=%s\\n' "$(mode_of "$cfg/config.json")"
    printf 'dir_mode=%s\\n' "$(mode_of "$cfg")"
    printf 'eff_host=%s\\n' "$eff_host"
    printf 'eff_tls=%s\\n' "$eff_tls"
    printf 'eff_pems=%s\\n' "$eff_pems"
    printf 'eff_ca=%s\\n' "$eff_ca"
    printf 'eff_err=%s\\n' "$eff_err"
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
    # Answers by the --format it is given: the name and host when it asks for .Name, the host alone otherwise.
    case "$*" in
      *.Name*) printf '%s\\t%s\\n' "\${FAKE_CONTEXT_NAME-default}" "\${FAKE_CONTEXT_HOST-}" ;;
      *) printf '%s\\n' "\${FAKE_CONTEXT_HOST-}" ;;
    esac
    exit "\${FAKE_CONTEXT_EXIT:-0}" ;;
  image)
    exit "\${FAKE_INSPECT_EXIT:-0}" ;;
  pull)
    if [ -n "$eff_err" ]; then printf '%s\\n' "$eff_err" >&2; exit 1; fi
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

// CTC-6157 — a download credential Docker echoes back must be redacted before its error line is cut
// to 400 characters, or a cut inside the secret leaves a prefix that matches nothing.
const PASSWORD = "ctcpull_SECRETVALUE123";
const EXPECTED_AUTH = Buffer.from(`x-catalyst-pull:${PASSWORD}`).toString("base64");
const CRED_CONFIG = { auths: { "registry.example.dev": { auth: EXPECTED_AUTH } } };
const LEAD = "Error response from daemon: unauthorized: ";

/** One error line that holds `secret` at index `at`, so the 400-character cut falls inside it. */
function straddling(secret: string, at = 390): string {
  const line = LEAD + "a".repeat(at - LEAD.length) + secret + " rejected";
  expect(line.indexOf(secret)).toBe(at);
  expect(at + secret.length).toBeGreaterThan(400);
  return line;
}

/** `secret` with `gap` after its first `at` characters (default: in the middle), as Docker might echo it. */
function broken(secret: string, gap: string, at = Math.floor(secret.length / 2)): string {
  return secret.slice(0, at) + gap + secret.slice(at);
}

/** No fragment of either secret: not its first 4 characters, and not its last 4 either. None of these
 *  four strings occurs in the fixtures' own text, so any hit is a piece of a credential. */
function expectNoSecretFragment(text: string) {
  expect(text).not.toContain(PASSWORD.slice(0, 4)); // "ctcp"
  expect(text).not.toContain(PASSWORD.slice(-4)); // "E123"
  expect(text).not.toContain(EXPECTED_AUTH.slice(0, 4)); // "eC1j"
  expect(text).not.toContain(EXPECTED_AUTH.slice(-4)); // "MjM="
}

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
  // The name, a tab, then the host. The argv holds the characters backslash-t, which Go's template turns into the tab.
  const INSPECT_FORMAT = '{{.Name}}{{"\\t"}}{{(index .Endpoints "docker").Host}}';

  test("endpoint(): DOCKER_HOST + DOCKER_CONTEXT → conflict; DOCKER_HOST alone → it; else docker context inspect's answer", async () => {
    const conflict = spawnEnvShellDocker({ env: baseEnv({ DOCKER_HOST: "tcp://x:2376", DOCKER_CONTEXT: "foo" }) });
    expect(await conflict.endpoint()).toEqual({ ok: false, reason: "conflict" });
    expect(calls()).toHaveLength(0);

    const hostOnly = spawnEnvShellDocker({ env: baseEnv({ DOCKER_HOST: "tcp://x:2376" }) });
    expect(await hostOnly.endpoint()).toEqual({ ok: true, host: "tcp://x:2376" });
    expect(calls()).toHaveLength(0);

    const inspected = spawnEnvShellDocker({ env: baseEnv({ FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock" }) });
    expect(await inspected.endpoint()).toEqual({ ok: true, host: "unix:///var/run/docker.sock" });
    expect(lastCall().argv).toEqual(["context", "inspect", "--format", INSPECT_FORMAT]);

    const named = spawnEnvShellDocker({
      env: baseEnv({ DOCKER_CONTEXT: "foo", FAKE_CONTEXT_NAME: "foo", FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock" }),
    });
    expect(await named.endpoint()).toEqual({ ok: true, host: "unix:///var/run/docker.sock", context: "foo" });
    expect(lastCall().argv).toEqual(["context", "inspect", "foo", "--format", INSPECT_FORMAT]);

    // The default context is Docker's built-in one, resolved from the environment: no context to pull through.
    const chosenDefault = spawnEnvShellDocker({
      env: baseEnv({ DOCKER_CONTEXT: "default", FAKE_CONTEXT_NAME: "default", FAKE_CONTEXT_HOST: "unix:///var/run/docker.sock" }),
    });
    expect(await chosenDefault.endpoint()).toEqual({ ok: true, host: "unix:///var/run/docker.sock" });
  });

  test("endpoint(): the current context chosen with `docker context use` (no DOCKER_CONTEXT) comes back by name", async () => {
    const current = spawnEnvShellDocker({ env: baseEnv({ FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: "tcp://remote.example:2376" }) });
    expect(await current.endpoint()).toEqual({ ok: true, host: "tcp://remote.example:2376", context: "remote-tls" });
    expect(lastCall().argv).toEqual(["context", "inspect", "--format", INSPECT_FORMAT]);
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

  test("pull(): an explicit host (Docker's default context) → --host <endpoint> --config <tmp> pull <ref>; the file is 0600 in a 0700 dir; DOCKER_CONTEXT and DOCKER_AUTH_CONFIG absent; dir removed after success AND failure", async () => {
    const selectors = { DOCKER_CONTEXT: "desktop-linux", DOCKER_AUTH_CONFIG: '{"x":1}', HOME: "/h" };

    const ok = spawnEnvShellDocker({ env: baseEnv({ ...selectors, FAKE_PULL_EXIT: "0" }), tmpdir: () => pullTmp });
    expect((await ok.pull(REF, { host: HOST }, CONFIG)).ok).toBe(true);
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
    // An explicit host is Docker's default context: its TLS comes from DOCKER_TLS_VERIFY and DOCKER_CERT_PATH,
    // which keep the developer's certificates although the config moved.
    expect(success.vars.DOCKER_CERT_PATH).toBe("/h/.docker");
    expect(success.argv).not.toContain("--context");
    expect(success.vars.eff_host).toBe(HOST);
    expect(success.vars.eff_err).toBe("");

    const failing = spawnEnvShellDocker({
      env: baseEnv({ ...selectors, FAKE_PULL_EXIT: "1", FAKE_PULL_ERR: "line one\nError response from daemon: denied" }),
      tmpdir: () => pullTmp,
    });
    expect(await failing.pull(REF, { host: HOST }, CONFIG)).toEqual({ ok: false, detail: "Error response from daemon: denied" });
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
    await explicit.pull(REF, { host: HOST }, CONFIG);
    expect(lastCall().vars.DOCKER_CERT_PATH).toBe("/certs");

    const fromConfig = spawnEnvShellDocker({ env: baseEnv({ HOME: "/h", DOCKER_CONFIG: "/cfg" }), tmpdir: () => pullTmp });
    await fromConfig.pull(REF, { host: HOST }, CONFIG);
    const call = lastCall();
    expect(call.vars.DOCKER_CERT_PATH).toBe("/cfg");
    expect(call.vars.DOCKER_CONFIG).not.toBe("/cfg");
    expect(pullDirs()).toEqual([]);
  });

  test("pull(): the credential is in the file only, never in argv", async () => {
    const auth = Buffer.from("x-catalyst-pull:ctcpull_SECRETVALUE").toString("base64");
    const config = { auths: { "registry.example.dev": { auth } } };
    const docker = spawnEnvShellDocker({ env: baseEnv(), tmpdir: () => pullTmp });
    expect((await docker.pull("registry.example.dev/env:1", { host: HOST }, config)).ok).toBe(true);

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
    expect(await docker.pull(REF, { host: HOST }, CONFIG)).toEqual({ ok: false, detail: "docker is not installed" });
    expect(pullDirs()).toEqual([]);
  });

  test.each([
    ["password at 390", PASSWORD, 390],
    ["auth at 390", EXPECTED_AUTH, 390],
    ["auth at 370", EXPECTED_AUTH, 370],
  ] as const)(
    "pull() CTC-6157: Docker echoes the credential across the 400-character cut (%s) → no fragment of it comes back",
    async (_name, secret, at) => {
      const docker = spawnEnvShellDocker({
        env: baseEnv({ FAKE_PULL_EXIT: "1", FAKE_PULL_ERR: `progress line\n${straddling(secret, at)}` }),
        tmpdir: () => pullTmp,
      });
      const result = await docker.pull(REF, { host: HOST }, CRED_CONFIG);
      expect(result.ok).toBe(false);
      expectNoSecretFragment(result.detail);
      expect(result.detail.startsWith(LEAD)).toBe(true);
      expect(result.detail).toContain("[redacted]");
      expect(result.detail.length).toBeLessThanOrEqual(400);
      expect(pullDirs()).toEqual([]);
    },
  );

  test("pull() CTC-6157: the catch path (the temp directory cannot be made) redacts the credential its error message names", async () => {
    // mkdtemp's ENOENT message carries the path, and the path here holds the password.
    const docker = spawnEnvShellDocker({ env: baseEnv(), tmpdir: () => join(root, `missing-${PASSWORD}`) });
    const result = await docker.pull(REF, { host: HOST }, CRED_CONFIG);
    expect(result.ok).toBe(false);
    // The message is short, so nothing is cut: the temp root's random name is the only other text in it
    // that is not fixed, so it is taken out before looking for a fragment of a credential.
    expectNoSecretFragment(result.detail.replaceAll(root, "<root>"));
    expect(result.detail.startsWith("ENOENT")).toBe(true);
    expect(result.detail).toContain("[redacted]");
  });

  test.each([
    ["a CRLF in the password", PASSWORD, "\r\n"],
    ["a line feed in the auth value", EXPECTED_AUTH, "\n"],
  ] as const)(
    "pull() CTC-6157: Docker breaks the credential up with %s → none of it comes back",
    async (_name, secret, gap) => {
      const docker = spawnEnvShellDocker({
        env: baseEnv({ FAKE_PULL_EXIT: "1", FAKE_PULL_ERR: `progress line\n${LEAD}${broken(secret, gap)} rejected` }),
        tmpdir: () => pullTmp,
      });
      const result = await docker.pull(REF, { host: HOST }, CRED_CONFIG);
      expectNoSecretFragment(result.detail);
      expect(result).toEqual({ ok: false, detail: `${LEAD}[redacted] rejected` });
      expect(pullDirs()).toEqual([]);
    },
  );

  test.each(
    [
      ["an ANSI colour sequence", "\x1b[31m"],
      ["an OSC ended by BEL", "\x1b]0;title\x07"],
      ["an unterminated OSC", "\x1b]0;title"],
      ["a charset designation", "\x1b(B"],
      ["an 8-bit CSI", "\x9b31m"],
    ].flatMap(([name, gap]) =>
      [PASSWORD, EXPECTED_AUTH].flatMap((secret) =>
        [0, 395 - LEAD.length].map((pad) => [name, secret, gap, pad] as const),
      ),
    ),
  )("pull() CTC-6157: %s in a secret (secret %#, pad %#) → escape-bearing text is withheld", async (_name, secret, gap, pad) => {
    const docker = spawnEnvShellDocker({
      env: baseEnv({
        FAKE_PULL_EXIT: "1",
        FAKE_PULL_ERR: `progress line\n${LEAD}${"a".repeat(pad)}${broken(secret, gap)} rejected`,
      }),
      tmpdir: () => pullTmp,
    });
    const result = await docker.pull(REF, { host: HOST }, CRED_CONFIG);
    expect(result).toEqual({ ok: false, detail: "" });
    expect(pullDirs()).toEqual([]);
  });
});

describe("pull through a named context (CTC-6154)", () => {
  const REF = "docker.io/library/alpine:3.20";
  const HOST_TLS = "tcp://remote.example:2376";
  const CONFIG = { auths: { "https://index.docker.io/v1/": {} } };
  const PEMS = { "ca.pem": "CA-remote-tls", "cert.pem": "CERT-remote-tls", "key.pem": "KEY-remote-tls" };
  const PEM_NAMES = "ca.pem cert.pem key.pem";

  /** Writes a context the way `docker context create` does: meta/<sha256(name)>/meta.json and tls/<id>/docker/*.pem. */
  function writeContext(
    configDir: string,
    name: string,
    host: string,
    opts: { skipTLSVerify?: boolean; pems?: Record<string, string> } = {},
  ): { tlsDir: string } {
    const id = createHash("sha256").update(name).digest("hex");
    const metaDir = join(configDir, "contexts", "meta", id);
    const tlsDir = join(configDir, "contexts", "tls", id, "docker");
    mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ Name: name, Metadata: {}, Endpoints: { docker: { Host: host, SkipTLSVerify: opts.skipTLSVerify === true } } }),
      { mode: 0o600 },
    );
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    for (const [file, content] of Object.entries(opts.pems ?? {})) writeFileSync(join(tlsDir, file), content, { mode: 0o600 });
    return { tlsDir };
  }

  /** `endpoint()` then `pull()`, the way `catalyst env shell` calls them. */
  async function endpointThenPull(env: NodeJS.ProcessEnv, config = CONFIG) {
    const docker = spawnEnvShellDocker({ env, tmpdir: () => pullTmp });
    const endpoint = await docker.endpoint();
    if (!endpoint.ok) throw new Error(`endpoint() refused: ${endpoint.reason}`);
    return { endpoint, pulled: await docker.pull(REF, endpoint, config) };
  }

  function expectTlsPull(): void {
    const call = lastCall();
    expect(call.vars.eff_err).toBe("");
    expect(call.vars.eff_host).toBe(HOST_TLS);
    expect(call.vars.eff_tls).toBe("verify");
    expect(call.vars.eff_pems).toBe(PEM_NAMES);
    expect(call.vars.eff_ca).toBe("CA-remote-tls");
  }

  function expectIsolatedConfig(): void {
    const call = lastCall();
    expect(call.vars.config).toBe(JSON.stringify(CONFIG));
    expect(call.vars.config_mode).toBe("600");
    expect(call.vars.dir_mode).toBe("700");
    expect(call.vars.DOCKER_AUTH_CONFIG).toBe("<unset>");
  }

  function expectStoreIntact(tlsDir: string): void {
    for (const [file, content] of Object.entries(PEMS)) expect(readFileSync(join(tlsDir, file), "utf8")).toBe(content);
  }

  let home: string;

  beforeEach(() => {
    home = join(root, "home");
    mkdirSync(home);
  });

  test("DOCKER_CONTEXT names a TLS context: the pull reaches the context's engine with the context's own TLS files", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({ HOME: home, DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { endpoint, pulled } = await endpointThenPull(env);
    expect(endpoint).toEqual({ ok: true, host: HOST_TLS, context: "remote-tls" });
    expect(pulled.ok).toBe(true);

    expectTlsPull();
    expectIsolatedConfig();
    const call = lastCall();
    expect(call.argv.slice(0, 2)).toEqual(["--context", "remote-tls"]);
    expect(call.argv).not.toContain("--host");
    expect(call.vars.DOCKER_CONTEXT).toBe("<unset>");
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("the developer also exports DOCKER_TLS_VERIFY=1: the context's files are used, not $HOME/.docker's", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({
      HOME: home,
      DOCKER_CONTEXT: "remote-tls",
      DOCKER_TLS_VERIFY: "1",
      FAKE_CONTEXT_NAME: "remote-tls",
      FAKE_CONTEXT_HOST: HOST_TLS,
    });

    const { pulled } = await endpointThenPull(env);
    expect(pulled.ok).toBe(true);
    expectTlsPull();
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("`docker context use` (no DOCKER_CONTEXT) with the store under DOCKER_CONFIG: the store is found through DOCKER_CONFIG, not HOME", async () => {
    const configDir = join(root, "cfg");
    const { tlsDir } = writeContext(configDir, "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({ HOME: home, DOCKER_CONFIG: configDir, FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { endpoint, pulled } = await endpointThenPull(env);
    expect(endpoint).toEqual({ ok: true, host: HOST_TLS, context: "remote-tls" });
    expect(calls()[0]?.argv).toEqual(["context", "inspect", "--format", '{{.Name}}{{"\\t"}}{{(index .Endpoints "docker").Host}}']);
    expect(pulled.ok).toBe(true);

    expectTlsPull();
    expectIsolatedConfig();
    expect(lastCall().vars.DOCKER_CONFIG).not.toBe(configDir);
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("a SkipTLSVerify context with no TLS files: TLS stays on, unverified", async () => {
    writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { skipTLSVerify: true });
    const env = baseEnv({ HOME: home, DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { pulled } = await endpointThenPull(env);
    expect(pulled.ok).toBe(true);
    const call = lastCall();
    expect(call.vars.eff_err).toBe("");
    expect(call.vars.eff_host).toBe(HOST_TLS);
    expect(call.vars.eff_tls).toBe("noverify");
    expect(pullDirs()).toEqual([]);
  });

  test("a failed pull still removes the throwaway directory and leaves the developer's context store intact", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({
      HOME: home,
      DOCKER_CONTEXT: "remote-tls",
      FAKE_CONTEXT_NAME: "remote-tls",
      FAKE_CONTEXT_HOST: HOST_TLS,
      FAKE_PULL_EXIT: "1",
      FAKE_PULL_ERR: "Error response from daemon: denied",
    });

    const { pulled } = await endpointThenPull(env);
    expect(pulled).toEqual({ ok: false, detail: "Error response from daemon: denied" });
    expectTlsPull();
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
    expect(existsSync(join(home, ".docker", "contexts", "meta"))).toBe(true);
  });

  test("a context the store does not hold is refused by Docker, and nothing is left behind", async () => {
    const env = baseEnv({ HOME: home });
    const pulled = await spawnEnvShellDocker({ env, tmpdir: () => pullTmp }).pull(REF, { host: HOST_TLS, context: "gone" }, CONFIG);
    expect(pulled).toEqual({ ok: false, detail: 'context "gone" does not exist' });
    expect(pullDirs()).toEqual([]);
  });

  test("no docker on PATH with a context endpoint → not installed, and the directory is still removed", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const docker = spawnEnvShellDocker({ env: { ...baseEnv({ HOME: home }), PATH: emptyDir }, tmpdir: () => pullTmp });
    expect(await docker.pull(REF, { host: HOST_TLS, context: "remote-tls" }, CONFIG)).toEqual({
      ok: false,
      detail: "docker is not installed",
    });
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  // End to end through `catalyst env shell`, whose signature did not change: no docker port is injected, so the
  // CLI builds the real one over ctx.env. The image is missing, and the anonymous pull succeeds, so what decides the
  // test is the TLS outcome the fake records for that one pull.
  describe("catalyst env shell, no injected docker", () => {
    async function shellWith(extra: NodeJS.ProcessEnv): Promise<number> {
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".catalyst"), { recursive: true });
      writeFileSync(join(repo, ".catalyst", "catalyst.toml"), '[environment]\ntoolchains = [{ name = "node", version = "22" }]\n');
      const ctx = makeCtx(home, {
        env: baseEnv({ HOME: home, CATALYST_SKILLS_OFFLINE: "1", FAKE_VERSION_OS: "linux", FAKE_INSPECT_EXIT: "1", ...extra }),
      });
      return main(["env", "shell", "--root", repo], ctx, {
        env: { shell: { isTty: () => true, platform: "darwin", uid: 501, readRepositoryName: async () => "acme/web", gitCommonDir: async () => null } },
      });
    }

    function expectContextTls(): void {
      const pull = calls().find((call) => call.vars.eff_tls !== undefined);
      if (!pull) throw new Error("the fake docker never saw a pull");
      expect(pull.vars.eff_err).toBe("");
      expect(pull.vars.eff_host).toBe(HOST_TLS);
      expect(pull.vars.eff_tls).toBe("verify");
      expect(pull.vars.eff_pems).toBe(PEM_NAMES);
      expect(pull.vars.eff_ca).toBe("CA-remote-tls");
    }

    test("DOCKER_CONTEXT names a TLS context: the first image download carries the context's TLS files", async () => {
      writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
      expect(await shellWith({ DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS })).toBe(0);
      expectContextTls();
    });

    test("the current context is a TLS context (no DOCKER_CONTEXT): the first image download carries its TLS files", async () => {
      writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
      expect(await shellWith({ FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS })).toBe(0);
      expectContextTls();
    });
  });
});

describe("pull through a named context (CTC-6154)", () => {
  const REF = "docker.io/library/alpine:3.20";
  const HOST_TLS = "tcp://remote.example:2376";
  const CONFIG = { auths: { "https://index.docker.io/v1/": {} } };
  const PEMS = { "ca.pem": "CA-remote-tls", "cert.pem": "CERT-remote-tls", "key.pem": "KEY-remote-tls" };
  const PEM_NAMES = "ca.pem cert.pem key.pem";

  /** Writes a context the way `docker context create` does: meta/<sha256(name)>/meta.json and tls/<id>/docker/*.pem. */
  function writeContext(
    configDir: string,
    name: string,
    host: string,
    opts: { skipTLSVerify?: boolean; pems?: Record<string, string> } = {},
  ): { tlsDir: string } {
    const id = createHash("sha256").update(name).digest("hex");
    const metaDir = join(configDir, "contexts", "meta", id);
    const tlsDir = join(configDir, "contexts", "tls", id, "docker");
    mkdirSync(metaDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ Name: name, Metadata: {}, Endpoints: { docker: { Host: host, SkipTLSVerify: opts.skipTLSVerify === true } } }),
      { mode: 0o600 },
    );
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    for (const [file, content] of Object.entries(opts.pems ?? {})) writeFileSync(join(tlsDir, file), content, { mode: 0o600 });
    return { tlsDir };
  }

  /** `endpoint()` then `pull()`, the way `catalyst env shell` calls them. */
  async function endpointThenPull(env: NodeJS.ProcessEnv, config = CONFIG) {
    const docker = spawnEnvShellDocker({ env, tmpdir: () => pullTmp });
    const endpoint = await docker.endpoint();
    if (!endpoint.ok) throw new Error(`endpoint() refused: ${endpoint.reason}`);
    return { endpoint, pulled: await docker.pull(REF, endpoint, config) };
  }

  function expectTlsPull(): void {
    const call = lastCall();
    expect(call.vars.eff_err).toBe("");
    expect(call.vars.eff_host).toBe(HOST_TLS);
    expect(call.vars.eff_tls).toBe("verify");
    expect(call.vars.eff_pems).toBe(PEM_NAMES);
    expect(call.vars.eff_ca).toBe("CA-remote-tls");
  }

  function expectIsolatedConfig(): void {
    const call = lastCall();
    expect(call.vars.config).toBe(JSON.stringify(CONFIG));
    expect(call.vars.config_mode).toBe("600");
    expect(call.vars.dir_mode).toBe("700");
    expect(call.vars.DOCKER_AUTH_CONFIG).toBe("<unset>");
  }

  function expectStoreIntact(tlsDir: string): void {
    for (const [file, content] of Object.entries(PEMS)) expect(readFileSync(join(tlsDir, file), "utf8")).toBe(content);
  }

  let home: string;

  beforeEach(() => {
    home = join(root, "home");
    mkdirSync(home);
  });

  test("DOCKER_CONTEXT names a TLS context: the pull reaches the context's engine with the context's own TLS files", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({ HOME: home, DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { endpoint, pulled } = await endpointThenPull(env);
    expect(endpoint).toEqual({ ok: true, host: HOST_TLS, context: "remote-tls" });
    expect(pulled.ok).toBe(true);

    expectTlsPull();
    expectIsolatedConfig();
    const call = lastCall();
    expect(call.argv.slice(0, 2)).toEqual(["--context", "remote-tls"]);
    expect(call.argv).not.toContain("--host");
    expect(call.vars.DOCKER_CONTEXT).toBe("<unset>");
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("the developer also exports DOCKER_TLS_VERIFY=1: the context's files are used, not $HOME/.docker's", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({
      HOME: home,
      DOCKER_CONTEXT: "remote-tls",
      DOCKER_TLS_VERIFY: "1",
      FAKE_CONTEXT_NAME: "remote-tls",
      FAKE_CONTEXT_HOST: HOST_TLS,
    });

    const { pulled } = await endpointThenPull(env);
    expect(pulled.ok).toBe(true);
    expectTlsPull();
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("`docker context use` (no DOCKER_CONTEXT) with the store under DOCKER_CONFIG: the store is found through DOCKER_CONFIG, not HOME", async () => {
    const configDir = join(root, "cfg");
    const { tlsDir } = writeContext(configDir, "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({ HOME: home, DOCKER_CONFIG: configDir, FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { endpoint, pulled } = await endpointThenPull(env);
    expect(endpoint).toEqual({ ok: true, host: HOST_TLS, context: "remote-tls" });
    expect(calls()[0]?.argv).toEqual(["context", "inspect", "--format", '{{.Name}}{{"\\t"}}{{(index .Endpoints "docker").Host}}']);
    expect(pulled.ok).toBe(true);

    expectTlsPull();
    expectIsolatedConfig();
    expect(lastCall().vars.DOCKER_CONFIG).not.toBe(configDir);
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  test("a SkipTLSVerify context with no TLS files: TLS stays on, unverified", async () => {
    writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { skipTLSVerify: true });
    const env = baseEnv({ HOME: home, DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS });

    const { pulled } = await endpointThenPull(env);
    expect(pulled.ok).toBe(true);
    const call = lastCall();
    expect(call.vars.eff_err).toBe("");
    expect(call.vars.eff_host).toBe(HOST_TLS);
    expect(call.vars.eff_tls).toBe("noverify");
    expect(pullDirs()).toEqual([]);
  });

  test("a failed pull still removes the throwaway directory and leaves the developer's context store intact", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const env = baseEnv({
      HOME: home,
      DOCKER_CONTEXT: "remote-tls",
      FAKE_CONTEXT_NAME: "remote-tls",
      FAKE_CONTEXT_HOST: HOST_TLS,
      FAKE_PULL_EXIT: "1",
      FAKE_PULL_ERR: "Error response from daemon: denied",
    });

    const { pulled } = await endpointThenPull(env);
    expect(pulled).toEqual({ ok: false, detail: "Error response from daemon: denied" });
    expectTlsPull();
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
    expect(existsSync(join(home, ".docker", "contexts", "meta"))).toBe(true);
  });

  test("a context the store does not hold is refused by Docker, and nothing is left behind", async () => {
    const env = baseEnv({ HOME: home });
    const pulled = await spawnEnvShellDocker({ env, tmpdir: () => pullTmp }).pull(REF, { host: HOST_TLS, context: "gone" }, CONFIG);
    expect(pulled).toEqual({ ok: false, detail: 'context "gone" does not exist' });
    expect(pullDirs()).toEqual([]);
  });

  test("no docker on PATH with a context endpoint → not installed, and the directory is still removed", async () => {
    const { tlsDir } = writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
    const docker = spawnEnvShellDocker({ env: { ...baseEnv({ HOME: home }), PATH: emptyDir }, tmpdir: () => pullTmp });
    expect(await docker.pull(REF, { host: HOST_TLS, context: "remote-tls" }, CONFIG)).toEqual({
      ok: false,
      detail: "docker is not installed",
    });
    expect(pullDirs()).toEqual([]);
    expectStoreIntact(tlsDir);
  });

  // End to end through `catalyst env shell`, whose signature did not change: no docker port is injected, so the
  // CLI builds the real one over ctx.env. The image is missing, and the anonymous pull succeeds, so what decides the
  // test is the TLS outcome the fake records for that one pull.
  describe("catalyst env shell, no injected docker", () => {
    async function shellWith(extra: NodeJS.ProcessEnv): Promise<number> {
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".catalyst"), { recursive: true });
      writeFileSync(join(repo, ".catalyst", "catalyst.toml"), '[environment]\ntoolchains = [{ name = "node", version = "22" }]\n');
      const ctx = makeCtx(home, {
        env: baseEnv({ HOME: home, CATALYST_SKILLS_OFFLINE: "1", FAKE_VERSION_OS: "linux", FAKE_INSPECT_EXIT: "1", ...extra }),
      });
      return main(["env", "shell", "--root", repo], ctx, {
        env: { shell: { isTty: () => true, platform: "darwin", uid: 501, readRepositoryName: async () => "acme/web", gitCommonDir: async () => null } },
      });
    }

    function expectContextTls(): void {
      const pull = calls().find((call) => call.vars.eff_tls !== undefined);
      if (!pull) throw new Error("the fake docker never saw a pull");
      expect(pull.vars.eff_err).toBe("");
      expect(pull.vars.eff_host).toBe(HOST_TLS);
      expect(pull.vars.eff_tls).toBe("verify");
      expect(pull.vars.eff_pems).toBe(PEM_NAMES);
      expect(pull.vars.eff_ca).toBe("CA-remote-tls");
    }

    test("DOCKER_CONTEXT names a TLS context: the first image download carries the context's TLS files", async () => {
      writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
      expect(await shellWith({ DOCKER_CONTEXT: "remote-tls", FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS })).toBe(0);
      expectContextTls();
    });

    test("the current context is a TLS context (no DOCKER_CONTEXT): the first image download carries its TLS files", async () => {
      writeContext(join(home, ".docker"), "remote-tls", HOST_TLS, { pems: PEMS });
      expect(await shellWith({ FAKE_CONTEXT_NAME: "remote-tls", FAKE_CONTEXT_HOST: HOST_TLS })).toBe(0);
      expectContextTls();
    });
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

  test("lastLine CTC-6157: a secret that crosses the 400-character cut is redacted before the cut, not left as a prefix", () => {
    expect(lastLine("a".repeat(390) + PASSWORD + " rejected", [PASSWORD])).toBe("a".repeat(390) + "[redacted]");
    expect(lastLine("a".repeat(390) + EXPECTED_AUTH + " rejected", [EXPECTED_AUTH])).toBe("a".repeat(390) + "[redacted]");
  });

  test("lastLine CTC-6157: the longest secret goes first, so one secret inside another does not split it", () => {
    expect(lastLine("denied abcXYZ12345def", ["XYZ12345", "abcXYZ12345def"])).toBe("denied [redacted]");
  });

  test("lastLine CTC-6157: an empty secret is ignored", () => {
    expect(lastLine("denied", [""])).toBe("denied");
  });

  // What Docker's echo may put inside a credential: line breaks and plain control characters (text
  // with an escape or a C1 control is withheld, tested below). Whatever sits between the characters, none of the credential comes back.
  const BREAKS = [
    ["a CRLF", "\r\n"],
    ["a line feed", "\n"],
    ["a carriage return", "\r"],
    ["a NUL", "\x00"],
    ["a bell", "\x07"],
    ["a DEL", "\x7f"],
    ["a non-ASCII character", "\u00e9"],
  ] as const;

  const BROKEN_CREDENTIALS = BREAKS.flatMap(([name, gap]) => [
    [`${name} in the password`, PASSWORD, gap] as const,
    [`${name} in the auth value`, EXPECTED_AUTH, gap] as const,
  ]);

  test.each(BROKEN_CREDENTIALS)("lastLine CTC-6157: %s → the whole credential is redacted", (_name, secret, gap) => {
    const shown = lastLine(`progress\n${LEAD}${broken(secret, gap)} rejected`, [PASSWORD, EXPECTED_AUTH]);
    expectNoSecretFragment(shown);
    expect(shown).toBe(`${LEAD}[redacted] rejected`);
  });

  test.each([
    ["after its first character", 1],
    ["before its last character", PASSWORD.length - 1],
  ])("lastLine CTC-6157: a line break %s still redacts the password", (_name, at) => {
    const echo = `${LEAD}${broken(PASSWORD, "\r\n", at)} rejected`;
    expect(lastLine(echo, [PASSWORD])).toBe(`${LEAD}[redacted] rejected`);
  });

  test("lastLine CTC-6157: a control character between every pair of characters of the credential still redacts it", () => {
    for (const secret of [PASSWORD, EXPECTED_AUTH]) {
      const echo = `${LEAD}${[...secret].join("\x00")} rejected`;
      expect(lastLine(echo, [PASSWORD, EXPECTED_AUTH])).toBe(`${LEAD}[redacted] rejected`);
    }
  });

  test("lastLine CTC-6157: a break and the 400-character cut together: the cut falls after the redaction", () => {
    const echo = "a".repeat(395) + broken(PASSWORD, "\x07") + " rejected";
    expect(lastLine(echo, [PASSWORD])).toBe("a".repeat(395) + "[reda");
    const crlf = "a".repeat(395) + broken(EXPECTED_AUTH, "\r\n") + " rejected";
    expect(lastLine(crlf, [EXPECTED_AUTH])).toBe("a".repeat(395) + "[reda");
  });

  test.each([
    ["longest first", ["XYZ12345", "abcXYZ12345def"]],
    ["shortest first", ["abcXYZ12345def", "XYZ12345"]],
  ])("lastLine CTC-6157: one secret inside another (%s), with a break inside both", (_name, secrets) => {
    expect(lastLine("denied abc\x00XYZ12345def", secrets)).toBe("denied [redacted]");
    expect(lastLine("denied abcXYZ\r\n12345def", secrets)).toBe("denied [redacted]");
  });

  test("lastLine CTC-6157: an empty secret beside a real one changes nothing about it", () => {
    expect(lastLine(`denied ${broken(PASSWORD, "\r\n")}`, ["", PASSWORD])).toBe("denied [redacted]");
    expect(lastLine(`denied \x1b[31mred\x1b[0m`, [""])).toBe("denied [31mred[0m");
  });

  test("lastLine CTC-6157: a secret is matched as written, so regex metacharacters in it are not special", () => {
    const secret = "a.b*c+(d)[e]{1}|f^$\\g";
    expect(lastLine(`x ${broken(secret, "\x00")} y aXb*c+(d)[e]{1}|f^$\\g`, [secret])).toBe(
      "x [redacted] y aXb*c+(d)[e]{1}|f^$\\g",
    );
  });

  test("lastLine CTC-6157: text that mimics the credential over and over is handled in linear time", () => {
    const hostile = "ctcpull_\x1b[".repeat(100_000);
    const started = performance.now();
    const shown = lastLine(hostile, [PASSWORD, EXPECTED_AUTH]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(shown.length).toBeLessThanOrEqual(400);
  });
});

// CTC-6157 (review): every complete ECMA-48 escape or control sequence, 7-bit and 8-bit.
const SEQUENCES = [
  ["an OSC ended by BEL", "\x1b]0;title\x07"],
  ["an OSC ended by ST", "\x1b]0;title\x1b\\"],
  ["a DCS ended by ST", "\x1bPq#0;2;0;0;0\x1b\\"],
  ["a SOS ended by BEL", "\x1bXnote\x07"],
  ["a PM ended by ST", "\x1b^note\x1b\\"],
  ["an APC ended by BEL", "\x1b_note\x07"],
  ["an 8-bit OSC ended by 0x9C", "\x9d0;title\x9c"],
  ["an 8-bit DCS ended by BEL", "\x90qdata\x07"],
  ["an 8-bit SOS ended by 0x9C", "\x98note\x9c"],
  ["an 8-bit PM ended by 0x9C", "\x9enote\x9c"],
  ["an 8-bit APC ended by 0x9C", "\x9fnote\x9c"],
  ["a 7-bit OSC ended by 0x9C", "\x1b]0;title\x9c"],
  ["a charset designation (ESC ( B)", "\x1b(B"],
  ["a save-cursor escape (ESC 7)", "\x1b7"],
  ["a two-intermediate escape (ESC SP F)", "\x1b F"],
  ["an 8-bit CSI", "\x9b31m"],
  ["an 8-bit CSI with parameters", "\x9b38;5;196m"],
] as const;

const SEQUENCE_CASES = SEQUENCES.flatMap(([name, gap]) => [
  [`${name} in the password`, PASSWORD, gap] as const,
  [`${name} in the auth value`, EXPECTED_AUTH, gap] as const,
]);

describe("lastLine CTC-6157: text with an escape or a C1 control is withheld", () => {
  test.each(SEQUENCE_CASES)("%s → the detail is withheld", (_name, secret, gap) => {
    const shown = lastLine(`progress\n${LEAD}${broken(secret, gap)} rejected`, [PASSWORD, EXPECTED_AUTH]);
    expect(shown).toBe("");
  });

  test.each(SEQUENCE_CASES)("%s straddling the 400-character cut → withheld", (_name, secret, gap) => {
    const line = LEAD + "a".repeat(395 - LEAD.length) + broken(secret, gap) + " rejected";
    expect(lastLine(line, [PASSWORD, EXPECTED_AUTH])).toBe("");
  });

  test.each(SEQUENCE_CASES)("%s → redactSecrets (the second layer) withholds it too", (_name, secret, gap) => {
    expect(redactSecrets(`${LEAD}${broken(secret, gap)} rejected`, [PASSWORD, EXPECTED_AUTH])).toBe("");
  });

  test("an OSC with no terminator inside a secret is withheld", () => {
    for (const secret of [PASSWORD, EXPECTED_AUTH]) {
      for (const gap of ["\x1b]0;title", "\x9d0;title", "\x1bPdata"]) {
        expect(lastLine(`${LEAD}${broken(secret, gap)} rejected`, [PASSWORD, EXPECTED_AUTH])).toBe("");
      }
    }
  });

  test("an unterminated OSC inside the password straddling the cut is withheld", () => {
    const line = LEAD + "a".repeat(390 - LEAD.length) + broken(PASSWORD, "\x1b]0;title") + " rejected";
    expect(lastLine(line, [PASSWORD, EXPECTED_AUTH])).toBe("");
  });

  test("a low-entropy password: coloured text that only mentions the word is withheld, never half-redacted", () => {
    const shown = lastLine("\x1b[31mwrong password for user\x1b[0m", ["password123", "cGFzc3dvcmQxMjM="]);
    expect(shown).toBe("");
  });

  test("escape-free text that mentions the word stays as it was", () => {
    expect(lastLine("wrong password for user", ["password123"])).toBe("wrong password for user");
    expect(redactSecrets("wrong password for user", ["password123"])).toBe("wrong password for user");
  });

  test("text with no secret in it, even with sequences, comes out as before", () => {
    expect(lastLine("denied \x1b]0;title\x07 \x1b(B \x9b31m end")).toBe(
      "denied ]0;title (B 31m end",
    );
    expect(redactSecrets("plain \x1b[31mctcpull_\x1b[0m only", [""])).toBe("plain \x1b[31mctcpull_\x1b[0m only");
    expect(redactSecrets("plain \x1b[31m only", [])).toBe("plain \x1b[31m only");
  });

  test("hostile unterminated control strings are handled in linear time", () => {
    const hostile = "ctcpull_\x1b]".repeat(100_000);
    const started = performance.now();
    const shown = lastLine(hostile, [PASSWORD, EXPECTED_AUTH]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(shown.length).toBeLessThanOrEqual(400);
  });
});
