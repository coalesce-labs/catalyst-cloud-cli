#!/usr/bin/env node
// github-release.mjs — CTC-9044: every CLI release gets a GitHub Release, as the SDK's and
// catalyst-cloud's do. The notes are that version's CHANGELOG.md section, read from the tagged
// commit, so a backfill of an older tag shows what that release said and not what main says now.
// publish.yml runs this for the tag it just published; github-release.yml runs it by hand for
// tags that shipped before this existed. A tag that already has a Release is left as it is, so a
// re-run finishes a release instead of failing on it.
import { execFileSync } from "node:child_process";

const HELP = `Usage: node scripts/github-release.mjs <skills-bundle-vX.Y.Z>... [--dry-run]

Creates the GitHub Release for each tag, titled "Catalyst CLI X.Y.Z", with that version's
CHANGELOG.md section from the tagged commit as its notes. Skips a tag that already has a Release.
Only the highest skills-bundle-v* tag is marked latest. Needs gh with contents: write.

Options:
  --dry-run  print what would be created; create nothing
  --help     this text`;

export const TAG_PREFIX = "skills-bundle-v";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function versionOfTag(tag) {
  if (!tag.startsWith(TAG_PREFIX)) throw new Error(`not a release tag: ${tag}`);
  const version = tag.slice(TAG_PREFIX.length);
  if (!SEMVER.test(version)) throw new Error(`not a release tag: ${tag}`);
  return version;
}

function parts(version) {
  return SEMVER.exec(version).slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The highest version among the repository's release tags; names that are not release tags are ignored.
export function highestVersion(tags) {
  let best;
  for (const tag of tags) {
    let version;
    try {
      version = versionOfTag(tag);
    } catch {
      continue;
    }
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

// The body under `## <version>` up to the next `## ` heading, trimmed. A version with no section,
// or an empty one, is an error: a Release with no notes is the gap this script exists to close.
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
  return body;
}

export function releaseTitle(version) {
  return `Catalyst CLI ${version}`;
}

function run(cmd, args, input) {
  return execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
}

function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag, "--json", "tagName"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function remoteTags() {
  return run("git", ["ls-remote", "--tags", "--refs", "origin", `${TAG_PREFIX}*`])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].replace("refs/tags/", ""));
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  const tags = argv.filter((a) => a !== "--dry-run");
  const flag = tags.find((a) => a.startsWith("-"));
  if (flag !== undefined || tags.length === 0) {
    console.error(flag ? `unexpected argument: ${flag} (see --help)` : "name at least one tag (see --help)");
    return 1;
  }
  const versions = tags.map(versionOfTag);
  const highest = highestVersion([...remoteTags(), ...tags]);
  for (const [i, tag] of tags.entries()) {
    const version = versions[i];
    if (releaseExists(tag)) {
      console.log(`${tag}: a GitHub Release already exists; leaving it`);
      continue;
    }
    const notes = releaseNotes(run("git", ["show", `refs/tags/${tag}:CHANGELOG.md`]), version);
    const latest = version === highest;
    const args = ["release", "create", tag, "--verify-tag", "--title", releaseTitle(version), "--notes-file", "-", `--latest=${latest}`];
    if (dryRun) {
      console.log(`${tag}: would create "${releaseTitle(version)}" (latest=${latest}) with notes:\n${notes}\n`);
      continue;
    }
    run("gh", args, notes);
    console.log(`${tag}: created "${releaseTitle(version)}" (latest=${latest})`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
