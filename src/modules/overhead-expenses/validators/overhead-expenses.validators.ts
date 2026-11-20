import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField } from "../../../shared/validation/fields.js";
import { EXPENSE_SORT_FIELDS, EXPENSE_TYPES } from "../dto/overhead-expenses.dto.js";

const sortPattern = new RegExp(`^(${EXPENSE_SORT_FIELDS.join("|")})(:(asc|desc))?$`);
const uuid = z.uuid({ error: "validation.idInvalid" });

// KWD fils: a whole number, 0 or more, at most 999,999,999.999 KWD.
export const MAX_EXPENSE_MINOR = 999_999_999_999;
const amountMinor = z
  .number({ error: "validation.expenseAmountInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_EXPENSE_MINOR, {
    error: "validation.expenseAmountInvalid",
  });
const type = z.enum(EXPENSE_TYPES, { error: "validation.expenseTypeInvalid" });
const description = z
  .string({ error: "validation.expenseDescriptionInvalid" })
  .trim()
  .min(1, { error: "validation.expenseDescriptionInvalid" })
  .max(500, { error: "validation.expenseDescriptionInvalid" });
// Optional; an empty one is none.
const invoiceNumber = z
  .string({ error: "validation.expenseInvoiceNumberInvalid" })
  .trim()
  .max(60, { error: "validation.expenseInvoiceNumberInvalid" })
  .nullable()
  .transform((value) => (value ? value : null));

export const listOverheadExpensesQuerySchema = paginationQuerySchema.extend({
  // Looks in the description, the invoice number and the villa number.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  villaId: uuid.optional(),
  type: type.optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortExpenseInvalid" }).optional(),
});

export const createOverheadExpenseSchema = z.strictObject({
  villaId: uuid,
  type,
  description,
  amountMinor,
  expenseDate: calendarDateField,
  invoiceNumber: invoiceNumber.optional(),
});

export const updateOverheadExpenseSchema = z
  .strictObject({
    villaId: uuid.optional(),
    type: type.optional(),
    description: description.optional(),
    amountMinor: amountMinor.optional(),
    expenseDate: calendarDateField.optional(),
    invoiceNumber: invoiceNumber.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const expenseFileParams = z.strictObject({ id: uuid, fileId: uuid });

export type ListOverheadExpensesQuery = z.output<typeof listOverheadExpensesQuerySchema>;
export type CreateOverheadExpenseInput = z.output<typeof createOverheadExpenseSchema>;
export type UpdateOverheadExpenseInput = z.output<typeof updateOverheadExpenseSchema>;
