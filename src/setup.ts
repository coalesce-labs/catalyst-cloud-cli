// setup.ts — CTC-4625: `catalyst setup`, what a person sees while Catalyst installs.
//
// install.sh is a small POSIX bootstrap: it checks for Node, npm, git and a coding agent, gets
// this command, and runs `catalyst setup --engine <file> --engine-sha256 <digest> -- <its args>`.
// The engine is the served install script's step bodies. It runs unchanged in behaviour, with
// CATALYST_INSTALL_UI=events: it keeps the lock, the last-run.json receipt, resume, the flags and
// the exit codes, and instead of drawing anything it reports on fd 4 (see setup-events.ts). This
// command draws those reports, asks the questions, and runs the sign-in itself.
//
//   fd 3  the --json document, forwarded to stdout unchanged (one document)
//   fd 4  the engine's events
//   fd 5  this command's answers, one line per question or sign-in
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { VERB_USAGE } from "./args.js";
import type { Ctx } from "./config.js";
import {
  plainSetupLine,
  SetupEventStream,
  type SetupEvent,
} from "./setup-events.js";
import {
  createSetupRenderer,
  type SetupRenderer,
  type SetupStream,
} from "./setup-render.js";
import type { SigninOutcome } from "./setup-signin.js";
import { setupPartHeading } from "./setup-onboard-copy.js";

export type SetupAsk = Extract<SetupEvent, { kind: "ask" }>;

export interface SetupDeps {
  /** Continue project setup in the same process after the engine releases its lock. */
  onboard?: (
    r: SetupRenderer,
    flags: {
      json: boolean;
      yes: boolean;
      verbose: boolean;
      localSync: boolean;
      runner?: boolean;
      logPath?: string;
    },
  ) => Promise<number>;
  stdout: SetupStream;
  stderr: SetupStream;
  /** Where fd 3's --json document goes: this process's stdout. */
  writeJson: (chunk: string) => void;
  /** A person can answer questions (a terminal, and no --yes). */
  interactive: boolean;
  /** The answer, or null when the person cancelled the question (Ctrl-C at a prompt). `gone`
   *  aborts when the engine has exited and nobody will read the answer. */
  ask?: (
    event: SetupAsk,
    r: SetupRenderer,
    gone: AbortSignal,
  ) => Promise<string | null>;
  /** `stop` aborts on Ctrl-C during the sign-in, or when the engine has exited. */
  signin?: (
    seconds: number,
    r: SetupRenderer,
    stop: AbortSignal,
    spinner: () => SetupSpinner | null,
  ) => Promise<SigninOutcome>;
  /** A spinner on the human stream (stdout, or stderr under --json); null where it cannot draw. */
  spinner?: (
    r: SetupRenderer,
    stream: "stdout" | "stderr",
  ) => SetupSpinner | null;
}

export interface SetupSpinner {
  start(msg: string): void;
  message(msg: string): void;
  stop(): void;
}

const MACHINE_TITLES: Record<number, string> = {
  1: "Install the catalyst command",
  2: "Add the Catalyst skills",
  3: "Set up folders",
  4: "Sign in to Catalyst",
  5: "Local sync",
  6: "Schedule the daily update",
};
const EXIT_STOPPED = 10;
/** How long the engine's pipes may take to drain after it exits. */
const PIPE_DRAIN_MS = 2000;
/** Flags the engine reads a value after, so a value is never mistaken for --json or --yes. */
const VALUED = new Set([
  "--scope",
  "--prefix",
  "--repo-root",
  "--worktrees-root",
  "--thoughts-repo",
  "--housekeeping",
  "--login-timeout",
  "--replica-db",
  "--profile",
]);

export const SETUP_USAGE = VERB_USAGE.setup ?? "setup";

interface Parsed {
  engine: string;
  sha256: string;
  args: string[];
}

function parseSetupArgv(argv: string[]): Parsed | string {
  let engine = "";
  let sha256 = "";
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--engine" || a === "--engine-sha256") {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === "--engine") engine = value;
      else sha256 = value;
      continue;
    }
    break;
  }
  if (!engine || !sha256) return "--engine and --engine-sha256 are required";
  if (!/^[0-9a-f]{64}$/.test(sha256))
    return "--engine-sha256 must be 64 lowercase hex characters";
  return { engine, sha256, args: argv.slice(i) };
}

