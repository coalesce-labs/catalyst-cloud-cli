#!/usr/bin/env node
// node-support-matrix.mjs — CTC-2158. Derives the CI Node matrix from package.json's `engines.node`
// intersected with the live Node release schedule, so the matrix can never drift from the declared
// range. Ryan (product owner), 2026-09-17T20:38Z: "Node support: current plus active LTS, matrix
// derived from `engines`." Encoded here as an ASSERTION (a `current`/`active-lts` major excluded by
// `engines.node` is a hard failure naming the major), not as a hand-written array — the shape the
// sibling CTC-2483 plan used (`node: ["22", "24", "26"]`) is explicitly what this decision replaces.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

/** Parse the major out of the one range form this package declares (">=X" or ">=X.Y[.Z]"). Throws
 *  naming engines.node rather than guessing at an unparseable range. */
export function parseMajor(range) {
  const m = /^>=\s*(\d+)/.exec(String(range).trim());
  if (!m) throw new Error(`engines.node is "${range}", which this script's parser does not understand (it only reads ">=X" or ">=X.Y.Z")`);
  return Number(m[1]);
}

/** Classify one schedule entry (`{start, lts?, maintenance?, end}`) at `now`. Odd majors (no `lts`
 *  field) go straight from "current" to "eol" at `end`; even majors pass through "active-lts" and
 *  "maintenance" first. */
export function classify(entry, now) {
  const t = Date.parse(now);
  if (entry.end && t >= Date.parse(entry.end)) return "eol";
  if (entry.maintenance && t >= Date.parse(entry.maintenance)) return "maintenance";
  if (entry.lts && t >= Date.parse(entry.lts)) return "active-lts";
  if (entry.start && t >= Date.parse(entry.start)) return "current";
  return "unreleased";
}

/**
 * Derive { majors, pullRequest, degraded?, warning? } from `engines.node`, the live schedule, and
 * `now`. `schedule` is the parsed `nodejs/Release` schedule.json body, or `null` on a fetch failure —
 * a null schedule degrades LOUDLY to the `engines` floor major alone rather than failing every PR.
 *
 * CTC-8223: `pullRequest` is the one major an ordinary pull request checks: the Active LTS major in
 * `majors`, or the newest one when none is in Active LTS. Main and the merge queue still check all
 * of `majors`, so a break on another supported major is caught before it merges.
 */
export function deriveMatrix({ engines, schedule, now }) {
  const floorMajor = parseMajor(engines);
  if (!schedule) {
    return {
      majors: [String(floorMajor)],
      pullRequest: [String(floorMajor)],
      degraded: true,
      warning: `could not fetch the Node release schedule (${SCHEDULE_URL}); falling back to the engines.node floor (${floorMajor}) alone`,
    };
  }

  const classified = {};
  for (const [key, entry] of Object.entries(schedule)) {
    const m = /^v(\d+)$/.exec(key);
    if (!m) continue;
    classified[Number(m[1])] = classify(entry, now);
  }

  for (const [majorStr, status] of Object.entries(classified)) {
    const major = Number(majorStr);
    if ((status === "current" || status === "active-lts") && major < floorMajor) {
      throw new Error(`engines.node (${engines}) excludes Node ${major}, which is currently ${status} — the recorded policy is "current plus active LTS, matrix derived from engines"`);
    }
  }

  const majors = Object.entries(classified)
    .filter(([majorStr, status]) => Number(majorStr) >= floorMajor && status !== "eol" && status !== "unreleased")
    .map(([majorStr]) => Number(majorStr))
    .sort((a, b) => a - b)
    .map(String);

  const activeLts = majors.filter((major) => classified[Number(major)] === "active-lts");
  const pullRequest = [activeLts[activeLts.length - 1] ?? majors[majors.length - 1]].filter(
    (major) => major !== undefined,
  );

  return { majors, pullRequest };
}

export function formatForGithub(majors) {
  return JSON.stringify(majors);
}

async function fetchScheduleLive() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(SCHEDULE_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 1) return null;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const engines = pkg.engines?.node;
  if (!engines) {
    console.error("node-support-matrix: package.json is missing engines.node");
    process.exit(1);
  }
  const schedule = await fetchScheduleLive();
  const now = new Date().toISOString().slice(0, 10);
  let result;
  try {
    result = deriveMatrix({ engines, schedule, now });
  } catch (err) {
    console.error(`::error title=Node support matrix::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (result.degraded) {
    console.error(`::warning title=Node support matrix degraded::${result.warning}`);
  }
  if (args.includes("--explain")) {
    console.error(`engines.node: ${engines}`);
    console.error(`majors: ${result.majors.join(", ")}`);
    console.error(`pull request: ${result.pullRequest.join(", ")}`);
    process.exit(0);
  }
  console.log(formatForGithub(args.includes("--pull-request") ? result.pullRequest : result.majors));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
