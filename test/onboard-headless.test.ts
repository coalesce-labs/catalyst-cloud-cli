// CTC-4633 — `catalyst onboard --headless`: the non-interactive path for CI, image builds and agent
// VMs. Every browser grant already exists; every input arrives by flag, env or file. It never prompts,
// never opens a browser, prints one JSON document, exits 0/10/11/12, and never echoes the key.
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";
import { CliError } from "../src/errors.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import { createClackOnboardUi, type OnboardUi } from "../src/onboard-ui.js";
import type { RunnerEngine } from "../src/onboard-runner.js";
import { type ParsedArgs, parseArgs } from "../src/args.js";
import { configPathFor, defaultCtx, writeConfig, type Ctx } from "../src/config.js";
import {
  cmdOnboard,
  ONBOARD_STEPS,
  onboardLockPath,
  onboardStatePath,
  readOnboardJournal,
  type OnboardAdapter,
  type OnboardJournal,
  type OnboardStepId,
} from "../src/onboard.js";
import {
  headlessOnboardAdapters,
  headlessOnboardDeps,
  planOnboardHeadless,
  headlessStepItems,
  type HeadlessTracker,
  ONBOARD_HEADLESS_SCHEMA,
  runOnboardHeadless,
} from "../src/onboard-headless.js";
import {
  FIXTURE_KEY,
  FIXTURE_ME_BODY,
  FIXTURE_USER_KEY,
  startMeFixture,
  type FixtureServer,
} from "./fixture.js";

const SECRET = "ctc_headless_synthetic_secret_never_echo_9f3a";
const INPUT_ENV = {
  CATALYST_ONBOARD_TEAM: "ENG",
  CATALYST_ONBOARD_REPOS: "acme/api, acme/web",
  CATALYST_ONBOARD_CODING_ACCOUNT: "claude-one",
  CATALYST_ONBOARD_RUNNER: "no",
};
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(env: NodeJS.ProcessEnv = {}, fetchImpl?: typeof fetch) {
  const home = mkdtempSync(join(tmpdir(), "onboard-headless-"));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  let fetches = 0;
  const opened: string[] = [];
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: { CATALYST_SKILLS_OFFLINE: "1", ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetches++;
      if (fetchImpl) return fetchImpl(input, init);
      throw new Error("no network in this test");
    }) as typeof fetch,
    now: () => new Date("2026-10-02T18:00:00.000Z"),
  };
  const deps = {
    // A real terminal is attached: headless must still never ask.
    isTty: () => true,
    openBrowser: (url: string) => void opened.push(url),
    sleep: async () => {},
  };
  const run = (argv: string[]) => main(argv, ctx, deps);
  const everything = () => [...out, ...err].join("\n");
  const doc = () => {
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!) as Record<string, any>;
    expect(["complete", "ready", "not-ready", "paused", "failed"]).toContain(result.verdict);
    expect(Array.isArray(result.actions)).toBe(true);
    expect(result.actions.length).toBeLessThanOrEqual(5);
    expect(result.actions.map((action: { text: string }) => action.text).join("\n")).not.toMatch(/\bcatalyst onboard\b/);
    expect(typeof result.next).toBe("string");
    expect(result.next.length).toBeGreaterThan(0);
    expect(result.next).not.toMatch(/\bcatalyst onboard\b/);
    expect(JSON.stringify(result.headless)).not.toMatch(/\bcatalyst onboard\b(?! --help\b)/);
    expect(JSON.stringify(result)).not.toContain("/settings/runner-hosts");
    return result;
  };
  return { home, ctx, out, err, run, doc, everything, opened, fetches: () => fetches };
}

