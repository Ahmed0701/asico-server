import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import {
  DAILY_LABOUR_SORT_FIELDS,
  MAX_LABOUR_COUNT,
  MAX_LABOUR_NOTES_LENGTH,
} from "../dto/daily-labour.dto.js";

// "labourDate", "labourDate:asc" or "labourCount:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${DAILY_LABOUR_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

// A whole number from 0 to 100,000. One refine, so every bad value gives one error. It is also what a cell of the import
// file must hold.
export const labourCount = z
  .number({ error: "validation.labourCountInvalid" })
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_LABOUR_COUNT, {
    error: "validation.labourCountInvalid",
  });

// Blank means "no notes": it is stored as null.
export const notes = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string(required)
    .trim()
    .max(MAX_LABOUR_NOTES_LENGTH, { error: "validation.labourNotesTooLong" })
    .nullable(),
);

// The villa is fixed when a row is made: a PATCH carrying villaId is refused as an unknown field.
export const createDailyLabourSchema = z.strictObject({
  villaId: id,
  labourDate: calendarDateField,
  contractorId: id,
  labourCount,
  notes: notes.optional(),
});

// No defaults here: a field that is not sent must stay as it is. The contractor cannot be cleared: it is required.
export const updateDailyLabourSchema = z
  .strictObject({
    labourDate: calendarDateField.optional(),
    contractorId: id.optional(),
    labourCount: labourCount.optional(),
    notes: notes.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const listDailyLabourQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortDailyLabourInvalid" }).optional(),
    villaId: queryId.optional(),
    contractorId: queryId.optional(),
    labourFrom: calendarDateField.optional(),
    labourTo: calendarDateField.optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.labourFrom || !query.labourTo || query.labourFrom <= query.labourTo, {
    error: "validation.dateRangeInvalid",
    path: ["labourTo"],
  });

export type CreateDailyLabourInput = z.output<typeof createDailyLabourSchema>;
export type UpdateDailyLabourInput = z.output<typeof updateDailyLabourSchema>;
export type ListDailyLabourQuery = z.output<typeof listDailyLabourQuerySchema>;
