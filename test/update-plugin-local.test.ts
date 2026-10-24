import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCloudPluginUpdate, cloudPluginInventory, resolveClaude, CLOUD_PLUGIN_ID } from "../src/update-plugin";
import { stageSkillSource } from "../src/update-skill-source";
import { spawnCliCommand } from "../src/update-cli";
import { tempHome } from "./helpers";
import { skillRepository } from "./update-fixtures";

describe("real Claude local marketplace", () => {
  it("upgrades, downgrades and corrects same-version content while preserving disabled state and plugin data", () => {
    const claude = resolveClaude(tempHome(), process.env);
    if (claude === null) { console.warn("UNAVAILABLE: real Claude executable absent; deterministic plugin tests still execute."); return; }
    const home = tempHome();
    const env = { PATH: process.env.PATH, HOME: home, PWD: home, CLAUDE_CONFIG_DIR: join(home, "claude-config"), DISABLE_AUTOUPDATER: "1" };
    const run = (...args: string[]) => {
      const result = spawnCliCommand([claude, ...args], home, env);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      return result.stdout;
    };
    const old = skillRepository("cloud", "0.16.25");
    const next = skillRepository("cloud", "0.16.28");
    const initial = stageSkillSource(home, "cloud", old.target, { repositoryUrl: () => old.repo });
    if (!initial.ok) throw new Error(initial.detail);
    run("plugin", "marketplace", "add", initial.dir, "--scope", "user");
    run("plugin", "install", CLOUD_PLUGIN_ID, "--scope", "user");
    run("plugin", "disable", CLOUD_PLUGIN_ID, "--scope", "user");
    const settingsFile = join(env.CLAUDE_CONFIG_DIR, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.env = { KEEP_THIS: "yes" };
    writeFileSync(settingsFile, JSON.stringify(settings));
    const data = join(env.CLAUDE_CONFIG_DIR, "plugins/data/catalyst-cloud/catalyst");
    mkdirSync(data, { recursive: true }); writeFileSync(join(data, "sentinel"), "keep");
    const apply = (fixture: typeof old) => applyCloudPluginUpdate(home, env, fixture.target, fixture.target.version, "user", { claudePath: claude, repositoryUrl: () => fixture.repo });
    expect(apply(next)).toMatchObject({ outcome: "updated", version: "0.16.28", commit: next.target.commit });
    expect(apply(old)).toMatchObject({ outcome: "updated", version: "0.16.25", commit: old.target.commit });
    // A later remote commit at the same version, deliberately selected before correction to A.
    const laterCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: next.repo, encoding: "utf8" }).trim();
    const later = { ...next, target: { ...next.target, commit: laterCommit } };
    expect(apply(later)).toMatchObject({ outcome: "updated", commit: laterCommit });
    const registryFile = join(env.CLAUDE_CONFIG_DIR, "plugins/installed_plugins.json");
    const registry = JSON.parse(readFileSync(registryFile, "utf8"));
    registry.plugins[CLOUD_PLUGIN_ID][0].gitCommitSha = laterCommit;
    writeFileSync(registryFile, JSON.stringify(registry));
    expect(apply(next)).toMatchObject({ outcome: "updated", commit: next.target.commit });
    expect(cloudPluginInventory(home, env)).toMatchObject({ commit: next.target.commit, version: "0.16.28" });
    const inventory = cloudPluginInventory(home, env);
    if (inventory.state !== "installed") throw new Error("plugin not installed");
    expect(readFileSync(join(inventory.source.dir, "skills/catalyst-onboard/SKILL.md"), "utf8")).toContain("approved A");
    const after = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(after.enabledPlugins[CLOUD_PLUGIN_ID]).toBe(false);
    expect(after.env.KEEP_THIS).toBe("yes");
    expect(readFileSync(join(data, "sentinel"), "utf8")).toBe("keep");
    const details: unknown = JSON.parse(run("plugin", "list", "--json"));
    expect(details).toEqual(expect.arrayContaining([expect.objectContaining({ id: CLOUD_PLUGIN_ID, version: "0.16.28", enabled: false, scope: "user" })]));
  }, 120_000);
});
