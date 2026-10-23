// ready.test.ts — READY on a complete fixture; NOT READY names Node, config, contract, skills dir and
// SDK failures separately, each with its fix line; a contract readiness check that failed surfaces
// with who can answer; the replica is a note, never a failure.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_SKILLS, main } from "../src/cli";
import {
  contractPathFor,
  defaultSkillsDirFor,
  readManifest,
  type Ctx,
} from "../src/config";
import type { PublishedLookup } from "../src/published";
import { readyReport } from "../src/ready";
import { PROVENANCE_MARKER } from "../src/skill-shape";
import { installSkills } from "../src/skills";
import * as sdk from "../src/sdk";
import { FIXTURE_ME_USER, startMeFixture, type FixtureServer } from "./fixture";
import {
  makeCtx,
  seedJoined,
  seedReplica,
  seedTeamGate,
  seedWriterState,
  tempHome,
  type TestCtx,
} from "./helpers";

const STAMP_RE = new RegExp(
  `${PROVENANCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(@\\S+)?`,
);

/** Rewrite every installed skill's provenance line to carry `version` (or no stamp at all). */
function stampInstalledSkillsAt(dir: string, version: string | null): void {
  for (const name of CUSTOMER_SKILLS) {
    const p = join(dir, name, "SKILL.md");
    const text = readFileSync(p, "utf8");
    writeFileSync(
      p,
      text.replace(
        STAMP_RE,
        version === null
          ? PROVENANCE_MARKER
          : `${PROVENANCE_MARKER}@${version}`,
      ),
    );
  }
}

function registryFetch(latest: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ latest }), { status })) as typeof fetch;
}

function fixedLookup(
  latest: string | null,
  reason: string | null = null,
  source: PublishedLookup["source"] = "network",
): () => Promise<PublishedLookup> {
  return async () => ({ latest, reason, source });
}

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
});

