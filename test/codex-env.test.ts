// codex-env.test.ts — `catalyst codex-env`: the slot resolver (match, unregistered, no login,
// malformed login file), the resource-attribute grammar and merge, the never-blocking cache (hit, miss
// with an unawaited refresh, stale), `--apply` through a fake launchctl and its non-macOS refusal, and
// that no printed value ever carries the account id or its hash. Every test runs against a temp HOME,
// a recorded detach and a fetch that never answers, so --print and --apply provably never wait on it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { codexAccountsCachePathFor } from "../src/config";
import {
  CODEX_ACCOUNTS_TTL_SECONDS,
  NO_LOGIN_SLOT,
  UNREGISTERED_SLOT,
  attrValue,
  defaultCodexHome,
  defaultRun,
  loginSha256,
  mergeResourceAttributes,
  readCodexAccountId,
  readCodexAccountsCache,
  resolveSlot,
  shortHostName,
  type CodexAccountsCache,
  type CodexEnvDeps,
} from "../src/codex-env";
import { FIXTURE_ME_BODY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const NOW = new Date("2026-10-23T12:00:00Z");
const MY_ID = "acct-0f3c9a-local-login";
const OTHER_ID = "acct-someone-else";
const TOKEN = "eyJ-never-printed-token";

let server: FixtureServer;
let home: string;
let codexHome: string;
let fetches: number;
let spawned: string[][];
let launchctl: string[][];

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  codexHome = join(home, ".codex");
  fetches = 0;
  spawned = [];
  launchctl = [];
  await seedJoined(home, server, { contract: false });
});

/** A fetch that records the call and never answers: a verb that awaited it would hang the test. */
const hangingFetch = (() => {
  fetches++;
  return new Promise<Response>(() => {});
}) as typeof fetch;

function ctxWith(env: Record<string, string> = {}): TestCtx {
  return makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", ...env }, fetch: hangingFetch, now: () => NOW });
}

const deps = (over: CodexEnvDeps = {}): CodexEnvDeps => ({
  hostname: () => "build-box.example.internal",
  detach: (argv) => {
    spawned.push(argv);
    return { pid: 4242 };
  },
  run: (cmd, args) => {
    launchctl.push([cmd, ...args]);
    return { status: 0, stderr: "" };
  },
  platform: "darwin",
  ...over,
});

function writeLogin(dir: string, body: string | Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), typeof body === "string" ? body : JSON.stringify(body));
}
const codexLogin = (accountId: string) => ({
  OPENAI_API_KEY: null,
  tokens: { id_token: TOKEN, access_token: TOKEN, refresh_token: TOKEN, account_id: accountId },
  last_refresh: "2026-10-23T00:00:00Z",
});

function writeCache(over: Partial<CodexAccountsCache> = {}): void {
  const cache: CodexAccountsCache = {
    fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    workspace: FIXTURE_ME_BODY.account,
    // The matching slot is SECOND, so a resolver that ignored the hash would name the wrong one.
    accounts: [
      { accountSlot: "codex-other", loginSha256: loginSha256(OTHER_ID) },
      { accountSlot: "codex-mine", loginSha256: loginSha256(MY_ID) },
    ],
    ...over,
  };
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(codexAccountsCachePathFor(home), JSON.stringify(cache));
}

async function print(ctx = ctxWith(), d = deps()): Promise<{ code: number; out: string; ctx: TestCtx }> {
  const code = await main(["codex-env", "--print", "--codex-home", codexHome], ctx, { codexEnv: d });
  return { code, out: ctx.out.join("\n"), ctx };
}

const pairs = (value: string) => value.split(",").map((p) => p.slice(0, p.indexOf("=")));
const slotOf = (value: string) => /(?:^|,)catalyst\.account_slot=([^,]*)/.exec(value)?.[1];

