import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { packageRoot } from "../src/config.js";
import { onboardReasonText } from "../src/onboard-next.js";
import {
  HOST_DISK_LABEL,
  HOST_DISK_SAMPLE_FILE,
  engineDiskPath,
  foreignHostDiskSample,
  hostDiskSamplerStatus,
  installHostDiskSampler,
  runnerDiskCopy,
  runnerDiskVerdict,
  type SamplerRun,
} from "../src/onboard-runner-disk.js";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const GIB = 1024 ** 3;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function temp(): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "runner-disk-"));
  homes.push(home);
  return home;
}
const sample = (availableGiB: number, observedAtMs = NOW) =>
  JSON.stringify({ schemaVersion: 1, path: "/Users/a", observedAtMs, availableBytes: Math.round(availableGiB * GIB), totalBytes: 500 * GIB });

describe("the runner's disk verdict mirrors the supervisor's admission", () => {
  const saved = { CATALYST_HOST_DISK_SAMPLE_FILE: HOST_DISK_SAMPLE_FILE };

  test("a VM engine with no sample file is unmeasured, never measured through the VM", () => {
    expect(runnerDiskVerdict({ dir: "/r", saved: {}, vm: true, nowMs: NOW, nativeAvailableBytes: () => 900 * GIB }))
      .toEqual({ state: "unmeasured", detail: "physical_host_disk_sample_required", floorGiB: 25 });
  });

  test("a fresh sample reads from the install's host-disk bind", () => {
    const read: string[] = [];
    const verdict = runnerDiskVerdict({ dir: "/r", saved, vm: true, nowMs: NOW,
      readSample: (path) => { read.push(path); return sample(80); } });
    expect(read).toEqual(["/r/host-disk/space.json"]);
    expect(verdict).toEqual({ state: "measured", availableGiB: 80, floorGiB: 25 });
  });

  test("an operator's sample directory and floor are honoured", () => {
    const read: string[] = [];
    const verdict = runnerDiskVerdict({ dir: "/r", vm: true, nowMs: NOW,
      saved: { ...saved, CATALYST_HOST_DISK_SAMPLE_DIR: "/Users/a/samples", CATALYST_HOST_FREE_FLOOR_GIB: "45" },
      readSample: (path) => { read.push(path); return sample(40); } });
    expect(read).toEqual(["/Users/a/samples/space.json"]);
    expect(verdict).toEqual({ state: "below_floor", availableGiB: 40, floorGiB: 45 });
  });

  test.each([
    ["missing", () => { throw new Error("ENOENT"); }, "host_disk_sample_missing"],
    ["older than 30 seconds", () => sample(80, NOW - 30_001), "host_disk_sample_stale"],
    ["from the future", () => sample(80, NOW + 5_001), "host_disk_sample_stale"],
    ["malformed", () => "{", "host_disk_sample_invalid"],
  ])("a sample that is %s is unmeasured", (_name, readSample, detail) => {
    expect(runnerDiskVerdict({ dir: "/r", saved, vm: true, nowMs: NOW, readSample }))
      .toMatchObject({ state: "unmeasured", detail });
  });

  test("native Linux measures Docker's data root against the 25 GiB floor", () => {
    expect(runnerDiskVerdict({ dir: "/r", saved: {}, vm: false, nowMs: NOW, nativeAvailableBytes: () => Math.ceil(15.62 * GIB) }))
      .toEqual({ state: "below_floor", availableGiB: 15.62, floorGiB: 25 });
    expect(runnerDiskVerdict({ dir: "/r", saved: {}, vm: false, nowMs: NOW, nativeAvailableBytes: () => null }))
      .toMatchObject({ state: "unmeasured", detail: "host_disk_unreadable" });
  });

  test("the copy names the numbers and the fix", () => {
    const low = runnerDiskCopy({ state: "below_floor", availableGiB: 15.62, floorGiB: 25 }, false);
    expect(low.line).toContain("15.62 GiB of disk is free and it needs 25 GiB");
    expect(low.fix).toContain("Docker's data");
    const mac = runnerDiskCopy({ state: "unmeasured", detail: "host_disk_sample_stale", floorGiB: 25 }, true);
    expect(mac.line).toContain("more than 30 seconds old");
    expect(mac.fix).toContain("catalyst setup --runner");
    for (const text of [low.line, low.fix, mac.line, mac.fix]) expect(text).not.toContain("—");
  });
});

