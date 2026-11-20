import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { hasAnyField } from "../../../shared/validation/fields.js";
import { OVERHEAD_ROLES, OVERHEAD_SORT_FIELDS } from "../dto/overhead.dto.js";

const sortPattern = new RegExp(`^(${OVERHEAD_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

// KWD fils a month: a whole number, 0 or more, at most 999,999,999.999 KWD.
export const MAX_SALARY_MINOR = 999_999_999_999;
const salaryMinor = z
  .number({ error: "validation.overheadSalaryInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_SALARY_MINOR, {
    error: "validation.overheadSalaryInvalid",
  });

const nameOf = (key: string) =>
  z.string({ error: key }).trim().min(1, { error: key }).max(120, { error: key });

const name = nameOf("validation.overheadNameInvalid");
const role = z.enum(OVERHEAD_ROLES, { error: "validation.overheadRoleInvalid" });

export const listOverheadQuerySchema = paginationQuerySchema.extend({
  // Looks in the name and the role.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortOverheadInvalid" }).optional(),
});

export const createOverheadSchema = z.strictObject({ name, role, salaryMinor });

export const updateOverheadSchema = z
  .strictObject({ name: name.optional(), role: role.optional(), salaryMinor: salaryMinor.optional() })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListOverheadQuery = z.output<typeof listOverheadQuerySchema>;
export type CreateOverheadInput = z.output<typeof createOverheadSchema>;
export type UpdateOverheadInput = z.output<typeof updateOverheadSchema>;
