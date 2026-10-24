// codex-attribution.test.ts: the Codex launch hooks `catalyst setup` installs around `catalyst
// codex-env`: the marked rc block (written, replaced in place, never beside a hand-written codex, and
// removed byte for byte), the macOS login agent through a fake launchctl, the launch environment's
// cleanup, and the one status line. Every test runs in a fixture HOME that the tests name as the
// account's own; the real launchctl, the real rc files and the network are never touched.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { parseArgs } from "../src/args";
import { codexAccountsCachePathFor } from "../src/config";
import { loginSha256 } from "../src/codex-env";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  CODEX_ABSENT_LINE,
  CODEX_ATTRIBUTION_LABEL,
  codexAgentPlist,
  codexAgentPlistPath,
  codexAttributionStatusLine,
  codexAttributionAfterSetup,
  codexBlock,
  codexPresence,
  definesCodex,
  findBlocks,
  installCodexAgent,
  removeCodexAttribution,
  RC_BACKUP_SUFFIX,
  setupCodexAttribution,
  withoutAppliedAttributes,
  type CodexAttributionDeps,
} from "../src/codex-attribution";
import type { SchedulerRun } from "../src/runner-auto-update";
import { FIXTURE_ME_BODY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const NOW = new Date("2026-10-24T12:00:00Z");
const ONE_ID = "acct-local-one";
const TWO_ID = "acct-local-two";
const CLI =
  "/opt/catalyst/lib/node_modules/@catalyst-cloud/cli/bin/catalyst.js";

let server: FixtureServer;
let home: string;
let fetches: number;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  fetches = 0;
  // Codex is installed unless a test says otherwise: the desktop app in the fixture's ~/Applications.
  mkdirSync(join(home, "Applications", "Codex.app"), { recursive: true });
});

/** A fetch that records the call and never answers: anything that awaited it would hang the test. */
const hangingFetch = (() => {
  fetches++;
  return new Promise<Response>(() => {});
}) as typeof fetch;

function ctxWith(env: Record<string, string> = { SHELL: "/bin/zsh" }): TestCtx {
  return makeCtx(home, {
    env: { CATALYST_SKILLS_OFFLINE: "1", ...env },
    fetch: hangingFetch,
    now: () => NOW,
  });
}

/** launchctl as a little state machine: print answers for a loaded agent, and the launch env is one value. */
function fakeLaunchctl(
  start: {
    loaded?: boolean;
    env?: string;
    stuck?: boolean;
    bootstrapFails?: boolean;
    /** bootstrap answers 0, but the agent is gone again before the check. */
    dropsAtLoad?: boolean;
    /** getenv prints the value and still exits non-zero. */
    getenvFails?: boolean;
    /** setenv and unsetenv exit non-zero and change nothing. */
    envWriteFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let loaded = start.loaded ?? false;
  let env = start.env ?? "";
  const ok = { status: 0, stdout: "", stderr: "" };
  const refused = { status: 1, stdout: "", stderr: "Operation not permitted" };
  const run: SchedulerRun = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "launchctl")
      return { status: 127, stdout: "", stderr: "not launchctl" };
    switch (args[0]) {
      case "print":
        return loaded
          ? ok
          : { status: 113, stdout: "", stderr: "Could not find service" };
      case "bootstrap":
        if (start.bootstrapFails)
          return {
            status: 5,
            stdout: "",
            stderr: "Bootstrap failed: 5: Input/output error",
          };
        if (!start.dropsAtLoad) loaded = true;
        return ok;
      case "bootout":
        if (!start.stuck) loaded = false;
        return ok;
      case "kickstart":
        return ok;
      case "getenv":
        return {
          status: start.getenvFails ? 1 : 0,
          stdout: `${env}\n`,
          stderr: "",
        };
      case "setenv":
        if (start.envWriteFails) return refused;
        env = args[2] ?? "";
        return ok;
      case "unsetenv":
        if (start.envWriteFails) return refused;
        env = "";
        return ok;
      default:
        return { status: 1, stdout: "", stderr: `unexpected ${args[0]}` };
    }
  };
  return {
    calls,
    run,
    get loaded() {
      return loaded;
    },
    get env() {
      return env;
    },
  };
}

const deps = (
  run: SchedulerRun,
  over: CodexAttributionDeps = {},
): CodexAttributionDeps => ({
  platform: "darwin",
  run,
  uid: 501,
  cli: CLI,
  path: "/opt/catalyst/bin:/usr/bin:/bin",
  realHome: () => home,
  applicationDirs: [join(home, "Applications")],
  ...over,
});
const linux = (): CodexAttributionDeps =>
  deps(fakeLaunchctl().run, { platform: "linux" });

const zshrc = () => join(home, ".zshrc");
const bashrc = () => join(home, ".bashrc");
const bytes = (path: string) => readFileSync(path);
const blockCount = (path: string) =>
  readFileSync(path, "latin1")
    .split("\n")
    .filter((l) => l.replace(/\r$/, "") === BLOCK_BEGIN).length;

function writeLogin(dir: string, accountId: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "never-read-token", account_id: accountId },
    }),
  );
}

function writeAccountCache(fetchedAt: Date): void {
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    codexAccountsCachePathFor(home),
    JSON.stringify({
      fetchedAt: fetchedAt.toISOString(),
      workspace: FIXTURE_ME_BODY.account,
      accounts: [
        { accountSlot: "codex-one", loginSha256: loginSha256(ONE_ID) },
        { accountSlot: "codex-two", loginSha256: loginSha256(TWO_ID) },
      ],
    }),
  );
}

const shells = {
  bash: spawnSync("bash", ["--version"]).status === 0,
  zsh: spawnSync("zsh", ["--version"]).status === 0,
};

/** A `catalyst` that answers codex-env --print with the Codex home's folder name, and a `codex` that
 *  prints the attributes it was started with and its arguments. */