describe("the Mac's host-disk LaunchAgent", () => {
  /** A fake launchctl and python on a fake clock. The one-shot sampler run writes a fresh sample
   * like the real script. A started agent publishes at once and then every `--interval` seconds,
   * as the looping script does. `launchd: "pended"` is mini-2 over SSH (CTC-5929): it loads the
   * agent but starts it only on kickstart. `"never"` starts nothing. */
  function machine(options: { clt?: boolean; brew?: boolean; bootstrap?: boolean; launchd?: "runs" | "pended" | "never" } = {}) {
    const home = temp();
    const dir = join(home, "state", "runner");
    mkdirSync(join(dir, "host-disk"), { recursive: true });
    const output = join(dir, "host-disk", "space.json");
    const loaded = new Set<string>();
    const calls: string[] = [];
    let clock = NOW;
    let agent: { intervalMs: number; last: number } | null = null;
    const start = () => {
      if (agent || options.launchd === "never") return;
      const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(plist, "utf8"))![1]!;
      const values = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]!);
      agent = { intervalMs: Number(values[values.indexOf("--interval") + 1]) * 1_000, last: clock };
      writeFileSync(output, sample(80, clock));
    };
    const tick = (ms: number) => {
      clock += ms;
      while (agent && agent.intervalMs > 0 && clock - agent.last >= agent.intervalMs) {
        agent.last += agent.intervalMs;
        writeFileSync(output, sample(80, agent.last));
      }
    };
    const run: SamplerRun = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "/usr/bin/xcode-select") return { status: options.clt === false ? 2 : 0, stdout: "", stderr: "" };
      if (cmd.endsWith("python3")) {
        // With --interval the real script never exits, so setup's one-shot run would time out.
        if (args.includes("--interval")) return { status: 1, stdout: "", stderr: "timed out" };
        writeFileSync(args[args.indexOf("--output") + 1]!, sample(80, clock));
        return { status: 0, stdout: "", stderr: "" };
      }
      const [verb, target] = args;
      if (verb === "print") return { status: loaded.has(target!) ? 0 : 113, stdout: "", stderr: "" };
      if (verb === "bootout") { loaded.delete(target!); agent = null; return { status: 0, stdout: "", stderr: "" }; }
      if (verb === "bootstrap") {
        if (options.bootstrap === false) return { status: 5, stdout: "", stderr: "" };
        loaded.add(`${target}/${HOST_DISK_LABEL}`);
        if ((options.launchd ?? "runs") === "runs") start();
        return { status: 0, stdout: "", stderr: "" };
      }
      if (verb === "kickstart") {
        if (!loaded.has(target!)) return { status: 113, stdout: "", stderr: "" };
        start();
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const exists = (path: string) =>
      path === "/usr/bin/python3" ? options.clt !== false
        : path === "/opt/homebrew/bin/python3" ? options.brew === true
          : existsSync(path);
    // Docker Desktop is the active engine, with its default disk image folder.
    const desktop = join(home, "Library/Containers/com.docker.docker/Data/vms/0/data");
    mkdirSync(desktop, { recursive: true });
    const deps = { home, uid: 501, now: () => clock, sleep: tick, run, exists, desktop,
      dockerHost: `unix://${home}/.docker/run/docker.sock` as string | null, realpath: (path: string) => path,
      explicitPath: undefined as string | undefined };
    const plist = join(home, "Library", "LaunchAgents", `${HOST_DISK_LABEL}.plist`);
    /** Distinct sample times the agent publishes over the next `seconds`, one-second reads. */
    const published = (seconds: number) => {
      const seen = new Set<number>();
      for (let i = 0; i < seconds; i++) {
        tick(1_000);
        seen.add(JSON.parse(readFileSync(output, "utf8")).observedAtMs as number);
      }
      return seen.size;
    };
    return { home, dir, deps, calls, plist, loaded, published };
  }

  test("installs catalyst-cloud's sampler and template with this install's paths, then loads it", () => {
    const m = machine();
    expect(hostDiskSamplerStatus(m.dir, m.deps)).toBe("missing");
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    const script = join(m.dir, "host-disk-sampler", "host-disk-sample.py");
    expect(readFileSync(script)).toEqual(readFileSync(join(packageRoot(), "vendor/self-host/host-disk-sample.py")));
    const plist = readFileSync(m.plist, "utf8");
    expect(plist).not.toMatch(/__[A-Z]+__/);
    for (const value of ["/usr/bin/python3", script, m.deps.desktop, join(m.dir, "host-disk", "space.json")])
      expect(plist).toContain(`<string>${value}</string>`);
    expect(plist).toContain("<string>--interval</string><string>10</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(m.calls).toContain(`/bin/launchctl bootstrap gui/501 ${m.plist}`);
    expect(m.calls).toContain(`/bin/launchctl kickstart gui/501/${HOST_DISK_LABEL}`);
    expect(hostDiskSamplerStatus(m.dir, m.deps)).toBe("installed");
  });

  test("a second install leaves the loaded agent running", () => {
    const m = machine();
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    m.calls.length = 0;
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    expect(m.calls.filter(call => / (bootout|bootstrap) /.test(call))).toEqual([]);
  });

  test("a changed agent is reloaded in place", () => {
    const m = machine();
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    writeFileSync(m.plist, readFileSync(m.plist, "utf8").replace("<string>10</string>", "<string>60</string>"));
    m.calls.length = 0;
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    expect(m.calls.filter(call => / (bootout|bootstrap) /.test(call)))
      .toEqual([`/bin/launchctl bootout gui/501/${HOST_DISK_LABEL}`, `/bin/launchctl bootstrap gui/501 ${m.plist}`]);
  });

  test("a same-label agent publishing elsewhere belongs to its operator and is never replaced", () => {
    const m = machine();
    mkdirSync(join(m.home, "Library", "LaunchAgents"), { recursive: true });
    const foreign = `<plist><dict><key>Label</key><string>${HOST_DISK_LABEL}</string><key>ProgramArguments</key><array>` +
      "<string>/usr/bin/python3</string><string>/x.py</string><string>--output</string><string>/elsewhere/space.json</string></array></dict></plist>";
    writeFileSync(m.plist, foreign);
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("runner_host_disk_sampler_conflict");
    expect(hostDiskSamplerStatus(m.dir, m.deps)).toBe("runner_host_disk_sampler_conflict");
    expect(readFileSync(m.plist, "utf8")).toBe(foreign);
    expect(m.calls.some(call => call.includes("launchctl boot"))).toBe(false);
  });

  test("never runs the Command Line Tools stub; uses Homebrew's python3 instead", () => {
    const m = machine({ clt: false, brew: true });
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    expect(m.calls.some(call => call.startsWith("/usr/bin/python3"))).toBe(false);
    expect(readFileSync(m.plist, "utf8")).toContain("<string>/opt/homebrew/bin/python3</string>");
  });

  test("no usable python3 is named, with nothing written", () => {
    const m = machine({ clt: false, brew: false });
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("runner_host_disk_sampler_python_missing");
    expect(existsSync(m.plist)).toBe(false);
  });

  test("falls back to the user domain when no one is logged in at the console", () => {
    const m = machine();
    const run = m.deps.run;
    m.deps.run = (cmd, args) => args[0] === "bootstrap" && args[1] === "gui/501"
      ? { status: 5, stdout: "", stderr: "" } : run(cmd, args, 0);
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    expect(m.loaded.has(`user/501/${HOST_DISK_LABEL}`)).toBe(true);
  });

  test("an agent launchd will not load is a failure, not a silent success", () => {
    const m = machine({ bootstrap: false });
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("runner_host_disk_sampler_failed");
  });

  // CTC-5929 mini-2: bootstrapped over SSH, the agent sat at runs = 0 ("pended nondemand spawn =
  // interval"), the setup-time sample went stale in 30 seconds, and the supervisor refused work.
  test("an agent launchd loads but holds is started on demand and keeps publishing", () => {
    const m = machine({ launchd: "pended" });
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    expect(m.calls).toContain(`/bin/launchctl kickstart gui/501/${HOST_DISK_LABEL}`);
    // The positive cadence control: three minutes later it still publishes every ten seconds.
    expect(m.published(180)).toBeGreaterThanOrEqual(17);
    expect(hostDiskSamplerStatus(m.dir, m.deps)).toBe("installed");
  });

  test("setup's own sample is one run that exits, never the agent's loop", () => {
    const m = machine();
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("ready");
    const once = m.calls.filter(call => call.startsWith("/usr/bin/python3 "));
    expect(once).toHaveLength(1);
    expect(once[0]).not.toContain("--interval");
  });

  test("an agent launchd never runs is named, not reported ready", () => {
    const m = machine({ launchd: "never" });
    expect(installHostDiskSampler(m.dir, m.deps)).toBe("runner_host_disk_sampler_not_repeating");
    const text = onboardReasonText({ id: "runner", state: "waiting", reason: "runner_host_disk_sampler_not_repeating" });
    expect(text).toContain("launchd did not keep it measuring this Mac's disk");
    expect(text).toContain("SSH");
    expect(text).toContain("catalyst setup --runner");
    expect(text).not.toContain("runner_host_disk_sampler_not_repeating");
  });
});

