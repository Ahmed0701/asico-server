import { z } from "zod";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const dateTime = z.iso.datetime({ offset: true });

// A date alone covers the whole UTC day: it starts a range at 00:00:00.000 and ends one at 23:59:59.999.
// A date and time is taken as given (any offset is converted to UTC). Impossible dates such as 2026-02-30 fail.
export function parseDateInput(value: string, edge: "start" | "end"): Date | undefined {
  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
  }
  if (!dateTime.safeParse(value).success) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// A query or body field holding a date. `edge` decides what a date without a time means.
export const dateField = (edge: "start" | "end") =>
  z.string({ error: "validation.dateInvalid" }).transform((value, ctx) => {
    const date = parseDateInput(value, edge);
    if (!date) {
      ctx.issues.push({ code: "custom", message: "validation.dateInvalid", input: value });
      return z.NEVER;
    }
    return date;
  });

// A calendar day (YYYY-MM-DD) for a DATE column: no time, no offset. It is held as that day at 00:00 UTC
// (see `toDay` in shared/utils/day.ts for the way back). Impossible dates such as 2026-02-30 fail.
export const calendarDateField = z
  .string({ error: "validation.calendarDateInvalid" })
  .transform((value, ctx) => {
    const date = DATE_ONLY.test(value) ? parseDateInput(value, "start") : undefined;
    if (!date) {
      ctx.issues.push({ code: "custom", message: "validation.calendarDateInvalid", input: value });
      return z.NEVER;
    }
    return date;
  });
