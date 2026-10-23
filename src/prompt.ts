// prompt.ts — the CLI's interactive reads: asking for the personal key on a terminal without
// echoing it, and one [y/N] question. The streams are parameters so the tests can drive it without a real TTY.
import { createInterface } from "node:readline";
import { createInterface as createPromiseInterface } from "node:readline/promises";

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** True when there is a terminal to prompt on. Both ends matter: the question needs somewhere to go. */
export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a `[y/N]` question on stderr and read the answer. False without a terminal, and for anything but y/yes. */
export async function confirmYesNo(question: string): Promise<boolean> {
  if (!stdinIsTty()) return false;
  const prompt = createPromiseInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * Read one line without echoing it. Everything readline would write after the question itself goes
 * to a muted stream, so the key never reaches the screen or a scrollback buffer; the caller still
 * gets it back, trimmed.
 */
export async function promptSecret(question: string, io?: PromptIo): Promise<string> {
  const input = io?.input ?? process.stdin;
  const target = io?.output ?? process.stdout;
  let muted = false;
  const output = Object.create(target) as NodeJS.WritableStream;
  output.write = (chunk: string | Uint8Array): boolean => {
    if (!muted) target.write(chunk);
    return true;
  };
  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (value) => resolve(value));
      muted = true;
    });
    target.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}