describe("the slot resolver", () => {
  test("the hash is lowercase hex SHA-256 of the UTF-8 account id, the cloud's own (known vector)", () => {
    expect(loginSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("match: a login whose hash a cached account carries resolves to that account's slot", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache();
    const { code, out } = await print();
    expect(code).toBe(0);
    expect(out).toBe("catalyst.account_slot=codex-mine,host.name=build-box");
  });

  test("unregistered: a login no cached account matches is never guessed", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache({ accounts: [{ accountSlot: "codex-other", loginSha256: loginSha256(OTHER_ID) }] });
    const { code, out } = await print();
    expect(code).toBe(0);
    expect(slotOf(out)).toBe(UNREGISTERED_SLOT);
  });

  test("no login: a missing login file, one with no account id, or an empty one is none:no-login", async () => {
    writeCache();
    expect(slotOf((await print()).out)).toBe(NO_LOGIN_SLOT);
    writeLogin(codexHome, { OPENAI_API_KEY: "sk-test-not-a-login", tokens: null });
    expect(slotOf((await print()).out)).toBe(NO_LOGIN_SLOT);
    writeLogin(codexHome, { tokens: { account_id: "" } });
    expect(slotOf((await print()).out)).toBe(NO_LOGIN_SLOT);
    expect(resolveSlot(null, null)).toBe(NO_LOGIN_SLOT);
  });

  test("malformed: an unparseable login file is none:no-login, and none of its text is printed", async () => {
    writeCache();
    writeLogin(codexHome, `{"tokens": {"access_token": "${TOKEN}", "account_id": "${MY_ID}"`);
    const { code, out, ctx } = await print();
    expect(code).toBe(0);
    expect(slotOf(out)).toBe(NO_LOGIN_SLOT);
    const everything = [...ctx.out, ...ctx.err].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(MY_ID);
  });

  test("only tokens.account_id is taken from the login file", () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    expect(readCodexAccountId(codexHome)).toBe(MY_ID);
    writeLogin(codexHome, { account_id: MY_ID, tokens: { access_token: TOKEN } });
    expect(readCodexAccountId(codexHome)).toBeNull();
  });

  test("a login file that is not an object, whose tokens are not an object, or whose account id is not a string, is no login", () => {
    for (const body of ["null", "[]", '"text"', '{"tokens":"x"}', '{"tokens":[]}', '{"tokens":{"account_id":42}}']) {
      writeLogin(codexHome, body);
      expect(readCodexAccountId(codexHome), body).toBeNull();
    }
  });
});

describe("the attribute grammar and merge", () => {
  test("existing keys are kept, in order and verbatim, and the two keys are appended", () => {
    expect(mergeResourceAttributes("service.name=codex,deployment.environment=dev", { slot: "codex-mine", hostName: "box" })).toBe(
      "service.name=codex,deployment.environment=dev,catalyst.account_slot=codex-mine,host.name=box",
    );
    expect(mergeResourceAttributes(undefined, { slot: "s", hostName: "h" })).toBe("catalyst.account_slot=s,host.name=h");
    expect(mergeResourceAttributes(",,team=eng,", { slot: "s", hostName: "h" })).toBe("team=eng,catalyst.account_slot=s,host.name=h");
  });

  test("dedupe: an earlier slot or host name is replaced, so each appears exactly once", () => {
    const value = mergeResourceAttributes("catalyst.account_slot=old,host.name=Old-Mac.local,team=eng, host.name =again", {
      slot: "codex-mine",
      hostName: "box",
    });
    expect(value).toBe("team=eng,catalyst.account_slot=codex-mine,host.name=box");
    expect(pairs(value).filter((k) => k === "catalyst.account_slot")).toHaveLength(1);
    expect(pairs(value).filter((k) => k === "host.name")).toHaveLength(1);
  });

  test("an existing account key is never passed on (CTC-2786)", () => {
    const value = mergeResourceAttributes("account=acme,team=eng", { slot: "s", hostName: "h" });
    expect(pairs(value)).not.toContain("account");
    expect(value).toBe("team=eng,catalyst.account_slot=s,host.name=h");
  });

  test("structure characters in a value become _ and a blank value is unknown, as the runner writes them", () => {
    expect(attrValue("a,b=c")).toBe("a_b_c");
    expect(attrValue("   ")).toBe("unknown");
    expect(mergeResourceAttributes("", { slot: "x=y", hostName: "" })).toBe("catalyst.account_slot=x_y,host.name=unknown");
  });

  test("the host name is cut at its first dot", async () => {
    expect(shortHostName("dev-laptop.local")).toBe("dev-laptop");
    expect(shortHostName("plain")).toBe("plain");
    const { out } = await print(ctxWith(), deps({ hostname: () => "build-box.lan.example" }));
    expect(out.endsWith(",host.name=build-box")).toBe(true);
  });

  test("--print merges into the OTEL_RESOURCE_ATTRIBUTES already set", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache();
    const { out } = await print(ctxWith({ OTEL_RESOURCE_ATTRIBUTES: "hostname=box,catalyst.account_slot=stale" }));
    expect(out).toBe("hostname=box,catalyst.account_slot=codex-mine,host.name=build-box");
  });

  test("a pair with no = is kept verbatim, unless it names a key set here", () => {
    expect(mergeResourceAttributes("team,host.name,x=1,catalyst.account_slot", { slot: "s", hostName: "h" })).toBe(
      "team,x=1,catalyst.account_slot=s,host.name=h",
    );
  });

  test("with no hostname injected, the machine's own short name is used", async () => {
    const { out } = await print(ctxWith(), deps({ hostname: undefined }));
    expect(out.endsWith(`,host.name=${attrValue(shortHostName(hostname()))}`)).toBe(true);
  });
});