/** Which of the engine's own flags were given, read the way its parser reads them. */
export function engineFlags(args: readonly string[]): {
  json: boolean;
  yes: boolean;
  verbose: boolean;
  localSync: boolean;
  runner?: boolean;
  logPath?: string;
} {
  const seen: ReturnType<typeof engineFlags> = { json: false, yes: false, verbose: false, localSync: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (VALUED.has(a)) {
      i++;
      continue;
    }
    if (a === "--json") seen.json = true;
    if (a === "--yes") seen.yes = true;
    if (a === "--verbose") seen.verbose = true;
    if (a === "--with-replica") seen.localSync = true;
    if (a === "--runner") seen.runner = true;
    if (a === "--no-runner") seen.runner = false;
  }
  return seen;
}

/** The plan's steps: number and title on one line, what it does indented below, a blank line between. */
function planRenderer(r: SetupRenderer) {
  let open = false;
  let hidden = false;
  return {
    plan(number: number, title: string, text: string) {
      hidden = number === 5 || number === 7;
      if (hidden) return;
      if (open) r.blank();
      open = true;
      r.plan(number >= 8 ? number - 2 : number === 6 ? 5 : number, title, text);
    },
    more(text: string) {
      if (!hidden) r.line(`      ${text}`);
    },
    close() {
      open = false;
    },
  };
}

/** A stop before the engine ran: the person's line, and under --json the one document anyway. */
function stopBeforeEngine(
  deps: SetupDeps,
  ctx: Ctx,
  json: boolean,
  message: string,
): number {
  createSetupRenderer(deps.stderr, ctx.env).line(`catalyst setup: ${message}`);
  if (json)
    deps.writeJson(
      `${JSON.stringify(
        {
          schema: "catalyst-install-last-run/1",
          state: "stopped",
          exitCode: EXIT_STOPPED,
          message,
          fix: "run the install command again",
          steps: [],
        },
        null,
        2,
      )}\n`,
    );
  return EXIT_STOPPED;
}

/** A shell reports a child killed by a signal as 128 plus its number; so does this command. */
function exitCodeOf(
  status: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (status !== null) return status;
  return signal ? 128 + (constants.signals[signal] ?? 0) : EXIT_STOPPED;
}