describe("ready", () => {
  test("default readiness loads the HTTP SDK while the optional Node SDK cannot load", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const nodeLoad = vi
      .spyOn(sdk, "loadSdk")
      .mockRejectedValue(
        new Error("optional Node entry cannot load node:sqlite"),
      );
    const httpLoad = vi.spyOn(sdk, "loadHttpSdk");
    try {
      // No injected readiness loader: exercise the actual default HTTP loader and its module.
      const report = await readyReport(ctx, {
        skillNames: CUSTOMER_SKILLS,
        offline: true,
      });
      expect(httpLoad).toHaveBeenCalledTimes(1);
      expect(nodeLoad).not.toHaveBeenCalled();
      expect(report.checks.find((check) => check.id === "sdk")).toMatchObject({
        ok: true,
      });
      expect(report.replica.verdict).toBe("absent");
      expect(
        report.checks.find((check) => check.id === "replica"),
      ).toMatchObject({ ok: false, note: true });
      expect(report.ready).toBe(true);
    } finally {
      nodeLoad.mockRestore();
      httpLoad.mockRestore();
    }
  });

  test("an explicitly injected readiness loader retains its failure gate", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const loader = vi.fn(async () => {
      throw new Error("injected readiness SDK failure");
    });
    const report = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
      loadSdk: loader,
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(report.checks.find((check) => check.id === "sdk")).toMatchObject({
      ok: false,
      line: "sdk: injected readiness SDK failure",
    });
    expect(report.checks.find((check) => check.id === "replica")).toMatchObject(
      { note: true },
    );
    expect(report.ready).toBe(false);
  });

  test("READY on a complete fixture, with the replica as a note", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text.split("\n").at(-1)).toBe("READY");
    expect(text).toMatch(/^ok {3}runtime: /m);
    expect(text).toMatch(/^ok {3}config: joined Hagale Technologies/m);
    expect(text).toMatch(/^ok {3}contract: 1\.0\.0 cached/m);
    expect(text).toMatch(/^ok {3}cliPath: /m);
    expect(text).toMatch(/^ok {3}skills: all \d+ present/m);
    expect(text).toMatch(/^ok {3}sdk: loads/m);
    expect(text).toMatch(/^note {2}replica: absent/m);
    expect(text).toMatch(
      /^note {2}team ENG: Catalyst hasn't checked events from Linear and GitHub for this team yet\./m,
    );
    expect(text).toMatch(/^note {2}team OPS: Catalyst hasn't checked this team yet/m);
  });
  test("a fresh replica reads ok", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 5, heartbeatAgeMs: 0 });
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as {
      ready: boolean;
      checks: { id: string; ok: boolean }[];
    };
    expect(j.ready).toBe(true);
    expect(j.checks.find((c) => c.id === "replica")?.ok).toBe(true);
  });
  test("NOT READY names Node, config, contract, skills dir and sdk failures separately, each with its fix", async () => {
    const report = await readyReport(ctx, {
      runtime: { kind: "node", version: "20.0.0", nodeCompat: "20.0.0" },
      skillNames: CUSTOMER_SKILLS,
      loadSdk: async () => {
        throw new Error("no registerHooks");
      },
    });
    expect(report.ready).toBe(false);
    const failed = report.checks
      .filter((c) => !c.ok && !c.note)
      .map((c) => c.id);
    // "skills" is a note, not a failure: the customer's own agent installs them, so a copy
    // directory with none of ours in it is the normal plugin case.
    expect(failed).toEqual(["runtime", "config", "contract", "sdk"]);
    expect(report.checks.find((c) => c.id === "skills")).toMatchObject({
      ok: true,
      note: true,
    });
    for (const c of report.checks.filter((c) => !c.ok && !c.note)) {
      expect(c.fix, `${c.id} must name a fix`).toBeTruthy();
      expect(c.who, `${c.id} must name who`).toBeTruthy();
    }
    expect(report.checks.find((c) => c.id === "config")?.fix).toContain(
      "npx -p @catalyst-cloud/cli catalyst login",
    );
    expect(report.checks.find((c) => c.id === "sdk")?.line).toContain(
      "no registerHooks",
    );
    expect(await main(["ready"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/NOT READY$/);
    expect(ctx.out.join("\n")).toMatch(
      /fix: npx -p @catalyst-cloud\/cli catalyst login/,
    );
  });
  test("a missing cliPath heals to the running launcher; an out-of-range contract and a corrupt config each fail by name", async () => {
    await seedJoined(home, server, { config: { cliPath: `${home}/nope.js` } });
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      contractVersion: string;
    };
    writeFileSync(
      contractPathFor(home),
      JSON.stringify({ ...cache, contractVersion: "3.0.0" }),
    );
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    // 0.9.3: a recorded launcher that no longer exists is rewritten to the running one before ready reads it.
    expect(text).toMatch(/^ok {3}cliPath: /m);
    expect(text).toMatch(/^FAIL {2}contract: version 3\.0\.0 is outside/m);
    // The out-of-range fix must pin @latest (`npm update -g` never crosses a caret below 1.0.0) AND
    // re-login so the new global bin rewrites customer.json.cliPath.
    expect(text).toContain(
      "fix: npm install -g @catalyst-cloud/cli@latest && catalyst login",
    );
    expect(text).not.toContain("npm update");
    writeFileSync(`${home}/.config/catalyst-cloud/customer.json`, "{corrupt");
    const c2 = makeCtx(home);
    expect(await main(["ready"], c2)).toBe(1);
    expect(c2.out.join("\n")).toMatch(/^FAIL {2}config: .*not valid JSON/m);
  });
  test("a contract readiness check that failed surfaces with who can answer; a blocked team fails", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        teams: {
          readiness: {
            status: string;
            checks: { id: string; state: string; reason?: string }[];
          };
        }[];
      };
    };
    const eng = cache.doc.teams[0]!;
    eng.readiness.status = "blocked";
    eng.readiness.checks[0] = {
      id: "oauth_scope",
      state: "fail",
      reason: "missing_scope",
    };
    cache.doc.teams[1]!.readiness = { status: "blocked", checks: [] };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(
      /^FAIL {2}team ENG: Catalyst's Linear connection is missing a permission it needs\./m,
    );
    expect(text).toMatch(/who: an owner or admin of your Catalyst workspace/);
    expect(text).toMatch(/^FAIL {2}team OPS: not ready for work yet/m);
  });
  test("Linear automation fixes reach both ready text and the JSON consumed by the installer", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        teams: {
          readiness: {
            status: string;
            checks: { id: string; state: string; reason?: string }[];
          };
        }[];
      };
    };
    const rules = [
      ["linear_automation_pr_open", "On PR open"],
      ["linear_automation_pr_review", "On PR review request or activity"],
      ["linear_automation_pr_ready", "On PR ready for merge"],
      ["linear_automation_pr_merge", "On PR merge"],
    ] as const;
    cache.doc.teams[0]!.readiness = {
      status: "blocked",
      checks: rules.map(([id]) => ({
        id,
        state: "fail",
        reason: "automation_conflict",
      })),
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(1);
    const report = JSON.parse(ctx.out.join("\n")) as {
      checks: { id: string; fix?: string }[];
    };
    const plain = makeCtx(home);
    expect(await main(["ready"], plain)).toBe(1);
    for (const [id, rule] of rules) {
      const fix = report.checks.find(
        (check) => check.id === `team:ENG:${id}`,
      )?.fix;
      expect(fix).toBe(
        `in Linear, open Settings → Teams → ENG → Workflow → Pull request and commit automations and set "${rule}" to No action, including any branch overrides. Then run catalyst ready again`,
      );
      expect(plain.out.join("\n")).toContain(`fix: ${fix}`);
    }
  });
  test("CTC-3561: a required_values fail names the missing variables and where to set them, and prints no value", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        teams: {
          readiness: { status: string; checks: Record<string, unknown>[] };
        }[];
      };
    };
    const eng = cache.doc.teams[0]!;
    eng.readiness.status = "degraded";
    // A value-shaped key rides along to prove the renderer reads `names` only.
    eng.readiness.checks.push({
      id: "required_values",
      state: "fail",
      names: ["DATABASE_URL", "STRIPE_KEY"],
      value: "sk_live_never_printed",
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^FAIL {2}team ENG: A variable ENG's repository needs has no value/m);
    expect(text).toContain(
      `fix: set DATABASE_URL, STRIPE_KEY with catalyst var set NAME --repo <owner/name> (catalyst secret set NAME --repo <owner/name> for a secret)`,
    );
    expect(text).not.toContain("sk_live_never_printed");
    expect(text).not.toContain("resolve required_values");
  });
  test("CTC-3561: one missing variable reads in the singular", async () => {
    await seedJoined(home, server);
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { teams: { readiness: { checks: Record<string, unknown>[] } }[] };
    };
    cache.doc.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      names: ["DATABASE_URL"],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const r = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
    });
    expect(r.checks.find((c) => c.id === "team:ENG:required_values")!.fix).toBe(
      `set DATABASE_URL with catalyst var set DATABASE_URL --repo <owner/name> (catalyst secret set DATABASE_URL --repo <owner/name> for a secret)`,
    );
  });
  test("CTC-3561: a team check without names, or with an empty list, keeps today's fix line", async () => {
    await seedJoined(home, server);
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { teams: { readiness: { checks: Record<string, unknown>[] } }[] };
    };
    cache.doc.teams[0]!.readiness.checks[0] = {
      id: "oauth_scope",
      state: "fail",
      reason: "missing_scope",
    };
    cache.doc.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      names: [],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const r = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
    });
    expect(r.checks.find((c) => c.id === "team:ENG:oauth_scope")!.fix).toBe(
      "run catalyst onboard and have an owner or admin approve the Linear link it prints",
    );
    expect(r.checks.find((c) => c.id === "team:ENG:required_values")!.fix).toBe(
      `set the missing values with catalyst var set NAME --repo <owner/name> (catalyst secret set NAME --repo <owner/name> for a secret)`,
    );
  });
  test("CTC-3606: an unresolved reference names the variable and the reference, and says the checkout refuses it", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        teams: {
          readiness: { status: string; checks: Record<string, unknown>[] };
        }[];
      };
    };
    const eng = cache.doc.teams[0]!;
    eng.readiness.status = "degraded";
    // DATABASE_URL is `$DB_SECRET` and DB_SECRET has no value. A value-shaped key rides along to prove only names are read.
    eng.readiness.checks.push({
      id: "required_values",
      state: "fail",
      names: ["DATABASE_URL"],
      unresolved: [
        {
          name: "DATABASE_URL",
          references: ["DB_SECRET"],
          value: "postgres://never_printed",
        },
      ],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toContain(
      "fix: DATABASE_URL refers to DB_SECRET, which has no value, so Catalyst can't start work there",
    );
    // An unresolved variable exists; it is not told to be set.
    expect(text).not.toContain("set DATABASE_URL");
    expect(text).not.toContain("never_printed");
  });
  test("CTC-3606: missing names, unresolved references and other repositories' missing names share one fix line", async () => {
    await seedJoined(home, server);
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { teams: { readiness: { checks: Record<string, unknown>[] } }[] };
    };
    cache.doc.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      names: ["API_URL", "DATABASE_URL"],
      unresolved: [
        { name: "DATABASE_URL", references: ["DB_SECRET", "DB_HOST"] },
      ],
      repos: [
        {
          repo: "acme/billing",
          reason: "required_value_missing",
          names: ["STRIPE_KEY"],
        },
        {
          repo: "acme/web",
          reason: "required_value_missing",
          names: ["SENTRY_DSN"],
          unresolved: [{ name: "SENTRY_DSN", references: ["SENTRY_TOKEN"] }],
        },
        { repo: "acme/docs", reason: "required_value_missing" },
      ],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const r = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
    });
    expect(r.checks.find((c) => c.id === "team:ENG:required_values")!.fix).toBe(
      `set API_URL with catalyst var set API_URL --repo <owner/name> (catalyst secret set API_URL --repo <owner/name> for a secret). ` +
        "DATABASE_URL refers to DB_SECRET, DB_HOST, which have no value, so Catalyst can't start work there. " +
        "acme/billing is missing STRIPE_KEY. " +
        "in acme/web, SENTRY_DSN refers to SENTRY_TOKEN, which has no value, so Catalyst can't start work there",
    );
  });
  test("CTC-3606: a check whose only finding is another repository's missing names names that repository", async () => {
    await seedJoined(home, server);
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { teams: { readiness: { checks: Record<string, unknown>[] } }[] };
    };
    cache.doc.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      repos: [
        {
          repo: "owner/repo",
          reason: "required_value_missing",
          names: ["STRIPE_KEY"],
        },
      ],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const r = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
    });
    expect(r.checks.find((c) => c.id === "team:ENG:required_values")!.fix).toBe(
      "owner/repo is missing STRIPE_KEY",
    );
  });
  test("CTC-3606: malformed unresolved and repos entries are dropped, and a check left with nothing keeps the generic line", async () => {
    await seedJoined(home, server);
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { teams: { readiness: { checks: Record<string, unknown>[] } }[] };
    };
    cache.doc.teams[0]!.readiness.checks.push({
      id: "required_values",
      state: "fail",
      unresolved: [
        { name: "DATABASE_URL", references: [] },
        { references: ["X"] },
        null,
        "junk",
      ],
      repos: [
        { names: ["STRIPE_KEY"] },
        { repo: "owner/repo", names: [] },
        null,
      ],
    });
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const r = await readyReport(ctx, {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
    });
    expect(r.checks.find((c) => c.id === "team:ENG:required_values")!.fix).toBe(
      `set the missing values with catalyst var set NAME --repo <owner/name> (catalyst secret set NAME --repo <owner/name> for a secret)`,
    );
  });
  test("CTC-3561: the bundle's contract range accepts 1.24.0, the version that ships names", async () => {
    const { contractVersionInRange } = await import("../src/contract");
    expect(
      contractVersionInRange("1.24.0", readManifest().tenantContractRange),
    ).toBe(true);
  });
});

