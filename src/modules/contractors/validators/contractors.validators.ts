import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { contactEmail, hasAnyField, name, partyStatus, phone } from "../../../shared/validation/fields.js";
import { CONTRACTOR_SORT_FIELDS, SUMMARY_SORT_FIELDS } from "../dto/contractors.dto.js";

// "name", "name:asc" or "name:desc", for the whitelisted fields only. Anything else is a 400, not ignored.
const sortPattern = (fields: readonly string[]) => new RegExp(`^(${fields.join("|")})(:(asc|desc))?$`);

export const listContractorsQuerySchema = paginationQuerySchema.extend({
  sort: z
    .string()
    .regex(sortPattern(CONTRACTOR_SORT_FIELDS), { error: "validation.sortNameCreatedAtInvalid" })
    .optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  status: partyStatus.optional(),
});

export const contractorSummaryQuerySchema = paginationQuerySchema.extend({
  sort: z
    .string()
    .regex(sortPattern(SUMMARY_SORT_FIELDS), { error: "validation.sortContractorVillasInvalid" })
    .optional(),
});

export const createContractorSchema = z.strictObject({
  name,
  phone,
  email: contactEmail.optional(),
  status: partyStatus.optional(),
});

export const updateContractorSchema = z
  .strictObject({
    name: name.optional(),
    phone: phone.optional(),
    email: contactEmail.optional(),
    status: partyStatus.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListContractorsQuery = z.output<typeof listContractorsQuerySchema>;
export type ContractorSummaryQuery = z.output<typeof contractorSummaryQuerySchema>;
export type CreateContractorInput = z.output<typeof createContractorSchema>;
export type UpdateContractorInput = z.output<typeof updateContractorSchema>;
