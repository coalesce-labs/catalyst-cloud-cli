// flow.test.ts — CTC-6368. `catalyst flow`: a repository's open pull request counts over time,
// one row per Flow bucket, through the typed SDK's `client.flow.series()` with an injected
// fake client (the identity/connections pattern; no HTTP anywhere in this file).
import { beforeEach, describe, expect, test } from "vitest";
import type {
  FlowSeries,
  FlowSeriesColumn,
  FlowSeriesParams,
  FlowSeriesResult,
  TenantClient,
} from "@catalyst-cloud/sdk";
import { main, usageText } from "../src/cli";
import { readManifest, writeConfig, type CustomerConfig } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let ctx: TestCtx;
let config: CustomerConfig;
beforeEach(() => {
  const home = tempHome();
  ctx = makeCtx(home);
  config = {
    baseUrl: "https://cloud.example",
    key: "ctc_user_self",
    account: "tenant",
    slug: "tenant",
    name: "Tenant",
    permissions: ["mirror:read"],
    principal: "service",
    user: { id: "self", label: "Self", email: null, role: "member", linearUserId: null },
    joinedAt: "2026-09-25T00:00:00Z",
    lastSkillBundleVersion: readManifest().version,
  };
  writeConfig(home, config);
});

function column(startMs: number, endMs: number, open: number | null, partial = false): FlowSeriesColumn {
  return {
    startMs,
    endMs,
    label: "L",
    partial,
    ticket: null,
    pr: open === null
      ? null
      : { open, opened: 1, merged: 0, closedUnmerged: 0, net: 0, cycleSeconds: [] },
  };
}

function series(columns: readonly FlowSeriesColumn[], boundary: unknown = { kind: "iana", timeZone: "America/Chicago" }): FlowSeries {
  return {
    project: { id: "p1", name: "Catalyst Cloud", repo: "coalesce-labs/catalyst-cloud" },
    period: "2w",
    generatedAt: Date.UTC(2026, 9, 25, 17, 30),
    columns,
    boundary,
  };
}

function fake(answer: FlowSeriesResult) {
  const calls: FlowSeriesParams[] = [];
  const client: Pick<TenantClient, "flow"> = {
    flow: {
      series: async (params) => {
        calls.push(params);
        return answer;
      },
    },
  };
  return { calls, client };
}

// 2026-10-12 00:00 America/Chicago (CDT, UTC-5)
const CHICAGO_MIDNIGHT = Date.UTC(2026, 9, 12, 5);
const daily = series(Array.from({ length: 14 }, (_, i) =>
  column(CHICAGO_MIDNIGHT + i * DAY, CHICAGO_MIDNIGHT + (i + 1) * DAY - (i === 13 ? 12 * HOUR : 0), 20 + i, i === 13)));
const hourlyStart = Date.UTC(2026, 9, 24, 13);
const hourly = series(Array.from({ length: 24 }, (_, i) =>
  column(hourlyStart + i * HOUR, hourlyStart + (i + 1) * HOUR - (i === 23 ? 30 * 60_000 : 0), 30 + (i % 3), i === 23)));

