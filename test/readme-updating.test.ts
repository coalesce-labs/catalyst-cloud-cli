// readme-updating.test.ts — the README's "Updating" section says what the release check does
// (CTC-6742): the set times of day it moves the runner (the same defaults the code uses), the
// commands that change them, and that the installer's daily job runs the same check rather than
// asking the reader to migrate it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_TIMES } from "../src/update-windows";

const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

function updatingSection(): string {
  const start = readme.indexOf("\n## Updating\n");
  expect(start, "the README has an Updating section").toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

describe("the README's Updating section", () => {
  it("POSITIVE CONTROL: it names the default update times the schedule uses, in order", () => {
    const times = [...DEFAULT_WINDOW_TIMES];
    const listed = `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
    expect(updatingSection()).toContain(`only at set times of day, ${listed} in the machine's time zone`);
  });

  it("names the commands that set the times, restore the defaults and apply a waiting release at once", () => {
    const section = updatingSection();
    expect(section).toContain("`catalyst update policy windows 06:00,18:00 --time-zone America/Chicago`");
    expect(section).toContain("`catalyst update policy windows default`");
    expect(section).toContain("`catalyst runner update` or `catalyst update` applies a waiting release at once");
  });

  it("says the installer's daily job runs the same release check, and asks the reader to migrate nothing", () => {
    const section = updatingSection();
    expect(section).toContain("The installer's daily job runs the same release check");
    expect(section).not.toMatch(/must (also )?migrate/i);
  });
});
