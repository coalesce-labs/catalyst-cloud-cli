import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDarwinThoughtsEngineForTest, validateDarwinThoughtsInstallLayoutForTest } from "../src/onboard-runner-custody.js";

describe("actual custody Engine selection through a fixed fake executable", () => {
  let home: string;
  let oldContext: string | undefined;
  let oldHost: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "custody-engine-"));
    oldContext = process.env.DOCKER_CONTEXT; oldHost = process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT; delete process.env.DOCKER_HOST;
  });
  afterEach(() => {
    if (oldContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = oldContext;
    if (oldHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldHost;
    fs.rmSync(home, { recursive: true, force: true });
  });
  function fixture(label: string | null = "v1", missingImage?: string) {
    const log = join(home, "calls.jsonl");
    const executable = join(home, "fixed-docker");
    const source = "#!" + fs.realpathSync(process.execPath) + "\n" + [
      'const fs=require("node:fs"),args=process.argv.slice(2);',
      "fs.appendFileSync(" + JSON.stringify(log) + ',JSON.stringify(args)+"\\n");',
      'if(args.includes("context")) console.log(args.includes("lane-selected")?"unix:///selected.sock":"unix:///default.sock");',
      'else if(args.includes("info")) console.log("selected-daemon");',
      'else if(args.includes("image")) {if(args.at(-1)===' + JSON.stringify(missingImage ?? null) + ')process.exit(1);if(args.some(arg=>arg.includes("json .")))console.log(JSON.stringify({Id:"sha256:"+"a".repeat(64),Config:{Labels:' +
        JSON.stringify(label === null ? {} : { "dev.catalystcloud.runner.darwin-thoughts-custody": label }) +
        '}}));else console.log("sha256:"+"a".repeat(64));}',
      'else process.exit(1);',
    ].join("\n");
    fs.writeFileSync(executable, source, { mode: 0o700, flag: "wx" });
    const hash = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const input = {
      principal: { platform: "darwin", uid: 501, euid: 501, gid: 20, home },
      nodeExecutable: fs.realpathSync(process.execPath), dockerExecutable: executable,
      supervisorImage: "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "a".repeat(64),
      runnerImage: "ghcr.io/coalesce-labs/catalyst-runner@sha256:" + "b".repeat(64),
      deadlineMs: Date.now() + 10000,
    };
    return { log, input };
  }
  it("positive control default context is actually inspected and both images remain cache-only", async () => {
    const f = fixture(); expect(await inspectDarwinThoughtsEngineForTest(f.input)).toMatchObject({
      endpoint: "unix:///default.sock", cachedSupervisor: true, cachedRunner: true,
    });
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(4);
    expect(calls.every(call => !call.includes("pull"))).toBe(true);
    expect(calls.filter(call => call.includes("image"))).toHaveLength(2);
  });
  it("uses explicit DOCKER_CONTEXT rather than attesting the default Engine", async () => {
    const f = fixture(); process.env.DOCKER_CONTEXT = "lane-selected";
    expect(await inspectDarwinThoughtsEngineForTest(f.input)).toHaveProperty("endpoint", "unix:///selected.sock");
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls[0]).toContain("lane-selected");
    expect(calls.slice(1).every(call => call.includes("unix:///selected.sock"))).toBe(true);
  });
  it("receives the runtime and enrolled helper caches separately on the same selected Engine", async () => {
    const f = fixture(); process.env.DOCKER_CONTEXT = "lane-selected";
    const producerSupervisorImage = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "c".repeat(64);
    expect(await inspectDarwinThoughtsEngineForTest({ ...f.input, producerSupervisorImage })).toMatchObject({
      endpoint: "unix:///selected.sock", cachedSupervisor: true, cachedProducerSupervisor: true, cachedRunner: true,
    });
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(5);
    expect(calls.filter(call => call.includes("image")).map(call => call.at(-1)))
      .toEqual([f.input.supervisorImage, producerSupervisorImage, f.input.runnerImage]);
    expect(calls.slice(1).every(call => call.includes("unix:///selected.sock"))).toBe(true);
    expect(calls.every(call => !call.includes("pull"))).toBe(true);
  });
  it("does not substitute the cached runtime image for an uncached enrolled helper", async () => {
    const producerSupervisorImage = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "c".repeat(64);
    const f = fixture("v1", producerSupervisorImage);
    expect(await inspectDarwinThoughtsEngineForTest({ ...f.input, producerSupervisorImage })).toMatchObject({
      cachedSupervisor: true, cachedProducerSupervisor: false, cachedRunner: true,
    });
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls.some(call => call.includes("image") && call.at(-1) === producerSupervisorImage)).toBe(true);
    expect(calls.every(call => !call.includes("pull"))).toBe(true);
  });
  it("refuses conflicting HOST/CONTEXT before any executable work", async () => {
    const f = fixture(); process.env.DOCKER_CONTEXT = "lane-selected"; process.env.DOCKER_HOST = "unix:///other.sock";
    await expect(inspectDarwinThoughtsEngineForTest(f.input)).rejects.toThrow(/conflict|selector/);
    expect(fs.existsSync(f.log)).toBe(false);
  });
  it("receives the exact custody label from cached runner metadata", async () => {
    const f = fixture();
    expect(await inspectDarwinThoughtsEngineForTest(f.input)).toHaveProperty("runnerCustodyVersion", "v1");
  });
  it.each([null, "v2"])("receives an absent or different cached runner label without inventing v1: %s", async (label) => {
    const f = fixture(label);
    expect((await inspectDarwinThoughtsEngineForTest(f.input)).runnerCustodyVersion).not.toBe("v1");
  });
  it("accepts only the native standard state layout", () => {
    expect(() => validateDarwinThoughtsInstallLayoutForTest(home, join(home, ".local", "state", "catalyst", "runner"))).not.toThrow();
  });
  it("refuses custom runner state inside a broader generation workspace", () => {
    expect(() => validateDarwinThoughtsInstallLayoutForTest(home, join(home, "repos", "generation-workspace", "state", "runner"))).toThrow(/layout|workspace|path/);
  });
});
