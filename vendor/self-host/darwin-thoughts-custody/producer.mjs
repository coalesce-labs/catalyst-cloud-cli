// packages/host-isolation/src/darwin-thoughts-producer.ts
import fs from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign
} from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";

// packages/protocol/src/darwin-thoughts-custody.ts
var DARWIN_THOUGHTS_CUSTODY_VERSION = 1;
var DARWIN_THOUGHTS_PRIVATE_ROOT = "/run/catalyst-thoughts-private";
var DARWIN_THOUGHTS_MAX_EXCHANGE_MS = 30000;
var DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES = 16384;
var AUTHORITY_FIELDS = [
  "version",
  "installationId",
  "publicKey",
  "nativeUid",
  "nativeGid",
  "nativeHome",
  "endpoint",
  "daemonId",
  "thoughtsRoot",
  "locksRoot",
  "requestsRoot",
  "responsesRoot"
];
var REQUEST_FIELDS = [
  "version",
  "installationId",
  "nonce",
  "tenant",
  "repository",
  "issuedAtMs",
  "expiresAtMs"
];
var RESPONSE_FIELDS = [
  "version",
  "kind",
  "authority",
  "request",
  "observedAtMs",
  "expiresAtMs",
  "nativeBootId",
  "producerInstance"
];
var STAT_FIELDS = [
  "path",
  "device",
  "inode",
  "uid",
  "gid",
  "mode",
  "isDirectory",
  "isSymbolicLink"
];
var HEX_NONCE = /^[a-f0-9]{64}$/;
var TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
var TENANT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
var OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
var REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
var PUBLIC_KEY = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
var UINT64_MAX = "18446744073709551615";
var MAX_PATH_CHARS = 4096;
function invalid(reason) {
  throw new Error(reason);
}
function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function exact(value, required, optional, reason) {
  if (!plainRecord(value))
    return invalid(reason);
  const fields = Reflect.ownKeys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || fields.some((key) => typeof key !== "string" || !required.includes(key) && !optional.includes(key)) || fields.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value")))
    return invalid(reason);
  return value;
}
function matches(value, pattern, reason) {
  if (typeof value !== "string" || !pattern.test(value))
    return invalid(reason);
  return value;
}
function integer(value, min, max, reason) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid(reason);
  return value;
}
function path(value, reason) {
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS || !value.startsWith("/") || value === "/" || value.endsWith("/") || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.slice(1).split("/").some((part) => part === "" || part === "." || part === ".."))
    return invalid(reason);
  return value;
}
function below(child, parent) {
  return child.startsWith(parent + "/");
}
function tuple(tenant, repository, reason) {
  const tenantName = matches(tenant, TENANT, reason);
  if (typeof repository !== "string" || repository.length > 201)
    return invalid(reason);
  const parts = repository.split("/");
  const owner = matches(parts[0], OWNER, reason);
  const name = matches(parts[1], REPOSITORY, reason);
  if (parts.length !== 2 || name === "." || name === "..")
    return invalid(reason);
  return { tenant: tenantName, repository: owner + "/" + name };
}
function parseDarwinThoughtsAuthority(value) {
  const reason = "darwin_thoughts_authority_invalid";
  const row = exact(value, AUTHORITY_FIELDS, [], reason);
  if (row.version !== DARWIN_THOUGHTS_CUSTODY_VERSION)
    return invalid(reason);
  const nativeHome = path(row.nativeHome, reason);
  const thoughtsRoot = path(row.thoughtsRoot, reason);
  const locksRoot = path(row.locksRoot, reason);
  const requestsRoot = path(row.requestsRoot, reason);
  const responsesRoot = path(row.responsesRoot, reason);
  const roots = [thoughtsRoot, locksRoot, requestsRoot, responsesRoot];
  if (roots.some((root) => !below(root, nativeHome)) || roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && (root === other || below(root, other) || below(other, root)))))
    return invalid(reason);
  if (typeof row.endpoint !== "string" || !row.endpoint.startsWith("unix://"))
    return invalid(reason);
  const endpoint = "unix://" + path(row.endpoint.slice(7), reason);
  return Object.freeze({
    version: DARWIN_THOUGHTS_CUSTODY_VERSION,
    installationId: matches(row.installationId, HEX_NONCE, reason),
    publicKey: matches(row.publicKey, PUBLIC_KEY, reason),
    nativeUid: integer(row.nativeUid, 1, 4294967294, reason),
    nativeGid: integer(row.nativeGid, 0, 4294967294, reason),
    nativeHome,
    endpoint,
    daemonId: matches(row.daemonId, TOKEN, reason),
    thoughtsRoot,
    locksRoot,
    requestsRoot,
    responsesRoot
  });
}
function deriveDarwinThoughtsTargets(authority, tenant, repository) {
  const installed = parseDarwinThoughtsAuthority(authority);
  const selected = tuple(tenant, repository, "darwin_thoughts_tuple_invalid");
  const suffix = selected.tenant + "/" + selected.repository;
  const privateRoot = DARWIN_THOUGHTS_PRIVATE_ROOT;
  return Object.freeze({
    checkoutSource: installed.thoughtsRoot + "/" + suffix,
    lockSource: installed.locksRoot + "/" + selected.tenant,
    requestSource: installed.requestsRoot + "/" + suffix,
    responseSource: installed.responsesRoot + "/" + suffix,
    publicCheckoutTarget: "/srv/catalyst/tenants/" + selected.tenant + "/repos/" + selected.repository,
    privateCheckoutTarget: privateRoot + "/checkouts/" + suffix,
    privateLockTarget: privateRoot + "/locks/" + selected.tenant,
    privateRequestTarget: privateRoot + "/requests/" + suffix,
    privateResponseTarget: privateRoot + "/responses/" + suffix
  });
}
function parseDarwinThoughtsRequest(value) {
  const reason = "darwin_thoughts_request_invalid";
  const row = exact(value, REQUEST_FIELDS, [], reason);
  if (row.version !== DARWIN_THOUGHTS_CUSTODY_VERSION)
    return invalid(reason);
  const selected = tuple(row.tenant, row.repository, reason);
  const issuedAtMs = integer(row.issuedAtMs, 1, Number.MAX_SAFE_INTEGER, reason);
  const expiresAtMs = integer(row.expiresAtMs, 1, Number.MAX_SAFE_INTEGER, reason);
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > DARWIN_THOUGHTS_MAX_EXCHANGE_MS)
    return invalid(reason);
  return Object.freeze({
    version: DARWIN_THOUGHTS_CUSTODY_VERSION,
    installationId: matches(row.installationId, HEX_NONCE, reason),
    nonce: matches(row.nonce, HEX_NONCE, reason),
    ...selected,
    issuedAtMs,
    expiresAtMs
  });
}
function decimal(value, nonzero, reason) {
  const text = matches(value, /^(0|[1-9][0-9]{0,19})$/, reason);
  if (nonzero && text === "0" || text.length === 20 && text > UINT64_MAX)
    return invalid(reason);
  return text;
}
function statIdentity(value, expectedPath, authority, native, git) {
  const reason = "darwin_thoughts_response_invalid";
  const row = exact(value, STAT_FIELDS, [], reason);
  const observedPath = path(row.path, reason);
  const uid = integer(row.uid, 0, 4294967294, reason);
  const gid = integer(row.gid, 0, 4294967294, reason);
  const mode = integer(row.mode, 0, 4095, reason);
  if (observedPath !== expectedPath || row.isDirectory !== true || row.isSymbolicLink !== false || (native ? uid !== authority.nativeUid || gid !== authority.nativeGid : uid !== 0 && uid !== 10001) || (mode & 448) !== 448 || (mode & 3602) !== 0 || !git && (mode & 7) !== 0)
    return invalid(reason);
  return Object.freeze({
    path: observedPath,
    device: decimal(row.device, false, reason),
    inode: decimal(row.inode, true, reason),
    uid,
    gid,
    mode,
    isDirectory: true,
    isSymbolicLink: false
  });
}
function parseDarwinThoughtsResponse(value, context) {
  const reason = "darwin_thoughts_response_invalid";
  try {
    const basic = exact(value, RESPONSE_FIELDS, [
      "nativeCheckout",
      "nativeLock",
      "engineCheckout",
      "engineLock",
      "nativeGit",
      "engineGit",
      "reason"
    ], reason);
    if (basic.version !== DARWIN_THOUGHTS_CUSTODY_VERSION)
      return invalid(reason);
    const authority = parseDarwinThoughtsAuthority(basic.authority);
    const request = parseDarwinThoughtsRequest(basic.request);
    const installed = parseDarwinThoughtsAuthority(context.authority);
    const expected = parseDarwinThoughtsRequest(context.request);
    const nowMs = integer(context.nowMs, 1, Number.MAX_SAFE_INTEGER, reason);
    if (canonicalDarwinThoughtsJson(authority) !== canonicalDarwinThoughtsJson(installed) || canonicalDarwinThoughtsJson(request) !== canonicalDarwinThoughtsJson(expected) || request.installationId !== authority.installationId || request.issuedAtMs > nowMs || request.expiresAtMs <= nowMs)
      return invalid(reason);
    const observedAtMs = integer(basic.observedAtMs, 1, Number.MAX_SAFE_INTEGER, reason);
    const expiresAtMs = integer(basic.expiresAtMs, 1, Number.MAX_SAFE_INTEGER, reason);
    if (observedAtMs < request.issuedAtMs || observedAtMs > nowMs || expiresAtMs <= observedAtMs || expiresAtMs <= nowMs || expiresAtMs > request.expiresAtMs)
      return invalid(reason);
    const binding = {
      version: DARWIN_THOUGHTS_CUSTODY_VERSION,
      authority,
      request,
      observedAtMs,
      expiresAtMs,
      nativeBootId: matches(basic.nativeBootId, TOKEN, reason),
      producerInstance: matches(basic.producerInstance, HEX_NONCE, reason)
    };
    if (basic.kind === "refused") {
      const row = exact(value, [...RESPONSE_FIELDS, "reason"], [], reason);
      return Object.freeze({
        ...binding,
        kind: "refused",
        reason: matches(row.reason, /^[a-z][a-z0-9_]{0,127}$/, reason)
      });
    }
    if (basic.kind !== "accepted")
      return invalid(reason);
    const row = exact(value, [...RESPONSE_FIELDS, "nativeCheckout", "nativeLock", "engineCheckout", "engineLock"], ["nativeGit", "engineGit"], reason);
    const paths = deriveDarwinThoughtsTargets(authority, request.tenant, request.repository);
    const hasGit = Object.hasOwn(row, "nativeGit");
    if (hasGit !== Object.hasOwn(row, "engineGit"))
      return invalid(reason);
    return Object.freeze({
      ...binding,
      kind: "accepted",
      nativeCheckout: statIdentity(row.nativeCheckout, paths.checkoutSource, authority, true, false),
      nativeLock: statIdentity(row.nativeLock, paths.lockSource, authority, true, false),
      engineCheckout: statIdentity(row.engineCheckout, paths.checkoutSource, authority, false, false),
      engineLock: statIdentity(row.engineLock, paths.lockSource, authority, false, false),
      ...hasGit ? {
        nativeGit: statIdentity(row.nativeGit, paths.checkoutSource + "/.git", authority, true, true),
        engineGit: statIdentity(row.engineGit, paths.checkoutSource + "/.git", authority, false, true)
      } : {}
    });
  } catch {
    return invalid(reason);
  }
}
function utf8Bytes(text, reason) {
  let size = 0;
  for (let index = 0;index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char <= 127)
      size++;
    else if (char <= 2047)
      size += 2;
    else if (char >= 55296 && char <= 56319) {
      const next = text.charCodeAt(++index);
      if (!(next >= 56320 && next <= 57343))
        return invalid(reason);
      size += 4;
    } else {
      if (char >= 56320 && char <= 57343)
        return invalid(reason);
      size += 3;
    }
  }
  return size;
}
function canonicalDarwinThoughtsJson(value) {
  const reason = "darwin_thoughts_json_invalid";
  const seen = new Set;
  let nodes = 0;
  function encode(input, depth) {
    if (++nodes > 4096 || depth > 16)
      return invalid(reason);
    if (input === null)
      return "null";
    if (typeof input === "boolean")
      return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input) || Object.is(input, -0))
        return invalid(reason);
      return String(input);
    }
    if (typeof input === "string") {
      if (utf8Bytes(input, reason) > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES)
        return invalid(reason);
      return JSON.stringify(input);
    }
    if (typeof input !== "object" || seen.has(input))
      return invalid(reason);
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const keys = Reflect.ownKeys(input);
        if (input.length > 4096 || Object.keys(input).length !== input.length || keys.length !== input.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, "value"))))
          return invalid(reason);
        return "[" + input.map((item) => encode(item, depth + 1)).join(",") + "]";
      }
      if (!plainRecord(input) || Reflect.ownKeys(input).some((key) => typeof key !== "string"))
        return invalid(reason);
      const keys = Object.keys(input).sort();
      if (keys.length > 4096 || Reflect.ownKeys(input).length !== keys.length)
        return invalid(reason);
      return "{" + keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          return invalid(reason);
        return JSON.stringify(key) + ":" + encode(descriptor.value, depth + 1);
      }).join(",") + "}";
    } finally {
      seen.delete(input);
    }
  }
  const result = encode(value, 0);
  if (utf8Bytes(result, reason) > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES)
    return invalid(reason);
  return result;
}

