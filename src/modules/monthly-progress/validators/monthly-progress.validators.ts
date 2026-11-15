import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { MONTHLY_PROGRESS_SORT_FIELDS } from "../dto/monthly-progress.dto.js";

// "change", "change:desc" or "villaNumber:asc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${MONTHLY_PROGRESS_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const monthlyProgressQuerySchema = paginationQuerySchema.extend({
  // YYYY-MM; the current month (APP_TIMEZONE) when not sent. A month after the current one is refused by the service.
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "validation.monthInvalid" })
    .optional(),
  // Looks in the villa number, the location and the contractor's name.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortMonthlyProgressInvalid" }).optional(),
});

export type MonthlyProgressQuery = z.output<typeof monthlyProgressQuerySchema>;