export async function cmdSetup(
  argv: string[],
  ctx: Ctx,
  deps: SetupDeps,
): Promise<number> {
  const parsed = parseSetupArgv(argv);
  if (typeof parsed === "string")
    return stopBeforeEngine(
      deps,
      ctx,
      argv.includes("--json"),
      `${parsed}. Usage: catalyst ${SETUP_USAGE}`,
    );
  const flags = engineFlags(parsed.args);
  let body: Buffer;
  try {
    body = readFileSync(parsed.engine);
  } catch (error) {
    return stopBeforeEngine(
      deps,
      ctx,
      flags.json,
      `the setup engine ${parsed.engine} could not be read (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`,
    );
  }
  if (createHash("sha256").update(body).digest("hex") !== parsed.sha256)
    return stopBeforeEngine(
      deps,
      ctx,
      flags.json,
      "the setup engine did not match the digest install.sh expected. Nothing was run, and nothing was changed.",
    );
  // The engine runs from a private copy of the bytes just checked, so the file it was given cannot
  // change between the check and the run.
  const own = mkdtempSync(join(tmpdir(), "catalyst-setup-engine-"));
  try {
    const engine = join(own, "engine.sh");
    writeFileSync(engine, body, { mode: 0o600 });
    return await runEngine(engine, parsed.args, flags, ctx, deps);
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
}

async function runEngine(
  engine: string,
  args: readonly string[],
  flags: ReturnType<typeof engineFlags>,
  ctx: Ctx,
  deps: SetupDeps,
): Promise<number> {
  const errors = createSetupRenderer(deps.stderr, ctx.env);
  const human = flags.json ? deps.stderr : deps.stdout;
  const r = createSetupRenderer(
    human,
    flags.json ? { ...ctx.env, NO_COLOR: "1" } : ctx.env,
  );
  const plan = planRenderer(r);
  // Aborts once the engine has exited: a question or sign-in still open then has nobody to answer.
  const gone = new AbortController();
  // The sign-in in progress, if any; Ctrl-C stops only that one.
  let signinStop: AbortController | null = null;
  const child: ChildProcess = spawn("/bin/sh", [engine, ...args], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
    env: {
      ...ctx.env,
      CATALYST_INSTALL_UI: "events",
      CATALYST_INSTALL_INTERACTIVE: deps.interactive && !flags.yes ? "1" : "0",
    },
  });
  // Node types `stdio` as a five-slot tuple; fds 3 to 5 exist because the spawn above asked for them.
  const pipes: readonly unknown[] = child.stdio;
  const jsonPipe = pipes[3];
  const eventPipe = pipes[4];
  const answers = pipes[5];
  if (
    !(jsonPipe instanceof Readable) ||
    !(eventPipe instanceof Readable) ||
    !(answers instanceof Writable)
  ) {
    child.kill("SIGTERM");
    return stopBeforeEngine(
      deps,
      ctx,
      flags.json,
      "the setup engine's pipes could not be opened. Nothing was changed.",
    );
  }
  answers.on("error", () => {
    // The engine stopped before reading its answer; its exit code says why.
  });
  const answer = (line: string) => {
    if (!answers.destroyed) answers.write(`${line}\n`);
  };
  let spin: SetupSpinner | null = null;
  const spinner = () =>
    deps.spinner?.(r, flags.json ? "stderr" : "stdout") ?? null;
  const stopSpin = () => {
    spin?.stop();
    spin = null;
  };
  const changes: string[] = [];
  const deferredEnding: Array<Extract<SetupEvent, { kind: "line" | "heading" }>> = [];
  let current: Extract<SetupEvent, { kind: "begin" }> | null = null;
  let queue = Promise.resolve();
  const handle = async (event: SetupEvent): Promise<void> => {
    if (event.kind !== "begin") stopSpin();
    if (event.kind !== "plan" && event.kind !== "more") plan.close();
    switch (event.kind) {
      case "line":
        if (/^(Details:|Full log:)\s+/.test(event.text))
          flags.logPath = event.text.replace(/^(Details:|Full log:)\s+/, "");
        if (deps.onboard && /^(Next:|Details:|Full log:)\s+/.test(event.text)) {
          deferredEnding.push(event);
          return;
        }
        if (event.text === "") r.blank();
        else if (
          !deps.onboard ||
          !/^(Next:|Details:|Full log:|This computer is ready)/.test(event.text)
        ) {
          if (event.text === "Catalyst setup") r.intro(event.text);
          else r.line(event.text);
        }
        return;
      case "row":
        r.line(`  ${event.label.padEnd(18)} ${event.value}`);
        return;
      case "heading":
        if (deps.onboard && ["What’s left", "What's left"].includes(event.text)) {
          deferredEnding.push(event);
          return;
        }
        if (
          !deps.onboard ||
          !["What’s left", "What\'s left"].includes(event.text)
        )
          r.heading(
            event.text === "Setting up"
              ? setupPartHeading(1, r.traits.unicode)
              : event.text,
          );
        return;
      case "plan":
        plan.plan(event.number, event.title, event.text);
        return;
      case "more":
        plan.more(event.text);
        return;
      case "begin":
        stopSpin();
        current = event;
        if (event.number !== 7)
          r.begin(
            event.number === 6 ? 5 : event.number === 5 ? 0 : event.number,
            MACHINE_TITLES[event.number] ?? event.title,
          );
        return;
      case "step":
        if (event.number !== 7)
          r.step(
            event.mark === "act" && event.number === 6 ? "skip" : event.mark,
            event.number === 6 ? 5 : event.number === 5 ? 0 : event.number,
            MACHINE_TITLES[event.number] ?? event.title,
            event.outcome,
          );
        else if (event.mark === "fail")
          r.step("fail", 0, "This computer", event.outcome);
        current = null;
        return;
      case "detail":
        if (current || flags.verbose) r.detail(event.text);
        return;
      case "change":
        changes.push(event.text);
        return;
      case "changes-end":
        if (flags.verbose) for (const text of changes.splice(0)) r.line(text);
        return;
      case "verdict":
        if (!event.ok || !deps.onboard) {
          r.heading(event.ok ? "Setup complete" : "Not ready for work yet");
          r.line(event.text);
        }
        return;
      case "stop": {
        const block = createSetupRenderer(deps.stderr, ctx.env);
        block.line(block.bold(event.header));
        block.line(`  What happened: ${event.what}`);
        block.line(`  Already done:  ${event.done}`);
        block.line(`  To fix:        ${event.fix}`);
        block.line(`  Log:           ${event.log}`);
        // An agent greps this line and runs it as is, so it is never wrapped.
        deps.stderr.write(`resume: ${event.resume}\n`);
        return;
      }
      case "ask": {
        if (!(deps.interactive && !flags.yes && deps.ask)) {
          answer(event.fallback);
          return;
        }
        const reply = await deps.ask(event, r, gone.signal);
        if (reply === null) {
          // Ctrl-C at a prompt arrives as a cancelled question (the prompt holds the terminal in
          // raw mode). The engine stops the way it stops on Ctrl-C: record, block, exit 10.
          child.kill("SIGINT");
          answer(event.id === "continue" ? "n" : "");
          return;
        }
        if (event.id === "replica") flags.localSync = /^y(es)?$/i.test(reply);
        answer(reply);
        return;
      }
      case "signin": {
        // The sign-in is the one step a person does: it gets its own line before the code.
        r.update("waiting for you");
        if (!deps.signin) {
          answer("failed");
          return;
        }
        const stop = new AbortController();
        signinStop = stop;
        try {
          answer(
            await deps.signin(
              event.timeoutSeconds,
              r,
              AbortSignal.any([stop.signal, gone.signal]),
              spinner,
            ),
          );
        } finally {
          signinStop = null;
        }
        return;
      }
      case "note":
        if (flags.verbose) r.line(r.dim(event.text));
        return;
    }
  };
  // Events are handled one at a time, in order: a question holds the lines after it until answered.
  // A handler that fails still answers, so the engine is never left waiting on fd 5.
  const enqueue = (event: SetupEvent) => {
    queue = queue
      .then(() => handle(event))
      .catch((error: unknown) => {
        stopSpin();
        errors.line(
          `catalyst setup: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (event.kind === "ask") answer(event.fallback);
        if (event.kind === "signin") answer("failed");
      });
  };
  const events = new SetupEventStream(enqueue);
  const passThrough = new SetupEventStream(enqueue, plainSetupLine);
  eventPipe
    .setEncoding("utf8")
    .on("data", (chunk: string) => events.push(chunk));
  let machineJson = "";
  jsonPipe.setEncoding("utf8").on("data", (chunk: string) => {
    if (deps.onboard) machineJson += chunk;
    else deps.writeJson(chunk);
  });
  // Anything the engine prints outside the protocol is still shown, never lost.
  for (const stream of [child.stdout, child.stderr])
    stream
      ?.setEncoding("utf8")
      .on("data", (chunk: string) => passThrough.push(chunk));
  // Ctrl-C reaches the engine too (same process group), and it records and stops on its own. This
  // command only stops a sign-in in progress, and on a second Ctrl-C stops an engine still going.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts += 1;
    signinStop?.abort();
    if (interrupts > 1) child.kill("SIGTERM");
  };
  process.on("SIGINT", onInterrupt);
  child.on("exit", () => gone.abort());
  const closed = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  try {
    const code = await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        errors.line(
          `catalyst setup: the setup engine could not start (${error.message}).`,
        );
        resolve(EXIT_STOPPED);
      });
      child.on("exit", (status, signal) => resolve(exitCodeOf(status, signal)));
    });
    // The engine is done; its last lines may still be in the pipes. A background child it started
    // can hold them open for good, so wait for them briefly, not until that child exits.
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, PIPE_DRAIN_MS).unref()),
    ]);
    for (const pipe of [eventPipe, jsonPipe, child.stdout, child.stderr])
      pipe?.destroy();
    events.end();
    passThrough.end();
    await queue;
    stopSpin();
    if (
      code === 0 &&
      deps.onboard &&
      !args.some((a) => ["--dry-run", "--help", "-h"].includes(a))
    ) {
      try {
        return await deps.onboard(r, flags);
      } catch {
        errors.line(
          "catalyst setup: onboarding could not finish. Run catalyst setup to try again.",
        );
        if (flags.json)
          deps.writeJson(
            `${JSON.stringify({ schema: "catalyst-install-last-run/1", state: "failed", exitCode: 10, steps: [] })}\n`,
          );
        return 10;
      }
    }
    // A failed, declined or dry-run engine never enters onboarding. Preserve its actual
    // repair guidance; successful continuation owns the sole final screen instead.
    for (const event of deferredEnding) {
      if (event.kind === "heading") r.heading(event.text);
      else if (event.text.startsWith("Next:")) r.outro(event.text);
      else r.line(event.text);
    }
    if (machineJson) deps.writeJson(machineJson);
    return code;
  } finally {
    r.dispose();
    process.off("SIGINT", onInterrupt);
  }
}
