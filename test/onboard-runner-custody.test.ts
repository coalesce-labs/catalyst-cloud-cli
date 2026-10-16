import fs from "node:fs";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDarwinThoughtsInstallerTestHarness, installDarwinThoughtsCustody } from "../src/onboard-runner-custody.js";

const PROCESS_UID = process.getuid?.();
const PROCESS_GID = process.getgid?.();
if (PROCESS_UID === undefined || PROCESS_GID === undefined) throw Error("native fixture requires POSIX identity");
const NATIVE_UID = PROCESS_UID === 0 ? 501 : PROCESS_UID;
const NATIVE_GID = PROCESS_UID === 0 ? 20 : PROCESS_GID;
const FOREIGN_UID = NATIVE_UID + 1;
const NOW = 1791619200000;
const SUPERVISOR = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "a".repeat(64);
const RUNNER = "ghcr.io/coalesce-labs/catalyst-runner@sha256:" + "b".repeat(64);
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const row = value as Record<string, unknown>;
  return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonical(row[key])).join(",") + "}";
}
function identity(path: string, uid: number, gid: number) {
  const s = fs.lstatSync(path, { bigint: true });
  return { path, device: String(s.dev), inode: String(s.ino), uid, gid,
    mode: Number(s.mode & 0o7777n), isDirectory: true as const, isSymbolicLink: false as const };
}
describe("native Darwin custody installer", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "custody-installer-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  function fixture() {
    const dir = join(home, "self-host");
    fs.mkdirSync(dir, { mode: 0o750 });
    const principal = { platform: "darwin", uid: NATIVE_UID, euid: NATIVE_UID, gid: NATIVE_GID, home };
    // These ports inspect and pin executables, but never launch them. Keep real protected
    // fixture bytes independent of the CI toolcache's Node owner and write permissions.
    const executables = {
      nodeExecutable: join(home, "fixture-node"), dockerExecutable: join(home, "fixture-docker"),
    };
    fs.writeFileSync(executables.nodeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700, flag: "wx" });
    fs.writeFileSync(executables.dockerExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o700, flag: "wx" });
    const overrides = new Map<string, bigint>();
    const calls: Array<Record<string, unknown>> = [];
    let endpoint = "unix://" + join(home, "engine.sock");
    let cached = true;
    let runnerCustodyVersion: string | undefined = "v1";
    let wrongSignature = false;
    let nonceCount = 0;
    const harness = createDarwinThoughtsInstallerTestHarness({
      principal: () => principal, now: () => NOW,
      stat: (path: string, stat: fs.BigIntStats): fs.BigIntStats =>
        path === home || path.startsWith(home + "/")
          ? Object.assign(Object.create(stat), { uid: overrides.get(path) ?? BigInt(NATIVE_UID), gid: BigInt(NATIVE_GID) }) as fs.BigIntStats : stat,
      executables: () => executables,
      artifacts: () => ({
        producer: Buffer.from("// generated producer"), watchdog: Buffer.from("// generated watchdog"),
        deadline: Buffer.from("// generated deadline"), verifier: Buffer.from("// generated verifier"),
        serviceTemplate: "<plist>@@NODE_EXECUTABLE@@ @@WATCHDOG_FILE@@ @@PRODUCER_FILE@@ @@CONFIG_FILE@@</plist>",
      }),
      engineIdentity: async (input: Record<string, unknown>) => {
        calls.push({ kind: "engine", ...input });
        return { endpoint, daemonId: "selected-daemon", cachedSupervisor: cached,
          cachedRunner: cached, runnerCustodyVersion };
      },
      service: async (input: Record<string, unknown>) => { calls.push({ kind: "service", ...input }); },
      receiveBootstrap: async input => {
        calls.push({ kind: "bootstrap", supervisorImage: input.supervisorImage, verifierPath: input.verifierPath });
        const config = JSON.parse(fs.readFileSync(input.configPath, "utf8"));
        const authority = input.authority;
        const checkout = join(authority.thoughtsRoot, "custody-bootstrap", "catalyst", "custody-probe");
        const lock = join(authority.locksRoot, "custody-bootstrap");
        fs.mkdirSync(checkout, { recursive: true, mode: 0o750 });
        fs.mkdirSync(lock, { recursive: true, mode: 0o750 });
        const request = { version: 1, installationId: authority.installationId,
          nonce: (++nonceCount).toString(16).padStart(64, "0"), tenant: "custody-bootstrap",
          repository: "catalyst/custody-probe", issuedAtMs: NOW, expiresAtMs: input.deadlineMs };
        const engineCheckout = identity(checkout, 10001, 10001);
        const engineLock = identity(lock, 10001, 10001);
        const payload = canonical({
          version: 1, kind: "accepted", authority, request, observedAtMs: NOW,
          expiresAtMs: input.deadlineMs, nativeBootId: "native-boot", producerInstance: "c".repeat(64),
          nativeCheckout: identity(checkout, NATIVE_UID, NATIVE_GID), nativeLock: identity(lock, NATIVE_UID, NATIVE_GID),
          engineCheckout, engineLock,
        });
        const key = wrongSignature ? generateKeyPairSync("ed25519").privateKey :
          createPrivateKey({ key: fs.readFileSync(config.privateKeyFile), format: "der", type: "pkcs8" });
        return { bytes: Buffer.from(canonical({ version: 1, payload,
          signature: sign(null, Buffer.from(payload), key).toString("base64") })),
          request, engineCheckout, engineLock };
      },
    });
    const input = { dir, supervisorImage: SUPERVISOR, runnerImage: RUNNER, deadlineMs: NOW + 10_000 };
    return { dir, principal, overrides, calls, input, harness, executables,
      state: join(dirname(dir), "darwin-thoughts-custody"),
      setEndpoint: (value: string) => { endpoint = value; },
      setCached: (value: boolean) => { cached = value; },
      setRunnerCustodyVersion: (value: string | undefined) => { runnerCustodyVersion = value; },
      setWrongSignature: () => { wrongSignature = true; } };
  }
  it("exports a closed production installer", () => { expect(installDarwinThoughtsCustody).toBeTypeOf("function"); });
  it("accepts ordinary native0755 intermediates without broadening private signer/channel leaves", async () => {
    const f = fixture(); const local = join(home, ".local"); const share = join(local, "share");
    fs.mkdirSync(local, { mode: 0o755 }); fs.mkdirSync(share, { mode: 0o755 });
    const dir = join(share, "self-host"); fs.mkdirSync(dir, { mode: 0o750 });
    const result = await f.harness.install({ ...f.input, dir });
    expect(fs.lstatSync(local).mode & 0o7777).toBe(0o755);
    expect(fs.lstatSync(share).mode & 0o7777).toBe(0o755);
    for (const root of [dirname(result.configPath), result.requestsRoot, result.responsesRoot])
      expect(fs.lstatSync(root).mode & 0o7777).toBe(0o700);
  });
  it.each(["foreign", "writable", "group_writable", "symlink"])("refuses an unsafe native intermediate: %s", async (kind) => {
    const f = fixture(); const local = join(home, ".local");
    if (kind === "symlink") {
      const target = join(home, "native-outside");
      fs.mkdirSync(target, { mode: 0o755 }); fs.symlinkSync(target, local);
    } else fs.mkdirSync(local, { mode: 0o755 });
    const dir = join(local, "self-host"); fs.mkdirSync(dir, { mode: 0o750 });
    if (kind === "foreign") f.overrides.set(local, BigInt(FOREIGN_UID));
    else if (kind !== "symlink") fs.chmodSync(local, kind === "group_writable" ? 0o775 : 0o777);
    await expect(f.harness.install({ ...f.input, dir })).rejects.toThrow(/owner|custody|unsafe/);
    expect(f.calls).toEqual([]);
    if (kind === "symlink") expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    else expect(fs.lstatSync(local).mode & 0o7777).toBe(kind === "foreign" ? 0o755 : kind === "group_writable" ? 0o775 : 0o777);
  });
  it("refuses a0755 signer leaf instead of adopting it as an ordinary ancestor", async () => {
    const f = fixture(); await f.harness.install(f.input); f.calls.length = 0;
    fs.chmodSync(f.state, 0o755);
    await expect(f.harness.install(f.input)).rejects.toThrow(/custody|unsafe/);
    expect(f.calls).toEqual([]);
    expect(fs.lstatSync(f.state).mode & 0o7777).toBe(0o755);
  });
  it.each(["nodeExecutable", "dockerExecutable"] satisfies ("nodeExecutable" | "dockerExecutable")[])("refuses group-writable %s before Engine receiving", async (field) => {
    const f = fixture(); fs.chmodSync(f.executables[field], 0o775);
    await expect(f.harness.install(f.input)).rejects.toThrow(/executable_custody_unsafe/);
    expect(f.calls).toEqual([]);
    expect(fs.existsSync(join(f.state, "private-key.der"))).toBe(false);
    expect(fs.lstatSync(f.executables[field]).mode & 0o7777).toBe(0o775);
  });
  it("refuses an already-cancelled installer before any native state or Engine work", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.harness.install(f.input, controller.signal)).rejects.toThrow(/abort|cancel/);
    expect(f.calls).toEqual([]);
    expect(fs.existsSync(f.state)).toBe(false);
  });
  it("creates native private state and returns authority only after actual signed startup receiving", async () => {
    const f = fixture();
    const result = await f.harness.install(f.input);
    expect(result.authority).toMatchObject({ nativeUid: NATIVE_UID, nativeGid: NATIVE_GID, nativeHome: home,
      endpoint: "unix://" + join(home, "engine.sock"), thoughtsRoot: join(f.dir, "thoughts"), locksRoot: join(f.dir, "locks") });
    expect(result.requestsRoot).toBe(join(home, "darwin-thoughts-requests"));
    expect(result.responsesRoot).toBe(join(home, "darwin-thoughts-responses"));
    expect(JSON.parse(result.envAuthority)).toEqual(result.authority);
    expect(result.envAuthority).not.toContain("privateKey");
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    expect(Object.keys(config).sort()).toEqual(["authority", "dockerExecutable", "dockerExecutableSha256", "privateKeyFile", "supervisorImage", "version"]);
    expect(config.dockerExecutableSha256).toBe(createHash("sha256").update(fs.readFileSync(config.dockerExecutable)).digest("hex"));
    expect(config.dockerExecutable).toBe(f.executables.dockerExecutable);
    const runtime = JSON.parse(fs.readFileSync(join(f.state, "runtime.json"), "utf8"));
    expect(runtime.nodeExecutable).toBe(f.executables.nodeExecutable);
    expect(runtime.nodeExecutableSha256).toBe(createHash("sha256").update(fs.readFileSync(f.executables.nodeExecutable)).digest("hex"));
    for (const executable of Object.values(f.executables)) {
      expect(fs.lstatSync(executable).uid).toBe(PROCESS_UID);
      expect(fs.lstatSync(executable).mode & 0o7777).toBe(0o700);
    }
    expect(fs.lstatSync(f.state).mode & 0o7777).toBe(0o700);
    for (const file of ["producer.json", "private-key.der", "producer.mjs", "watchdog.mjs", "watchdog-deadline.mjs", "verifier.mjs"])
      expect(fs.lstatSync(join(f.state, file)).mode & 0o7777).toBe(0o600);
    expect(f.calls.map(call => call.kind)).toEqual(["engine", "service", "bootstrap"]);
    expect(f.calls.find(call => call.kind === "bootstrap")).toMatchObject({ verifierPath: join(f.state, "verifier.mjs") });
  });
  it("reuses the same config/key and receives another fresh nonce on recovery", async () => {
    const f = fixture(); const first = await f.harness.install(f.input);
    const config = fs.readFileSync(first.configPath);
    const keyFile = JSON.parse(config.toString()).privateKeyFile;
    const key = fs.readFileSync(keyFile);
    const second = await f.harness.install(f.input);
    expect(second.authority).toEqual(first.authority);
    expect(fs.readFileSync(first.configPath)).toEqual(config); expect(fs.readFileSync(keyFile)).toEqual(key);
    expect(f.calls.filter(call => call.kind === "bootstrap")).toHaveLength(2);
  });
  it("gives state enrolled before the verifier copy existed its copy, and refuses a changed one", async () => {
    const f = fixture(); await f.harness.install(f.input);
    const verifier = join(f.state, "verifier.mjs");
    fs.unlinkSync(verifier);
    await f.harness.install(f.input);
    expect(fs.readFileSync(verifier, "utf8")).toBe("// generated verifier");
    expect(fs.lstatSync(verifier).mode & 0o7777).toBe(0o600);
    fs.writeFileSync(verifier, "// substituted verifier");
    f.calls.length = 0;
    await expect(f.harness.install(f.input)).rejects.toThrow(/artifact_custody_mismatch/);
    expect(f.calls.filter(call => call.kind === "bootstrap")).toEqual([]);
  });
  it("re-attests an older enrolled helper on the current pin, replacing only the recorded image", async () => {
    const f = fixture(); const first = await f.harness.install(f.input);
    const runtimeSupervisor = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "c".repeat(64);
    const runtimeRunner = "ghcr.io/coalesce-labs/catalyst-runner@sha256:" + "d".repeat(64);
    const before = {
      key: fs.readFileSync(join(f.state, "private-key.der")),
      runtime: fs.readFileSync(join(f.state, "runtime.json")),
      producer: fs.readFileSync(join(f.state, "producer.mjs")),
      watchdog: fs.readFileSync(join(f.state, "watchdog.mjs")),
      deadline: fs.readFileSync(join(f.state, "watchdog-deadline.mjs")),
      plist: fs.readFileSync(join(home, "Library", "LaunchAgents", first.serviceLabel + ".plist")),
    };
    const enrolled = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
    f.calls.length = 0;
    const second = await f.harness.install({ ...f.input, supervisorImage: runtimeSupervisor, runnerImage: runtimeRunner });
    expect(second.authority).toEqual(first.authority);
    expect(fs.readFileSync(join(f.state, "private-key.der"))).toEqual(before.key);
    expect(fs.readFileSync(join(f.state, "runtime.json"))).toEqual(before.runtime);
    expect(fs.readFileSync(join(f.state, "producer.mjs"))).toEqual(before.producer);
    expect(fs.readFileSync(join(f.state, "watchdog.mjs"))).toEqual(before.watchdog);
    expect(fs.readFileSync(join(f.state, "watchdog-deadline.mjs"))).toEqual(before.deadline);
    expect(fs.readFileSync(join(home, "Library", "LaunchAgents", first.serviceLabel + ".plist"))).toEqual(before.plist);
    const reattested = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
    expect(reattested).toEqual({ ...enrolled, supervisorImage: runtimeSupervisor });
    expect(fs.lstatSync(first.configPath).mode & 0o7777).toBe(0o600);
    expect(f.calls.find(call => call.kind === "engine")).toMatchObject({
      supervisorImage: runtimeSupervisor, runnerImage: runtimeRunner,
    });
    expect(f.calls.find(call => call.kind === "engine")).not.toHaveProperty("producerSupervisorImage");
    expect(f.calls.find(call => call.kind === "bootstrap")).toMatchObject({ supervisorImage: runtimeSupervisor });
    expect(f.calls.map(call => call.kind)).toEqual(["engine", "service", "bootstrap"]);
  });
  it("re-attests without any Engine work on the evicted enrolled digest", async () => {
    const f = fixture(); await f.harness.install(f.input);
    const runtimeSupervisor = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "e".repeat(64);
    f.calls.length = 0;
    const second = await f.harness.install({ ...f.input, supervisorImage: runtimeSupervisor });
    expect(second.authority).toBeDefined();
    expect(JSON.parse(fs.readFileSync(second.configPath, "utf8")).supervisorImage).toBe(runtimeSupervisor);
    expect(f.calls.filter(call => call.kind === "engine")).toHaveLength(1);
    expect(f.calls.find(call => call.kind === "engine")).not.toHaveProperty("producerSupervisorImage");
    expect(f.calls.map(call => call.kind)).toEqual(["engine", "service", "bootstrap"]);
  });
  it.each(["foreign repository", "unpinned", "malformed"])("refuses an invalid saved producer helper: %s", async kind => {
    const f = fixture(); const first = await f.harness.install(f.input);
    const config = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
    config.supervisorImage = kind === "foreign repository" ? SUPERVISOR.replace("coalesce-labs", "foreign") :
      kind === "unpinned" ? "ghcr.io/coalesce-labs/catalyst-supervisor:latest" : null;
    fs.writeFileSync(first.configPath, canonical(config)); const unchanged = fs.readFileSync(first.configPath);
    f.calls.length = 0;
    await expect(f.harness.install(f.input)).rejects.toThrow(/authority|image_pin/);
    expect(f.calls).toEqual([]);
    expect(fs.readFileSync(first.configPath)).toEqual(unchanged);
  });
  it.each(["uid", "euid", "home"] satisfies ("uid" | "euid" | "home")[])("refuses a changed actual native %s before bootstrap", async (field) => {
    const f = fixture(); await f.harness.install(f.input); f.calls.length = 0;
    if (field === "home") f.principal.home = join(home, "different"); else f.principal[field] = FOREIGN_UID;
    await expect(f.harness.install(f.input)).rejects.toThrow(/principal|authority|owner/);
    expect(f.calls).toEqual([]);
  });
  it("refuses another native owner's thoughts root rather than adopting/chowning", async () => {
    const f = fixture(); fs.mkdirSync(join(f.dir, "thoughts"), { mode: 0o750 });
    f.overrides.set(join(f.dir, "thoughts"), BigInt(FOREIGN_UID));
    await expect(f.harness.install(f.input)).rejects.toThrow(/owner|custody/);
    expect(fs.lstatSync(join(f.dir, "thoughts")).mode & 0o7777).toBe(0o750);
    expect(f.calls).toEqual([]);
  });
  it("does not rekey a missing private key beside existing authority", async () => {
    const f = fixture(); const result = await f.harness.install(f.input); f.calls.length = 0;
    const config = fs.readFileSync(result.configPath); const key = JSON.parse(config.toString()).privateKeyFile;
    fs.unlinkSync(key);
    await expect(f.harness.install(f.input)).rejects.toThrow(/key|custody|state/);
    expect(fs.existsSync(key)).toBe(false); expect(fs.readFileSync(result.configPath)).toEqual(config);
    expect(f.calls).toEqual([]);
  });
  it.each(["remote", "missing_cache"])("refuses %s Engine receiving without pull or new authority", async (kind) => {
    const f = fixture();
    if (kind === "remote") f.setEndpoint("tcp://attacker:2375"); else f.setCached(false);
    await expect(f.harness.install(f.input)).rejects.toThrow(/engine|cache|endpoint/);
    expect(fs.existsSync(join(f.state, "private-key.der"))).toBe(false);
    expect(f.calls.filter(call => call.kind !== "engine")).toEqual([]);
  });
  it("refuses startup bytes signed by a key not pinned by the installation", async () => {
    const f = fixture(); f.setWrongSignature();
    await expect(f.harness.install(f.input)).rejects.toThrow(/custody|signature|proof/);
    expect(f.calls.map(call => call.kind)).toEqual(["engine", "service", "bootstrap"]);
  });
  it.each([undefined, "v2"])("refuses a cached runner without the exact custody v1 label: %s", async (label) => {
    const f = fixture(); f.setRunnerCustodyVersion(label);
    await expect(f.harness.install(f.input)).rejects.toThrow(/runner|custody|label/);
    expect(fs.existsSync(join(f.state, "private-key.der"))).toBe(false);
    expect(f.calls.map(call => call.kind)).toEqual(["engine"]);
  });
});
