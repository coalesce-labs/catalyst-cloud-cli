import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerExec } from "../src/onboard-runner";
import { dockerRunnerUpdateEngine, runnerDir, updateResultLines } from "../src/runner-update";

// The docker-backed engine, driven through a scripted `docker` command: each test answers the exact
// argv the engine sends, so what it parses, and what it refuses, is the engine's own code.

type Answer = { code: number; stdout: string; stderr?: string };
function scripted(answer: (args: string[]) => Answer | undefined) {
  const calls: string[][] = [];
  const exec: RunnerExec = async (args) => {
    calls.push(args);
    return answer(args) ?? { code: 1, stdout: "" };
  };
  return { exec, calls };
}
const has = (args: string[], ...parts: string[]) => parts.every((p) => args.includes(p));

function install(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-docker-"));
  writeFileSync(join(dir, ".env"), "CATALYST_SLOTS=1\n", { mode: 0o600 });
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  return dir;
}
const HOST = "host_21b9e3400316b3736ccd248fd66e46a2";
const ID = "a".repeat(64);
const REF = `ghcr.io/coalesce-labs/catalyst-runner@sha256:${"1".repeat(64)}`;

describe("desiredRelease reads the container's one JSON line and nothing else", () => {
  const read = async (answer: Answer) => {
    const { exec, calls } = scripted((args) => (has(args, "run", "--rm", "supervisor") ? answer : undefined));
    const result = await dockerRunnerUpdateEngine({ exec, env: {} }).desiredRelease(install());
    return { result, calls };
  };

  it("POSITIVE CONTROL: an answered read keeps status, body and host id, from a one-off supervisor container", async () => {
    const { result, calls } = await read({ code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: { ok: true }, hostId: HOST }) });
    expect(result).toEqual({ kind: "answered", status: 200, body: { ok: true }, hostId: HOST });
    expect(calls[0]).toEqual(expect.arrayContaining(["--project-name", "catalyst-host", "run", "--rm", "-T", "--no-deps", "--entrypoint", "bun", "supervisor"]));
  });

  it("an unreachable read keeps a short detail", async () => {
    const { result } = await read({ code: 0, stdout: JSON.stringify({ kind: "unreachable", detail: "x".repeat(200), hostId: HOST }) });
    expect(result).toEqual({ kind: "unreachable", detail: "x".repeat(80), hostId: HOST });
  });

  it.each([
    ["the container failed", { code: 1, stdout: "" }],
    ["the output is not JSON", { code: 0, stdout: "not json" }],
    ["the output is not an object", { code: 0, stdout: "[1]" }],
    ["the host id is malformed", { code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: null, hostId: "bad host" }) }],
    ["the kind is unknown", { code: 0, stdout: JSON.stringify({ kind: "no_credential" }) }],
  ])("NEGATIVE: %s → no_credential", async (_label, answer) => {
    expect((await read(answer)).result).toEqual({ kind: "no_credential" });
  });
});

