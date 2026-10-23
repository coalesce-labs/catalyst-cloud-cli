// update-plugin.test.ts — the Claude plugin form of the Cloud skills pack moves with the release
// check (CTC-6791). Claude Code is a fake `claude` that rewrites its own registry files the way the
// real one does, so the version read back is what the report says. The plugin never moves past the
// approval, and a run that finds no `claude` changes nothing and names the command.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { systemdUnits, type SchedulerRun } from "../src/runner-auto-update";
import type { RunnerUpdateEngine } from "../src/runner-update";
import { runUpdate, updateReportLines, type UpdateOptions } from "../src/update";
import type { CliExec } from "../src/update-cli";
import { applyCloudPluginUpdate, CLAUDE_PATH_ENV, CLOUD_PLUGIN_COMMAND, cloudPluginInventory, resolveClaude } from "../src/update-plugin";
import { setComponentPolicy } from "../src/update-policy";
import { makeCtx, tempHome } from "./helpers";
import { approved, fakeCliApply, memberFetch, NEXT, OLD, signIn } from "./update-fixtures";

const noDocker = (): RunnerUpdateEngine => {
  throw new Error("a machine with no runner installation must not reach Docker");
};

const plugins = (home: string) => join(home, ".claude", "plugins");

/** Claude Code's registry with the Cloud plugin at `version`, and its marketplace checkout serving `served`. */
function installPlugin(home: string, version: string, served: string): void {
  mkdirSync(join(plugins(home), "marketplaces", "catalyst-cloud", ".claude-plugin"), { recursive: true });
  writeRegistry(home, version);
  serve(home, served);
}

function writeRegistry(home: string, version: string): void {
  writeFileSync(
    join(plugins(home), "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "catalyst@catalyst-cloud": [{ scope: "user", installPath: "/x", version, installedAt: "2026-10-01T00:00:00.000Z" }] } }),
  );
}

function serve(home: string, version: string): void {
  writeFileSync(join(plugins(home), "marketplaces", "catalyst-cloud", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "catalyst", version }));
}

