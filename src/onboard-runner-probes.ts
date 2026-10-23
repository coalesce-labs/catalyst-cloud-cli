import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { RunnerExec, RunnerExecOptions } from "./onboard-runner.js";

export type RunnerVmCapability = "ready" | "runner_home_mount_unwritable" |
  "runner_container_host_unreachable" | "runner_container_network_unreachable" |
  "runner_engine_probe_unavailable";

/** Runs as the supervisor's uid. A matching engine-side path is insufficient: both sides must
 * read the fresh challenge, including a container write returned through the host mount. */
export function runnerMountProbe(paths: string[], challenge: string): string {
  return `const fs=require("node:fs");
    try { for (const path of ${JSON.stringify(paths)}) {
      if (fs.readFileSync(path+"/challenge","utf8")!==${JSON.stringify(challenge)}) process.exit(41);
      fs.writeFileSync(path+"/pending",${JSON.stringify(challenge)},{mode:0o600,flag:"wx"});
      fs.renameSync(path+"/pending",path+"/received");
    } console.log(${JSON.stringify(challenge)}); } catch { process.exit(41); }`;
}

/** Contains no credentials. Host reach requires our exact fresh challenge response; public
 * reach checks the configured Catalyst endpoint. Each request and the program have deadlines. */
export function runnerNetworkProbe(hostUrls: string[], networkUrl: string, challenge: string): string {
  return `(async()=>{
    const deadline=setTimeout(()=>process.exit(44),20000);
    try {
      const hostStop=new AbortController();
      try { await Promise.any(${JSON.stringify(hostUrls)}.map(async url=>{
        const response=await fetch(url,{redirect:"error",
          signal:AbortSignal.any([hostStop.signal,AbortSignal.timeout(12000)])});
        if(!response.ok || await response.text()!==${JSON.stringify(challenge)}) throw Error("host");
      })); } catch { process.exit(42); }
      finally { hostStop.abort(); }
      try { const response=await fetch(${JSON.stringify(networkUrl)},
          {redirect:"error",signal:AbortSignal.timeout(5000)});
        if(!response.ok) process.exit(43);
        await response.body?.cancel();
      } catch { process.exit(43); }
      console.log(${JSON.stringify(challenge)});
    } finally { clearTimeout(deadline); }
  })().catch(()=>process.exit(44));`;
}

export async function runnerVmCapabilities(input: {
  paths: string[];
  image: string;
  baseUrl: string;
  exec: RunnerExec;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Injection for daemon-free tests; production uses the host alias and this Mac's addresses. */
  hostAddresses?: string[];
}): Promise<RunnerVmCapability> {
  const challenge = randomUUID();
  const scratch: string[] = [];
  const options: RunnerExecOptions = { env: input.env, signal: input.signal, timeoutMs: 35_000 };
  async function run(program: string, mounts: string[] = []) {
    const name = `catalyst-engine-probe-${randomUUID()}`;
    try {
      return await input.exec(["run", "--rm", "--name", name, "--pull=never", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user", "10001:10001",
        "--tmpfs", "/tmp:size=16m,mode=1777", ...mounts.flatMap(path =>
          ["--mount", `type=bind,src=${path},dst=${path}`]),
        "--entrypoint", "bun", input.image, "-e", program], options);
    } finally {
      // Killing a docker client does not stop its container. Clean up only our fresh exact name,
      // even on abort, with an independent short deadline. Never touch any existing container.
      const removed = await input.exec(["rm", "--force", name], { env: input.env, timeoutMs: 10_000 });
      if (removed.code !== 0 && ![
        `Error response from daemon: No such container: ${name}`, `Error: No such container: ${name}`,
      ].includes(removed.stderr?.trim() ?? "")) throw Error("probe_cleanup_unverified");
    }
  }
  try {
    if (input.paths.length === 0 || input.signal?.aborted) return "runner_engine_probe_unavailable";
    try {
      for (const path of input.paths) {
        const dir = mkdtempSync(join(path, ".catalyst-engine-probe-"));
        scratch.push(dir);
        writeFileSync(join(dir, "challenge"), challenge, { mode: 0o600, flag: "wx" });
      }
      const mounted = await run(runnerMountProbe(scratch, challenge), scratch);
      if (mounted.code !== 0 || mounted.stdout.trim() !== challenge ||
          scratch.some(path => readFileSync(join(path, "received"), "utf8") !== challenge))
        return "runner_home_mount_unwritable";
    } catch { return "runner_home_mount_unwritable"; }

    const server = createServer((request, response) => {
      const matches = request.method === "GET" && request.url === `/${challenge}`;
      response.writeHead(matches ? 200 : 404, { "content-type": "text/plain", "connection": "close" });
      response.end(matches ? challenge : "");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "0.0.0.0", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") return "runner_engine_probe_unavailable";
      const hosts = input.hostAddresses ?? ["host.docker.internal", ...Object.values(networkInterfaces())
        .flatMap(rows => rows ?? []).filter(row => row.family === "IPv4" && !row.internal)
        .map(row => row.address)];
      const urls = [...new Set(hosts)].slice(0, 16)
        .map(host => `http://${host}:${address.port}/${challenge}`);
      const result = await run(runnerNetworkProbe(urls, new URL("/healthz", input.baseUrl).href, challenge));
      if (result.code === 42) return "runner_container_host_unreachable";
      if (result.code === 43) return "runner_container_network_unreachable";
      return result.code === 0 && result.stdout.trim() === challenge ? "ready" : "runner_engine_probe_unavailable";
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } catch { return "runner_engine_probe_unavailable"; }
  finally { for (const path of scratch) rmSync(path, { recursive: true, force: true }); }
}
