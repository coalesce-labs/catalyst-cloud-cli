// login.test.ts — unit + flow coverage for login (and its deprecated `join` alias): tenant discovery
// from the key (GET /me), the 0600 config write with the CLI path, the cached contract, the fact
// that login installs no skills, and the one-line update notice a new version prints next session.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CliError,
  CUSTOMER_SKILLS,
  MeError,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  PROVENANCE_MARKER,
  UsageError,
  configPathFor,
  contractPathFor,
  defaultCtx,
  defaultSkillsDirFor,
  fetchMe,
  installSkills,
  loadConfig,
  main,
  normalizeBaseUrl,
  parseArgs,
  parseChangelogEntry,
  saveConfig,
  updateNoticeLine,
  writeConfig,
  formatMode,
  type CustomerConfig,
  type Ctx,
} from "../src/cli";
import { FIXTURE_ME_BODY, FIXTURE_ME_USER, FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";

let home: string;
let out: string[];
let err: string[];
let server: FixtureServer;

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: {},
    home,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
    now: () => new Date("2026-09-09T12:00:00Z"),
    ...overrides,
  };
}

function seededConfig(over: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    baseUrl: "https://example.dev",
    key: "fixture-key",
    account: FIXTURE_ME_BODY.account,
    slug: FIXTURE_ME_BODY.slug,
    name: FIXTURE_ME_BODY.name,
    permissions: [...FIXTURE_ME_BODY.permissions],
    principal: FIXTURE_ME_BODY.principal,
    joinedAt: "2026-09-01T00:00:00Z",
    lastSkillBundleVersion: "0.0.9",
    ...over,
  };
}

function readConfig(): CustomerConfig {
  return JSON.parse(readFileSync(configPathFor(home), "utf8")) as CustomerConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "catalyst-skills-"));
  out = [];
  err = [];
});

afterAll(async () => {
  await server?.close();
});

beforeAll(async () => {
  server = await startMeFixture();
});

describe("parseArgs", () => {
  test("parses login with flags", () => {
    const a = parseArgs([
      "login",
      "--key",
      "k",
      "--base-url",
      "http://x",
      "--skills-dir",
      "/s",
      "--force",
    ]);
    expect(a).toMatchObject({
      command: "login",
      key: "k",
      baseUrl: "http://x",
      skillsDir: "/s",
      force: true,
    });
  });
  test("missing flag value is a UsageError", () => {
    expect(() => parseArgs(["login", "--key"])).toThrow(UsageError);
  });
  test("unknown option is a UsageError", () => {
    expect(() => parseArgs(["--wat"])).toThrow(UsageError);
  });
  test("a second positional is the subcommand and the rest are positionals", () => {
    const a = parseArgs(["query", "issue", "ABC-1", "--json"]);
    expect(a.command).toBe("query");
    expect(a.subcommand).toBe("issue");
    expect(a.rest).toEqual(["ABC-1"]);
    expect(a.json).toBe(true);
    expect(parseArgs(["login", "extra"])).toMatchObject({ command: "login", subcommand: "extra", rest: [] });
  });
  test("a flag another verb owns is a UsageError for login", () => {
    expect(() => parseArgs(["login", "--refresh"])).toThrow(UsageError);
  });
  test("help and version flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
  });
});

describe("normalizeBaseUrl", () => {
  test("strips trailing slashes only", () => {
    expect(normalizeBaseUrl("https://x.dev///")).toBe("https://x.dev");
    expect(normalizeBaseUrl("https://x.dev")).toBe("https://x.dev");
  });
});

