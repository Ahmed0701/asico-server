import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { VILLA_FINANCE_SORT_FIELDS } from "../dto/villa-finance.dto.js";

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));

export const villaParams = z.strictObject({ villaId: id });

// KWD fils: a whole number, 0 or more, at most 999,999,999.999 KWD; null clears it.
export const MAX_FINANCE_MINOR = 999_999_999_999;
const amount = z
  .number({ error: "validation.financeAmountInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_FINANCE_MINOR, {
    error: "validation.financeAmountInvalid",
  })
  .nullable()
  .optional();

// A villa's share of the Department Overhead salaries, in hundredths of a percent: 0 to 10000 (100%); null clears it.
export const MAX_SALARY_SHARE_BP = 10_000;
const share = z
  .number({ error: "validation.salaryShareInvalid" })
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_SALARY_SHARE_BP, {
    error: "validation.salaryShareInvalid",
  })
  .nullable()
  .optional();

// Only what is sent changes; at least one. The budget is the villa's own (saved in KWD).
export const putVillaFinanceSchema = z
  .strictObject({
    budgetMinor: amount,
    workOrderMinor: amount,
    salaryShareBp: share,
    materialsMinor: amount,
    pettyCashMinor: amount,
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

const sortPattern = new RegExp(`^(${VILLA_FINANCE_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listVillaFinanceQuerySchema = paginationQuerySchema.extend({
  // Looks in the villa number and the location.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortVillaFinanceInvalid" }).optional(),
});

export type PutVillaFinanceInput = z.output<typeof putVillaFinanceSchema>;
export type ListVillaFinanceQuery = z.output<typeof listVillaFinanceQuerySchema>;
