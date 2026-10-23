// no-workspace-refusal.test.ts — CTC-5399: a person who signs in with no workspace (every route
// answering 403 `jwt-org-unmapped`) is told the invitation next step in plain words, never the raw
// reason, while every OTHER 403 reason keeps its own distinct line. Behavior runs through the
// fixture cloud (test/fixture.ts) and the real login verb, not a mocked branch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configPathFor, main, type Ctx } from "../src/cli";
import { ApiClient, fetchMe } from "../src/transport";
import { FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";

/** The exact sentence CTC-5399 promises the person, quoted here so a wording drift fails loudly. */
const NEXT_STEP =
  "This sign-in has no Catalyst workspace yet. Ask your admin for an invitation, or accept the one in your email, then run the install command again.";
const NO_WORKSPACE = { status: 403, body: { error: "forbidden", reason: "jwt-org-unmapped" } };

let server: FixtureServer;
let home: string;
let out: string[];
let err: string[];

function ctx(): Ctx {
  return {
    env: {},
    home,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
    now: () => new Date("2026-09-09T12:00:00Z"),
  };
}

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "catalyst-no-workspace-"));
  out = [];
  err = [];
});
afterEach(() => {
  delete server.meRefusal;
});

describe("fetchMe — the no-workspace refusal maps to the invitation next step", () => {
  test("a signed-in person with no organization sees the sentence, never the raw reason", async () => {
    server.meRefusal = NO_WORKSPACE;
    const failure = await fetchMe(server.url, FIXTURE_USER_KEY, fetch).catch((e: unknown) => e);
    expect((failure as Error).message).toContain(NEXT_STEP);
    expect((failure as Error).message).not.toContain("jwt-org-unmapped");
  });

  // Positive control: another 403 reason on /me must stay raw, so the two lines remain distinct.
  test("a different 403 reason keeps the raw reason and never prints the invitation sentence", async () => {
    server.meRefusal = { status: 403, body: { error: "forbidden", reason: "seat-inactive" } };
    const failure = await fetchMe(server.url, FIXTURE_USER_KEY, fetch).catch((e: unknown) => e);
    expect((failure as Error).message).toContain("seat-inactive");
    expect((failure as Error).message).not.toContain(NEXT_STEP);
  });
});

describe("login — a person without a workspace is told how to get one", () => {
  test("key rail: exit 2 with the invitation step on stderr, no config written", async () => {
    server.meRefusal = NO_WORKSPACE;
    const code = await main(["login", "--key", FIXTURE_USER_KEY, "--base-url", server.url], ctx());
    expect(code).toBe(2);
    expect(err.join("\n")).toContain(NEXT_STEP);
    expect(err.join("\n")).not.toContain("jwt-org-unmapped");
    expect(existsSync(configPathFor(home)), "a refused login writes no config").toBe(false);
  });

  test("keyless rail: the device flow succeeds, /me refuses, and the person still gets the invitation step", async () => {
    server.meRefusal = NO_WORKSPACE;
    const code = await main(["login", "--base-url", server.url], ctx(), {
      isTty: () => false,
      sleep: async () => {},
    });
    expect(code).toBe(2);
    const printed = `${out.join("\n")}\n${err.join("\n")}`;
    expect(printed).toContain(NEXT_STEP);
    expect(printed).not.toContain("jwt-org-unmapped");
    expect(existsSync(configPathFor(home))).toBe(false);
  });

  // Positive control on the ApiClient rail: a host-only route refusing a personal key keeps the
  // route line naming its own reason, untouched by the no-workspace mapping.
  test("a host-only 403 for a personal key keeps its route line and its own reason", async () => {
    const client = new ApiClient(`${server.url}/`, async () => FIXTURE_USER_KEY, fetch);
    const failure = await client.getJson("/api/v1/work/acquire").catch((e: unknown) => e);
    expect((failure as Error).message).toContain("may not reach that route");
    expect((failure as Error).message).toContain("not-machine-principal");
    expect((failure as Error).message).not.toContain(NEXT_STEP);
  });
});

describe("the catalyst-onboard skill names the invitation first", () => {
  const skillsRoot = join(import.meta.dirname, "..", "skills");

  test("its first onboarding step is accepting the workspace invitation", () => {
    const skill = readFileSync(join(skillsRoot, "catalyst-onboard", "SKILL.md"), "utf8");
    const section = skill.slice(
      skill.indexOf("## Use the onboarding command"),
      skill.indexOf("## Which branch you are on"),
    );
    const firstItem = section.match(/^\d+\.\s+(.+)$/m)?.[1] ?? "";
    expect(firstItem).toMatch(/Accept the workspace invitation first/);
  });

  test("the connect reference maps the jwt-org-unmapped refusal to the invitation", () => {
    const connecting = readFileSync(
      join(skillsRoot, "catalyst-onboard", "references", "connecting-this-machine.md"),
      "utf8",
    );
    expect(connecting).toContain("jwt-org-unmapped");
    expect(connecting).toMatch(/invitation email \(or the workspace admin who sends one\)/);
  });
});
