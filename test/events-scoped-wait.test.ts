// CTC-6650 — `events wait-for` with scope keys runs on the SDK's wait under the CLI's exit codes.
import { beforeEach, describe, expect, test } from "vitest";
import type { CachedEventWaitOptions, EventWaitOptions, EventWaitResult, WaitedEvent } from "@catalyst-cloud/sdk/events";
import { main } from "../src/cli";
import { readManifest, writeConfig, type CustomerConfig } from "../src/config";
import type { EventsSdk } from "../src/events";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

let home: string;
let ctx: TestCtx;
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
  const config: CustomerConfig = { baseUrl: "https://cloud.example/", key: "ctc_user_self", account: "workspace-1", slug: "acme", name: "Acme", permissions: ["mirror:read"], principal: "service", user: { id: "self", label: "Self", email: null, role: "member", linearUserId: null }, joinedAt: "2026-10-23T00:00:00Z", lastSkillBundleVersion: readManifest().version };
  writeConfig(home, config);
});

const conflict: WaitedEvent = {
  tenantId: "workspace-1",
  sequence: 9002,
  eventId: "conflict-9002",
  type: "pr.conflict.detected",
  schemaVersion: 1,
  recordedAt: "2026-10-23T09:00:00.000Z",
  payload: { repo: "acme/web", branch: "feature/checkout", pr: 9001, paths: ["src/a.ts"] },
};

