// Shared ESM launcher for @catalyst-cloud/cli (CTC-1926, CTC-3479). tsc does not carry a shebang
// through emit, so each bin is a tiny wrapper around this module and the program lives in dist/cli.js.
// bin/catalyst.js is the command; bin/catalyst-skills.js is its deprecated second name. Two files,
// not one file that sniffs process.argv[1]: npm's Windows shims pass the real script path, so the
// invoked name is only reliable as the file that was run.
//
// ⛔ NEVER `process.exit(code)` STRAIGHT AFTER A WRITE. When stdout is a PIPE — which is how every
// skill script spawns this CLI — writes are asynchronous, so `process.exit` severs whatever is
// still in flight AND STILL REPORTS THE ORIGINAL EXIT CODE. The caller then reads a truncated body
// with a success code and has no way to tell it from a complete one: `query issues --json` on a
// tenant with ~80+ tickets came back as 65,528 bytes of invalid JSON, exit 0 (0.2.0). Interactive
// use hid it, because a tty gives stdout a synchronous write path.
//
// So: park the code on `process.exitCode`, wait for both streams to drain, and only then exit. The
// explicit exit stays — `fetch`'s keep-alive sockets can hold the event loop open for seconds after
// the work is done, and a CLI that lingers is its own defect — but by then nothing is buffered.
//
// ⛔ THE PREFLIGHT BELOW RUNS BEFORE dist/cli.js IS IMPORTED (CTC-2158). It answers "can THIS
// runtime run the CLI, and if not, what is the one command?" using the SAME dist/runtime.js verdict
// every other message in the package reads — one voice, not a second copy of the floor logic.
// Importing dist/runtime.js, dist/runtime-store.js and dist/config.js here is safe on every runtime
// measured for this ticket (Node 22.14, Node 26.8.1, bun 1.3.14, bun 1.4.2): none of the three
// imports node:sqlite or the SDK, which are the only two things that used to abort module loading
// before main() ever ran. `runtime` itself is EXEMPT from every refusal below, or the fix command
// could not be run on the broken runtime it exists to fix.
//
// Policy (CATALYST_SKILLS_RUNTIME overrides: auto | pinned | ambient):
//   • a pin is installed (and the policy is not "ambient") -> re-exec into it, always. A customer
//     who ran `runtime install` asked for a runtime independent of the machine's default Node — this
//     is where they get it (Tier 2).
//   • auto (default), ambient supported, no pin -> run in process. ZERO extra process: skill
//     scripts spawn this CLI constantly, and doubling process startup on every call is a real cost.
//   • ambient unsupported, no pin -> print the verdict and the ONE command; exit 1, never a raw
//     module-resolution error.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** The one stderr line the deprecated name prints in addition to what the program prints. */
export const DEPRECATED_NAME_LINE =
  "catalyst-skills: this command name is deprecated. Run catalyst instead, with the same arguments.";

/**
 * Run the CLI with this process's arguments. `invokedAs` is the command name the person typed,
 * fixed by which bin file ran; `binUrl` is that bin's import.meta.url, which a re-exec into the
 * pinned runtime runs again so the child keeps the same name.
 *
 * Where the deprecated name's line goes depends on who reads stderr. Skill scripts spawn the CLI
 * through a pipe and report the FIRST stderr line as the error, so on a pipe the line comes last,
 * after the program's own output. On a terminal a person reads it, and a long-running verb such as
 * `watch` may never finish, so there it comes first. A re-exec prints nothing itself: the child is
 * the same bin and prints the line once.
 */
export async function launch(invokedAs, binUrl) {
  const argv = process.argv.slice(2);
  const deprecated = invokedAs === "catalyst-skills";
  if (argv[0] !== "runtime" && (await runSelectedVersion(invokedAs, binUrl))) return;
  const handled = argv[0] === "runtime" ? false : await preflight(invokedAs, binUrl, argv, deprecated);
  if (handled) return;
  const noticeFirst = deprecated && process.stderr.isTTY === true;
  if (noticeFirst) process.stderr.write(`${DEPRECATED_NAME_LINE}\n`);
  const noticeLast = deprecated && !noticeFirst;
  import("../dist/cli.js")
    .then((m) => m.main(argv))
    .then((code) => finish(code, noticeLast))
    .catch((err) => {
      console.error(`${invokedAs}: failed to load: ${err instanceof Error ? err.message : String(err)}`);
      finish(1, noticeLast);
    });
}

