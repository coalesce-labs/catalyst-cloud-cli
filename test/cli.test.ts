// cli.test.ts — the dispatcher's own branches: version, bare usage, the update notice going to
// stderr for a machine-read verb, status after join, install, join --start-replica, join against a
// contract outside the range, a MeError exit, and the SDK loader's failure line.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_SKILLS, main, saveConfig } from "../src/cli";
import { configPathFor, contractPathFor, defaultReplicaDbFor, defaultSkillsDirFor } from "../src/config";
import { loadSdk, resetSdkCache } from "../src/sdk";
import { installTsDepsLoader, makeHooks } from "../src/ts-deps-loader";
import { startMeFixture, type FixtureServer } from "./fixture";
import { joinedConfig, makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";
import { PROVENANCE_MARKER } from "../src/skill-shape";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
  server.contractVersion = "1.0.0";
});

describe("dispatcher", () => {
  test("--version and bare usage", async () => {
    expect(await main(["--version"], ctx)).toBe(0);
    expect(ctx.out[0]).toMatch(/^@catalyst-cloud\/cli \d+\.\d+\.\d+ \(tenant contract range: [^\r\n()]+\)$/);
    const c2 = makeCtx(home);
    expect(await main([], c2)).toBe(0);
    expect(c2.out.join("\n")).toContain("Usage:");
    const c3 = makeCtx(home);
    expect(await main(["--wat"], c3)).toBe(1);
    expect(c3.err[0]).toContain("unknown option");
  });
  test("the update notice goes to stderr for a machine-read verb and to stdout for a human one", async () => {
    saveConfig(home, joinedConfig(server, { lastSkillBundleVersion: "0.0.1" }));
    expect(await main(["me"], ctx)).toBe(0);
    expect(ctx.out.some((l) => l.startsWith("[catalyst]"))).toBe(false);
    expect(ctx.err.some((l) => l.startsWith("[catalyst] updated 0.0.1"))).toBe(true);
    saveConfig(home, joinedConfig(server, { lastSkillBundleVersion: "0.0.1" }));
    const c2 = makeCtx(home);
    expect(await main(["notice"], c2)).toBe(0);
    expect(c2.out.some((l) => l.startsWith("[catalyst] updated 0.0.1"))).toBe(true);
  });
  test("an installer-owned CLI probe preserves an old stamped skill until the installer replaces it", async () => {
    const skill = join(defaultSkillsDirFor(home), "catalyst-onboard");
    mkdirSync(skill, { recursive: true });
    const old = `---\nname: catalyst-onboard\n---\n<!-- ${PROVENANCE_MARKER}@0.0.1 -->\nOld installer copy\n`;
    writeFileSync(join(skill, "SKILL.md"), old);
    writeFileSync(join(skill, "fixture.txt"), "old bytes\n");
    saveConfig(home, joinedConfig(server, { lastSkillBundleVersion: "0.0.1" }));

    const owned = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", CATALYST_INSTALL_SKILLS_OWNER: "1" } });
    expect(await main(["capabilities", "--json"], owned)).toBe(0);
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(old);
    expect(readFileSync(join(skill, "fixture.txt"), "utf8")).toBe("old bytes\n");
    await main(["ready", "--json"], makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", CATALYST_INSTALL_SKILLS_OWNER: "1" } }));
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(old);

    saveConfig(home, joinedConfig(server, { lastSkillBundleVersion: "0.0.1" }));
    expect(await main(["capabilities", "--json"], makeCtx(home))).toBe(0);
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).not.toBe(old);
  });
  test("status names the credential: 'personal key' for a key config, 'your login (expires …)' for an oauth one", async () => {
    await seedJoined(home, server, { config: { user: undefined } });
    expect(await main(["status"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Credential: personal key");

    const home2 = tempHome();
    const now = new Date("2026-09-12T12:00:00Z");
    const c2 = makeCtx(home2, { now: () => now });
    mkdirSync(join(home2, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(
      configPathFor(home2),
      JSON.stringify({
        baseUrl: server.url,
        account: "tenant-3",
        slug: "hagale-technologies",
        name: "Hagale Technologies",
        permissions: ["mirror:read", "mirror:feed"],
        principal: "service",
        user: { id: "d1-user-tony", label: "Tony", email: null, role: "admin", linearUserId: "lin-tony" },
        joinedAt: now.toISOString(),
        lastSkillBundleVersion: "0.4.0",
        auth: { kind: "oauth", accessToken: "at", refreshToken: "rt", expiresAt: new Date(now.getTime() + 14 * 60_000).toISOString(), sessionId: "sess" },
      }),
    );
    expect(await main(["status"], c2)).toBe(0);
    const t2 = c2.out.join("\n");
    expect(t2).toContain("As: Tony (admin)");
    expect(t2).toMatch(/Credential: your login \(expires in 14m\)/);
  });
  test("status after login names the CLI path and the contract cache", async () => {
    await seedJoined(home, server);
    expect(await main(["status"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^CLI: .*bin\/catalyst\.js$/m);
    expect(text).toContain(`Contract: ${contractPathFor(home)}`);
    const home2 = tempHome();
    await seedJoined(home2, server, { contract: false, config: { cliPath: `${home2}/gone.js` } });
    const c2 = makeCtx(home2);
    expect(await main(["status"], c2)).toBe(0);
    // 0.9.3: a recorded launcher that no longer exists heals to the running one, so status shows it.
    expect(c2.out.join("\n")).not.toContain("(missing — re-run login)");
    expect(c2.out.join("\n")).toMatch(/^CLI: .*bin\/catalyst\.js$/m);
    expect(c2.out.join("\n")).toContain("not cached");
  });
  test("install places the skills and names a skipped foreign dir", async () => {
    const dir = join(home, "sk");
    mkdirSync(join(dir, "unstick"), { recursive: true });
    writeFileSync(join(dir, "unstick", "SKILL.md"), "mine");
    expect(await main(["install", "--skills-dir", dir], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain('Skipped "unstick"');
    expect(ctx.out.join("\n")).toContain("Skills installed to");
    const allForeign = join(home, "foreign");
    for (const name of CUSTOMER_SKILLS) {
      mkdirSync(join(allForeign, name), { recursive: true });
      writeFileSync(join(allForeign, name, "SKILL.md"), "mine");
    }
    const c2 = makeCtx(home);
    expect(await main(["install", "--skills-dir", allForeign], c2)).toBe(0);
    expect(c2.out.join("\n")).toContain("already had them");
  });
  test("login --start-replica spawns the detached writer", async () => {
    const spawned: string[][] = [];
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url, "--start-replica"], ctx, {
      replica: { detach: (argv) => (spawned.push(argv), { pid: process.pid }) },
    });
    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]![0]).toMatch(/bin\/catalyst\.js$/);
    expect(spawned[0]!.slice(1)).toEqual(["replica", "start"]);
    expect(existsSync(`${defaultReplicaDbFor(home)}.pid`)).toBe(true);
    expect(ctx.out.join("\n")).toContain("replica writer started in the background");
  });
  test("login against a contract outside the range still connects and says so on stderr", async () => {
    server.contractVersion = "3.0.0";
    expect(await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx)).toBe(0);
    expect(ctx.err.join("\n")).toMatch(/3\.0\.0 but this bundle accepts 1\.x \|\| 2\.x/);
    expect(existsSync(contractPathFor(home))).toBe(false);
    // The config is still written, so the customer can update the bundle and re-read the contract.
    expect(existsSync(configPathFor(home))).toBe(true);
  });
  test("login keeps an existing replicaDb and tolerates a corrupt previous config", async () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), "{corrupt");
    expect(await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), "utf8")) as { replicaDb: string };
    expect(cfg.replicaDb).toBe(defaultReplicaDbFor(home));
    saveConfig(home, joinedConfig(server, { replicaDb: "/elsewhere/replica.db" }));
    expect(await main(["join", "--key", "fixture-key", "--base-url", server.url], makeCtx(home))).toBe(0);
    expect((JSON.parse(readFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), "utf8")) as { replicaDb: string }).replicaDb).toBe("/elsewhere/replica.db");
  });
  test("a dead server is a MeError exit 2 for me; a contract positional is a usage error", async () => {
    await seedJoined(home, server, { contract: false, config: { baseUrl: "http://127.0.0.1:1" } });
    expect(await main(["me"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("could not reach");
    await seedJoined(home, server);
    expect(await main(["contract", "extra"], makeCtx(home))).toBe(1);
    const c3 = makeCtx(home);
    expect(await main(["contract", "--refresh", "--path", "vocabulary.bookkeeping.marker"], c3)).toBe(0);
    expect(c3.out.join("\n")).toBe("[bookkeeping-fixture]");
    expect(c3.err[0]).toMatch(/^contract: 1\.0\.0 from (network|revalidated)/);
  });
});

describe("sdk loader", () => {
  test("loadSdk wraps an import failure in one CliError line and does not cache it", async () => {
    resetSdkCache();
    const err = (await loadSdk(async () => {
      throw new Error("ERR_SOMETHING: nope\nsecond line");
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/could not be loaded on Node .*: ERR_SOMETHING: nope — this verb needs the SDK/);
    expect(err.message).toContain("22.15");
    expect(err.message).toContain("npx -y -p @catalyst-cloud/cli catalyst runtime install");
    expect(err.message).not.toMatch(/or under bun/);
    resetSdkCache();
    expect(typeof (await loadSdk()).nodeSqliteEngine).toBe("function");
    expect(await loadSdk()).toBe(await loadSdk());
  });
  test("installTsDepsLoader names the missing API, and is a no-op once installed", () => {
    expect(installTsDepsLoader()).toEqual({ installed: true });
    expect(installTsDepsLoader({})).toEqual({ installed: true });
  });
  test("the hook pair: only node_modules .ts files are stripped, and only a failed .js → .ts relative import is remapped", () => {
    const hooks = makeHooks(
      (src) => `stripped:${src}`,
      (p) => p.endsWith("/node_modules/pkg/src/mirror.ts"),
      (p) => `source of ${p}`,
    );
    const notFound = Object.assign(new Error("nf"), { code: "ERR_MODULE_NOT_FOUND" });
    const next = () => {
      throw notFound;
    };
    const parent = "file:///x/node_modules/pkg/src/index.ts";
    expect(hooks.resolve("./mirror.js", { parentURL: parent }, next)).toEqual({ url: "file:///x/node_modules/pkg/src/mirror.ts", format: "module", shortCircuit: true });
    expect(hooks.resolve("./mirror", { parentURL: parent }, next).url).toBe("file:///x/node_modules/pkg/src/mirror.ts");
    expect(() => hooks.resolve("./other.js", { parentURL: parent }, next)).toThrow(notFound);
    expect(() => hooks.resolve("./mirror.js", { parentURL: "file:///x/src/app.ts" }, next)).toThrow(notFound);
    expect(() => hooks.resolve("pkg", { parentURL: parent }, next)).toThrow(notFound);
    const other = Object.assign(new Error("boom"), { code: "ERR_OTHER" });
    expect(() =>
      hooks.resolve("./mirror.js", { parentURL: parent }, () => {
        throw other;
      }),
    ).toThrow(other);
    expect(hooks.resolve("./ok.js", { parentURL: parent }, () => ({ url: "file:///ok.js" }))).toEqual({ url: "file:///ok.js" });
    const passthrough = { format: "module", source: "x" };
    expect(hooks.load("file:///x/node_modules/pkg/src/mirror.ts", {}, () => passthrough)).toEqual({ format: "module", shortCircuit: true, source: "stripped:source of /x/node_modules/pkg/src/mirror.ts" });
    expect(hooks.load("file:///x/src/app.ts", {}, () => passthrough)).toBe(passthrough);
    expect(hooks.load("file:///x/node_modules/pkg/dist/index.js", {}, () => passthrough)).toBe(passthrough);
  });
});