describe("the runtime check — CTC-2158", () => {
  test("an unsupported runtime FAILS the runtime check and carries the one fix command", async () => {
    const report = await readyReport(ctx, {
      runtime: { kind: "node", version: "22.14.0", nodeCompat: "22.14.0" },
      skillNames: [],
      loadSdk: async () => {
        throw new Error("no registerHooks");
      },
    });
    const runtime = report.checks.find((c) => c.id === "runtime")!;
    expect(runtime.ok).toBe(false);
    expect(runtime.line).toContain("22.14.0");
    expect(runtime.line).toContain("22.15");
    expect(runtime.fix).toContain("runtime install");
    expect(report.ready).toBe(false);
  });

  test("bun 1.3.14 FAILS the runtime check as bun, never as its node compat major", async () => {
    const report = await readyReport(ctx, {
      runtime: { kind: "bun", version: "1.3.14", nodeCompat: "24.3.0" },
      skillNames: [],
      loadSdk: async () => {},
    });
    const runtime = report.checks.find((c) => c.id === "runtime")!;
    expect(runtime.line).toContain("bun 1.3.14");
    expect(runtime.line).not.toMatch(/\bnode: 24\b/);
    expect(runtime.ok).toBe(false);
  });

  test("a supported runtime passes and there is no check called `node` any more", async () => {
    const report = await readyReport(ctx, {
      runtime: { kind: "node", version: "26.8.1", nodeCompat: "26.8.1" },
      skillNames: [],
      loadSdk: async () => {},
    });
    expect(report.checks.find((c) => c.id === "runtime")!.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "node")).toBeUndefined();
  });
});