function fakeTools(answers = true): string {
  const bin = join(home, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "catalyst"),
    answers
      ? `#!/bin/sh\n[ "$1 $2 $3" = "codex-env --print --codex-home" ] || exit 2\nprintf 'catalyst.account_slot=%s,host.name=box\\n' "$(basename "$4")"\n`
      : "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nprintf '%s|%s\\n' "\${OTEL_RESOURCE_ATTRIBUTES-unset}" "$*"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function runShell(
  shell: "bash" | "zsh",
  rc: string,
  script: string,
  bin: string,
): string[] {
  const body = `. "${rc}"; ${script}`;
  const args =
    shell === "zsh"
      ? ["-f", "-c", body]
      : ["--norc", "--noprofile", "-c", body];
  const r = spawnSync(shell, args, {
    encoding: "utf8",
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect(r.stderr).toBe("");
  return r.stdout.trimEnd().split("\n");
}

const LAUNCHES = `codex exec hi; CODEX_HOME="$HOME/.codex-homes/work" codex; echo "after=\${OTEL_RESOURCE_ATTRIBUTES-unset}"`;
const EXPECTED = [
  "catalyst.account_slot=.codex,host.name=box|exec hi",
  "catalyst.account_slot=work,host.name=box|",
  "after=unset",
];

describe("Scenario: A terminal Codex launch carries its coding account after setup", () => {
  test.skipIf(!shells.bash)(
    "bash: codex carries codex-env --print's answer for the Codex home in use, for that one call only",
    () => {
      setupCodexAttribution(ctxWith({ SHELL: "/bin/bash" }), linux());
      expect(runShell("bash", bashrc(), LAUNCHES, fakeTools())).toEqual(
        EXPECTED,
      );
    },
  );

  test.skipIf(!shells.zsh)("zsh: the same block works the same way", () => {
    setupCodexAttribution(ctxWith({ SHELL: "/bin/zsh" }), linux());
    expect(runShell("zsh", zshrc(), LAUNCHES, fakeTools())).toEqual(EXPECTED);
  });

  test.skipIf(!shells.bash)(
    "when catalyst cannot answer, codex still runs, with nothing added to its environment",
    () => {
      setupCodexAttribution(ctxWith({ SHELL: "/bin/bash" }), linux());
      expect(runShell("bash", bashrc(), "codex", fakeTools(false))).toEqual([
        "unset|",
      ]);
    },
  );

  test("the block runs only flags codex-env takes, and the real codex through `command`", () => {
    const block = codexBlock();
    expect(block).toContain(
      'command catalyst codex-env --print --codex-home "${CODEX_HOME:-$HOME/.codex}"',
    );
    expect(block).toContain('command codex "$@"');
    expect(() =>
      parseArgs(["codex-env", "--print", "--codex-home", "/x"]),
    ).not.toThrow();
  });

  test("a second Codex home on the same machine gets its own slot", async () => {
    await seedJoined(home, server, { contract: false });
    writeAccountCache(new Date(NOW.getTime() - 60_000));
    writeLogin(join(home, ".codex"), ONE_ID);
    writeLogin(join(home, ".codex-homes", "work"), TWO_ID);
    const spawned: string[][] = [];
    const printed = async (codexHome: string) => {
      const ctx = ctxWith();
      const code = await main(
        ["codex-env", "--print", "--codex-home", codexHome],
        ctx,
        {
          codexEnv: {
            hostname: () => "box",
            detach: (argv) => {
              spawned.push(argv);
              return { pid: 4242 };
            },
          },
        },
      );
      expect(code).toBe(0);
      return ctx.out.at(-1);
    };
    expect(await printed(join(home, ".codex"))).toBe(
      "catalyst.account_slot=codex-one,host.name=box",
    );
    expect(await printed(join(home, ".codex-homes", "work"))).toBe(
      "catalyst.account_slot=codex-two,host.name=box",
    );
    expect(spawned).toEqual([]);
    expect(fetches).toBe(0);
  });
});

describe("Scenario: Running setup twice leaves one hook", () => {
  test("a second run leaves every rc file byte for byte as the first run wrote it", () => {
    writeFileSync(zshrc(), "export PATH=$HOME/bin:$PATH\n");
    writeFileSync(bashrc(), "alias ll='ls -l'\n");
    const f = fakeLaunchctl();
    const first = setupCodexAttribution(ctxWith(), deps(f.run));
    const after = [bytes(zshrc()), bytes(bashrc())];
    const second = setupCodexAttribution(ctxWith(), deps(f.run));
    expect([bytes(zshrc()), bytes(bashrc())]).toEqual(after);
    expect(blockCount(zshrc())).toBe(1);
    expect(blockCount(bashrc())).toBe(1);
    expect(first[0]).toContain("~/.zshrc (added) and ~/.bashrc (added)");
    expect(second[0]).toContain(
      "~/.zshrc (unchanged) and ~/.bashrc (unchanged)",
    );
  });

  test("an older block is replaced in place, and the lines around it are kept", () => {
    writeFileSync(
      zshrc(),
      `export A=1\n${BLOCK_BEGIN}\nalias codex=old-hook\n${BLOCK_END}\nexport B=2\n`,
    );
    const lines = setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe(
      `export A=1\n${codexBlock()}export B=2\n`,
    );
    expect(lines[0]).toContain("~/.zshrc (replaced)");
  });

  test("a copied second block is dropped, leaving exactly one", () => {
    writeFileSync(
      zshrc(),
      `export A=1\n${codexBlock()}export B=2\n${codexBlock()}`,
    );
    setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe(
      `export A=1\n${codexBlock()}export B=2\n`,
    );
  });

  test("a zsh-only Mac gets no ~/.bashrc; a ~/.bashrc that exists gets the block", () => {
    setupCodexAttribution(ctxWith({ SHELL: "/bin/zsh" }), linux());
    expect(existsSync(zshrc())).toBe(true);
    expect(existsSync(bashrc())).toBe(false);
    writeFileSync(bashrc(), "");
    setupCodexAttribution(ctxWith({ SHELL: "/bin/zsh" }), linux());
    expect(readFileSync(bashrc(), "utf8")).toBe(codexBlock());
  });

  test("with $ZDOTDIR set, the block goes to $ZDOTDIR/.zshrc, ~/.zshrc is untouched, and removal undoes it there", () => {
    const zdot = join(home, ".config", "zsh");
    mkdirSync(zdot, { recursive: true });
    const zdotRc = join(zdot, ".zshrc");
    const zdotBefore = Buffer.from("export IN_ZDOTDIR=1\n");
    const homeBefore = Buffer.from("export IN_HOME=1\n");
    writeFileSync(zdotRc, zdotBefore);
    writeFileSync(zshrc(), homeBefore);
    const ctx = () => ctxWith({ SHELL: "/bin/zsh", ZDOTDIR: zdot });
    setupCodexAttribution(ctx(), linux());
    expect(blockCount(zdotRc)).toBe(1);
    expect(bytes(zshrc())).toEqual(homeBefore);
    const removal = removeCodexAttribution(ctx(), linux());
    expect(removal.ok).toBe(true);
    expect(bytes(zdotRc)).toEqual(zdotBefore);
    expect(bytes(zshrc())).toEqual(homeBefore);
  });

  test("a ~/.zshrc linked into a dotfiles folder inside HOME stays a link: the target gets the block, and removal restores the target byte for byte", () => {
    const real = join(home, "dotfiles", "zshrc");
    mkdirSync(join(home, "dotfiles"));
    const before = Buffer.from("export A=1\n");
    writeFileSync(real, before);
    symlinkSync(real, zshrc());
    setupCodexAttribution(ctxWith(), linux());
    expect(lstatSync(zshrc()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`export A=1\n${codexBlock()}`);
    removeCodexAttribution(ctxWith(), linux());
    expect(lstatSync(zshrc()).isSymbolicLink()).toBe(true);
    expect(bytes(real)).toEqual(before);
  });

  test("a 0600 rc file stays 0600 after setup and after removal", () => {
    writeFileSync(zshrc(), "export SECRET_FREE=1\n", { mode: 0o600 });
    expect(statSync(zshrc()).mode & 0o777).toBe(0o600);
    setupCodexAttribution(ctxWith(), linux());
    expect(blockCount(zshrc())).toBe(1);
    expect(statSync(zshrc()).mode & 0o777).toBe(0o600);
    removeCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe("export SECRET_FREE=1\n");
    expect(statSync(zshrc()).mode & 0o777).toBe(0o600);
  });

  test("a write that fails midway leaves the rc file byte for byte as it was, with no temp file and no partial file", () => {
    const before = Buffer.from("export A=1\nexport B=2\n");
    writeFileSync(zshrc(), before);
    const written: string[] = [];
    const failing = linux();
    failing.files = {
      writeFile: (path, data, options) => {
        written.push(path);
        writeFileSync(
          path,
          (typeof data === "string" ? Buffer.from(data) : data).subarray(0, 8),
          options,
        );
        throw new Error("disk full");
      },
    };
    const lines = setupCodexAttribution(ctxWith(), failing);
    expect(written).toHaveLength(1);
    expect(bytes(zshrc())).toEqual(before);
    expect(existsSync(written[0]!)).toBe(false);
    expect(readdirSync(home).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
    expect(lines.join("\n")).toContain(
      "Left ~/.zshrc without the Codex launch hook: it could not be read or written (disk full)",
    );
  });

  test("a rename that fails leaves the rc file as it was and removes the temp file", () => {
    const before = Buffer.from("export A=1\n");
    writeFileSync(zshrc(), before);
    const failing = linux();
    failing.files = {
      rename: () => {
        throw new Error("rename refused");
      },
    };
    setupCodexAttribution(ctxWith(), failing);
    expect(bytes(zshrc())).toEqual(before);
    expect(readdirSync(home).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });

  test("a write that fails during removal leaves the block in place and fails the removal", () => {
    writeFileSync(zshrc(), "export A=1\n");
    setupCodexAttribution(ctxWith(), linux());
    const withBlock = bytes(zshrc());
    const failing = linux();
    failing.files = {
      rename: () => {
        throw new Error("rename refused");
      },
    };
    const removal = removeCodexAttribution(ctxWith(), failing);
    expect(removal.ok).toBe(false);
    expect(bytes(zshrc())).toEqual(withBlock);
    expect(readdirSync(home).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });

  test("a link to a file outside the home folder is never written, and setup says so", () => {
    const elsewhere = tempHome();
    const real = join(elsewhere, "zshrc");
    writeFileSync(real, "export A=1\n");
    symlinkSync(real, zshrc());
    const lines = setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(real, "utf8")).toBe("export A=1\n");
    expect(lines.join("\n")).toMatch(
      /Left ~\/\.zshrc without the Codex launch hook: it is a link to .*zshrc, outside your home folder/,
    );
  });

  test("a start marker without its end marker leaves the file alone", () => {
    writeFileSync(zshrc(), `${BLOCK_BEGIN}\nexport A=1\n`);
    const lines = setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe(`${BLOCK_BEGIN}\nexport A=1\n`);
    expect(lines.join("\n")).toContain("without its partner");
  });
});

describe("Scenario: A hand-written codex function or alias is left alone", () => {
  test.each([
    ["an alias", "alias codex='codex --search'\n"],
    ["a zsh global alias", "alias -g codex=codex-nightly\n"],
    ["one alias among several", "alias ll='ls -l' codex='codex --search'\n"],
    ["a function", 'codex() { command codex --search "$@"; }\n'],
    ["a function with a space", "codex () {\n  command codex\n}\n"],
    ["the function keyword", "function codex {\n  command codex\n}\n"],
    [
      "the function keyword with parentheses",
      "function codex() {\n  command codex\n}\n",
    ],
    ["a CRLF alias", "alias codex=codex-nightly\r\n"],
  ])(
    "%s outside the block: setup writes nothing to that file and says why",
    (_name, text) => {
      writeFileSync(zshrc(), text);
      writeFileSync(bashrc(), "export A=1\n");
      const lines = setupCodexAttribution(ctxWith(), linux());
      expect(readFileSync(zshrc(), "utf8")).toBe(text);
      expect(lines.join("\n")).toContain(
        "Left ~/.zshrc without the Codex launch hook: it already defines codex itself, as a function or an alias",
      );
      expect(blockCount(bashrc())).toBe(1);
    },
  );

  test.each([
    ["a helper function", "codex_helper() { echo hi; }\n"],
    ["a helper with the keyword", "function codex_helper {\n  echo hi\n}\n"],
    ["a helper alias", "alias codex_helper='codex --search'\n"],
    ["a commented-out alias", "# alias codex='codex --search'\n"],
    ["a plain call", "codex --version >/dev/null\n"],
  ])("%s is not a codex definition", (_name, text) => {
    expect(definesCodex(text)).toBe(false);
    writeFileSync(zshrc(), text);
    setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe(text + codexBlock());
  });

  test("the block's own codex function never counts as the person's", () => {
    writeFileSync(zshrc(), codexBlock());
    expect(definesCodex(codexBlock())).toBe(true);
    expect(setupCodexAttribution(ctxWith(), linux())[0]).toContain(
      "~/.zshrc (unchanged)",
    );
  });
});

describe("Scenario: A Dock launch of the Codex desktop app carries its coding account", () => {
  test("the agent runs codex-env --apply with the absolute CLI path, at load and when the default login file changes", () => {
    const plist = codexAgentPlist({
      cli: CLI,
      path: "/opt/catalyst/bin:/usr/bin",
      home,
    });
    expect(plist).toContain(
      `<key>Label</key><string>${CODEX_ATTRIBUTION_LABEL}</string>`,
    );
    expect(plist).toContain(
      `<key>ProgramArguments</key><array><string>${CLI}</string><string>codex-env</string><string>--apply</string></array>`,
    );
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain(
      `<key>WatchPaths</key><array><string>${join(home, ".codex", "auth.json")}</string></array>`,
    );
    expect(plist).toContain(`<key>HOME</key><string>${home}</string>`);
  });

  test("setup writes the agent, loads it into the login session and verifies it; a second run changes nothing", () => {
    const f = fakeLaunchctl();
    const lines = setupCodexAttribution(ctxWith(), deps(f.run));
    const path = codexAgentPlistPath(home);
    expect(readFileSync(path, "utf8")).toBe(
      codexAgentPlist({
        cli: CLI,
        path: "/opt/catalyst/bin:/usr/bin:/bin",
        home,
      }),
    );
    expect(f.calls).toEqual([
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`,
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
      `launchctl kickstart gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    ]);
    expect(lines.join("\n")).toContain(
      `the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded. A Codex app that is already open picks this up the next time it starts.`,
    );
    f.calls.length = 0;
    expect(setupCodexAttribution(ctxWith(), deps(f.run)).join("\n")).toContain(
      "LaunchAgent is loaded and unchanged",
    );
    expect(f.calls).toEqual([
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    ]);
  });

  test("a moved CLI rewrites the agent: the loaded one is booted out first and loaded again", () => {
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run));
    f.calls.length = 0;
    setupCodexAttribution(
      ctxWith(),
      deps(f.run, { cli: "/usr/local/bin/catalyst" }),
    );
    expect(f.calls.slice(0, 3)).toEqual([
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
      `launchctl bootout gui/501/${CODEX_ATTRIBUTION_LABEL}`,
      `launchctl bootstrap gui/501 ${codexAgentPlistPath(home)}`,
    ]);
    expect(readFileSync(codexAgentPlistPath(home), "utf8")).toContain(
      "<string>/usr/local/bin/catalyst</string>",
    );
  });

  test("a refused bootstrap is reported with launchctl's words and the fix", () => {
    const f = fakeLaunchctl({ bootstrapFails: true });
    const lines = setupCodexAttribution(ctxWith(), deps(f.run)).join("\n");
    expect(lines).toContain(
      "Setup could not load the dev.catalystcloud.codex-attribution LaunchAgent (launchctl bootstrap exited 5: Bootstrap failed: 5: Input/output error)",
    );
    expect(lines).toContain(
      "Run catalyst setup again in Terminal on this Mac's desktop.",
    );
  });

  test("Linux gets the shell hook only: no agent file and no launchctl call", () => {
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run, { platform: "linux" }));
    expect(blockCount(zshrc())).toBe(1);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test("under a HOME that is not the account's own, setup writes nothing and asks launchctl nothing", () => {
    const f = fakeLaunchctl();
    expect(
      setupCodexAttribution(
        ctxWith(),
        deps(f.run, { realHome: () => tempHome() }),
      ),
    ).toEqual([]);
    expect(existsSync(zshrc())).toBe(false);
    expect(f.calls).toEqual([]);
  });
});

describe("Scenario: Removing the attribution restores the machine", () => {
  test.each([
    ["ends with a line break", "export A=1\n"],
    ["ends without a line break", "export A=1"],
    ["uses CRLF", "export A=1\r\nexport B=2\r\n"],
    ["uses CRLF and has no final line break", "export A=1\r\nexport B=2"],
    ["is empty", ""],
    ["holds bytes that are not UTF-8", "export A='\xff\xfe'\n"],
  ])("a file that %s is byte for byte what it was", (_name, text) => {
    const original = Buffer.from(text, "latin1");
    writeFileSync(zshrc(), original);
    setupCodexAttribution(ctxWith(), linux());
    expect(blockCount(zshrc())).toBe(1);
    expect(bytes(zshrc()).subarray(0, original.length)).toEqual(original);
    const removal = removeCodexAttribution(ctxWith(), linux());
    expect(removal.ok).toBe(true);
    expect(bytes(zshrc())).toEqual(original);
    expect(removal.lines[0]).toBe(
      "Removed the Codex launch hook from ~/.zshrc; the file is as it was before setup added it.",
    );
  });

  test("a file setup created for the block is deleted again", () => {
    setupCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toContain("setup created this file");
    removeCodexAttribution(ctxWith(), linux());
    expect(existsSync(zshrc())).toBe(false);
  });

  test("lines added after the block are kept, with the line break they follow", () => {
    writeFileSync(zshrc(), "export A=1");
    setupCodexAttribution(ctxWith(), linux());
    writeFileSync(zshrc(), `${readFileSync(zshrc(), "utf8")}export B=2\n`);
    removeCodexAttribution(ctxWith(), linux());
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\nexport B=2\n");
  });

  test("removal boots the agent out before it deletes the plist", () => {
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run));
    const plist = codexAgentPlistPath(home);
    const events: string[] = [];
    const removal = removeCodexAttribution(
      ctxWith(),
      deps(
        (cmd, args) => {
          events.push([cmd, ...args].join(" "));
          return f.run(cmd, args);
        },
        {
          files: {
            unlink: (path) => {
              events.push(`unlink ${path}`);
              unlinkSync(path);
            },
          },
        },
      ),
    );
    expect(removal.ok).toBe(true);
    const bootout = events.indexOf(
      `launchctl bootout gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    );
    const deleted = events.indexOf(`unlink ${plist}`);
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(deleted);
    expect(existsSync(plist)).toBe(false);
  });

  test("the agent is booted out and deleted, and the value --apply set is unset", () => {
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run));
    f.run("launchctl", [
      "setenv",
      "OTEL_RESOURCE_ATTRIBUTES",
      "catalyst.account_slot=codex-one,host.name=box",
    ]);
    f.calls.length = 0;
    const removal = removeCodexAttribution(ctxWith(), deps(f.run));
    expect(removal.ok).toBe(true);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
    expect(f.loaded).toBe(false);
    expect(f.env).toBe("");
    expect(f.calls).toContain(
      `launchctl bootout gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    );
    expect(f.calls).toContain("launchctl unsetenv OTEL_RESOURCE_ATTRIBUTES");
    expect(removal.lines).toContain(
      `Unloaded and deleted the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent.`,
    );
  });

  test("attributes that were there before --apply are kept: only the coding account and machine name come out", () => {
    const f = fakeLaunchctl({
      env: "deployment.environment=dev,catalyst.account_slot=codex-one,host.name=box",
    });
    const removal = removeCodexAttribution(ctxWith(), deps(f.run));
    expect(f.env).toBe("deployment.environment=dev");
    expect(f.calls).not.toContain(
      "launchctl unsetenv OTEL_RESOURCE_ATTRIBUTES",
    );
    expect(removal.agent.environment).toBe("kept_others");
  });

  test("a launch environment value with no coding account in it is not ours, and is left alone", () => {
    const f = fakeLaunchctl({ env: "service.name=mine,host.name=mine" });
    removeCodexAttribution(ctxWith(), deps(f.run));
    expect(f.env).toBe("service.name=mine,host.name=mine");
    expect(f.calls.filter((c) => /setenv|unsetenv/.test(c))).toEqual([]);
    expect(
      withoutAppliedAttributes("a=1,catalyst.account_slot=x,host.name=y"),
    ).toEqual({ applied: true, rest: "a=1" });
  });

  test("an agent launchd will not let go of fails the removal, and the environment waits for it", () => {
    const f = fakeLaunchctl({
      loaded: true,
      stuck: true,
      env: "catalyst.account_slot=codex-one,host.name=box",
    });
    const removal = removeCodexAttribution(ctxWith(), deps(f.run));
    expect(removal.ok).toBe(false);
    expect(removal.lines.join("\n")).toContain(
      `it is still loaded: run launchctl bootout gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    );
    expect(f.env).toBe("catalyst.account_slot=codex-one,host.name=box");
  });

  test("catalyst setup --remove-codex-attribution, run twice: the second run finds nothing to remove", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run));
    const first = ctxWith();
    expect(
      await main(["setup", "--remove-codex-attribution"], first, {
        codexAttribution: deps(f.run),
      }),
    ).toBe(0);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    const second = ctxWith();
    expect(
      await main(["setup", "--remove-codex-attribution"], second, {
        codexAttribution: deps(f.run),
      }),
    ).toBe(0);
    expect(second.out).toEqual([
      "No shell rc file had the Codex launch hook.",
      `The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent was not installed.`,
    ]);
    expect(fetches).toBe(0);
  });

  test("--remove-codex-attribution with --dry-run is refused before anything changes", async () => {
    writeFileSync(zshrc(), codexBlock());
    const ctx = ctxWith();
    expect(
      await main(["setup", "--remove-codex-attribution", "--dry-run"], ctx, {
        codexAttribution: linux(),
      }),
    ).toBe(1);
    expect(ctx.err.join("\n")).toContain(
      "--remove-codex-attribution changes files",
    );
    expect(readFileSync(zshrc(), "utf8")).toBe(codexBlock());
  });

  test("a block is found in a CRLF file too, and an end marker alone is malformed", () => {
    expect(findBlocks(`a\r\n${BLOCK_BEGIN}\r\nx\r\n${BLOCK_END}\r\n`)).toEqual([
      {
        start: 3,
        end: 3 + BLOCK_BEGIN.length + 2 + 3 + BLOCK_END.length + 2,
        created: false,
        newlineAdded: false,
      },
    ]);
    expect(findBlocks(`${BLOCK_END}\n`)).toBe("malformed");
  });
});

describe("Scenario: Setup status says what the default Codex login resolves to", () => {
  test("installed: one line names the slot the default Codex home resolves to and the cache age, from the cache alone", async () => {
    await seedJoined(home, server, { contract: false });
    writeAccountCache(new Date(NOW.getTime() - 2 * 3600_000 - 5_000));
    writeLogin(join(home, ".codex"), TWO_ID);
    const f = fakeLaunchctl();
    setupCodexAttribution(ctxWith(), deps(f.run));
    const cacheBefore = readFileSync(codexAccountsCachePathFor(home), "utf8");
    expect(codexAttributionStatusLine(ctxWith(), deps(f.run))).toBe(
      "Codex attribution: installed (shell hook in ~/.zshrc, login agent loaded); ~/.codex resolves to coding account codex-two, account list cached 2 hours ago.",
    );
    expect(fetches).toBe(0);
    expect(readFileSync(codexAccountsCachePathFor(home), "utf8")).toBe(
      cacheBefore,
    );
  });

  test("not installed, with no Codex login and no cache, says so and how to add it", () => {
    expect(codexAttributionStatusLine(ctxWith(), linux())).toBe(
      "Codex attribution: not installed (no shell hook); ~/.codex resolves to coding account none:no-login, no account list cached. Run catalyst setup to add it.",
    );
  });

  test("a shell hook without a loaded agent on a Mac is not installed", () => {
    setupCodexAttribution(
      ctxWith(),
      deps(fakeLaunchctl({ bootstrapFails: true }).run),
    );
    expect(
      codexAttributionStatusLine(ctxWith(), deps(fakeLaunchctl().run)),
    ).toMatch(
      /^Codex attribution: not installed \(shell hook in ~\/\.zshrc, login agent not loaded\);/,
    );
  });

  test("catalyst status ends with the line", async () => {
    await seedJoined(home, server, { contract: false });
    setupCodexAttribution(ctxWith(), linux());
    const ctx = ctxWith();
    expect(await main(["status"], ctx, { codexAttribution: linux() })).toBe(0);
    expect(ctx.out.at(-1)).toMatch(
      /^Codex attribution: installed \(shell hook in ~\/\.zshrc\); ~\/\.codex resolves to coding account none:no-login, no account list cached\.$/,
    );
  });
});

describe("Codex is not on this computer", () => {
  const noCodex = (run: SchedulerRun) =>
    deps(run, { applicationDirs: [join(home, "no-apps")] });

  test("setup writes no rc block and no agent, asks launchctl nothing, and says it skipped", () => {
    writeFileSync(zshrc(), "export A=1\n");
    const f = fakeLaunchctl();
    const lines = setupCodexAttribution(ctxWith(), noCodex(f.run));
    expect(lines).toEqual([CODEX_ABSENT_LINE]);
    expect(CODEX_ABSENT_LINE).toContain(
      "Run catalyst setup again after you install Codex",
    );
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    expect(existsSync(bashrc())).toBe(false);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test("a codex command on PATH counts as installed", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const ctx = ctxWith({ SHELL: "/bin/zsh", PATH: `/nowhere:${bin}` });
    expect(codexPresence(ctx, noCodex(fakeLaunchctl().run))).toBe(
      join(bin, "codex"),
    );
    const f = fakeLaunchctl();
    setupCodexAttribution(ctx, noCodex(f.run));
    expect(blockCount(zshrc())).toBe(1);
    expect(f.loaded).toBe(true);
  });

  test("a codex file that is not executable, or a Codex home folder alone, does not count", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "not a program\n", { mode: 0o644 });
    writeLogin(join(home, ".codex"), ONE_ID);
    const ctx = ctxWith({ SHELL: "/bin/zsh", PATH: bin });
    expect(codexPresence(ctx, noCodex(fakeLaunchctl().run))).toBeNull();
    expect(setupCodexAttribution(ctx, noCodex(fakeLaunchctl().run))).toEqual([
      CODEX_ABSENT_LINE,
    ]);
  });

  test("the desktop app in an Applications folder counts as installed", () => {
    expect(codexPresence(ctxWith(), linux())).toBe(
      join(home, "Applications", "Codex.app"),
    );
  });

  test("Codex installed later: the next setup run adds the hook and the agent", () => {
    const f = fakeLaunchctl();
    expect(setupCodexAttribution(ctxWith(), noCodex(f.run))).toEqual([
      CODEX_ABSENT_LINE,
    ]);
    expect(existsSync(zshrc())).toBe(false);
    const lines = setupCodexAttribution(ctxWith(), deps(f.run));
    expect(lines[0]).toContain("~/.zshrc (added)");
    expect(f.loaded).toBe(true);
    expect(existsSync(codexAgentPlistPath(home))).toBe(true);
  });
});

describe("Scenario: An rc file setup will not write is named, and removal leaves it alone", () => {
  test("a ~/.zshrc that is a folder", () => {
    mkdirSync(zshrc());
    expect(setupCodexAttribution(ctxWith(), linux())).toEqual([
      "Left ~/.zshrc without the Codex launch hook: it is not a regular file.",
    ]);
    const removal = removeCodexAttribution(ctxWith(), linux());
    expect(removal.files).toEqual([]);
    expect(removal.ok).toBe(true);
    expect(statSync(zshrc()).isDirectory()).toBe(true);
  });

  test("a ~/.zshrc link to a file that does not exist", () => {
    const gone = join(home, "dotfiles", "zshrc");
    symlinkSync(gone, zshrc());
    expect(setupCodexAttribution(ctxWith(), linux())).toEqual([
      "Left ~/.zshrc without the Codex launch hook: it is a link to a file that does not exist.",
    ]);
    expect(removeCodexAttribution(ctxWith(), linux()).files).toEqual([]);
    expect(lstatSync(zshrc()).isSymbolicLink()).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  test("a second start marker inside a block: setup and removal both leave the file, and removal fails", () => {
    const text = `${BLOCK_BEGIN}\nexport A=1\n${BLOCK_BEGIN}\n${BLOCK_END}\n`;
    expect(findBlocks(text)).toBe("malformed");
    writeFileSync(zshrc(), text);
    expect(setupCodexAttribution(ctxWith(), linux()).join("\n")).toContain(
      "Left ~/.zshrc without the Codex launch hook: it has a",
    );
    const removal = removeCodexAttribution(ctxWith(), linux());
    expect(removal.ok).toBe(false);
    expect(removal.lines[0]).toBe(
      `Left ~/.zshrc as it is: it has a "${BLOCK_BEGIN}" or "${BLOCK_END}" line without its partner; remove the block yourself.`,
    );
    expect(readFileSync(zshrc(), "utf8")).toBe(text);
  });

  test("removal never writes through a link outside the home folder: a block there is named for the person to remove", () => {
    const elsewhere = tempHome();
    const real = join(elsewhere, "zshrc");
    const withBlock = `export A=1\n${codexBlock()}`;
    writeFileSync(real, withBlock);
    symlinkSync(real, zshrc());
    const removal = removeCodexAttribution(ctxWith(), linux());
    expect(removal.ok).toBe(false);
    expect(removal.lines[0]).toBe(
      `Left ~/.zshrc as it is: it is a link to ${realpathSync(real)}, outside your home folder; remove the block from that file yourself.`,
    );
    expect(readFileSync(real, "utf8")).toBe(withBlock);
  });

  test("a link outside the home folder with no block, or to a folder, has no hook to remove", () => {
    const elsewhere = tempHome();
    const real = join(elsewhere, "zshrc");
    writeFileSync(real, "export A=1\n");
    symlinkSync(real, zshrc());
    const plain = removeCodexAttribution(ctxWith(), linux());
    expect(plain.files).toEqual([]);
    expect(plain.ok).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("export A=1\n");
    unlinkSync(zshrc());
    symlinkSync(elsewhere, zshrc());
    expect(removeCodexAttribution(ctxWith(), linux()).files).toEqual([]);
  });

  test("a writer that throws something other than an Error is still named in the skip line", () => {
    writeFileSync(zshrc(), "export A=1\n");
    const failing = linux();
    failing.files = {
      writeFile: () => {
        throw "quota exceeded";
      },
    };
    expect(setupCodexAttribution(ctxWith(), failing)).toEqual([
      "Left ~/.zshrc without the Codex launch hook: it could not be read or written (quota exceeded).",
    ]);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
  });

  test("no rc file and a login shell that is neither zsh nor bash: setup creates none and says so", () => {
    expect(
      setupCodexAttribution(ctxWith({ SHELL: "/bin/fish" }), linux()),
    ).toEqual([
      "No shell rc file got the Codex launch hook: there is no ~/.zshrc or ~/.bashrc, and your login shell is neither zsh nor bash.",
    ]);
    expect(existsSync(zshrc())).toBe(false);
    expect(existsSync(bashrc())).toBe(false);
  });

  test("a $ZDOTDIR outside the home folder is named by its full path, in setup and in status", () => {
    const zdot = tempHome();
    const ctx = () => ctxWith({ SHELL: "/bin/zsh", ZDOTDIR: zdot });
    const lines = setupCodexAttribution(ctx(), linux());
    expect(lines[0]).toBe(
      `Codex launches from a terminal name their coding account: the codex function is in ${join(zdot, ".zshrc")} (added).`,
    );
    expect(codexAttributionStatusLine(ctx(), linux())).toContain(
      `installed (shell hook in ${join(zdot, ".zshrc")});`,
    );
  });
});

describe("Scenario: The login agent and the launch environment when launchd does not cooperate", () => {
  test("an agent launchd drops right after bootstrap is reported, and not kickstarted", () => {
    const f = fakeLaunchctl({ dropsAtLoad: true });
    const lines = setupCodexAttribution(ctxWith(), deps(f.run)).join("\n");
    expect(lines).toContain(
      `Setup could not load the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent (launchd did not keep ${CODEX_ATTRIBUTION_LABEL} loaded)`,
    );
    expect(f.calls).toEqual([
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
      `launchctl bootstrap gui/501 ${codexAgentPlistPath(home)}`,
      `launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`,
    ]);
  });

  test("the agent installer itself refuses a HOME that is not the account's own", () => {
    const f = fakeLaunchctl();
    expect(
      installCodexAgent(ctxWith(), deps(f.run, { realHome: () => tempHome() })),
    ).toEqual({ state: "other_home" });
    expect(f.calls).toEqual([]);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
  });

  test("under a HOME that is not the account's own, removal cleans that HOME's rc files and leaves launchd alone", () => {
    writeFileSync(zshrc(), "export A=1\n");
    setupCodexAttribution(ctxWith(), linux());
    const applied = "catalyst.account_slot=codex-one,host.name=box";
    const f = fakeLaunchctl({ loaded: true, env: applied });
    const removal = removeCodexAttribution(
      ctxWith(),
      deps(f.run, { realHome: () => tempHome() }),
    );
    expect(removal.ok).toBe(true);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    expect(removal.agent).toEqual({
      agent: "other_home",
      environment: "untouched",
    });
    expect(removal.lines).toContain(
      `HOME (${home}) is not this account's home folder, so the LaunchAgent and the launch environment were left alone.`,
    );
    expect(f.calls).toEqual([]);
    expect(f.env).toBe(applied);
  });

  test("an attribute with no value is kept like any other", () => {
    const f = fakeLaunchctl({
      env: "debug,catalyst.account_slot=codex-one,host.name=box",
    });
    const removal = removeCodexAttribution(ctxWith(), deps(f.run));
    expect(removal.agent.environment).toBe("kept_others");
    expect(f.env).toBe("debug");
  });

  test("a launch environment launchctl cannot read is left alone", () => {
    const applied = "catalyst.account_slot=codex-one,host.name=box";
    const f = fakeLaunchctl({ env: applied, getenvFails: true });
    const removal = removeCodexAttribution(ctxWith(), deps(f.run));
    expect(removal.ok).toBe(true);
    expect(removal.agent.environment).toBe("untouched");
    expect(f.calls.filter((c) => /setenv|unsetenv/.test(c))).toEqual([]);
    expect(f.env).toBe(applied);
  });

  test("a launch environment launchctl will not change fails the removal with the commands to fix it, and setup exits 1", async () => {
    const applied = "catalyst.account_slot=codex-one,host.name=box";
    const f = fakeLaunchctl({ env: applied, envWriteFails: true });
    const ctx = ctxWith();
    expect(
      await main(["setup", "--remove-codex-attribution"], ctx, {
        codexAttribution: deps(f.run),
      }),
    ).toBe(1);
    expect(ctx.out).toEqual([
      "No shell rc file had the Codex launch hook.",
      `The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent was not installed.`,
      "Could not change OTEL_RESOURCE_ATTRIBUTES in the launch environment. Run launchctl getenv OTEL_RESOURCE_ATTRIBUTES to see it, and launchctl unsetenv OTEL_RESOURCE_ATTRIBUTES to clear it.",
    ]);
    expect(f.env).toBe(applied);
  });

  test("--remove-codex-attribution --json prints one document with what it changed", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    setupCodexAttribution(ctxWith(), linux());
    const ctx = ctxWith();
    expect(
      await main(["setup", "--remove-codex-attribution", "--json"], ctx, {
        codexAttribution: linux(),
      }),
    ).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({
      removed: true,
      files: [{ path: zshrc(), state: "removed" }],
      agent: { agent: "not_macos", environment: "untouched" },
      homes: [],
    });
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
  });
});

