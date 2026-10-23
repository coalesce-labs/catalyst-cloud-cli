import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instrumentation = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => args[0] === "/fixed/docker"
      ? instrumentation.execFile(...args) : actual.execFile(...args),
  };
});
import { receiveDarwinThoughtsCommandForTest } from "../src/onboard-runner-custody.js";

interface CommandOptions {
  readonly timeout: number;
  readonly signal?: AbortSignal;
}
type Callback = (error: Error | null, stdout: string, stderr: string) => void;

describe("native installer command absolute receiving deadline", () => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const children: { kill: ReturnType<typeof vi.fn>; event: EventEmitter }[] = [];
  beforeEach(() => { instrumentation.execFile.mockReset(); });
  afterEach(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const child of children) child.event.removeAllListeners();
    children.length = 0;
  });
  function instrument(receives: boolean) {
    instrumentation.execFile.mockImplementation((_file: string, _args: string[], options: CommandOptions, callback: Callback) => {
      const child = new EventEmitter();
      const kill = vi.fn((_signal: string) => false);
      Object.assign(child, { pid: 424242, kill });
      children.push({ kill, event: child });
      if (receives) timers.add(setTimeout(() => callback(null, " known receipt ", ""), 10));
      else {
        // Exercise the actual timeout/abort receiving instrument without a real child.
        // The kill signal is recorded, but the child never yields a close or callback.
        timers.add(setTimeout(() => kill("SIGKILL"), options.timeout));
        options.signal?.addEventListener("abort", () => kill("SIGKILL"), { once: true });
      }
      return child;
    });
  }
  function bounded<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timers.add(setTimeout(() => reject(Error("fixture_receipt_wedged")), 800));
    })]);
  }
  it("positive control receives the ordinary callback through the same executable instrument", async () => {
    instrument(true);
    expect(await bounded(receiveDarwinThoughtsCommandForTest("/fixed/docker", ["info"], Date.now() + 100))).toEqual({
      code: 0, stdout: "known receipt", stderr: "",
    });
    expect(instrumentation.execFile).toHaveBeenCalledTimes(1);
    expect(children[0]!.kill).not.toHaveBeenCalled();
  }, 5000);
  it("refuses within the deadline plus bounded reaping fallback when kill never yields a receipt", async () => {
    instrument(false);
    const started = performance.now();
    const received = await bounded(receiveDarwinThoughtsCommandForTest("/fixed/docker", ["info"], Date.now() + 100));
    expect(received.code).toBe(1);
    expect(performance.now() - started).toBeLessThan(650);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  }, 5000);
  it("caller abort also refuses within a bounded fallback when kill never yields a receipt", async () => {
    instrument(false);
    const controller = new AbortController();
    const started = performance.now();
    const pending = receiveDarwinThoughtsCommandForTest("/fixed/docker", ["info"], Date.now() + 10000, 16384, controller.signal);
    controller.abort();
    expect((await bounded(pending)).code).toBe(1);
    expect(performance.now() - started).toBeLessThan(650);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  }, 5000);
});