/** An executable named `claude` in a fresh directory. */
function claudeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  const path = join(dir, "claude");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/** A fake Claude Code: a marketplace refresh serves `refreshTo`, and a plugin update installs what is served. */
function fakeClaude(home: string, refreshTo: string): CliExec & { calls: string[] } {
  const calls: string[] = [];
  const exec: CliExec = (argv) => {
    calls.push(argv.slice(1).join(" "));
    if (argv[2] === "marketplace") serve(home, refreshTo);
    else if (argv[2] === "update") {
      const served = JSON.parse(readFileSync(join(plugins(home), "marketplaces", "catalyst-cloud", ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
      writeRegistry(home, served.version);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return Object.assign(exec, { calls });
}

function applying(home: string, exec: CliExec, env: NodeJS.ProcessEnv): UpdateOptions & { ctx: ReturnType<typeof makeCtx> } {
  signIn(home);
  const ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", ...env }, fetch: memberFetch(200, { ok: true, release: approved() }) });
  return {
    ctx,
    mode: "apply",
    imagesDir: join(home, "no-runner"),
    engine: noDocker,
    cliApply: fakeCliApply([]),
    pluginApply: (h, e, target, scope, deps) => applyCloudPluginUpdate(h, e, target, scope, { ...deps, exec }),
  };
}

describe("the Cloud plugin follows the approved release", () => {
  it("POSITIVE CONTROL: a plugin at an older version reports the approved version after the release check", async () => {
    const home = tempHome();
    installPlugin(home, OLD, OLD);
    const claude = fakeClaude(home, NEXT);
    const { ctx, ...options } = applying(home, claude, { PATH: join(claudeBinary(), "..") });
    const report = await runUpdate(ctx, options);
    expect(report.components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ installed: NEXT, approved: NEXT, status: "updated", action: null });
    expect(claude.calls).toEqual(["plugin marketplace update catalyst-cloud", "plugin update catalyst@catalyst-cloud --scope user"]);
    expect(cloudPluginInventory(home, {})).toMatchObject({ state: "installed", version: NEXT });
    expect(updateReportLines(report)).toContain(`Cloud skills plugin: run /reload-plugins in Claude Code, or restart it, to load ${NEXT}.`);
    expect(report.exitCode).toBe(0);
  });

  it("a marketplace that serves a version other than the approved one leaves the plugin where it is", async () => {
    const home = tempHome();
    installPlugin(home, OLD, OLD);
    const ahead = `${NEXT.split(".").slice(0, 2).join(".")}.${Number(NEXT.split(".")[2]) + 1}`;
    const claude = fakeClaude(home, ahead);
    const { ctx, ...options } = applying(home, claude, { PATH: join(claudeBinary(), "..") });
    const report = await runUpdate(ctx, options);
    expect(report.components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ installed: OLD, status: "pending", reason: "marketplace_not_approved" });
    expect(claude.calls).toEqual(["plugin marketplace update catalyst-cloud"]);
    expect(cloudPluginInventory(home, {})).toMatchObject({ version: OLD });
  });

  it("the scheduled run finds claude at the path recorded at setup, with no claude on its PATH", async () => {
    const home = tempHome();
    installPlugin(home, OLD, OLD);
    const claude = fakeClaude(home, NEXT);
    const recorded = claudeBinary();
    const used: (string | null | undefined)[] = [];
    const { ctx, ...options } = applying(home, claude, { PATH: "/usr/bin:/bin", [CLAUDE_PATH_ENV]: recorded });
    const report = await runUpdate(ctx, {
      ...options,
      pluginApply: (h, e, target, scope, deps) => (used.push(deps.claudePath), applyCloudPluginUpdate(h, e, target, scope, { ...deps, exec: claude })),
    });
    expect(used).toEqual([recorded]);
    expect(report.components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ installed: NEXT, status: "updated" });
  });

  it("claude in Claude Code's usual install location is found with no PATH and no recorded path", () => {
    const home = tempHome();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const path = join(home, ".local", "bin", "claude");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    expect(resolveClaude(home, {})).toBe(path);
  });

  it("NEGATIVE: with no claude found, the row reads update available with the one command, and nothing is changed", async () => {
    const home = tempHome();
    installPlugin(home, OLD, OLD);
    const claude = fakeClaude(home, NEXT);
    const { ctx, ...options } = applying(home, claude, {});
    const report = await runUpdate(ctx, options);
    const row = report.components.find((c) => c.id === "skills-cloud-plugin");
    expect(row).toMatchObject({ installed: OLD, approved: NEXT, status: "update_available", action: CLOUD_PLUGIN_COMMAND });
    expect(claude.calls).toEqual([]);
    expect(updateReportLines(report)).toContain(`Cloud skills plugin: this CLI does not install ${NEXT} by itself yet. Run: ${CLOUD_PLUGIN_COMMAND}`);
    expect(cloudPluginInventory(home, {})).toMatchObject({ version: OLD });
  });

  it("follows the Cloud skills setting: held, it does not move", async () => {
    const home = tempHome();
    installPlugin(home, OLD, OLD);
    const claude = fakeClaude(home, NEXT);
    const { ctx, ...options } = applying(home, claude, { PATH: join(claudeBinary(), "..") });
    setComponentPolicy(home, "skills-cloud", false);
    const report = await runUpdate(ctx, options);
    expect(report.components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ status: "held", reason: "owner_setting" });
    expect(claude.calls).toEqual([]);
  });

  it("a machine without the plugin lists no plugin row", async () => {
    const home = tempHome();
    signIn(home);
    const ctx = makeCtx(home, { fetch: memberFetch(200, { ok: true, release: approved() }) });
    const report = await runUpdate(ctx, { mode: "check", imagesDir: join(home, "no-runner"), engine: noDocker });
    expect(report.components.map((c) => c.id)).not.toContain("skills-cloud-plugin");
  });
});

describe("catalyst runner auto-update records the claude command", () => {
  it("the schedule carries the claude path found at setup", async () => {
    const home = tempHome();
    const claude = claudeBinary();
    const runnerDir = mkdtempSync(join(tmpdir(), "runner-cmd-"));
    writeFileSync(join(runnerDir, ".env"), "CATALYST_SLOTS=1\n", { mode: 0o600 });
    writeFileSync(join(runnerDir, "compose.yaml"), "name: catalyst-host\n");
    const run: SchedulerRun = () => ({ status: 0, stdout: "", stderr: "" });
    const ctx = makeCtx(home, { env: { PATH: join(claude, "..") } });
    const scheduler = { platform: "darwin" as const, run, cli: "/usr/local/bin/catalyst", path: "/usr/bin:/bin" };
    expect(await main(["runner", "auto-update", "on", "--dir", runnerDir], ctx, { runner: { scheduler } })).toBe(0);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "dev.catalystcloud.runner-update.plist"), "utf8");
    expect(plist).toContain(`<key>${CLAUDE_PATH_ENV}</key><string>${claude}</string>`);
  });

  it("the Linux timer's service carries the claude path found at setup", () => {
    const deps = { cli: "/usr/local/bin/catalyst", path: "/usr/bin:/bin" };
    expect(systemdUnits({ ...deps, claude: "/home/a/.local/bin/claude" }, "/srv/runner").service).toContain(
      `Environment="${CLAUDE_PATH_ENV}=/home/a/.local/bin/claude"`,
    );
    expect(systemdUnits({ ...deps, claude: null }, "/srv/runner").service).not.toContain(CLAUDE_PATH_ENV);
  });
});
