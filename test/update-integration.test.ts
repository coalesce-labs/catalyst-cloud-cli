// update-integration.test.ts — the ticket's five scenarios (CTC-6708) through the real command
// parser, the real CLI activation and Cloud pack refresh on temporary files, and the person's own
// `catalyst` bin for the version check. The fixture boundaries left: the image engine (Docker), the
// approved release (the cloud's), npm's download (a fake that writes the package it was asked for)
// and, for the replica, the writer's status (the old writer itself is a real process).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import type { ApprovedSkillPack } from "../src/approved-release";
import { loadConfig } from "../src/config";
import { pidAlive, type ReplicaStatus } from "../src/replica";
import { readReleaseState } from "../src/runner-update";
import { applyCliUpdate, spawnCliCommand, type CliExec } from "../src/update-cli";
import { restartReplica } from "../src/update-replica";
import { applyPackUpdate } from "../src/update-skills";
import { makeCtx, seedReplica, seedWriterState, tempHome } from "./helpers";
import { answered, approved, CLI_VERSION, cloudPack, countingEngine, fakeNpm, hostRelease, NEXT, OLD, ref, runnerInstall, sdkProject, signIn, skillRepository } from "./update-fixtures";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(pkgRoot, "bin", "catalyst.js");

beforeAll(() => {
  const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
  expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
}, 120_000);

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** npm's download: writes the asked-for CLI package, whose bin answers its version and whose
 *  bundled skills carry its stamp. */
const npm: CliExec = (argv, cwd, env) => {
  if (argv[0] !== "npm") return spawnCliCommand(argv, cwd, env);
  const spec = argv[argv.length - 1] ?? "";
  const version = spec.slice(spec.lastIndexOf("@") + 1);
  const dir = join(argv[argv.indexOf("--prefix") + 1] ?? cwd, "node_modules", "@catalyst-cloud", "cli");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@catalyst-cloud/cli", version }));
  writeFileSync(join(dir, "bin", "catalyst.js"), `console.log("@catalyst-cloud/cli ${version} (fixture)");\n`);
  for (const name of ["catalyst-onboard", "unstick"]) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(
      join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: fixture\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills@${version} — fixture -->\n\n# ${name}\n`,
    );
  }
  return { status: 0, stdout: "", stderr: "" };
};

/** A runner on generation 88, a Cloud pack from OLD, images at generation 89 and a component approval naming NEXT. */
function install() {
  const home = tempHome();
  signIn(home);
  const dir = runnerInstall();
  const skills = cloudPack(OLD);
  const source = skillRepository();
  const release = approved({ mutate: (r) => { r.skills = { cloud: source.target }; } });
  const engine = countingEngine(answered(hostRelease({ components: release })), { supervisor: ref("supervisor", "8"), watchdog: ref("watchdog", "9") });
  const ctx = () => makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", CATALYST_SKILLS_CLAUDE_DIR: skills } });
  const update = {
    engine,
    cliApply: (h: string, own: string, target: string) => applyCliUpdate(h, own, target, { exec: npm }),
    packApply: (h: string, env: NodeJS.ProcessEnv, pack: "cloud" | "dev", d: string, target: ApprovedSkillPack) => applyPackUpdate(h, env, pack, d, target, { baseline: { exec: npm }, repositoryUrl: () => source.repo }),
  };
  const version = () =>
    spawnSync(process.execPath, [BIN, "--version"], { cwd: pkgRoot, encoding: "utf8", env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home } }).stdout;
  const stamp = () => readFileSync(join(skills, "catalyst-onboard", "SKILL.md"), "utf8").match(/catalyst-skills@(\S+)/)?.[1];
  return { home, dir, skills, engine, ctx, update, version, stamp };
}

