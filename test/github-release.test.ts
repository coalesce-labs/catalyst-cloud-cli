// github-release.test.ts — CTC-9044: every CLI release gets a GitHub Release whose notes are that
// version's CHANGELOG section. The script's pure parts are tested here; the workflows are read as
// text to hold the two things a reviewer cannot see from a green run: only the Release job can
// write to the repository, and it runs after the npm publish, never instead of it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  compareVersions,
  highestVersion,
  releaseNotes,
  releaseTitle,
  versionOfTag,
} from "../scripts/github-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.16.44",
  "",
  "First paragraph of 0.16.44.",
  "",
  "Second paragraph of 0.16.44.",
  "",
  "## 0.16.43",
  "",
  "Only paragraph of 0.16.43.",
  "",
  "## 0.16.4",
  "",
  "Old one.",
  "",
].join("\n");

describe("releaseNotes", () => {
  test("returns the whole section, every paragraph, and nothing from the next version", () => {
    expect(releaseNotes(CHANGELOG, "0.16.44")).toBe(
      "First paragraph of 0.16.44.\n\nSecond paragraph of 0.16.44.",
    );
  });

  test("reads a middle section and the last section to the end of the file", () => {
    expect(releaseNotes(CHANGELOG, "0.16.43")).toBe("Only paragraph of 0.16.43.");
    expect(releaseNotes(CHANGELOG, "0.16.4")).toBe("Old one.");
  });

  test("matches the heading exactly, so 0.16.4 never reads 0.16.44's section", () => {
    expect(releaseNotes(CHANGELOG, "0.16.4")).not.toContain("0.16.44");
  });

  test("accepts CRLF line endings", () => {
    expect(releaseNotes(CHANGELOG.replace(/\n/g, "\r\n"), "0.16.44")).toBe(
      "First paragraph of 0.16.44.\n\nSecond paragraph of 0.16.44.",
    );
  });

  test("refuses a version with no section", () => {
    expect(() => releaseNotes(CHANGELOG, "0.16.45")).toThrow('no "## 0.16.45" section');
  });

  test("refuses an empty section", () => {
    expect(() => releaseNotes("## 0.16.45\n\n## 0.16.44\n\nx\n", "0.16.45")).toThrow("is empty");
  });

  test("the shipped CHANGELOG has notes for the package's own version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(releaseNotes(read("CHANGELOG.md"), pkg.version).length).toBeGreaterThan(0);
  });
});

describe("tags and versions", () => {
  test("versionOfTag reads a release tag and refuses anything else", () => {
    expect(versionOfTag("skills-bundle-v0.16.44")).toBe("0.16.44");
    expect(() => versionOfTag("v0.16.44")).toThrow("not a release tag");
    expect(() => versionOfTag("skills-bundle-v0.16")).toThrow("not a release tag");
    expect(() => versionOfTag("skills-bundle-v0.16.44; rm -rf /")).toThrow("not a release tag");
  });

  test("compareVersions orders numerically, not as text", () => {
    expect(compareVersions("0.16.44", "0.16.5")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.16.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("highestVersion picks the newest release tag and ignores other tags", () => {
    expect(
      highestVersion(["skills-bundle-v0.16.4", "skills-bundle-v0.16.44", "skills-bundle-v0.16.5", "v9.9.9"]),
    ).toBe("0.16.44");
    expect(highestVersion(["v1.0.0"])).toBeUndefined();
  });

  test("the title names the product and version the way the SDK's Releases do", () => {
    expect(releaseTitle("0.16.44")).toBe("Catalyst CLI 0.16.44");
  });
});

describe("the workflows", () => {
  const publish = read(".github", "workflows", "publish.yml");
  const backfill = read(".github", "workflows", "github-release.yml");
  const releaseJob = publish.slice(publish.indexOf("\n  github-release:"));
  const publishJob = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  github-release:"));

  test("publish.yml creates the Release in its own job, after the npm publish, on a tag push", () => {
    expect(releaseJob).toMatch(/needs: publish/);
    expect(releaseJob).toMatch(/if: github\.event_name == 'push'/);
    expect(releaseJob).toContain('node scripts/github-release.mjs "$GITHUB_REF_NAME"');
  });

  test("only the Release job can write to the repository", () => {
    expect(publish).toMatch(/^permissions:\n  contents: read$/m);
    expect(publishJob).not.toContain("contents: write");
    expect(releaseJob).toContain("contents: write");
    expect(releaseJob).not.toMatch(/bun install|npm publish|NPM_PUBLISH_TOKEN/);
  });

  test("the backfill only creates Releases, rehearses by default, and passes tags through env", () => {
    expect(backfill).toContain("node scripts/github-release.mjs");
    expect(backfill).not.toMatch(/npm publish|NPM_PUBLISH_TOKEN|bun install/);
    expect(backfill).toMatch(/dry_run:[\s\S]*?default: true/);
    expect(backfill).toContain("TAGS: ${{ inputs.tags }}");
    expect(backfill).not.toMatch(/run:[^\n]*\$\{\{ inputs\./);
  });
});