describe("Scenario: Status reads the cache age and the agent the way a person would say them", () => {
  test.each([
    [30, "under a minute"],
    [60, "1 minute"],
    [5 * 60 + 10, "5 minutes"],
    [3600, "1 hour"],
    [3 * 86400, "3 days"],
  ])(
    "a list fetched %i seconds ago was cached %s ago",
    async (seconds, said) => {
      await seedJoined(home, server, { contract: false });
      writeAccountCache(new Date(NOW.getTime() - seconds * 1000));
      writeLogin(join(home, ".codex"), TWO_ID);
      expect(codexAttributionStatusLine(ctxWith(), linux())).toBe(
        `Codex attribution: not installed (no shell hook); ~/.codex resolves to coding account codex-two, account list cached ${said} ago. Run catalyst setup to add it.`,
      );
    },
  );

  test("a Mac with the shell hook and no agent file says the agent is not installed, without asking launchctl", () => {
    setupCodexAttribution(ctxWith(), linux());
    const f = fakeLaunchctl();
    expect(codexAttributionStatusLine(ctxWith(), deps(f.run))).toBe(
      "Codex attribution: not installed (shell hook in ~/.zshrc, login agent not installed); ~/.codex resolves to coding account none:no-login, no account list cached. Run catalyst setup to add it.",
    );
    expect(f.calls).toEqual([]);
  });

  test("by default the desktop app is looked for in /Applications, then in ~/Applications", () => {
    const system = join("/Applications", "Codex.app");
    const inSystem = existsSync(system) && statSync(system).isDirectory();
    expect(codexPresence(ctxWith(), {})).toBe(
      inSystem ? system : join(home, "Applications", "Codex.app"),
    );
  });
});