function writeKeyFile(home: string, value: string, mode = 0o600): string {
  const path = join(home, "catalyst.key");
  writeFileSync(path, `${value}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

describe("headless pre-flight: what is missing is named before any network call", () => {
  test("no credentials: exit 11 at once, naming the account key, one JSON document, nothing written", async () => {
    const f = fixture();
    const started = Date.now();
    const code = await f.run(["onboard", "--headless", "--json"]);
    expect(code).toBe(11);
    expect(Date.now() - started).toBeLessThan(2000);
    const doc = f.doc();
    expect(doc).toMatchObject({ schema: 1, exit: 11, complete: false });
    expect(doc.headless.schema).toBe(ONBOARD_HEADLESS_SCHEMA);
    const ids = doc.headless.missing.map((item: { id: string }) => item.id);
    expect(ids[0]).toBe("account_key");
    expect(ids).toEqual(["account_key", "linear_team", "repositories", "coding_account", "runner"]);
    expect(doc.headless.missing[0]).toMatchObject({
      kind: "input",
      reason: "account_key_missing",
      env: "CATALYST_CLOUD_TOKEN",
      flag: "--key-file",
      url: "https://staging.catalystcloud.dev/settings/api-keys",
    });
    expect(doc.headless.refused).toEqual([]);
    expect(f.fetches()).toBe(0);
    expect(f.opened).toEqual([]);
    expect(f.everything()).not.toMatch(/Continue\?|\[Y\/n\]/);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("CATALYST_ONBOARD_HEADLESS=1 selects headless without the flag", async () => {
    const f = fixture({ CATALYST_ONBOARD_HEADLESS: "1" });
    expect(await f.run(["onboard", "--json"])).toBe(11);
    expect(f.doc().headless.missing[0].id).toBe("account_key");
  });

  test("human output names each missing item on stderr and keeps the exit code", async () => {
    const f = fixture(INPUT_ENV);
    expect(await f.run(["onboard", "--headless"])).toBe(11);
    expect(f.err.join("\n")).toContain("account key");
    expect(f.err.join("\n")).toContain("CATALYST_CLOUD_TOKEN");
    expect(f.everything()).not.toMatch(/Continue\?|\[Y\/n\]/);
  });

  test.each([
    ["linear_team", "CATALYST_ONBOARD_TEAM", "--team"],
    ["repositories", "CATALYST_ONBOARD_REPOS", "--repo"],
    ["coding_account", "CATALYST_ONBOARD_CODING_ACCOUNT", "--coding-account"],
    ["runner", "CATALYST_ONBOARD_RUNNER", "--runner"],
  ])("a missing %s is named with its flag and env", async (id, env, flag) => {
    const inputs: NodeJS.ProcessEnv = { ...INPUT_ENV, CATALYST_CLOUD_TOKEN: SECRET };
    delete inputs[env];
    const f = fixture(inputs);
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    const doc = f.doc();
    expect(doc.headless.missing).toEqual([
      expect.objectContaining({ id, kind: "input", env, flag }),
    ]);
    expect(f.fetches()).toBe(0);
    expect(f.everything()).not.toContain(SECRET);
  });

  test("flags win over env and every input is reported back, never the key", async () => {
    const f = fixture({ ...INPUT_ENV, CATALYST_ONBOARD_RUNNER: "maybe" });
    expect(
      await f.run([
        "onboard", "--headless", "--json", "--team", "OPS", "--repo", "acme/one",
        "--coding-account", "claude-two", "--runner", "no",
      ]),
    ).toBe(11);
    expect(f.doc().headless.inputs).toEqual({
      accountKey: null,
      baseUrl: "https://staging.catalystcloud.dev",
      team: "OPS",
      repos: ["acme/one"],
      codingAccount: "claude-two",
      runner: "no",
    });
  });

  test("the key on the command line is refused with exit 12 and never echoed", async () => {
    const f = fixture(INPUT_ENV);
    expect(await f.run(["onboard", "--headless", "--json", "--key", SECRET])).toBe(12);
    const doc = f.doc();
    expect(doc.exit).toBe(12);
    expect(doc.headless.refused).toEqual([
      expect.objectContaining({ id: "account_key", reason: "account_key_on_command_line" }),
    ]);
    expect(f.everything()).not.toContain(SECRET);
    expect(f.fetches()).toBe(0);
  });

  test("an invalid runner value is refused with exit 12", async () => {
    const f = fixture({ ...INPUT_ENV, CATALYST_CLOUD_TOKEN: SECRET, CATALYST_ONBOARD_RUNNER: "sometimes" });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(12);
    expect(f.doc().headless.refused).toEqual([
      expect.objectContaining({ id: "runner", reason: "runner_input_invalid" }),
    ]);
  });

  test("an unknown option under --headless still answers with one JSON document and exit 12", async () => {
    const f = fixture();
    expect(await f.run(["onboard", "--headless", "--json", "--colour"])).toBe(12);
    const doc = f.doc();
    expect(doc.exit).toBe(12);
    expect(doc.headless.refused[0]).toMatchObject({ id: "command_line", reason: "usage" });
  });

  test("--key-file and --runner belong to headless", async () => {
    const f = fixture();
    expect(await f.run(["onboard", "--runner", "no"])).toBe(1);
    expect(f.err.join("\n")).toContain("--headless");
  });
});

describe("headless key files", () => {
  test("a group- or world-writable key file is refused with exit 12", async () => {
    const f = fixture(INPUT_ENV);
    const path = writeKeyFile(f.home, SECRET, 0o620);
    expect(await f.run(["onboard", "--headless", "--json", "--key-file", path])).toBe(12);
    expect(f.doc().headless.refused).toEqual([
      expect.objectContaining({ id: "account_key", reason: "account_key_file_permissions" }),
    ]);
    expect(f.everything()).not.toContain(SECRET);
  });

  test("a key path that is not a regular file is a missing key (exit 11), read never, so a FIFO cannot hang", async () => {
    const f = fixture(INPUT_ENV);
    const dir = join(f.home, "not-a-file");
    mkdirSync(dir);
    expect(await f.run(["onboard", "--headless", "--json", "--key-file", dir])).toBe(11);
    expect(f.doc().headless.missing[0]).toMatchObject({ reason: "account_key_file_not_regular" });
    const g = fixture(INPUT_ENV);
    const fifo = join(g.home, "key.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    expect(await g.run(["onboard", "--headless", "--json", "--key-file", fifo])).toBe(11);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(g.doc().headless.missing[0]).toMatchObject({ reason: "account_key_file_not_regular" });
  });

  test("a key put in CATALYST_CLOUD_TOKEN_FILE by mistake is never echoed", async () => {
    const f = fixture({ ...INPUT_ENV, CATALYST_CLOUD_TOKEN_FILE: SECRET });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    expect(f.doc().headless.missing[0]).toMatchObject({ reason: "account_key_file_unreadable" });
    expect(f.everything()).not.toContain(SECRET);
    const g = fixture(INPUT_ENV);
    expect(await g.run(["onboard", "--headless", "--json", "--key-file", SECRET])).toBe(11);
    expect(g.everything()).not.toContain(SECRET);
  });

  test.each(["flag", "env"])("%s headless dry-run stays a plan rather than claiming operational readiness", async (mode) => {
    const f = fixture({ ...INPUT_ENV, CATALYST_CLOUD_TOKEN: SECRET });
    if (mode === "env") f.ctx.env.CATALYST_ONBOARD_HEADLESS = "1";
    expect(await f.run(["onboard", ...(mode === "flag" ? ["--headless"] : []), "--dry-run", "--json"])).toBe(0);
    expect(f.fetches()).toBe(0);
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    const result = f.doc();
    expect(result).toMatchObject({ mode: "plan", verdict: "not-ready", exit: null });
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((step: { state: string }) => step.state === "pending")).toBe(true);
    expect(result.headless.inputs.accountKey).toBe("env");
    expect(f.everything()).not.toContain(SECRET);
    const ordinary = fixture(INPUT_ENV);
    expect(await cmdOnboard(parseArgs(["onboard", "--dry-run", "--json"]), ordinary.ctx, { bindSignals: false })).toBe(0);
    expect(ordinary.out).toHaveLength(1);
    expect(JSON.parse(ordinary.out[0]!)).toMatchObject({ mode: "plan", verdict: "not-ready", exit: null });
    expect(ordinary.fetches()).toBe(0);
    expect(existsSync(onboardStatePath(ordinary.home))).toBe(false);
  });

  test("a missing or empty key file is a missing key (exit 11)", async () => {
    const f = fixture({ ...INPUT_ENV, CATALYST_CLOUD_TOKEN_FILE: join(tmpdir(), "no-such-catalyst-key") });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    expect(f.doc().headless.missing[0]).toMatchObject({ id: "account_key", reason: "account_key_file_unreadable" });
    const g = fixture(INPUT_ENV);
    const empty = writeKeyFile(g.home, "");
    expect(await g.run(["onboard", "--headless", "--json", "--key-file", empty])).toBe(11);
    expect(g.doc().headless.missing[0]).toMatchObject({ id: "account_key", reason: "account_key_missing" });
  });

  test("a world-readable key file is used with a warning", async () => {
    const f = fixture(INPUT_ENV);
    const path = writeKeyFile(f.home, SECRET, 0o644);
    // The fake network refuses every request, so the run stops at the key login (exit 10).
    expect(await f.run(["onboard", "--headless", "--json", "--key-file", path])).toBe(10);
    const doc = f.doc();
    expect(doc.headless.inputs.accountKey).toBe("file");
    expect(doc.headless.warnings.join("\n")).toContain("readable by other users");
    expect(f.everything()).not.toContain(SECRET);
  });
});

describe("headless against a fixture cloud", () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startMeFixture();
  });
  afterAll(async () => {
    await server.close();
  });

  function cloud(env: NodeJS.ProcessEnv) {
    return fixture(
      { ...INPUT_ENV, CATALYST_CLOUD_BASE_URL: server.url, ...env },
      ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init)) as typeof fetch,
    );
  }

  test("a tenant account key is refused (exit 12): onboarding acts as a person", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: FIXTURE_KEY });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(12);
    expect(f.doc().headless.refused).toEqual([
      expect.objectContaining({ id: "account_key", reason: "account_key_not_personal" }),
    ]);
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(f.everything()).not.toContain(FIXTURE_KEY);
  });

  test("a rejected key is a missing key (exit 11) with the page to mint one", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: SECRET });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    expect(f.doc().headless.missing).toEqual([
      expect.objectContaining({
        id: "account_key",
        reason: "account_key_rejected",
        url: `${server.url}/settings/api-keys`,
        text: expect.stringContaining("CATALYST_CLOUD_TOKEN"),
      }),
    ]);
    expect(f.everything()).not.toContain(SECRET);
  });

  test("a rejected key file names its selector without echoing its path or value", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN_FILE: "" });
    const path = writeKeyFile(f.home, SECRET);
    f.ctx.env.CATALYST_CLOUD_TOKEN_FILE = path;
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    const item = f.doc().headless.missing[0];
    expect(item.reason).toBe("account_key_rejected");
    expect(item.text).toContain("CATALYST_CLOUD_TOKEN_FILE");
    expect(f.everything()).not.toContain(path);
    expect(f.everything()).not.toContain(SECRET);
  });

  test("a rejected environment key identifies its source and points to the saved personal login", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: SECRET });
    writeConfig(f.home, {
      baseUrl: server.url, key: FIXTURE_USER_KEY,
      account: FIXTURE_ME_BODY.account, slug: FIXTURE_ME_BODY.slug, name: FIXTURE_ME_BODY.name,
      permissions: [], principal: "session",
      user: { id: "d1-user-tony", label: "Tony", email: "tony@example.test", role: "admin", linearUserId: "linear-user-tony" },
      joinedAt: "2026-10-01T00:00:00Z", lastSkillBundleVersion: "0.14.10",
    });
    const before = readFileSync(configPathFor(f.home), "utf8");
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    const item = f.doc().headless.missing[0];
    expect(item.reason).toBe("account_key_rejected");
    expect(item.text).toContain("CATALYST_CLOUD_TOKEN");
    expect(item.text).toContain("saved personal login");
    expect(item.text).toContain("Unset CATALYST_CLOUD_TOKEN");
    expect(f.everything()).not.toContain(SECRET);
    expect(f.everything()).not.toContain(FIXTURE_USER_KEY);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);

    delete f.ctx.env.CATALYST_CLOUD_TOKEN;
    f.out.length = 0;
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    expect(f.doc().headless.inputs.accountKey).toBe("saved");
    expect(f.doc().steps.find((step: { id: string }) => step.id === "signin")?.state).toBe("done");
  });

  test("a key for another person than the saved login is refused (exit 12) and the saved login is kept", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: FIXTURE_USER_KEY });
    writeConfig(f.home, {
      baseUrl: server.url,
      key: "ctc_saved_other_person_synthetic",
      account: FIXTURE_ME_BODY.account,
      slug: FIXTURE_ME_BODY.slug,
      name: FIXTURE_ME_BODY.name,
      permissions: [],
      principal: "session",
      user: { id: "someone-else", label: "Else", email: null, role: "admin", linearUserId: null },
      joinedAt: "2026-10-01T00:00:00Z",
      lastSkillBundleVersion: "0.14.10",
    });
    const before = readFileSync(configPathFor(f.home), "utf8");
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(12);
    expect(f.doc().headless.refused).toEqual([
      expect.objectContaining({ id: "account_key", reason: "account_key_other_login" }),
    ]);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
  });

  test("a supplied personal key upgrades a saved host login for the same workspace", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: FIXTURE_USER_KEY });
    writeConfig(f.home, {
      baseUrl: server.url, key: FIXTURE_KEY,
      account: FIXTURE_ME_BODY.account, slug: FIXTURE_ME_BODY.slug, name: FIXTURE_ME_BODY.name,
      permissions: [], principal: "service", joinedAt: "2026-10-01T00:00:00Z",
      lastSkillBundleVersion: "0.14.10",
    });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(11);
    expect(f.doc().headless.refused).toEqual([]);
    expect(JSON.parse(readFileSync(configPathFor(f.home), "utf8")).key).toBe(FIXTURE_USER_KEY);
    expect(f.doc().steps.find((step: { id: string }) => step.id === "signin")?.state).toBe("done");
    expect(f.everything()).not.toContain(FIXTURE_USER_KEY);
  });

  test("a run that stops before any step still names why", async () => {
    // A saved login holding the account's host key: onboarding refuses before the first step.
    const f = cloud({});
    writeConfig(f.home, {
      baseUrl: server.url,
      key: FIXTURE_KEY,
      account: FIXTURE_ME_BODY.account,
      slug: FIXTURE_ME_BODY.slug,
      name: FIXTURE_ME_BODY.name,
      permissions: [],
      principal: "service",
      joinedAt: "2026-10-01T00:00:00Z",
      lastSkillBundleVersion: "0.14.10",
    });
    expect(await f.run(["onboard", "--headless", "--json"])).toBe(12);
    const doc = f.doc();
    expect(doc.headless.inputs.accountKey).toBe("saved");
    expect(doc.headless.refused).toEqual([
      expect.objectContaining({ id: "account_key", reason: "account_key_not_personal" }),
    ]);
    expect(f.everything()).not.toContain(FIXTURE_KEY + "\"");
  });

  test("a personal key runs onboarding: one JSON document, no prompt, no browser, key never echoed", async () => {
    const f = cloud({ CATALYST_CLOUD_TOKEN: FIXTURE_USER_KEY });
    const code = await f.run(["onboard", "--headless", "--json"]);
    // The fixture serves no onboarding capabilities, so the run waits on named steps.
    expect(code).toBe(11);
    const doc = f.doc();
    expect(doc.exit).toBe(code);
    expect(doc.headless.inputs.accountKey).toBe("env");
    expect(doc.steps.find((s: { id: string }) => s.id === "signin")?.state).toBe("done");
    expect(f.opened).toEqual([]);
    expect(f.everything()).not.toMatch(/Continue\?|\[Y\/n\]|enter the code/i);
    expect(f.everything()).not.toContain(FIXTURE_USER_KEY);
    expect(readFileSync(onboardStatePath(f.home), "utf8")).not.toContain(FIXTURE_USER_KEY);
    if (code !== 0) expect(doc.headless.missing.length + doc.headless.failed.length + doc.headless.refused.length).toBeGreaterThan(0);
  });
});

describe("headless steps never open a browser: an absent grant is a named exit-11 reason with its page", () => {
  const base = "https://cloud.example.test";
  function adapters(pending: OnboardStepId[]) {
    const acted: OnboardStepId[] = [];
    const all: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS)
      all[id] = {
        check: async () => (pending.includes(id) ? { state: "pending" } : { state: "done" }),
        act: async () => {
          acted.push(id);
          return { state: "done" };
        },
      };
    return { all, acted };
  }

  test.each([
    ["linear.workspace", "linear_workspace_grant_missing", `${base}/a/account/connections`],
    ["github.install", "github_app_grant_missing", `${base}/a/account/connections`],
    ["linear.personal", "linear_personal_grant_missing", `${base}/settings/connected-accounts`],
    ["github.personal", "github_personal_grant_missing", `${base}/settings/connected-accounts`],
  ] as const)("%s", async (step, reason, url) => {
    const home = mkdtempSync(join(tmpdir(), "onboard-headless-grant-"));
    homes.push(home);
    const out: string[] = [];
    const ctx: Ctx = { ...defaultCtx(), home, env: {}, stdout: (l) => out.push(l), stderr: () => {} };
    const { all, acted } = adapters([step]);
    const confirm = vi.fn();
    const code = await cmdOnboard(parseArgs(["onboard", "--yes", "--json"]), ctx, {
      adapters: headlessOnboardAdapters(all),
      identity: async () => ({ account: "a", membershipId: "p", baseUrl: base, role: "owner" }),
      bindSignals: false,
      isTty: () => true,
      confirm,
    });
    expect(code).toBe(11);
    expect(acted).not.toContain(step);
    expect(confirm).not.toHaveBeenCalled();
    const journal = JSON.parse(out[0]!);
    expect(journal.steps.find((s: { id: string }) => s.id === step)).toMatchObject({ state: "waiting", reason });
    expect(headlessStepItems(journal, base).missing).toContainEqual(
      expect.objectContaining({ id: step, kind: "grant", reason, url }),
    );
  });
});

describe("headless runner integration", () => {
  function runnerFixture(choice = "yes") {
    const f = fixture({ ...INPUT_ENV, CATALYST_ONBOARD_RUNNER: choice });
    writeConfig(f.home, {
      baseUrl: "https://cloud.example.test", key: FIXTURE_USER_KEY, account: "a", slug: "a", name: "A",
      permissions: [], principal: "session", user: { id: "p", label: "P", email: null, role: "admin", linearUserId: null },
      joinedAt: "2026-10-01T00:00:00Z", lastSkillBundleVersion: "0.14.10",
    });
    return f;
  }

  test("parser preserves bare interactive opt-in and explicit headless values", () => {
    expect(parseArgs(["onboard", "--runner", "--yes"]).flags.runner).toBe(true);
    expect(parseArgs(["onboard", "--no-runner"]).flags["no-runner"]).toBe(true);
    expect(parseArgs(["onboard", "--headless", "--runner", "yes"]).flags.runner).toBe("yes");
    expect(parseArgs(["onboard", "--runner=no", "--headless"]).flags.runner).toBe("no");
  });

  test.each(["yes", "no"])("%s maps into the runtime runner adapter without a prompt", async (choice) => {
    const f = runnerFixture(choice);
    const planned = planOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx);
    expect(planned.report.refused).toEqual([]);
    expect(planned.args.flags.runner).toBe(choice === "yes" ? true : undefined);
    expect(planned.args.flags["no-runner"]).toBe(choice === "no" ? true : undefined);
    const info = vi.fn(async () => null);
    const runtime = createOnboardRuntime(planned.args, f.ctx, { runnerEngine: { info } as unknown as RunnerEngine, login: async () => 0, ready: async () => ({ state: "done" }) });
    const result = await runtime.adapters!.runner!.check(f.ctx, { schema: 1, runId: "r", cli: "t", installer: null,
      tenant: "a", account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", steps: [], changes: [], exit: null });
    expect(result).toMatchObject({ state: "skipped", reason: choice === "yes" ? "runner_docker_missing" : "runner_not_selected" });
    expect(info).toHaveBeenCalledTimes(choice === "yes" ? 1 : 0);
  });

  test.each([
    ["--headless", ["onboard", "--headless", "--json"]],
    ["CATALYST_ONBOARD_HEADLESS=1", ["onboard", "--json"]],
  ] as const)("CTC-4739 — a headless runner no (%s) is named as the headless input, never as a --no-runner nobody typed", async (how, given) => {
    const f = runnerFixture("no");
    if (how !== "--headless") f.ctx.env.CATALYST_ONBOARD_HEADLESS = "1";
    const argv = [...given];
    const planned = planOnboardHeadless(parseArgs(argv), f.ctx);
    expect(planned.args.flags.headless).toBe(true);
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    await runOnboardHeadless(parseArgs(argv), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker, false)),
    }, "test");
    const said = f.everything();
    expect(said).toContain("this computer will not take work, because the headless runner input is no");
    expect(said).not.toContain("--no-runner was passed");
  });

  test.each([["no", false], ["no", true], ["yes", false], ["yes", true]] as const)("actual runtime runner %s preserves JSON actions and probes (scoped=%s)", async (choice, scoped) => {
    const f = runnerFixture(choice);
    const argv = ["onboard", "--headless", "--json", ...(scoped ? ["--only", "runner"] : [])];
    const planned = planOnboardHeadless(parseArgs(argv), f.ctx);
    const info = vi.fn(async () => null);
    const runtime = createOnboardRuntime(planned.args, f.ctx, { runnerEngine: { info } as unknown as RunnerEngine, login: async () => 0, ready: async () => ({ state: "done" }) });
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters.runner = runtime.adapters!.runner;
    expect(await runOnboardHeadless(parseArgs(argv), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker, args.flags.runner === true)),
    }, "test")).toBe(choice === "yes" ? 11 : 0);
    const doc = f.doc();
    expect(doc).toMatchObject({ exit: choice === "yes" ? 11 : 0, verdict: choice === "yes" ? "not-ready" : scoped ? "ready" : "complete", headless: { inputs: { runner: choice } } });
    if (choice === "no") expect(doc.actions, "unrequested runner actions must stay empty").toEqual([]);
    else {
      expect(doc.actions).toContainEqual(expect.objectContaining({ step: "runner", number: 15 }));
      expect(doc.headless.missing).toContainEqual(expect.objectContaining({ id: "runner", reason: "runner_docker_missing" }));
    }
    expect(readOnboardJournal(onboardStatePath(f.home))?.exit).toBe(choice === "yes" ? 11 : 0);
    expect(info).toHaveBeenCalledTimes(choice === "yes" ? 1 : 0);
    expect(f.opened).toEqual([]);
  });

  test.each(["paused", "not-ready"])("the wrapper preserves the current core %s verdict instead of old interrupted rows", async (verdict) => {
    const f = runnerFixture("no");
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: async (_args, ctx, tracker) => {
        tracker.stepsRan = verdict === "not-ready";
        ctx.stdout(JSON.stringify({ schema: 1, runId: "paused-fixture", cli: "test", installer: null,
          tenant: null, exit: 11, complete: false, changes: [], verdict,
          steps: verdict === "paused" ? [] : [{ id: "github.install", state: "failed", reason: "interrupted" }],
        }));
        return 11;
      },
    }, "test")).toBe(11);
    expect(f.doc().verdict).toBe(verdict);
  });

  test.each([
    ["waiting", 11, "not-ready", "missing"],
    ["failed", 10, "failed", "failed"],
  ] as const)("readiness %s preserves its named cause without inventing a numbered action", async (state, exit, verdict, bucket) => {
    const f = runnerFixture("no");
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters.ready = { check: async () => ({ state, reason: "onboarding_checks_pending" }) };
    const hooks = {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args: ParsedArgs, ctx: Ctx, tracker: HeadlessTracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker, false)),
    };
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, hooks, "test")).toBe(exit);
    const doc = f.doc();
    expect(doc).toMatchObject({ exit, verdict, actions: [], next: "run the same headless setup command" });
    expect(doc.steps).toContainEqual(expect.objectContaining({ id: "ready", state, reason: "onboarding_checks_pending" }));
    expect(doc.headless[bucket]).toContainEqual(expect.objectContaining({ id: "ready", reason: "onboarding_checks_pending" }));
    expect(readOnboardJournal(onboardStatePath(f.home))?.exit).toBe(exit);
    f.out.length = 0;
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json", "--only", "runner"]), f.ctx, hooks, "test")).toBe(0);
    const scoped = f.doc();
    expect(scoped).toMatchObject({ exit: 0, verdict: "ready", actions: [], headless: { missing: [], failed: [] } });
    expect(scoped.steps).toContainEqual(expect.objectContaining({ id: "ready", state, reason: "onboarding_checks_pending" }));
    expect(readOnboardJournal(onboardStatePath(f.home))?.exit).toBe(0);
  });

  test("the actual dispatcher never enters an injected setup UI for a headless run", async () => {
    const f = runnerFixture("no");
    const accessed: PropertyKey[] = [];
    const dispose = vi.fn();
    const setupUi = new Proxy({} as OnboardUi, { get: (_target, key) => {
      accessed.push(key);
      if (key === "dispose") return dispose;
      throw new Error("headless must not access the injected UI");
    } });
    const code = await main(["onboard", "--headless", "--json", "--only", "runner"], f.ctx, {
      setupUi,
      isTty: () => true,
      openBrowser: () => { throw new Error("headless must not open a browser"); },
    });
    expect(accessed).toEqual(["dispose"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    // This fixture closes transport; the real runtime failure remains exit 10.
    expect(code).toBe(10);
    expect(f.doc().exit).toBe(10);
  });

  test.each(["flag", "env"])("non-JSON headless %s never creates the fallback UI", async (mode) => {
    const f = runnerFixture("no");
    if (mode === "env") f.ctx.env.CATALYST_ONBOARD_HEADLESS = "1";
    const baseline = ["SIGINT", "SIGTERM", "SIGHUP"].map((event) => process.listenerCount(event));
    const registrations: string[] = [];
    const originalOn = process.on;
    const spy = vi.spyOn(process, "on").mockImplementation(function (event, listener) {
      if (["SIGINT", "SIGTERM", "SIGHUP"].includes(String(event)) &&
        new Error().stack?.includes("createClackOnboardUi")) registrations.push(String(event));
      return originalOn.call(process, event, listener);
    });
    try {
      const code = await main(["onboard", ...(mode === "flag" ? ["--headless"] : []), "--only", "runner"], f.ctx, {
        isTty: () => true,
        openBrowser: () => { throw new Error("headless must not open a browser"); },
      });
      expect(code).toBe(10);
      expect(registrations).toEqual([]);
      expect(["SIGINT", "SIGTERM", "SIGHUP"].map((event) => process.listenerCount(event))).toEqual(baseline);
      expect(f.everything()).not.toMatch(/\x1b\[|Continue\?|enter the code/i);
    } finally {
      spy.mockRestore();
    }
  });

  test("every headless report bucket preserves the same headless retry", () => {
    const journal: Pick<OnboardJournal, "steps"> = { steps: [
      { id: "accounts", state: "waiting", reason: "coding_account_not_found" },
      { id: "capacity", state: "failed", reason: "account_inventory_unavailable" },
      { id: "skills", state: "waiting", reason: "skills_install_unverified" },
      { id: "values", state: "waiting", reason: "values_selection_required" },
      { id: "settings", state: "failed", refused: true, reason: "settings_approval_required" },
    ] };
    const items = headlessStepItems(journal, "https://cloud.example.test");
    expect(items.missing.length).toBeGreaterThan(0);
    expect(items.failed.length).toBeGreaterThan(0);
    expect(items.deferred.length).toBeGreaterThan(0);
    expect(items.refused.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toMatch(/\bcatalyst onboard\b/);
    expect(JSON.stringify(items)).toContain("same headless setup command");
  });

  test("non-JSON headless stdout preserves the same retry for blocked non-runner steps", async () => {
    const f = runnerFixture("no");
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
    adapters.skills = { check: async () => ({ state: "waiting", reason: "skills_install_unverified" }) };
    adapters.accounts = { check: async () => ({ state: "waiting", reason: "coding_account_not_found" }) };
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({
        adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }),
      }, tracker)),
    }, "test")).toBe(11);
    expect(f.out.join("\n")).toContain("Check the Catalyst skills:");
    expect(f.out.join("\n")).toContain("Check AI accounts:");
    expect(f.out.join("\n")).toContain("resume: run the same headless setup command");
    expect(f.out.join("\n")).not.toMatch(/\bcatalyst onboard\b/);
    expect(f.err.join("\n")).not.toMatch(/\bcatalyst onboard\b/);
  });

  test.each(["flag", "env"])("%s headless renewal and early-stop guidance stays actionable on every channel", async (mode) => {
    for (const json of [false, true]) {
      for (const stop of ["identity", "accounts", "workspace", "runner", "refused", "settings", "first-ticket"] as const) {
        const f = runnerFixture(stop === "runner" ? "yes" : "no");
        if (mode === "env") f.ctx.env.CATALYST_ONBOARD_HEADLESS = "1";
        const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
        for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }) };
        const expired = () => { throw new CliError("saved login needs renewal", "onboard-login-refresh-required", 11); };
        if (stop === "accounts") adapters.accounts = { check: async () => expired() };
        if (stop === "workspace") adapters["linear.workspace"] = { check: async () => ({ state: "waiting", reason: "workspace_login_refresh_required" }) };
        if (stop === "runner") adapters.runner = { check: async () => ({ state: "waiting", reason: "runner_identity_unverified" }) };
        if (stop === "refused") adapters["linear.team"] = { check: async () => ({ state: "refused", reason: "team_scope_refused" }) };
        if (stop === "settings") adapters.settings = { check: async () => ({ state: "waiting", reason: "onboarding_capability_login_refresh_required" }) };
        if (stop === "first-ticket") adapters["first-ticket"] = { check: async () => expired() };
        const code = await runOnboardHeadless(parseArgs(["onboard", ...(mode === "flag" ? ["--headless"] : []), ...(json ? ["--json"] : [])]), f.ctx, {
          login: async () => { throw new Error("no supplied key"); },
          onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({
            adapters, bindSignals: false,
            identity: async () => stop === "identity" ? expired() : ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }),
          }, tracker, stop === "runner")),
        }, "test");
        expect(code, `${mode}/${json}/${stop}`).toBe(stop === "refused" ? 12 : 11);
        expect(f.err.join("\n"), `${mode}/${json}/${stop} stderr`).not.toMatch(/\bcatalyst (?:onboard|login)\b/);
        expect(f.err, `${mode}/${json}/${stop} empty lines`).not.toContain("Missing: ");
        if (json) {
          const result = f.doc();
          expect(JSON.stringify({ actions: result.actions, next: result.next, headless: result.headless })).not.toMatch(/\bcatalyst login\b/);
          const items = ["missing", "failed", "deferred", "refused"].flatMap((bucket) => result.headless[bucket]);
          expect(items.every((item) => item.text.trim().length > 0)).toBe(true);
          expect(items.filter((item) => item.reason === "not_checked")).toEqual([]);
          if (stop !== "refused") expect(JSON.stringify(items)).toContain("Supply a personal key");
          if (stop === "runner") expect(JSON.stringify(items)).toContain("owner or administrator");
          if (stop === "settings" || stop === "first-ticket") {
            expect(result.headless.missing).toContainEqual(expect.objectContaining({ id: stop }));
            expect(result.headless.deferred).toEqual([]);
          }
          if (stop === "accounts" || stop === "refused") expect(result.steps.some((step: { state: string; reason?: string }) => step.state === "pending" && !step.reason)).toBe(true);
        } else {
          expect(f.out.join("\n")).not.toMatch(/\bcatalyst (?:onboard|login)\b/);
          if (stop !== "refused") expect(f.everything()).toContain("Supply a personal key");
          if (stop === "settings" || stop === "first-ticket") expect(f.err.join("\n")).toMatch(/^Missing: .*Supply a personal key/m);
        }
        expect(f.fetches()).toBe(0);
        expect(f.opened).toEqual([]);
      }
    }
  });

  test("CTC-4680: no headless item tells an agent to run bare catalyst setup", () => {
    const cases = [
      ["github.install", "github_installation_approval_pending"],
      ["github.install", "github_installation_browser_unavailable"],
      ["linear.workspace", "workspace_browser_unavailable"],
      ["linear.personal", "personal_browser_unavailable"],
      ["github.personal", "personal_browser_unavailable"],
      ["accounts", "account_enrollment_required"],
      ["runner", "github_install_pending"],
      ["linear.workspace", "consent_timeout"],
    ] as const;
    for (const [id, reason] of cases) {
      const items = headlessStepItems({ steps: [{ id, state: "waiting", reason }] }, "https://cloud.example.test");
      for (const item of [...items.missing, ...items.deferred, ...items.failed]) {
        expect(item.text, `${id} ${reason}`).not.toMatch(/catalyst (?:setup|onboard)\b(?! --help)/);
      }
    }
  });

  test("a deferred step that stops the run is missing; ordinary optional waits remain deferred", () => {
    for (const id of ["settings", "values", "first-ticket", "housekeeping", "runner"] as const) {
      for (const reason of ["onboard_login_refresh_required", "interrupted"]) {
        const items = headlessStepItems({ steps: [{ id, state: "waiting", reason }] }, "https://cloud.example.test");
        expect(items.missing).toContainEqual(expect.objectContaining({ id, reason }));
        expect(items.deferred).toEqual([]);
      }
    }
    const optional = headlessStepItems({ steps: [{ id: "values", state: "waiting", reason: "values_selection_required" }] }, "https://cloud.example.test");
    expect(optional.missing).toEqual([]);
    expect(optional.deferred).toContainEqual(expect.objectContaining({ id: "values", reason: "values_selection_required" }));
  });

  test("all login-refresh reasons use personal-key guidance and unreached rows create no empty item", () => {
    for (const reason of ["account", "personal", "onboard", "onboarding_capability", "workspace", "github_installation", "project", "team_read", "workflow", "runner"].map((prefix) => `${prefix}_login_refresh_required`)) {
      const items = headlessStepItems({ steps: [
        { id: "accounts", state: "waiting", reason },
        { id: "ready", state: "pending" },
      ] }, "https://cloud.example.test");
      expect(items.missing).toHaveLength(1);
      expect(items.missing[0]).toMatchObject({ id: "accounts", reason });
      expect(items.missing[0]!.text).toContain("Supply a personal key from https://cloud.example.test/settings/api-keys in CATALYST_CLOUD_TOKEN or --key-file");
      expect(JSON.stringify(items)).not.toMatch(/\bcatalyst (?:login|onboard)\b/);
    }
  });

  test.each(["flag", "env"])("headless %s disposes setup signal handlers even before the missing-input exit", async (mode) => {
    const f = fixture(mode === "env" ? { CATALYST_ONBOARD_HEADLESS: "1" } : {});
    const signals = new EventEmitter();
    const quiet = () => {};
    const ui = createClackOnboardUi({
      intro: quiet, outro: quiet,
      log: { message: quiet, info: quiet, warn: quiet, error: quiet },
      select: async () => "stop", isCancel: () => false,
    }, { input: new PassThrough(), output: new PassThrough() }, {
      signals, interactive: false, introduced: true, consentGiven: true,
    });
    const dispose = vi.spyOn(ui, "dispose");
    const events = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const event of events) expect(signals.listenerCount(event)).toBe(1);
    try {
      expect(await main(["onboard", "--json", "--yes", ...(mode === "flag" ? ["--headless"] : [])], f.ctx, {
        setupUi: ui, setupApproved: true, isTty: () => true,
        openBrowser: () => { throw new Error("headless must not open a browser"); },
      })).toBe(11);
      expect(dispose).toHaveBeenCalledTimes(1);
      for (const event of events) expect(signals.listenerCount(event)).toBe(0);
      expect(f.doc().headless.missing).toContainEqual(expect.objectContaining({ id: "account_key" }));
    } finally {
      ui.dispose();
    }
  });

  test.each([
    { name: "completed work guidance", complete: true, ticket: false, scoped: false, next: "move a ticket to the stage that starts Catalyst's work in Linear." },
    { name: "scoped resume guidance", complete: false, ticket: false, scoped: true, next: "run the same headless setup command" },
    { name: "first ticket guidance", complete: true, ticket: true, scoped: false, next: "Follow https://cloud.example.test/tickets/ENG-123 in Linear; Catalyst comments there as each phase finishes." },
  ])("a successful headless run preserves $name", async ({ complete, ticket, scoped, next }) => {
    const f = runnerFixture("no");
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json", ...(scoped ? ["--only", "runner"] : [])]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: async (_args, ctx, tracker) => {
        tracker.stepsRan = true;
        ctx.stdout(JSON.stringify({ schema: 1, runId: "ticket-fixture", cli: "test", installer: null,
          tenant: null, exit: 0, complete, changes: [],
          steps: ticket ? [{ id: "first-ticket", state: "done", evidence: { ticketKey: "ENG-123", ticketUrl: "https://cloud.example.test/tickets/ENG-123" } }] : [],
        }));
        return 0;
      },
    }, "test")).toBe(0);
    expect(f.doc().next).toBe(next);
  });

  test("a missing requested runner never prints Ready for work without --json", async () => {
    const f = runnerFixture();
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters.runner = { check: async () => ({ state: "skipped", reason: "runner_docker_missing" }), act: async () => ({ state: "done" }) };
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker, true)),
    }, "test");
    expect(code).toBe(11);
    expect(f.out.join("\n")).not.toContain("Ready for work.");
    expect(f.out.join("\n")).toContain("Setup still needs 1");
    expect(f.out.join("\n")).toContain("resume: run the same headless setup command");
    expect(f.out.join("\n")).not.toContain("resume: catalyst onboard");
    expect(f.err.join("\n")).toContain("Docker");
  });

  test("a scoped retry does not inherit unrelated waits from an earlier receipt", async () => {
    const f = runnerFixture("no");
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters["github.personal"] = { check: async () => ({ state: "waiting", reason: "github_personal_missing" }), act: async () => ({ state: "waiting", reason: "github_personal_missing" }) };
    const hooks = {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args: ParsedArgs, ctx: Ctx, tracker: HeadlessTracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker)),
    };
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, hooks, "test")).toBe(11);
    f.out.length = 0;
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json", "--only", "linear.team"]), f.ctx, hooks, "test")).toBe(0);
    expect(f.doc()).toMatchObject({ exit: 0, actions: [], headless: { missing: [], failed: [], refused: [] } });
    expect(JSON.parse(readFileSync(onboardStatePath(f.home), "utf8")).exit).toBe(0);
    adapters["linear.personal"] = { check: async () => ({ state: "failed", reason: "linear_personal_probe_failed" }), act: async () => ({ state: "failed", reason: "linear_personal_probe_failed" }) };
    f.out.length = 0;
    expect(await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json", "--only", "linear.team"]), f.ctx, hooks, "test")).toBe(10);
    expect(f.doc()).toMatchObject({ exit: 10, headless: { missing: [], failed: [expect.objectContaining({ id: "linear.personal", reason: "linear_personal_probe_failed" })] } });
    expect(JSON.parse(readFileSync(onboardStatePath(f.home), "utf8")).exit).toBe(10);
  });

  test.each(["result", "error"])("a check-path %s refusal is named in refused with exit12", async (kind) => {
    const f = runnerFixture("no");
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters["github.install"] = { check: async () => {
      if (kind === "error") throw new CliError("refused", "github-identity-mismatch", 12);
      return { state: "refused", reason: "github_identity_mismatch" };
    } };
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker)),
    }, "test");
    expect(code).toBe(12);
    expect(f.doc()).toMatchObject({ exit: 12, headless: { refused: [expect.objectContaining({ id: "github.install", reason: "github_identity_mismatch" })], failed: [] } });
    const saved = readOnboardJournal(onboardStatePath(f.home));
    expect(saved?.exit).toBe(12);
    expect(saved?.steps.find((step) => step.id === "github.install")).toMatchObject({ state: "failed", refused: true });
  });

  test("a waiting deferred step is missing when it is the explicit scoped step", async () => {
    const f = runnerFixture("no");
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters.values = { check: async () => ({ state: "waiting", reason: "required_values_missing" }) };
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json", "--only", "values"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker)),
    }, "test");
    expect(code).toBe(11);
    expect(f.doc()).toMatchObject({ exit: 11, headless: { missing: [expect.objectContaining({ id: "values", reason: "required_values_missing" })], deferred: [] } });
    expect(readOnboardJournal(onboardStatePath(f.home))?.exit).toBe(11);
  });

  test("a member's explicit runner request is refused consistently in JSON and the receipt", async () => {
    const f = runnerFixture();
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "member" }) }, tracker, true)),
    }, "test");
    expect(code).toBe(12);
    expect(f.doc()).toMatchObject({ exit: 12, verdict: "not-ready", actions: [expect.objectContaining({ step: "runner" })], headless: { refused: [expect.objectContaining({ id: "runner", reason: "member_scope" })] } });
    expect(JSON.parse(readFileSync(onboardStatePath(f.home), "utf8")).exit).toBe(12);
  });

  test.each([
    ["waiting", "runner_admission_operator", 11],
    ["waiting", "runner_org_key_missing", 11],
    ["waiting", "runner_images_unavailable", 11],
    ["skipped", "runner_docker_missing", 11],
    ["failed", "runner_compose_failed", 10],
    ["done", undefined, 0],
  ] as const)("a requested runner %s/%s keeps exit %s in JSON and the saved receipt", async (state, reason, exit) => {
    const f = runnerFixture();
    const adapters: Partial<Record<OnboardStepId, OnboardAdapter>> = {};
    for (const id of ONBOARD_STEPS) adapters[id] = { check: async () => ({ state: "done" }), act: async () => ({ state: "done" }) };
    adapters.runner = { check: async () => ({ state, ...(reason ? { reason } : {}) }), act: async () => ({ state, ...(reason ? { reason } : {}) }) };
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx, tracker) => cmdOnboard(args, ctx, headlessOnboardDeps({ adapters, bindSignals: false,
        identity: async () => ({ account: "a", membershipId: "p", baseUrl: "https://cloud.example.test", role: "admin" }) }, tracker, args.flags.runner === true)),
    }, "test");
    expect(code).toBe(exit);
    const doc = f.doc();
    expect(doc.exit).toBe(exit);
    expect(doc.verdict).toBe(exit === 10 ? "failed" : exit === 0 ? "complete" : "not-ready");
    if (exit !== 0) expect(doc.actions).toContainEqual(expect.objectContaining({ step: "runner", number: expect.any(Number), text: expect.any(String), who: expect.any(String) }));
    expect(JSON.parse(readFileSync(onboardStatePath(f.home), "utf8")).exit).toBe(exit);
    expect(doc.headless.deferred.some((item: { id: string }) => item.id === "runner")).toBe(false);
    if (reason) expect(doc.headless[exit === 10 ? "failed" : "missing"]).toContainEqual(expect.objectContaining({ id: "runner", reason }));
    expect(f.opened).toEqual([]);
  });
});

describe("the real binary through a pipe", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(here, "..");
  beforeAll(() => {
    const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
    expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
  }, 120_000);

  test.each(["flag", "env"])("%s key-file I/O faults retain the named headless envelope and scrub buffers", (selection) => {
    const home = mkdtempSync(join(tmpdir(), "onboard-key-io-"));
    homes.push(home);
    const key = writeKeyFile(home, "", 0o600);
    const preload = join(home, "fault.cjs");
    writeFileSync(preload, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const open = fs.openSync, stat = fs.fstatSync, read = fs.readSync, close = fs.closeSync;
let target, buffer;
const witness = { reached: false, canaryWritten: false };
const fail = () => Object.assign(new Error("synthetic file fault"), { code: "EIO" });
fs.openSync = function(path, ...args) { const fd = open.call(this, path, ...args); if (path === process.env.FAULT_PATH) target = fd; return fd; };
fs.fstatSync = function(fd, ...args) { if (fd === target && process.env.FAULT_MODE === "fstat") { witness.reached = true; throw fail(); } return stat.call(this, fd, ...args); };
fs.readSync = function(fd, bytes, ...args) { if (fd === target && process.env.FAULT_MODE === "read") { witness.reached = true; bytes.fill(7); buffer = bytes; witness.canaryWritten = bytes.length > 0 && bytes.some(x => x !== 0); throw fail(); } return read.call(this, fd, bytes, ...args); };
fs.closeSync = function(fd, ...args) { const result = close.call(this, fd, ...args); if (fd === target && process.env.FAULT_MODE === "close") { witness.reached = true; throw fail(); } return result; };
syncBuiltinESMExports();
process.on("exit", () => { if (buffer) witness.scrubbed = buffer.length > 0 && buffer.every(x => x === 0); fs.writeFileSync(process.env.FAULT_WITNESS, JSON.stringify(witness)); });
`);
    for (const mode of ["normal", "fstat", "read", "close"] as const) {
      const witnessFile = join(home, `${mode}.json`);
      const result = spawnSync(process.execPath, ["--require", preload, join(pkgRoot, "bin", "catalyst.js"), "onboard", "--json", "--key-file", key, ...(selection === "flag" ? ["--headless"] : [])], {
        env: { PATH: process.env.PATH, HOME: home, CATALYST_SKILLS_HOME: home, CATALYST_SKILLS_OFFLINE: "1", ...INPUT_ENV,
          ...(selection === "env" ? { CATALYST_ONBOARD_HEADLESS: "1" } : {}),
          FAULT_PATH: key, FAULT_MODE: mode, FAULT_WITNESS: witnessFile },
        encoding: "utf8", timeout: 15_000,
      });
      expect(result.status, `${mode}: ${result.stderr}`).toBe(11);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const doc = JSON.parse(lines[0]!);
      expect(doc.headless.missing).toContainEqual(expect.objectContaining({ id: "account_key", reason: mode === "normal" ? "account_key_missing" : "account_key_file_unreadable" }));
      expect(result.stdout + result.stderr).not.toContain(key);
      expect(result.stderr).not.toMatch(/\bcatalyst (?:onboard|login)\b|EIO|synthetic file fault/);
      expect(existsSync(configPathFor(home))).toBe(false);
      expect(existsSync(onboardStatePath(home))).toBe(false);
      const witness = JSON.parse(readFileSync(witnessFile, "utf8"));
      expect(witness.reached).toBe(mode !== "normal");
      if (mode === "read") expect(witness).toMatchObject({ canaryWritten: true, scrubbed: true });
    }
    // A close fault must not downgrade the original unsafe-permissions refusal.
    chmodSync(key, 0o666);
    const result = spawnSync(process.execPath, ["--require", preload, join(pkgRoot, "bin", "catalyst.js"), "onboard", "--headless", "--json", "--key-file", key], {
      env: { PATH: process.env.PATH, HOME: home, CATALYST_SKILLS_HOME: home, CATALYST_SKILLS_OFFLINE: "1", ...INPUT_ENV,
        FAULT_PATH: key, FAULT_MODE: "close", FAULT_WITNESS: join(home, "refused-close.json") }, encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(12);
    expect(JSON.parse(result.stdout).headless.refused).toContainEqual(expect.objectContaining({ reason: "account_key_file_permissions" }));
  }, 30_000);

  test("no credentials and no terminal: exit 11 within seconds, exactly one JSON line on stdout", async () => {
    const home = mkdtempSync(join(tmpdir(), "onboard-headless-bin-"));
    homes.push(home);
    const started = Date.now();
    const child = spawn(process.execPath, [join(pkgRoot, "bin", "catalyst.js"), "onboard", "--headless", "--json"], {
      env: { PATH: process.env.PATH, HOME: home, CATALYST_SKILLS_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code, stderr).toBe(11);
    expect(Date.now() - started).toBeLessThan(15_000);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!);
    expect(doc.headless.missing[0]).toMatchObject({ id: "account_key", reason: "account_key_missing" });
    expect(stderr).not.toMatch(/Continue\?|\[Y\/n\]/);
  }, 30_000);
});

