import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { PAYMENT_METHODS, PAYMENT_SORT_FIELDS, PAYMENT_STATUSES } from "../dto/payments.dto.js";

// "dueDate", "dueDate:asc" or "amount:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${PAYMENT_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

// KWD fils: a whole number, 0 or more, at most 999,999,999.999 KWD.
export const MAX_AMOUNT_MINOR = 999_999_999_999;
const amountMinor = z
  .number({ error: "validation.paymentAmountInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_MINOR, {
    error: "validation.paymentAmountInvalid",
  });

const status = z.enum(PAYMENT_STATUSES, { error: "validation.paymentStatusInvalid" });
const method = z.enum(PAYMENT_METHODS, { error: "validation.paymentMethodInvalid" });

// Optional text: trimmed, and an empty one means none.
const optionalText = (max: number, key: string) =>
  z
    .string({ error: key })
    .trim()
    .max(max, { error: key })
    .transform((value) => (value.length === 0 ? null : value));

const reference = optionalText(100, "validation.paymentReferenceLength");
const notes = optionalText(2000, "validation.paymentNotesLength");

const booleanQuery = z
  .enum(["true", "false"], { error: "validation.booleanInvalid" })
  .transform((value) => value === "true");

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortPaymentsInvalid" }).optional(),
  // Looks in the reference, the notes, the contractor's name and the villa number.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  status: status.optional(),
  contractorId: queryId.optional(),
  villaId: queryId.optional(),
  // true: only the pending payments past their due date (APP_TIMEZONE).
  overdue: booleanQuery.optional(),
});

// A PAID payment without a paid date gets today's (APP_TIMEZONE); a PENDING one keeps none.
export const createPaymentSchema = z.strictObject({
  contractorId: id,
  villaId: id.nullable().optional(),
  amountMinor,
  status: status.optional(),
  dueDate: calendarDateField.nullable().optional(),
  paidDate: calendarDateField.nullable().optional(),
  method: method.nullable().optional(),
  reference: reference.nullable().optional(),
  notes: notes.nullable().optional(),
});

export const updatePaymentSchema = z
  .strictObject({
    contractorId: id.optional(),
    villaId: id.nullable().optional(),
    amountMinor: amountMinor.optional(),
    status: status.optional(),
    dueDate: calendarDateField.nullable().optional(),
    paidDate: calendarDateField.nullable().optional(),
    method: method.nullable().optional(),
    reference: reference.nullable().optional(),
    notes: notes.nullable().optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const paymentFileParams = z.strictObject({
  id: z.uuid({ error: "validation.idInvalid" }),
  fileId: z.uuid({ error: "validation.idInvalid" }),
});

export type ListPaymentsQuery = z.output<typeof listPaymentsQuerySchema>;
export type CreatePaymentInput = z.output<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.output<typeof updatePaymentSchema>;
