// docker-stdin-epipe.test.ts — CTC-7006. A docker that exits before reading its stdin breaks the
// pipe the CLI writes to. Node raises that EPIPE as an `error` event on the child's stdin, and a
// stream with no `error` listener rethrows it: the CLI died before `runner update --auto` printed its
// line, recorded its outcome or released its lock. The child's exit code is the verdict, as it is
// for `watch --exec` (src/watch.ts), and a broken pipe is not a failure on its own.
//
// The stand-in docker is a real executable on PATH, so the real spawn path runs, not a scripted exec.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

import { spawnDocker } from "../src/onboard-runner";
import { RELEASE_STATE_FILE } from "../src/runner-update";
import { tempHome } from "./helpers";
import { runnerInstall } from "./update-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

/** A fresh directory holding one executable `docker` that runs `body`, for the front of PATH. */
function stubDocker(body: string): string {
  const bin = mkdtempSync(join(tmpdir(), "docker-stub-"));
  writeFileSync(join(bin, "docker"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}
const pathWith = (bin: string) => `${bin}${delimiter}${process.env.PATH ?? ""}`;

describe("spawnDocker", () => {
  test("a docker that exits before reading its input is judged by its exit code, not by the broken pipe", async () => {
    // An input larger than the pipe buffer cannot be written in one shot, so the write is still in
    // flight when a docker that reads nothing exits. Without the stdin error listener in
    // spawnDocker, that EPIPE arrives with no listener and Node rethrows it as an unhandled error;
    // vitest surfaces that as a failed file even when every assertion here passed.
    const input = "x".repeat(1024 * 1024);
    for (const [body, code] of [["exit 1", 1], ["exit 0", 0]] as const) {
      const env = { ...process.env, PATH: pathWith(stubDocker(body)) };
      await expect(spawnDocker(["version"], { env, input })).resolves.toEqual({ code, stdout: "", stderr: "" });
    }
  });
});

describe("the built CLI against a docker that exits without reading its input", () => {
  beforeAll(() => {
    // bin/catalyst.js loads dist/, so the compiled output must be current.
    const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
    expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
  }, 120_000);

  // A cold CLI always loses the race to a docker that exits at once, so these fail without the fix.
  function runCli(args: string[], bin: string, home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(pkgRoot, "bin", "catalyst.js"), ...args], {
        cwd: pkgRoot,
        env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home, CATALYST_SKILLS_OFFLINE: "1", PATH: pathWith(bin) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  const AUTO_LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z (retained|failed) \S+ generation=\S+$/;

  test("runner update --auto prints one outcome line, exits with its own code, and reports that outcome next run", async () => {
    const home = tempHome();
    const dir = runnerInstall(undefined, null);

    const first = await runCli(["runner", "update", "--auto", "--dir", dir], stubDocker("exit 1"), home);
    expect(first.stderr).not.toMatch(/EPIPE/);
    const lines = first.stdout.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(AUTO_LINE);
    // A docker that fails the release read is the existing `retained no_credential`, exit 1.
    expect(first.status).toBe(1);
    const state = JSON.parse(readFileSync(join(dir, RELEASE_STATE_FILE), "utf8")) as { last: unknown };
    expect(state.last).toMatchObject({ outcome: "retained", detail: "no_credential" });
    expect(existsSync(join(dir, "update.lock")), "the lock is released").toBe(false);

    // The next run's release read carries the recorded outcome to the cloud. The stub appends its
    // arguments to a file beside itself, so no path is quoted into the script.
    const recording = stubDocker(`printf '%s\\n' "$@" >> "$(dirname "$0")/argv"\nexit 1`);
    const second = await runCli(["runner", "update", "--auto", "--dir", dir], recording, home);
    expect(second.stderr).not.toMatch(/EPIPE/);
    expect(second.stdout.trim()).toMatch(AUTO_LINE);
    const report = readFileSync(join(recording, "argv"), "utf8").split("\n").find((arg) => arg.startsWith("CATALYST_UPDATE_REPORT="));
    expect(report).toBeDefined();
    expect(report).toContain('"outcome":"retained"');
  });

  test("runner status says Docker is not reachable instead of crashing", async () => {
    const result = await runCli(["runner", "status"], stubDocker("exit 1"), tempHome());
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toMatch(/EPIPE/);
    expect(output).toContain("Docker is not reachable");
    expect(result.status).toBe(1);
  });
});
