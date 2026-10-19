import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ENV_SHELL_START_SCRIPT,
  homeVolumeFor,
  parseCheckOutput,
  shellRunArgs,
  START_EXIT_TOOLCHAIN,
  toolchainSpecs,
} from "../src/env/shell-plan";

const IMAGE =
  "ghcr.io/coalesce-labs/catalyst-runner@sha256:a19f7b0859a9814740935f7aadd8fe5c5c9c5974f9a5956a057b983ada16ea01";
const TOOLCHAINS = [
  { name: "node", version: "22" },
  { name: "bun", version: "1.3.14" },
];
const base = {
  image: IMAGE,
  root: "/Users/ana/src/web",
  gitCommonDir: null,
  toolchains: TOOLCHAINS,
  passNames: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
  checkNames: [],
};

test("homeVolumeFor names the volume by the image digest's first 12 hex", () => {
  expect(homeVolumeFor(IMAGE)).toBe("catalyst-env-home-a19f7b0859a9");
  expect(homeVolumeFor("not-pinned")).toMatch(/^catalyst-env-home-[0-9a-f]{12}$/);
});

test("toolchainSpecs joins name@version in declared order", () => {
  expect(toolchainSpecs(TOOLCHAINS)).toEqual(["node@22", "bun@1.3.14"]);
});

test("shell mode on a terminal: the whole argv, pinned", () => {
  expect(shellRunArgs({ ...base, mode: "shell", tty: true })).toEqual([
    "run", "--rm", "--pull", "never", "-i", "-t",
    "--user", "10001:10001",
    "--mount", "type=bind,src=/Users/ana/src/web,dst=/workspace",
    "--mount", "type=volume,src=catalyst-env-home-a19f7b0859a9,dst=/home/catalyst",
    "-w", "/workspace",
    "-e", "HOME=/home/catalyst",
    "-e", "MISE_SYSTEM_DATA_DIR=/opt/catalyst/toolchain",
    "-e", "MISE_SHARED_INSTALL_DIRS=/opt/catalyst/toolchain/installs",
    "-e", "CLAUDE_CODE_ENABLE_TELEMETRY=0",
    "-e", "OTEL_METRICS_EXPORTER=none", "-e", "OTEL_LOGS_EXPORTER=none", "-e", "OTEL_TRACES_EXPORTER=none",
    "-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", "GIT_CONFIG_VALUE_0=*",
    "-e", "TERM",
    "-e", "DATABASE_URL", "-e", "STRIPE_SECRET_KEY",
    "--entrypoint", "/bin/sh", IMAGE,
    "-c", ENV_SHELL_START_SCRIPT, "catalyst-env-shell", "shell", "node@22", "bun@1.3.14",
  ]);
});

test("not a terminal: -i without -t and no TERM", () => {
  const argv = shellRunArgs({ ...base, mode: "shell", tty: false });
  expect(argv.slice(0, 6)).toEqual(["run", "--rm", "--pull", "never", "-i", "--user"]);
  expect(argv).not.toContain("-t");
  expect(argv).not.toContain("TERM");
});

test("check mode: neither -i nor -t; CATALYST_ENV_NAMES carries the declared names (names only)", () => {
  const argv = shellRunArgs({
    ...base,
    mode: "check",
    tty: true,
    passNames: ["DATABASE_URL"],
    checkNames: ["DATABASE_URL", "SENTRY_DSN"],
  });
  expect(argv).not.toContain("-i");
  expect(argv).not.toContain("-t");
  expect(argv).not.toContain("TERM");
  expect(argv).toContain("CATALYST_ENV_NAMES=DATABASE_URL SENTRY_DSN");
  expect(argv.slice(-4)).toEqual(["catalyst-env-shell", "check", "node@22", "bun@1.3.14"]);
});