// packages/host-isolation/src/darwin-thoughts-producer.ts
class ProducerError extends Error {
  reason;
  constructor(reason) {
    super("darwin_thoughts_producer:" + reason);
    this.reason = reason;
  }
}
function fail(reason) {
  throw new ProducerError(reason);
}
function canonicalPath(value, reason) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/" || value.includes("\x00") || value.endsWith("/"))
    fail(reason);
  return value;
}
function below2(path, root) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
function within(path, root) {
  return path === root || below2(path, root);
}
function exact2(value, fields, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(reason);
  const row = value;
  if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key)))
    fail(reason);
  return row;
}
function parseCanonical(bytes, reason) {
  try {
    const text = bytes.toString("utf8");
    const value = JSON.parse(text);
    if (!Buffer.from(text).equals(bytes) || canonicalDarwinThoughtsJson(value) !== text)
      fail(reason);
    return value;
  } catch {
    return fail(reason);
  }
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && (a.isDirectory() || a.nlink === b.nlink);
}
function unlinkIfPresent(path) {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
}

class NativeCustody {
  principal;
  ports;
  held = new Map;
  constructor(principal, ports) {
    this.principal = principal;
    this.ports = ports;
  }
  stat(path, stat) {
    return this.ports.nativeStat(path, stat);
  }
  hold(path, directory, privateMode = false, publicGit = false) {
    const prior = this.held.get(path);
    if (prior) {
      this.recheckOne(prior);
      this.policy(prior.stat, directory, privateMode, publicGit);
      return prior;
    }
    let fd;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (directory ? fs.constants.O_DIRECTORY : 0));
    } catch {
      return fail(directory ? "native_path_unsafe" : "private_file_custody_unsafe");
    }
    try {
      const stat = this.stat(path, fs.fstatSync(fd, { bigint: true }));
      this.policy(stat, directory, privateMode, publicGit);
      const held = { path, fd, stat };
      this.recheckOne(held);
      this.held.set(path, held);
      return held;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  policy(stat, directory, privateMode, publicGit) {
    if (stat.uid !== BigInt(this.principal.uid) || stat.gid !== BigInt(this.principal.gid))
      fail("native_owner_mismatch");
    const mode = Number(stat.mode & 0o7777n);
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      fail("native_path_unsafe");
    if (directory) {
      if ((mode & 3602) !== 0 || (mode & 448) !== 448 || !publicGit && (mode & 7) !== 0 || privateMode && mode !== 448)
        fail("native_directory_custody_unsafe");
    } else if (mode !== 384)
      fail("private_file_custody_unsafe");
  }
  walk(path, create = false, mode = 488, privateLeaf = false, publicGit = false) {
    canonicalPath(path, "native_path_unsafe");
    if (!within(path, this.principal.home))
      fail("native_path_outside_home");
    this.hold(this.principal.home, true, false, true);
    let cursor = this.principal.home;
    const components = relative(cursor, path).split("/").filter(Boolean);
    for (let index = 0;index < components.length; index++) {
      this.recheck();
      cursor = join(cursor, components[index]);
      let missing = false;
      try {
        fs.lstatSync(cursor);
      } catch (error) {
        if (error.code !== "ENOENT")
          fail("native_path_unsafe");
        missing = true;
      }
      if (missing) {
        if (!create)
          fail("native_path_missing");
        try {
          fs.mkdirSync(cursor, { mode });
        } catch (error) {
          if (error.code !== "EEXIST")
            fail("native_path_create_failed");
        }
      }
      this.hold(cursor, true, privateLeaf && index === components.length - 1, index < components.length - 1 || publicGit);
    }
    return this.hold(path, true, privateLeaf, publicGit || path === this.principal.home);
  }
  read(path, max) {
    this.walk(dirname(path));
    const held = this.hold(path, false);
    if (held.stat.size > BigInt(max))
      fail("private_file_custody_unsafe");
    const bytes = Buffer.alloc(Number(held.stat.size));
    if (fs.readSync(held.fd, bytes, 0, bytes.length, 0) !== bytes.length)
      fail("private_file_custody_unsafe");
    this.recheckOne(held);
    const after = this.stat(path, fs.fstatSync(held.fd, { bigint: true }));
    if (after.size !== held.stat.size || after.mtimeNs !== held.stat.mtimeNs || after.ctimeNs !== held.stat.ctimeNs)
      fail("private_file_descriptor_changed");
    return bytes;
  }
  recheckOne(held) {
    try {
      const current = this.stat(held.path, fs.fstatSync(held.fd, { bigint: true }));
      const named = this.stat(held.path, fs.lstatSync(held.path, { bigint: true }));
      if (!same(held.stat, current) || !same(current, named))
        fail("native_descriptor_changed");
      if (held.stat.isFile() && (current.size !== held.stat.size || current.mtimeNs !== held.stat.mtimeNs || current.ctimeNs !== held.stat.ctimeNs))
        fail("native_descriptor_changed");
    } catch {
      fail("native_descriptor_changed");
    }
  }
  recheck() {
    for (const held of this.held.values())
      this.recheckOne(held);
  }
  drop(path) {
    const held = this.held.get(path);
    if (held) {
      this.recheckOne(held);
      fs.closeSync(held.fd);
      this.held.delete(path);
    }
  }
  gitMetadata(path, deadlineMs) {
    const entries = new Map;
    const receive = (entry) => {
      const stat = this.stat(entry, fs.lstatSync(entry, { bigint: true }));
      const mode = Number(stat.mode & 0o7777n);
      if (stat.uid !== BigInt(this.principal.uid) || stat.gid !== BigInt(this.principal.gid) || (mode & 3602) !== 0 || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
        fail("native_custody_unavailable");
      return stat;
    };
    const walk = (directory, depth) => {
      if (depth > 32 || this.ports.now() >= deadlineMs)
        fail("native_git_metadata_bounds");
      const before = receive(directory);
      if (!before.isDirectory())
        fail("native_custody_unavailable");
      entries.set(directory, before);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entries.size >= 16384 || this.ports.now() >= deadlineMs)
          fail("native_git_metadata_bounds");
        const child = join(directory, entry.name);
        const stat = receive(child);
        entries.set(child, stat);
        if (stat.isDirectory())
          walk(child, depth + 1);
      }
      if (!same(before, receive(directory)))
        fail("native_git_metadata_changed");
    };
    walk(path, 0);
    return () => {
      this.recheck();
      for (const [entry, before] of entries) {
        if (this.ports.now() >= deadlineMs)
          fail("native_git_metadata_bounds");
        const after = receive(entry);
        if (!same(before, after) || !before.isDirectory() && (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs))
          fail("native_git_metadata_changed");
      }
    };
  }
  retireExpiredRequest(path) {
    const held = this.hold(path, false);
    this.recheck();
    fs.unlinkSync(path);
    this.held.delete(path);
    fs.closeSync(held.fd);
  }
  close() {
    for (const held of this.held.values())
      fs.closeSync(held.fd);
    this.held.clear();
  }
  identity(held) {
    return {
      path: held.path,
      device: held.stat.dev.toString(),
      inode: held.stat.ino.toString(),
      uid: Number(held.stat.uid),
      gid: Number(held.stat.gid),
      mode: Number(held.stat.mode & 0o7777n),
      isDirectory: true,
      isSymbolicLink: false
    };
  }
}
function installed(configPath, ports) {
  const principal = ports.principal();
  if (principal.platform !== "darwin" || principal.uid <= 0 || principal.euid !== principal.uid || !Number.isSafeInteger(principal.uid) || !Number.isSafeInteger(principal.gid))
    fail("native_principal_invalid");
  canonicalPath(principal.home, "native_principal_home_invalid");
  canonicalPath(configPath, "config_path_unsafe");
  if (!below2(configPath, principal.home))
    fail("native_principal_home_authority_mismatch");
  const custody = new NativeCustody(principal, ports);
  try {
    custody.walk(dirname(configPath), false, 448, true);
    const row = exact2(parseCanonical(custody.read(configPath, 16384), "config_invalid"), [
      "version",
      "authority",
      "privateKeyFile",
      "supervisorImage",
      "dockerExecutable",
      "dockerExecutableSha256"
    ], "config_invalid");
    if (row.version !== 1)
      fail("config_invalid");
    const authority = parseDarwinThoughtsAuthority(row.authority);
    if (authority.nativeUid !== principal.uid || authority.nativeGid !== principal.gid || authority.nativeHome !== principal.home)
      fail("native_principal_authority_mismatch");
    const privateKeyFile = canonicalPath(row.privateKeyFile, "key_path_unsafe");
    const dockerExecutable = canonicalPath(row.dockerExecutable, "config_executable_unsafe");
    if (typeof row.supervisorImage !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(row.supervisorImage) || typeof row.dockerExecutableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.dockerExecutableSha256))
      fail("config_invalid");
    for (const root of [
      authority.thoughtsRoot,
      authority.locksRoot,
      authority.requestsRoot,
      authority.responsesRoot
    ]) {
      if (within(configPath, root) || within(privateKeyFile, root) || within(dockerExecutable, root) || within(dirname(configPath), root) || within(root, dirname(configPath)) || within(dirname(privateKeyFile), root) || within(root, dirname(privateKeyFile)))
        fail("key_mount_path_unsafe");
      custody.walk(root, false, 448, root === authority.requestsRoot || root === authority.responsesRoot);
    }
    if (dirname(privateKeyFile) !== dirname(configPath))
      fail("key_state_directory_mismatch");
    let key;
    try {
      key = createPrivateKey({
        key: custody.read(privateKeyFile, 4096),
        type: "pkcs8",
        format: "der"
      });
    } catch {
      return fail("key_custody_invalid");
    }
    if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") !== authority.publicKey)
      fail("key_authority_mismatch");
    const config = {
      version: 1,
      authority,
      privateKeyFile,
      dockerExecutable,
      supervisorImage: row.supervisorImage,
      dockerExecutableSha256: row.dockerExecutableSha256
    };
    custody.recheck();
    return { config, principal, custody, key, configPath };
  } catch (error) {
    custody.close();
    throw error;
  }
}
function registryFile(state) {
  return join(dirname(state.configPath), "known-tuples.json");
}
function readRegistry(state) {
  const path = registryFile(state);
  try {
    fs.lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT")
      return [];
    throw error;
  }
  const row = exact2(parseCanonical(state.custody.read(path, 16384), "registry_invalid"), ["version", "installationId", "tuples"], "registry_invalid");
  if (row.version !== 1 || row.installationId !== state.config.authority.installationId || !Array.isArray(row.tuples) || row.tuples.length > 128)
    fail("registry_invalid");
  const seen = new Set;
  return row.tuples.map((value) => {
    const tuple = exact2(value, ["tenant", "repository"], "registry_invalid");
    if (typeof tuple.tenant !== "string" || typeof tuple.repository !== "string")
      fail("registry_invalid");
    deriveDarwinThoughtsTargets(state.config.authority, tuple.tenant, tuple.repository);
    const id = tuple.tenant + "/" + tuple.repository;
    if (seen.has(id))
      fail("registry_invalid");
    seen.add(id);
    return { tenant: tuple.tenant, repository: tuple.repository };
  });
}
function writePrivate(state, path, bytes, replace, beforePublish) {
  state.custody.walk(dirname(path), false, 448, true);
  state.custody.recheck();
  if (!replace) {
    try {
      fs.lstatSync(path);
      fail("response_already_exists");
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
  }
  const temporary = join(dirname(path), ".producer-" + randomBytes(16).toString("hex"));
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    state.custody.recheck();
    beforePublish?.();
    if (replace)
      fs.renameSync(temporary, path);
    else {
      fs.linkSync(temporary, path);
      fs.unlinkSync(temporary);
    }
    const parentFd = fs.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    fs.closeSync(fd);
    unlinkIfPresent(temporary);
  }
}
function remember(state, request) {
  const tuples = readRegistry(state);
  if (tuples.some((tuple) => tuple.tenant === request.tenant && tuple.repository === request.repository))
    return;
  if (tuples.length >= 128)
    fail("registry_capacity_exceeded");
  tuples.push({ tenant: request.tenant, repository: request.repository });
  state.custody.drop(registryFile(state));
  writePrivate(state, registryFile(state), Buffer.from(canonicalDarwinThoughtsJson({
    version: 1,
    installationId: state.config.authority.installationId,
    tuples
  })), true);
}
function fresh(request, deadlineMs, ports) {
  const now = ports.now();
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now || request.issuedAtMs > now || request.expiresAtMs <= now)
    fail("request_deadline_expired");
}
function makeProducer(ports) {
  const producerInstance = randomBytes(32).toString("hex");
  async function answer(options) {
    const state = installed(options.configPath, ports);
    try {
      const { authority } = state.config;
      canonicalPath(options.requestFile, "request_path_invalid");
      let request;
      try {
        request = parseDarwinThoughtsRequest(parseCanonical(state.custody.read(options.requestFile, 4096), "request_invalid"));
      } catch {
        return fail("request_invalid");
      }
      fresh(request, options.deadlineMs, ports);
      if (request.installationId !== authority.installationId || basename(options.requestFile) !== request.nonce + ".json")
        fail("request_authority_invalid");
      const targets = deriveDarwinThoughtsTargets(authority, request.tenant, request.repository);
      const global = dirname(options.requestFile) === authority.requestsRoot;
      if (!global && (dirname(options.requestFile) !== targets.requestSource || !readRegistry(state).some((tuple) => tuple.tenant === request.tenant && tuple.repository === request.repository)))
        fail("request_channel_invalid");
      const responseDirectory = global ? authority.responsesRoot : targets.responseSource;
      const deadlineMs = Math.min(options.deadlineMs, request.expiresAtMs);
      let response;
      try {
        const checkout = state.custody.walk(targets.checkoutSource, true);
        const lock = state.custody.walk(targets.lockSource, true);
        state.custody.walk(targets.requestSource, true, 448, true);
        state.custody.walk(targets.responseSource, true, 448, true);
        let git;
        const gitPath = join(targets.checkoutSource, ".git");
        try {
          fs.lstatSync(gitPath);
          git = state.custody.walk(gitPath, false, 488, false, true);
        } catch (error) {
          if (error.code !== "ENOENT")
            throw error;
        }
        const recheckGit = git ? state.custody.gitMetadata(gitPath, deadlineMs) : undefined;
        fresh(request, deadlineMs, ports);
        const engine = await (ports.engine ?? ((input) => observeEngine(state, input, ports)))({
          image: state.config.supervisorImage,
          endpoint: authority.endpoint,
          nonce: request.nonce,
          deadlineMs,
          checkoutPath: targets.checkoutSource,
          lockPath: targets.lockSource
        });
        fresh(request, deadlineMs, ports);
        state.custody.recheck();
        recheckGit?.();
        if (engine.daemonId !== authority.daemonId || engine.endpoint !== authority.endpoint || engine.nonce !== request.nonce || Boolean(engine.git) !== Boolean(git))
          fail("engine_binding_mismatch");
        response = parseDarwinThoughtsResponse({
          version: 1,
          kind: "accepted",
          authority,
          request,
          observedAtMs: ports.now(),
          expiresAtMs: deadlineMs,
          nativeBootId: state.principal.nativeBootId,
          producerInstance,
          nativeCheckout: state.custody.identity(checkout),
          nativeLock: state.custody.identity(lock),
          engineCheckout: engine.checkout,
          engineLock: engine.lock,
          ...git ? { nativeGit: state.custody.identity(git), engineGit: engine.git } : {}
        }, { authority, request, nowMs: ports.now() });
      } catch (error) {
        fresh(request, deadlineMs, ports);
        response = parseDarwinThoughtsResponse({
          version: 1,
          kind: "refused",
          authority,
          request,
          observedAtMs: ports.now(),
          expiresAtMs: deadlineMs,
          nativeBootId: state.principal.nativeBootId,
          producerInstance,
          reason: error instanceof ProducerError ? error.reason : "native_custody_refused"
        }, { authority, request, nowMs: ports.now() });
      }
      if (response.kind === "refused")
        state.custody.close();
      const publication = installed(options.configPath, ports);
      try {
        if (canonicalDarwinThoughtsJson(publication.config) !== canonicalDarwinThoughtsJson(state.config))
          fail("authority_descriptor_changed");
        const received = publication.custody.read(options.requestFile, 4096);
        if (!received.equals(Buffer.from(canonicalDarwinThoughtsJson(request))))
          fail("request_descriptor_changed");
        fresh(request, deadlineMs, ports);
        const payload = canonicalDarwinThoughtsJson(response);
        const envelope = canonicalDarwinThoughtsJson({
          version: 1,
          payload,
          signature: sign(null, Buffer.from(payload), publication.key).toString("base64")
        });
        if (response.kind === "accepted")
          remember(publication, request);
        writePrivate(publication, join(responseDirectory, request.nonce + ".json"), Buffer.from(envelope), false, () => {
          fresh(request, deadlineMs, ports);
          if (response.kind === "accepted")
            state.custody.recheck();
        });
      } finally {
        publication.custody.close();
      }
      return {
        kind: response.kind,
        nonce: request.nonce,
        ...response.kind === "refused" ? { reason: response.reason } : {}
      };
    } finally {
      state.custody.close();
    }
  }
  async function runOnce(options) {
    const state = installed(options.configPath, ports);
    const pending = [];
    try {
      if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= ports.now())
        fail("producer_deadline_expired");
      const authority = state.config.authority;
      const channels = [
        { request: authority.requestsRoot, response: authority.responsesRoot },
        ...readRegistry(state).map((tuple) => {
          const targets = deriveDarwinThoughtsTargets(authority, tuple.tenant, tuple.repository);
          return { request: targets.requestSource, response: targets.responseSource };
        })
      ];
      for (const channel of channels) {
        state.custody.walk(channel.request, false, 448, true);
        state.custody.walk(channel.response, false, 448, true);
        const directory = fs.opendirSync(channel.request);
        try {
          let entries = 0;
          let entry;
          while ((entry = directory.readSync()) !== null) {
            if (++entries > 256 || pending.length >= 32)
              fail("request_inbox_capacity_exceeded");
            if (!/^[a-f0-9]{64}\.json$/.test(entry.name))
              continue;
            if (!entry.isFile())
              fail("request_custody_unsafe");
            const requestPath = join(channel.request, entry.name);
            const request = parseDarwinThoughtsRequest(parseCanonical(state.custody.read(requestPath, 4096), "request_invalid"));
            const targets = deriveDarwinThoughtsTargets(state.config.authority, request.tenant, request.repository);
            if (request.installationId !== state.config.authority.installationId || request.nonce + ".json" !== entry.name || channel.request !== state.config.authority.requestsRoot && channel.request !== targets.requestSource)
              fail("request_authority_invalid");
            if (request.expiresAtMs <= ports.now() && request.issuedAtMs <= ports.now()) {
              state.custody.retireExpiredRequest(requestPath);
              continue;
            }
            const response = join(channel.response, entry.name);
            let exists = true;
            try {
              fs.lstatSync(response);
            } catch (error) {
              if (error.code !== "ENOENT")
                throw error;
              exists = false;
            }
            if (exists) {
              state.custody.read(response, 16384);
              continue;
            }
            pending.push(join(channel.request, entry.name));
          }
        } finally {
          directory.closeSync();
        }
      }
      state.custody.recheck();
    } finally {
      state.custody.close();
    }
    let accepted = 0;
    let refused = 0;
    for (const requestFile of pending) {
      const result = await answer({ ...options, requestFile });
      if (result.kind === "accepted")
        accepted++;
      else
        refused++;
    }
    return { accepted, refused };
  }
  return { answer, runOnce };
}
function nativePrincipal() {
  if (process.platform !== "darwin" || !process.getuid || !process.geteuid || !process.getgid)
    fail("native_principal_invalid");
  const nativeHome = fs.realpathSync(userInfo().homedir);
  const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeout: 1000,
    maxBuffer: 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (!boot.trim())
    fail("native_boot_unavailable");
  return {
    platform: process.platform,
    uid: process.getuid(),
    euid: process.geteuid(),
    gid: process.getgid(),
    home: nativeHome,
    nativeBootId: createHash("sha256").update(boot).digest("hex")
  };
}
function runDarwinThoughtsProducerOnce(options) {
  return makeProducer({
    principal: nativePrincipal,
    now: Date.now,
    nativeStat: (_path, stat) => stat
  }).runOnce(options);
}
function command(executable, args, deadlineMs, now) {
  const remaining = deadlineMs - now();
  if (remaining <= 0)
    fail("request_deadline_expired");
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: remaining,
      killSignal: "SIGKILL",
      maxBuffer: 16384,
      encoding: "utf8"
    }, (error, stdout) => error ? reject(new ProducerError("engine_command_refused")) : resolve(stdout.trim()));
  });
}
var ENGINE_PROGRAM = [
  'const fs=require("node:fs"),args=JSON.parse(process.argv[1]);',
  'const identity=(alias,path)=>{const s=fs.lstatSync(alias,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error("directory");return {path,device:String(s.dev),inode:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&4095n),isDirectory:true,isSymbolicLink:false};};',
  "const t=setTimeout(()=>process.exit(124),Math.min(args.remaining,30000));t.unref();",
  'const checkout=identity("/checkout",args.checkoutPath),lock=identity("/lock",args.lockPath);',
  'for(const alias of ["/checkout","/lock"]){const d=alias+"/"+args.challengeDirectory;if(fs.readFileSync(d+"/native","utf8")!==args.nonce)throw Error("challenge");fs.writeFileSync(d+"/engine",args.nonce,{flag:"wx",mode:384});}',
  'let git;try{git=identity("/checkout/.git",args.checkoutPath+"/.git");}catch(e){if(e.code!=="ENOENT")throw e;}',
  "console.log(JSON.stringify({checkout,lock,...(git?{git}:{})}));"
].join(`
`);
async function observeEngine(state, input, ports) {
  const { config, custody } = state;
  const executable = config.dockerExecutable;
  if (fs.realpathSync(executable) !== executable)
    fail("config_executable_unsafe");
  const executableFd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let executableStat;
  try {
    executableStat = fs.fstatSync(executableFd, { bigint: true });
    if (!executableStat.isFile() || (executableStat.mode & 0o7022n) !== 0n || (executableStat.mode & 0o111n) === 0n || executableStat.uid !== 0n && executableStat.uid !== BigInt(state.principal.uid) || executableStat.size > 256n * 1024n * 1024n || createHash("sha256").update(fs.readFileSync(executableFd)).digest("hex") !== config.dockerExecutableSha256)
      fail("config_executable_unsafe");
  } finally {
    fs.closeSync(executableFd);
  }
  const dockerConfig = fs.mkdtempSync(join(dirname(state.configPath), ".docker-empty-"));
  const challengeDirectory = ".catalyst-custody-" + randomBytes(16).toString("hex");
  const helperName = "catalyst-custody-" + randomBytes(16).toString("hex");
  const helperLabel = "dev.catalystcloud.thoughts-custody-helper";
  const helperToken = config.authority.installationId + ":" + randomBytes(32).toString("hex");
  const scratch = [];
  let id;
  let cachedImage;
  let createAttempted = false;
  const receiveHelperIdentity = (output, acknowledgedId) => {
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      return fail("engine_helper_cleanup_unproved");
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object" || Array.isArray(parsed[0]))
      fail("engine_helper_cleanup_unproved");
    const row = parsed[0];
    if (!row.Config || typeof row.Config !== "object" || Array.isArray(row.Config))
      fail("engine_helper_cleanup_unproved");
    const receivedConfig = row.Config;
    if (!receivedConfig.Labels || typeof receivedConfig.Labels !== "object" || Array.isArray(receivedConfig.Labels))
      fail("engine_helper_cleanup_unproved");
    const labels = receivedConfig.Labels;
    if (typeof row.Id !== "string" || !/^[a-f0-9]{64}$/.test(row.Id) || acknowledgedId !== undefined && row.Id !== acknowledgedId || row.Name !== "/" + helperName || row.Image !== cachedImage || receivedConfig.Image !== input.image || labels[helperLabel] !== helperToken)
      fail("engine_helper_cleanup_unproved");
    return row.Id;
  };
  const docker = async (args, deadlineMs = input.deadlineMs) => {
    if (!same(executableStat, fs.lstatSync(executable, { bigint: true })))
      fail("config_executable_changed");
    custody.recheck();
    return command(executable, ["--config", dockerConfig, "--host", input.endpoint, ...args], deadlineMs, ports.now);
  };
  let result;
  try {
    cachedImage = await docker(["image", "inspect", "--format", "{{.Id}}", input.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(cachedImage))
      fail("engine_cached_image_unavailable");
    const daemonId = await docker(["info", "--format", "{{.ID}}"]);
    if (daemonId !== config.authority.daemonId)
      fail("engine_binding_mismatch");
    for (const root of [input.checkoutPath, input.lockPath]) {
      custody.recheck();
      const path = join(root, challengeDirectory);
      fs.mkdirSync(path, { mode: 448 });
      scratch.push(path);
      custody.hold(path, true, true);
      fs.writeFileSync(join(path, "native"), input.nonce, { flag: "wx", mode: 384 });
    }
    const remaining = input.deadlineMs - ports.now();
    if (remaining <= 0)
      fail("request_deadline_expired");
    const helperArgs = canonicalDarwinThoughtsJson({
      remaining,
      nonce: input.nonce,
      challengeDirectory,
      checkoutPath: input.checkoutPath,
      lockPath: input.lockPath
    });
    createAttempted = true;
    const created = await docker([
      "create",
      "--pull=never",
      "--name",
      helperName,
      "--label",
      helperLabel + "=" + helperToken,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "10001:10001",
      "--memory",
      "64m",
      "--memory-swap",
      "64m",
      "--cpus",
      "1",
      "--pids-limit",
      "32",
      "--workdir",
      "/",
      "--mount",
      "type=bind,src=" + input.checkoutPath + ",dst=/checkout",
      "--mount",
      "type=bind,src=" + input.lockPath + ",dst=/lock",
      "--entrypoint",
      "/usr/bin/timeout",
      input.image,
      "--signal=KILL",
      Math.max(1, Math.ceil(remaining / 1000)) + "s",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
      "/usr/local/bin/bun",
      "--config=/dev/null",
      "--no-env-file",
      "--cwd=/",
      "-e",
      ENGINE_PROGRAM,
      helperArgs
    ]);
    if (!/^[a-f0-9]{64}$/.test(created))
      fail("engine_helper_identity_invalid");
    id = created;
    id = receiveHelperIdentity(await docker(["inspect", helperName]), id);
    const output = await docker(["start", "--attach", id]);
    if (await docker(["inspect", "--format", "{{.State.ExitCode}}", id]) !== "0")
      fail("engine_helper_refused");
    custody.recheck();
    for (const path of scratch) {
      if (custody.read(join(path, "engine"), 128).toString("utf8") !== input.nonce)
        fail("engine_challenge_mismatch");
    }
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("engine_helper_output_invalid");
    const row = parsed;
    if (Object.keys(row).some((key) => !["checkout", "lock", "git"].includes(key)))
      fail("engine_helper_output_invalid");
    result = {
      value: {
        daemonId,
        endpoint: input.endpoint,
        nonce: input.nonce,
        checkout: row.checkout,
        lock: row.lock,
        ...Object.hasOwn(row, "git") ? { git: row.git } : {}
      }
    };
  } catch (error) {
    result = { error };
  }
  let cleanupUnproved = false;
  if (createAttempted) {
    const cleanupStarted = performance.now();
    const cleanupDocker = (args) => {
      const remaining = 2000 - (performance.now() - cleanupStarted);
      if (remaining <= 0 || !same(executableStat, fs.lstatSync(executable, { bigint: true })))
        fail("engine_helper_cleanup_unproved");
      return command(executable, ["--config", dockerConfig, "--host", input.endpoint, ...args], ports.now() + Math.ceil(remaining), ports.now);
    };
    try {
      if (await cleanupDocker(["info", "--format", "{{.ID}}"]) !== config.authority.daemonId || await cleanupDocker(["image", "inspect", "--format", "{{.Id}}", input.image]) !== cachedImage)
        fail("engine_helper_cleanup_unproved");
      let received;
      for (let attempt = 0;attempt < 32; attempt++) {
        try {
          received = await cleanupDocker(["inspect", helperName]);
          break;
        } catch {
          if (id !== undefined || performance.now() - cleanupStarted >= 1900)
            throw new ProducerError("engine_helper_cleanup_unproved");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (received === undefined)
        fail("engine_helper_cleanup_unproved");
      id = receiveHelperIdentity(received, id);
      const list = ["ps", "--all", "--no-trunc", "--quiet", "--filter", "id=" + id];
      if (await cleanupDocker(list) !== id)
        fail("engine_helper_cleanup_unproved");
      await cleanupDocker(["rm", "--force", id]);
      if (await cleanupDocker(list) !== "")
        fail("engine_helper_cleanup_unproved");
    } catch {
      cleanupUnproved = true;
    }
  }
  for (const path of scratch) {
    custody.drop(join(path, "engine"));
    custody.drop(path);
    for (const file of ["native", "engine"]) {
      unlinkIfPresent(join(path, file));
    }
    fs.rmdirSync(path);
  }
  fs.rmdirSync(dockerConfig);
  if (cleanupUnproved)
    fail("engine_helper_cleanup_unproved");
  if ("error" in result)
    throw result.error;
  return result.value;
}

// deploy/self-host/darwin-thoughts-custody/producer-entry.ts
if (process.argv.length !== 4 || !/^[1-9][0-9]{12,15}$/.test(process.argv[3] ?? "")) {
  process.stderr.write(`darwin_thoughts_producer:arguments_invalid
`);
  process.exitCode = 1;
} else {
  try {
    const result = await runDarwinThoughtsProducerOnce({
      configPath: process.argv[2],
      deadlineMs: Number(process.argv[3])
    });
    process.stdout.write(JSON.stringify(result) + `
`);
  } catch {
    process.stderr.write(`darwin_thoughts_producer:refused
`);
    process.exitCode = 1;
  }
}