function fakeSdk(
  wait: (options: EventWaitOptions) => Promise<EventWaitResult>,
  cached: (options: CachedEventWaitOptions) => Promise<EventWaitResult> = async () => ({ outcome: "timeout", cursor: null, waitedMs: 0 }),
) {
  const calls: { cloud: EventWaitOptions[]; cache: CachedEventWaitOptions[]; tailed: number } = { cloud: [], cache: [], tailed: 0 };
  const sdk: EventsSdk = {
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${home}/events`,
    readCachedEvents: async () => [],
    async *tailCachedEvents() {
      calls.tailed += 1;
      yield* [];
    },
    waitForEvents: (options) => {
      calls.cloud.push(options);
      return wait(options);
    },
    waitForCachedEvents: (options) => {
      calls.cache.push(options);
      return cached(options);
    },
  };
  return { sdk, calls };
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("events wait-for with scope keys", () => {
  test("a branch wait sends the scope filter to the SDK and prints each matched event", async () => {
    const f = fakeSdk(async () => ({ outcome: "matched", events: [conflict], cursor: 9002 }));
    const code = await main(["events", "wait-for", "--type", "pr.conflict.detected", "--ref", "acme/web:feature/checkout", "--timeout", "14400"], ctx, { events: { loadSdk: async () => f.sdk } });
    expect(code).toBe(0);
    expect(ctx.out.map((line) => JSON.parse(line))).toEqual([conflict]);
    expect(f.calls.cloud).toHaveLength(1);
    expect(f.calls.cloud[0]).toMatchObject({
      baseUrl: "https://cloud.example",
      tenantId: "workspace-1",
      auth: { kind: "token", token: "ctc_user_self" },
      filter: { ref: ["acme/web:feature/checkout"], type: "pr.conflict.detected" },
      timeoutMs: 14_400_000,
    });
    expect(f.calls.cache).toHaveLength(0);
  });

  test("a type family, a repeated key and --to me each select the SDK wait", async () => {
    const f = fakeSdk(async () => ({ outcome: "matched", events: [conflict], cursor: 9002 }));
    expect(await main(["events", "wait-for", "--type", "pr.*", "--after", "9000"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(0);
    expect(await main(["events", "wait-for", "--pr", "acme/web#9001", "--pr", "acme/web#9002", "--ticket", "CTC-1234"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(0);
    expect(await main(["events", "wait-for", "--to", "me", "--session", "CTC-1234/implement#7"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(0);
    expect(f.calls.cloud.map((call) => [call.filter, call.after])).toEqual([
      [{ type: "pr.*" }, 9000],
      [{ pr: ["acme/web#9001", "acme/web#9002"], ticket: "CTC-1234" }, undefined],
      [{ session: ["CTC-1234/implement#7"], to: "me" }, undefined],
    ]);
  });

  test("a timeout exits 1 and names the cursor the next wait resumes from", async () => {
    const f = fakeSdk(async () => ({ outcome: "timeout", cursor: 7000, waitedMs: 60_000 }));
    expect(await main(["events", "wait-for", "--repo", "acme/web", "--timeout", "60"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
    expect(ctx.out).toEqual([]);
    expect(ctx.err.join("\n")).toContain("no matching event within 60 s; resume with --after 7000");
  });

  test("a refusal exits 2 with the server's reason naming the refused value", async () => {
    const f = fakeSdk(async () => ({ outcome: "refused", source: "cloud", status: 403, key: "ticket", value: "OPS-77", reason: "ticket OPS-77 is outside your teams", filter: { ticket: "OPS-77" } }));
    expect(await main(["events", "wait-for", "--repo", "acme/web", "--ticket", "OPS-77"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(2);
    expect(ctx.err.join("\n")).toContain("the cloud refused the wait (403) on --ticket OPS-77: ticket OPS-77 is outside your teams");
  });

  test("five failed requests in a row end the wait as an outage, exit 4, the same as the original path", async () => {
    ctx = makeCtx(home, { fetch: async () => { throw new TypeError("fetch failed"); } });
    const f = fakeSdk(async (options) => {
      for (let attempt = 0; attempt < 5 && !options.signal?.aborted; attempt++) await options.fetch?.("https://cloud.example/api/v1/events/query").catch(() => undefined);
      await untilAborted(options.signal);
      return { outcome: "aborted", cursor: 7000 };
    });
    expect(await main(["events", "wait-for", "--repo", "acme/web"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(4);
    expect(ctx.err.join("\n")).toContain("unreachable for 5 attempts");
    expect(ctx.err.join("\n")).toContain("this is an outage, not a timeout");
  });

  test("a 5xx counts toward the outage and any other answer resets the count", async () => {
    const statuses = [503, 503, 503, 503, 200, 503, 503, 503, 503];
    ctx = makeCtx(home, { fetch: async () => new Response(null, { status: statuses.shift() ?? 200 }) });
    const f = fakeSdk(async (options) => {
      for (let attempt = 0; attempt < 9; attempt++) await options.fetch?.("https://cloud.example/api/v1/events/query");
      return options.signal?.aborted ? { outcome: "aborted", cursor: null } : { outcome: "timeout", cursor: null, waitedMs: 1 };
    });
    expect(await main(["events", "wait-for", "--repo", "acme/web"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
  });

  test("an interrupt exits 130", async () => {
    let interrupt: (() => void) | undefined;
    const f = fakeSdk(async (options) => {
      interrupt?.();
      await untilAborted(options.signal);
      return { outcome: "aborted", cursor: null };
    });
    expect(await main(["events", "wait-for", "--repo", "acme/web"], ctx, { events: { loadSdk: async () => f.sdk, onInterrupt: (handler) => { interrupt = handler; return () => undefined; } } })).toBe(130);
  });

  test("--from-cache waits on the local cache, and a missing cache exits 3 with the start command", async () => {
    const f = fakeSdk(async () => ({ outcome: "matched", events: [conflict], cursor: 9002 }), async () => ({ outcome: "failed", code: "cache-missing", reason: "no event cache", cursor: null }));
    expect(await main(["events", "wait-for", "--from-cache", "--pr", "acme/web#9001"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(3);
    expect(f.calls.cloud).toHaveLength(0);
    expect(f.calls.cache[0]).toMatchObject({ tenantId: "workspace-1", directory: `${home}/events`, filter: { pr: ["acme/web#9001"] } });
    expect(ctx.err.join("\n")).toContain("catalyst replica start --detach");
  });

  test("a history gap exits 2 and names where to resume", async () => {
    const f = fakeSdk(async () => ({ outcome: "failed", code: "history-gap", reason: "retained history starts at 5501", cursor: 5000, resumeFrom: 5500 }));
    expect(await main(["events", "wait-for", "--repo", "acme/web", "--after", "5000"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(2);
    expect(ctx.err.join("\n")).toContain("the wait failed (history-gap): retained history starts at 5501; resume with --after 5500");
  });

  test("scope keys are refused outside wait-for, and --to takes only me", async () => {
    const f = fakeSdk(async () => ({ outcome: "timeout", cursor: null, waitedMs: 0 }));
    expect(await main(["events", "tail", "--repo", "acme/web"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
    expect(await main(["events", "wait-for", "--to", "someone"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
    expect(await main(["events", "wait-for", "--repo", "acme/web", "--directory", "/tmp/x"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
    expect(f.calls.cloud).toHaveLength(0);
  });

  test("an exact type with a ticket keeps the original path", async () => {
    const f = fakeSdk(async () => ({ outcome: "timeout", cursor: null, waitedMs: 0 }));
    expect(await main(["events", "wait-for", "--from-cache", "--type", "relay.phase.completed", "--ticket", "CTC-1", "--timeout", "0"], ctx, { events: { loadSdk: async () => f.sdk } })).toBe(1);
    expect(f.calls.cloud).toHaveLength(0);
    expect(f.calls.cache).toHaveLength(0);
    expect(f.calls.tailed).toBe(1);
  });
});
