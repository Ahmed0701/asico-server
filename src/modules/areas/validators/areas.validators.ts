import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { city, hasAnyField, name } from "../../../shared/validation/fields.js";
import { AREA_SORT_FIELDS } from "../dto/areas.dto.js";

// "name", "name:asc" or "villaCount:desc", for the whitelisted fields only. Anything else is a 400, not ignored.
const sortPattern = new RegExp(`^(${AREA_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listAreasQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortAreasInvalid" }).optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
});

export const createAreaSchema = z.strictObject({ name, city });

export const updateAreaSchema = z
  .strictObject({ name: name.optional(), city: city.optional() })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListAreasQuery = z.output<typeof listAreasQuerySchema>;
export type CreateAreaInput = z.output<typeof createAreaSchema>;
export type UpdateAreaInput = z.output<typeof updateAreaSchema>;
