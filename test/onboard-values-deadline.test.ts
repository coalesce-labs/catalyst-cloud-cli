// The one-minute values wait includes sleep, readiness refresh and contract JSON.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { contractPathFor, writeConfig } from "../src/config.js";
import { onboardValuesAdapter, VALUES_WAIT_MS } from "../src/onboard-values.js";
import type { OnboardJournal } from "../src/onboard.js";
import { buildFixtureContract } from "./fixture-contract.js";
import { makeCtx } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "values-deadline-"));
  writeConfig(home, {
    baseUrl: "https://cloud.example.test", key: "ctc_user_synthetic",
    account: "tenant-3", slug: "fixture", name: "Fixture", permissions: null,
    principal: "session", joinedAt: "2026-10-04T00:00:00Z", lastSkillBundleVersion: "0.15.5",
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
const journal: OnboardJournal = {
  schema: 1, runId: "synthetic", installer: null, cli: "test", tenant: null,
  exit: null, operations: {}, changes: [],
  steps: [{ id: "linear.team", state: "done", evidence: { team: "team-eng" } }],
};
function verdict(state: "unknown" | "pass") {
  const doc = buildFixtureContract();
  doc.teams[0]!.readiness = {
    ...doc.teams[0]!.readiness,
    checkedAt: Date.now() - 1, expiresAt: Date.now() + 300_000,
    checks: [{ id: "required_values", state }],
  };
  return doc;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("values wait has one absolute deadline", () => {
  test("sleep ending at the deadline starts no new readiness or contract read", async () => {
    const calls: string[] = [];
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input) => {
      calls.push(String(input));
      return String(input).includes("/tenant/readiness")
        ? Response.json({}) : Response.json(verdict(calls.length === 2 ? "unknown" : "pass"));
    } });
    const result = await onboardValuesAdapter({ sleep: async () => {
      vi.setSystemTime(Date.now() + VALUES_WAIT_MS);
    } }).check(ctx, journal);
    expect(result).toMatchObject({ state: "waiting", reason: "required_values_unread" });
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["readiness", "contract-fetch", "contract-body"] as const)(
    "a stalled %s ends at the shared deadline, aborts the read and ignores late success",
    async (stage) => {
      const began = latch(), entered = latch(), held = latch();
      let readinessReads = 0, contractReads = 0;
      let activeSignal: AbortSignal | undefined;
      const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input, init) => {
        const readiness = String(input).includes("/tenant/readiness");
        const nth = readiness ? ++readinessReads : ++contractReads;
        if (nth > 1 && ((stage === "readiness" && readiness) ||
            (stage === "contract-fetch" && !readiness))) {
          activeSignal = init?.signal ?? undefined;
          entered.resolve();
          await held.promise; // Deliberately ignores abort to exercise the outer wait boundary.
        }
        if (readiness) return Response.json({});
        const response = Response.json(verdict(nth === 1 ? "unknown" : "pass"));
        if (nth > 1 && stage === "contract-body") {
          activeSignal = init?.signal ?? undefined;
          const original = response.json.bind(response);
          vi.spyOn(response, "json").mockImplementation(async () => {
            entered.resolve();
            await held.promise;
            return original();
          });
        }
        return response;
      } });
      const check = onboardValuesAdapter({ sleep, message: began.resolve }).check(ctx, journal);
      await began.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await entered.promise;
      const cachedBefore = readFileSync(contractPathFor(home), "utf8");
      await vi.advanceTimersByTimeAsync(VALUES_WAIT_MS - 10_000);
      expect(await check).toMatchObject({ state: "waiting", reason: "required_values_unread" });
      expect(activeSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      held.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(readFileSync(contractPathFor(home), "utf8")).toBe(cachedBefore);
    },
  );

  test("Ctrl-C ends an in-flight body at once and removes the caller listener", async () => {
    const stop = new AbortController(), began = latch(), entered = latch(), held = latch();
    const added = vi.spyOn(stop.signal, "addEventListener");
    const removed = vi.spyOn(stop.signal, "removeEventListener");
    let reads = 0, activeSignal: AbortSignal | undefined;
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input, init) => {
      if (String(input).includes("/tenant/readiness")) return Response.json({});
      const response = Response.json(verdict(++reads === 1 ? "unknown" : "pass"));
      if (reads > 1) {
        activeSignal = init?.signal ?? undefined;
        vi.spyOn(response, "json").mockImplementation(async () => { entered.resolve(); await held.promise; return verdict("pass"); });
      }
      return response;
    } });
    const check = onboardValuesAdapter({ sleep, message: began.resolve }).check(ctx, journal, stop.signal);
    await began.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await entered.promise;
    const cache = readFileSync(contractPathFor(home), "utf8");
    stop.abort();
    expect(await check).toEqual({ state: "waiting", reason: "interrupted" });
    expect(activeSignal?.aborted).toBe(true);
    expect(removed.mock.calls.some((call) => call[0] === "abort" &&
      added.mock.calls.some((add) => add[1] === call[1]))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(readFileSync(contractPathFor(home), "utf8")).toBe(cache);
  });

  test("a passing poll before the deadline completes and clears its timer", async () => {
    const began = latch();
    let reads = 0;
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input) =>
      String(input).includes("/tenant/readiness") ? Response.json({}) :
        Response.json(verdict(++reads === 1 ? "unknown" : "pass")),
    });
    const check = onboardValuesAdapter({ sleep, message: began.resolve }).check(ctx, journal);
    await began.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await check).toMatchObject({ state: "done" });
    expect(reads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("Ctrl-C during sleep starts no read and clears the deadline", async () => {
    const stop = new AbortController(), entered = latch();
    const calls: string[] = [];
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input) => {
      calls.push(String(input));
      return String(input).includes("/tenant/readiness")
        ? Response.json({}) : Response.json(verdict("unknown"));
    } });
    const check = onboardValuesAdapter({ sleep: () => {
      entered.resolve();
      return new Promise<void>(() => {});
    } }).check(ctx, journal, stop.signal);
    await entered.promise;
    stop.abort();
    expect(await check).toEqual({ state: "waiting", reason: "interrupted" });
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a throwing sleep still clears the timer and caller listener", async () => {
    const stop = new AbortController();
    const added = vi.spyOn(stop.signal, "addEventListener");
    const removed = vi.spyOn(stop.signal, "removeEventListener");
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input) =>
      String(input).includes("/tenant/readiness") ? Response.json({}) :
        Response.json(verdict("unknown")),
    });
    await expect(onboardValuesAdapter({ sleep: async () => {
      throw new Error("synthetic sleep failure");
    } }).check(ctx, journal, stop.signal)).rejects.toThrow("synthetic sleep failure");
    expect(removed.mock.calls.some((call) => call[0] === "abort" &&
      added.mock.calls.some((add) => add[1] === call[1]))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a failed refresh with a passing cached contract remains unverified", async () => {
    let reads = 0;
    const ctx = makeCtx(home, { now: () => new Date(), fetch: async (input) => {
      if (String(input).includes("/tenant/readiness")) return Response.json({});
      if (++reads > 1) throw new Error("synthetic network failure");
      return Response.json(verdict("pass"));
    } });
    expect(await onboardValuesAdapter().check(ctx, journal)).toMatchObject({ state: "done" });
    expect(await onboardValuesAdapter({ sleep }).check(ctx, journal)).toEqual({
      state: "waiting", reason: "required_values_unverified",
    });
  });
});
