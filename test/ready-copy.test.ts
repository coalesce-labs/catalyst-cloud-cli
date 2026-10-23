// CTC-4680: every team row `catalyst ready` prints is plain words: no check id, reason code, API
// route or "tenant", and every fix is a catalyst command, a full URL or a step in Linear's own settings.
import { describe, expect, test } from "vitest";
import {
  dispatchGateCopy,
  teamCheckCopy,
  whoFixes,
} from "../src/ready-copy.js";

const BASE = "https://staging.catalystcloud.dev";
const IDS = [
  "oauth_scope",
  "token_live",
  "team_visible",
  "mapped_states_exist",
  "mapping_total",
  "types_compatible",
  "labels_present",
  "writes_land",
  "webhook_covers_team",
  "hosts_current",
  "environment_declared",
  "tools_resolvable",
  "required_values",
  "reviewer_required",
  "reviewer_configured",
  "reviewer_answering",
  "linear_automation_pr_open",
  "linear_automation_pr_review",
  "linear_automation_pr_ready",
  "linear_automation_pr_merge",
  "merge_queue_configured",
  "coding_account_enrolled",
  "github_app_installed",
  "thoughts_reachable",
];

function assertPlain(text: string) {
  expect(text).not.toMatch(/tenant/i);
  expect(text).not.toMatch(/\/api\/v1/);
  expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/); // no snake_case ids or reason codes
  expect(text).not.toMatch(/—/);
}

describe("team checks", () => {
  for (const id of IDS)
    for (const state of ["fail", "unknown"] as const)
      test(`${id} ${state} is plain words with a fix`, () => {
        const row = teamCheckCopy(BASE, "ADV", id, state, null);
        expect(row.line.startsWith("team ADV: ")).toBe(true);
        assertPlain(row.line);
        expect(row.fix).toBeTruthy();
        assertPlain(row.fix ?? "");
        assertPlain(whoFixes(id));
      });

  test("a mapping failure names the map command, not a page", () => {
    const fix = teamCheckCopy(BASE, "ADV", "mapping_total", "fail", null).fix;
    expect(fix).toContain("catalyst team map ADV");
    expect(fix).not.toContain("/settings/");
  });

  test("a check with a command offers it before its page", () => {
    expect(teamCheckCopy(BASE, "ADV", "webhook_covers_team", "fail", null).fix).toMatch(
      /^an owner or admin registers the repository with catalyst onboard --team ADV --repo <owner\/name>, or open https:\/\/staging\.catalystcloud\.dev\/settings\/projects$/,
    );
  });

  test("required values keep the variable names the caller built", () => {
    expect(
      teamCheckCopy(BASE, "ADV", "required_values", "fail", "set DATABASE_URL on …").fix,
    ).toBe("set DATABASE_URL on …");
  });

  test("an unknown check id still reads as words", () => {
    const row = teamCheckCopy(BASE, "ADV", "brand_new_check", "fail", null);
    expect(row.line).toBe("team ADV: Brand new check needs attention.");
    expect(row.fix).toBe("run catalyst team check ADV to see why");
  });
});

describe("dispatch gate", () => {
  test("mapping missing names the moves in words and links the map page", () => {
    const row = dispatchGateCopy(BASE, "ADV", "mapping_missing", ["dispatch", "pr", "done", "canceled"]);
    expect(row.line).toBe(
      "team ADV: Catalyst doesn't know which ADV stages to use for starting work, pull requests, Done and Canceled. Until it does, it starts no ADV tickets.",
    );
    expect(row.fix).toBe("run catalyst team map ADV");
  });

  test("an unresolved mapping says Catalyst is catching up, not 'map your stages'", () => {
    const row = dispatchGateCopy(BASE, "ADV", "mapping_state_unresolved", ["dispatch", "pr", "done", "canceled"]);
    assertPlain(row.line);
    expect(row.line).toContain("in its copy of ADV yet");
    expect(row.fix).toContain("run catalyst ready again in a minute");
    expect(row.fix).toContain("run catalyst team check ADV");
    expect(row.fix).not.toMatch(/Map my stages|Re-check/);
  });

  test("an open gate is one short line", () => {
    expect(dispatchGateCopy(BASE, "ADV", "open", [])).toEqual({
      line: "team ADV: Catalyst can start ADV tickets",
    });
  });

  test("a status this bundle doesn't know never prints the code", () => {
    const row = dispatchGateCopy(BASE, "ADV", "frobnicated", []);
    expect(row.line).not.toContain("frobnicated");
    assertPlain(row.line);
  });
});

test("who never names a tenant", () => {
  expect(whoFixes("mapping_total")).toBe("an owner or admin of your Catalyst workspace");
  expect(whoFixes("team_visible")).toBe("an admin of your Linear workspace");
  expect(whoFixes("not_a_check")).toBe("an owner or admin of your Catalyst workspace");
});

test("CTC-4708: stages still syncing is an expected wait with no fix to do", () => {
  const row = dispatchGateCopy(BASE, "ADV", "stages_syncing", ["dispatch", "pr"]);
  expect(row.line).toBe(
    "team ADV: Catalyst is still copying ADV's stages from Linear. It starts ADV tickets once that finishes.",
  );
  expect(row.fix).toBeUndefined();
});