describe("the cache never makes a launch wait", () => {
  test("hit: a fresh cache answers, no refresh starts, and nothing is fetched", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache();
    expect(slotOf((await print()).out)).toBe("codex-mine");
    expect(spawned).toEqual([]);
    expect(fetches).toBe(0);
  });

  test("miss: no cache answers unregistered straight away and starts a detached refresh it never awaits", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    const { code, out } = await print();
    expect(code).toBe(0);
    expect(slotOf(out)).toBe(UNREGISTERED_SLOT);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.slice(-2)).toEqual(["codex-env", "--refresh"]);
    // The fetch never answers; the verb returned anyway, so it never waited on the network.
    expect(fetches).toBe(0);
  });

  test("stale: an old cache still answers, and a refresh starts for the next launch", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache({ fetchedAt: new Date(NOW.getTime() - (CODEX_ACCOUNTS_TTL_SECONDS + 60) * 1000).toISOString() });
    const ctx = ctxWith();
    expect(await main(["codex-env", "--print", "--codex-home", codexHome, "--json"], ctx, { codexEnv: deps() })).toBe(0);
    const out = JSON.parse(ctx.out.join("\n")) as { slot: string; cache: string; refreshStarted: boolean };
    expect(out).toMatchObject({ slot: "codex-mine", cache: "stale", refreshStarted: true });
    expect(spawned).toHaveLength(1);
    expect(fetches).toBe(0);
  });

  test("another workspace's cache is a miss, and a logged-out machine starts no refresh", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache({ workspace: "another-workspace" });
    expect(slotOf((await print()).out)).toBe(UNREGISTERED_SLOT);
    expect(spawned).toHaveLength(1);
    home = tempHome();
    codexHome = join(home, ".codex");
    writeLogin(codexHome, codexLogin(MY_ID));
    spawned = [];
    expect(slotOf((await print()).out)).toBe(UNREGISTERED_SLOT);
    expect(spawned).toEqual([]);
  });

  test("--refresh fetches the coding accounts and caches only each slot and its login hash", async () => {
    const mine = loginSha256(MY_ID);
    server.codingAccounts = [
      { accountSlot: "codex-mine", provider: "codex", email: "person@example.com", label: "mine", loginSha256: mine },
      { accountSlot: "codex-theirs", provider: "codex", loginSha256: null },
      { accountSlot: "slot-a", provider: "claude" },
    ];
    try {
      const ctx = makeCtx(home, { now: () => NOW });
      expect(await main(["codex-env", "--refresh"], ctx, { codexEnv: deps() })).toBe(0);
      const path = codexAccountsCachePathFor(home);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const cache = JSON.parse(readFileSync(path, "utf8")) as CodexAccountsCache;
      expect(cache).toEqual({ fetchedAt: NOW.toISOString(), workspace: FIXTURE_ME_BODY.account, accounts: [{ accountSlot: "codex-mine", loginSha256: mine }] });
      expect(readFileSync(path, "utf8")).not.toContain("person@example.com");
    } finally {
      server.codingAccounts = undefined;
    }
    writeLogin(codexHome, codexLogin(MY_ID));
    expect(slotOf((await print()).out)).toBe("codex-mine");
    expect(spawned).toEqual([]);
  });

  test("exactly one mode is required", async () => {
    expect(await main(["codex-env"], ctxWith(), { codexEnv: deps() })).toBe(1);
    expect(await main(["codex-env", "--print", "--refresh"], ctxWith(), { codexEnv: deps() })).toBe(1);
  });
});

