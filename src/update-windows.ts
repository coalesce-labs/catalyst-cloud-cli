// update-windows.ts — the set times of day an owner may choose for a self-hosted machine to take a
// new release (CTC-6709). By default there are none (CTC-7465): the 15-minute schedule applies a
// newer release at its next check, because an update restarts only the supervisor, in place, and
// every running job finishes on the image it started with. An owner who wants set times saves them
// with `catalyst update policy windows`. The schedule then applies a newer release only once a window
// has opened since the last window a run settled, and an owner's own `catalyst runner update` still
// applies at once. Windows are wall-clock times in the machine's time zone, or the zone its owner saved.

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

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
  const times = normalizeWindowTimes(windows.times);
  if (times === null) throw new Error(`update windows ${JSON.stringify(windows.times)} are not 24-hour times`);
  const today = wallClock(nowMs, timeZone);
  const candidates: number[] = [];
  // Two calendar days either side of today's date in the zone. Stepping by date, not by 24 hours,
  // keeps a 23- or 25-hour day around a clock change from skipping a date or reading one twice.
  for (let shift = -2; shift <= 2; shift++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + shift));
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number) as [number, number];
      candidates.push(instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone));
    }
  }
  candidates.sort((a, b) => a - b);
  const lastOpenedMs = candidates.filter((ms) => ms <= nowMs).pop();
  const nextOpensMs = candidates.find((ms) => ms > nowMs);
  if (lastOpenedMs === undefined || nextOpensMs === undefined) throw new Error(`no update window around ${new Date(nowMs).toISOString()} in ${timeZone}`);
  return { lastOpenedMs, nextOpensMs, timeZone };
}
