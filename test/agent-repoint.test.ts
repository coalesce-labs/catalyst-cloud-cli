// CTC-6975: a global install points an older runner update agent at itself, and touches nothing else.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersionAt, postinstallRepoint, repointAgent, repointLine, type RepointDeps } from "../src/agent-repoint.js";
import { launchAgentPath, launchAgentPlist, systemdUnitPaths, systemdUnits, type SchedulerRun } from "../src/runner-auto-update.js";

let root: string;
let home: string;
let dir: string;
let calls: string[][];

const ok: SchedulerRun = (cmd, args) => {
  calls.push([cmd, ...args]);
  return { status: 0, stdout: "", stderr: "" };
};

/** A global prefix holding one catalyst package at `version`, returning its bin link. */
function install(prefix: string, version: string, name = "@catalyst-cloud/cli"): string {
  const pkg = join(root, prefix, "lib", "node_modules", "@catalyst-cloud", "cli");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(pkg, "bin", "catalyst.js"), "#!/usr/bin/env node\n");
  chmodSync(join(pkg, "bin", "catalyst.js"), 0o755);
  const link = join(root, prefix, "bin", "catalyst");
  mkdirSync(dirname(link), { recursive: true });
  spawnSync("ln", ["-s", join("..", "lib", "node_modules", "@catalyst-cloud", "cli", "bin", "catalyst.js"), link]);
  return link;
}

function writeAgent(cli: string, platform: "darwin" | "linux" = "darwin"): string {
  const deps = { cli, path: "/opt/homebrew/bin:/usr/bin:/bin:/custom/docker", home, claude: null };
  if (platform === "darwin") {
    const path = launchAgentPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, launchAgentPlist(deps, dir));
    return path;
  }
  const paths = systemdUnitPaths(home);
  mkdirSync(dirname(paths.service), { recursive: true });
  const units = systemdUnits(deps, dir);
  writeFileSync(paths.service, units.service);
  writeFileSync(paths.timer, units.timer);
  return paths.service;
}

