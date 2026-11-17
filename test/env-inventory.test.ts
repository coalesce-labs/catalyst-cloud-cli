// env-inventory.test.ts — CTC-2496 acceptance criterion 1: a fixture repository carrying a
// `.env.example`, a GitHub workflow that uses `secrets.X`, a `wrangler.toml` binding and a
// `process.env.Y` read; each name lands in the right group with its file:line source and its
// consumer. Plus the CLI wiring (`env inventory`, `--json`, offline, usage, VERB_HELP_KNOWN).
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { VERB_USAGE, verbHelp } from "../src/args";
import { inventoryRepo } from "../src/env/inventory";
import { renderInventory } from "../src/env/render";
import { scanWorkflow } from "../src/env/scan-workflow";
import { writeFixtureRepo } from "./env-fixture-repo";
import { makeCtx, tempHome } from "./helpers";

const root = writeFixtureRepo();
const inv = inventoryRepo(root);
const at = (name: string) => inv.entries.find((e) => e.name === name);

describe("scanners + grouping (acceptance criterion 1)", () => {
  test("DATABASE_URL: build/test, found in the example, the source read and a non-deploy workflow job", () => {
    const e = at("DATABASE_URL");
    expect(e).toBeDefined();
    expect(e!.group).toBe("build/test");
    expect(e!.localSource).toBe(".env file or your shell");
    const files = e!.found.map((f) => `${f.file}:${f.line}`);
    expect(files).toContain(".env.example:1");
    expect(files).toContain("src/index.ts:2");
    expect(e!.found.some((f) => f.file === ".github/workflows/ci.yml")).toBe(true);
    expect(e!.found.some((f) => f.consumer === "a documented name in .env.example")).toBe(true);
    expect(e!.found.some((f) => f.consumer === "read by src/index.ts")).toBe(true);
    expect(e!.found.some((f) => f.consumer === "workflow job test")).toBe(true);
  });

  test("STRIPE_SECRET_KEY: a source-only read is build/test, local value from .env or the shell", () => {
    expect(at("STRIPE_SECRET_KEY")).toMatchObject({ group: "build/test", localSource: ".env file or your shell" });
  });

  test("OPTIONAL_FLAG: a commented name in .env.example is still documented", () => {
    expect(at("OPTIONAL_FLAG")).toBeDefined();
  });

  test("CLOUDFLARE_API_TOKEN and NPM_PUBLISH_TOKEN: referenced only from the deploy job -> deploy-only, CI secret", () => {
    expect(at("CLOUDFLARE_API_TOKEN")).toMatchObject({ group: "deploy-only", localSource: "CI secret" });
    expect(at("NPM_PUBLISH_TOKEN")).toMatchObject({ group: "deploy-only", localSource: "CI secret" });
  });

  test("D-7: a secret referenced from a NON-deploy job is build/test — the stricter need wins", () => {
    expect(at("TEST_DATABASE_URL")).toMatchObject({ group: "build/test", localSource: "CI secret" });
  });

  test("a workflow-level secret ref (not job-scoped) is build/test, never deploy-only", () => {
    expect(at("GLOBAL_TOKEN")).toMatchObject({ group: "build/test" });
  });

  test("wrangler bindings: kv_namespaces, d1_databases and durable_objects.bindings all land in bindings", () => {
    expect(at("SESSIONS")).toMatchObject({ group: "bindings", localSource: "Cloudflare binding" });
    expect(at("SESSIONS")!.found[0]).toMatchObject({ file: "wrangler.toml", consumer: "kv_namespaces binding" });
    expect(at("DB")).toMatchObject({ group: "bindings" });
    expect(at("DB")!.found[0]!.consumerKind).toBe("d1_databases");
    // Discovery 5: durable_objects.bindings is keyed `name =`, not `binding =`
    expect(at("COUNTER")).toMatchObject({ group: "bindings" });
    expect(at("COUNTER")!.found[0]!.consumerKind).toBe("durable_objects.bindings");
    // Discovery 5: an [env.production.*] table's binding carries the stripped environment name
    expect(at("PROD_SESSIONS")).toMatchObject({ group: "bindings", wranglerEnvironment: "production" });
  });

  test("D-6: a wrangler [vars] entry is build/test, not a binding, with nothing to declare", () => {
    expect(at("PUBLIC_MODE")).toMatchObject({ group: "build/test", needsDeclaration: false });
    expect(at("PROD_ONLY")).toMatchObject({ group: "build/test", needsDeclaration: false, wranglerEnvironment: "production" });
  });

  test("Discovery 1: a flow-style workflow env mapping is found (a naive line scanner misses it)", () => {
    expect(at("FLOW_ONE")).toBeDefined();
    expect(at("FLOW_TWO")).toBeDefined();
  });

  test("Discovery 3: a job that merely echoes the word 'deploy' is not classified a deploy job", () => {
    expect(inv.jobs.find((j) => j.id === "ship")!.deploy).toBe(false);
    expect(inv.jobs.find((j) => j.id === "deploy")!.deploy).toBe(true);
    expect(inv.jobs.find((j) => j.id === "test")!.deploy).toBe(false);
  });

  test("Discovery 4: no name is invented from inside a wrangler.toml multi-line string, but the key itself is real", () => {
    expect(inv.entries.map((e) => e.name)).not.toContain("a");
    expect(at("MULTI")).toBeDefined();
  });

  test("a run: block's plain shell text is not mined for a name, but a ${{ secrets.X }} inside it IS a reference", () => {
    expect(inv.entries.map((e) => e.name)).not.toContain("NOT_A_NAME");
    expect(at("INSIDE_BLOCK")).toBeDefined();
  });

  test("groups are in ticket order, and names are sorted within each group", () => {
    expect(inv.groups.map((g) => g.id)).toEqual(["build/test", "deploy-only", "bindings"]);
    for (const g of inv.groups) expect(g.names).toEqual([...g.names].sort());
  });

  test("D-4: a wrangler.jsonc config is named as unread, never silently reported as empty", () => {
    const jsoncRoot = writeFixtureRepo({ "wrangler.jsonc": "{}" });
    const withJsonc = inventoryRepo(jsoncRoot);
    expect(withJsonc.notes.join(" ")).toMatch(/wrangler\.jsonc.*not read/i);
  });
});

