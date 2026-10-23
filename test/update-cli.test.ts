// update-cli.test.ts — the CLI moves itself to the approved version (CTC-6708): the approved
// package is installed into its own directory, checked, and selected; the person's own `catalyst`
// command then answers with that version. A failed install leaves the running version selected.
// The launcher half spawns the real bin, so dist/ is built first.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { activeRuntimeBin, activeRuntimePathFor, applyCliUpdate, readActiveRuntime, runtimeRootFor, spawnCliCommand, type CliExec } from "../src/update-cli";
import { tempHome } from "./helpers";
import { CLI_VERSION, NEXT, OLD } from "./update-fixtures";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(pkgRoot, "bin", "catalyst.js");
const LEGACY_BIN = join(pkgRoot, "bin", "catalyst-skills.js");

/** Stands in for npm: writes a CLI package that answers `--version` with `answers` into the prefix. */
function fakeNpm(calls: string[][], opts: { answers?: string; name?: string; fail?: boolean } = {}): CliExec {
  return (argv, cwd, env) => {
    if (argv[0] !== "npm") return spawnCliCommand(argv, cwd, env);
    calls.push([...argv]);
    if (opts.fail) return { status: 1, stdout: "", stderr: "npm ERR! network" };
    const spec = argv[argv.length - 1] ?? "";
    const version = spec.slice(spec.lastIndexOf("@") + 1);
    const prefix = argv[argv.indexOf("--prefix") + 1] ?? cwd;
    const dir = join(prefix, "node_modules", "@catalyst-cloud", "cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: opts.name ?? "@catalyst-cloud/cli", version }));
    for (const bin of ["catalyst.js", "catalyst-skills.js"])
      writeFileSync(join(dir, "bin", bin), `console.log("@catalyst-cloud/cli ${opts.answers ?? version} (fixture ${bin})");\n`);
    return { status: 0, stdout: "", stderr: "" };
  };
}

const runBin = (home: string, bin = BIN, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bin, "--version"], { cwd: pkgRoot, encoding: "utf8", env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home, ...env } });

beforeAll(() => {
  const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
  expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
}, 120_000);

describe("applyCliUpdate", () => {
  it("POSITIVE CONTROL: installs the exact approved CLI beside this one, checks it answers, selects it, and `catalyst --version` reports it", () => {
    const home = tempHome();
    const calls: string[][] = [];
    expect(runBin(home).stdout).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    const result = applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm(calls), now: () => 42 });
    expect(result).toEqual({ outcome: "updated", detail: "activated", version: NEXT });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`@catalyst-cloud/cli@${NEXT}`);
    expect(calls[0]).not.toContain("-g");
    expect(readActiveRuntime(home)).toEqual({ version: 1, cliVersion: NEXT, root: runtimeRootFor(home, NEXT), activatedAtMs: 42, previous: null });
    const out = runBin(home);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`@catalyst-cloud/cli ${NEXT} (fixture catalyst.js)`);
    expect(runBin(home, LEGACY_BIN).stdout).toContain(`@catalyst-cloud/cli ${NEXT} (fixture catalyst-skills.js)`);
  });

  it("a staging another check is running is left alone: nothing installed, nothing removed", () => {
    const home = tempHome();
    mkdirSync(join(home, ".config", "catalyst-cloud", "cli-runtimes"), { recursive: true });
    writeFileSync(join(home, ".config", "catalyst-cloud", "cli-runtimes", ".staging.lock"), "");
    const calls: string[][] = [];
    expect(applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm(calls) })).toEqual({ outcome: "failed", detail: "update_running", version: CLI_VERSION });
    expect(calls).toEqual([]);
    expect(existsSync(activeRuntimePathFor(home))).toBe(false);
  });

  it("a second check at the same approved version installs nothing more", () => {
    const home = tempHome();
    const calls: string[][] = [];
    applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm(calls) });
    expect(applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm(calls) })).toMatchObject({ outcome: "current", version: NEXT });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["the install fails", { fail: true }, "install_failed"],
    ["the package is not the CLI", { name: "left-pad" }, "package_mismatch"],
    ["the installed CLI answers with another version", { answers: OLD }, "smoke_failed"],
  ])("NEGATIVE: when %s nothing is selected and the running version keeps answering", (_label, opts, detail) => {
    const home = tempHome();
    const result = applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm([], opts) });
    expect(result).toEqual({ outcome: "failed", detail, version: CLI_VERSION });
    expect(existsSync(activeRuntimePathFor(home))).toBe(false);
    expect(runBin(home).stdout).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
  });

  it("a failed later update keeps the earlier selected version and its directory", () => {
    const home = tempHome();
    const [major, minor, patch] = NEXT.split(".").map(Number) as [number, number, number];
    const later = `${major}.${minor}.${patch + 1}`;
    applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm([]) });
    const before = readFileSync(activeRuntimePathFor(home), "utf8");
    expect(applyCliUpdate(home, CLI_VERSION, later, { exec: fakeNpm([], { fail: true }) })).toMatchObject({ outcome: "failed", version: NEXT });
    expect(readFileSync(activeRuntimePathFor(home), "utf8")).toBe(before);
    expect(runBin(home).stdout).toContain(`@catalyst-cloud/cli ${NEXT} `);
  });

  it("NEGATIVE: a target that is not an exact version, or is older, never installs", () => {
    const home = tempHome();
    const calls: string[][] = [];
    expect(applyCliUpdate(home, CLI_VERSION, "latest", { exec: fakeNpm(calls) })).toMatchObject({ outcome: "failed", detail: "target_invalid" });
    expect(applyCliUpdate(home, CLI_VERSION, OLD, { exec: fakeNpm(calls) })).toMatchObject({ outcome: "current", detail: "installed_newer" });
    expect(calls).toEqual([]);
  });
});

