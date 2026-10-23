import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { configPathFor, loadConfig, readManifest, writeConfig } from "../src/config";
import type { RunnerCommand } from "../src/runner";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

const HOST = "host_abc";
const REQUEST = "0b9f1c2e-1d2a-4c3b-8a4d-5e6f7a8b9c0d";
const SUPERVISOR = "a".repeat(64);
const WATCHDOG = "b".repeat(64);

interface Fake {
  calls: string[][];
  supervisor: "running" | "exited" | "absent";
  attempts: string[];
  volumes: string[];
  network: "v1" | "other" | "absent";
  networkInUse?: boolean;
  enrolled: boolean;
}

let ctx: TestCtx;
let dir: string;
let fake: Fake;
let cloud: { method: string; url: string; body: unknown }[];
let cloudStatus: Record<string, number>;
let otherHosts: unknown[];

function command(f: Fake): RunnerCommand {
  return async (file, args) => {
    f.calls.push([file, ...args]);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (file === "launchctl") return args[0] === "print" ? { code: 113, stdout: "", stderr: "not found" } : ok();
    if (file !== "docker") return ok();
    const a = args.join(" ");
    if (a.startsWith("ps --all --no-trunc --filter label=com.docker.compose.project=catalyst-host")) {
      if (f.supervisor === "absent") return ok();
      const files = [join(dir, "compose.yaml")].join(",");
      return ok([[SUPERVISOR, "supervisor", f.supervisor, dir, files], [WATCHDOG, "deadline-watchdog", "running", dir, files]]
        .map(r => r.join("\t")).join("\n") + "\n");
    }
    if (a.includes("ps --status running --services"))
      return ok(f.supervisor === "running" ? "supervisor\ndeadline-watchdog\n" : "deadline-watchdog\n");
    if (a.endsWith("stop supervisor")) { f.supervisor = "exited"; return ok(); }
    if (a.endsWith("up --detach")) { f.supervisor = "running"; return ok(); }
    if (a.includes("--entrypoint bun supervisor -e"))
      return f.enrolled ? ok(JSON.stringify({ hostId: HOST, tenant: "acme", team: "ADV", enrollmentKind: "self_hosted" })) : { code: 1, stdout: "", stderr: "" };
    if (a.startsWith("ps --filter label=dev.catalystcloud.attempt.id")) return ok(f.attempts.join("\n"));
    if (a.startsWith(`ps --all --no-trunc --filter label=dev.catalystcloud.attempt.host-id=${HOST}`))
      return ok(f.attempts.map(id => `${id}\t${HOST}`).join("\n"));
    if (a.startsWith("rm --force")) { f.attempts = []; return ok(); }
    if (a.startsWith(`volume ls --filter label=dev.catalystcloud.attempt.host-id=${HOST}`))
      return ok(f.volumes.map(v => `${v}\t${HOST}`).join("\n"));
    if (a.startsWith("volume rm")) { f.volumes = f.volumes.filter(v => !args.includes(v)); return ok(); }
    if (a.includes(" down --volumes")) { f.supervisor = "absent"; f.enrolled = false; return ok(); }
    if (a.startsWith("volume inspect")) return { code: 1, stdout: "", stderr: "no such volume" };
    if (a.startsWith("network inspect"))
      return f.network === "absent" ? { code: 1, stdout: "", stderr: "not found" } : ok(f.network === "v1" ? "v1\n" : "\n");
    if (a.startsWith("network rm")) {
      if (f.networkInUse) return { code: 1, stdout: "", stderr: "has active endpoints" };
      f.network = "absent"; return ok();
    }
    return ok();
  };
}

function runner(...argv: string[]) {
  return main(["runner", ...argv], ctx, { runner: { run: command(fake), platform: "linux", isTty: () => false } });
}

