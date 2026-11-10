import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { OPEN_WORK_SORT_FIELDS, PRIORITIES, WORK_STATUSES } from "../dto/open-works.dto.js";

// "location", "location:asc" or "elecPhaseName:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${OPEN_WORK_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

const status = z.enum(WORK_STATUSES, { error: "validation.workStatusInvalid" });
const priority = z.enum(PRIORITIES, { error: "validation.priorityInvalid" });

// A whole number from 0 to 100. One refine, so every bad value gives one error.
const progress = z
  .number({ error: "validation.progressInvalid" })
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 100, {
    error: "validation.progressInvalid",
  });

// A calendar day (YYYY-MM-DD); null means "not set".
const nullableDate = calendarDateField.nullable();

type WithDates = { startDate?: Date | null | undefined; endDate?: Date | null | undefined };

function endNotBeforeStart(value: WithDates): boolean {
  return !value.startDate || !value.endDate || value.endDate >= value.startDate;
}
const dateOrderIssue = { error: "validation.dateRangeInvalid", path: ["endDate"] };

// The villa is fixed when an item is made, and the source is always MANUAL here: a PATCH carrying either is refused as an
// unknown field. An item made by hand is filed under an existing ACTIVE electrical phase (required) and starts at NOT_STARTED, 0,
// unless it says otherwise.
export const createOpenWorkSchema = z
  .strictObject({
    villaId: id,
    elecPhaseId: id,
    status: status.optional(),
    priority: priority.optional(),
    progress: progress.optional(),
    contractorId: id.nullable().optional(),
    startDate: nullableDate.optional(),
    endDate: nullableDate.optional(),
  })
  .refine(endNotBeforeStart, dateOrderIssue);

// No defaults here: a field that is not sent must stay as it is. The electrical phase can be moved for a manual item only (an
// automatic one follows its phase), and cannot be cleared.
export const updateOpenWorkSchema = z
  .strictObject({
    elecPhaseId: id.optional(),
    status: status.optional(),
    priority: priority.optional(),
    progress: progress.optional(),
    contractorId: id.nullable().optional(),
    startDate: nullableDate.optional(),
    endDate: nullableDate.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" })
  .refine(endNotBeforeStart, dateOrderIssue);

export const listOpenWorksQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortOpenWorksInvalid" }).optional(),
    villaId: queryId.optional(),
    elecPhaseId: queryId.optional(),
    status: status.optional(),
    priority: priority.optional(),
    contractorId: queryId.optional(),
    overdue: z
      .enum(["true", "false"], { error: "validation.booleanInvalid" })
      .transform((value) => value === "true")
      .optional(),
    done: z
      .enum(["true", "false"], { error: "validation.booleanInvalid" })
      .transform((value) => value === "true")
      .optional(),
    startFrom: calendarDateField.optional(),
    startTo: calendarDateField.optional(),
    endFrom: calendarDateField.optional(),
    endTo: calendarDateField.optional(),
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

export type CreateOpenWorkInput = z.output<typeof createOpenWorkSchema>;
export type UpdateOpenWorkInput = z.output<typeof updateOpenWorkSchema>;
export type ListOpenWorksQuery = z.output<typeof listOpenWorksQuerySchema>;