describe("without --headless, a run with no terminal never prompts", () => {
  test("no --yes and no terminal: exit 11 with the reason, no question asked", async () => {
    const f = fixture();
    const code = await main(["onboard"], f.ctx, { isTty: () => false, openBrowser: (u) => void f.opened.push(u) });
    expect(code).toBe(11);
    expect(f.everything()).not.toMatch(/Continue\?|\[Y\/n\]/);
    expect(f.opened).toEqual([]);
  });
});

describe("headless hygiene", () => {
  test("onboarding steps run without the key in their environment", async () => {
    const home = mkdtempSync(join(tmpdir(), "onboard-headless-env-"));
    homes.push(home);
    const ctx: Ctx = {
      ...defaultCtx(),
      home,
      env: { ...INPUT_ENV, CATALYST_CLOUD_TOKEN: SECRET },
      stdout: () => {},
      stderr: () => {},
      fetch: (async () =>
        Response.json({
          ...FIXTURE_ME_BODY,
          user: { id: "person-a", label: "A", email: null, role: "admin", linearUserId: null },
        })) as unknown as typeof fetch,
    };
    let seen: NodeJS.ProcessEnv | null = null;
    await runOnboardHeadless(
      parseArgs(["onboard", "--headless", "--json"]),
      ctx,
      {
        login: async () => 0,
        onboard: async (_args, onboardCtx) => {
          seen = onboardCtx.env;
          return 11;
        },
      },
      "0.0.0-test",
    );
    expect(seen).not.toBeNull();
    expect(seen!.CATALYST_CLOUD_TOKEN).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  test("a run that stops before its first step names the line it stopped on, not an older receipt's steps", async () => {
    const home = mkdtempSync(join(tmpdir(), "onboard-headless-stop-"));
    homes.push(home);
    writeConfig(home, {
      baseUrl: "https://cloud.example.test",
      key: "ctc_saved_person_synthetic",
      account: "a",
      slug: "a",
      name: "A",
      permissions: [],
      principal: "session",
      user: { id: "p", label: "P", email: null, role: "admin", linearUserId: null },
      joinedAt: "2026-10-01T00:00:00Z",
      lastSkillBundleVersion: "0.14.10",
    });
    const out: string[] = [];
    const ctx: Ctx = { ...defaultCtx(), home, env: { ...INPUT_ENV }, stdout: (l) => out.push(l), stderr: () => {} };
    const code = await runOnboardHeadless(
      parseArgs(["onboard", "--headless", "--json"]),
      ctx,
      {
        login: async () => {
          throw new Error("no key was supplied, so no login");
        },
        onboard: async (_args, onboardCtx) => {
          onboardCtx.stderr("Renew your login with catalyst login, then run catalyst onboard. Setup was not changed.");
          onboardCtx.stdout(
            JSON.stringify({
              schema: 1,
              exit: 11,
              steps: [{ id: "github.install", state: "waiting", reason: "github_app_grant_missing" }],
            }),
          );
          return 11;
        },
      },
      "0.0.0-test",
    );
    expect(code).toBe(11);
    expect(out).toHaveLength(1);
    const report = JSON.parse(out[0]!).headless;
    expect(report.missing).toEqual([expect.objectContaining({ id: "account_key", reason: "saved_login_expired" })]);
  });

  test("cmdOnboard exposes the exact pre-step cloud error in headless JSON", async () => {
    const f = fixture(INPUT_ENV);
    writeConfig(f.home, {
      baseUrl: "https://cloud.example.test", key: FIXTURE_USER_KEY, account: "a", slug: "a", name: "A",
      permissions: [], principal: "session", user: { id: "p", label: "P", email: null, role: "admin", linearUserId: null },
      joinedAt: "2026-10-01T00:00:00Z", lastSkillBundleVersion: "0.14.10",
    });
    const code = await runOnboardHeadless(parseArgs(["onboard", "--headless", "--json"]), f.ctx, {
      login: async () => { throw new Error("no supplied key"); },
      onboard: (args, ctx) => cmdOnboard(args, ctx, { bindSignals: false, identity: async () => {
        throw new CliError("unknown membership failure prose", "cloud-membership-refused", 12);
      } }, "0.14.10"),
    }, "0.14.10");
    expect(code).toBe(12);
    expect(f.doc().errorCode).toBe("cloud-membership-refused");
    expect(f.doc().headless.refused[0].reason).toBe("cloud-membership-refused");
  });

  test("--help with --headless --json answers with the document, not help text", async () => {
    const f = fixture();
    expect(await f.run(["onboard", "--headless", "--json", "--help"])).toBe(12);
    expect(f.doc().headless.refused[0]).toMatchObject({ reason: "usage" });
  });

  test("a global flag before the verb still gets the headless refusal document", async () => {
    const f = fixture();
    expect(
      await f.run(["--base-url", "https://cloud.example.test", "onboard", "--headless", "--json", "--colour"]),
    ).toBe(12);
    expect(f.doc().headless.refused[0]).toMatchObject({ reason: "usage" });
  });
});