describe("Scenario: Which setup runs add the hooks", () => {
  test("a full run adds them; with --json the lines go to stderr so stdout keeps its one document", () => {
    const plain = ctxWith();
    codexAttributionAfterSetup(parseArgs(["onboard"]), plain, linux());
    expect(plain.out).toEqual([
      "Codex launches from a terminal name their coding account: the codex function is in ~/.zshrc (added).",
    ]);
    expect(plain.err).toEqual([]);
    const json = ctxWith();
    codexAttributionAfterSetup(parseArgs(["onboard", "--json"]), json, linux());
    expect(json.out).toEqual([]);
    expect(json.err).toEqual([
      "Codex launches from a terminal name their coding account: the codex function is in ~/.zshrc (unchanged).",
    ]);
  });

  test.each([["--dry-run"], ["--only", "ready"], ["--no-shell-hook"]])(
    "a run with %s adds nothing and says nothing",
    (...flags) => {
      const f = fakeLaunchctl();
      const ctx = ctxWith();
      codexAttributionAfterSetup(
        parseArgs(["onboard", ...flags]),
        ctx,
        deps(f.run),
      );
      expect(existsSync(zshrc())).toBe(false);
      expect(existsSync(codexAgentPlistPath(home))).toBe(false);
      expect(f.calls).toEqual([]);
      expect([...ctx.out, ...ctx.err]).toEqual([]);
    },
  );
});