describe("more ready branches", () => {
  test("a degraded team with all checks passing is a note; an unknown check id needs an answer; no humans resolved", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        humans: unknown[];
        teams: {
          readiness: {
            status: string;
            checks: { id: string; state: string }[];
          };
        }[];
      };
    };
    cache.doc.humans = [];
    cache.doc.teams[0]!.readiness.status = "degraded";
    cache.doc.teams[0]!.readiness.checks =
      cache.doc.teams[0]!.readiness.checks.map((c) => ({
        ...c,
        state: "pass",
      }));
    cache.doc.teams[1]!.readiness = {
      status: "ready",
      checks: [{ id: "mystery_check", state: "fail" }],
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^note {2}team ENG: works, with some optional settings still missing/m);
    expect(text).toMatch(/^FAIL {2}team OPS: Mystery check needs attention\.$/m);
    expect(text).toMatch(/who: an owner or admin of your Catalyst workspace/);
    expect(text).not.toMatch(/tenant/i);
  });
  test("config names the connected person when the /me user block is present", async () => {
    await seedJoined(home, server, { config: { user: FIXTURE_ME_USER } });
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(
      /^ok {3}config: joined Hagale Technologies as Tony \(admin\)$/m,
    );
  });
  test("config falls back to the account line when there is no user block", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(
      /^ok {3}config: joined Hagale Technologies \(hagale-technologies\) as service$/m,
    );
  });
  test("warns (never refuses) when the installed bundle is older than the contract's minimum", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { skillsBundle?: unknown };
    };
    cache.doc.skillsBundle = {
      package: "@catalyst-cloud/catalyst-skills",
      minVersion: "9.9.9",
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as {
      ready: boolean;
      checks: { id: string; note?: boolean; line: string }[];
    };
    expect(j.ready).toBe(true);
    const note = j.checks.find((c) => c.id === "bundle");
    expect(note).toMatchObject({ note: true });
    expect(note!.line).toContain("9.9.9");
    expect(note!.line).toContain(
      "npm install -g @catalyst-cloud/cli@latest && catalyst login",
    );
    expect(note!.line).not.toContain("npm update");
  });
  test("no bundle note when the installed bundle meets the contract's minimum", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { skillsBundle?: unknown };
    };
    cache.doc.skillsBundle = {
      package: "@catalyst-cloud/catalyst-skills",
      minVersion: "0.0.1",
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { checks: { id: string }[] };
    expect(j.checks.find((c) => c.id === "bundle")).toBeUndefined();
  });
  test("no bundle note and no crash when the contract omits skillsBundle (older cloud)", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as {
      ready: boolean;
      checks: { id: string }[];
    };
    expect(j.ready).toBe(true);
    expect(j.checks.find((c) => c.id === "bundle")).toBeUndefined();
  });
  test("a failed check the contract marks needsAnswer: false stays informational (a note with the count), and the verdict stays READY", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: {
        teams: {
          readiness: {
            checks: {
              id: string;
              state: string;
              reason?: string;
              count?: number;
            }[];
          };
        }[];
      };
    };
    cache.doc.teams[0]!.readiness.checks[6] = {
      id: "labels_present",
      state: "fail",
      reason: "labels_missing",
      count: 2,
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as {
      ready: boolean;
      checks: {
        id: string;
        ok: boolean;
        note?: boolean;
        line: string;
        who?: string;
      }[];
    };
    const c = j.checks.find((x) => x.id === "team:ENG:labels_present")!;
    expect(c).toMatchObject({
      ok: false,
      note: true,
      who: "nobody yet; it is informational",
    });
    expect(c.line).toBe("team ENG: Catalyst's labels in Linear need attention.");
    expect(j.ready).toBe(true);
  });
});