describe("fetchMe — the key names the tenant (CTC-493 / PR #3332)", () => {
  test("happy path echoes account, slug, name, permissions, principal", async () => {
    const me = await fetchMe(server.url, "fixture-key", fetch);
    expect(me).toEqual(FIXTURE_ME_BODY);
  });
  test("permissions null (unrestricted) round-trips as null", async () => {
    const unrestricted = await startMeFixture(() => ({
      status: 200,
      body: { ...FIXTURE_ME_BODY, permissions: null, principal: "session" },
    }));
    try {
      const me = await fetchMe(unrestricted.url, "fixture-key", fetch);
      expect(me.permissions).toBeNull();
      expect(me.principal).toBe("session");
    } finally {
      await unrestricted.close();
    }
  });
  test("401 becomes a human-readable MeError that never echoes the key", async () => {
    await expect(fetchMe(server.url, "wrong-key", fetch)).rejects.toThrow(
      /credential not accepted/,
    );
    try {
      await fetchMe(server.url, "wrong-key", fetch);
    } catch (e) {
      expect(e).toBeInstanceOf(MeError);
      expect((e as MeError).kind).toBe("http");
      expect((e as MeError).status).toBe(401);
      expect((e as Error).message).not.toContain("wrong-key");
    }
  });
  test("network failure becomes a kind=network MeError naming the URL", async () => {
    const refuse = await startMeFixture();
    const deadUrl = refuse.url;
    await refuse.close();
    await expect(fetchMe(deadUrl, "fixture-key", fetch)).rejects.toMatchObject({ kind: "network" });
  });
  test("a body missing required fields is a shape error", async () => {
    const bad = await startMeFixture(() => ({ status: 200, body: { account: "tenant-3" } }));
    try {
      await expect(fetchMe(bad.url, "fixture-key", fetch)).rejects.toMatchObject({ kind: "shape" });
    } finally {
      await bad.close();
    }
  });
});

describe("config read/write", () => {
  test("absent config loads as null", () => {
    expect(loadConfig(home)).toBeNull();
  });
  test("corrupt config is a loud CliError, not a silent null", () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), "{oops");
    expect(() => loadConfig(home)).toThrow(CliError);
  });
  test("config missing fields is a CliError", () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), JSON.stringify({ account: "x" }));
    expect(() => loadConfig(home)).toThrow(CliError);
  });
  test("saveConfig writes mode 0600 and round-trips", () => {
    const cfg: CustomerConfig = {
      baseUrl: "https://example.dev",
      key: "k",
      account: "tenant-3",
      slug: "s",
      name: "n",
      permissions: ["mirror:read"],
      principal: "service",
      joinedAt: "2026-09-09T00:00:00Z",
      lastSkillBundleVersion: "0.1.0",
    };
    const path = saveConfig(home, cfg);
    expect(path).toBe(configPathFor(home));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(home)).toEqual(cfg);
  });
  test("Codex P1: rewriting an existing world-readable config re-applies 0600 (mode is not create-only)", () => {
    const path = configPathFor(home);
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(path, "{corrupt");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const written = writeConfig(home, seededConfig());
    expect(written.path).toBe(path);
    expect(written.mode).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(formatMode(written.mode)).toBe("0600");
  });
});

describe("changelog + Tier 2 notice", () => {
  test("parseChangelogEntry finds the entry, skips blanks, stops at the next heading", () => {
    const md = [
      "# Changelog",
      "",
      "## 0.2.0",
      "",
      "first line of 0.2.0",
      "second line",
      "## 0.1.0",
      "entry for 0.1.0",
    ].join("\n");
    expect(parseChangelogEntry(md, "0.2.0")).toBe("first line of 0.2.0");
    expect(parseChangelogEntry(md, "0.1.0")).toBe("entry for 0.1.0");
    expect(parseChangelogEntry(md, "9.9.9")).toBeNull();
  });
  test("the shipped CHANGELOG has an entry for the shipped version", () => {
    const version = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(parseChangelogEntry(changelog, version)).toBeTruthy();
  });
  test("the notice line is ONE line with old version, new version, the entry, and the update command", () => {
    const line = updateNoticeLine("0.1.0", "0.2.0", "added cycles");
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("0.1.0");
    expect(line).toContain("0.2.0");
    expect(line).toContain("added cycles");
    // A caret range below 1.0.0 never moves a minor, so `npm update -g` never crosses 0.2.x → 0.3.0;
    // the upgrade command must pin @latest via `npm install -g`, then re-run login so the new global
    // bin rewrites customer.json.cliPath (or the helpers keep spawning the stale recorded bundle).
    expect(line).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    expect(line).toContain("catalyst login");
    expect(line).not.toContain("npm update");
    expect(updateNoticeLine("0.1.0", "0.2.0", null)).toContain("see CHANGELOG.md");
  });
});