beforeEach(() => {
  cloud = [];
  cloudStatus = {};
  otherHosts = [];
  ctx = makeCtx(tempHome(), {
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      cloud.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      const status = cloudStatus[`${method} ${url.includes("runner-keys") ? "runner-keys" : "hosts"}`] ?? cloudStatus[method] ?? (method === "DELETE" && url.includes("runner-keys") ? 204 : 200);
      if (status === 204) return new Response(null, { status });
      if (method === "GET") return Response.json({ hosts: otherHosts });
      if (method === "PUT") return Response.json({ account: "acme", admissionEnabled: false }, { status });
      return Response.json(status === 200 ? { ok: true, hostId: HOST } : { error: "denied" }, { status });
    },
  });
  ctx.env.CATALYST_INSTALL_STATE_DIR = join(ctx.home, "state");
  dir = join(ctx.home, "state", "runner");
  for (const sub of ["slots/acme", "thoughts", "locks", "session-egress", "host-disk", "host-disk-sampler"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "host-disk-sampler", "host-disk-sample.py"), "# sampler\n", { mode: 0o644 });
  writeFileSync(join(dir, "compose.yaml"), "services: {}\n", { mode: 0o644 });
  writeFileSync(join(dir, ".env"), "CATALYST_HOST_NAME=studio\n", { mode: 0o600 });
  writeFileSync(join(dir, "key-request.json"), JSON.stringify({ version: 1, requestId: REQUEST, account: "acme", teamId: "team-uuid", hostName: "studio" }), { mode: 0o600 });
  fake = { calls: [], supervisor: "running", attempts: ["c".repeat(64)], volumes: ["catalyst-pa_x_1-g1-ws"], network: "v1", enrolled: true };
  writeConfig(ctx.home, {
    baseUrl: "https://cloud.example", key: "ctc_user_admin", account: "acme", slug: "acme", name: "Acme",
    permissions: ["mirror:read"], principal: "service", joinedAt: "2026-10-16T00:00:00Z",
    lastSkillBundleVersion: readManifest().version,
  });
});

const docker = () => fake.calls.filter(c => c[0] === "docker").map(c => c.slice(1).join(" "));

describe("runner stop and start", () => {
  it("stops only the supervisor, keeps the registration, and is safe to repeat", async () => {
    expect(await runner("stop")).toBe(0);
    expect(docker().some(c => c.endsWith("stop supervisor"))).toBe(true);
    expect(docker().some(c => c.includes("down") || c.includes("volume rm"))).toBe(false);
    expect(ctx.out.join("\n")).toContain("takes no new work, and keeps its registration");
    expect(ctx.out.join("\n")).toContain("1 attempt container(s) already started keep running");
    expect(ctx.out.join("\n")).toContain("catalyst runner start");
    fake.calls = [];
    ctx.out.length = 0;
    expect(await runner("stop")).toBe(0);
    expect(docker().some(c => c.endsWith("stop supervisor"))).toBe(false);
    expect(ctx.out.join("\n")).toContain("already stopped");
    expect(cloud).toEqual([]);
  });

  it("starts the same project again and names the same host", async () => {
    fake.supervisor = "exited";
    expect(await runner("start")).toBe(0);
    expect(docker().some(c => c.endsWith("up --detach"))).toBe(true);
    expect(ctx.out.join("\n")).toContain("same registration");
    expect(ctx.out.join("\n")).toContain(`Host: ${HOST}`);
    ctx.out.length = 0;
    expect(await runner("start")).toBe(0);
    expect(ctx.out.join("\n")).toContain("already running");
  });

  it("status reports the project's containers", async () => {
    fake.supervisor = "exited";
    expect(await runner("status", "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ installed: true, state: "stopped", dir });
  });

  it("refuses a runner folder outside this person's home without touching anything", async () => {
    const outside = tempHome();
    mkdirSync(join(outside, "runner"));
    writeFileSync(join(outside, "runner", "compose.yaml"), "");
    dir = join(outside, "runner");
    await expect(runner("stop")).resolves.toBe(1);
    expect(ctx.err.join("\n")).toContain("not one setup created for you");
    expect(docker().some(c => c.endsWith("stop supervisor"))).toBe(false);
  });

  it("rejects uninstall flags on stop", async () => {
    expect(await runner("stop", "--yes")).not.toBe(0);
  });
  it("a bare runner reports status beside runner update and auto-update", async () => {
    fake.supervisor = "running";
    expect(await runner("--json")).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ installed: true, state: "running", dir });
  });
});

