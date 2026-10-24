// update-windows.ts — the set times of day a self-hosted machine takes a new release (CTC-6709).
// The 15-minute schedule checks often so an owner sees the approved release quickly, but a busy
// machine restarting its supervisor every time a release lands would interrupt its owner's day as
// often as releases ship. So the schedule applies a newer release only once a window has opened
// since the last window a run settled, and an owner's own `catalyst runner update` applies at once.
// Windows are wall-clock times in the machine's time zone, or the zone its owner saved.

/** Four windows a day, spread so a release approved at any time waits at most about eight hours. */
export const DEFAULT_WINDOW_TIMES = ["03:00", "11:00", "16:00", "22:00"] as const;

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DAY_MS = 86_400_000;

export interface UpdateWindows {
  /** Wall-clock times, `HH:MM`, sorted and distinct. */
  times: string[];
  /** An IANA zone, or null for the machine's own. */
  timeZone: string | null;
}

export interface WindowBounds {
  /** The latest window at or before now. */
  lastOpenedMs: number;
  /** The first window after now. */
  nextOpensMs: number;
  timeZone: string;
}

export function defaultWindows(): UpdateWindows {
  return { times: [...DEFAULT_WINDOW_TIMES], timeZone: null };
}

export function isWindowTime(value: string): boolean {
  return TIME.test(value);
}

/** Whether this runtime knows the zone. `Intl` throws a RangeError for one it does not. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0;
  } catch {
    return false;
  }
}

export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Sorted, distinct `HH:MM` times, or null when any entry is not one or there are none. */
export function normalizeWindowTimes(values: readonly string[]): string[] | null {
  if (values.length === 0 || values.length > 24 || !values.every(isWindowTime)) return null;
  return [...new Set(values)].sort();
}

/** The zone's wall clock at an instant, as the parts a window time is compared with. */
function wallClock(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The zone's offset from UTC at an instant, in milliseconds, to the minute. */
function offsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant a wall-clock time falls on in the zone. A time a clock change skips or repeats lands within an hour of it. */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetMs(asUtc, timeZone);
  return asUtc - offsetMs(first, timeZone);
}

/** The window before and after `nowMs`. */
export function windowBounds(nowMs: number, windows: UpdateWindows): WindowBounds {
  const timeZone = windows.timeZone ?? machineTimeZone();
  const times = normalizeWindowTimes(windows.times) ?? [...DEFAULT_WINDOW_TIMES];
  const candidates: number[] = [];
  // Yesterday through tomorrow in the zone always holds the window before and the one after now.
  for (const shift of [-DAY_MS, 0, DAY_MS]) {
    const d = wallClock(nowMs + shift, timeZone);
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number) as [number, number];
      candidates.push(instantOf(d.year, d.month, d.day, hour, minute, timeZone));
    }
  }
  candidates.sort((a, b) => a - b);
  const lastOpenedMs = candidates.filter((ms) => ms <= nowMs).pop()!;
  const nextOpensMs = candidates.find((ms) => ms > nowMs)!;
  return { lastOpenedMs, nextOpensMs, timeZone };
}
