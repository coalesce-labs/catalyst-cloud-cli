// node-support-matrix.test.ts — CTC-2158, Phase 4. No network: the fixture below is a real, recorded
// snapshot of https://raw.githubusercontent.com/nodejs/Release/main/schedule.json's v22/v24/v26
// entries, read live on 2026-09-17 (research §"The matrix can be derived from engines.node").
import { describe, expect, test } from "vitest";
import { classify, deriveMatrix, formatForGithub, parseMajor } from "../scripts/node-support-matrix.mjs";

const SCHEDULE = {
  v18: { start: "2022-04-19", lts: "2022-10-18", maintenance: "2023-10-18", end: "2025-04-30" },
  v20: { start: "2023-04-18", lts: "2023-10-24", maintenance: "2024-10-22", end: "2026-04-30" },
  v22: { start: "2024-04-24", lts: "2024-10-29", maintenance: "2025-10-21", end: "2027-04-30" },
  v24: { start: "2025-05-06", lts: "2025-10-28", maintenance: "2026-10-20", end: "2028-04-30" },
  v26: { start: "2026-05-05", lts: "2026-10-28", maintenance: "2027-10-20", end: "2029-04-30" },
};
const NOW = "2026-09-17";

describe("parseMajor", () => {
  test("reads the major out of the one range form this package declares", () => {
    expect(parseMajor(">=22.15")).toBe(22);
    expect(parseMajor(">=24")).toBe(24);
  });
  test("throws naming engines.node on an unparseable range", () => {
    expect(() => parseMajor("^22 || >=24")).toThrow(/engines\.node/);
  });
});

describe("classify", () => {
  test("matches the real, recorded phase for each major on 2026-09-17", () => {
    expect(classify(SCHEDULE.v22, NOW)).toBe("maintenance");
    expect(classify(SCHEDULE.v24, NOW)).toBe("active-lts");
    expect(classify(SCHEDULE.v26, NOW)).toBe("current");
  });
  test("a major past its end date is eol", () => {
    expect(classify(SCHEDULE.v18, NOW)).toBe("eol");
  });
});

describe("deriveMatrix", () => {
  test("derives the matrix from engines.node, newest last, non-EOL only", () => {
    expect(deriveMatrix({ engines: ">=22.15", schedule: SCHEDULE, now: NOW }).majors).toEqual(["22", "24", "26"]);
  });

  test("raising the engines floor shrinks the matrix with no other edit", () => {
    expect(deriveMatrix({ engines: ">=24", schedule: SCHEDULE, now: NOW }).majors).toEqual(["24", "26"]);
  });

  test("an EOL major is never in the matrix even if engines still admits it", () => {
    expect(deriveMatrix({ engines: ">=18", schedule: SCHEDULE, now: NOW }).majors).not.toContain("18");
  });

  // Ryan, 2026-09-17T20:38Z: "Node support: current plus active LTS, matrix derived from engines."
  // Encoded as an ASSERTION, not as a hand-written array — so the policy is enforced, not transcribed.
  test("engines that excludes the Current or Active-LTS major is a hard failure naming the major", () => {
    expect(() => deriveMatrix({ engines: ">=27", schedule: SCHEDULE, now: NOW })).toThrow(/26.*current|24.*active/i);
  });

  test("an unparseable engines range throws naming engines.node rather than guessing", () => {
    expect(() => deriveMatrix({ engines: "^22 || >=24", schedule: SCHEDULE, now: NOW })).toThrow(/engines\.node/);
  });

  test("a schedule fetch failure degrades to the floor major and reports the degradation", () => {
    const r = deriveMatrix({ engines: ">=22.15", schedule: null, now: NOW });
    expect(r.majors).toEqual(["22"]);
    expect(r.degraded).toBe(true);
    expect(r.warning).toMatch(/schedule/);
  });
});

// CTC-8223: an ordinary pull request checks the Active LTS major only; main and the merge queue
// keep the whole matrix.
describe("the pull request major", () => {
  test("is the Active LTS major, read from the same schedule", () => {
    expect(deriveMatrix({ engines: ">=22.15", schedule: SCHEDULE, now: NOW }).pullRequest).toEqual(["24"]);
  });

  test("moves to the next major the day it enters Active LTS, with no edit", () => {
    const later = deriveMatrix({ engines: ">=22.15", schedule: SCHEDULE, now: "2026-10-28" });
    expect(later.majors).toEqual(["22", "24", "26"]);
    expect(later.pullRequest).toEqual(["26"]);
  });

  test("is the newest supported major when no supported major is in Active LTS", () => {
    const currentOnly = { v26: SCHEDULE.v26 };
    expect(deriveMatrix({ engines: ">=26", schedule: currentOnly, now: NOW }).pullRequest).toEqual(["26"]);
  });

  test("is the engines floor when the schedule cannot be read", () => {
    expect(deriveMatrix({ engines: ">=22.15", schedule: null, now: NOW }).pullRequest).toEqual(["22"]);
  });
});

test("the emitted value is a GitHub-matrix-shaped JSON array on one line", () => {
  expect(formatForGithub(["22", "24", "26"])).toBe('["22","24","26"]');
});