describe("ready never recommends starting the replica (CTC-2499)", () => {
  test("not-configured, absent, stale and fresh replica states never mention replica start", async () => {
    const bare = makeCtx(tempHome());
    await main(["ready"], bare);
    expect(bare.out.join("\n")).not.toContain("replica start");

    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const c1 = makeCtx(home);
    await main(["ready"], c1);
    expect(c1.out.join("\n")).not.toContain("replica start");

    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000 });
    const c2 = makeCtx(home);
    await main(["ready"], c2);
    expect(c2.out.join("\n")).not.toContain("replica start");
  });
  test("a fresh replica also never mentions replica start", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 5, heartbeatAgeMs: 0 });
    await main(["ready"], ctx);
    expect(ctx.out.join("\n")).not.toContain("replica start");
  });
  test("the absent note says the replica is optional and off by default for large workspaces, with no ticket key", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^note {2}replica: absent/m); // the existing pin, unchanged
    expect(text).toContain("optional");
    expect(text).toContain("off by default for large workspaces");
    const replicaNote = text
      .split("\n")
      .find((line) => /^note {2}replica: absent/.test(line));
    expect(replicaNote).toBeDefined();
    expect(replicaNote).not.toMatch(/\bC[TL]C-\d+\b/);
  });
  test("ready --json exposes the writer's stopped state and failure count", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 });
    seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: {
        at: 1_700_000_000_000,
        reason: "5 consecutive snapshot failures",
        restartWith: "catalyst replica start --detach",
      },
    });
    expect(await main(["ready", "--json"], ctx)).toBe(0); // still a note, never a failure
    const j = JSON.parse(ctx.out.join("\n")) as {
      replica: {
        writer: {
          consecutiveFailures: number;
          lastError: string;
          stopped: { reason: string };
        };
      };
      checks: { id: string; note?: boolean }[];
    };
    expect(j.replica.writer.stopped.reason).toContain(
      "5 consecutive snapshot failures",
    );
    expect(j.replica.writer.consecutiveFailures).toBe(5);
    expect(j.replica.writer.lastError).toBe("/snapshot 503");
    expect(j.checks.find((c) => c.id === "replica")).toMatchObject({
      note: true,
    });
  });
  test("a writer that is no longer running is described in the past tense, and still recommends nothing", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41 }); // no lock, no live process: killed mid-backoff (CTC-2499)
    seedWriterState(home, {
      pid: 4_194_303,
      consecutiveFailures: 3,
      lastError: "/snapshot 503",
    });
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toContain("no longer running");
    expect(text).not.toContain("backing off"); // it is not waiting to retry; nothing is running
    expect(text).not.toContain("replica start");
  });
  test("the stopped case — and only the stopped case — names the restart command", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 });
    seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: {
        at: 1_700_000_000_000,
        reason: "5 consecutive snapshot failures",
        restartWith: "catalyst replica start --detach",
      },
    });
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toContain("5 consecutive snapshot failures");
    expect(text).toContain("/snapshot 503");
    expect(text).toContain("catalyst replica start --detach");
    expect(
      text.split("\n").filter((l) => l.startsWith("note  replica:")),
    ).toHaveLength(1);
  });
});

