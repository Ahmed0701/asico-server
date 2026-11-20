import { z } from "zod";
import { FACTORY_TYPES } from "../../../shared/constants/enums.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { MATERIAL_ORDER_SORT_FIELDS, MATERIAL_ORDER_STATUSES } from "../dto/material-orders.dto.js";

const factoryType = z.enum(FACTORY_TYPES, { error: "validation.factoryTypeInvalid" });
const sortPattern = new RegExp(`^(${MATERIAL_ORDER_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listMaterialOrdersQuerySchema = paginationQuerySchema.extend({
  // Looks in the villa number.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  type: factoryType.optional(),
  status: z.enum(MATERIAL_ORDER_STATUSES, { error: "validation.materialOrderStatusInvalid" }).optional(),
  // true: only the rows whose due date has passed with materials still to come.
  overdue: z
    .enum(["true", "false"], { error: "validation.booleanInvalid" })
    .transform((value) => value === "true")
    .optional(),
  sort: z.string().regex(sortPattern, { error: "validation.sortMaterialOrdersInvalid" }).optional(),
});

export const materialOrderParams = z.strictObject({
  villaId: z.uuid({ error: "validation.idInvalid" }),
  type: factoryType,
});

// The three dates, each a day or null (cleared). All three are sent: the row becomes what is sent.
export const setMaterialOrderSchema = z.strictObject({
  mrDate: calendarDateField.nullable(),
  poDate: calendarDateField.nullable(),
  dueDate: calendarDateField.nullable(),
});

export type ListMaterialOrdersQuery = z.output<typeof listMaterialOrdersQuerySchema>;
export type SetMaterialOrderInput = z.output<typeof setMaterialOrderSchema>;