describe("Scenario: An existing install turns on Codex attribution alone (CTC-6993)", () => {
  const backup = () => `${zshrc()}${RC_BACKUP_SUFFIX}`;
  const plist = () =>
    codexAgentPlist({ cli: CLI, path: "/opt/catalyst/bin:/usr/bin:/bin", home });
  const only = (ctx: TestCtx, d: CodexAttributionDeps, ...flags: string[]) =>
    main(["setup", "--only", "codex-attribution", ...flags], ctx, { codexAttribution: d });

  test("it adds the hooks and runs no other setup step", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const f = fakeLaunchctl();
    const ctx = ctxWith();
    expect(await only(ctx, deps(f.run))).toBe(0);
    expect(readFileSync(zshrc(), "utf8")).toBe(`export A=1\n${codexBlock()}`);
    expect(readFileSync(codexAgentPlistPath(home), "utf8")).toBe(plist());
    expect(f.loaded).toBe(true);
    expect(ctx.out).toEqual([
      "Codex launches from a terminal name their coding account: the codex function is in ~/.zshrc (added). The file as it was is kept at ~/.zshrc.before-codex-attribution.",
      `Codex launches from the Dock name their coding account: the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded. A Codex app that is already open picks this up the next time it starts.`,
    ]);
    expect(ctx.err).toEqual([]);
    // No onboarding step ran: nothing reached the network.
    expect(fetches).toBe(0);
  });

  test("it keeps a byte-for-byte copy of the rc file, with its mode, and names it", async () => {
    const original = Buffer.from("export A=1\r\nalias ll='ls -l' # caf\xe9\r\n", "latin1");
    writeFileSync(zshrc(), original, { mode: 0o600 });
    const ctx = ctxWith();
    expect(await only(ctx, linux())).toBe(0);
    expect(bytes(backup()).equals(original)).toBe(true);
    expect(statSync(backup()).mode & 0o777).toBe(0o600);
    expect(ctx.out.join("\n")).toContain("kept at ~/.zshrc.before-codex-attribution");
  });

  test("an earlier copy is never overwritten, so it stays what the file was before any hook", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    expect(await only(ctxWith(), linux())).toBe(0);
    // A hook from an older release: same markers, different body.
    writeFileSync(zshrc(), `export A=1\n${BLOCK_BEGIN}\nold body\n${BLOCK_END}\n`);
    const ctx = ctxWith();
    expect(await only(ctx, linux())).toBe(0);
    expect(readFileSync(zshrc(), "utf8")).toBe(`export A=1\n${codexBlock()}`);
    expect(readFileSync(backup(), "utf8")).toBe("export A=1\n");
    expect(ctx.out).toEqual([
      "Codex launches from a terminal name their coding account: the codex function is in ~/.zshrc (replaced). An earlier copy of the file is kept at ~/.zshrc.before-codex-attribution.",
    ]);
  });

  test("--dry-run prints exactly the block and the LaunchAgent file it would write, and changes nothing", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const f = fakeLaunchctl();
    const ctx = ctxWith();
    expect(await only(ctx, deps(f.run), "--dry-run")).toBe(0);
    expect(ctx.out).toEqual([
      "Would add this block in ~/.zshrc, after keeping a copy of the file as ~/.zshrc.before-codex-attribution:",
      ...codexBlock().replace(/\n$/, "").split("\n"),
      `Would write ~/Library/LaunchAgents/${CODEX_ATTRIBUTION_LABEL}.plist and load it:`,
      ...plist().replace(/\n$/, "").split("\n"),
      "Dry run: nothing was changed.",
    ]);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    expect(existsSync(backup())).toBe(false);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
    // The only launchctl call is the read-only check of whether the agent is loaded.
    expect(f.calls).toEqual([`launchctl print gui/501/${CODEX_ATTRIBUTION_LABEL}`]);
  });

  test("--dry-run for a file setup would create prints the block it would create it with", async () => {
    const ctx = ctxWith();
    expect(await only(ctx, linux(), "--dry-run")).toBe(0);
    expect(ctx.out).toEqual([
      "Would create ~/.zshrc with this block:",
      ...codexBlock({ created: true }).replace(/\n$/, "").split("\n"),
      "Dry run: nothing was changed.",
    ]);
    expect(existsSync(zshrc())).toBe(false);
  });

  test("a second run is byte-identical and says unchanged", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const f = fakeLaunchctl();
    expect(await only(ctxWith(), deps(f.run))).toBe(0);
    const rc = bytes(zshrc());
    const copy = bytes(backup());
    const agentFile = bytes(codexAgentPlistPath(home));
    const second = ctxWith();
    expect(await only(second, deps(f.run))).toBe(0);
    expect(bytes(zshrc()).equals(rc)).toBe(true);
    expect(bytes(backup()).equals(copy)).toBe(true);
    expect(bytes(codexAgentPlistPath(home)).equals(agentFile)).toBe(true);
    expect(second.out).toEqual([
      "~/.zshrc already has the Codex launch hook (unchanged).",
      `The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded and unchanged.`,
    ]);
  });

  test("a copy that cannot be written leaves the rc file as it was and fails the run", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const ctx = ctxWith();
    const failing = deps(fakeLaunchctl().run, {
      platform: "linux",
      files: {
        writeFile: (path, data, options) => {
          if (path.includes(RC_BACKUP_SUFFIX)) throw new Error("disk full");
          writeFileSync(path, data, options);
        },
      },
    });
    expect(await only(ctx, failing)).toBe(1);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    expect(ctx.out).toEqual([
      "Left ~/.zshrc without the Codex launch hook: it could not be written (disk full).",
    ]);
  });

  test("--json prints one document with the files, the copies and the agent", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const ctx = ctxWith();
    expect(await only(ctx, linux(), "--json")).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual({
      ok: true,
      dryRun: false,
      files: [{ path: zshrc(), state: "added" }],
      backups: [{ path: zshrc(), backup: backup(), kept: "new" }],
      agent: { state: "not_macos" },
      homes: [],
    });
  });

  test("with Codex not on this computer it says so and writes nothing", async () => {
    rmSync(join(home, "Applications", "Codex.app"), { recursive: true });
    writeFileSync(zshrc(), "export A=1\n");
    const ctx = ctxWith({ SHELL: "/bin/zsh", PATH: "/nowhere" });
    expect(await only(ctx, linux())).toBe(0);
    expect(ctx.out).toEqual([CODEX_ABSENT_LINE]);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
  });

  test("on a Mac with Codex not installed the agent is reported absent, not as a non-Mac, and launchctl is never called", async () => {
    rmSync(join(home, "Applications", "Codex.app"), { recursive: true });
    const f = fakeLaunchctl();
    const ctx = ctxWith({ SHELL: "/bin/zsh", PATH: "/nowhere" });
    expect(await only(ctx, deps(f.run), "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "").agent).toEqual({ state: "codex_absent" });
    expect(f.calls).toEqual([]);
    expect(existsSync(codexAgentPlistPath(home))).toBe(false);
  });

  test("under a HOME that is not this account's own it changes nothing and fails", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const ctx = ctxWith();
    expect(await only(ctx, { ...linux(), realHome: () => "/elsewhere" })).toBe(1);
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
    expect(ctx.out.join("\n")).toContain("is not this account's home folder");
  });

  test("--no-shell-hook with it is refused before anything changes", async () => {
    writeFileSync(zshrc(), "export A=1\n");
    const ctx = ctxWith();
    expect(await only(ctx, linux(), "--no-shell-hook")).toBe(1);
    expect(ctx.err.join("\n")).toContain("--only codex-attribution adds the Codex launch hooks");
    expect(readFileSync(zshrc(), "utf8")).toBe("export A=1\n");
  });
});

