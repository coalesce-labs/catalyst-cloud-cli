// args.test.ts — subcommand and positional parsing for every verb, per-verb flag validation, and
// every verb's --help mentioning every flag in its table.
import { describe, expect, test } from "vitest";
import { FLAG_TABLES, VERB_USAGE, flagList, parseArgs, positionals, verbHelp } from "../src/args";
import { UsageError, main } from "../src/cli";
import { makeCtx, tempHome } from "./helpers";

describe("parseArgs", () => {
  test("command, subcommand, rest", () => {
    const a = parseArgs(["query", "issue", "ENG-1", "--json"]);
    expect(a).toMatchObject({ command: "query", subcommand: "issue", rest: ["ENG-1"], json: true });
    expect(positionals(a)).toEqual(["issue", "ENG-1"]);
  });
  test("global flags keep their top-level fields", () => {
    const a = parseArgs(["join", "--key", "k", "--base-url", "http://x", "--skills-dir", "/s", "--force"]);
    expect(a).toMatchObject({ command: "join", key: "k", baseUrl: "http://x", skillsDir: "/s", force: true });
  });
  test("--name=value and repeatable flags", () => {
    const a = parseArgs(["watch", "--team=ENG", "--ticket", "ENG-1", "--ticket", "ENG-2"]);
    expect(a.flags.team).toBe("ENG");
    expect(flagList(a, "ticket")).toEqual(["ENG-1", "ENG-2"]);
  });
  test("an unknown per-verb flag is a UsageError naming the verb", () => {
    expect(() => parseArgs(["query", "issues", "--emoji", "x"])).toThrow(/unknown option for query: --emoji/);
    expect(() => parseArgs(["write", "comment", "ENG-1", "--wat"])).toThrow(UsageError);
  });
  test("missing flag value, empty value, and value on a boolean flag are usage errors", () => {
    expect(() => parseArgs(["join", "--key"])).toThrow(UsageError);
    expect(() => parseArgs(["join", "--key", ""])).toThrow(/--key requires a value/);
    expect(() => parseArgs(["contract", "--refresh=1"])).toThrow(/takes no value/);
  });
  test("help and version flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["explain", "-h"]).help).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
  });
  test("-- ends flag parsing", () => {
    const a = parseArgs(["replica", "sql", "--", "select 1 --x"]);
    expect(a.rest).toEqual(["select 1 --x"]);
  });
});

describe("every verb's --help", () => {
  for (const verb of Object.keys(VERB_USAGE)) {
    test(`${verb} --help exits 0 and mentions every flag in its table`, async () => {
      const ctx = makeCtx(tempHome());
      const code = await main([verb, "--help"], ctx);
      expect(code).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toContain(`catalyst ${VERB_USAGE[verb]}`);
      for (const flag of Object.keys(FLAG_TABLES[verb] ?? {})) expect(text, `${verb} help must mention --${flag}`).toContain(`--${flag}`);
      expect(text).toContain("--json");
      expect(verbHelp(verb)).toBe(text);
    });
  }
  test("query's usage documents --all (CTC-2010)", () => {
    expect(VERB_USAGE.query).toContain("[--all]");
  });
  test("an unknown verb is exit 1 with the usage", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["frobnicate"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("unknown command");
  });
});

describe("repository lifecycle arguments", () => {
  test("parses pause and resume reasons as values", () => {
    expect(parseArgs(["repo", "pause", "acme/app", "--reason", "flaky deploy"]).flags.reason).toBe("flaky deploy");
    expect(parseArgs(["repo", "resume", "acme/app", "--reason=deploy fixed", "--json"]).flags.reason).toBe("deploy fixed");
    expect(parseArgs(["repo", "resume", "acme/app"]).flags.reason).toBeUndefined();
    expect(() => parseArgs(["repo", "pause", "acme/app", "--reason"])).toThrow(/--reason requires a value/);
  });
});

test("repository help documents cloud writes and keeps the local verbs", async () => {
  const ctx = makeCtx(tempHome());
  expect(await main(["repo", "--help"], ctx)).toBe(0);
  const help = ctx.out.join("\n");
  for (const syntax of ["status", "pause <owner/name> --reason <text>", "resume <owner/name> [--reason <text>]", "agents-block <path> [--write]", "agent-setup <path> [--apply] [--with-check]", "1 to 500", "owner or admin"]) expect(help).toContain(syntax);
});
