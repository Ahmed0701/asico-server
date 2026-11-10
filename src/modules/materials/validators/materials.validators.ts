import { z } from "zod";
import { FACTORY_TYPES } from "../../../shared/constants/enums.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { BALANCE_STATUSES, DELIVERY_SORT_FIELDS, MAX_LINES, NOTE_TYPES } from "../dto/materials.dto.js";

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const factoryType = z.enum(FACTORY_TYPES, { error: "validation.factoryTypeInvalid" });
const booleanQuery = z
  .enum(["true", "false"], { error: "validation.booleanInvalid" })
  .transform((value) => value === "true");
const sortPattern = new RegExp(`^(${DELIVERY_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const text = (max: number, error: string) => z.string(required).trim().min(1, { error }).max(max, { error });

// More than zero, at most two decimals, and below 10 billion (DECIMAL(12,2)).
const quantity = z
  .number({ error: "validation.quantityInvalid" })
  .refine(
    (value) => Number.isFinite(value) && value > 0 && value < 1e10 && Math.round(value * 100) === value * 100,
    {
      error: "validation.quantityInvalid",
    },
  );

export const idParams = z.strictObject({ id });
export const villaIdParams = z.strictObject({ id });
export const noteParams = z.strictObject({ id, noteId: id });

export const listFactoriesQuerySchema = z.strictObject({ type: factoryType.optional() });

const factoryName = text(120, "validation.factoryNameLength");
export const createFactorySchema = z.strictObject({ name: factoryName, type: factoryType });
export const updateFactorySchema = z
  .strictObject({ name: factoryName.optional(), type: factoryType.optional() })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

// Zero or more, at most two decimals (a required quantity: 0 means not needed).
const requiredQuantity = z
  .number({ error: "validation.requiredInvalid" })
  .refine(
    (value) =>
      Number.isFinite(value) && value >= 0 && value < 1e10 && Math.round(value * 100) === value * 100,
    { error: "validation.requiredInvalid" },
  );

// The catalog of materials.
export const listItemsQuerySchema = z.strictObject({ type: factoryType.optional() });

const itemName = text(120, "validation.itemNameLength");
const unit = text(20, "validation.unitLength");
const sortOrder = z
  .number({ error: "validation.sortOrderInvalid" })
  .int({ error: "validation.sortOrderInvalid" })
  .min(0, { error: "validation.sortOrderInvalid" })
  .max(100_000, { error: "validation.sortOrderInvalid" });

export const createItemSchema = z.strictObject({
  name: itemName,
  type: factoryType,
  // Pieces unless said otherwise.
  unit: unit.default("pcs"),
  sortOrder: sortOrder.optional(),
  requiredPerVilla: requiredQuantity.optional(),
});
export const updateItemSchema = z
  .strictObject({
    name: itemName.optional(),
    type: factoryType.optional(),
    unit: unit.optional(),
    sortOrder: sortOrder.optional(),
    requiredPerVilla: requiredQuantity.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const listDeliveriesQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortDeliveriesInvalid" }).optional(),
  // Looks in the materials of the lines, the delivery note number, the factory and the villa number.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  villaId: id.optional(),
  factoryId: id.optional(),
  // Only the deliveries that brought this catalog item.
  itemId: id.optional(),
  type: factoryType.optional(),
  deliveryFrom: calendarDateField.optional(),
  deliveryTo: calendarDateField.optional(),
  // true: only the deliveries that have their delivery note; false: only the ones still missing it.
  hasNote: booleanQuery.optional(),
});

// The balance list: one row per villa and material it needs or received.
export const listBalanceQuerySchema = paginationQuerySchema.extend({
  // Looks in the villa number.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  villaId: id.optional(),
  itemId: id.optional(),
  type: factoryType.optional(),
  // PENDING: still to come (the balance list); COMPLETE: all here; OVER: more came than needed.
  status: z.enum(BALANCE_STATUSES, { error: "validation.balanceStatusInvalid" }).optional(),
});

// A villa's own quantities: null gives an item back the catalog's quantity.
export const villaRequirementsSchema = z.strictObject({
  items: z
    .array(z.strictObject({ itemId: id, quantity: requiredQuantity.nullable() }), {
      error: "validation.linesRequired",
    })
    .min(1, { error: "validation.linesRequired" })
    .max(200, { error: "validation.linesTooMany" })
    .refine((list) => new Set(list.map((row) => row.itemId)).size === list.length, {
      error: "validation.linesDuplicate",
    }),
});

const noteNumber = text(50, "validation.noteNumberLength");

// The materials of a delivery: at least one, each catalog item once.
const lines = z
  .array(z.strictObject({ itemId: id, quantity }), { error: "validation.linesRequired" })
  .min(1, { error: "validation.linesRequired" })
  .max(MAX_LINES, { error: "validation.linesTooMany" })
  .refine((list) => new Set(list.map((line) => line.itemId)).size === list.length, {
    error: "validation.linesDuplicate",
  });

export const createDeliverySchema = z.strictObject({
  villaId: id,
  factoryId: id,
  lines,
  noteNumber: noteNumber.nullable().optional(),
  deliveryDate: calendarDateField,
});

// `lines`, when given, replaces all the lines of the delivery.
export const updateDeliverySchema = z
  .strictObject({
    villaId: id.optional(),
    factoryId: id.optional(),
    lines: lines.optional(),
    noteNumber: noteNumber.nullable().optional(),
    deliveryDate: calendarDateField.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListFactoriesQuery = z.output<typeof listFactoriesQuerySchema>;
export type CreateFactoryInput = z.output<typeof createFactorySchema>;
export type UpdateFactoryInput = z.output<typeof updateFactorySchema>;
export type ListItemsQuery = z.output<typeof listItemsQuerySchema>;
export type CreateItemInput = z.output<typeof createItemSchema>;
export type UpdateItemInput = z.output<typeof updateItemSchema>;
export type ListBalanceQuery = z.output<typeof listBalanceQuerySchema>;
export type VillaRequirementsInput = z.output<typeof villaRequirementsSchema>;
export type ListDeliveriesQuery = z.output<typeof listDeliveriesQuerySchema>;
export type CreateDeliveryInput = z.output<typeof createDeliverySchema>;
export type UpdateDeliveryInput = z.output<typeof updateDeliverySchema>;

// The type of a delivery note from its first bytes, or undefined when it is none of the accepted ones.
export function noteTypeOf(head: Buffer): (typeof NOTE_TYPES)[number] | undefined {
  return NOTE_TYPES.find(
    (type) =>
      head.length >= type.signature.length && head.subarray(0, type.signature.length).equals(type.signature),
  );
}

// Control characters and invisible format characters (bidi overrides, zero width spaces) can disguise a name; the
// joiners stay, Arabic names use them.
const STRIP = /[\p{Cc}\p{Zl}\p{Zp}]|(?![‌‍])\p{Cf}/gu;

// The name is only stored and sent back in a header, never used as a path: the last path segment, cleaned, at most
// 200 characters, ending in the extension of the type the file really is.
export function noteFileName(raw: string, extension: string): string {
  const last = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const stem = Array.from(
    last
      .replace(STRIP, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, ""),
  )
    .slice(0, 200)
    .join("")
    .trim();
  return `${stem || "delivery-note"}.${extension}`;
}