describe("Scenario: A named Codex home sends its telemetry (CTC-7028)", () => {
  const SECRET = "Basic c2VjcmV0LXZhbHVlLW5ldmVyLXByaW50ZWQ=";
  const OTEL = [
    "[otel]",
    'environment = "dev"',
    "",
    "[otel.exporter.otlp-http]",
    'endpoint = "https://collector.example/v1/logs"',
    'protocol = "binary"',
    "",
    "[otel.exporter.otlp-http.headers]",
    `"authorization" = "${SECRET}"`,
    "",
  ].join("\n");
  const DEFAULT = `model = "gpt"\n\n${OTEL}\n[tui]\nstatus_line = "on"\n`;
  const extra = () => join(home, "homes", "second");
  const config = () => join(extra(), "config.toml");
  const copy = () => `${config()}${RC_BACKUP_SUFFIX}`;
  const setup = async (accountId: string | null = TWO_ID) => {
    await seedJoined(home, server, { contract: false });
    writeAccountCache(NOW);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), DEFAULT, { mode: 0o600 });
    mkdirSync(extra(), { recursive: true });
    if (accountId !== null) writeLogin(extra(), accountId);
  };
  const only = (ctx: TestCtx, ...flags: string[]) =>
    main(["setup", "--only", "codex-attribution", "--codex-home", extra(), ...flags], ctx, { codexAttribution: linux() });
  const otelOnly = OTEL.replace(/\n$/, "") + "\n";

  test("a registered home gets the default home's [otel] tables, after a byte-for-byte copy, and is never left wider than the source", async () => {
    await setup();
    const original = '[projects."/work"]\ntrust_level = "trusted"\n';
    writeFileSync(config(), original, { mode: 0o640 });
    const ctx = ctxWith();
    expect(await only(ctx)).toBe(0);
    const text = readFileSync(config(), "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain(otelOnly);
    expect(text).not.toContain("[tui]");
    expect(readFileSync(copy(), "utf8")).toBe(original);
    // The source is 600, so the credential never becomes group-readable; the copy of the file as it
    // was, which holds no credential, keeps its own mode.
    expect(statSync(config()).mode & 0o777).toBe(0o600);
    expect(statSync(copy()).mode & 0o777).toBe(0o640);
    expect(ctx.out.join("\n")).toContain(
      "Codex launches with ~/homes/second send their telemetry: the exporter from ~/.codex/config.toml is in ~/homes/second/config.toml. The file as it was is kept at ~/homes/second/config.toml.before-codex-attribution.",
    );
    expect(ctx.out.join("\n")).not.toContain(SECRET);
  });

  test("--dry-run shows the tables with every header value hidden, and changes nothing", async () => {
    await setup();
    writeFileSync(config(), "x = 1\n", { mode: 0o600 });
    const ctx = ctxWith();
    expect(await only(ctx, "--dry-run")).toBe(0);
    expect(readFileSync(config(), "utf8")).toBe("x = 1\n");
    expect(existsSync(copy())).toBe(false);
    const out = ctx.out.join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"authorization" = <hidden>');
    expect(out).toContain('endpoint = "https://collector.example/v1/logs"');
    expect(out).toContain("[otel.exporter.otlp-http.headers]");
    expect(ctx.out.at(-1)).toBe("Dry run: nothing was changed.");
  });

  test("a home that already exports is byte-identical, and a second run says unchanged", async () => {
    await setup();
    const own = `[otel]\nenvironment = "mine"\n`;
    writeFileSync(config(), own, { mode: 0o600 });
    const ctx = ctxWith();
    expect(await only(ctx)).toBe(0);
    expect(readFileSync(config(), "utf8")).toBe(own);
    expect(existsSync(copy())).toBe(false);
    expect(ctx.out).toContain("~/homes/second/config.toml already has a telemetry exporter (unchanged).");
    writeFileSync(config(), "x = 1\n", { mode: 0o600 });
    expect(await only(ctxWith())).toBe(0);
    const once = readFileSync(config());
    const again = ctxWith();
    expect(await only(again)).toBe(0);
    expect(readFileSync(config()).equals(once)).toBe(true);
    expect(again.out).toContain("~/homes/second/config.toml already has a telemetry exporter (unchanged).");
  });

  test.each([
    ["a login that is not a workspace coding account", "acct-somebody-else", "its Codex login is not one of this workspace's coding accounts"],
    ["no login at all", null, "there is no Codex login in it"],
  ])("a home with %s is left as it is", async (_label, accountId, why) => {
    await setup(accountId);
    writeFileSync(config(), "x = 1\n", { mode: 0o600 });
    const ctx = ctxWith();
    expect(await only(ctx, "--json")).toBe(0);
    expect(readFileSync(config(), "utf8")).toBe("x = 1\n");
    const homes = JSON.parse(ctx.out[0] ?? "").homes;
    expect(homes).toHaveLength(1);
    expect(homes[0].state).toBe("skipped");
    expect(homes[0].why).toContain(why);
  });

  test("the default home itself is never a target", async () => {
    await setup();
    const ctx = ctxWith();
    expect(await main(["setup", "--only", "codex-attribution", "--codex-home", join(home, ".codex"), "--json"], ctx, { codexAttribution: linux() })).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "").homes[0].why).toContain("default Codex home");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(DEFAULT);
  });

  test("a home with no config.toml gets one with the tables, mode 600", async () => {
    await setup();
    expect(await only(ctxWith())).toBe(0);
    expect(statSync(config()).mode & 0o777).toBe(0o600);
    expect(readFileSync(config(), "utf8")).toContain(otelOnly);
    expect(existsSync(copy())).toBe(false);
  });

  test.each([
    ["ends its last line", "x = 1\n"],
    ["does not end its last line", "x = 1"],
    ["is empty", ""],
  ])("--remove-codex-attribution gives back a config.toml that %s byte for byte", async (_label, original) => {
    await setup();
    writeFileSync(config(), original, { mode: 0o600 });
    expect(await only(ctxWith())).toBe(0);
    expect(readFileSync(config(), "utf8")).not.toBe(original);
    const ctx = ctxWith();
    await main(["setup", "--remove-codex-attribution", "--codex-home", extra()], ctx, { codexAttribution: linux() });
    expect(readFileSync(config(), "utf8")).toBe(original);
    expect(ctx.out).toContain("Took the copied telemetry exporter out of ~/homes/second/config.toml; the file is as it was before setup added it.");
  });

  test("a failed copy leaves config.toml as it was and fails the run", async () => {
    await setup();
    writeFileSync(config(), "x = 1\n", { mode: 0o600 });
    const failing: CodexAttributionDeps = {
      ...linux(),
      files: { writeFile: (path) => { if (path.includes("config.toml")) throw new Error("disk full"); } },
    };
    const ctx = ctxWith();
    expect(await main(["setup", "--only", "codex-attribution", "--codex-home", extra()], ctx, { codexAttribution: failing })).toBe(1);
    expect(readFileSync(config(), "utf8")).toBe("x = 1\n");
    expect(ctx.out.join("\n")).toContain("its config.toml could not be written (disk full)");
  });

  test("a config.toml that is a link is left alone, and the link's target is untouched", async () => {
    await setup();
    const elsewhere = join(home, "elsewhere.toml");
    writeFileSync(elsewhere, "x = 1\n", { mode: 0o600 });
    symlinkSync(elsewhere, config());
    const ctx = ctxWith();
    expect(await only(ctx, "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "").homes[0].state).toBe("skipped");
    expect(readFileSync(elsewhere, "utf8")).toBe("x = 1\n");
    expect(lstatSync(config()).isSymbolicLink()).toBe(true);
  });

  test("NEGATIVE: --codex-home without the Codex attribution paths is a usage error", async () => {
    await setup();
    expect(await main(["setup", "--codex-home", extra()], ctxWith(), { codexAttribution: linux() })).not.toBe(0);
  });
});