describe("flow with --repo", () => {
  test("prints 14 daily rows, each a date and an open count", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud", "--period", "2w", "--granularity", "day"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(f.calls).toEqual([{ repo: "coalesce-labs/catalyst-cloud", period: "2w", granularity: "day" }]);
    expect(ctx.out).toHaveLength(14);
    expect(ctx.out[0]).toBe("2026-10-12  20");
    expect(ctx.out[13]).toBe("2026-10-25  33  (now)");
  });

  test("prints 24 hourly points as one JSON array of the SDK's columns", async () => {
    const f = fake({ outcome: "ok", status: 200, series: hourly });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud", "--period", "24h", "--granularity", "hour", "--json"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual(hourly.columns); // 24 entries, unchanged
  });

  test("prints 24 hourly rows, each a local time with its UTC offset and an open count", async () => {
    const f = fake({ outcome: "ok", status: 200, series: hourly });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud", "--period", "24h", "--granularity", "hour"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out).toHaveLength(24);
    expect(ctx.out[0]).toBe("2026-10-24T08:00-05:00  30");
    expect(ctx.out[23]).toBe("2026-10-25T07:00-05:00  32  (now)");
  });

  test("daily rows across the US DST change keep local calendar dates", async () => {
    const dst = series([
      column(Date.UTC(2026, 9, 31, 5), Date.UTC(2026, 10, 1, 5), 21),
      column(Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 2, 6), 22),
      column(Date.UTC(2026, 10, 2, 6), Date.UTC(2026, 10, 3, 6), 23),
    ]);
    const f = fake({ outcome: "ok", status: 200, series: dst });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out).toEqual(["2026-10-31  21", "2026-11-01  22", "2026-11-02  23"]);
  });

  test("two-hour buckets print local times, and the call leaves granularity unset", async () => {
    const twoHour = series(Array.from({ length: 12 }, (_, i) =>
      column(hourlyStart + i * 2 * HOUR, hourlyStart + (i + 1) * 2 * HOUR, 25)));
    const f = fake({ outcome: "ok", status: 200, series: twoHour });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud", "--period", "2d"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out[0]).toBe("2026-10-24T08:00-05:00  25");
    expect(ctx.out[1]).toBe("2026-10-24T10:00-05:00  25");
    expect(f.calls).toEqual([{ repo: "coalesce-labs/catalyst-cloud", period: "2d", granularity: undefined }]);
  });

  test("with period and granularity both left out, the call carries neither", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(f.calls).toEqual([{ repo: "coalesce-labs/catalyst-cloud", period: undefined, granularity: undefined }]);
  });

  test("a mistyped granularity exits 1 with the verb's help, before any read", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow", "--period", "26w", "--granularity", "minute", "--repo", "x/y"], ctx, { flow: { createClient: () => f.client } })).toBe(1);
    expect(ctx.err[0]).toBe('--granularity must be hour or day (got "minute")');
    expect(ctx.err[1]).toContain("Usage: catalyst flow");
    expect(f.calls).toEqual([]);
  });

  test("a mistyped period or --repo, or a positional, exits 1 before any read", async () => {
    for (const argv of [["flow", "--period", "5w", "--repo", "a/b"], ["flow", "--repo", "nope"], ["flow", "acme/app"]]) {
      const here = makeCtx(tempHome());
      const f = fake({ outcome: "ok", status: 200, series: daily });
      expect(await main(argv, here, { flow: { createClient: () => f.client } })).toBe(1);
      expect(f.calls).toEqual([]);
    }
    const period = makeCtx(tempHome());
    await main(["flow", "--period", "5w", "--repo", "a/b"], period);
    expect(period.err[0]).toBe('--period must be one of 24h, 2d, 3d, 1w, 2w, 4w, 12w, 26w (got "5w")');
    const repo = makeCtx(tempHome());
    await main(["flow", "--repo", "widgets"], repo);
    expect(repo.err[0]).toBe('--repo must be owner/name (got "widgets")');
  });

  test("a refused read exits 2 with the cloud's reason and prints nothing on stdout", async () => {
    const f = fake({ outcome: "rejected", status: 400, reason: "flow-series-too-large: use daily buckets or a shorter period" });
    expect(await main(["flow", "--repo", "x/y", "--period", "26w", "--granularity", "hour", "--json"], ctx, { flow: { createClient: () => f.client } })).toBe(2);
    expect(ctx.out).toEqual([]);
    expect(ctx.err).toEqual(["catalyst: flow for x/y: flow-series-too-large: use daily buckets or a shorter period"]);
  });

  test("a network failure and an unauthorized failure each exit 2 with their reason", async () => {
    const net = fake({ outcome: "network", reason: "fetch failed" });
    expect(await main(["flow", "--repo", "x/y"], ctx, { flow: { createClient: () => net.client } })).toBe(2);
    expect(ctx.err.at(-1)).toBe("catalyst: flow for x/y: fetch failed");
    const unauth = fake({ outcome: "unauthorized", status: 401, reason: "credential not accepted", ref: null });
    expect(await main(["flow", "--repo", "x/y"], ctx, { flow: { createClient: () => unauth.client } })).toBe(2);
    expect(ctx.err.at(-1)).toBe("catalyst: flow for x/y: credential not accepted");
  });

  test("a bucket the workspace cannot attribute reads unavailable", async () => {
    const none = series([
      column(CHICAGO_MIDNIGHT, CHICAGO_MIDNIGHT + DAY, null),
      column(CHICAGO_MIDNIGHT + DAY, CHICAGO_MIDNIGHT + 2 * DAY, null, true),
    ]);
    const f = fake({ outcome: "ok", status: 200, series: none });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud"], ctx, { flow: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out).toEqual(["2026-10-12  unavailable", "2026-10-13  unavailable  (now)"]);
  });

  test("a fixed-offset boundary formats in its offset; a null or unknown-zone boundary falls back to UTC", async () => {
    const run = async (answer: FlowSeriesResult): Promise<string[]> => {
      const here = makeCtx(tempHome());
      writeConfig(here.home, config);
      const f = fake(answer);
      expect(await main(["flow", "--repo", "a/b"], here, { flow: { createClient: () => f.client } })).toBe(0);
      return here.out;
    };
    const fixed = series([column(Date.UTC(2026, 9, 11, 18, 30), Date.UTC(2026, 9, 12, 18, 30), 12)], { kind: "fixed-offset", offsetMinutes: 330 });
    expect(await run({ outcome: "ok", status: 200, series: fixed })).toEqual(["2026-10-12  12"]);

    const noBoundary = series([column(Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 13), 13)], null);
    expect(await run({ outcome: "ok", status: 200, series: noBoundary })).toEqual(["2026-10-12  13"]);

    const unknownZone = series([column(Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 13), 14)], { kind: "iana", timeZone: "Not/AZone" });
    expect(await run({ outcome: "ok", status: 200, series: unknownZone })).toEqual(["2026-10-12  14"]);
  });

  test("without a saved login the verb exits 2 and makes no read", async () => {
    const bare = makeCtx(tempHome());
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow", "--repo", "x/y"], bare, { flow: { createClient: () => f.client } })).toBe(2);
    expect(bare.err[0]).toContain("not connected yet");
    expect(f.calls).toEqual([]);
  });
});

