import { describe, expect, it } from "vitest";
import { isSecretName } from "../src/env/draft.js";
import { envrcLiteralValues, scanEnvrc } from "../src/env/scan-envrc.js";
import { ALL_NAMES, envrcText, SENTINEL, TOKEN_NAMES, valueFor } from "./env-machine-fixture.js";

describe("scanEnvrc", () => {
  it("lists the 44 names a 44-export .envrc exports, sorted, with line numbers, and 13 match the draft's secret rule", () => {
    const scan = scanEnvrc(envrcText());
    expect(scan.exported.map(({ name }) => name)).toEqual(ALL_NAMES);
    expect(scan.exported).toHaveLength(44);
    expect(scan.exported.find(({ name }) => name === "GITHUB_TOKEN")).toEqual({ name: "GITHUB_TOKEN", line: 4, computed: true, inherited: false });
    expect(scan.exported.filter(({ name }) => isSecretName(name)).map(({ name }) => name)).toEqual(TOKEN_NAMES);
  });

  it("reads `export NAME=…`, `export NAME` and `export A B` forms; a bare `NAME=x` (not exported) is not a name", () => {
    const scan = scanEnvrc("ONE=1\nexport TWO=2\nexport ONE\nexport THREE FOUR # both\nNOT_EXPORTED=x\n");
    expect(scan.exported.map(({ name }) => name)).toEqual(["FOUR", "ONE", "THREE", "TWO"]);
    expect(scan.exported.find(({ name }) => name === "ONE")!.computed).toBe(false);
    expect(scan.exported.find(({ name }) => name === "THREE")!.computed).toBe(true);
  });

  it("reports direnv lines it does not follow (dotenv, dotenv_if_exists, source_env, source_up, PATH_add, use, layout) as notRead with their line", () => {
    const scan = scanEnvrc("dotenv\ndotenv_if_exists .env.local\nsource_env ../x\nsource_up\nPATH_add bin\nuse nix\nlayout python\nexport A=1\n");
    expect(scan.notRead).toEqual([
      { line: 1, reason: "dotenv" },
      { line: 2, reason: "dotenv_if_exists" },
      { line: 3, reason: "source_env" },
      { line: 4, reason: "source_up" },
      { line: 5, reason: "PATH_add" },
      { line: 6, reason: "use" },
      { line: 7, reason: "layout" },
    ]);
    expect(scan.exported.map(({ name }) => name)).toEqual(["A"]);
  });

  it("reports unsupported export shapes (`export -n X`, `export A=1 B=2`, `export $(…)`) as notRead, not as names", () => {
    const scan = scanEnvrc("export -n X\nexport A=1 B=2\nexport $(grep -v '^#' .env | xargs)\nexport OK=1\n");
    expect(scan.exported.map(({ name }) => name)).toEqual(["OK"]);
    expect(scan.notRead.map(({ line }) => line)).toEqual([1, 2, 3]);
    expect(scan.notRead.every(({ reason }) => reason === "an export this reader does not follow")).toBe(true);
  });

  it("skips machine settings: PATH, MANPATH, HOME, SHELL, PWD, TMPDIR, LANG, VIRTUAL_ENV, LC_*, DIRENV_*, DYLD_*, OTEL_*, listing them in skippedNames", () => {
    const names = ["PATH", "MANPATH", "HOME", "SHELL", "PWD", "TMPDIR", "LANG", "VIRTUAL_ENV", "LC_ALL", "DIRENV_LOG_FORMAT", "DYLD_LIBRARY_PATH", "OTEL_SERVICE_NAME"];
    const scan = scanEnvrc(`${names.map((name) => `export ${name}=x`).join("\n")}\nexport KEEP=1\n`);
    expect(scan.exported.map(({ name }) => name)).toEqual(["KEEP"]);
    expect(scan.skippedNames).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("does not take continuation lines of a multi-line quoted value, a PEM block, a heredoc or a backslash continuation as names", () => {
    const text = [
      'export MULTI="first',
      "export INSIDE_QUOTE=no",
      'end"',
      "export KEY=-----BEGIN PRIVATE KEY-----",
      "export INSIDE_PEM=abc=",
      "-----END PRIVATE KEY-----",
      "export DOC=$(cat <<EOF",
      "export INSIDE_HEREDOC=1",
      "EOF",
      ")",
      "export LONG=one\\",
      "export INSIDE_BACKSLASH=2",
      "export AFTER=ok",
    ].join("\n");
    const scan = scanEnvrc(text);
    expect(scan.exported.map(({ name }) => name)).toEqual(["AFTER", "DOC", "KEY", "LONG", "MULTI"]);
  });

  it("marks `export A=\"$(cmd)\"`, `export A=$B`, backticks and multi-line values as computed", () => {
    const scan = scanEnvrc('export A="$(cmd)"\nexport B=$OTHER\nexport C=`date`\nexport D="open\nclose"\nexport E=plain\nexport F=$(gh auth token)\n');
    const computed = Object.fromEntries(scan.exported.map(({ name, computed: c }) => [name, c]));
    expect(computed).toEqual({ A: true, B: true, C: true, D: true, E: false, F: true });
  });

  it.each([
    'export QUERY="a<<EOF"',
    "export QUERY='a<<EOF'",
    "export APP_MODE=dev # example <<EOF",
    'QUERY="a<<EOF"',
    "QUERY=dev # example <<EOF",
    'printf "%s" "a<<EOF"',
    "printf example # <<EOF",
    'export QUERY="a\\\"<<EOF"',
    "printf \\<<EOF",
  ])("keeps later exports after quoted, commented or escaped heredoc text: %s", (line) => {
    const text = `${line}\nexport API_TOKEN=example\n`;
    expect(scanEnvrc(text).exported).toContainEqual({ name: "API_TOKEN", line: 2, computed: false, inherited: false });
    expect(envrcLiteralValues(text, new Set(["API_TOKEN"])).get("API_TOKEN")).toBe("example");
  });

  it.each([
    ["export DOC=$(cat <<EOF", ")"],
    ['export DOC="$(cat <<\'EOF\'', ')"'],
    ['export DOC="$(printf \'%s\' "$(cat <<-\"EOF\"', ')")"'],
    ["export DOC=`cat <<EOF", "`"],
  ])("still skips heredoc bodies in command substitutions: %s", (start, end) => {
    const text = [start, "export INSIDE_HEREDOC=hidden", "EOF", end, "export AFTER=ok"].join("\n");
    expect(scanEnvrc(text).exported.map(({ name }) => name)).toEqual(["AFTER", "DOC"]);
  });

  it("reports every export it drops as notRead: after a multi-line value, behind a guard, declare/typeset -x, an unclosed quote", () => {
    expect(scanEnvrc('export A="one\ntwo"; export B=2\n').notRead).toEqual([{ line: 2, reason: "a command after a multi-line value" }]);
    expect(scanEnvrc("export G='one\ntwo' && export H=3\n").notRead).toEqual([{ line: 2, reason: "a command after a multi-line value" }]);
    expect(scanEnvrc("[ -n x ] && export D=1\n").notRead).toEqual([{ line: 1, reason: "an export this reader does not follow" }]);
    expect(scanEnvrc("declare -x E=1\ntypeset -x F=2\n").notRead).toEqual([
      { line: 1, reason: "declare -x, which this reader does not follow" },
      { line: 2, reason: "typeset -x, which this reader does not follow" },
    ]);
    expect(scanEnvrc('export U="never\nexport V=1\nexport W=2\n').notRead).toEqual([
      { line: 1, reason: "a value that never closes; the lines after it were not read" },
    ]);
    // Control: a plain export and a commented one report nothing.
    expect(scanEnvrc("export OK=1\n# export not this\n").notRead).toEqual([]);
  });

  it("reads `foo#bar` as one static literal: `#` starts a comment only at the start of a word", () => {
    expect(scanEnvrc("export C=foo#bar\n").exported).toEqual([{ name: "C", line: 1, computed: false, inherited: false }]);
    expect(envrcLiteralValues("export C=foo#bar\n", new Set(["C"]))).toEqual(new Map([["C", "foo#bar"]]));
    expect(envrcLiteralValues("export C=foo #bar\n", new Set(["C"]))).toEqual(new Map([["C", "foo"]]));
  });

  it("marks a bare `export NAME` the file never assigns as inherited; one it assigns first is not", () => {
    const scan = scanEnvrc("export SENTRY_DSN\nX=1\nexport X\n");
    expect(scan.exported.find(({ name }) => name === "SENTRY_DSN")!.inherited).toBe(true);
    expect(scan.exported.find(({ name }) => name === "X")!.inherited).toBe(false);
  });

  it("never returns a value: JSON.stringify(scan) contains no sentinel (positive control: the sentinels are in the input text)", () => {
    const text = envrcText();
    for (const name of ALL_NAMES.filter((n) => n !== "GITHUB_TOKEN")) expect(text).toContain(valueFor(name));
    expect(JSON.stringify(scanEnvrc(text))).not.toContain(SENTINEL);
  });
});

describe("envrcLiteralValues", () => {
  it("returns plain, 'single' and \"double\" literals (no $, backtick or backslash), with a trailing ` # comment` dropped", () => {
    const text = "export A=plain\nexport B='single value'\nexport C=\"double\" # note\nexport D=x # note\n";
    const values = envrcLiteralValues(text, new Set(["A", "B", "C", "D"]));
    expect(Object.fromEntries(values)).toEqual({ A: "plain", B: "single value", C: "double", D: "x" });
  });

  it("returns nothing for computed, empty, multi-line or `~`-leading values, or for names not requested", () => {
    const text = 'export A="$(cmd)"\nexport B=\nexport C="open\nclose"\nexport D=~/x\nexport E="has\\\\slash"\nexport F=keep\nexport G=not-requested\n';
    const values = envrcLiteralValues(text, new Set(["A", "B", "C", "D", "E", "F"]));
    expect(Object.fromEntries(values)).toEqual({ F: "keep" });
  });

  it("returns the 43 static literals of the fixture, and not the computed GITHUB_TOKEN", () => {
    const values = envrcLiteralValues(envrcText(), new Set(ALL_NAMES));
    expect(values.size).toBe(43);
    expect(values.has("GITHUB_TOKEN")).toBe(false);
    expect(values.get("PLAIN_SETTING_00")).toBe(valueFor("PLAIN_SETTING_00"));
  });
});