const repoint = (
  self: string,
  version: string,
  platform: NodeJS.Platform = "darwin",
  run: SchedulerRun = ok,
  canWrite?: (path: string) => boolean,
  extra: Partial<RepointDeps> = {},
) =>
  repointAgent({ platform, home, uid: 501, self, version, nodeExecutable: "/usr/local/node/bin/node", env: { PATH: "/usr/bin:/bin" }, run, canWrite, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-repoint-"));
  home = join(root, "home");
  dir = join(home, ".local", "state", "catalyst", "runner");
  mkdirSync(dir, { recursive: true });
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repointAgent", () => {
  it("POSITIVE: an agent on an older CLI moves to this install, keeping its runner directory and PATH", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    const plist = writeAgent(stale);
    const before = readFileSync(plist, "utf8");

    expect(repoint(self, "0.16.35")).toEqual({ action: "repointed", from: stale, fromVersion: "0.16.31", to: self, backup: `${plist}.before-0.16.35` });
    // The file it replaced is kept beside it, under a name launchd does not load: the rollback.
    expect(readFileSync(`${plist}.before-0.16.35`, "utf8")).toBe(before);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(`<string>${self}</string><string>runner</string><string>update</string><string>--auto</string><string>--dir</string><string>${dir}</string>`);
    expect(text).not.toContain(`<string>${stale}</string>`);
    expect(text).toContain(`<string>${dirname(self)}:/usr/local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/docker</string>`);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", plist]);
    expect(readFileSync(join(dir, "update.log"), "utf8")).toContain(`now runs ${self} (0.16.35) instead of ${stale} (0.16.31)`);
  });

  it("POSITIVE: the same move on a systemd timer", () => {
    const stale = install("old", "0.16.20");
    const self = install("node", "0.16.35");
    const service = writeAgent(stale, "linux");

    expect(repoint(self, "0.16.35", "linux")).toMatchObject({ action: "repointed", from: stale, to: self });
    expect(readFileSync(service, "utf8")).toContain(`ExecStart="${self}" "runner" "update" "--auto" "--dir" "${dir}"`);
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "catalyst-runner-update.timer"]);
  });

  it("an agent whose CLI no longer exists moves to this install", () => {
    const self = install("node", "0.16.35");
    writeAgent(join(root, "gone", "bin", "catalyst"));
    expect(repoint(self, "0.16.35")).toMatchObject({ action: "repointed", fromVersion: null, to: self });
  });

  it.each([
    ["the same version", "0.16.35"],
    ["a newer version", "0.16.40"],
  ])("NEGATIVE: an agent on %s is left exactly as it is", (_label, agentVersion) => {
    const other = install("brew", agentVersion);
    const self = install("node", "0.16.35");
    const plist = writeAgent(other);
    const before = readFileSync(plist, "utf8");

    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "agent_cli_not_older" });
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("NEGATIVE: an agent already on this install is left alone", () => {
    const self = install("node", "0.16.35");
    writeAgent(self);
    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "already_current" });
    expect(calls).toEqual([]);
  });

  it("NEGATIVE: an agent running something that is not a catalyst CLI is left alone", () => {
    const self = install("node", "0.16.35");
    const wrapper = install("wrap", "1.0.0", "someone-else");
    writeAgent(wrapper);
    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "agent_cli_unrecognized" });
    expect(calls).toEqual([]);
  });

  it("NEGATIVE: an agent file this CLI did not write is left alone", () => {
    const self = install("node", "0.16.35");
    const path = launchAgentPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<plist><dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>x</string></array></dict></plist>");
    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "agent_unrecognized" });
    expect(calls).toEqual([]);
  });

  it("NEGATIVE: a machine with no agent gets nothing", () => {
    const self = install("node", "0.16.35");
    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "no_agent" });
    expect(repoint(self, "0.16.35", "linux")).toEqual({ action: "skipped", reason: "no_agent" });
    expect(repoint(self, "0.16.35", "win32")).toEqual({ action: "skipped", reason: "unsupported_platform" });
    expect(calls).toEqual([]);
  });

  it("NEGATIVE: an agent this person cannot change is left alone, with one line saying so", () => {
    const stale = install("old", "0.16.20");
    const self = install("node", "0.16.35");
    const service = writeAgent(stale, "linux");
    const before = readFileSync(service, "utf8");
    const asked: string[] = [];
    const result = repoint(self, "0.16.35", "linux", ok, (path) => (asked.push(path), path !== service));

    expect(result).toEqual({ action: "skipped", reason: "agent_not_writable", agent: service });
    expect(asked).toContain(service);
    expect(readFileSync(service, "utf8")).toBe(before);
    expect(existsSync(`${service}.before-0.16.35`)).toBe(false);
    expect(calls).toEqual([]);
    expect(repointLine(result, "0.16.35")).toContain("this install cannot change it");
  });

  it("NEGATIVE: a root-owned timer beside a writable service is also left alone", () => {
    const stale = install("old", "0.16.20");
    const self = install("node", "0.16.35");
    writeAgent(stale, "linux");
    const { timer } = systemdUnitPaths(home);
    expect(repoint(self, "0.16.35", "linux", ok, (path) => path !== timer)).toMatchObject({ action: "skipped", reason: "agent_not_writable" });
    expect(calls).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("NEGATIVE: the real write check refuses a read-only agent file", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    const plist = writeAgent(stale);
    chmodSync(plist, 0o444);
    expect(repoint(self, "0.16.35")).toEqual({ action: "skipped", reason: "agent_not_writable", agent: plist });
    expect(calls).toEqual([]);
  });

  it("a refused reload is reported, never thrown", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    writeAgent(stale);
    const refuse: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { status: 1, stdout: "", stderr: "" };
    };
    const plist = launchAgentPath(home);
    const before = readFileSync(plist, "utf8");
    const result = repoint(self, "0.16.35", "darwin", refuse);
    expect(result).toEqual({ action: "failed", detail: "launchctl_bootstrap_failed:Bootstrap failed: 5: Input/output error" });
    expect(repointLine(result, "0.16.35")).toContain("Run: catalyst runner auto-update on");
    // The agent goes back exactly as it was, is loaded again, and no backup is left behind.
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(calls.filter((c) => c[1] === "bootstrap")).toEqual([
      ["launchctl", "bootstrap", "gui/501", plist],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
    expect(existsSync(`${plist}.before-0.16.35`)).toBe(false);
  });

  it("a scheduler that throws mid-reload still restores the agent and reports a failure", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    const plist = writeAgent(stale);
    const before = readFileSync(plist, "utf8");
    const boom: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "bootstrap") throw new Error("spawn launchctl EAGAIN");
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(repoint(self, "0.16.35", "darwin", boom)).toEqual({ action: "failed", detail: "spawn launchctl EAGAIN" });
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(existsSync(`${plist}.before-0.16.35`)).toBe(false);
  });

  it("NEGATIVE: with no systemd user manager the unit is untouched and no backup is left", () => {
    const stale = install("old", "0.16.20");
    const self = install("node", "0.16.35");
    const service = writeAgent(stale, "linux");
    const before = readFileSync(service, "utf8");
    const noManager: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
    };
    expect(repoint(self, "0.16.35", "linux", noManager)).toEqual({ action: "failed", detail: "no_systemd_user_manager" });
    expect(readFileSync(service, "utf8")).toBe(before);
    expect(existsSync(`${service}.before-0.16.35`)).toBe(false);
  });
});