test("the vendored sampler keeps publishing at its interval on its own", async () => {
  const dir = temp();
  const output = join(dir, "host-disk", "space.json");
  const script = join(packageRoot(), "vendor/self-host/host-disk-sample.py");
  const child = spawn("python3", [script, "--path", dir, "--output", output, "--interval", "0.2"]);
  const seen = new Set<number>();
  try {
    for (let waited = 0; seen.size < 3 && waited < 5_000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { seen.add(JSON.parse(readFileSync(output, "utf8")).observedAtMs as number); } catch { /* not yet */ }
    }
  } finally {
    child.kill();
  }
  expect(child.exitCode).toBeNull();
  expect(seen.size).toBeGreaterThanOrEqual(3);
});

test("removal and diagnosis name both launchd domains", () => {
  const fix = runnerDiskCopy({ state: "unmeasured", detail: "host_disk_sample_stale", floorGiB: 25 }, true).fix;
  expect(fix).toContain(`gui/$(id -u)/${HOST_DISK_LABEL}`);
  expect(fix).toContain(`user/$(id -u)/${HOST_DISK_LABEL}`);
});

describe("the sampler measures the ACTIVE engine's disk", () => {
  function engine(socket: string, dirs: string[] = [], settings: Record<string, string> = {}) {
    const home = "/Users/a";
    const present = new Set(dirs.map(d => join(home, d)));
    return {
      home, uid: 501, now: () => NOW,
      dockerHost: `unix://${socket.startsWith("/") ? socket : join(home, socket)}` as string | null,
      exists: (path: string) => present.has(path),
      realpath: (path: string) => path === "/var/run/docker.sock" ? join(home, ".orbstack/run/docker.sock") : path,
      readText: (path: string) => {
        const name = path.split("/").at(-1)!;
        if (!(name in settings)) throw new Error("ENOENT");
        return settings[name]!;
      },
    };
  }
  const DESKTOP = "Library/Containers/com.docker.docker/Data/vms/0/data";
  const ORB = "Library/Group Containers/HUAQ24HBR6.dev.orbstack/data";

  test("with Docker Desktop and OrbStack both installed, OrbStack active measures OrbStack's disk", () => {
    expect(engineDiskPath(engine(".orbstack/run/docker.sock", [DESKTOP, ORB]))).toBe(join("/Users/a", ORB));
  });

  test("the /var/run/docker.sock symlink resolves to the engine it points at", () => {
    expect(engineDiskPath(engine("/var/run/docker.sock", [DESKTOP, ORB]))).toBe(join("/Users/a", ORB));
  });

  test("Docker Desktop active measures its default folder, never OrbStack's", () => {
    expect(engineDiskPath(engine(".docker/run/docker.sock", [DESKTOP, ORB]))).toBe(join("/Users/a", DESKTOP));
  });

  test("a relocated Docker Desktop disk image is measured where its settings put it", () => {
    const e = engine(".docker/run/docker.sock", [DESKTOP, "/Volumes/Fast/docker"].map(d => d), {
      "settings-store.json": JSON.stringify({ DataFolder: "/Volumes/Fast/docker" }) });
    e.exists = (path: string) => path === "/Volumes/Fast/docker" || path === join("/Users/a", DESKTOP);
    expect(engineDiskPath(e)).toBe("/Volumes/Fast/docker");
  });

  test("a relocated folder that is not there is unverified, never the default", () => {
    expect(engineDiskPath(engine(".docker/run/docker.sock", [DESKTOP], {
      "settings.json": JSON.stringify({ dataFolder: "/Volumes/Gone/docker" }) }))).toBeNull();
  });

  test("Lima and Colima measure the instance directory that holds the socket", () => {
    expect(engineDiskPath(engine(".lima/docker/sock/docker.sock", [".lima/docker"]))).toBe("/Users/a/.lima/docker");
    expect(engineDiskPath(engine(".colima/default/docker.sock", [".colima/_lima/colima"]))).toBe("/Users/a/.colima/_lima/colima");
    expect(engineDiskPath(engine(".colima/work/docker.sock", [".colima/_lima/colima-work"]))).toBe("/Users/a/.colima/_lima/colima-work");
  });

  test("an unknown or remote engine is unverified and needs CATALYST_HOST_DISK_PATH", () => {
    expect(engineDiskPath(engine("/tmp/custom/docker.sock", [DESKTOP, ORB]))).toBeNull();
    const remote = engine(".docker/run/docker.sock", [DESKTOP]);
    remote.dockerHost = "tcp://10.0.0.5:2376";
    expect(engineDiskPath(remote)).toBeNull();
    const named = { ...engine("/tmp/custom/docker.sock", ["/Volumes/VMs"]), explicitPath: "/Volumes/VMs" };
    named.exists = (path: string) => path === "/Volumes/VMs";
    expect(engineDiskPath(named)).toBe("/Volumes/VMs");
  });

  test("install refuses an unverified location before writing anything", () => {
    const home = temp();
    const dir = join(home, "state", "runner");
    const result = installHostDiskSampler(dir, { home, uid: 501, now: () => NOW,
      dockerHost: "unix:///tmp/custom/docker.sock", realpath: (path: string) => path, run: () => ({ status: 0, stdout: "", stderr: "" }) });
    expect(result).toBe("runner_host_disk_location_unverified");
    expect(existsSync(join(home, "Library", "LaunchAgents", `${HOST_DISK_LABEL}.plist`))).toBe(false);
  });

  test("a foreign agent's output becomes both sample settings", () => {
    const home = temp();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", `${HOST_DISK_LABEL}.plist`),
      "<array><string>--output</string><string>/Users/a/.local/share/catalyst/host-disk/space.json</string></array>");
    expect(foreignHostDiskSample(home)).toEqual({
      sampleDir: "/Users/a/.local/share/catalyst/host-disk", sampleFile: "/var/lib/catalyst/host-disk/space.json" });
  });
});
