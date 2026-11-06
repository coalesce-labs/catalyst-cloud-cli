// shell-docker.ts — the docker CLI as `catalyst env shell` uses it: is an engine running, where is
// it, is the image here, one download through a throwaway config, and the container itself. Modelled
// on onboard-runner.ts's spawnDocker, endpoint rule and anonymous pull.
import { spawn, type StdioOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, homedir, tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

/** Exactly what the download's throwaway Docker config holds. */
export interface DockerConfigJson {
  auths: Record<string, { auth?: string }>;
}

export type EnvShellServer =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "not_running" }
  | { state: "not_linux"; os: string };

export interface EnvShellDocker {
  server(): Promise<EnvShellServer>;
  endpoint(): Promise<{ ok: true; host: string } | { ok: false; reason: "conflict" | "unreadable" }>;
  imagePresent(ref: string): Promise<boolean>;
  /** One pull through a throwaway config holding exactly `config`; the directory is removed in `finally`. */
  pull(ref: string, host: string, config: DockerConfigJson): Promise<{ ok: boolean; detail: string }>;
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

/** What can sit between two characters of an echoed secret without showing on a terminal. Two models
 *  are tried, because a malformed sequence can swallow a secret character: the first drops every
 *  character outside printable ASCII, line breaks included; the second also drops each complete ECMA-48
 *  sequence whole, so that its printable remainder (`[31m`, `]0;title`, `(B`) goes with it:
 *   - CSI: `ESC [` or 0x9B, parameter bytes 0x30-0x3F, intermediates 0x20-0x2F, one final byte 0x40-0x7E;
 *   - a control string (OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`, or 0x9D, 0x90, 0x98, 0x9E, 0x9F)
 *     up to and including its terminator BEL, `ESC \` or 0x9C;
 *   - any other escape: `ESC`, intermediates 0x20-0x2F, one final byte 0x30-0x7E (`ESC ( B`, `ESC 7`).
 *  A sequence that never completes (a control string with no terminator) is not dropped by either model;
 *  `scrubFragments` is the net for that. */
function withoutBreaks(text: string, sequences: boolean): { kept: string; at: number[] } {
  const gone = new Uint8Array(text.length);
  const code = (i: number): number => (i < text.length ? text.charCodeAt(i) : -1);
  const csiEnd = (from: number): number => {
    let j = from;
    while (code(j) >= 0x30 && code(j) <= 0x3f) j++;
    while (code(j) >= 0x20 && code(j) <= 0x2f) j++;
    return code(j) >= 0x40 && code(j) <= 0x7e ? j + 1 : -1;
  };
  // Once a search for a terminator finds none, no later start can find one either: stay linear.
  let noTerminator = false;
  const stringEnd = (from: number): number => {
    if (noTerminator) return -1;
    for (let j = from; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c === 0x07 || c === 0x9c) return j + 1;
      if (c === 0x1b && code(j + 1) === 0x5c) return j + 2;
    }
    noTerminator = true;
    return -1;
  };
  const sequenceEnd = (i: number): number => {
    const c = text.charCodeAt(i);
    if (c === 0x9b) return csiEnd(i + 1);
    if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) return stringEnd(i + 1);
    if (c !== 0x1b) return -1;
    const next = code(i + 1);
    if (next === 0x5b) return csiEnd(i + 2);
    if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return stringEnd(i + 2);
    let j = i + 1;
    while (code(j) >= 0x20 && code(j) <= 0x2f) j++;
    return code(j) >= 0x30 && code(j) <= 0x7e ? j + 1 : -1;
  };
  for (let i = 0; i < text.length; i++) {
    const end = sequences ? sequenceEnd(i) : -1;
    if (end > 0) {
      gone.fill(1, i, end);
      i = end - 1;
    } else if (text.charCodeAt(i) < 0x20 || text.charCodeAt(i) > 0x7e) gone[i] = 1;
  }
  let kept = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (gone[i]) continue;
    kept += text[i];
    at.push(i);
  }
  return { kept, at };
}

const FRAGMENT = 8;

/** Whether `text` holds an escape or an 8-bit control character: the only case where a split the break
 *  model cannot parse is possible, and so the only one `scrubFragments` runs for. */
function hasEscape(text: string): boolean {
  return /[\x1b\x80-\x9f]/.test(text);
}

/** Replaces each stretch of `text` that is made of 8-character pieces of a secret with "[redacted]".
 *  The net under `redactSecrets`, for a split no break model parses, such as an OSC with no terminator
 *  inside a secret: it catches the readable pieces on either side, not a piece shorter than 8. Callers
 *  run it only for text that held an escape or an 8-bit control character, so that other text comes
 *  out as it went in. It is a `Set` lookup of fixed-size slices, never a pattern built from a secret. */