describe("installSkills", () => {
  test("installs every customer skill with its references, scripts and sidecars, idempotently", () => {
    const target = join(home, "skills");
    const first = installSkills(target, {});
    expect(first.installed.sort()).toEqual([...CUSTOMER_SKILLS]);
    expect(first.skipped).toEqual([]);
    const second = installSkills(target, {});
    expect(second.installed.sort()).toEqual([...CUSTOMER_SKILLS]);
    expect(readFileSync(join(target, "whats-happening", "SKILL.md"), "utf8")).toContain(
      PROVENANCE_MARKER,
    );
    for (const name of CUSTOMER_SKILLS) {
      expect(existsSync(join(target, name, "scripts", "lib", "cli.mjs")), `${name} scripts must install`).toBe(true);
      expect(existsSync(join(target, name, "agents", "portability.yaml")), `${name} sidecars must install`).toBe(true);
      expect(readdirSync(join(target, name, "references")).length, `${name} references must install`).toBeGreaterThan(0);
    }
  });
  test("a foreign skill dir is skipped without --force and replaced with it", () => {
    const target = join(home, "skills");
    mkdirSync(join(target, "whats-happening"), { recursive: true });
    writeFileSync(join(target, "whats-happening", "SKILL.md"), "---\nname: whats-happening\n---\nmine");
    const skipped = installSkills(target, {});
    expect(skipped.installed).not.toContain("whats-happening");
    expect(skipped.skipped).toEqual([{ name: "whats-happening", reason: "foreign-skill-dir" }]);
    expect(readFileSync(join(target, "whats-happening", "SKILL.md"), "utf8")).toContain("mine");
    const forced = installSkills(target, { force: true });
    expect(forced.installed).toContain("whats-happening");
    expect(readFileSync(join(target, "whats-happening", "SKILL.md"), "utf8")).toContain(
      PROVENANCE_MARKER,
    );
  });
});