describe("CTC-6708 scenarios", () => {
  it("one release check moves every installed component to the approved release", async () => {
    const it = install();
    expect(it.version()).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    const ctx = it.ctx();
    expect(await main(["update", "--dir", it.dir], ctx, { update: it.update })).toBe(0);
    expect(it.version()).toContain(`@catalyst-cloud/cli ${NEXT} `);
    expect(it.stamp()).toBe(NEXT);
    expect(readReleaseState(it.dir).generation).toBe(89);
    expect(ctx.out.at(-1)).toBe("Release check finished.");
  });

  it("the local replica comes back on the new CLI with its data", async () => {
    const it = install();
    const old = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "replica", "start"], { stdio: "ignore" });
    children.push(old);
    const oldPid = old.pid ?? -1;
    const dbPath = join(it.home, "replica.db");
    writeFileSync(dbPath, "synced rows and cursor");
    let next: { pid: number; version: string } | null = null;
    const status = (): ReplicaStatus => {
      const writer = next ?? (pidAlive(oldPid) ? { pid: oldPid, version: OLD } : null);
      return {
        verdict: writer ? "fresh" : "stale",
        exitCode: writer ? 0 : 1,
        configured: true,
        dbPath,
        cursor: 7,
        heartbeatAgeMs: 0,
        lockPid: writer?.pid ?? null,
        pidfilePid: null,
        writerAlive: writer !== null,
        reasons: [],
        writer: writer ? { updatedAt: 1, pid: writer.pid, consecutiveFailures: 0, lastError: null, lastFailureAt: null, stopped: null, version: writer.version } : null,
      };
    };
    const ctx = it.ctx();
    const cfg = loadConfig(it.home);
    if (!cfg) throw new Error("signed in");
    const starts: (readonly string[])[] = [];
    const replicaRestart = (target: string) =>
      restartReplica(ctx, cfg, target, {
        launcher: BIN,
        status,
        timeoutMs: 5_000,
        pollMs: 20,
        start: (argv) => {
          starts.push(argv);
          next = { pid: 4242, version: target };
          return 4242;
        },
      });
    // The release check finds the replica through its inventory; this one reports it running OLD.
    await seedReplica(it.home, { heartbeatAgeMs: 0 });
    seedWriterState(it.home, { version: OLD });
    expect(await main(["update", "--dir", it.dir], ctx, { update: { ...it.update, replicaRestart } })).toBe(0);
    expect(it.version()).toContain(`@catalyst-cloud/cli ${NEXT} `);
    expect(pidAlive(oldPid)).toBe(false);
    expect(starts).toEqual([[BIN, "replica", "start", "--db", dbPath]]);
    expect(ctx.out.find((l) => l.startsWith("Local replica"))).toContain("updated");
    expect(readFileSync(dbPath, "utf8")).toBe("synced rows and cursor");
  });

  it("an owner opts the CLI out and the rest still update", async () => {
    const it = install();
    expect(await main(["update", "policy", "cli", "off"], it.ctx())).toBe(0);
    expect(await main(["update", "--dir", it.dir], it.ctx(), { update: it.update })).toBe(0);
    expect(readReleaseState(it.dir).generation).toBe(89);
    expect(it.stamp()).toBe(NEXT);
    expect(it.version()).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    const check = it.ctx();
    expect(await main(["runner", "update", "--check", "--dir", it.dir], check, { runner: { engine: it.engine } })).toBe(0);
    expect(check.out.find((l) => l.startsWith("CLI "))).toContain("held by owner's setting");
  });

  it("an owner sees every component's version against the approved release", async () => {
    const it = install();
    const ctx = it.ctx();
    expect(await main(["update", "--check", "--dir", it.dir], ctx, { update: it.update })).toBe(0);
    for (const [label, installed, status] of [
      ["Runner", "generation 88", "update available"],
      ["CLI", CLI_VERSION, "update available"],
      ["Cloud skills", OLD, "update available"],
    ] as const) {
      const row = ctx.out.find((l) => l.startsWith(`${label} `)) ?? "";
      expect(row).toContain(installed);
      expect(row).toContain(label === "Runner" ? "generation 89" : NEXT);
      expect(row).toContain(status);
    }
    expect(it.version()).toContain(`@catalyst-cloud/cli ${CLI_VERSION} `);
    expect(it.stamp()).toBe(OLD);
  });

  it("a project's SDK is offered the release without Catalyst editing the project unasked", async () => {
    const it = install();
    const project = sdkProject(OLD);
    const bytes = () => Object.fromEntries(readdirSync(project).map((f) => [f, readFileSync(join(project, f), "utf8")]));
    const before = bytes();
    const ctx = it.ctx();
    const calls: string[][] = [];
    expect(await main(["update", "--dir", it.dir, "--project", project], ctx, { update: { ...it.update, sdkExec: fakeNpm(calls) } })).toBe(0);
    expect(ctx.out).toContain(`Update this project's SDK: catalyst update sdk --project ${project}`);
    expect(calls).toEqual([]);
    expect(bytes()).toEqual(before);
    // Turned on for that project, the next release check moves it.
    expect(await main(["update", "policy", "sdk", "on", "--project", project], it.ctx())).toBe(0);
    expect(await main(["update", "--dir", it.dir], it.ctx(), { update: { ...it.update, sdkExec: fakeNpm(calls) } })).toBe(0);
    expect(calls).toEqual([["npm", "install", "--save-exact", `@catalyst-cloud/sdk@${NEXT}`]]);
  });
});