describe("flow without --repo", () => {
  const connected = async () => [{ owner: "coalesce-labs", name: "catalyst-cloud" }];

  test("no --repo outside a checkout exits 2 and names --repo owner/name, before any read", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow"], ctx, { flow: { createClient: () => f.client, repoName: async () => null, repositories: connected } })).toBe(2);
    expect(ctx.err.join("\n")).toBe("catalyst: flow needs a repository: pass --repo owner/name (this directory is not a checkout with a GitHub origin)");
    expect(f.calls).toEqual([]);
  });

  test("a checkout of a repository outside the workspace exits 2 the same way", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow"], ctx, { flow: { createClient: () => f.client, repoName: async () => "acme/widgets", repositories: connected } })).toBe(2);
    expect(ctx.err.join("\n")).toBe("catalyst: flow needs a repository: pass --repo owner/name (this checkout's origin, acme/widgets, is not a repository of this workspace)");
    expect(f.calls).toEqual([]);
  });

  test("a connected checkout supplies the repository in the workspace's own case", async () => {
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow"], ctx, { flow: { createClient: () => f.client, repoName: async () => "coalesce-labs/catalyst-cloud", repositories: async () => [{ owner: "Coalesce-Labs", name: "Catalyst-Cloud" }] } })).toBe(0);
    expect(f.calls).toEqual([{ repo: "Coalesce-Labs/Catalyst-Cloud", period: undefined, granularity: undefined }]);
  });

  test("an explicit --repo never reads the checkout or the workspace contract", async () => {
    const reads: string[] = [];
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow", "--repo", "coalesce-labs/catalyst-cloud"], ctx, {
      flow: {
        createClient: () => f.client,
        repoName: async () => { reads.push("repoName"); return "acme/widgets"; },
        repositories: async () => { reads.push("repositories"); return []; },
      },
    })).toBe(0);
    expect(reads).toEqual([]);
  });

  test("the no-origin refusal never reads the workspace contract", async () => {
    const reads: string[] = [];
    const f = fake({ outcome: "ok", status: 200, series: daily });
    expect(await main(["flow"], ctx, {
      flow: {
        createClient: () => f.client,
        repoName: async () => null,
        repositories: async () => { reads.push("repositories"); return []; },
      },
    })).toBe(2);
    expect(reads).toEqual([]);
  });
});

describe("flow is discoverable", () => {
  test("the top-level usage lists flow", () => {
    expect(usageText()).toContain("catalyst flow [--repo <owner/name>]");
  });
});