describe("main — login (and the deprecated join alias)", () => {
  test("happy path: a personal key discovers the tenant AND the person, writes the 0600 config, installs no skills", async () => {
    const code = await main(["login", "--key", FIXTURE_USER_KEY, "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain(`Catalyst workspace: ${FIXTURE_ME_BODY.name} (${FIXTURE_ME_BODY.slug})`);
    // CTC-4680: the internal account id and the word "tenant" never reach the person.
    expect(out.join("\n")).not.toContain(FIXTURE_ME_BODY.account);
    expect(out.join("\n")).not.toMatch(/tenant/i);
    expect(out.join("\n")).toContain(`Signed in to Catalyst as ${FIXTURE_ME_USER.label} (${FIXTURE_ME_USER.role})`);
    const cfg = readConfig();
    expect(cfg).toMatchObject({
      account: "tenant-3",
      slug: "hagale-technologies",
      baseUrl: server.url,
      user: FIXTURE_ME_USER,
    });
    expect(cfg.key).toBe(FIXTURE_USER_KEY);
    expect(cfg.cliPath, "the skill scripts spawn the CLI login recorded").toMatch(/bin\/catalyst\.js$/);
    expect(statSync(configPathFor(home)).mode & 0o777).toBe(0o600);
    // Installing is the agent's own command. A login that also copied the set would leave a plugin
    // user with every skill twice, which is the one thing the README's install section warns about.
    expect(out.join("\n")).not.toMatch(/Skills installed/);
    for (const name of CUSTOMER_SKILLS) {
      expect(existsSync(join(defaultSkillsDirFor(home), name, "SKILL.md")), `${name} must not be copied by login`).toBe(false);
    }
  });
  test("join is still accepted, dispatches to login, and is the same run", async () => {
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`Catalyst workspace: ${FIXTURE_ME_BODY.name}`);
    expect(readConfig().account).toBe("tenant-3");
  });
  test("⭐ no key: login runs the device flow, prints the code + URL, writes an oauth config (no key, 0600), and names the person", async () => {
    server.oauth.pendingPolls = 1;
    const opened: string[] = [];
    const code = await main(["login", "--base-url", server.url], ctx(), {
      isTty: () => false,
      openBrowser: (u) => opened.push(u),
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("WXYZ-1234");
    expect(out.join("\n")).toContain(`${server.url}/activate`);
    expect(out.join("\n")).toContain(`Signed in to Catalyst as ${FIXTURE_ME_USER.label} (${FIXTURE_ME_USER.role})`);
    expect(opened, "no browser opened without a TTY").toEqual([]);
    const cfg = readConfig();
    expect(cfg.key, "an oauth config carries no key").toBeUndefined();
    expect(cfg.auth?.kind).toBe("oauth");
    expect(cfg.auth?.refreshToken).toBe("refresh-1");
    expect(cfg.auth?.sessionId).toBe("session_fixture");
    expect(statSync(configPathFor(home)).mode & 0o777).toBe(0o600);
  });
  test("CTC-4680: the opened-browser line is plain words, with no em dash", async () => {
    server.oauth.pendingPolls = 1;
    const opened: string[] = [];
    const code = await main(["login", "--base-url", server.url], ctx(), {
      isTty: () => true,
      openBrowser: (u) => opened.push(u),
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(opened).toHaveLength(1);
    const text = out.join("\n");
    expect(text).toContain("Opened your browser to that page. Approve there, or use the code above.");
    expect(text).not.toContain("\u2014");
  });
  test("CTC-2136: keyless login whose codes ALL expire mints 3, then prints one plain resume line and exits 2", async () => {
    server.oauth.expired = true;
    const before = server.oauth.deviceAuthorizeCount;
    try {
      const code = await main(["login", "--base-url", server.url], ctx(), { isTty: () => false, sleep: async () => {} });
      expect(code).toBe(2);
      expect(err.join("\n")).toContain("The sign-in code expired 3 times. Run the same command again when you are ready to approve.");
      expect(server.oauth.deviceAuthorizeCount - before, "exactly 3 device codes in one login").toBe(3);
      expect(existsSync(configPathFor(home)), "no config written on a failed login").toBe(false);
    } finally {
      server.oauth.expired = false;
      server.oauth.lastMintExpired = false; // the shared server's next login starts a fresh code chain
    }
  });
  test("⭐ CTC-2136: keyless login whose first code expires carries on with a fresh code and connects, in one process", async () => {
    server.oauth.expireNextCodes = 1;
    const before = server.oauth.deviceAuthorizeCount;
    try {
      const code = await main(["login", "--base-url", server.url], ctx(), { isTty: () => false, sleep: async () => {} });
      expect(code).toBe(0);
      const printed = out.join("\n");
      expect(printed).toContain("That code expired. Here is a new one (2 of 3):");
      expect(printed).toContain("WXYZ-1235");
      expect(printed).toContain(`Signed in to Catalyst as ${FIXTURE_ME_USER.label}`);
      expect(printed.match(/Config written to /g), "credentials written once").toHaveLength(1);
      expect(server.oauth.deviceAuthorizeCount - before).toBe(2);
      expect(readConfig().auth?.kind).toBe("oauth");
      expect(readConfig().auth?.refreshToken).toBe("refresh-1");
    } finally {
      server.oauth.expireNextCodes = 0;
      server.oauth.lastMintExpired = false;
    }
  });
  test("keyless login DENIED prints one clear actionable line and exits 2", async () => {
    server.oauth.denied = true;
    try {
      const code = await main(["login", "--base-url", server.url], ctx(), { isTty: () => false, sleep: async () => {} });
      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(/denied/);
      expect(err.join("\n")).toContain("catalyst login");
    } finally {
      server.oauth.denied = false;
    }
  });
  test("keyless login names the role from /me.user.role, NOT the token's role claim (probe: token said member for a D1 admin)", async () => {
    const before = server.oauth.jwtRole;
    server.oauth.jwtRole = "member"; // the unreliable JWT claim
    try {
      const code = await main(["login", "--base-url", server.url], ctx(), { isTty: () => false, sleep: async () => {} });
      expect(code).toBe(0);
      // FIXTURE_ME_USER.role is "admin" from /me — the printed role must be that, not the token's "member"
      expect(out.join("\n")).toContain(`Signed in to Catalyst as ${FIXTURE_ME_USER.label} (admin)`);
      expect(out.join("\n")).not.toContain("(member)");
      expect(readConfig().user?.role).toBe("admin");
    } finally {
      server.oauth.jwtRole = before;
    }
  });
  test("no key with a terminal attached opens the browser at the completion URL, once", async () => {
    server.oauth.pendingPolls = 0;
    const opened: string[] = [];
    const code = await main(["login", "--base-url", server.url], ctx(), {
      isTty: () => true,
      openBrowser: (u) => opened.push(u),
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(opened).toEqual([`${server.url}/activate?user_code=WXYZ-1234`]);
  });
  test("key and base URL fall back to CATALYST_CLOUD_TOKEN / CATALYST_CLOUD_BASE_URL", async () => {
    const code = await main(
      ["login"],
      ctx({ env: { CATALYST_CLOUD_TOKEN: "fixture-key", CATALYST_CLOUD_BASE_URL: server.url } }),
    );
    expect(code).toBe(0);
    expect(readConfig().baseUrl).toBe(server.url);
  });
  test("login --key still takes the key path unchanged (regression pin: no device flow, no oauth block)", async () => {
    const before = server.oauth.deviceAuthorizeCount;
    const code = await main(["login", "--key", FIXTURE_USER_KEY, "--base-url", server.url], ctx(), { isTty: () => true, sleep: async () => {} });
    expect(code).toBe(0);
    expect(readConfig().key).toBe(FIXTURE_USER_KEY);
    expect(readConfig().auth).toBeUndefined();
    expect(server.oauth.deviceAuthorizeCount, "the key path starts no device flow").toBe(before);
  });
  test("a rejected key is exit 2 with a human-readable cause and no config", async () => {
    const code = await main(["login", "--key", "wrong-key", "--base-url", server.url], ctx());
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("credential not accepted");
    expect(err.join("\n")).not.toContain("wrong-key");
    expect(existsSync(configPathFor(home))).toBe(false);
  });
  test("login overwrites a corrupt config instead of refusing to repair it", async () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), "{corrupt");
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(readConfig().account).toBe("tenant-3");
  });
  test("Codex P1: repairing a 0644 corrupt config leaves it 0600 and the reported mode is the real one", async () => {
    const path = configPathFor(home);
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(path, "{corrupt");
    chmodSync(path, 0o644);
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const modeLine = out.find((l) => l.startsWith("Config written to"));
    expect(modeLine).toContain("(mode 0600,");
    expect(modeLine).not.toContain("chmod it by hand");
  });
  test("login records the skills dir, so a later update refreshes copies that already live there", async () => {
    const skillsDir = join(home, "elsewhere", "skills");
    const code = await main(
      ["login", "--key", "fixture-key", "--base-url", server.url, "--skills-dir", skillsDir],
      ctx(),
    );
    expect(code).toBe(0);
    expect(readConfig().skillsDir).toBe(skillsDir);
  });

  test("login caches the tenant contract beside the config", async () => {
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(existsSync(contractPathFor(home))).toBe(true);
    const cached = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { contractVersion: string };
    expect(cached.contractVersion).toBe("1.0.0");
    expect(out.join("\n")).toContain("Saved your workspace settings (version 1.0.0) to");
  });

  test("the tenant's account key still connects, but says it names no person and points at a personal key", async () => {
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(readConfig().key).toBe("fixture-key");
    expect(readConfig().user).toBeUndefined();
    expect(err.join("\n")).toMatch(/shared key \(a host credential\)/);
    expect(err.join("\n")).toMatch(/Settings → API keys/);
    expect(out.join("\n")).not.toContain("Connected as");
    // The contract is still cached: since CTC-2076 nothing a person reads is refused by class.
    expect(existsSync(contractPathFor(home))).toBe(true);
  });

  test("a personal key whose Linear identity is unmatched says so on login and still connects", async () => {
    server.meUser = { ...FIXTURE_ME_USER, linearUserId: null };
    try {
      const code = await main(["login", "--key", FIXTURE_USER_KEY, "--base-url", server.url], ctx());
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/Signed in to Catalyst as Tony \(admin\) — your Linear identity is not matched yet/);
      expect(readConfig().user?.linearUserId).toBeNull();
    } finally {
      server.meUser = undefined;
    }
  });
});

describe("main — Tier 2 notice (a new version's next session)", () => {
  test("a stale stamp prints exactly one notice line and updates the stamp", async () => {
    saveConfig(home, seededConfig());
    let code = await main(["notice"], ctx());
    expect(code).toBe(0);
    const noticeLines = out.filter((l) => l.startsWith("[catalyst] updated"));
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    expect(noticeLines[0]).toContain("catalyst login");
    expect(noticeLines[0]).not.toContain("npm update");
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
    out = [];
    code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst]"))).toHaveLength(0);
  });
  test("login after an update also prints the one-line notice", async () => {
    saveConfig(home, seededConfig({ baseUrl: server.url }));
    const code = await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst] updated"))).toHaveLength(1);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });
  test("notice with no config is silent and exit 0", async () => {
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });
});

describe("main — a CLI notice preserves installed skills", () => {
  const STALE =
    "---\nname: concierge\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills -->\nSTALE COPY FROM 0.0.9\n";

  function seedStaleCopies(skillsDir: string): void {
    for (const name of CUSTOMER_SKILLS) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), STALE.replace("concierge", name));
    }
  }

  test("a stale stamp records the notice while preserving every installed skill", async () => {
    const skillsDir = join(home, "recorded", "skills");
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig({ skillsDir }));
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    for (const name of CUSTOMER_SKILLS) {
      const md = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      expect(md, `${name} must retain its installed bytes`).toBe(STALE.replace("concierge", name));
      expect(md).toContain(PROVENANCE_MARKER);
    }
    expect(out.filter((l) => l.startsWith("[catalyst] refreshed"))).toHaveLength(0);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });

  test("a notice leaves the default skills directory and destination setting unchanged", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig());
    await main(["notice"], ctx());
    expect(readFileSync(join(skillsDir, "whats-happening", "SKILL.md"), "utf8")).toBe(STALE.replace("concierge", "whats-happening"));
    expect(readConfig().skillsDir).toBeUndefined();
  });

  test("a notice preserves both customer-authored and bundle-owned skill bytes", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    writeFileSync(join(skillsDir, "unstick", "SKILL.md"), "---\nname: unstick\n---\nmine");
    saveConfig(home, seededConfig());
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(readFileSync(join(skillsDir, "unstick", "SKILL.md"), "utf8")).toContain("mine");
    expect(readFileSync(join(skillsDir, "whats-happening", "SKILL.md"), "utf8")).toBe(STALE.replace("concierge", "whats-happening"));
    expect(out.join("\n")).not.toContain('left "unstick" alone');
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });

  test("a notice records the CLI version without attempting to repair an invalid skills path", async () => {
    const skillsDir = join(home, "not-a-dir");
    writeFileSync(skillsDir, "a file where the skills dir should be");
    saveConfig(home, seededConfig({ skillsDir }));
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
    expect(err).toEqual([]);
    expect(readFileSync(skillsDir, "utf8")).toBe("a file where the skills dir should be");
    expect(out.filter((l) => l.startsWith("[catalyst] refreshed"))).toHaveLength(0);
  });

  test("a config with no notice stamp records the CLI version and keeps skill bytes", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig({ lastSkillBundleVersion: "" }));
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst] updated"))).toHaveLength(0);
    expect(readFileSync(join(skillsDir, "unstick", "SKILL.md"), "utf8")).toBe(STALE.replace("concierge", "unstick"));
    expect(readConfig().lastSkillBundleVersion).not.toBe("");
  });
});

