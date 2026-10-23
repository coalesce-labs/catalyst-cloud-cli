// raise-script-gates.test.ts — CTC-5044: what-needs-me's raise.mjs passes the PR-hold flags through to
// `catalyst ask raise` unchanged, and passes none when none are given. The script runs as a real
// `node` process against a stand-in CLI that logs its argv, so what is under test is the script.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "what-needs-me", "scripts", "raise.mjs");

function run(args: string[]): { status: number | null; stdout: string; argv: string[] } {
  const home = mkdtempSync(join(tmpdir(), "raise-gates-"));
  const log = join(home, "argv.json");
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
      'process.stdout.write(JSON.stringify({ identifier: "ENG-101" }) + "\\n");',
    ].join("\n"),
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({ baseUrl: "https://cloud.example", account: "tenant-fixture", cliPath: cli, key: "fixture-key" }),
  );
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home },
  });
  return { status: r.status, stdout: r.stdout, argv: JSON.parse(readFileSync(log, "utf8")) as string[] };
}

const base = ["--team", "ENG", "--title", "Ship it?", "--option", "Release", "--option", "Keep", "--blocks", "ENG-1"];

describe("raise.mjs --gates-pr (CTC-5044)", () => {
  test("every gates flag reaches ask raise, and the human line names the release", () => {
    const r = run([...base, "--gates-pr", "5412", "--gates-pr", "5413", "--gates-label", "hold:preview", "--released-by", "A", "--gates-repo", "hagale/web"]);
    expect(r.status).toBe(0);
    expect(r.argv).toEqual([
      "ask", "raise", "--team", "ENG", "--title", "Ship it?", "--option", "Release", "--option", "Keep", "--blocks", "ENG-1",
      "--gates-pr", "5412", "--gates-pr", "5413", "--gates-label", "hold:preview", "--released-by", "A", "--gates-repo", "hagale/web", "--json",
    ]);
    expect(r.stdout).toContain("answer A releases the hold on PR #5412, #5413");
  });
  test("without the gates flags, ask raise gets none of them", () => {
    const r = run(base);
    expect(r.status).toBe(0);
    expect(r.argv.filter((a) => /gates|released-by/.test(a))).toEqual([]);
  });
});