describe("runner uninstall", () => {
  it("needs confirmation without a terminal", async () => {
    expect(await runner("uninstall")).toBe(2);
    expect(fake.calls.filter(c => c.join(" ").includes("stop supervisor"))).toEqual([]);
    expect(cloud).toEqual([]);
  });

  it("stops work, revokes the host and key, removes what setup created, and prints the checkouts it kept", async () => {
    expect(await runner("uninstall", "--yes")).toBe(0);
    const calls = docker();
    const stop = calls.findIndex(c => c.endsWith("stop supervisor"));
    const down = calls.findIndex(c => c.includes(" down --volumes --remove-orphans"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(down).toBeGreaterThan(stop);
    expect(calls).toContain(`rm --force ${"c".repeat(64)}`);
    expect(calls).toContain("volume rm catalyst-pa_x_1-g1-ws");
    expect(calls).toContain("network rm catalyst-session-v1");
    expect(cloud.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `DELETE /api/v1/hosts/${HOST}`,
      `DELETE /api/v1/agent/runner-keys/${REQUEST}`,
      "GET /api/v1/hosts/enrollments",
      "PUT /api/v1/agent/runner-admission",
    ]);
    expect(cloud[3]!.body).toEqual({ admissionEnabled: false });
    for (const gone of ["compose.yaml", ".env", "key-request.json", "session-egress", "host-disk", "host-disk-sampler", "uninstall.json"])
      expect(existsSync(join(dir, gone)), gone).toBe(false);
    for (const kept of ["slots/acme", "thoughts", "locks"]) expect(existsSync(join(dir, kept)), kept).toBe(true);
    const out = ctx.out.join("\n");
    expect(out).toContain("Left behind on this machine:");
    expect(out).toContain(`${join(dir, "slots")} (repository checkouts)`);
    expect(out).toContain("--delete-checkouts");
    expect(out).toContain("Uninstalled the runner from this machine.");
  });

  it("keeps team admission on while another machine still runs the team", async () => {
    otherHosts = [{ hostId: "host_other", team: "ADV", revokedAtMs: null }];
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(cloud.some(c => c.method === "PUT")).toBe(false);
    expect(ctx.out.join("\n")).toContain("1 other machine(s) still run team ADV");
  });

  it("deletes the checkouts only when asked", async () => {
    expect(await runner("uninstall", "--yes", "--delete-checkouts")).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the credential when the cloud revoked only part, then finishes on a rerun from its journal", async () => {
    cloudStatus["DELETE runner-keys"] = 503;
    expect(await runner("uninstall", "--yes")).toBe(1);
    expect(docker().some(c => c.includes(" down "))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "uninstall.json"), "utf8"))).toMatchObject({ hostId: HOST, requestId: REQUEST, team: "ADV", cloudRevoked: true });
    expect(ctx.out.join("\n")).toContain("the key service is unavailable");
    // The credential volume cannot be read any more; the journal still names the host.
    fake.enrolled = false;
    delete cloudStatus["DELETE runner-keys"];
    cloud = [];
    ctx.out.length = 0;
    await expect(runner("start")).resolves.toBe(1);
    expect(ctx.err.join("\n")).toContain("catalyst runner uninstall");
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(cloud[0]).toMatchObject({ method: "DELETE", url: expect.stringContaining(`/api/v1/hosts/${HOST}`) });
    expect(existsSync(join(dir, "uninstall.json"))).toBe(false);
  });

  it("CTC-5930: a member's refused uninstall changes nothing in the cloud, so runner start brings the machine back", async () => {
    cloudStatus.DELETE = 403;
    expect(await runner("uninstall", "--yes")).toBe(1);
    expect(ctx.out.join("\n")).toContain("admin access is required");
    expect(JSON.parse(readFileSync(join(dir, "uninstall.json"), "utf8"))).toMatchObject({ hostId: HOST, cloudRevoked: false });
    fake.supervisor = "exited";
    fake.calls = [];
    ctx.out.length = 0;
    expect(await runner("start")).toBe(0);
    expect(existsSync(join(dir, "uninstall.json"))).toBe(false);
    expect(docker().some(c => c.includes(" up --detach"))).toBe(true);
    expect(ctx.out.join("\n")).toContain("before the cloud changed anything, so it is cancelled");
  });

  it.each(["not logged in", "another account"] as const)("CTC-5930: %s, uninstall changes nothing and the runner keeps taking work", async (mode) => {
    if (mode === "not logged in") rmSync(configPathFor(ctx.home), { force: true });
    else writeConfig(ctx.home, { ...loadConfig(ctx.home)!, account: "other" });
    expect(await runner("uninstall", "--yes")).toBe(1);
    expect(ctx.out.join("\n")).toContain("Nothing was changed: the runner keeps running.");
    expect(docker().some(c => c.includes(" stop supervisor"))).toBe(false);
    expect(existsSync(join(dir, "uninstall.json"))).toBe(false);
    expect(cloud).toEqual([]);
  });

  it("CTC-5930: keeps team admission on while another machine serves the team as an added team", async () => {
    otherHosts = [{ hostId: "host_other", team: "OPS", teams: ["OPS", "ADV"], revokedAtMs: null }];
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(cloud.some(c => c.method === "PUT")).toBe(false);
    expect(ctx.out.join("\n")).toContain("1 other machine(s) still run team ADV");
  });

  it("treats a host the cloud already revoked as done, and leaves a network another owner made", async () => {
    cloudStatus.DELETE = 404;
    fake.network = "other";
    expect(await runner("uninstall", "--yes")).toBe(0);
    const out = ctx.out.join("\n");
    expect(out).toContain("already revoked");
    expect(out).toContain("catalyst-session-v1: not created by setup");
    expect(docker()).not.toContain("network rm catalyst-session-v1");
  });

  it("names a network still in use as left behind", async () => {
    fake.networkInUse = true;
    expect(await runner("uninstall", "--yes", "--json")).toBe(1);
    const body = JSON.parse(ctx.out[0]!);
    expect(body.removed).toBe(false);
    expect(body.leftBehind).toContain("catalyst-session-v1: still in use by a container");
  });

  it("removes the Mac storage service and its folders, and only a plist setup wrote", async () => {
    const agents = join(ctx.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const custody = join(agents, "dev.catalystcloud.runner.darwin-thoughts-custody.plist");
    writeFileSync(custody, "<plist><dict><key>Label</key><string>dev.catalystcloud.runner.darwin-thoughts-custody</string></dict></plist>");
    const sampler = join(agents, "dev.catalystcloud.host-disk.plist");
    writeFileSync(sampler, "<plist>someone else's</plist>");
    for (const name of ["darwin-thoughts-custody", "darwin-thoughts-requests", "darwin-thoughts-responses"])
      mkdirSync(join(dir, "..", name), { mode: 0o700 });
    expect(await main(["runner", "uninstall", "--yes"], ctx, { runner: { run: command(fake), platform: "darwin", isTty: () => false } })).toBe(0);
    expect(fake.calls).toContainEqual(["launchctl", "bootout", `user/${process.getuid!()}/dev.catalystcloud.runner.darwin-thoughts-custody`]);
    expect(existsSync(custody)).toBe(false);
    expect(existsSync(sampler)).toBe(true);
    for (const name of ["darwin-thoughts-custody", "darwin-thoughts-requests", "darwin-thoughts-responses"])
      expect(existsSync(join(dir, "..", name))).toBe(false);
    expect(ctx.out.join("\n")).toContain(`${sampler}: not the file setup installed`);
  });

  /** A disk sampler plist with the label setup uses, publishing to `output`. */
  const samplerPlist = (output: string) => `<plist><dict><key>Label</key><string>dev.catalystcloud.host-disk</string>` +
    `<key>ProgramArguments</key><array><string>--output</string><string>${output}</string></array></dict></plist>`;

  it("removes the disk sampler setup installed, and keeps a same-label agent that publishes elsewhere", async () => {
    const agents = join(ctx.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const sampler = join(agents, "dev.catalystcloud.host-disk.plist");
    // Setup's: it publishes into this runner's own host-disk bind.
    writeFileSync(sampler, samplerPlist(join(dir, "host-disk", "space.json")));
    expect(await main(["runner", "uninstall", "--yes"], ctx, { runner: { run: command(fake), platform: "darwin", isTty: () => false } })).toBe(0);
    expect(fake.calls).toContainEqual(["launchctl", "bootout", `user/${process.getuid!()}/dev.catalystcloud.host-disk`]);
    expect(existsSync(sampler)).toBe(false);
    expect(existsSync(join(dir, "host-disk-sampler"))).toBe(false);
  });

  it("keeps a same-label disk agent an operator installed to publish somewhere else", async () => {
    const agents = join(ctx.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const sampler = join(agents, "dev.catalystcloud.host-disk.plist");
    writeFileSync(sampler, samplerPlist("/Users/a/.local/share/catalyst/host-disk/space.json"));
    expect(await main(["runner", "uninstall", "--yes"], ctx, { runner: { run: command(fake), platform: "darwin", isTty: () => false } })).toBe(0);
    expect(fake.calls.some(c => c.join(" ").includes("bootout") && c.join(" ").includes("dev.catalystcloud.host-disk"))).toBe(false);
    expect(existsSync(sampler)).toBe(true);
    expect(ctx.out.join("\n")).toContain(`${sampler}: not the file setup installed`);
  });

  it("says so when nothing is installed", async () => {
    fake.supervisor = "absent";
    const empty = tempHome();
    ctx.env.CATALYST_INSTALL_STATE_DIR = join(empty, "state");
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(ctx.out.join("\n")).toContain("Nothing to remove");
    expect(cloud).toEqual([]);
  });
});

type Result = { code: number; stdout: string; stderr: string };
/** The fake, with chosen docker calls answered differently. */
function overriding(pick: (call: string) => Result | undefined): RunnerCommand {
  const base = command(fake);
  return async (file, args, options) => (file === "docker" ? pick(args.join(" ")) : undefined) ?? base(file, args, options);
}
const fail = (stderr = ""): Result => ({ code: 1, stdout: "", stderr });
const rows = (...lines: string[][]): Result => ({ code: 0, stdout: lines.map(l => l.join("\t")).join("\n") + "\n", stderr: "" });
const PROJECT_PS = "ps --all --no-trunc --filter label=com.docker.compose.project=catalyst-host";
function runnerWith(run: RunnerCommand, ...argv: string[]) {
  return main(["runner", ...argv], ctx, { runner: { run, platform: "linux", isTty: () => false } });
}

describe("CTC-6603: runner refuses what it cannot verify", () => {
  it("refuses an unknown action and an extra word", async () => {
    expect(await runner("restart")).not.toBe(0);
    expect(await runner("stop", "now")).not.toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("says Docker is not reachable when the project cannot be listed", async () => {
    expect(await runnerWith(overriding(c => c.startsWith(PROJECT_PS) ? fail() : undefined), "status")).toBe(1);
    expect(ctx.err.join("\n")).toContain("Docker is not reachable");
  });

  it("changes nothing when a project container cannot be read", async () => {
    const files = join(dir, "compose.yaml");
    expect(await runnerWith(overriding(c => c.startsWith(PROJECT_PS) ? rows(["not-an-id", "supervisor", "running", dir, files]) : undefined), "stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("has a container this command cannot read");
    expect(docker().some(c => c.endsWith("stop supervisor"))).toBe(false);
  });

  it("changes nothing when the project was started from two folders", async () => {
    const files = join(dir, "compose.yaml");
    expect(await runnerWith(overriding(c => c.startsWith(PROJECT_PS)
      ? rows([SUPERVISOR, "supervisor", "running", dir, files], [WATCHDOG, "deadline-watchdog", "running", join(ctx.home, "other"), files]) : undefined), "stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("more than one folder");
  });
});

describe("CTC-6603: runner status", () => {
  it("prints the state, the folder and each container", async () => {
    expect(await runner("status")).toBe(0);
    expect(ctx.out).toEqual([`Runner: running (folder ${dir})`, "  supervisor: running", "  deadline-watchdog: running"]);
  });

  it("reads a set-up runner with no containers as not started", async () => {
    fake.supervisor = "absent";
    expect(await runner("status", "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ installed: true, state: "not started", containers: [] });
  });

  it.each([[[] as string[], "No Catalyst runner is installed on this machine."], [["--json"], JSON.stringify({ installed: false })]])(
    "says so when nothing is installed (%j)", async (flags, line) => {
      fake.supervisor = "absent";
      ctx.env.CATALYST_INSTALL_STATE_DIR = join(tempHome(), "state");
      expect(await runner("status", ...flags)).toBe(0);
      expect(ctx.out).toEqual([line]);
    });
});

describe("CTC-6603: runner stop and start failures", () => {
  it("refuses to stop a runner that has no containers", async () => {
    fake.supervisor = "absent";
    expect(await runner("stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("No Catalyst runner is running on this machine");
  });

  it("refuses a runner folder that lost its settings", async () => {
    rmSync(join(dir, ".env"));
    expect(await runner("stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("is missing its settings");
  });

  it("changes nothing when Compose cannot read the runner's state", async () => {
    expect(await runnerWith(overriding(c => c.includes("ps --status running --services") ? fail() : undefined), "stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("Compose could not read the runner's state");
  });

  it("names Compose's last line when the supervisor does not stop", async () => {
    expect(await runnerWith(overriding(c => c.endsWith("stop supervisor") ? fail("warming up\nboom\n") : undefined), "stop")).toBe(1);
    expect(ctx.err.join("\n")).toContain("The runner did not stop: boom");
  });

  it("names Compose's last line when the runner does not start", async () => {
    fake.supervisor = "exited";
    expect(await runnerWith(overriding(c => c.endsWith("up --detach") ? fail("port is already allocated\n") : undefined), "start")).toBe(1);
    expect(ctx.err.join("\n")).toContain("The runner did not start: port is already allocated");
  });

  it("reports stop and start as JSON", async () => {
    expect(await runner("stop", "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toEqual({ stopped: true, alreadyStopped: false, runningAttempts: 1 });
    ctx.out.length = 0;
    expect(await runner("start", "--json")).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toEqual({ started: true, alreadyRunning: false, hostId: HOST });
  });

  it("refuses to start over an uninstall journal it cannot read", async () => {
    fake.supervisor = "exited";
    writeFileSync(join(dir, "uninstall.json"), "not json");
    expect(await runner("start")).toBe(1);
    expect(ctx.err.join("\n")).toContain("An uninstall of this runner has started");
    expect(docker().some(c => c.endsWith("up --detach"))).toBe(false);
  });
});

describe("CTC-6603: runner uninstall edges", () => {
  it("asks on a terminal and keeps the runner on a no, then goes ahead on a yes", async () => {
    let shown: string[] = [];
    const ask = (answer: boolean) => main(["runner", "uninstall"], ctx, { runner: { run: command(fake), platform: "linux", isTty: () => true, confirm: async (summary) => { shown = summary; return answer; } } });
    expect(await ask(false)).toBe(2);
    expect(shown).toContain("Runner key: will be revoked");
    expect(shown).toContain(`Host registration: ${HOST} (team ADV)`);
    expect(ctx.out.join("\n")).toContain("Runner kept.");
    expect(cloud).toEqual([]);
    expect(await ask(true)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Uninstalled the runner from this machine.");
  });

  it("reports a missing confirmation as JSON", async () => {
    expect(await runner("uninstall", "--json")).toBe(2);
    expect(JSON.parse(ctx.out[0]!)).toEqual({ removed: false, reason: "confirmation_required" });
  });

  it("revokes only the key for a machine that never enrolled", async () => {
    fake.enrolled = false;
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(ctx.out.join("\n")).toContain("host registration (this machine never enrolled)");
    expect(cloud.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`DELETE /api/v1/agent/runner-keys/${REQUEST}`]);
  });

  it("names what it could not list or remove, and keeps the journal for a rerun", async () => {
    const run = overriding(c => c.endsWith("stop supervisor") || c.startsWith("ps --all --no-trunc --filter label=dev.catalystcloud.attempt.host-id")
      || c.startsWith("volume ls") || c.includes(" down --volumes") ? fail("down broke\n") : undefined);
    expect(await runnerWith(run, "uninstall", "--yes")).toBe(1);
    const out = ctx.out.join("\n");
    expect(out).toContain("supervisor (compose stop failed)");
    expect(out).toContain("attempt containers (could not be listed)");
    expect(out).toContain("attempt volumes (could not be listed)");
    expect(out).toContain("compose project (down broke)");
    expect(out).toContain("lets the next run finish the uninstall");
    expect(out).toContain("Some of the runner is left on this machine");
  });

  it("names attempt containers and volumes Docker would not remove", async () => {
    const run = overriding(c => c.startsWith("rm --force") || c.startsWith("volume rm catalyst-pa") ? fail() : undefined);
    expect(await runnerWith(run, "uninstall", "--yes", "--json")).toBe(1);
    const body = JSON.parse(ctx.out[0]!);
    expect(body.steps).toEqual(expect.arrayContaining([
      { item: "attempt containers", outcome: "failed", detail: "1" },
      { item: "attempt volumes", outcome: "failed", detail: "catalyst-pa_x_1-g1-ws" },
    ]));
  });

  it("removes the project's own volumes and keeps one another project labelled", async () => {
    const run = overriding(c => c.startsWith("volume inspect")
      ? { code: 0, stdout: c.endsWith("supervisor-state") ? "catalyst-host\n" : "someone-else\n", stderr: "" } : undefined);
    expect(await runnerWith(run, "uninstall", "--yes")).toBe(0);
    expect(docker()).toContain("volume rm catalyst-host_supervisor-state");
    expect(docker()).not.toContain("volume rm catalyst-host_host-credential");
    expect(ctx.out.join("\n")).toContain("catalyst-host_host-credential: not labelled as this project's");
  });

  it("leaves team admission as it was when the cloud refuses the switch", async () => {
    cloudStatus.PUT = 403;
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(ctx.out.join("\n")).toContain("team runner admission (left as it was (the cloud answered 403))");
  });

  it("leaves team admission as it was when the machine list cannot be read", async () => {
    const reach = ctx.fetch;
    ctx.fetch = async (input, init) => (init?.method ?? "GET") === "GET" ? Promise.reject(new Error("offline")) : reach(input, init);
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(ctx.out.join("\n")).toContain("left as it was: the machine list could not be read");
    expect(cloud.some(c => c.method === "PUT")).toBe(false);
  });

  it("skips the session network when there is none", async () => {
    fake.network = "absent";
    expect(await runner("uninstall", "--yes")).toBe(0);
    expect(docker().some(c => c.startsWith("network rm"))).toBe(false);
  });
});
