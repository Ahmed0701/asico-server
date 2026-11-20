import { z } from "zod";
import { FACTORY_TYPES } from "../../../shared/constants/enums.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { hasAnyField } from "../../../shared/validation/fields.js";

const uuid = z.uuid({ error: "validation.idInvalid" });

export const listVillaVendorsQuerySchema = paginationQuerySchema.extend({
  // Looks in the villa number, the location and the assigned factory names.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  // The villas a factory is assigned to.
  factoryId: uuid.optional(),
  // The villas with no factory of that type assigned yet.
  missing: z.enum(FACTORY_TYPES, { error: "validation.factoryTypeInvalid" }).optional(),
  sort: z
    .string()
    .regex(/^villaNumber(:(asc|desc))?$/, { error: "validation.sortVillaVendorsInvalid" })
    .optional(),
});

export const villaVendorsParams = z.strictObject({ villaId: uuid });

// Only what is sent changes; null takes the factory off the villa.
export const putVillaVendorsSchema = z
  .strictObject({
    switchgearFactoryId: uuid.nullable().optional(),
    cableFactoryId: uuid.nullable().optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListVillaVendorsQuery = z.output<typeof listVillaVendorsQuerySchema>;
export type PutVillaVendorsInput = z.output<typeof putVillaVendorsSchema>;
