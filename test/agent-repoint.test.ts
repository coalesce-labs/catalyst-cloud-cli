// CTC-6975: a global install points an older runner update agent at itself, and touches nothing else.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersionAt, repointAgent, repointLine } from "../src/agent-repoint.js";
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

const repoint = (self: string, version: string, platform: NodeJS.Platform = "darwin", run: SchedulerRun = ok) =>
  repointAgent({ platform, home, uid: 501, self, version, nodeExecutable: "/usr/local/node/bin/node", env: { PATH: "/usr/bin:/bin" }, run });

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

    expect(repoint(self, "0.16.35")).toEqual({ action: "repointed", from: stale, fromVersion: "0.16.31", to: self });
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

  it("a refused reload is reported, never thrown", () => {
    const stale = install("brew", "0.16.31");
    const self = install("node", "0.16.35");
    writeAgent(stale);
    const refuse: SchedulerRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { status: 1, stdout: "", stderr: "" };
    };
    const result = repoint(self, "0.16.35", "darwin", refuse);
    expect(result).toEqual({ action: "failed", detail: "launchctl_bootstrap_failed:Bootstrap failed: 5: Input/output error" });
    expect(repointLine(result, "0.16.35")).toContain("Run: catalyst runner auto-update on");
  });
});

describe("cliVersionAt", () => {
  it("reads the version of the package a bin link belongs to", () => {
    expect(cliVersionAt(install("brew", "0.16.31"))).toBe("0.16.31");
    expect(cliVersionAt(install("fwd", "0.16.31", "@catalyst-cloud/catalyst-skills"))).toBe("0.16.31");
  });
  it("NEGATIVE: a missing command or a foreign package has no version", () => {
    expect(cliVersionAt(join(root, "nothing"))).toBeNull();
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