describe("attemptContainers counts this host's phase containers", () => {
  it("counts listed ids, filtered by this host's label", async () => {
    const { exec, calls } = scripted((args) => (has(args, "ps", "--all", "--quiet") ? { code: 0, stdout: "abc\ndef\n\n" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).attemptContainers(install(), HOST)).toBe(2);
    expect(calls[0]).toContain(`label=dev.catalystcloud.attempt.host-id=${HOST}`);
  });

  it("an unreadable listing or a malformed host id is null, never zero", async () => {
    const { exec, calls } = scripted(() => ({ code: 1, stdout: "" }));
    const engine = dockerRunnerUpdateEngine({ exec, env: {} });
    expect(await engine.attemptContainers(install(), HOST)).toBeNull();
    expect(await engine.attemptContainers(install(), "bad host")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("prepare pulls natively, through the setup engine's own checks", () => {
  const info = { code: 0, stdout: JSON.stringify({ Architecture: "aarch64", OSType: "linux", OperatingSystem: "Ubuntu" }) };
  const cached = (arch: string) => ({ code: 0, stdout: JSON.stringify([{ Id: `sha256:${ID}`, Os: "linux", Architecture: arch, RepoDigests: [REF] }]) });
  const engineWith = (answer: (args: string[]) => Answer | undefined) =>
    dockerRunnerUpdateEngine({ exec: scripted(answer).exec, env: {} });
  const base = (args: string[]): Answer | undefined =>
    has(args, "info") ? info : has(args, "compose", "version") ? { code: 0, stdout: "v2" } : has(args, "context", "inspect") ? { code: 0, stdout: "unix:///var/run/docker.sock" } : undefined;

  it("POSITIVE CONTROL: a cached native image is ready", async () => {
    expect(await engineWith((a) => base(a) ?? (has(a, "image", "inspect") ? cached("arm64") : undefined)).prepare([REF])).toBeNull();
  });

  it("an image built for another architecture is refused by name", async () => {
    expect(await engineWith((a) => base(a) ?? (has(a, "image", "inspect") ? cached("amd64") : undefined)).prepare([REF])).toBe(`runner_image_emulated:${REF}`);
  });

  it("an image that is neither cached nor pullable is unavailable", async () => {
    expect(await engineWith(base).prepare([REF])).toBe(`runner_images_unavailable:${REF}`);
  });

  it("no reachable Docker is docker_unavailable", async () => {
    expect(await engineWith(() => undefined).prepare([REF])).toBe("docker_unavailable");
  });
});

describe("services, stop, readiness and cleanup", () => {
  const started = "2026-10-17T13:31:14.610922962Z";
  it("POSITIVE CONTROL: reads both services' running state, image and start time", async () => {
    const { exec } = scripted((args) => {
      if (has(args, "ps", "--all", "--quiet", "supervisor")) return { code: 0, stdout: `${ID}\n` };
      if (has(args, "ps", "--all", "--quiet", "deadline-watchdog")) return { code: 0, stdout: `${"b".repeat(64)}\n` };
      if (has(args, "inspect")) return { code: 0, stdout: `true|${REF}|${started}\n` };
      return undefined;
    });
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).services(install())).toEqual({
      supervisor: { running: true, image: REF, startedAtMs: Date.parse(started) },
      watchdog: { running: true, image: REF, startedAtMs: Date.parse(started) },
    });
  });

  it("a service with no container is null; an unreadable one makes the whole read null", async () => {
    const empty = scripted((args) => (has(args, "ps") ? { code: 0, stdout: "\n" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec: empty.exec, env: {} }).services(install())).toEqual({ supervisor: null, watchdog: null });
    const odd = scripted((args) => (has(args, "ps") ? { code: 0, stdout: "not-an-id\n" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec: odd.exec, env: {} }).services(install())).toBeNull();
    const failed = scripted(() => ({ code: 1, stdout: "" }));
    expect(await dockerRunnerUpdateEngine({ exec: failed.exec, env: {} }).services(install())).toBeNull();
  });

  it("stopSupervisor stops only the supervisor service", async () => {
    const { exec, calls } = scripted((args) => (has(args, "stop", "supervisor") ? { code: 0, stdout: "" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).stopSupervisor(install())).toBe(true);
    expect(calls[0]?.slice(-2)).toEqual(["stop", "supervisor"]);
  });

  it("readiness needs host_ready in the logs since the container last started", async () => {
    const answer = (logs: string) => scripted((args) => {
      if (has(args, "ps", "--quiet", "supervisor")) return { code: 0, stdout: `${ID}\n` };
      if (has(args, "inspect")) return { code: 0, stdout: `${started}\n` };
      if (has(args, "logs", "--since", started)) return { code: 0, stdout: logs };
      return undefined;
    });
    expect(await dockerRunnerUpdateEngine({ exec: answer('{"event":"host_ready","freeSlots":1}').exec, env: {} }).supervisorReadySinceStart(install())).toBe(true);
    expect(await dockerRunnerUpdateEngine({ exec: answer('{"event":"supervisor_started"}').exec, env: {} }).supervisorReadySinceStart(install())).toBe(false);
    const missing = scripted(() => ({ code: 0, stdout: "\n" }));
    expect(await dockerRunnerUpdateEngine({ exec: missing.exec, env: {} }).supervisorReadySinceStart(install())).toBe(false);
  });

  it("removeImages removes each replaced image by its digest reference", async () => {
    const { exec, calls } = scripted(() => ({ code: 0, stdout: "" }));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).removeImages([REF, `${REF}x`])).toEqual([]);
    expect(calls).toEqual([["image", "rm", REF], ["image", "rm", `${REF}x`]]);
  });

  it("removeImages returns an image Docker refused while it is still present, and not one already gone", async () => {
    const used = `${REF}used`;
    const { exec } = scripted((args) => {
      if (args[1] === "rm") return { code: 1, stdout: "" };
      return args.includes(used) ? { code: 0, stdout: "sha256:abc\n" } : { code: 1, stdout: "" };
    });
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).removeImages([used, `${REF}gone`])).toEqual([used]);
  });

  it("a thrown docker command is a failure, never an exception", async () => {
    const exec: RunnerExec = async () => { throw new Error("spawn docker ENOENT"); };
    const engine = dockerRunnerUpdateEngine({ exec, env: {} });
    expect(await engine.stopSupervisor(install())).toBe(false);
    expect(await engine.attemptContainers(install(), HOST)).toBeNull();
  });
});

describe("helpers", () => {
  it("runnerDir is the runner folder under the setup state directory", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    expect(runnerDir({ home, env: {} })).toBe(join(home, ".local", "state", "catalyst", "runner"));
  });

  it("updateResultLines says the outcome and the release in plain words", () => {
    expect(updateResultLines({ outcome: "updated", detail: "updated:runner", generation: 2, releaseId: "hr-x", exitCode: 0 }))
      .toEqual(["The runner moved to the approved release.", "Release: hr-x, generation 2 (updated:runner)."]);
    expect(updateResultLines({ outcome: "retained", detail: "release_unavailable", generation: null, exitCode: 0 })[1])
      .toBe("Release: none, generation none (release_unavailable).");
  });
});
