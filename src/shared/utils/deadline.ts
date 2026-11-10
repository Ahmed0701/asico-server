// The deadline of a small work: the END of its endDate day in the application's time zone (APP_TIMEZONE). It is the only place
// the application counts a day in a zone other than UTC; "today" everywhere else is still the UTC day.
//
// A work that is still pending is
//   - overdue once the deadline has passed (from 00:00 local of the day after endDate), and
//   - due soon from `hoursBefore` hours before the deadline until then.
//
// Both are decided by CALENDAR DAYS of the zone, so the API's flags, the list filters, the dashboard and the alert job give the
// same answer from the same two days (see `alertWindow`): at `now`, a work is overdue when its endDate is before the zone's today,
// and due soon when its endDate is today or later but before the zone's day at `now + hoursBefore`. That is the same as comparing
// instants with the deadline (the first instant of the next day), which `deadlineOf` returns for display.

export type DeadlinePolicy = { timeZone: string; hoursBefore: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// An IANA name such as Asia/Kuwait (or UTC). A fixed offset like +03:00 is not a zone name: it has no days that repeat or skip.
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(name)) {
    return false;
  }
  try {
    formatterOf(name);
    return true;
  } catch {
    return false;
  }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallOf(instant: Date, timeZone: string): Wall {
  const wall: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") {
      wall[part.type] = Number(part.value);
    }
  }
  return wall as Wall;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

// The calendar day (YYYY-MM-DD) the instant falls in, in the zone.
export function localDayOf(instant: Date, timeZone: string): string {
  const { year, month, day } = wallOf(instant, timeZone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

// The wall clock of the zone minus UTC at that instant, in ms (whole seconds).
function offsetOf(instant: Date, timeZone: string): number {
  const w = wallOf(instant, timeZone);
  return (
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) -
    Math.floor(instant.getTime() / 1000) * 1000
  );
}

const startCache = new Map<string, Date>();

// The zone's calendar day at `instant`, as a date at 00:00 UTC (the shape every DATE column is read and compared in).
export function zoneToday(instant: Date, timeZone: string): Date {
  return new Date(`${localDayOf(instant, timeZone)}T00:00:00.000Z`);
}

// The first instant of the calendar day `day` (YYYY-MM-DD) in the zone: 00:00 local, or the end of the gap when a zone skips
// its midnight.
export function startOfLocalDay(day: string, timeZone: string): Date {
  const key = `${timeZone}|${day}`;
  const cached = startCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, date);
  let guess = wall - offsetOf(new Date(wall), timeZone);
  guess = wall - offsetOf(new Date(guess), timeZone);
  const isFirst = (ms: number): boolean =>
    localDayOf(new Date(ms), timeZone) === day && localDayOf(new Date(ms - 1), timeZone) !== day;
  let found = guess;
  if (!isFirst(guess)) {
    // A midnight that does not exist or happens twice: search the day's edge (within a day of the guess) by bisection.
    let low = wall - DAY_MS;
    let high = wall + DAY_MS;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (localDayOf(new Date(mid), timeZone) >= day) {
        high = mid;
      } else {
        low = mid;
      }
    }
    found = high;
  }
  if (startCache.size > 2000) {
    startCache.clear();
  }
  const result = new Date(found);
  startCache.set(key, result);
  return result;
}

// The day after `day` (YYYY-MM-DD).
export function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// The instant a work with this endDate becomes overdue: the start of the next day in the zone.
export function deadlineOf(endDay: string, policy: DeadlinePolicy): Date {
  return startOfLocalDay(nextDay(endDay), policy.timeZone);
}

// The two days every comparison uses at `now`: the zone's today, and the zone's day `hoursBefore` hours from now.
export type AlertWindow = { today: string; horizon: string };

export function alertWindow(now: Date, policy: DeadlinePolicy): AlertWindow {
  return {
    today: localDayOf(now, policy.timeZone),
    horizon: localDayOf(new Date(now.getTime() + policy.hoursBefore * HOUR_MS), policy.timeZone),
  };
}

export type DeadlineState = { deadlineAt: Date; overdue: boolean; dueSoon: boolean };

// The state of a work with this endDate. `pending` false (done): neither flag is ever set; the deadline is still given.
export function deadlineState(
  endDay: string,
  pending: boolean,
  window: AlertWindow,
  policy: DeadlinePolicy,
): DeadlineState {
  const overdue = pending && endDay < window.today;
  const dueSoon = pending && endDay >= window.today && endDay < window.horizon;
  return { deadlineAt: deadlineOf(endDay, policy), overdue, dueSoon };
}
