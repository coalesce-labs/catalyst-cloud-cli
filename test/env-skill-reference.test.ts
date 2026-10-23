// env-skill-reference.test.ts — the catalyst-onboard skill tells an agent to draft from this computer
// with `catalyst env draft` and to offer `catalyst env import`, and never to read a value itself.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reference = readFileSync(new URL("../skills/catalyst-onboard/references/declaring-a-repository.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("catalyst-onboard: declaring a repository", () => {
  it("step 3 runs catalyst env draft --root <repo> --json first", () => {
    const step3 = reference.split("\n").find((line) => line.startsWith("3. "));
    expect(step3).toContain("run `catalyst env draft --root <repo> --json` first");
    expect(step3).toContain("`.envrc`");
    expect(step3).toContain("`~/.claude.json`");
    expect(step3).toContain("Do not inspect `.env` values or run repository scripts");
  });

  it("the approval section offers catalyst env import --root <repo> --yes --json as a question", () => {
    const approval = reference.slice(reference.indexOf("## Ask before writing or opening the PR"), reference.indexOf("## File shape"));
    expect(approval).toContain("Want me to store this computer's values for these names in Catalyst?");
    expect(approval).toContain("`catalyst env import --root <repo> --yes --json`");
    expect(approval.indexOf("After approval, write the validated file.")).toBeLessThan(approval.indexOf("catalyst env import"));
  });

  it("never tells the agent to read a value", () => {
    expect(reference).toContain("so do not read them yourself");
    expect(reference).not.toMatch(/\b(?:read|print|show|copy) (?:the |each |its )?values?\b(?! from)/i);
  });

  it("the README names env draft's machine scan and env import's login", () => {
    expect(readme).toContain("`env draft --write` writes a new `.catalyst/catalyst.toml` from the repository's files and from this computer");
    expect(readme).toContain("These commands need no login, except `env import`");
  });
});
