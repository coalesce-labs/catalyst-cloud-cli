import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runnerMountProbe, runnerNetworkProbe, runnerVmCapabilities } from "../src/onboard-runner-probes.js";
import type { RunnerExec, RunnerExecOptions } from "../src/onboard-runner.js";

const homes: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function endpoint(code = 200, body = "ok", redirect = false) {
  const server = createServer((_request, response) => {
    response.writeHead(code, redirect ? { location: "/elsewhere" } : {}); response.end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture listener missing");
  return `http://127.0.0.1:${address.port}`;
}
function program(script: string): ReturnType<RunnerExec> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.RUNNER_JS_TEST_RUNTIME ?? process.execPath, ["-e", script],
      { timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "runner-vm-probes-")); homes.push(home);
  const paths = ["slots", "thoughts", "locks"].map(sub => join(home, sub));
  for (const path of paths) { mkdirSync(path); writeFileSync(join(path, "custom"), "keep"); }
  const runs: Array<{ args: string[]; options: RunnerExecOptions }> = [];
  const exec: RunnerExec = async (args, options) => {
    runs.push({ args, options });
    if (args[0] === "rm") return { code: 0, stdout: "" };
    return program(args[args.indexOf("-e") + 1]!);
  };
  return { paths, runs, exec };
}
const image = `ghcr.io/example/supervisor@sha256:${"a".repeat(64)}`;

test("actual probe programs round-trip all mounts and reach the host and network without Docker", async () => {
  const f = fixture();
  expect(await runnerVmCapabilities({ ...f, image, baseUrl: await endpoint(), env: {},
    hostAddresses: ["127.0.0.1", "127.0.0.1"] })).toBe("ready");
  const runs = f.runs.filter(row => row.args[0] === "run");
  expect(runs).toHaveLength(2);
  expect(runs[0]!.args).toEqual(expect.arrayContaining([
    "--rm", "--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--user", "10001:10001", "--entrypoint", "bun", image,
  ]));
  expect(runs[0]!.args.filter(arg => arg === "--mount")).toHaveLength(3);
  expect(runs[1]!.args).not.toContain("--mount");
  const names = runs.map(row => row.args[row.args.indexOf("--name") + 1]);
  expect(new Set(names).size).toBe(2);
  expect(f.runs.filter(row => row.args[0] === "rm").map(row => row.args))
    .toEqual(names.map(name => ["rm", "--force", name]));
  expect(f.runs.every(row => row.options.timeoutMs! <= 35_000)).toBe(true);
  for (const path of f.paths) {
    expect(readdirSync(path)).toEqual(["custom"]);
    expect(readFileSync(join(path, "custom"), "utf8")).toBe("keep");
  }
});

test("a container success marker without a host-side write cannot pass the mount probe", async () => {
  const f = fixture();
  const exec: RunnerExec = async args => {
    if (args[0] === "rm") return { code: 0, stdout: "" };
    const mount = args[args.indexOf("--mount") + 1]!;
    const path = /src=(.*),dst=/.exec(mount)![1]!;
    return { code: 0, stdout: readFileSync(join(path, "challenge"), "utf8") };
  };
  expect(await runnerVmCapabilities({ ...f, exec, image, baseUrl: "https://example.test", env: {} }))
    .toBe("runner_home_mount_unwritable");
  expect(f.paths.every(path => readdirSync(path).join() === "custom")).toBe(true);
});

test.each([41, 125])("an unwritable or unavailable bind mount (exit %s) stops before network", async code => {
  const f = fixture();
  const exec: RunnerExec = async (args, options) => {
    f.runs.push({ args, options }); return { code: args[0] === "run" ? code : 0, stdout: "" };
  };
  expect(await runnerVmCapabilities({ ...f, exec, image, baseUrl: "https://example.test", env: {} }))
    .toBe("runner_home_mount_unwritable");
  expect(f.runs.filter(row => row.args[0] === "run")).toHaveLength(1);
});

test("a mismatching container challenge refuses a mount", async () => {
  const f = fixture();
  const path = f.paths[0]!; writeFileSync(join(path, "challenge"), "other");
  expect((await program(runnerMountProbe([path], "expected"))).code).toBe(41);
  expect(readdirSync(path).sort()).toEqual(["challenge", "custom"]);
});

test("mount directory failures are precise and retain existing files", async () => {
  const f = fixture();
  expect(await runnerVmCapabilities({ ...f, paths: [join(f.paths[0]!, "absent")], image,
    baseUrl: "https://example.test", env: {} })).toBe("runner_home_mount_unwritable");
  expect(f.runs).toEqual([]);
});

test("no reachable host refuses precisely, after a positive mount control", async () => {
  const f = fixture();
  expect(await runnerVmCapabilities({ ...f, image, baseUrl: await endpoint(), env: {}, hostAddresses: [] }))
    .toBe("runner_container_host_unreachable");
  expect(f.runs.filter(row => row.args[0] === "run")).toHaveLength(2);
});

test.each(["wrong challenge", "HTTP error", "redirect", "connection refused"])
  ("the actual host reach program rejects %s", async kind => {
    const url = kind === "connection refused" ? "http://127.0.0.1:1" :
      await endpoint(kind === "HTTP error" ? 503 : kind === "redirect" ? 302 : 200, "other", kind === "redirect");
    expect((await program(runnerNetworkProbe([url], await endpoint(), "expected"))).code).toBe(42);
  });

test.each(["HTTP error", "connection refused", "redirect"])("network %s has its own refusal", async kind => {
  const f = fixture();
  const baseUrl = kind === "connection refused" ? "http://127.0.0.1:1" :
    await endpoint(kind === "redirect" ? 302 : 503, "other", kind === "redirect");
  expect(await runnerVmCapabilities({ ...f, image, baseUrl, env: {}, hostAddresses: ["127.0.0.1"] }))
    .toBe("runner_container_network_unreachable");
});

test.each(["aborted", "empty paths"])("%s does not launch a probe", async kind => {
  const f = fixture();
  expect(await runnerVmCapabilities({ ...f, image, baseUrl: "https://example.test", env: {},
    ...(kind === "aborted" ? { signal: AbortSignal.abort() } : { paths: [] }) }))
    .toBe("runner_engine_probe_unavailable");
  expect(f.runs).toEqual([]);
});

test.each(["bad exit", "empty stdout", "exec throws"])("network probe %s fails closed and removes its exact container", async kind => {
  const f = fixture();
  const controller = new AbortController();
  const exec: RunnerExec = async (args, options) => {
    if (args[0] === "run" && !args.includes("--mount")) {
      f.runs.push({ args, options }); controller.abort();
      if (kind === "exec throws") throw Error("client timeout");
      return { code: kind === "bad exit" ? 44 : 0, stdout: "" };
    }
    return f.exec(args, options);
  };
  expect(await runnerVmCapabilities({ ...f, exec, image, baseUrl: await endpoint(), env: {},
    signal: controller.signal, hostAddresses: ["127.0.0.1"] })).toBe("runner_engine_probe_unavailable");
  const cleanup = f.runs.filter(row => row.args[0] === "rm");
  expect(cleanup).toHaveLength(2);
  expect(cleanup.every(row => row.options.signal === undefined && row.options.timeoutMs === 10_000)).toBe(true);
  expect(f.paths.every(path => readdirSync(path).join() === "custom")).toBe(true);
});
