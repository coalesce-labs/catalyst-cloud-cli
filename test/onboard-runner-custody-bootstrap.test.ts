import fs from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { darwinThoughtsInstallAdvice, darwinThoughtsInstallException, darwinThoughtsInstallRefusal, receiveDarwinThoughtsBootstrapForTest } from "../src/onboard-runner-custody.js";
import {
  canonicalDarwinThoughtsJson,
  deriveDarwinThoughtsTargets,
  verifyDarwinThoughtsCustodyResponse,
} from "../vendor/self-host/darwin-thoughts-custody/verifier.mjs";

const PROCESS_UID = process.getuid?.();
const PROCESS_GID = process.getgid?.();
if (PROCESS_UID === undefined || PROCESS_GID === undefined) throw Error("native fixture requires POSIX identity");
const NATIVE_UID = PROCESS_UID === 0 ? 501 : PROCESS_UID;
const NATIVE_GID = PROCESS_UID === 0 ? 20 : PROCESS_GID;

const IMAGE = "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:" + "a".repeat(64);
const IMAGE_ID = "sha256:" + "d".repeat(64);
const CID = "c".repeat(64);
const LABEL = "dev.catalystcloud.custody-token";
const VENDORED_VERIFIER = join(import.meta.dirname, "..", "vendor", "self-host", "darwin-thoughts-custody", "verifier.mjs");
// Docker Desktop's own words when a bind source sits outside its file sharing (npm under Homebrew).
const MOUNTS_DENIED = "docker: Error response from daemon: mounts denied: \nThe path /opt/homebrew/lib/node_modules/@catalyst-cloud/cli/vendor/self-host/darwin-thoughts-custody/verifier.mjs is not shared from the host and is not known to Docker.\nYou can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.";
type Mode = "complete" | "ack-timeout" | "ack-invalid" | "foreign-label" |
  "foreign-image" | "foreign-name" | "foreign-cache" | "foreign-daemon" |
  "rm-noop" | "late-create" | "proof-refused" | "unknown-refusal" | "create-refused" | "create-refused-persisted" | "create-transport-eof";
interface State {
  mode: Mode; calls: string[][]; created?: string[]; removed: boolean; inspectCount: number;
  row?: { Id: string; Name: string; Image: string; Config: { Image: string; Labels: Record<string, string> } };
}
function identity(path: string, uid: number, gid: number) {
  const stat = fs.lstatSync(path, { bigint: true });
  return { path, device: String(stat.dev), inode: String(stat.ino), uid, gid,
    mode: Number(stat.mode & 0o7777n), isDirectory: true as const, isSymbolicLink: false as const };
}

