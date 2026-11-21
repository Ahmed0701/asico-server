import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { contactEmail, hasAnyField, name, partyStatus, phone } from "../../../shared/validation/fields.js";
import { ELECTRICAL_ENGINEER_SORT_FIELDS } from "../dto/electrical-engineers.dto.js";

// "name", "name:asc" or "name:desc", for the whitelisted fields only. Anything else is a 400, not ignored.
const sortPattern = new RegExp(`^(${ELECTRICAL_ENGINEER_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listElectricalEngineersQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortNameCreatedAtInvalid" }).optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  status: partyStatus.optional(),
});

// The user account to link (null: none).
const userId = z.uuid({ error: "validation.idInvalid" }).nullable();

export const createElectricalEngineerSchema = z.strictObject({
  name,
  phone,
  email: contactEmail.optional(),
  status: partyStatus.optional(),
  userId: userId.optional(),
});

export const updateElectricalEngineerSchema = z
  .strictObject({
    name: name.optional(),
    phone: phone.optional(),
    email: contactEmail.optional(),
    status: partyStatus.optional(),
    userId: userId.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListElectricalEngineersQuery = z.output<typeof listElectricalEngineersQuerySchema>;
export type CreateElectricalEngineerInput = z.output<typeof createElectricalEngineerSchema>;
export type UpdateElectricalEngineerInput = z.output<typeof updateElectricalEngineerSchema>;

// Moves every villa of the engineer to another one.
export const transferVillasSchema = z.strictObject({
  toEngineerId: z.uuid({ error: "validation.idInvalid" }),
});

export type TransferVillasInput = z.output<typeof transferVillasSchema>;
