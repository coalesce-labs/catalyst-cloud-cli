import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeRuntimePathFor, spawnCliCommand, type CliExec } from "../src/update-cli";
import { applyPackUpdate } from "../src/update-skills";
import { tempHome } from "./helpers";
import { cloudPack, OLD, skillRepository } from "./update-fixtures";

/** The legacy baseline is the installed exact npm version, never the target source. */
function packageNpm(calls: string[][], fail = false): CliExec {
  return (argv, cwd, env) => {
    if (argv[0] !== "npm") return spawnCliCommand(argv, cwd, env);
    calls.push([...argv]);
    if (fail) return { status: 1, stdout: "", stderr: "network" };
    const dir = join(argv[argv.indexOf("--prefix") + 1] ?? cwd, "node_modules/@catalyst-cloud/cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@catalyst-cloud/cli", version: OLD }));
    writeFileSync(join(dir, "bin/catalyst.js"), `console.log("${OLD}")`);
    cpSync(cloudPack(OLD), join(dir, "skills"), { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("legacy pack adoption", () => {
  it("verifies exact baseline bytes, removes retired names and leaves independent skills", () => {
    const home = tempHome(), skills = cloudPack(OLD), source = skillRepository(), calls: string[][] = [];
    mkdirSync(join(skills, "custom")); writeFileSync(join(skills, "custom/SKILL.md"), "mine");
    const result = applyPackUpdate(home, {}, "cloud", skills, source.target, { baseline: { exec: packageNpm(calls) }, repositoryUrl: () => source.repo });
    expect(result).toMatchObject({ outcome: "updated", commit: source.target.commit });
    expect(calls[0]).toContain(`@catalyst-cloud/cli@${OLD}`);
    expect(readFileSync(join(skills, "catalyst-onboard/SKILL.md"), "utf8")).toContain("approved A");
    expect(existsSync(join(skills, "unstick"))).toBe(false);
    expect(readFileSync(join(skills, "custom/SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(activeRuntimePathFor(home))).toBe(false);
  });
  it("keeps edited stamped copies and refuses adoption without a baseline", () => {
    const home = tempHome(), skills = cloudPack(OLD), source = skillRepository();
    writeFileSync(join(skills, "catalyst-onboard/extra"), "local");
    expect(applyPackUpdate(home, {}, "cloud", skills, source.target, { baseline: { exec: packageNpm([]) } })).toMatchObject({ outcome: "failed", detail: "local_changes" });
    expect(readFileSync(join(skills, "catalyst-onboard/extra"), "utf8")).toBe("local");
    expect(applyPackUpdate(tempHome(), {}, "cloud", cloudPack(OLD), source.target, { baseline: { exec: packageNpm([], true) } })).toMatchObject({ outcome: "linked", detail: "installation_owner_unknown" });
  });
  it("does not adopt arbitrary symlinks or foreign same-name copies", () => {
    const home = tempHome(), original = cloudPack(OLD), dir = join(home, "skills"), source = skillRepository();
    mkdirSync(dir); symlinkSync(join(original, "catalyst-onboard"), join(dir, "catalyst-onboard"));
    expect(applyPackUpdate(home, {}, "cloud", dir, source.target)).toMatchObject({ outcome: "linked", detail: "installation_owner_unknown" });
    expect(readFileSync(join(original, "catalyst-onboard/SKILL.md"), "utf8")).toContain(OLD);
  });
});
