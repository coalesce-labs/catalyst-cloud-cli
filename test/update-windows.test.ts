// update-windows.test.ts — the set times of day the schedule takes a new runner release (CTC-6709):
// the window before and after an instant in the machine's zone, across a day boundary and a clock
// change, and the times and zones an owner may save.
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_TIMES, isTimeZone, normalizeWindowTimes, windowBounds } from "../src/update-windows";

const at = (iso: string) => Date.parse(iso);
const chicago = { times: [...DEFAULT_WINDOW_TIMES], timeZone: "America/Chicago" };

describe("the window before and after now, in the machine's zone", () => {
  it("POSITIVE CONTROL: a release seen at 09:00 in Chicago waits for 11:00; the last window was 03:00", () => {
    // 2026-10-23 is daylight time in Chicago, UTC-5.
    expect(windowBounds(at("2026-10-23T14:00:00Z"), chicago)).toEqual({
      lastOpenedMs: at("2026-10-23T08:00:00Z"),
      nextOpensMs: at("2026-10-23T16:00:00Z"),
      timeZone: "America/Chicago",
    });
  });

  it("at a window's own minute, that window has opened", () => {
    const b = windowBounds(at("2026-10-23T21:00:00Z"), chicago);
    expect(b.lastOpenedMs).toBe(at("2026-10-23T21:00:00Z"));
    expect(b.nextOpensMs).toBe(at("2026-10-24T03:00:00Z"));
  });

  it("after the day's last window the next one is 03:00 the next day", () => {
    const b = windowBounds(at("2026-10-24T04:30:00Z"), chicago); // 23:30 local
    expect(b.lastOpenedMs).toBe(at("2026-10-24T03:00:00Z"));
    expect(b.nextOpensMs).toBe(at("2026-10-24T08:00:00Z"));
  });

  it("across the autumn clock change, 03:00 is standard time (UTC-6)", () => {
    // Chicago falls back at 02:00 on 2026-11-01; 08:30Z is 02:30 standard time.
    const b = windowBounds(at("2026-11-01T08:30:00Z"), chicago);
    expect(b.lastOpenedMs).toBe(at("2026-11-01T03:00:00Z")); // 22:00 daylight time the evening before
    expect(b.nextOpensMs).toBe(at("2026-11-01T09:00:00Z"));
  });

  it.each([
    // [what, now, window times, last opened, next]
    ["an ordinary day (control)", "2026-10-20T05:30:00Z", ["00:15"], "2026-10-20T05:15:00Z", "2026-10-21T05:15:00Z"],
    ["00:30 daylight time on the 25-hour day", "2026-11-01T05:30:00Z", ["00:15"], "2026-11-01T05:15:00Z", "2026-11-02T06:15:00Z"],
    ["23:30 standard time on the 25-hour day", "2026-11-02T05:30:00Z", ["23:45"], "2026-11-01T04:45:00Z", "2026-11-02T05:45:00Z"],
    ["00:30 the day after the 23-hour day", "2027-03-15T05:30:00Z", ["22:00"], "2027-03-15T03:00:00Z", "2027-03-16T03:00:00Z"],
  ])("both bounds exist around a clock change: %s", (_what, now, times, last, next) => {
    expect(windowBounds(at(now), { times, timeZone: "America/Chicago" })).toEqual({ lastOpenedMs: at(last), nextOpensMs: at(next), timeZone: "America/Chicago" });
  });

  it("an owner's own times and zone are used, sorted", () => {
    const b = windowBounds(at("2026-10-23T12:00:00Z"), { times: ["18:30", "06:00"], timeZone: "UTC" });
    expect(b).toEqual({ lastOpenedMs: at("2026-10-23T06:00:00Z"), nextOpensMs: at("2026-10-23T18:30:00Z"), timeZone: "UTC" });
  });
});

describe("what an owner may save", () => {
  it("times are 24-hour HH:MM, sorted and distinct", () => {
    expect(normalizeWindowTimes(["16:00", "03:00", "16:00"])).toEqual(["03:00", "16:00"]);
  });

  it.each([[[]], [["3:00"]], [["24:00"]], [["03:60"]], [["noon"]]])("NEGATIVE: %j is not a list of window times", (times) => {
    expect(normalizeWindowTimes(times)).toBeNull();
  });

  it("a zone this runtime knows is accepted; an unknown or empty one is not", () => {
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});
