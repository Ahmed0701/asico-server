import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import {
  DAILY_REPORT_SORT_FIELDS,
  MAX_REPORT_TEXT_LENGTH,
  MAX_WORKERS,
  WEATHERS,
} from "../dto/daily-reports.dto.js";

// "reportDate", "reportDate:asc" or "contractorName:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${DAILY_REPORT_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

// The weather, the workers and the notes are also what a cell of the import file must hold.
export const weather = z.enum(WEATHERS, { error: "validation.weatherInvalid" });

// A whole number from 0 to 100,000. One refine, so every bad value gives one error.
export const workersCount = z
  .number({ error: "validation.workersCountInvalid" })
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_WORKERS, {
    error: "validation.workersCountInvalid",
  });

// Blank means "no notes": it is stored as null.
export const notes = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string(required).trim().max(MAX_REPORT_TEXT_LENGTH, { error: "validation.notesTooLong" }).nullable(),
);

// A report belongs to a contractor and is prepared by an electrical engineer, both required (the service checks that they exist
// and are ACTIVE). There is no villa: a body that carries a villaId is refused as an unknown field.
export const createDailyReportSchema = z.strictObject({
  contractorId: id,
  preparedByEngineerId: id,
  reportDate: calendarDateField,
  weather,
  workersCount,
  notes: notes.optional(),
});

// No defaults here: a field that is not sent must stay as it is. Neither the contractor nor the engineer can be cleared.
export const updateDailyReportSchema = z
  .strictObject({
    contractorId: id.optional(),
    preparedByEngineerId: id.optional(),
    reportDate: calendarDateField.optional(),
    weather: weather.optional(),
    workersCount: workersCount.optional(),
    notes: notes.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const listDailyReportsQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortDailyReportsInvalid" }).optional(),
    // A daily report has no villa any more. A client that still sends the filter is told so instead of being given every report.
    villaId: z.undefined({ error: "validation.dailyReportVillaFilterRemoved" }).optional(),
    contractorId: queryId.optional(),
    preparedByEngineerId: queryId.optional(),
    weather: weather.optional(),
    reportFrom: calendarDateField.optional(),
    reportTo: calendarDateField.optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.reportFrom || !query.reportTo || query.reportFrom <= query.reportTo, {
    error: "validation.dateRangeInvalid",
    path: ["reportTo"],
  });

export type CreateDailyReportInput = z.output<typeof createDailyReportSchema>;
export type UpdateDailyReportInput = z.output<typeof updateDailyReportSchema>;
export type ListDailyReportsQuery = z.output<typeof listDailyReportsQuerySchema>;
