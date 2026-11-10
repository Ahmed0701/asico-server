import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import {
  MAX_DESCRIPTION_LENGTH,
  SMALL_WORK_SORT_FIELDS,
  SMALL_WORK_STATUSES,
} from "../dto/small-works.dto.js";

// "endDate", "endDate:asc" or "contractorName:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${SMALL_WORK_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

// The status and the description are also what a cell of the import file must hold.
export const status = z.enum(SMALL_WORK_STATUSES, { error: "validation.smallWorkStatusInvalid" });

export const description = z
  .string(required)
  .trim()
  .min(1, { error: "validation.descriptionLength" })
  .max(MAX_DESCRIPTION_LENGTH, { error: "validation.descriptionLength" });

// The villa is fixed when a small work is made: a PATCH carrying villaId is refused as an unknown field. A status left out
// is PENDING (the service says so). The order of the two dates and their bound around today are the service's to check (a
// 422 and a 400 with the field), since a PATCH may send only one of them.
export const createSmallWorkSchema = z.strictObject({
  villaId: id,
  contractorId: id,
  startDate: calendarDateField,
  endDate: calendarDateField,
  description,
  status: status.optional(),
});

// No defaults here: a field that is not sent must stay as it is. The contractor cannot be cleared: it is required.
export const updateSmallWorkSchema = z
  .strictObject({
    contractorId: id.optional(),
    startDate: calendarDateField.optional(),
    endDate: calendarDateField.optional(),
    description: description.optional(),
    status: status.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

const flag = z
  .enum(["true", "false"], { error: "validation.booleanInvalid" })
  .transform((value) => value === "true");

export const listSmallWorksQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortSmallWorksInvalid" }).optional(),
    villaId: queryId.optional(),
    contractorId: queryId.optional(),
    status: status.optional(),
    startFrom: calendarDateField.optional(),
    startTo: calendarDateField.optional(),
    endFrom: calendarDateField.optional(),
    endTo: calendarDateField.optional(),
    overdue: flag.optional(),
    dueSoon: flag.optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.startFrom || !query.startTo || query.startFrom <= query.startTo, {
    error: "validation.dateRangeInvalid",
    path: ["startTo"],
  })
  .refine((query) => !query.endFrom || !query.endTo || query.endFrom <= query.endTo, {
    error: "validation.dateRangeInvalid",
    path: ["endTo"],
  });

export type CreateSmallWorkInput = z.output<typeof createSmallWorkSchema>;
export type UpdateSmallWorkInput = z.output<typeof updateSmallWorkSchema>;
export type ListSmallWorksQuery = z.output<typeof listSmallWorksQuerySchema>;
