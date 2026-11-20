import { z } from "zod";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { MONTHLY_PROGRESS_SORT_FIELDS } from "../dto/monthly-progress.dto.js";

// "due", "due:desc" or "villaNumber:asc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${MONTHLY_PROGRESS_SORT_FIELDS.join("|")})(:(asc|desc))?$`);
const uuid = z.uuid({ error: "validation.idInvalid" });

export const monthlyProgressQuerySchema = paginationQuerySchema.extend({
  // Looks in the villa number, the location and the contractor's name.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  // true: only the villas with unpaid progress (something owed, or a Work Order Value missing).
  owed: z
    .enum(["true", "false"], { error: "validation.booleanInvalid" })
    .transform((value) => value === "true")
    .optional(),
  // The villas of one contractor.
  contractorId: uuid.optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortMonthlyProgressInvalid" }).optional(),
});

// A payment made before the system: its day, the progress it paid up to (0.1 to 100, one decimal), the amount (KWD
// fils), the contractor (the villa's own when left out) and a note.
export const manualPaymentSchema = z.strictObject({
  paidOn: calendarDateField,
  ratio: z
    .number({ error: "validation.paidRatioInvalid" })
    .refine((value) => value >= 0.1 && value <= 100 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, {
      error: "validation.paidRatioInvalid",
    }),
  amountMinor: z
    .number({ error: "validation.paymentAmountInvalid" })
    .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= 999_999_999_999, {
      error: "validation.paymentAmountInvalid",
    }),
  contractorId: uuid.nullable().optional(),
  note: z
    .string({ error: "validation.paymentNotesLength" })
    .trim()
    .max(2000, { error: "validation.paymentNotesLength" })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional(),
});

export const villaPaymentParams = z.strictObject({ villaId: uuid });
export const paymentParams = z.strictObject({ id: uuid });

export type ManualPaymentBody = z.output<typeof manualPaymentSchema>;
export type MonthlyProgressQuery = z.output<typeof monthlyProgressQuerySchema>;