describe("ready prints each team's dispatch gate (CTC-2208)", () => {
  test("AC2a — a shut gate is a FAIL in plain words with the map page as the fix, and the verdict is NOT READY", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    seedTeamGate(home, 0, {
      status: "mapping_missing",
      missingSlots: ["dispatch", "pr"],
      remedy: "Open Settings → Linear teams → ENG and press Map my stages.",
    });
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(
      /^FAIL {2}team ENG: Catalyst doesn't know which ENG stages to use for starting work and pull requests\. Until it does, it starts no ENG tickets\.$/m,
    );
    // CTC-4680: the cloud's remedy names an API route and says "tenant"; the fix is the map command.
    expect(text).toContain("fix: run catalyst team map ENG");
    expect(text).not.toContain("Open Settings → Linear teams → ENG and press Map my stages.");
    expect(text).toMatch(
      /^ {6}who: an owner or admin of your Catalyst workspace$/m,
    );
    expect(text.split("\n").at(-1)).toBe("NOT READY");
  });

  test("AC2b — an open gate reads ok and the verdict stays READY", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    seedTeamGate(home, 0, { status: "open", missingSlots: [], remedy: null });
    seedTeamGate(home, 1, { status: "open", missingSlots: [], remedy: null });
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.at(-1)!) as {
      ready: boolean;
      checks: { id: string; ok: boolean; line: string }[];
    };
    expect(j.ready).toBe(true);
    expect(j.checks.filter((c) => c.id.endsWith(":dispatchGate"))).toEqual([
      {
        id: "team:ENG:dispatchGate",
        ok: true,
        line: "team ENG: Catalyst can start ENG tickets",
      },
      {
        id: "team:OPS:dispatchGate",
        ok: true,
        line: "team OPS: Catalyst can start OPS tickets",
      },
    ]);
  });

  test("AC2c — a contract with no dispatchGate (an older cloud) emits nothing and does not crash", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.at(-1)!) as {
      ready: boolean;
      checks: { id: string }[];
    };
    expect(j.ready).toBe(true);
    expect(j.checks.filter((c) => c.id.endsWith(":dispatchGate"))).toEqual([]);
  });

  test("AC2d — a team whose readiness was never checked still gets its gate line", async () => {
    await seedJoined(home, server); // OPS is readiness.status === "unchecked"
    installSkills(defaultSkillsDirFor(home), {});
    seedTeamGate(home, 1, {
      status: "mapping_missing",
      missingSlots: ["dispatch"],
      remedy: "Map OPS.",
    });
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toMatch(
      /^FAIL {2}team OPS: Catalyst doesn't know which OPS stages to use for starting work\./m,
    );
    expect(text).toContain("fix: run catalyst team map OPS");
    expect(text).toMatch(/^note {2}team OPS: Catalyst hasn't checked this team yet$/m); // still emitted, after it
  });

  test("AC2e — a status this bundle does not know never prints its code, and the fix is the team check", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    seedTeamGate(home, 0, {
      status: "frobnicated",
      missingSlots: [],
      remedy: null,
    });
    expect(await main(["ready", "--json"], ctx)).toBe(1);
    const j = JSON.parse(ctx.out.at(-1)!) as {
      checks: { id: string; ok: boolean; line: string; fix?: string }[];
    };
    const c = j.checks.find((x) => x.id === "team:ENG:dispatchGate")!;
    expect(c).toMatchObject({ ok: false });
    expect(c.line).toBe("team ENG: Catalyst can't start ENG tickets yet.");
    expect(c.fix).toBe("run catalyst team check ENG to see why");
  });
});

