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
var SIGNATURE = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
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
function parseDarwinThoughtsSignedEnvelope(value) {
  const reason = "darwin_thoughts_envelope_invalid";
  const row = exact(value, ["version", "payload", "signature"], [], reason);
  if (row.version !== DARWIN_THOUGHTS_CUSTODY_VERSION || typeof row.payload !== "string" || row.payload.length === 0 || row.payload.length > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES || utf8Bytes(row.payload, reason) > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES)
    return invalid(reason);
  const envelope = Object.freeze({
    version: DARWIN_THOUGHTS_CUSTODY_VERSION,
    payload: row.payload,
    signature: matches(row.signature, SIGNATURE, reason)
  });
  try {
    canonicalDarwinThoughtsJson(envelope);
  } catch {
    return invalid(reason);
  }
  return envelope;
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
// packages/host-isolation/src/darwin-thoughts-custody.ts
import { createPublicKey, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
function failure(reason, cause) {
  return new Error(`darwin_thoughts_custody:${reason}`, { cause });
}
function guarded(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("darwin_thoughts_custody:"))
      throw error;
    throw failure("invalid", error);
  }
}
function sameDescriptor(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function checkRegular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n || stat.size <= 0n || stat.size > BigInt(DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES)) {
    throw failure("unsafe_file");
  }
}
function readDarwinThoughtsCustodyFile(path, expectedOwner) {
  return guarded(() => {
    const namedBefore = fs.lstatSync(path, { bigint: true });
    checkRegular(namedBefore);
    if (expectedOwner && (namedBefore.uid !== BigInt(expectedOwner.uid) || namedBefore.gid !== BigInt(expectedOwner.gid))) {
      throw failure("file_owner");
    }
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      checkRegular(opened);
      if (!sameDescriptor(namedBefore, opened))
        throw failure("substituted_file");
      const bytes = Buffer.alloc(DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0)
          break;
        length += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      const namedAfter = fs.lstatSync(path, { bigint: true });
      checkRegular(after);
      checkRegular(namedAfter);
      if (length > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES || BigInt(length) !== after.size || !sameDescriptor(opened, after) || !sameDescriptor(after, namedAfter))
        throw failure("substituted_file");
      return bytes.subarray(0, length);
    } finally {
      fs.closeSync(fd);
    }
  });
}
function canonicalValue(text) {
  const value = JSON.parse(text);
  if (canonicalDarwinThoughtsJson(value) !== text)
    throw failure("noncanonical_json");
  return value;
}
function verifyDarwinThoughtsCustodyResponse(bytes, expected) {
  return guarded(() => {
    if (bytes.byteLength === 0 || bytes.byteLength > DARWIN_THOUGHTS_MAX_PAYLOAD_BYTES)
      throw failure("size");
    const authority = parseDarwinThoughtsAuthority(expected.authority);
    const request = parseDarwinThoughtsRequest(expected.request);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = parseDarwinThoughtsSignedEnvelope(canonicalValue(text));
    const key = createPublicKey({
      key: Buffer.from(authority.publicKey, "base64"),
      type: "spki",
      format: "der"
    });
    if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "der" }).toString("base64") !== authority.publicKey || !verify(null, Buffer.from(envelope.payload, "utf8"), key, Buffer.from(envelope.signature, "base64"))) {
      throw failure("signature");
    }
    const response = parseDarwinThoughtsResponse(canonicalValue(envelope.payload), {
      authority,
      request,
      nowMs: expected.nowMs
    });
    if (response.kind !== "accepted")
      throw failure("producer_refused");
    for (const [actual, current] of [
      [response.engineCheckout, expected.engineCheckout],
      [response.engineLock, expected.engineLock],
      [response.engineGit, expected.engineGit]
    ]) {
      if (canonicalDarwinThoughtsJson(actual ?? null) !== canonicalDarwinThoughtsJson(current ?? null)) {
        throw failure("engine_identity");
      }
    }
    return response;
  });
}
function cleanPath(path) {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/")
    throw failure("path");
  let current = "/";
  for (const component of path.slice(1).split("/")) {
    current = join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("directory");
  }
}
function directory(path, privateChannel = false) {
  return guarded(() => {
    cleanPath(path);
    const named = fs.lstatSync(path, { bigint: true });
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const after = fs.lstatSync(path, { bigint: true });
      if (!opened.isDirectory() || !sameDirectoryAuthority(named, opened) || !sameDirectoryAuthority(opened, after) || (opened.mode & 0o7022n) !== 0n || (opened.mode & 0o700n) !== 0o700n || privateChannel && ((opened.mode & 0o077n) !== 0n || opened.uid !== 0n && opened.uid !== 10001n)) {
        throw failure("unsafe_directory");
      }
      return opened;
    } finally {
      fs.closeSync(fd);
    }
  });
}
function currentIdentity(path, logicalPath) {
  const stat = directory(path);
  return {
    path: logicalPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
    isDirectory: true,
    isSymbolicLink: false
  };
}
function sameDirectoryAuthority(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}
function ancestors(paths, allowMissing = false) {
  const observed = new Map;
  for (const path of paths) {
    let current = "/";
    for (const component of ["", ...path.slice(1).split("/")]) {
      if (component)
        current = join(current, component);
      if (observed.has(current))
        continue;
      let stat;
      try {
        stat = fs.lstatSync(current, { bigint: true });
      } catch (error) {
        if (allowMissing && isMissing(error))
          break;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw failure("ancestor");
      observed.set(current, stat);
    }
  }
  return Array.from(observed, ([path, stat]) => ({ path, stat }));
}
function checkAncestors(expected) {
  for (const ancestor of expected) {
    const current = fs.lstatSync(ancestor.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryAuthority(current, ancestor.stat)) {
      throw failure("ancestor_identity");
    }
  }
}
function receiveStagingChannel(path, before, stagedFile, observedAncestors) {
  const current = directory(path, true);
  if (sameDirectoryAuthority(before, current))
    return current;
  if (before.dev !== current.dev || before.ino !== current.ino || before.mode !== current.mode || before.uid !== 0n || before.gid !== 0n || current.uid !== 10001n || current.gid !== 10001n || process.getuid?.() !== 10001 || process.geteuid?.() !== 10001 || process.getgid?.() !== 10001 || stagedFile.uid !== 10001n || stagedFile.gid !== 10001n)
    throw failure("ancestor_identity");
  const channel = observedAncestors.find((ancestor) => ancestor.path === path);
  if (!channel || !sameDirectoryAuthority(channel.stat, before))
    throw failure("ancestor_identity");
  checkAncestors(observedAncestors.filter((ancestor) => ancestor.path !== path));
  channel.stat = current;
  return current;
}
function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function gitPresent(path) {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error))
      return false;
    throw failure("git_descriptor", error);
  }
}
function removeOwned(path, owned) {
  if (!owned)
    return;
  try {
    const stat = fs.lstatSync(path, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === owned.dev && stat.ino === owned.ino)
      fs.unlinkSync(path);
  } catch (error) {
    if (!isMissing(error))
      throw failure("cleanup", error);
  }
}
async function requestFreshDarwinThoughtsCustody(options) {
  return exchange(options, false);
}
async function requestFreshDarwinThoughtsBootstrap(options) {
  const authority = guarded(() => parseDarwinThoughtsAuthority(options.authority));
  const targets = guarded(() => deriveDarwinThoughtsTargets(authority, options.tenant, options.repository));
  if (options.requestDir !== authority.requestsRoot || options.responseDir !== authority.responsesRoot || options.checkoutPath !== targets.checkoutSource || options.lockPath !== targets.lockSource || options.gitPath !== undefined && options.gitPath !== join(targets.checkoutSource, ".git"))
    throw failure("bootstrap_path");
  return exchange(options, true);
}
function bootstrapPaths(authority, tenant, repository) {
  const targets = deriveDarwinThoughtsTargets(authority, tenant, repository);
  return [
    [authority.thoughtsRoot, targets.checkoutSource],
    [authority.locksRoot, targets.lockSource],
    [authority.requestsRoot, targets.requestSource],
    [authority.responsesRoot, targets.responseSource]
  ];
}
function checkBootstrapDirectories(paths, allowMissing) {
  for (const [index, [root, leaf]] of paths.entries()) {
    if (!root || !leaf)
      throw failure("bootstrap_path");
    let current = root;
    const components = ["", ...leaf.slice(root.length + 1).split("/")];
    for (const component of components) {
      if (component)
        current = join(current, component);
      try {
        fs.lstatSync(current);
      } catch (error) {
        if (allowMissing && current !== root && isMissing(error))
          break;
        throw failure("bootstrap_directory", error);
      }
      const stat = directory(current, index >= 2);
      if (stat.uid !== 0n && stat.uid !== 10001n)
        throw failure("bootstrap_owner");
      if ((stat.mode & 0o007n) !== 0n)
        throw failure("unsafe_directory");
    }
  }
}
async function exchange(options, bootstrap) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const authority = guarded(() => parseDarwinThoughtsAuthority(options.authority));
  const targets = guarded(() => deriveDarwinThoughtsTargets(authority, options.tenant, options.repository));
  const issuedAtMs = now();
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= issuedAtMs || options.deadlineMs - issuedAtMs > DARWIN_THOUGHTS_MAX_EXCHANGE_MS)
    throw failure("deadline");
  const request = guarded(() => parseDarwinThoughtsRequest({
    version: 1,
    installationId: authority.installationId,
    nonce: randomBytes(32).toString("hex"),
    tenant: options.tenant,
    repository: options.repository,
    issuedAtMs,
    expiresAtMs: options.deadlineMs
  }));
  let requests = directory(options.requestDir, true);
  const responses = directory(options.responseDir, true);
  const creationPaths = bootstrap ? bootstrapPaths(authority, options.tenant, options.repository) : [];
  if (bootstrap)
    checkBootstrapDirectories(creationPaths, true);
  else {
    currentIdentity(options.checkoutPath, targets.checkoutSource);
    currentIdentity(options.lockPath, targets.lockSource);
  }
  const gitPath = join(options.checkoutPath, ".git");
  if (options.gitPath !== undefined && options.gitPath !== gitPath)
    throw failure("git_path");
  const initialGitPresent = options.gitPath !== undefined || gitPresent(gitPath);
  if (initialGitPresent)
    currentIdentity(gitPath, join(targets.checkoutSource, ".git"));
  const aliasAncestors = guarded(() => ancestors([
    options.requestDir,
    options.responseDir,
    options.checkoutPath,
    options.lockPath,
    ...initialGitPresent ? [gitPath] : [],
    ...creationPaths.map((paths) => paths[1])
  ], bootstrap));
  const finalPath = join(options.requestDir, `${request.nonce}.json`);
  const stagingPath = join(options.requestDir, `.${request.nonce}.tmp`);
  const responsePath = join(options.responseDir, `${request.nonce}.json`);
  let owned;
  let published = false;
  try {
    const fd = guarded(() => fs.openSync(stagingPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 384));
    try {
      owned = fs.fstatSync(fd, { bigint: true });
      const bytes = Buffer.from(canonicalDarwinThoughtsJson(request));
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const written = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(stagingPath, { bigint: true });
      checkRegular(written);
      if (!sameDescriptor(written, named) || written.dev !== owned.dev || written.ino !== owned.ino) {
        throw failure("substituted_request");
      }
    } finally {
      fs.closeSync(fd);
    }
    requests = receiveStagingChannel(options.requestDir, requests, owned, aliasAncestors);
    checkAncestors(aliasAncestors);
    if (!sameDirectoryAuthority(requests, directory(options.requestDir, true)))
      throw failure("channel_identity");
    try {
      fs.lstatSync(finalPath);
      throw failure("nonce_collision");
    } catch (error) {
      if (!isMissing(error))
        throw error;
    }
    fs.renameSync(stagingPath, finalPath);
    published = true;
    let previousNow = issuedAtMs;
    while (true) {
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < previousNow || nowMs >= options.deadlineMs)
        throw failure("deadline");
      previousNow = nowMs;
      checkAncestors(aliasAncestors);
      for (const [path, expected] of [
        [options.requestDir, requests],
        [options.responseDir, responses]
      ]) {
        const current = directory(path, true);
        if (!sameDirectoryAuthority(current, expected))
          throw failure("channel_identity");
      }
      let present = false;
      try {
        fs.lstatSync(responsePath);
        present = true;
      } catch (error) {
        if (!isMissing(error))
          throw error;
      }
      if (present) {
        if (bootstrap)
          checkBootstrapDirectories(creationPaths, false);
        const receivedAncestors = bootstrap ? guarded(() => ancestors(creationPaths.map((paths) => paths[1]))) : [];
        const receivedGitPresent = options.gitPath !== undefined || gitPresent(gitPath);
        const receivedGitAncestors = receivedGitPresent ? guarded(() => ancestors([gitPath])) : [];
        const bytes = readDarwinThoughtsCustodyFile(responsePath, {
          uid: Number(responses.uid),
          gid: Number(responses.gid)
        });
        const expectation = {
          authority,
          request,
          nowMs: 0,
          engineCheckout: currentIdentity(options.checkoutPath, targets.checkoutSource),
          engineLock: currentIdentity(options.lockPath, targets.lockSource)
        };
        if (receivedGitPresent)
          expectation.engineGit = currentIdentity(gitPath, join(targets.checkoutSource, ".git"));
        checkAncestors(aliasAncestors);
        checkAncestors(receivedGitAncestors);
        expectation.nowMs = now();
        if (!Number.isSafeInteger(expectation.nowMs) || expectation.nowMs < previousNow || expectation.nowMs >= options.deadlineMs)
          throw failure("deadline");
        const proof = verifyDarwinThoughtsCustodyResponse(bytes, expectation);
        checkAncestors(receivedGitAncestors);
        if (bootstrap) {
          checkAncestors(receivedAncestors);
          checkAncestors(aliasAncestors);
          checkBootstrapDirectories(creationPaths, false);
        }
        const finalNow = now();
        if (!Number.isSafeInteger(finalNow) || finalNow < expectation.nowMs || finalNow >= options.deadlineMs)
          throw failure("deadline");
        if (options.onProof) {
          options.onProof({
            bytes: Buffer.from(bytes),
            proof: structuredClone(proof),
            expectation: structuredClone(expectation)
          });
          const afterCallback = now();
          if (!Number.isSafeInteger(afterCallback) || afterCallback < finalNow || afterCallback >= options.deadlineMs)
            throw failure("deadline");
        }
        return proof;
      }
      await sleep(Math.min(50, options.deadlineMs - nowMs));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("darwin_thoughts_custody:"))
      throw error;
    throw failure("exchange", error);
  } finally {
    removeOwned(published ? finalPath : stagingPath, owned);
  }
}
export {
  canonicalDarwinThoughtsJson,
  deriveDarwinThoughtsTargets,
  parseDarwinThoughtsAuthority,
  parseDarwinThoughtsRequest,
  parseDarwinThoughtsResponse,
  parseDarwinThoughtsSignedEnvelope,
  requestFreshDarwinThoughtsBootstrap,
  requestFreshDarwinThoughtsCustody,
  verifyDarwinThoughtsCustodyResponse
};
