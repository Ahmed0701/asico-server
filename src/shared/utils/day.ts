// The start of the UTC day the instant falls in: what "today" means for the dates the app compares and stamps.
export function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A record may be written for today, for yesterday and the days before, and for tomorrow (a crew that reports ahead of
// midnight, or a clock in another time zone). Anything later is "too far ahead". Days are UTC days, like every date here.
export function isTooFarAhead(day: Date, now: Date): boolean {
  return day.getTime() > startOfUtcDay(now).getTime() + DAY_MS;
}

// The calendar day of a DATE column's value (a Date at 00:00 UTC), as YYYY-MM-DD.
export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Whether the day is within `years` years of the UTC day of `now`, either way. The planned dates of a small work have no
// "too far ahead" rule, only this sane bound.
export function isWithinYears(day: Date, now: Date, years: number): boolean {
  const today = startOfUtcDay(now);
  const low = new Date(today);
  low.setUTCFullYear(low.getUTCFullYear() - years);
  const high = new Date(today);
  high.setUTCFullYear(high.getUTCFullYear() + years);
  return day.getTime() >= low.getTime() && day.getTime() <= high.getTime();
}
