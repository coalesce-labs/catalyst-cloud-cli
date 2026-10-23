import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
const io = vi.hoisted(() => ({
  terminal: null as {
    input: PassThrough;
    output: PassThrough;
    close: () => void;
  } | null,
  ports: [] as { input: unknown; output: unknown }[],
  uiVerbose: [] as boolean[],
  argVerbose: [] as boolean[],
  argRunner: [] as unknown[],
}));
vi.mock("../src/setup-prompts.js", async (original) => ({
  ...(await original<typeof import("../src/setup-prompts.js")>()),
  openSetupTerminal: () => io.terminal,
  clackSetupAsk: () => async () => "y",
}));
vi.mock("../src/onboard-ui.js", async (original) => {
  const actual = await original<typeof import("../src/onboard-ui.js")>();
  return {
    ...actual,
    createClackOnboardUi: (
      ...args: Parameters<typeof actual.createClackOnboardUi>
    ) => {
      io.ports.push(args[1]);
      io.uiVerbose.push(args[2]?.verbose === true);
      return actual.createClackOnboardUi(...args);
    },
  };
});
vi.mock("../src/onboard-runtime.js", async () => {
  const { ONBOARD_STEPS } = await import("../src/onboard.js");
  return {
    createOnboardRuntime: (
      _args: { flags: Record<string, unknown> },
      _ctx: unknown,
      deps: { ui?: unknown },
    ) => {
      io.argVerbose.push(_args.flags.verbose === true);
      io.argRunner.push(_args.flags.runner === true ? true : _args.flags["no-runner"] === true ? false : undefined);
      return ({
      ui: deps.ui,
      bindSignals: false,
      adapters: Object.fromEntries(
        ONBOARD_STEPS.map((id) => [
          id,
          { check: async () => ({ state: "done" }) },
        ]),
      ),
      });
    },
  };
});
import { main } from "../src/cli.js";
import { defaultCtx } from "../src/config.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
  io.ports = [];
  io.uiVerbose = [];
  io.argVerbose = [];
  io.argRunner = [];
  io.terminal = null;
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "setup-cli-consent-"));
  homes.push(home);
  const path = join(home, "engine.sh");
  const source = `#!/bin/sh\nprintf 'ask\\tcontinue\\tStart setup?\\ty\\n' >&4\nIFS= read -r answer <&5\n[ "$answer" = y ] || exit 10\nprintf '{"machine":true}\\n' >&3\nexit 0\n`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  const output: string[] = [];
  io.terminal = {
    input: new PassThrough(),
    output: new PassThrough(),
    close: () => {},
  };
  return {
    args: [
      "setup",
      "--engine",
      path,
      "--engine-sha256",
      createHash("sha256").update(source).digest("hex"),
      "--",
    ],
    ctx: {
      ...defaultCtx(),
      home,
      env: {},
      stdout: (line: string) => output.push(line),
      stderr: () => {},
    },
    output,
  };
}
test("approved JSON setup on a controlling terminal continues onboarding without another consent", async () => {
  const f = fixture();
  expect(await main([...f.args, "--json"], f.ctx, { isTty: () => true })).toBe(
    0,
  );
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0]!)).toMatchObject({
    verdict: "complete",
    exit: 0,
    complete: true,
  });
  expect(io.ports).toHaveLength(0);
});
test("actual setup dispatcher gives onboarding prompts the controlling output", async () => {
  const f = fixture();
  const terminal = io.terminal!;
  expect(await main(f.args, f.ctx, { isTty: () => true })).toBe(0);
  expect(io.ports).toEqual([
    { input: terminal.input, output: terminal.output },
  ]);
  expect(io.ports[0]!.output).not.toBe(process.stdout);
});

test.each([false, true])("setup verbose reaches onboarding args and its human UI (JSON=%s)", async (json) => {
 const f=fixture();
 expect(await main([...f.args, "--verbose", ...(json?["--json"]:[])],f.ctx,{isTty:()=>true})).toBe(0);
 expect(io.argVerbose).toEqual([true]);
 expect(io.uiVerbose).toEqual(json ? [] : [true]);
});

 test.each([["--runner", true], ["--no-runner", false]] as const)("setup forwards %s through the engine continuation", async (flag, selected) => {
   const f = fixture();
   expect(await main([...f.args, flag], f.ctx, { isTty: () => true })).toBe(0);
   expect(io.argRunner).toEqual([selected]);
 });
