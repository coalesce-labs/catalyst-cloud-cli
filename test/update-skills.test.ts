// update-skills.test.ts — the Cloud skills pack moves to its approved version (CTC-6708) from that
// version's own package, while the CLI's selection is untouched (so a held CLI stays held). Only
// copies this install made change: a person's own skill and a symlinked one are left alone.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeRuntimePathFor, spawnCliCommand, type CliExec } from "../src/update-cli";
import { applyCloudPackUpdate } from "../src/update-skills";
import { tempHome } from "./helpers";
import { cloudPack, NEXT, OLD } from "./update-fixtures";

const stamped = (name: string, version: string) =>
  `---\nname: ${name}\ndescription: fixture\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills@${version} — fixture -->\n\n# ${name} ${version}\n`;

/** Stands in for npm: writes a CLI package of the asked version whose bundled skills carry `stamp`. */
function packageNpm(calls: string[][], opts: { stamp?: string; fail?: boolean } = {}): CliExec {
  return (argv, cwd, env) => {
    if (argv[0] !== "npm") return spawnCliCommand(argv, cwd, env);
    calls.push([...argv]);
    if (opts.fail) return { status: 1, stdout: "", stderr: "npm ERR! network" };
    const spec = argv[argv.length - 1] ?? "";
    const version = spec.slice(spec.lastIndexOf("@") + 1);
    const prefix = argv[argv.indexOf("--prefix") + 1] ?? cwd;
    const dir = join(prefix, "node_modules", "@catalyst-cloud", "cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@catalyst-cloud/cli", version }));
    writeFileSync(join(dir, "bin", "catalyst.js"), `console.log("@catalyst-cloud/cli ${version} (fixture)");\n`);
    for (const name of ["catalyst-onboard", "unstick"]) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(join(dir, "skills", name, "SKILL.md"), stamped(name, opts.stamp ?? version));
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

const read = (dir: string, name: string) => readFileSync(join(dir, name, "SKILL.md"), "utf8");

describe("applyCloudPackUpdate", () => {
  it("POSITIVE CONTROL: refreshes this install's copies to the approved pack and selects no CLI", () => {
    const home = tempHome();
    const skills = cloudPack(OLD);
    const calls: string[][] = [];
    const result = applyCloudPackUpdate(home, skills, NEXT, { exec: packageNpm(calls) });
    expect(result).toEqual({ outcome: "updated", detail: "refreshed", version: NEXT });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`@catalyst-cloud/cli@${NEXT}`);
    expect(read(skills, "catalyst-onboard")).toContain(`@${NEXT}`);
    expect(read(skills, "unstick")).toContain(`@${NEXT}`);
    // The CLI's own selection is not this update's to change: a held CLI stays held.
    expect(existsSync(activeRuntimePathFor(home))).toBe(false);
  });

  it("a person's own skill of the same name and a symlinked skill are left as they are", () => {
    const home = tempHome();
    const skills = mkdtempSync(join(tmpdir(), "update-skills-mixed-"));
    mkdirSync(join(skills, "catalyst-onboard"));
    writeFileSync(join(skills, "catalyst-onboard", "SKILL.md"), stamped("catalyst-onboard", OLD));
    mkdirSync(join(skills, "my-own", "unstick"), { recursive: true });
    const linked = join(skills, "my-own", "unstick");
    writeFileSync(join(linked, "SKILL.md"), "---\nname: unstick\ndescription: mine\n---\n\n# mine\n");
    symlinkSync(linked, join(skills, "unstick"));
    const mine = read(skills, "unstick");
    const result = applyCloudPackUpdate(home, skills, NEXT, { exec: packageNpm([]) });
    expect(result).toMatchObject({ outcome: "updated", version: NEXT });
    expect(read(skills, "catalyst-onboard")).toContain(`@${NEXT}`);
    expect(read(skills, "unstick")).toBe(mine);
  });

  it("a pack an installer linked in is left to that installer: no download, no change, not a failure", () => {
    const home = tempHome();
    const source = cloudPack(OLD);
    const skills = mkdtempSync(join(tmpdir(), "update-skills-linked-"));
    symlinkSync(join(source, "catalyst-onboard"), join(skills, "catalyst-onboard"));
    const calls: string[][] = [];
    expect(applyCloudPackUpdate(home, skills, NEXT, { exec: packageNpm(calls) })).toEqual({ outcome: "linked", detail: "installation_owner_unknown", version: null });
    expect(calls).toEqual([]);
    expect(read(skills, "catalyst-onboard")).toContain(`@${OLD}`);
  });

  it.each([
    ["the install fails", { fail: true }, "install_failed"],
    ["the package's skills are not the approved pack", { stamp: OLD }, "pack_mismatch"],
  ])("NEGATIVE: when %s no skill changes", (_label, opts, detail) => {
    const home = tempHome();
    const skills = cloudPack(OLD);
    const before = read(skills, "catalyst-onboard");
    expect(applyCloudPackUpdate(home, skills, NEXT, { exec: packageNpm([], opts) })).toMatchObject({ outcome: "failed", detail });
    expect(read(skills, "catalyst-onboard")).toBe(before);
  });
});