describe("a running macOS agent is never cut off", () => {
  const busyFor = (polls: number): SchedulerRun => {
    let seen = 0;
    return (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") return { status: 0, stdout: seen++ < polls ? "gui/501/x = {\n\tstate = running\n\t\tstate = active\n}" : "gui/501/x = {\n\tstate = not running\n}", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
  };

  it("waits for an update in progress to finish, then repoints", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    writeAgent(stale);
    const slept: number[] = [];
    const result = repoint(self, "0.16.35", "darwin", busyFor(2), undefined, { sleep: (ms) => slept.push(ms), busyWaitMs: 60_000 });
    expect(result).toMatchObject({ action: "repointed" });
    expect(slept).toEqual([5_000, 5_000]);
    // Three reads (running, running, idle) before anything stops the job.
    const order = calls.map((c) => c[1]);
    expect(order.slice(0, 3)).toEqual(["print", "print", "print"]);
    expect(order.indexOf("bootout")).toBeGreaterThan(2);
  });

  it("NEGATIVE: an agent still running at the deadline is left exactly as it is", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    const plist = writeAgent(stale);
    const before = readFileSync(plist, "utf8");
    const slept: number[] = [];
    const result = repoint(self, "0.16.35", "darwin", busyFor(1_000), undefined, { sleep: (ms) => slept.push(ms), busyWaitMs: 20_000 });
    expect(result).toEqual({ action: "skipped", reason: "agent_busy" });
    expect(slept).toHaveLength(4);
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(existsSync(`${plist}.before-0.16.35`)).toBe(false);
    expect(calls.every((c) => c[1] === "print")).toBe(true);
    expect(repointLine(result, "0.16.35")).toContain("busy updating");
  });
});

describe("agent files", () => {
  it("a plist with no PATH falls back to this install's PATH, and a recorded claude path is kept", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    const path = launchAgentPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `<plist><dict><key>ProgramArguments</key><array><string>${stale}</string><string>runner</string><string>update</string><string>--auto</string><string>--dir</string><string>${dir}</string></array>` +
        `<key>EnvironmentVariables</key><dict><key>CATALYST_CLAUDE_PATH</key><string>/opt/claude &amp; co/claude</string></dict></dict></plist>`,
    );
    expect(repoint(self, "0.16.35")).toMatchObject({ action: "repointed" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`<string>${dirname(self)}:/usr/local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`);
    expect(text).toContain("<key>CATALYST_CLAUDE_PATH</key><string>/opt/claude &amp; co/claude</string>");
  });

  it.each([
    ["a relative program", (s: string) => ["catalyst", "runner", "update", "--auto", "--dir", s]],
    ["another subcommand", (s: string) => ["/usr/bin/catalyst", "runner", "status", "--auto", "--dir", s]],
    ["a relative directory", () => ["/usr/bin/catalyst", "runner", "update", "--auto", "--dir", "runner"]],
    ["an extra word", (s: string) => ["/usr/bin/catalyst", "runner", "update", "--auto", "--dir", s, "--check"]],
  ])("NEGATIVE: a unit naming %s is unrecognized", (_label, words) => {
    const self = install("node", "0.16.35");
    const { service } = systemdUnitPaths(home);
    mkdirSync(dirname(service), { recursive: true });
    writeFileSync(service, `[Service]\nExecStart=${words(dir).map((w) => `"${w}"`).join(" ")}\n`);
    expect(repoint(self, "0.16.35", "linux")).toEqual({ action: "skipped", reason: "agent_unrecognized" });
  });

  it("NEGATIVE: a unit with no ExecStart is unrecognized", () => {
    const self = install("node", "0.16.35");
    const { service } = systemdUnitPaths(home);
    mkdirSync(dirname(service), { recursive: true });
    writeFileSync(service, "[Service]\nType=oneshot\n");
    expect(repoint(self, "0.16.35", "linux")).toEqual({ action: "skipped", reason: "agent_unrecognized" });
  });

  it("an unreadable agent is a failure, never a throw", () => {
    const self = install("node", "0.16.35");
    mkdirSync(launchAgentPath(home), { recursive: true });
    expect(repoint(self, "0.16.35")).toMatchObject({ action: "failed" });
  });

  it("quiet results print nothing", () => {
    expect(repointLine({ action: "skipped", reason: "no_agent" }, "0.16.35")).toBeNull();
  });
});

