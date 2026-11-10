import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { MAINTENANCE_SORT_FIELDS } from "../dto/maintenance.dto.js";

// "handoverDate", "handoverDate:asc" or "villaNumber:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${MAINTENANCE_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const villaNumber = z
  .string(required)
  .trim()
  .min(1, { error: "validation.textLength" })
  .max(50, { error: "validation.textLength" });

const location = z
  .string(required)
  .trim()
  .min(1, { error: "validation.maintenanceLocationLength" })
  .max(200, { error: "validation.maintenanceLocationLength" });

const issue = z
  .string(required)
  .trim()
  .min(1, { error: "validation.maintenanceIssueLength" })
  .max(2000, { error: "validation.maintenanceIssueLength" });

const booleanQuery = z
  .enum(["true", "false"], { error: "validation.booleanInvalid" })
  .transform((value) => value === "true");

export const listMaintenanceQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortMaintenanceInvalid" }).optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  // true: only the solved ones; false: only the ones still open. Missing: all of them.
  solved: booleanQuery.optional(),
});

export const createMaintenanceSchema = z.strictObject({
  villaNumber,
  location,
  handoverDate: calendarDateField,
  issue,
});

export const updateMaintenanceSchema = z
  .strictObject({
    villaNumber: villaNumber.optional(),
    location: location.optional(),
    handoverDate: calendarDateField.optional(),
    issue: issue.optional(),
    // Checking it as solved moves it to the solved list; unchecking moves it back.
    solved: z.boolean({ error: "validation.booleanInvalid" }).optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListMaintenanceQuery = z.output<typeof listMaintenanceQuerySchema>;
export type CreateMaintenanceInput = z.output<typeof createMaintenanceSchema>;
export type UpdateMaintenanceInput = z.output<typeof updateMaintenanceSchema>;
