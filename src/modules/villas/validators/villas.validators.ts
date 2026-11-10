import { z } from "zod";
import { MEW_STATES, VILLA_TYPES } from "../../../shared/constants/enums.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { required } from "../../../shared/validation/fields.js";
import { VILLA_SORT_FIELDS } from "../dto/villas.dto.js";

// "location", "location:asc" or "location:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${VILLA_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const text = z
  .string(required)
  .trim()
  .min(1, { error: "validation.textLength" })
  .max(50, { error: "validation.textLength" });

const ownerName = z
  .string(required)
  .trim()
  .min(1, { error: "validation.ownerNameLength" })
  .max(120, { error: "validation.ownerNameLength" });

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));

const villaType = z.enum(VILLA_TYPES, { error: "validation.villaTypeInvalid" });

// A calendar day (YYYY-MM-DD); null means "not set".
const nullableDate = calendarDateField.nullable();

// The ISO 4217 codes the system knows, alphabetical (the choices of the import template's Currency column).
export const CURRENCY_CODES: readonly string[] = Intl.supportedValuesOf("currency");
const CURRENCIES = new Set(CURRENCY_CODES);

// An ISO 4217 code, in any case; it is kept in capitals.
const currency = z
  .string(required)
  .trim()
  .toUpperCase()
  .refine((code) => CURRENCIES.has(code), { error: "validation.currencyInvalid" });

// Minor units (fils, piastres, cents): a whole number from 0 up to 2^53 - 1 (isSafeInteger is that upper bound).
const budgetMinor = z
  .number({ error: "validation.budgetInvalid" })
  .refine((value) => Number.isSafeInteger(value) && value >= 0, {
    error: "validation.budgetInvalid",
  });

type WithDates = { startDate?: Date | null | undefined; targetDate?: Date | null | undefined };

function targetNotBeforeStart(value: WithDates): boolean {
  return !value.startDate || !value.targetDate || value.targetDate >= value.startDate;
}
const dateOrderIssue = { error: "validation.targetBeforeStart", path: ["targetDate"] };

// A currency belongs to a budget: it cannot be sent while the budget is null or, on creation, missing.
const currencyNeedsBudgetIssue = { error: "validation.currencyWithoutBudget", path: ["currency"] };

export const createVillaSchema = z
  .strictObject({
    villaNumber: text,
    ownerName: ownerName.nullable().optional(),
    // How the villa is built; null or missing means not set.
    villaType: villaType.nullable().optional(),
    areaId: id,
    block: text,
    plot: text,
    civilEngineerId: id,
    // The electrical engineer, if one is set; null or missing means none.
    electricalEngineerId: id.nullable().optional(),
    // The villa's one contractor; null or missing means none yet.
    contractorId: id.nullable().optional(),
    startDate: nullableDate.optional(),
    targetDate: nullableDate.optional(),
    // Both or neither: a budget without a currency gets KWD.
    budgetMinor: budgetMinor.nullable().optional(),
    currency: currency.optional(),
  })
  .refine(targetNotBeforeStart, dateOrderIssue)
  .refine(
    (value) => value.currency === undefined || (value.budgetMinor ?? null) !== null,
    currencyNeedsBudgetIssue,
  );

// No defaults here: a field that is not sent must stay as it is.
export const updateVillaSchema = z
  .strictObject({
    villaNumber: text.optional(),
    ownerName: ownerName.nullable().optional(),
    villaType: villaType.nullable().optional(),
    areaId: id.optional(),
    block: text.optional(),
    plot: text.optional(),
    civilEngineerId: id.optional(),
    electricalEngineerId: id.nullable().optional(),
    contractorId: id.nullable().optional(),
    startDate: nullableDate.optional(),
    targetDate: nullableDate.optional(),
    // null removes the budget and its currency. A budget without a currency keeps the villa's, or gets KWD.
    budgetMinor: budgetMinor.nullable().optional(),
    currency: currency.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    error: "validation.atLeastOneField",
  })
  .refine(targetNotBeforeStart, dateOrderIssue)
  .refine((value) => value.currency === undefined || value.budgetMinor !== null, currencyNeedsBudgetIssue);

export const listVillasQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortVillasInvalid" }).optional(),
    area: text.optional(),
    areaId: z.uuid({ error: "validation.idInvalid" }).optional(),
    block: text.optional(),
    plot: text.optional(),
    civilEngineerId: z.uuid({ error: "validation.idInvalid" }).optional(),
    electricalEngineerId: z.uuid({ error: "validation.idInvalid" }).optional(),
    contractorId: z.uuid({ error: "validation.idInvalid" }).optional(),
    mewInspectionPassed: z
      .enum(["true", "false"], { error: "validation.booleanInvalid" })
      .transform((value) => value === "true")
      .optional(),
    mewInspection: z
      .enum(["true", "false"], { error: "validation.booleanInvalid" })
      .transform((value) => value === "true")
      .optional(),
    mewFollowUp: z
      .enum(["true", "false"], { error: "validation.booleanInvalid" })
      .transform((value) => value === "true")
      .optional(),
    villaType: villaType.optional(),
    startFrom: calendarDateField.optional(),
    startTo: calendarDateField.optional(),
    targetFrom: calendarDateField.optional(),
    targetTo: calendarDateField.optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.startFrom || !query.startTo || query.startFrom <= query.startTo, {
    error: "validation.dateRangeInvalid",
    path: ["startTo"],
  })
  .refine((query) => !query.targetFrom || !query.targetTo || query.targetFrom <= query.targetTo, {
    error: "validation.dateRangeInvalid",
    path: ["targetTo"],
  });

// The fields of a villa that are plain text, for the import to check a cell by the same rule as a request.
export { currency as villaCurrencyField, ownerName as villaOwnerNameField, text as villaTextField };

export type CreateVillaInput = z.output<typeof createVillaSchema>;
export type UpdateVillaInput = z.output<typeof updateVillaSchema>;
export type ListVillasQuery = z.output<typeof listVillasQuerySchema>;

// The villa's MEW states: either or both, each NOT_SUBMITTED, RUNNING or APPROVED.
const mewState = z.enum(MEW_STATES, { error: "validation.mewStateInvalid" });
// The villa's MEW details: either state, and the inspection day (YYYY-MM-DD, or null to clear it).
export const mewStatesSchema = z
  .strictObject({
    mewAcState: mewState.optional(),
    mewElecState: mewState.optional(),
    mewInspectionDate: nullableDate.optional(),
  })
  .refine(
    (value) =>
      value.mewAcState !== undefined ||
      value.mewElecState !== undefined ||
      value.mewInspectionDate !== undefined,
    {
      error: "validation.atLeastOneField",
    },
  );
export type MewStatesInput = z.output<typeof mewStatesSchema>;