describe("the cache file", () => {
  const writeRaw = (text: string) => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(codexAccountsCachePathFor(home), text);
  };
  const valid = { fetchedAt: NOW.toISOString(), workspace: FIXTURE_ME_BODY.account, accounts: [] };

  test("unreadable JSON or the wrong shape reads as no cache", () => {
    for (const text of [
      "{oops",
      "null",
      "[]",
      JSON.stringify({ ...valid, fetchedAt: 1 }),
      JSON.stringify({ ...valid, workspace: 7 }),
      JSON.stringify({ ...valid, accounts: "codex-mine" }),
    ]) {
      writeRaw(text);
      expect(readCodexAccountsCache(home), text).toBeNull();
    }
    writeRaw(JSON.stringify(valid));
    expect(readCodexAccountsCache(home)).toEqual(valid);
  });

  test("a row that is not an account, has no slot, or whose hash is not 64 lowercase hex is left out", () => {
    const mine = loginSha256(MY_ID);
    writeRaw(
      JSON.stringify({
        ...valid,
        accounts: [
          null,
          "codex-junk",
          { loginSha256: mine },
          { accountSlot: "codex-upper", loginSha256: mine.toUpperCase() },
          { accountSlot: "codex-short", loginSha256: "abc123" },
          { accountSlot: "codex-number", loginSha256: 5 },
          { accountSlot: "codex-mine", loginSha256: mine, email: "person@example.com" },
        ],
      }),
    );
    expect(readCodexAccountsCache(home)?.accounts).toEqual([{ accountSlot: "codex-mine", loginSha256: mine }]);
  });

  test("a fetch time that does not parse reads as stale: it still answers and starts a refresh", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache({ fetchedAt: "not-a-time" });
    const ctx = ctxWith();
    expect(await main(["codex-env", "--print", "--codex-home", codexHome, "--json"], ctx, { codexEnv: deps() })).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ slot: "codex-mine", cache: "stale", refreshStarted: true });
  });

  test("a broken login config reads as logged out: the launch still answers, with no map and no refresh", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeCache();
    writeFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), "{broken");
    const { code, out } = await print();
    expect(code).toBe(0);
    expect(slotOf(out)).toBe(UNREGISTERED_SLOT);
    expect(spawned).toEqual([]);
  });

  test("a refresh that cannot be spawned is not a failed launch", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    const ctx = ctxWith();
    const throwing = deps({
      detach: () => {
        throw new Error("spawn failed");
      },
    });
    expect(await main(["codex-env", "--print", "--codex-home", codexHome, "--json"], ctx, { codexEnv: throwing })).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ slot: UNREGISTERED_SLOT, cache: "missing", refreshStarted: false });
  });

  test("the real detached spawn returns straight away", async () => {
    const ctx = ctxWith();
    const real = deps({ detach: undefined, argv: ["-e", "0"] });
    expect(await main(["codex-env", "--print", "--codex-home", codexHome, "--json"], ctx, { codexEnv: real })).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ cache: "missing", refreshStarted: true });
  });
});

