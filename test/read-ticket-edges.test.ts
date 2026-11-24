// read-ticket-edges.test.ts — the catalyst-linear reader prints a ticket's edges in both
// directions. `relations` on the record holds only the edges the ticket points out along; the
// tickets holding it arrive in `blocked_by`. A reader that prints one and not the other shows a
// held ticket as free. Each case runs the real script as a `node` process against a stand-in CLI
// that answers `query issue` with a fixture record.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const reader = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "catalyst-linear",
  "scripts",
  "read-ticket.mjs",
);

const BOTH_DIRECTIONS = {
  identifier: "ENG-2",
  title: "A ticket with edges in both directions",
  state: "Todo",
  relations: [
    {
      id: "rel-1",
      type: "blocks",
      issue_identifier: "ENG-2",
      related_identifier: "ENG-9",
      related_state: "Backlog",
      related_title: "Work this ticket holds",
    },
    {
      id: "rel-2",
      type: "related",
      issue_identifier: "ENG-2",
      related_identifier: "ENG-4",
    },
  ],
  blocked_by: [
    {
      identifier: "ENG-7",
      title: "Work that must finish first",
      state: "In Progress",
      is_ask: false,
      is_approval: false,
      is_decided: false,
      unresolved: false,
    },
    {
      identifier: "ENG-8",
      title: "ASK: pick the retention window",
      state: "Todo",
      is_ask: true,
      is_approval: false,
      is_decided: false,
      unresolved: true,
    },
    {
      identifier: "ENG-6",
      title: "ASK: approve the rollout",
      state: "Done",
      is_ask: true,
      is_approval: true,
      is_decided: true,
      unresolved: false,
    },
  ],
  description: "Fixture body.",
};

/** Run the real reader against a stand-in CLI that prints `record` for any verb. */
function read(record: unknown, ...flags: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "read-ticket-edges-"));
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    `process.stdout.write(${JSON.stringify(JSON.stringify(record))} + "\\n");\n`,
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({ account: "fixture", key: "key-fixture", cliPath: cli }),
  );
  const r = spawnSync(process.execPath, [reader, "ENG-2", ...flags], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe("the ticket reader prints edges in both directions", () => {
  test("the tickets holding this one print in their own block, with state and ask marks", () => {
    const out = read(BOTH_DIRECTIONS);
    expect(out).toContain(
      [
        "blocked by (3):",
        "  ENG-7 [In Progress] Work that must finish first",
        "  ENG-8 [Todo] (ask, unresolved) ASK: pick the retention window",
        "  ENG-6 [Done] (ask, approval, decided) ASK: approve the rollout",
      ].join("\n"),
    );
  });

  test("the edges this ticket points out along still print, with the other ticket's state when the record has one", () => {
    const out = read(BOTH_DIRECTIONS);
    expect(out).toContain(
      [
        "relations (2):",
        "  blocks: ENG-2 -> ENG-9 [Backlog]",
        "  related: ENG-2 -> ENG-4",
        "blocked by (3):",
      ].join("\n"),
    );
  });

  test("a ticket with no edges prints neither block", () => {
    const out = read({
      identifier: "ENG-3",
      title: "No edges",
      state: "Todo",
      relations: [],
      blocked_by: [],
      description: "Fixture body.",
    });
    expect(out).not.toContain("blocked by");
    expect(out).not.toContain("relations");
    expect(out).toBe(
      [
        "ticket: ENG-3",
        "title: No edges",
        "state: Todo",
        "description:",
        "Fixture body.",
        "",
      ].join("\n"),
    );
  });

  test("a record with no blocked_by field reads as before", () => {
    const { blocked_by: _dropped, ...older } = BOTH_DIRECTIONS;
    const out = read(older);
    expect(out).toContain("relations (2):");
    expect(out).not.toContain("blocked by");
  });

  test("--json prints the whole record, blockers included", () => {
    const row = JSON.parse(read(BOTH_DIRECTIONS, "--json")) as {
      blocked_by: { identifier: string }[];
    };
    expect(row.blocked_by.map((b) => b.identifier)).toEqual([
      "ENG-7",
      "ENG-8",
      "ENG-6",
    ]);
  });
});