describe("main — status / install / help / version", () => {
  test("status before login says how to connect, naming login and the env form", async () => {
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`npx ${LEGACY_PACKAGE_NAME} login`);
    expect(out.join("\n")).toContain("CATALYST_CLOUD_TOKEN");
  });
  test("status after login names the tenant and contract range", async () => {
    await main(["login", "--key", "fixture-key", "--base-url", server.url], ctx());
    out = [];
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(FIXTURE_ME_BODY.name);
    expect(out.join("\n")).toContain("1.x");
  });
  test("install places skills without touching config, and names a skipped foreign dir", async () => {
    const skillsDir = join(home, "claude-skills");
    mkdirSync(join(skillsDir, "whats-happening"), { recursive: true });
    writeFileSync(join(skillsDir, "whats-happening", "SKILL.md"), "mine");
    const code = await main(["install", "--skills-dir", skillsDir], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Skills installed to");
    expect(out.join("\n")).toContain('Skipped "whats-happening"');
    expect(existsSync(configPathFor(home))).toBe(false);
  });
  test("an empty --key value is a usage error, not an empty credential", async () => {
    const code = await main(["login", "--key", ""], ctx());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--key requires a value");
  });
  test("help prints usage, exit 0", async () => {
    const code = await main([], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });
  test("unknown command is exit 1 with usage on stderr", async () => {
    const code = await main(["frobnicate"], ctx());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown command");
  });
  test("version prints name, version and the contract range", async () => {
    const code = await main(["--version"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(PACKAGE_NAME);
    expect(PACKAGE_NAME).toBe("@catalyst-cloud/cli");
    expect(out.join("\n")).toContain("1.x");
  });
});

describe("defaultCtx", () => {
  test("prefers CATALYST_SKILLS_HOME, then HOME, then /", () => {
    const saved = { ...process.env };
    try {
      process.env.CATALYST_SKILLS_HOME = "/a";
      process.env.HOME = "/b";
      expect(defaultCtx().home).toBe("/a");
      delete process.env.CATALYST_SKILLS_HOME;
      expect(defaultCtx().home).toBe("/b");
      delete process.env.HOME;
      expect(defaultCtx().home).toBe("/");
    } finally {
      process.env.CATALYST_SKILLS_HOME = saved.CATALYST_SKILLS_HOME;
      process.env.HOME = saved.HOME;
    }
  });
});