describe("--refresh", () => {
  const answering = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const refresh = async (ctx: TestCtx, extra: string[] = []) => main(["codex-env", "--refresh", ...extra], ctx, { codexEnv: deps() });

  test("logged out, it says how to log in and exits 2", async () => {
    home = tempHome();
    const ctx = makeCtx(home);
    expect(await refresh(ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("not connected yet");
  });

  test("on a cloud without the route, it says a newer one is needed and writes nothing", async () => {
    server.routesDeployed = false;
    try {
      const ctx = makeCtx(home, { now: () => NOW });
      expect(await refresh(ctx)).toBe(3);
      expect(ctx.err.join("\n")).toContain("needs a newer Catalyst Cloud");
    } finally {
      server.routesDeployed = true;
    }
    expect(existsSync(codexAccountsCachePathFor(home))).toBe(false);
  });

  test("when the cloud cannot be reached, it fails and writes nothing", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: offline, now: () => NOW });
    expect(await refresh(ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("could not reach");
    expect(existsSync(codexAccountsCachePathFor(home))).toBe(false);
  });

  test("it reads a bare array, an accounts object, an empty object and a null body, and counts in words", async () => {
    const one = { accountSlot: "codex-mine", loginSha256: loginSha256(MY_ID) };
    const two = { accountSlot: "codex-other", loginSha256: loginSha256(OTHER_ID) };
    const cases: [unknown, number, string][] = [
      [[one], 1, "Cached 1 Codex coding account for this workspace"],
      [{ accounts: [one, two] }, 2, "Cached 2 Codex coding accounts for this workspace"],
      [{}, 0, "Cached 0 Codex coding accounts for this workspace"],
      [null, 0, "Cached 0 Codex coding accounts for this workspace"],
    ];
    for (const [body, n, line] of cases) {
      const ctx = makeCtx(home, { fetch: answering(body), now: () => NOW });
      expect(await refresh(ctx), JSON.stringify(body)).toBe(0);
      expect(ctx.out.join("\n")).toContain(line);
      expect(ctx.out.join("\n")).toContain("6 hours");
      expect(readCodexAccountsCache(home)?.accounts).toHaveLength(n);
    }
  });

  test("--json names the path, the fetch time and the count", async () => {
    const ctx = makeCtx(home, { fetch: answering({ accounts: [{ accountSlot: "codex-mine", loginSha256: loginSha256(MY_ID) }] }), now: () => NOW });
    expect(await refresh(ctx, ["--json"])).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual({ path: codexAccountsCachePathFor(home), fetchedAt: NOW.toISOString(), accounts: 1 });
  });

  test("a cache it cannot write is a failed refresh that names the path", async () => {
    mkdirSync(codexAccountsCachePathFor(home), { recursive: true });
    const ctx = makeCtx(home, { fetch: answering({ accounts: [] }), now: () => NOW });
    expect(await refresh(ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain(`could not write ${codexAccountsCachePathFor(home)}`);
  });

  test("--codex-home is refused", async () => {
    const ctx = makeCtx(home);
    expect(await refresh(ctx, ["--codex-home", codexHome])).toBe(1);
    expect(ctx.err.join("\n")).toContain("--codex-home goes with --print");
  });
});

describe("--apply", () => {
  test("on macOS it sets the value with launchctl for the default Codex home", async () => {
    writeLogin(join(home, ".codex"), codexLogin(MY_ID));
    writeCache();
    const ctx = ctxWith({ OTEL_RESOURCE_ATTRIBUTES: "team=eng" });
    expect(await main(["codex-env", "--apply"], ctx, { codexEnv: deps() })).toBe(0);
    expect(launchctl).toEqual([
      ["launchctl", "setenv", "OTEL_RESOURCE_ATTRIBUTES", "team=eng,catalyst.account_slot=codex-mine,host.name=build-box"],
    ]);
    expect(fetches).toBe(0);
  });

  test("CODEX_HOME, when set, is the default Codex home", async () => {
    const elsewhere = join(home, "codex-homes", "work");
    writeLogin(elsewhere, codexLogin(MY_ID));
    writeCache();
    expect(await main(["codex-env", "--apply"], ctxWith({ CODEX_HOME: elsewhere }), { codexEnv: deps() })).toBe(0);
    expect(slotOf(launchctl[0]![3]!)).toBe("codex-mine");
  });

  test("on any other platform it refuses, non-zero, and runs nothing", async () => {
    writeLogin(join(home, ".codex"), codexLogin(MY_ID));
    const ctx = ctxWith();
    expect(await main(["codex-env", "--apply"], ctx, { codexEnv: deps({ platform: "linux" }) })).toBe(2);
    expect(ctx.err.join("\n")).toContain("macOS");
    expect(ctx.err.join("\n")).toContain("catalyst codex-env --print");
    expect(launchctl).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("a failed launchctl is a failed apply", async () => {
    const ctx = ctxWith();
    const failing = deps({ run: () => ({ status: 5, stderr: "denied" }) });
    expect(await main(["codex-env", "--apply"], ctx, { codexEnv: failing })).toBe(2);
    expect(ctx.err.join("\n")).toContain("launchctl setenv failed (exit 5): denied");
  });

  test("--codex-home goes with --print only", async () => {
    expect(await main(["codex-env", "--apply", "--codex-home", codexHome], ctxWith(), { codexEnv: deps() })).toBe(1);
    expect(launchctl).toEqual([]);
  });

  test("--json says it applied, and names the slot", async () => {
    writeLogin(join(home, ".codex"), codexLogin(MY_ID));
    writeCache();
    const ctx = ctxWith();
    expect(await main(["codex-env", "--apply", "--json"], ctx, { codexEnv: deps() })).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ slot: "codex-mine", applied: true, cache: "fresh" });
    expect(launchctl).toHaveLength(1);
  });

  test("an empty or blank CODEX_HOME counts as unset", () => {
    expect(defaultCodexHome(ctxWith())).toBe(join(home, ".codex"));
    expect(defaultCodexHome(ctxWith({ CODEX_HOME: "" }))).toBe(join(home, ".codex"));
    expect(defaultCodexHome(ctxWith({ CODEX_HOME: "   " }))).toBe(join(home, ".codex"));
    expect(defaultCodexHome(ctxWith({ CODEX_HOME: " /work/codex " }))).toBe("/work/codex");
  });

  test("with no platform injected, it follows this machine's platform", async () => {
    const ctx = ctxWith();
    const code = await main(["codex-env", "--apply"], ctx, { codexEnv: deps({ platform: undefined }) });
    expect(code).toBe(process.platform === "darwin" ? 0 : 2);
    expect(launchctl).toHaveLength(process.platform === "darwin" ? 1 : 0);
  });

  test("the real runner: a command that exits non-zero keeps its status and stderr; one that cannot start fails with its spawn error", () => {
    expect(defaultRun(process.execPath, ["-e", "process.stderr.write('refused'); process.exitCode = 3"])).toEqual({ status: 3, stderr: "refused" });
    expect(defaultRun(process.execPath, ["-e", "0"])).toEqual({ status: 0, stderr: "" });
    const missing = defaultRun(join(home, "no-such-launchctl"), []);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
  });

  // Never on a Mac: the real launchctl there would change the person's login environment.
  test.skipIf(process.platform === "darwin")("without an injected runner, a missing launchctl is a failed apply", async () => {
    const ctx = ctxWith();
    expect(await main(["codex-env", "--apply"], ctx, { codexEnv: deps({ run: undefined }) })).toBe(2);
    expect(ctx.err.join("\n")).toContain("launchctl setenv failed (exit 1)");
  });
});

describe("no printed value carries the account id or its hash", () => {
  test("matched, unregistered, applied and --json output name only the slot", async () => {
    writeLogin(codexHome, codexLogin(MY_ID));
    writeLogin(join(home, ".codex"), codexLogin(MY_ID));
    writeCache();
    const outputs: string[] = [];
    outputs.push((await print()).out);
    const json = ctxWith();
    await main(["codex-env", "--print", "--codex-home", codexHome, "--json"], json, { codexEnv: deps() });
    outputs.push(...json.out, ...json.err);
    const applied = ctxWith();
    await main(["codex-env", "--apply"], applied, { codexEnv: deps() });
    outputs.push(...applied.out, ...applied.err, ...launchctl.flat());
    writeCache({ accounts: [] });
    outputs.push((await print()).out);
    expect(outputs.some((o) => o.includes("codex-mine"))).toBe(true);
    expect(outputs.some((o) => o.includes(UNREGISTERED_SLOT))).toBe(true);
    for (const o of outputs) {
      expect(o).not.toContain(MY_ID);
      expect(o).not.toContain(loginSha256(MY_ID));
      expect(o).not.toContain(TOKEN);
      expect(pairs(o)).not.toContain("account");
    }
  });
});
