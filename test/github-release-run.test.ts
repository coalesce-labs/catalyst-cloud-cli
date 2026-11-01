// github-release-run.test.ts — CTC-9044: runs scripts/github-release.mjs end to end against fake
// `gh` and `git` commands on PATH, to hold what the pure-function tests cannot: a tag that already
// has a Release is skipped, only the highest release tag is marked latest, a dry run creates
// nothing, the notes come from the tagged commit's CHANGELOG.md, and the tag must already exist.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "github-release.mjs");

const changelogAt = (version: string) =>
  `# Changelog\n\n## ${version}\n\nNotes as tagged for ${version}.\n\n## 0.16.1\n\nOlder.\n`;

interface Fake {
  dir: string;
  /** Each `gh release create` call: its arguments, then the notes it read on stdin. */
  creates: () => { args: string[]; notes: string }[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fake `git` answers the remote tag list and each tag's CHANGELOG.md; fake `gh` reports the tags in
 *  `existing` as having a Release and records every create. */
function fake(remoteTags: string[], existing: string[]): Fake {
  const dir = mkdtempSync(join(tmpdir(), "github-release-"));
  dirs.push(dir);
  for (const tag of remoteTags) {
    writeFileSync(join(dir, `changelog-${tag}`), changelogAt(tag.replace("skills-bundle-v", "")));
  }
  writeFileSync(join(dir, "remote-tags"), remoteTags.map((t) => `0000\trefs/tags/${t}\n`).join(""));
  writeFileSync(join(dir, "existing"), existing.map((t) => `${t}\n`).join(""));
  const git = `#!/bin/sh
d='${dir}'
if [ "$1" = ls-remote ]; then cat "$d/remote-tags"; exit 0; fi
if [ "$1" = show ]; then t="\${2#refs/tags/}"; t="\${t%%:CHANGELOG.md}"
  [ "$2" = "refs/tags/$t:CHANGELOG.md" ] && [ -f "$d/changelog-$t" ] && { cat "$d/changelog-$t"; exit 0; }
  echo "fatal: bad object $2" >&2; exit 128; fi
echo "unexpected git $*" >&2; exit 2
`;
  const gh = `#!/bin/sh
d='${dir}'
if [ "$1 $2" = "release view" ]; then grep -qx "$3" "$d/existing"; exit $?; fi
if [ "$1 $2" = "release create" ]; then n=$(ls "$d" | grep -c '\\.args$'); printf '%s\\n' "$@" > "$d/create-$n.args"; cat > "$d/create-$n.notes"; exit 0; fi
echo "unexpected gh $*" >&2; exit 2
`;
  writeFileSync(join(dir, "git"), git);
  writeFileSync(join(dir, "gh"), gh);
  chmodSync(join(dir, "git"), 0o755);
  chmodSync(join(dir, "gh"), 0o755);
  return {
    dir,
    creates: () => {
      const out: { args: string[]; notes: string }[] = [];
      for (let n = 0; existsSync(join(dir, `create-${n}.args`)); n++) {
        out.push({
          args: readFileSync(join(dir, `create-${n}.args`), "utf8").trim().split("\n"),
          notes: readFileSync(join(dir, `create-${n}.notes`), "utf8"),
        });
      }
      return out;
    },
  };
}

function runScript(f: Fake, args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${f.dir}:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const TAGS = ["skills-bundle-v0.16.42", "skills-bundle-v0.16.43", "skills-bundle-v0.16.44"];

describe("github-release.mjs run end to end", () => {
  test("creates each missing Release from its own tag's notes, marking only the highest tag latest", () => {
    const f = fake(TAGS, []);
    runScript(f, ["skills-bundle-v0.16.42", "skills-bundle-v0.16.44"]);
    const creates = f.creates();
    expect(creates.map((c) => c.args[2])).toEqual(["skills-bundle-v0.16.42", "skills-bundle-v0.16.44"]);
    expect(creates[0]!.args).toContain("--latest=false");
    expect(creates[1]!.args).toContain("--latest=true");
    expect(creates[0]!.args).toContain("--verify-tag");
    expect(creates[0]!.args).toEqual(expect.arrayContaining(["--title", "Catalyst CLI 0.16.42"]));
    expect(creates[0]!.notes).toBe("Notes as tagged for 0.16.42.");
    expect(creates[1]!.notes).toBe("Notes as tagged for 0.16.44.");
  });

  test("an older tag is not marked latest when a newer release tag exists only on the remote", () => {
    const f = fake(TAGS, []);
    runScript(f, ["skills-bundle-v0.16.43"]);
    expect(f.creates().map((c) => c.args)).toEqual([expect.arrayContaining(["--latest=false"])]);
  });

  test("leaves a tag that already has a Release alone and still creates the others", () => {
    const f = fake(TAGS, ["skills-bundle-v0.16.43"]);
    const out = runScript(f, ["skills-bundle-v0.16.43", "skills-bundle-v0.16.44"]);
    expect(out).toContain("skills-bundle-v0.16.43: a GitHub Release already exists");
    expect(f.creates().map((c) => c.args[2])).toEqual(["skills-bundle-v0.16.44"]);
  });

  test("a dry run prints the Release and its notes and creates nothing", () => {
    const f = fake(TAGS, []);
    const out = runScript(f, ["skills-bundle-v0.16.44", "--dry-run"]);
    expect(out).toContain('would create "Catalyst CLI 0.16.44" (latest=true)');
    expect(out).toContain("Notes as tagged for 0.16.44.");
    expect(f.creates()).toEqual([]);
  });

  test("refuses a name that is not a release tag before creating anything", () => {
    const f = fake(TAGS, []);
    expect(() => runScript(f, ["skills-bundle-v0.16.44", "v0.16.44"])).toThrow();
    expect(f.creates()).toEqual([]);
  });
});