/**
 * CTC-6708 — a release check installs the approved CLI in its own directory and records it as the
 * selected version (dist/update-cli.js). This command stays where npm put it, so scheduled jobs and
 * saved launcher paths keep working: when the selected version is newer than its own, it loads that
 * version's bin in this same process (no second process, so a pid, a signal and an exit code are the
 * selected version's own). The selected version's launcher finds nothing newer and runs. Any doubt
 * (no record, an unreadable one, a directory that does not hold that version) runs this version, as
 * before. A release check that runs a staged version to check it sets CATALYST_CLI_ACTIVE_RUNTIME
 * to that bin's path, so that run never selects. Returns true when it already handled the invocation.
 */
async function runSelectedVersion(invokedAs, binUrl) {
  if (process.env.CATALYST_CLI_ACTIVE_RUNTIME === fileURLToPath(binUrl)) return false;
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/";
  let bin = null;
  try {
    const [updateCli, config] = await Promise.all([import("../dist/update-cli.js"), import("../dist/config.js")]);
    bin = updateCli.activeRuntimeBin(home, config.readManifest().version, basename(fileURLToPath(binUrl)));
  } catch {
    return false;
  }
  if (!bin) return false;
  const { pathToFileURL } = await import("node:url");
  await import(pathToFileURL(bin).href);
  return true;
}

/** Returns true when it already handled (and exited) the invocation. */
async function preflight(invokedAs, binUrl, args, deprecated) {
  const policy = process.env.CATALYST_SKILLS_RUNTIME ?? "auto";
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/";

  let runtimeStore, runtimeMod, config;
  try {
    [runtimeStore, runtimeMod, config] = await Promise.all([import("../dist/runtime-store.js"), import("../dist/runtime.js"), import("../dist/config.js")]);
  } catch {
    // dist/ itself failed to resolve for some other reason — fall through to the normal import
    // in launch(), whose own .catch() will surface that loudly rather than hiding it here.
    return false;
  }

  const pin = policy === "ambient" ? null : runtimeStore.readPin(home);
  if (pin) {
    const { existsSync } = await import("node:fs");
    if (existsSync(pin.nodePath)) {
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync(pin.nodePath, [fileURLToPath(binUrl), ...args], {
        stdio: "inherit",
        env: { ...process.env, CATALYST_SKILLS_RUNTIME: "ambient" },
      });
      await finish(res.status ?? 1, false);
      return true;
    }
  }

  if (policy === "pinned") {
    console.error(`${invokedAs}: CATALYST_SKILLS_RUNTIME=pinned but no pinned runtime is installed. Run: ${runtimeMod.FIX_COMMAND}`);
    await finish(1, deprecated);
    return true;
  }

  let manifest;
  try {
    manifest = config.readManifest();
  } catch (err) {
    console.error(`${invokedAs}: ${err instanceof Error ? err.message : String(err)}`);
    await finish(1, deprecated);
    return true;
  }

  // CATALYST_SKILLS_RUNTIME_FACTS is a test-only injection seam: it lets the launcher's own tests
  // drive an unsupported/supported runtime without actually installing one.
  const facts = process.env.CATALYST_SKILLS_RUNTIME_FACTS ? JSON.parse(process.env.CATALYST_SKILLS_RUNTIME_FACTS) : runtimeMod.detectRuntime();
  const verdict = runtimeMod.runtimeVerdict(facts, manifest.enginesNode);
  if (!verdict.supported) {
    console.error(`${invokedAs}: ${verdict.line}`);
    if (verdict.reason) console.error(`  ${verdict.reason}`);
    if (verdict.fix) console.error(`  fix: ${verdict.fix}`);
    await finish(1, deprecated);
    return true;
  }
  return false;
}

/**
 * Resolve once every byte already handed to `stream` has reached the other end. The empty write is
 * ordered behind the real ones, so its callback is the drain signal; a destroyed or errored stream
 * (a reader that hung up) resolves immediately rather than hanging the process forever.
 */
function drained(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("error", done);
    try {
      stream.write("", done);
    } catch {
      done();
    }
  });
}

async function finish(code, notice) {
  process.exitCode = code;
  if (notice) process.stderr.write(`${DEPRECATED_NAME_LINE}\n`);
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