function scrubFragments(text: string, secrets: readonly string[]): string {
  const pieces = new Set<string>();
  for (const secret of secrets) {
    for (let i = 0; i + FRAGMENT <= secret.length; i++) pieces.add(secret.slice(i, i + FRAGMENT));
  }
  if (pieces.size === 0) return text;
  const hit = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + FRAGMENT <= text.length; i++) {
    if (!pieces.has(text.slice(i, i + FRAGMENT))) continue;
    hit.fill(1, i, i + FRAGMENT);
    any = true;
  }
  if (!any) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!hit[i]) out += text[i];
    else if (i === 0 || !hit[i - 1]) out += "[redacted]";
  }
  return out;
}

/** Every occurrence of each non-empty secret becomes "[redacted]", also when Docker broke it up with
 *  control characters, a line break or a complete ECMA-48 escape or control sequence (CTC-6157): the whole stretch from its first
 *  character to its last is replaced. Occurrences that overlap, such as one secret inside another,
 *  become one marker. This is a plain `indexOf` over the text with the breaks taken out, never a
 *  pattern built from a secret, so it cannot backtrack and needs no escaping. The secrets here are
 *  printable ASCII: a password is `\x21-\x7e` and an `auth` value is base64. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const wanted = secrets.filter((secret) => secret !== "");
  if (wanted.length === 0) return text;
  // covered[i] counts the occurrences that start at or before i and have not ended yet.
  const covered = new Int32Array(text.length + 1);
  let found = false;
  for (const sequences of [false, true]) {
    const { kept, at } = withoutBreaks(text, sequences);
    for (const secret of wanted) {
      for (let i = kept.indexOf(secret); i >= 0; i = kept.indexOf(secret, i + 1)) {
        covered[at[i]]++;
        covered[at[i + secret.length - 1] + 1]--;
        found = true;
      }
    }
  }
  if (!found) return hasEscape(text) ? scrubFragments(text, wanted) : text;
  let out = "";
  let depth = 0;
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    depth += covered[i];
    if (depth === 0) out += text[i];
    else if (!inside) out += "[redacted]";
    inside = depth > 0;
  }
  return hasEscape(text) ? scrubFragments(out, wanted) : out;
}

/** Docker's last non-empty error line, printable characters only. The secrets are redacted from the
 *  whole raw text, before it is split into lines and stripped and before it is cut to 400 characters,
 *  so neither a break inside a secret nor the cut can leave a fragment that no replacement matches
 *  (CTC-6157). The cut can still fall inside "[redacted]". */
export function lastLine(text: string, secrets: readonly string[] = []): string {
  const lines = redactSecrets(text, secrets)
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
    .filter((line) => line !== "");
  // The escapes are gone by now, so a piece of a secret an unparsed one split shows again: scrub the
  // line once more, when the raw text held an escape, before it is cut.
  const last = lines.at(-1) ?? "";
  const scrubbed = hasEscape(text) ? scrubFragments(last, secrets.filter((secret) => secret !== "")) : last;
  return scrubbed.slice(0, 400);
}

/** The secrets a pull's config carries: each `auth` value and the password it encodes. */
function secretsOf(config: DockerConfigJson): string[] {
  return Object.values(config.auths).flatMap(({ auth }) => {
    if (!auth) return [];
    const decoded = Buffer.from(auth, "base64").toString("utf8");
    return [auth, decoded.slice(decoded.indexOf(":") + 1)];
  });
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
        '{{(index .Endpoints "docker").Host}}',
      ]);
      const host = read.stdout.trim();
      return read.code === 0 && host !== "" ? { ok: true, host } : { ok: false, reason: "unreadable" };
    },
    async imagePresent(ref) {
      return (await quiet(["image", "inspect", "--format", "{{.Id}}", ref])).code === 0;
    },
    async pull(ref, host, config) {
      // The config is the only channel for the credential, so nothing it holds may come back in `detail`.
      const secrets = secretsOf(config);
      let dir: string | undefined;
      try {
        // mkdtemp creates the directory 0700; the file is 0600 and holds nothing else.
        dir = mkdtempSync(join((deps.tmpdir ?? osTmpdir)(), "catalyst-env-pull-"));
        writeFileSync(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
        const pullEnv: NodeJS.ProcessEnv = {
          ...env,
          DOCKER_CONFIG: dir,
          // A TLS endpoint keeps the developer's own certificates although the config moved.
          DOCKER_CERT_PATH: env.DOCKER_CERT_PATH || env.DOCKER_CONFIG || join(env.HOME || homedir(), ".docker"),
        };
        delete pullEnv.DOCKER_CONTEXT;
        delete pullEnv.DOCKER_AUTH_CONFIG;
        // Progress goes to our stderr, so `--json` stdout stays one line; the error stream is kept.
        const result = await spawnWait(["--host", host, "--config", dir, "pull", ref], {
          env: pullEnv,
          stdio: ["ignore", 2, "pipe"],
          timeoutMs: 3_600_000,
        });
        if (result.missing) return { ok: false, detail: "docker is not installed" };
        return { ok: result.code === 0, detail: lastLine(result.stderr, secrets) };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? lastLine(error.message, secrets) : "the download could not start" };
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