describe("production custody bootstrap helper ACK and cleanup", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "custody-bootstrap-ack-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function fixture(mode: Mode) {
    const stateRoot = join(home, "signer"); fs.mkdirSync(stateRoot, { mode: 0o700 });
    const key = generateKeyPairSync("ed25519");
    const authority = {
      version: 1 as const, installationId: "a".repeat(64),
      publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      nativeUid: NATIVE_UID, nativeGid: NATIVE_GID, nativeHome: home,
      endpoint: "unix://" + join(home, "engine.sock"), daemonId: "selected-daemon",
      thoughtsRoot: join(home, "thoughts"), locksRoot: join(home, "locks"),
      requestsRoot: join(home, "requests"), responsesRoot: join(home, "responses"),
    };
    for (const root of [authority.thoughtsRoot, authority.locksRoot, authority.requestsRoot, authority.responsesRoot])
      fs.mkdirSync(root, { mode: 0o700 });
    const targets = deriveDarwinThoughtsTargets(authority, "custody-bootstrap", "catalyst/custody-probe");
    fs.mkdirSync(targets.checkoutSource, { recursive: true, mode: 0o750 });
    fs.mkdirSync(targets.lockSource, { recursive: true, mode: 0o750 });
    const now = Date.now();
    const deadlineMs = now + (mode === "ack-timeout" ? 700 : 10_000);
    const request = { version: 1 as const, installationId: authority.installationId,
      nonce: "b".repeat(64), tenant: "custody-bootstrap", repository: "catalyst/custody-probe",
      issuedAtMs: now, expiresAtMs: deadlineMs };
    const engineCheckout = identity(targets.checkoutSource, 10001, 10001);
    const engineLock = identity(targets.lockSource, 10001, 10001);
    const payload = canonicalDarwinThoughtsJson({ version: 1, kind: "accepted", authority, request,
      observedAtMs: now, expiresAtMs: deadlineMs, nativeBootId: "native-boot",
      producerInstance: "e".repeat(64), nativeCheckout: identity(targets.checkoutSource, NATIVE_UID, NATIVE_GID),
      nativeLock: identity(targets.lockSource, NATIVE_UID, NATIVE_GID), engineCheckout, engineLock });
    const bytes = Buffer.from(canonicalDarwinThoughtsJson({ version: 1, payload,
      signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64") }));
    const proof = { bytes: bytes.toString("base64"), request, engineCheckout, engineLock };
    const statePath = join(home, "engine-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ mode, calls: [], removed: false, inspectCount: 0 }), { mode: 0o600 });
    const dockerExecutable = join(home, "fixed-docker");
    const script = `#!${fs.realpathSync(process.execPath)}
      const fs=require('node:fs'),file=${JSON.stringify(statePath)},state=JSON.parse(fs.readFileSync(file,'utf8'));
      const raw=process.argv.slice(2),args=raw.slice(4);state.calls.push(raw);
      const save=()=>fs.writeFileSync(file,JSON.stringify(state),{mode:384});const out=value=>{save();process.stdout.write(value+'\\n')};
      if(raw[0]!=='--config'||raw[2]!=='--host'||raw[3]!==${JSON.stringify(authority.endpoint)})throw Error('fixture_unscoped_cli');
      if(args[0]==='image')out(state.row&&state.mode==='foreign-cache'?'sha256:'+'f'.repeat(64):${JSON.stringify(IMAGE_ID)});
      else if(args[0]==='info')out(state.row&&state.mode==='foreign-daemon'?'foreign-daemon':${JSON.stringify(authority.daemonId)});
      else if(args[0]==='create'){
        const labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const value=args[++i],at=value.indexOf('=');labels[value.slice(0,at)]=value.slice(at+1)}
        state.created=args;
        if(state.mode==='create-refused'){save();process.stderr.write(${JSON.stringify(MOUNTS_DENIED)}+'\\n');process.exit(125);}
        state.row={Id:${JSON.stringify(CID)},Name:'/'+args[args.indexOf('--name')+1],Image:${JSON.stringify(IMAGE_ID)},Config:{Image:${JSON.stringify(IMAGE)},Labels:labels}};save();
        if(state.mode==='create-transport-eof'){save();process.stderr.write('error during connect: Post "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/create": unexpected EOF\\n');process.exit(1);}
        if(state.mode==='create-refused-persisted'){save();process.stderr.write('Error response from daemon: unexpected engine failure\\n');process.exit(125);}
        if(state.mode==='ack-timeout'){setInterval(()=>{},100);setTimeout(()=>process.exit(0),5000);}
        else if(['ack-invalid','late-create','foreign-label','foreign-image','foreign-name','foreign-cache','foreign-daemon'].includes(state.mode))out('invalid-create-ack');
        else out(${JSON.stringify(CID)});
      }
      else if(args[0]==='inspect'){
        const target=args.at(-1);state.inspectCount++;
        if(!state.row||state.removed||![state.row.Id,state.row.Name,state.row.Name.slice(1)].includes(target)||(['late-create','create-transport-eof'].includes(state.mode)&&state.inspectCount===1)){
          save();process.stderr.write('Error: No such container: '+target+'\\n');process.exit(1);
        }
        const row=JSON.parse(JSON.stringify(state.row));
        if(state.mode==='foreign-label')row.Config.Labels[${JSON.stringify(LABEL)}]='foreign-token';
        if(state.mode==='foreign-image')row.Config.Image='foreign@sha256:'+'f'.repeat(64);
        if(state.mode==='foreign-name')row.Name+='-foreign';
        if(args.includes('--format'))out(row.Id+' '+row.Config.Labels[${JSON.stringify(LABEL)}]);
        else out(JSON.stringify([row]));
      }
      else if(args[0]==='ps')out(state.row&&!state.removed&&!(state.mode==='create-transport-eof'&&state.inspectCount<2)?state.row.Id:'');
      else if(args[0]==='start'){
        if(args.at(-1)!==${JSON.stringify(CID)})throw Error('fixture_foreign_start');
        if(state.mode==='proof-refused'||state.mode==='unknown-refusal'){
          save();process.stderr.write('darwin_thoughts_custody:'+(state.mode==='proof-refused'?'file_owner':'secret_lowercase_value')+'\\nprivate credential payload must never appear\\n');process.exit(1);
        }
        out(JSON.stringify(${JSON.stringify(proof)}));
      }
      else if(args[0]==='rm'){
        if(args.length!==3||args[1]!=='--force'||args[2]!==${JSON.stringify(CID)})throw Error('fixture_nonexact_delete');
        if(state.mode!=='rm-noop')state.removed=true;out(${JSON.stringify(CID)});
      }
      else throw Error('fixture_unexpected_cli:'+JSON.stringify(args));
    `;
    fs.writeFileSync(dockerExecutable, script, { mode: 0o700 });
    const configPath = join(stateRoot, "producer.json");
    fs.writeFileSync(configPath, canonicalDarwinThoughtsJson({ version: 1, authority,
      dockerExecutable, dockerExecutableSha256: createHash("sha256").update(fs.readFileSync(dockerExecutable)).digest("hex") }), { mode: 0o600 });
    const verifierPath = join(stateRoot, "verifier.mjs");
    fs.copyFileSync(VENDORED_VERIFIER, verifierPath); fs.chmodSync(verifierPath, 0o600);
    const state = (): State => JSON.parse(fs.readFileSync(statePath, "utf8")) as State;
    return { authority, request, targets, state, input: { authority, configPath, verifierPath, supervisorImage: IMAGE,
      deadlineMs, nodeExecutable: fs.realpathSync(process.execPath), dockerExecutable } };
  }
  function commands(state: State) { return state.calls.map(call => call.slice(4)); }
  function receivedIdentity(state: State) {
    const args = state.created!;
    const name = args[args.indexOf("--name") + 1]!;
    expect(name).toMatch(/^catalyst-custody-bootstrap-[a-f0-9]{32}$/);
    const label = args[args.indexOf("--label") + 1]!;
    expect(label).toMatch(/^dev\.catalystcloud\.custody-token=[a-f0-9]{64}$/);
    expect(label).not.toContain("b".repeat(64));
    expect(commands(state)).toContainEqual(["inspect", name]);
    expect(commands(state).some(args => args[0] === "info")).toBe(true);
    expect(commands(state).some(args => args[0] === "image" && args.at(-1) === IMAGE)).toBe(true);
  }
  function removedAndAbsent(state: State) {
    const calls = commands(state);
    const selector = ["ps", "--all", "--no-trunc", "--quiet", "--filter", "id=" + CID];
    const rm = calls.findIndex(args => args[0] === "rm");
    expect(calls[rm]).toEqual(["rm", "--force", CID]);
    expect(calls.slice(0, rm)).toContainEqual(selector);
    expect(calls.slice(rm + 1)).toContainEqual(selector);
    expect(state.removed).toBe(true);
  }

  it("positive control receives an actual signed proof through the fixed executable", async () => {
    const f = fixture("complete"); const result = await receiveDarwinThoughtsBootstrapForTest(f.input);
    expect(verifyDarwinThoughtsCustodyResponse(result.bytes, { authority: f.authority, request: f.request,
      nowMs: Date.now(), engineCheckout: result.engineCheckout as ReturnType<typeof identity>,
      engineLock: result.engineLock as ReturnType<typeof identity> })).toMatchObject({ kind: "accepted" });
    const state = f.state();
    expect(state.row?.Id).toBe(CID);
    expect(commands(state)).toContainEqual(["rm", "--force", CID]);
    expect(state.removed).toBe(true);
    expect(commands(state).every(args => !args.includes("pull"))).toBe(true);
  });
  it.each(["ack-timeout", "ack-invalid", "late-create"] as const)("recovers only its exact persisted helper after %s", async mode => {
    const f = fixture(mode);
    await expect(receiveDarwinThoughtsBootstrapForTest(f.input)).rejects.toThrow(/bootstrap_create_unreceived/);
    const state = f.state(); receivedIdentity(state); removedAndAbsent(state);
    if (mode === "late-create") expect(state.inspectCount).toBeGreaterThanOrEqual(2);
  });
  it.each(["foreign-label", "foreign-image", "foreign-name", "foreign-cache", "foreign-daemon"] as const)("refuses cleanup of a helper with %s identity", async mode => {
    const f = fixture(mode);
    await expect(receiveDarwinThoughtsBootstrapForTest(f.input)).rejects.toThrow(/bootstrap_cleanup_unproved/);
    const state = f.state();
    expect(state.row?.Id).toBe(CID);
    expect(commands(state).filter(args => args[0] === "rm")).toEqual([]);
    expect(state.removed).toBe(false);
  });
  it("refuses a successful rm ACK when the exact CID is still present", async () => {
    const f = fixture("rm-noop");
    await expect(receiveDarwinThoughtsBootstrapForTest(f.input)).rejects.toThrow(/bootstrap_cleanup_unproved/);
    expect(commands(f.state())).toContainEqual(["rm", "--force", CID]);
    expect(f.state().removed).toBe(false);
  });
  it("keeps the signed-response channel read-only in the actual create argv", async () => {
    const f = fixture("complete"); await receiveDarwinThoughtsBootstrapForTest(f.input);
    const args = f.state().created!;
    const mounts = args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]!] : []);
    expect(mounts).toContain("type=bind,src=" + f.authority.responsesRoot + ",dst=" + f.authority.responsesRoot + ",readonly");
    expect(mounts).toContain("type=bind,src=" + f.authority.requestsRoot + ",dst=" + f.authority.requestsRoot);
  });
  it("mounts the verifier copy from custody state, never from the package install path", async () => {
    const f = fixture("complete"); await receiveDarwinThoughtsBootstrapForTest(f.input);
    const args = f.state().created!;
    const mounts = args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]!] : []);
    expect(mounts).toContain("type=bind,src=" + f.input.verifierPath + ",dst=/custody-verifier.mjs,readonly");
    expect(mounts.some(mount => mount.includes("/vendor/"))).toBe(false);
  });
  it("refuses a verifier copy that no longer matches the vendored hash, before any create", async () => {
    const f = fixture("complete"); fs.appendFileSync(f.input.verifierPath, "\n// substituted");
    await expect(receiveDarwinThoughtsBootstrapForTest(f.input)).rejects.toThrow(/bootstrap_verifier_unreceived/);
    expect(f.state().calls).toEqual([]);
  });
  it("keeps Docker's create refusal once it proves nothing persisted", async () => {
    const f = fixture("create-refused");
    let error: unknown;
    try { await receiveDarwinThoughtsBootstrapForTest(f.input); } catch (caught) { error = caught; }
    expect(darwinThoughtsInstallRefusal(error)).toBe("bootstrap_create_refused:file_sharing");
    expect(darwinThoughtsInstallAdvice(error)).toMatch(/File sharing/);
    expect(String(error)).not.toContain("/opt/homebrew");
    const state = f.state(); const calls = commands(state);
    const label = state.created![state.created!.indexOf("--label") + 1]!;
    const create = calls.findIndex(args => args[0] === "create");
    expect(calls.slice(create + 1)).toContainEqual(["ps", "--all", "--no-trunc", "--quiet", "--filter", "label=" + label]);
    expect(state.row).toBeUndefined();
    expect(calls.filter(args => ["start", "rm"].includes(args[0]!))).toEqual([]);
  });
  it("treats a create transport failure as unreceived and recovers a helper the daemon persisted late", async () => {
    const f = fixture("create-transport-eof");
    let error: unknown;
    try { await receiveDarwinThoughtsBootstrapForTest(f.input); } catch (caught) { error = caught; }
    expect(darwinThoughtsInstallRefusal(error)).toBe("bootstrap_create_unreceived");
    expect(darwinThoughtsInstallAdvice(error)).toBeUndefined();
    const state = f.state(); receivedIdentity(state); removedAndAbsent(state);
    expect(state.inspectCount).toBeGreaterThanOrEqual(2);
  });
  it("still recovers and removes a helper the Engine persisted despite a create refusal", async () => {
    const f = fixture("create-refused-persisted");
    let error: unknown;
    try { await receiveDarwinThoughtsBootstrapForTest(f.input); } catch (caught) { error = caught; }
    expect(darwinThoughtsInstallRefusal(error)).toBe("bootstrap_create_refused");
    expect(darwinThoughtsInstallAdvice(error)).toBeUndefined();
    const state = f.state(); receivedIdentity(state); removedAndAbsent(state);
  });
  it.each(["proof-refused", "unknown-refusal"] as const)("receives only a closed refusal code and still removes its helper: %s", async mode => {
    const f = fixture(mode);
    let error: unknown;
    try { await receiveDarwinThoughtsBootstrapForTest(f.input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(darwinThoughtsInstallRefusal(error)).toBe(mode === "proof-refused" ? "bootstrap_proof_refused:file_owner" : "bootstrap_proof_refused");
    expect(String(error)).not.toContain("private credential");
    expect(darwinThoughtsInstallException(error)).toMatchObject({ custodyErrorClass: "CustodyInstallError", custodyErrorMessage: String(error).replace(/^CustodyInstallError: /, ""), custodyErrorMessageRedacted: false });
    removedAndAbsent(f.state());
  });
  it("never treats an arbitrary error message as a safe installer refusal", () => {
    expect(darwinThoughtsInstallRefusal(Error("darwin_thoughts_custody_install:private credential payload"))).toBeUndefined();
  });
});