describe("ready reports when the installed skill bundle or CLI is behind the published release (CTC-2160)", () => {
  const online = (overrides: Partial<Ctx> = {}) =>
    makeCtx(home, { env: {}, ...overrides });

  test("ready makes no request when the release check is off, and none of the release checks appear", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    let calls = 0;
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      offline: true,
      fetchLatestRelease: async () => {
        calls += 1;
        return { latest: "9.9.9", reason: null, source: "network" };
      },
    });
    expect(calls).toBe(0);
    expect(
      report.checks.find(
        (c) => c.id === "cliRelease" || c.id === "skillsRelease",
      ),
    ).toBeUndefined();
  });

  test("CATALYST_SKILLS_OFFLINE=1 does the same without --offline", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    let calls = 0;
    const report = await readyReport(
      makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1" } }),
      {
        skillNames: CUSTOMER_SKILLS,
        fetchLatestRelease: async () => {
          calls += 1;
          return { latest: "9.9.9", reason: null, source: "network" };
        },
      },
    );
    expect(calls).toBe(0);
    expect(
      report.checks.find(
        (c) => c.id === "cliRelease" || c.id === "skillsRelease",
      ),
    ).toBeUndefined();
  });

  test("warns (never refuses) when the installed skill bundle is older than the published one", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    stampInstalledSkillsAt(defaultSkillsDirFor(home), "0.2.1");
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("0.9.9"),
    });
    expect(report.ready).toBe(true);
    const note = report.checks.find((c) => c.id === "skillsRelease")!;
    expect(note).toMatchObject({ ok: false, note: true });
    expect(note.line).toContain("0.2.1");
    expect(note.line).toContain("0.9.9");
    expect(note.line).toContain("npx skills update -y");
    expect(note.fix).toBeUndefined();
  });

  test("no skillsRelease note when the installed bundle matches the published one", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup(readManifest().version),
    });
    expect(report.checks.find((c) => c.id === "skillsRelease")).toBeUndefined();
  });

  test("no skillsRelease note when the installed bundle is NEWER than the published one", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("0.5.0"),
    });
    expect(report.checks.find((c) => c.id === "skillsRelease")).toBeUndefined();
    expect(report.checks.find((c) => c.id === "cliRelease")).toBeUndefined();
  });

  test("unstamped installed skills warn only once a stamped release is published (D4)", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    stampInstalledSkillsAt(defaultSkillsDirFor(home), null);
    const behind = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("0.9.9"),
    });
    const note = behind.checks.find((c) => c.id === "skillsRelease");
    expect(note).toBeDefined();
    expect(note!.line).toContain("0.9.9");
    const tooEarly = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("0.5.0"),
    });
    expect(
      tooEarly.checks.find((c) => c.id === "skillsRelease"),
    ).toBeUndefined();
  });

  test("no skillsRelease note when no skills are installed at all", async () => {
    await seedJoined(home, server);
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("9.9.9"),
    });
    expect(report.checks.find((c) => c.id === "skillsRelease")).toBeUndefined();
  });

  test("the oldest stamp is the one reported when installed skills disagree", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const dir = defaultSkillsDirFor(home);
    const p = join(dir, "catalyst-onboard", "SKILL.md");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(STAMP_RE, `${PROVENANCE_MARKER}@0.1.0`),
    );
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("9.9.9"),
    });
    expect(report.checks.find((c) => c.id === "skillsRelease")?.line).toContain(
      "0.1.0",
    );
    expect(report.checks.find((c) => c.id === "skillsRelease")?.line).toContain(
      "catalyst-onboard",
    );
  });

  // A mixed install is the field report itself: machines that pulled at different hours hold some
  // skills stamped behind and some old enough to carry no stamp at all. Both facts have to reach the
  // customer, and the "oldest" claim has to stay true while an unknown-version file sits beside it.
  test("a mixed install names the unstamped skills as well as the oldest stamp, in one note", async () => {
    await seedJoined(home, server);
    const dir = defaultSkillsDirFor(home);
    installSkills(dir, {});
    stampInstalledSkillsAt(dir, "0.6.1");
    const p = join(dir, "unstick", "SKILL.md");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(STAMP_RE, PROVENANCE_MARKER),
    );
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("1.0.0"),
    });
    const notes = report.checks.filter((c) => c.id === "skillsRelease");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.line).toContain("0.6.1");
    expect(notes[0]!.line).toContain("unstick");
    expect(notes[0]!.line).toContain("1.0.0");
    expect(notes[0]!.line).toContain("npx skills update -y");
    expect(report.ready).toBe(true);
  });

  test("warns when the running CLI is older than the latest publish", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("9.9.9"),
    });
    const note = report.checks.find((c) => c.id === "cliRelease")!;
    expect(note).toMatchObject({ ok: false, note: true });
    expect(note.line).toContain(readManifest().version);
    expect(note.line).toContain("9.9.9");
    expect(note.line).toContain(
      "npm install -g @catalyst-cloud/cli@latest && catalyst login",
    );
    expect(note.line).not.toContain("npm update");
  });

  test("no cliRelease note when the CLI is current or newer than the publish", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup(readManifest().version),
    });
    expect(report.checks.find((c) => c.id === "cliRelease")).toBeUndefined();
  });

  test("cliRelease stays silent when the tenant-minimum bundle check already fired (D9)", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as {
      doc: { skillsBundle?: unknown };
    };
    cache.doc.skillsBundle = {
      package: "@catalyst-cloud/catalyst-skills",
      minVersion: "9.9.9",
    };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup("9.9.9"),
    });
    const notes = report.checks.filter(
      (c) => c.id === "bundle" || c.id === "cliRelease",
    );
    expect(notes.map((c) => c.id)).toEqual(["bundle"]);
  });

  test("an unreachable registry is one note that blames nothing on the install", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const report = await readyReport(online(), {
      skillNames: CUSTOMER_SKILLS,
      fetchLatestRelease: fixedLookup(null, "timed out", "none"),
    });
    expect(report.ready).toBe(true);
    const notes = report.checks.filter(
      (c) => c.id === "cliRelease" || c.id === "skillsRelease",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.line).toContain("timed out");
    expect(report.checks.find((c) => c.id === "skillsRelease")).toBeUndefined();
  });

  test("the verdict stays READY and the exit code stays 0 with both release notes present, end to end through main()", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    stampInstalledSkillsAt(defaultSkillsDirFor(home), "0.1.0");
    const c = online({ fetch: registryFetch("9.9.9") });
    expect(await main(["ready"], c)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(/READY$/);
    expect(text).toMatch(/^note {2}cliRelease: /m);
    expect(text).toMatch(/^note {2}skillsRelease: /m);
  });

  test("--offline emits neither release check, end to end", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    stampInstalledSkillsAt(defaultSkillsDirFor(home), "0.1.0");
    const c = online({ fetch: registryFetch("9.9.9") });
    expect(await main(["ready", "--offline"], c)).toBe(0);
    const text = c.out.join("\n");
    expect(text).not.toContain("cliRelease");
    expect(text).not.toContain("skillsRelease");
  });

  test("ready --help names --offline", async () => {
    expect(await main(["ready", "--help"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("--offline");
  });
});
