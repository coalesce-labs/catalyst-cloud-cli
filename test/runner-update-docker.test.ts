import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerRunnerEngine, type RunnerExec } from "../src/onboard-runner";
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

  it("CTC-6924: a report rides into the container as one environment value, and none without a report", async () => {
    const answer = { code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: { ok: true }, hostId: HOST }) };
    const { exec, calls } = scripted((args) => (has(args, "run", "--rm", "supervisor") ? answer : undefined));
    const engine = dockerRunnerUpdateEngine({ exec, env: {} });
    await engine.desiredRelease(install(), undefined, '{"v":1}');
    await engine.desiredRelease(install());
    const [withReport, without] = calls;
    expect(withReport!.slice(withReport!.indexOf("-e"), withReport!.indexOf("-e") + 2)).toEqual(["-e", 'CATALYST_UPDATE_REPORT={"v":1}']);
    expect(withReport!.indexOf("-e")).toBeLessThan(withReport!.indexOf("supervisor"));
    expect(without!.filter((a) => a.startsWith("CATALYST_UPDATE_REPORT="))).toEqual([]);
  });

  it("a fresh read uses the same one-off supervisor command", async () => {
    const answer = { code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: { ok: true }, hostId: HOST }) };
    const { exec, calls } = scripted(() => answer);
    const engine = dockerRunnerUpdateEngine({ exec, env: {} });
    const dir = install();
    await engine.desiredRelease(dir, undefined, undefined, true);
    await engine.desiredRelease(dir);
    expect(calls[0]).toEqual(calls[1]);
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

describe("updateDrain runs one supervisor container with the body as one environment value", () => {
  const response = { code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: { ok: true }, hostId: HOST }) };
  it("GET has no request environment variable", async () => {
    const { exec, calls } = scripted(() => response);
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).updateDrain(install(), null)).toMatchObject({ kind: "answered", status: 200 });
    expect(calls[0]).toEqual(expect.arrayContaining(["run", "--rm", "-T", "--no-deps", "--entrypoint", "bun", "supervisor", "-e"]));
    expect(calls[0]?.some((arg) => arg.startsWith("CATALYST_UPDATE_DRAIN_BODY="))).toBe(false);
  });

  it("POST passes the exact request JSON before the supervisor name", async () => {
    const { exec, calls } = scripted(() => response);
    const request = { action: "request" as const, requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", expectedRevision: 0, generation: 106 };
    await dockerRunnerUpdateEngine({ exec, env: {} }).updateDrain(install(), request);
    const args = calls[0]!;
    expect(args).toContain(`CATALYST_UPDATE_DRAIN_BODY=${JSON.stringify(request)}`);
    expect(args.indexOf(`CATALYST_UPDATE_DRAIN_BODY=${JSON.stringify(request)}`)).toBeLessThan(args.indexOf("supervisor"));
  });

  it.each([
    ["container failure", { code: 1, stdout: "" }],
    ["non-JSON", { code: 0, stdout: "not json" }],
    ["malformed host id", { code: 0, stdout: JSON.stringify({ kind: "answered", status: 200, body: null, hostId: "bad host" }) }],
    ["unknown kind", { code: 0, stdout: JSON.stringify({ kind: "else" }) }],
  ])("%s returns no_credential", async (_label, answer) => {
    const { exec } = scripted(() => answer);
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).updateDrain(install(), null)).toEqual({ kind: "no_credential" });
  });
});