describe("scanWorkflow edge cases", () => {
  test("a file that is not valid YAML yields no sightings and no jobs, rather than throwing", () => {
    const res = scanWorkflow("bad.yml", "jobs:\n  build:\n    - not: [valid, yaml,\n");
    expect(res.sightings).toEqual([]);
    expect(res.jobs).toEqual([]);
  });

  test("a job id matching the deploy pattern (e.g. 'cd') is classified deploy on id alone", () => {
    const text = ["jobs:", "  cd:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo hi", ""].join("\n");
    const res = scanWorkflow("x.yml", text);
    expect(res.jobs.find((j) => j.id === "cd")).toMatchObject({ deploy: true, why: "job id matches a deploy pattern" });
  });
});

describe("renderInventory", () => {
  test("an empty group prints '(none found)' rather than nothing", () => {
    const bareRoot = writeFixtureRepo({ "wrangler.toml": "" });
    const bare = inventoryRepo(bareRoot);
    const bindingsGroup = bare.groups.find((g) => g.id === "bindings")!;
    expect(bindingsGroup.names).toEqual([]);
    const lines = renderInventory(bare);
    const idx = lines.findIndex((l) => l.startsWith("bindings"));
    expect(lines[idx + 1]).toBe("  (none found)");
  });

  test("notes print under a 'Notes:' heading when present, and nothing extra when absent", () => {
    const withNote = inventoryRepo(writeFixtureRepo({ "wrangler.jsonc": "{}" }));
    expect(renderInventory(withNote)).toContain("Notes:");
    const withoutNote = inventoryRepo(writeFixtureRepo());
    expect(renderInventory(withoutNote)).not.toContain("Notes:");
  });
});

describe("the env inventory CLI verb", () => {
  test("prints three groups, each name with file:line, consumer and local source", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "inventory", root], ctx)).toBe(0);
    const out = ctx.out.join("\n");
    for (const h of ["build/test", "deploy-only", "bindings"]) expect(out).toContain(h);
    expect(out).toMatch(/DATABASE_URL[\s\S]*\.env\.example:1/);
    expect(out).toContain("CLOUDFLARE_API_TOKEN");
    expect(out).toContain("value committed in wrangler.toml");
  });

  test("--json carries the same data in machine form", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "inventory", root, "--json"], ctx)).toBe(0);
    const doc = JSON.parse(ctx.out.join("\n")) as { groups: { id: string }[]; entries: { name: string; group: string }[] };
    expect(doc.groups.map((g) => g.id)).toEqual(["build/test", "deploy-only", "bindings"]);
    expect(doc.entries.find((e) => e.name === "SESSIONS")!.group).toBe("bindings");
  });

  test("no login and no network: it runs against a home with no customer.json at all", async () => {
    expect(await main(["env", "inventory", root], makeCtx(tempHome()))).toBe(0);
  });

  test("env with no subcommand, or an unknown one, is a UsageError naming inventory and check", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "frobnicate"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/inventory \| check/);
  });

  test("D-1: env and environment are told apart in usage text", () => {
    expect(VERB_USAGE.env).toMatch(/this repository|offline|no login/i);
    expect(VERB_USAGE.environment).toMatch(/workspace/i);
    expect(verbHelp("env")).toContain("no login");
  });

  test("D-11: VERB_HELP_KNOWN covers both env and environment — a usage error prints the verb's own help", async () => {
    for (const v of ["env", "environment"]) {
      const ctx = makeCtx(tempHome());
      await main([v, "read", "extra-positional"], ctx);
      expect(ctx.err.join("\n"), `${v} must fall back to its own help`).toContain(`catalyst ${VERB_USAGE[v]}`);
    }
  });
});

// C-3 (validate attempt 7): `resolve(rest[0] ?? ".")` was never checked for existence and `walkRepo`
// swallows the readdir failure, so a typo'd path printed three empty groups and exited 0 — a mistyped
// argument was indistinguishable from a clean repository, in the one tool a person reviews before
// declaring anything.
describe("C-3: a path that is not a readable directory is refused", () => {
  test("a nonexistent path exits 1 and names the path, instead of reporting an empty repository", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "inventory", "/definitely/not/here"], ctx)).toBe(1);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("/definitely/not/here");
    expect(printed).not.toContain("(none found)");
  });

  test("a path that is a FILE rather than a directory is refused too", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "inventory", join(root, "wrangler.toml")], ctx)).toBe(1);
  });

  test("positive control: the fixture repository itself is still accepted and reports names", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "inventory", root], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("DATABASE_URL");
  });
});