test("a worktree's git common dir outside the root is mounted at the same absolute path", () => {
  const argv = shellRunArgs({ ...base, mode: "shell", tty: false, gitCommonDir: "/Users/ana/src/web-main/.git" });
  const mounts = argv.flatMap((word, i) => (word === "--mount" ? [argv[i + 1]] : []));
  expect(mounts).toEqual([
    "type=bind,src=/Users/ana/src/web,dst=/workspace",
    "type=bind,src=/Users/ana/src/web-main/.git,dst=/Users/ana/src/web-main/.git",
    "type=volume,src=catalyst-env-home-a19f7b0859a9,dst=/home/catalyst",
  ]);
});

test("no argv element contains a variable value or an '=' after a declared name", () => {
  for (const mode of ["shell", "check"] as const) {
    const argv = shellRunArgs({ ...base, mode, tty: true, checkNames: base.passNames });
    for (const name of base.passNames) expect(argv.some((word) => word.startsWith(`${name}=`))).toBe(false);
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("--network");
    expect(argv).not.toContain("-p");
  }
});

describe("ENV_SHELL_START_SCRIPT, run with sh against a fake mise on PATH", () => {
  let dir: string;
  let bin: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "catalyst-env-script-"));
    bin = join(dir, "bin");
    log = join(dir, "mise.log");
    spawnSync("mkdir", [bin]);
    writeFileSync(
      join(bin, "mise"),
      [
        "#!/bin/sh",
        'echo "$*" >> "$FAKE_LOG"',
        'case "$1" in',
        '  install) exit "${FAKE_INSTALL_EXIT:-0}" ;;',
        '  where) tool="${2%%@*}"; version="${2#*@}"; echo "/x/installs/$tool/$version.0" ;;',
        '  exec) shift; while [ "$1" != "--" ]; do shift; done; shift; MISE_MARK=1 exec "$@" ;;',
        "esac",
      ].join("\n"),
    );
    writeFileSync(
      join(bin, "bash"),
      ['#!/bin/sh', 'echo "bash $* mark=${MISE_MARK:-none}"', 'exit "${FAKE_BASH_EXIT:-0}"'].join("\n"),
    );
    chmodSync(join(bin, "mise"), 0o755);
    chmodSync(join(bin, "bash"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runScript = (mode: string, specs: string[], env: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", ENV_SHELL_START_SCRIPT, "catalyst-env-shell", mode, ...specs], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log, ...env },
      encoding: "utf8",
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  test("check: installs all specs once, prints one toolchain line per spec and one variable line per name, exits 0", () => {
    const r = runScript("check", ["node@22", "bun@1.3.14"], { CATALYST_ENV_NAMES: "DATABASE_URL SENTRY_DSN", DATABASE_URL: "x" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      "toolchain\tnode@22\t22.0\ntoolchain\tbun@1.3.14\t1.3.14.0\nvariable\tDATABASE_URL\tset\nvariable\tSENTRY_DSN\tunset\n",
    );
    expect(calls()).toEqual(["install node@22 bun@1.3.14", "where node@22", "where bun@1.3.14"]);
  });

  test("check: a set-but-empty variable reads set; an unset one reads unset; no value is printed", () => {
    const r = runScript("check", [], { CATALYST_ENV_NAMES: "EMPTY SECRET_ONE MISSING", EMPTY: "", SECRET_ONE: "postgres://secret" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("variable\tEMPTY\tset\nvariable\tSECRET_ONE\tset\nvariable\tMISSING\tunset\n");
    expect(r.stdout + r.stderr).not.toContain("postgres://secret");
  });

  test("shell: install, then exec mise exec <specs> -- bash -i; the shell's own exit code comes back", () => {
    const r = runScript("shell", ["node@22", "bun@1.3.14"], { FAKE_BASH_EXIT: "3" });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("bash -i mark=1\n");
    expect(calls()).toEqual(["install node@22 bun@1.3.14", "exec node@22 bun@1.3.14 -- bash -i"]);
  });

  test(`a failed install exits ${START_EXIT_TOOLCHAIN}`, () => {
    expect(runScript("shell", ["node@99.1.1"], { FAKE_INSTALL_EXIT: "1" }).status).toBe(97);
    expect(runScript("check", ["node@99.1.1"], { FAKE_INSTALL_EXIT: "1" }).status).toBe(97);
  });

  test("no toolchains: exec bash -l without calling mise at all", () => {
    const r = runScript("shell", []);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("bash -l mark=none\n");
    expect(calls()).toEqual([]);
  });
});

// CTC-6153: a login shell re-reads the profile, and Ubuntu's /etc/profile replaces PATH, so the
// toolchain mise put first on PATH was lost. A real bash with a profile that resets PATH stands in for it.
describe("ENV_SHELL_START_SCRIPT with a real bash: the toolchain PATH survives into the shell", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "catalyst-env-path-"));
    spawnSync("mkdir", ["-p", join(dir, "bin"), join(dir, "tool"), join(dir, "home")]);
    // Like real mise: put the toolchain's bin first on PATH, then exec the command after "--".
    writeFileSync(
      join(dir, "bin", "mise"),
      ["#!/bin/sh", 'case "$1" in install) exit 0 ;; exec) shift; while [ "$1" != "--" ]; do shift; done; shift; PATH="$TOOL_DIR:$PATH" exec "$@" ;; esac'].join("\n"),
    );
    chmodSync(join(dir, "bin", "mise"), 0o755);
    writeFileSync(join(dir, "home", ".bash_profile"), "PATH=/usr/bin:/bin\n");
    writeFileSync(join(dir, "home", ".bashrc"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.skipIf(!existsSync("/bin/bash"))("the shell started for declared toolchains still has the toolchain first on PATH", () => {
    const r = spawnSync("sh", ["-c", ENV_SHELL_START_SCRIPT, "catalyst-env-shell", "shell", "node@22"], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: join(dir, "home"), TOOL_DIR: join(dir, "tool") },
      input: 'echo "PATH=$PATH"\nexit\n',
      encoding: "utf8",
    });
    expect(r.stdout).toMatch(new RegExp(`PATH=${join(dir, "tool")}:`));
  });
});

// Real mise, only where this test runs inside a Catalyst image (phase containers do; plain CI skips).
const realMise = existsSync("/opt/catalyst/toolchain/installs/node/22") && spawnSync("mise", ["--version"]).status === 0;
test.skipIf(!realMise)("real mise: check resolves node@22 from the image without a download", () => {
  const home = mkdtempSync(join(tmpdir(), "catalyst-env-mise-"));
  try {
    const r = spawnSync("sh", ["-c", ENV_SHELL_START_SCRIPT, "catalyst-env-shell", "check", "node@22"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        MISE_DATA_DIR: join(home, "data"),
        MISE_SYSTEM_DATA_DIR: "/opt/catalyst/toolchain",
        MISE_SHARED_INSTALL_DIRS: "/opt/catalyst/toolchain/installs",
        CATALYST_ENV_NAMES: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^toolchain\tnode@22\t22\.[0-9]+\.[0-9]+\n$/);
    // Resolved from the image's own copy: nothing was downloaded into the shell's data dir.
    expect(existsSync(join(home, "data", "installs", "node"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseCheckOutput: maps lines back to the declared specs and names; ignores unknown lines; refuses a missing spec", () => {
  const out = "mise noise\ntoolchain\tnode@22\t22.23.3\ntoolchain\tbun@1.3.14\t1.3.14\ntoolchain\tdeno@2\t2.0.0\nvariable\tA\tset\nvariable\tB\tunset\nvariable\tC\tmaybe\n";
  expect(parseCheckOutput(out, ["node@22", "bun@1.3.14"], ["A", "B"])).toEqual({
    toolchains: [
      { spec: "node@22", resolved: "22.23.3" },
      { spec: "bun@1.3.14", resolved: "1.3.14" },
    ],
    variables: [
      { name: "A", set: true },
      { name: "B", set: false },
    ],
  });
  expect(parseCheckOutput(out, ["node@22", "python@3.12"], [])).toBeNull();
  expect(parseCheckOutput(out, [], ["C"])).toBeNull();
  expect(parseCheckOutput("toolchain\tnode@22\t\n", ["node@22"], [])).toBeNull();
  expect(parseCheckOutput("", [], [])).toEqual({ toolchains: [], variables: [] });
});