describe("attemptContainers counts this host's phase containers", () => {
  it("counts listed ids, filtered by this host's label", async () => {
    const { exec, calls } = scripted((args) => (has(args, "ps", "--all") ? { code: 0, stdout: "abc\ndef\n\n" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).attemptContainers(install(), HOST)).toBe(2);
    expect(calls[0]).toContain(`label=dev.catalystcloud.attempt.host-id=${HOST}`);
    expect(calls[0]).toContain("--format");
  });

  it("counts each phase attempt once even with more than one container", async () => {
    const { exec } = scripted((args) => (has(args, "ps", "--all") ? { code: 0, stdout: "abc\tatt-1\ndef\tatt-1\nghi\t\n" } : undefined));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).attemptContainers(install(), HOST)).toBe(2);
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
    // CTC-8745: the same read, for whether only a preparation stop is failing.
    const stopped = '{"event":"host_not_ready","linePerChange":true,"failing":[{"id":"host.preparation-failed","reason":"failed","remedy":"workspace_unavailable"}]}';
    expect(await dockerRunnerUpdateEngine({ exec: answer(stopped).exec, env: {} }).supervisorInPreparationStop(install())).toBe(true);
    expect(await dockerRunnerUpdateEngine({ exec: answer('{"event":"supervisor_started"}').exec, env: {} }).supervisorInPreparationStop(install())).toBe(false);
    expect(await dockerRunnerUpdateEngine({ exec: missing.exec, env: {} }).supervisorInPreparationStop(install())).toBe(false);
  });

  it("removeImages removes each replaced image by its digest reference", async () => {
    const { exec, calls } = scripted(() => ({ code: 0, stdout: "" }));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).removeImages([REF, `${REF}x`])).toEqual([]);
    expect(calls).toEqual([["image", "rm", REF], ["image", "rm", `${REF}x`]]);
  });

  it("removeImages returns an image Docker refused while it is still present, and not one already gone", async () => {
    const used = `${REF}used`;
    const gone = `${REF}gone`;
    const { exec } = scripted((args) => {
      if (args[1] === "rm") return { code: 1, stdout: "" };
      if (args.includes(used)) return { code: 0, stdout: "sha256:abc\n" };
      if (args.includes(gone)) return { code: 1, stdout: "", stderr: `Error response from daemon: No such image: ${gone}` };
      return undefined;
    });
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).removeImages([used, gone])).toEqual([used]);
  });

  it("removeImages keeps an image when Docker does not answer, so a later run tries again", async () => {
    const { exec } = scripted(() => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }));
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).removeImages([REF])).toEqual([REF]);
    const thrown: RunnerExec = async () => { throw new Error("spawn docker ENOENT"); };
    expect(await dockerRunnerUpdateEngine({ exec: thrown, env: {} }).removeImages([REF])).toEqual([REF]);
  });

  it("a thrown docker command is a failure, never an exception", async () => {
    const exec: RunnerExec = async () => { throw new Error("spawn docker ENOENT"); };
    const engine = dockerRunnerUpdateEngine({ exec, env: {} });
    expect(await engine.stopSupervisor(install())).toBe(false);
    expect(await engine.attemptContainers(install(), HOST)).toBeNull();
  });
});

describe("custody records only the installer's fixed refusal reasons", () => {
  const images = { runner: REF, supervisor: REF, watchdog: REF };
  const exec: RunnerExec = async () => ({ code: 1, stdout: "", stderr: "" });

  it("an installer refusal answers the installer's own reason", async () => {
    // An aborted signal makes the real installer refuse before it touches the machine.
    const aborted = AbortSignal.abort();
    expect(await dockerRunnerUpdateEngine({ exec, env: {} }).custody(install(), images, aborted)).toEqual({ refused: "installation_cancelled" });
  });

  it("NEGATIVE: any other exception is unclassified, and its text never reaches the answer", async () => {
    const setup = { ...dockerRunnerEngine({ exec, env: {} }), nativeThoughtsCustody: async () => { throw new Error("token=secret"); } };
    const answer = await dockerRunnerUpdateEngine({ exec, env: {}, setup }).custody(install(), images);
    expect(answer).toEqual({ refused: "unclassified" });
    expect(JSON.stringify(answer)).not.toContain("secret");
  });

  it("NEGATIVE: a setup engine without the custody step answers capability_missing", async () => {
    const setup = { ...dockerRunnerEngine({ exec, env: {} }), nativeThoughtsCustody: undefined };
    expect(await dockerRunnerUpdateEngine({ exec, env: {}, setup }).custody(install(), images)).toEqual({ refused: "capability_missing" });
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

  it.each([
    ["draining_for_update", "Phases are running here, so Catalyst sends this machine no new ones until they finish. Then it moves to the approved release."],
    ["drain_soft_limit", "Phases have run here for over 2 hours since Catalyst stopped sending new ones. They keep running, and the update still waits for them."],
    ["drain_unavailable", "A phase is running here and Catalyst could not be asked to stop sending new ones, so the update waits for the next check."],
  ] as const)("%s has the planned operator-facing text", (outcome, line) => {
    expect(updateResultLines({ outcome, detail: "phases_running:2", generation: 102, offeredGeneration: 106, exitCode: 0 })[0]).toBe(line);
  });
});
