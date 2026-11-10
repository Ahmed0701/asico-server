import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { contactEmail, hasAnyField, name, partyStatus, phone } from "../../../shared/validation/fields.js";
import { CIVIL_ENGINEER_SORT_FIELDS } from "../dto/civil-engineers.dto.js";

// "name", "name:asc" or "name:desc", for the whitelisted fields only. Anything else is a 400, not ignored.
const sortPattern = new RegExp(`^(${CIVIL_ENGINEER_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listCivilEngineersQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortNameCreatedAtInvalid" }).optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  status: partyStatus.optional(),
});

export const createCivilEngineerSchema = z.strictObject({
  name,
  phone,
  email: contactEmail.optional(),
  status: partyStatus.optional(),
});

export const updateCivilEngineerSchema = z
  .strictObject({
    name: name.optional(),
    phone: phone.optional(),
    email: contactEmail.optional(),
    status: partyStatus.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListCivilEngineersQuery = z.output<typeof listCivilEngineersQuerySchema>;
export type CreateCivilEngineerInput = z.output<typeof createCivilEngineerSchema>;
export type UpdateCivilEngineerInput = z.output<typeof updateCivilEngineerSchema>;