describe("the launcher's selection", () => {
  it("NEGATIVE: a record naming an older version, or a directory outside this install's runtime directory, runs this version", () => {
    const home = tempHome();
    applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm([]) });
    const record = JSON.parse(readFileSync(activeRuntimePathFor(home), "utf8")) as Record<string, unknown>;
    writeFileSync(activeRuntimePathFor(home), JSON.stringify({ ...record, root: join(home, "elsewhere") }));
    expect(activeRuntimeBin(home, CLI_VERSION)).toBeNull();
    expect(runBin(home).stdout).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    writeFileSync(activeRuntimePathFor(home), JSON.stringify(record));
    expect(activeRuntimeBin(home, NEXT)).toBeNull();
  });

  it("a bin told it is the one being checked runs itself; any other marker still selects", () => {
    const home = tempHome();
    applyCliUpdate(home, CLI_VERSION, NEXT, { exec: fakeNpm([]) });
    expect(runBin(home, BIN, { CATALYST_CLI_ACTIVE_RUNTIME: BIN }).stdout).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    // A `catalyst` started by a selected version's child (watch --exec, say) still runs the selected one.
    expect(runBin(home, BIN, { CATALYST_CLI_ACTIVE_RUNTIME: "/elsewhere/bin/catalyst.js" }).stdout).toContain(`@catalyst-cloud/cli ${NEXT} `);
  });

  it("the selected version runs in the launcher's own process", () => {
    const home = tempHome();
    applyCliUpdate(home, CLI_VERSION, NEXT, {
      exec: (argv, cwd, env) => {
        const result = fakeNpm([])(argv, cwd, env);
        if (argv[0] === "npm") {
          const prefix = argv[argv.indexOf("--prefix") + 1] ?? cwd;
          // Answers --version as the CLI does, and anything else with its own pid.
          writeFileSync(
            join(prefix, "node_modules", "@catalyst-cloud", "cli", "bin", "catalyst.js"),
            `console.log(process.argv.includes("--version") ? "@catalyst-cloud/cli ${NEXT} (fixture)" : "pid " + process.pid);\n`,
          );
        }
        return result;
      },
    });
    const child = spawnSync(process.execPath, [BIN, "status"], { cwd: pkgRoot, encoding: "utf8", env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home } });
    expect(child.stdout.trim()).toBe(`pid ${child.pid}`);
  });
});
