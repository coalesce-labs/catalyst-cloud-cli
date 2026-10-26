// readme-updating.test.ts — the README's "Updating" section says what the release check does
// (CTC-6742): that it moves the runner at its next check with no set times by default (CTC-7465),
// the commands that set times and go back to none, and that the installer's daily job runs the same
// check rather than asking the reader to migrate it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

function updatingSection(): string {
  const start = readme.indexOf("\n## Updating\n");
  expect(start, "the README has an Updating section").toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

describe("the README's Updating section", () => {
  it("POSITIVE CONTROL: it says the check moves the runner at once, with no set times unless the owner chooses some", () => {
    const section = updatingSection();
    expect(section).toContain("moves the runner images to a newer release as soon as it finds one, with no set times of day");
    expect(section).not.toMatch(/03:00, 11:00, 16:00 and 22:00/);
  });

  it("names the commands that set times, go back to none and apply a waiting release at once", () => {
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
