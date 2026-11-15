import { z } from "zod";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { VARIATION_ORDER_STATUSES } from "../dto/variation-orders.dto.js";

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));

// KWD fils: a whole number, 0 or more, at most 999,999,999.999 KWD.
export const MAX_VO_AMOUNT_MINOR = 999_999_999_999;
const amountMinor = z
  .number({ error: "validation.voAmountInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_VO_AMOUNT_MINOR, {
    error: "validation.voAmountInvalid",
  });

const voNumber = z
  .string({ error: "validation.voNumberRequired" })
  .trim()
  .min(1, { error: "validation.voNumberRequired" })
  .max(50, { error: "validation.voNumberLength" });

const status = z.enum(VARIATION_ORDER_STATUSES, { error: "validation.voStatusInvalid" });

// Trimmed; an empty one means none.
const notes = z
  .string({ error: "validation.voNotesLength" })
  .trim()
  .max(2000, { error: "validation.voNotesLength" })
  .transform((value) => (value.length === 0 ? null : value));

export const villaParams = z.strictObject({ villaId: id });

// Without a date added, today (APP_TIMEZONE).
export const createVariationOrderSchema = z.strictObject({
  voNumber,
  amountMinor,
  dateAdded: calendarDateField.optional(),
  status: status.optional(),
  notes: notes.nullable().optional(),
});

export const updateVariationOrderSchema = z
  .strictObject({
    voNumber: voNumber.optional(),
    amountMinor: amountMinor.optional(),
    dateAdded: calendarDateField.optional(),
    status: status.optional(),
    notes: notes.nullable().optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const variationOrderFileParams = z.strictObject({
  id: z.uuid({ error: "validation.idInvalid" }),
  fileId: z.uuid({ error: "validation.idInvalid" }),
});

export type CreateVariationOrderInput = z.output<typeof createVariationOrderSchema>;
export type UpdateVariationOrderInput = z.output<typeof updateVariationOrderSchema>;
