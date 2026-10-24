import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { systemdUnits, type SchedulerRun } from "../src/runner-auto-update";
import { runUpdate, updateReportLines, type UpdateOptions } from "../src/update";
import { spawnCliCommand, type CliExec } from "../src/update-cli";
import { applyCloudPluginUpdate, CLAUDE_PATH_ENV, CLOUD_PLUGIN_ID, cloudPluginInventory, resolveClaude } from "../src/update-plugin";
import { stageSkillSource } from "../src/update-skill-source";
import { setComponentPolicy } from "../src/update-policy";
import { makeCtx, tempHome } from "./helpers";
import { approved, fakeCliApply, memberFetch, NEXT, OLD, signIn, skillRepository } from "./update-fixtures";

const claudeBinary = () => {
  const path = join(tempHome(), "claude");
  writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o755); return path;
};

function installed(version = OLD) {
  const home = tempHome(), f = skillRepository("cloud", version), target = skillRepository();
  const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(home, "custom-claude"), [CLAUDE_PATH_ENV]: claudeBinary() };
  const source = stageSkillSource(home, "cloud", f.target, { repositoryUrl: () => f.repo });
  if (!source.ok) throw new Error(source.detail);
  const config = env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(config, "plugins"), { recursive: true });
  const select = (path: string) => {
    writeFileSync(join(config, "plugins/known_marketplaces.json"), JSON.stringify({ "catalyst-cloud": { source: { source: "directory", path }, installLocation: path } }));
    writeFileSync(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { [CLOUD_PLUGIN_ID]: false }, extraKnownMarketplaces: { "catalyst-cloud": { source: { source: "directory", path } }, unrelated: { source: { source: "directory", path: "/unrelated" } } }, unrelated: "keep" }));
  };
  const registry = (v: string, scope = "user") => writeFileSync(join(config, "plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [CLOUD_PLUGIN_ID]: [{ scope, version: v, gitCommitSha: "f".repeat(40) }] } }));
  select(source.dir); registry(version);
  writeFileSync(join(config, "plugins/data-sentinel"), "keep");
  let selected = source.dir;
  const calls: string[][] = [];
  const exec: CliExec = (argv, cwd, childEnv) => {
    if (argv[0] === "git") return spawnCliCommand(argv, cwd, childEnv);
    calls.push([...argv]);
    if (argv[2] === "marketplace" && argv[3] === "add") { selected = argv[4] ?? ""; select(selected); }
    if (argv[2] === "update") {
      const manifest: unknown = JSON.parse(readFileSync(join(selected, ".claude-plugin/plugin.json"), "utf8"));
      if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string") throw new Error("fixture manifest");
      registry(manifest.version);
    }
    return { status: 0, stdout: "child output must not be printed", stderr: "" };
  };
  return { home, env, config, f, target, source, exec, calls, registry };
}

describe("approved Cloud plugin", () => {
  it.each([OLD, NEXT, "0.16.99"])("selects the approved local checkout from %s, including stale cached SHA", (version) => {
    const f = installed(version);
    const result = applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { exec: f.exec, repositoryUrl: () => f.target.repo });
    expect(result).toMatchObject({ outcome: "updated", version: NEXT, commit: f.target.target.commit });
    expect(f.calls.map((a) => a.slice(1, 4))).toEqual([["plugin", "marketplace", "add"], ["plugin", "update", CLOUD_PLUGIN_ID]]);
    expect(f.calls.every((a) => a.slice(-2).join(" ") === "--scope user")).toBe(true);
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ commit: f.target.target.commit });
    const settings = JSON.parse(readFileSync(join(f.config, "settings.json"), "utf8"));
    expect(settings.enabledPlugins[CLOUD_PLUGIN_ID]).toBe(false);
    expect(settings.unrelated).toBe("keep");
    expect(readFileSync(join(f.config, "plugins/data-sentinel"), "utf8")).toBe("keep");
  });
  it("restores the previous source after command failure", () => {
    const f = installed();
    const result = applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { repositoryUrl: () => f.target.repo, exec: (argv, cwd, env) => argv[2] === "update" ? { status: 1, stdout: "", stderr: "failure" } : f.exec(argv, cwd, env) });
    expect(result).toMatchObject({ outcome: "failed", detail: "update_failed" });
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ commit: f.f.target.commit });
  });
  it("refuses unsupported scope, local edits, missing Claude and manifest mismatch", () => {
    const f = installed();
    f.registry(OLD, "project");
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ state: "unknown", reason: "plugin_scope_unsupported" });
    expect(applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "project", { exec: f.exec })).toMatchObject({ outcome: "failed" });
    f.registry(OLD);
    expect(applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { claudePath: null })).toMatchObject({ outcome: "no_claude" });
    expect(applyCloudPluginUpdate(f.home, f.env, f.target.target, OLD, "user", { exec: f.exec, repositoryUrl: () => f.target.repo })).toMatchObject({ outcome: "failed", detail: "source_mismatch" });
    writeFileSync(join(f.source.dir, "extra"), "edit");
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ state: "unknown", reason: "local_changes" });
    expect(f.calls).toEqual([]);
  });
  it("updates a plugin-only installation through the coordinator, respects holds, and keeps JSON clean", async () => {
    const f = installed(); signIn(f.home);
    const release = approved({ mutate: (r) => { r.skills = { cloud: f.target.target }; } });
    const ctx = makeCtx(f.home, { env: f.env, fetch: memberFetch(200, { ok: true, release }) });
    const options: UpdateOptions = { mode: "apply", imagesDir: join(f.home, "absent"), engine: () => { throw new Error("no Docker"); }, cliApply: fakeCliApply([]), pluginApply: (h, e, target, version, scope, deps) => applyCloudPluginUpdate(h, e, target, version, scope, { ...deps, exec: f.exec, repositoryUrl: () => f.target.repo }) };
    setComponentPolicy(f.home, "skills-cloud", false);
    expect((await runUpdate(ctx, options)).components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ status: "held" });
    expect(f.calls).toEqual([]);
    setComponentPolicy(f.home, "skills-cloud", true);
    const report = await runUpdate(ctx, options);
    expect(report.components.find((c) => c.id === "skills-cloud-plugin")).toMatchObject({ status: "updated", installedCommit: f.target.target.commit });
    expect(report.components.find((c) => c.id === "skills-cloud")).toMatchObject({ status: "not_installed" });
    expect(updateReportLines(report)).toContain(`Cloud skills plugin: run /reload-plugins in Claude Code, or restart it, to load ${NEXT}.`);
    expect(ctx.out).toEqual([]);
  });
  it("adopts only a clean allowlisted Git marketplace and rejects conflicting declarations", () => {
    const f = installed();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.source.dir });
    git("remote", "add", "origin", "https://github.com/coalesce-labs/catalyst-cloud-skills.git");
    const source = { source: "github", repo: "coalesce-labs/catalyst-cloud-skills" };
    writeFileSync(join(f.config, "plugins/known_marketplaces.json"), JSON.stringify({ "catalyst-cloud": { source, installLocation: f.source.dir } }));
    writeFileSync(join(f.config, "settings.json"), JSON.stringify({ extraKnownMarketplaces: { "catalyst-cloud": { source } } }));
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ state: "installed", commit: null });
    writeFileSync(join(f.source.dir, "ignored-extra"), "local");
    expect(applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { exec: f.exec })).toMatchObject({ outcome: "failed", detail: "local_changes" });
    rmSync(join(f.source.dir, "ignored-extra"));
    expect(applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { exec: f.exec, repositoryUrl: () => f.target.repo })).toMatchObject({ outcome: "updated", commit: f.target.target.commit });
    writeFileSync(join(f.config, "settings.local.json"), JSON.stringify({ extraKnownMarketplaces: { "catalyst-cloud": { source: { source: "directory", path: "/custom" } } } }));
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ state: "unknown", reason: "plugin_scope_unsupported" });
  });
  it("preserves a Git marketplace ref and verifies content when restoring a failed switch", () => {
    const f = installed();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/coalesce-labs/catalyst-cloud-skills.git"], { cwd: f.source.dir });
    const source = { source: "github", repo: "coalesce-labs/catalyst-cloud-skills", ref: "release/approved" };
    const restore = () => {
      writeFileSync(join(f.config, "plugins/known_marketplaces.json"), JSON.stringify({ "catalyst-cloud": { source, installLocation: f.source.dir } }));
      writeFileSync(join(f.config, "settings.json"), JSON.stringify({ extraKnownMarketplaces: { "catalyst-cloud": { source } } }));
    };
    restore();
    const calls: string[][] = [];
    const result = applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { repositoryUrl: () => f.target.repo, exec: (argv, cwd, env) => {
      calls.push([...argv]);
      if (argv[2] === "update") return { status: 1, stdout: "", stderr: "failure" };
      if (argv[4] === "coalesce-labs/catalyst-cloud-skills#release/approved") { restore(); return { status: 0, stdout: "", stderr: "" }; }
      return f.exec(argv, cwd, env);
    } });
    expect(result).toMatchObject({ outcome: "failed", detail: "update_failed" });
    expect(calls.some((argv) => argv[4] === "coalesce-labs/catalyst-cloud-skills#release/approved")).toBe(true);
    expect(cloudPluginInventory(f.home, f.env)).toMatchObject({ source: { argument: "coalesce-labs/catalyst-cloud-skills#release/approved" } });
  });
  it("reports failed restoration and rejects wrong marketplace names before selection", () => {
    const f = installed();
    let selections = 0;
    const failed = applyCloudPluginUpdate(f.home, f.env, f.target.target, NEXT, "user", { repositoryUrl: () => f.target.repo, exec: (argv, cwd, env) => {
      if (argv[2] === "update" || argv[2] === "marketplace" && ++selections > 1) return { status: 1, stdout: "", stderr: "failure" };
      return f.exec(argv, cwd, env);
    } });
    expect(failed).toMatchObject({ outcome: "failed", detail: "rollback_failed" });
    const fresh = installed();
    writeFileSync(join(fresh.target.repo, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "unrelated", plugins: [{ name: "catalyst", source: "./" }] }));
    execFileSync("git", ["add", "."], { cwd: fresh.target.repo });
    execFileSync("git", ["commit", "-qm", "wrong marketplace"], { cwd: fresh.target.repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fresh.target.repo, encoding: "utf8" }).trim();
    expect(applyCloudPluginUpdate(fresh.home, fresh.env, { ...fresh.target.target, commit }, NEXT, "user", { exec: fresh.exec, repositoryUrl: () => fresh.target.repo })).toMatchObject({ outcome: "failed", detail: "source_mismatch" });
    expect(fresh.calls).toEqual([]);
  });
  it("finds Claude in its usual location", () => {
    const home = tempHome(); mkdirSync(join(home, ".local/bin"), { recursive: true });
    const path = join(home, ".local/bin/claude"); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755);
    expect(resolveClaude(home, {})).toBe(path);
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