describe("postinstallRepoint", () => {
  it("NEGATIVE: no HOME, or a HOME with no agent, prints nothing", () => {
    expect(postinstallRepoint({})).toBeNull();
    expect(postinstallRepoint({ HOME: home, npm_config_prefix: join(root, "nowhere") })).toBeNull();
    const self = install("node", "0.16.35");
    expect(postinstallRepoint({ HOME: home, npm_config_prefix: dirname(dirname(self)) })).toBeNull();
  });
});

describe("every outcome for a recognized agent reaches its update.log", () => {
  const log = () => (existsSync(join(dir, "update.log")) ? readFileSync(join(dir, "update.log"), "utf8") : "");
  const refuse: SchedulerRun = (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5" } : { status: 1, stdout: "", stderr: "" };
  };
  const running: SchedulerRun = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: "x = {\n\tstate = running\n}", stderr: "" };
  };

  it("a failed repoint", () => {
    writeAgent(install("brew", "0.16.31"));
    repoint(install("node", "0.16.35"), "0.16.35", "darwin", refuse);
    expect(log()).toMatch(/^\S+Z catalyst: could not point the runner update agent at this install \(launchctl_bootstrap_failed:Bootstrap failed: 5\)/);
  });

  it("an agent this person cannot change", () => {
    writeAgent(install("brew", "0.16.31"));
    repoint(install("node", "0.16.35"), "0.16.35", "darwin", ok, () => false);
    expect(log()).toContain("this install cannot change it");
  });

  it("a busy agent", () => {
    writeAgent(install("brew", "0.16.31"));
    repoint(install("node", "0.16.35"), "0.16.35", "darwin", running, undefined, { sleep: () => {}, busyWaitMs: 0 });
    expect(log()).toContain("was busy updating");
  });

  it.each([
    ["agent_cli_not_older", "0.16.40"],
    ["already_current", null],
  ])("a quiet skip names its reason: %s", (reason, agentVersion) => {
    const self = install("node", "0.16.35");
    writeAgent(agentVersion === null ? self : install("brew", agentVersion));
    repoint(self, "0.16.35");
    expect(log()).toContain(`catalyst 0.16.35: the runner update agent was left as it is (${reason}).`);
  });

  it("NEGATIVE: with no agent there is no log to write, and none is created", () => {
    repoint(install("node", "0.16.35"), "0.16.35");
    expect(existsSync(join(dir, "update.log"))).toBe(false);
  });
});

describe("cliVersionAt", () => {
  it("reads the version of the package a bin link belongs to", () => {
    expect(cliVersionAt(install("brew", "0.16.31"))).toBe("0.16.31");
    expect(cliVersionAt(install("fwd", "0.16.31", "@catalyst-cloud/catalyst-skills"))).toBe("0.16.31");
  });
  it("NEGATIVE: a missing command or a foreign package has no version", () => {
    expect(cliVersionAt(join(root, "nothing"))).toBeNull();
    const broken = install("broken", "0.16.31");
    writeFileSync(join(root, "broken", "lib", "node_modules", "@catalyst-cloud", "cli", "package.json"), "{not json");
    expect(cliVersionAt(broken)).toBeNull();
    const deep = join(root, "a", "b", "c", "d", "e", "catalyst");
    mkdirSync(dirname(deep), { recursive: true });
    writeFileSync(deep, "");
    expect(cliVersionAt(deep)).toBeNull();
    expect(cliVersionAt(install("x", "1.0.0", "left-pad"))).toBeNull();
  });
});

describe("bin/postinstall.js", () => {
  const script = join(__dirname, "..", "bin", "postinstall.js");
  it.each([
    ["a local install", {}],
    ["the opt-out", { npm_config_global: "true", CATALYST_NO_AGENT_REPOINT: "1" }],
  ])("NEGATIVE: %s does nothing and exits 0", (_label, extra) => {
    const stale = install("brew", "0.16.31");
    const plist = writeAgent(stale);
    const before = readFileSync(plist, "utf8");
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...extra } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(readFileSync(plist, "utf8")).toBe(before);
  });
});
