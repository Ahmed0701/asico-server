import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import { FOREMAN_MISSION_SORT_FIELDS } from "../dto/foreman-missions.dto.js";

// "createdAt", "createdAt:asc" or "villaNumber:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${FOREMAN_MISSION_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

const notes = z
  .string(required)
  .trim()
  .min(1, { error: "validation.foremanMissionNotesLength" })
  .max(4000, { error: "validation.foremanMissionNotesLength" });

const booleanQuery = z
  .enum(["true", "false"], { error: "validation.booleanInvalid" })
  .transform((value) => value === "true");

export const listForemanMissionsQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortForemanMissionsInvalid" }).optional(),
  // Looks in the villa number, the villa's owner name and the notes.
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  // true: only the done ones; false: only the open ones. Missing: all of them.
  done: booleanQuery.optional(),
  villaId: queryId.optional(),
});

// The owner name is not sent: it is the villa's.
export const createForemanMissionSchema = z.strictObject({ villaId: id, notes });

export const updateForemanMissionSchema = z
  .strictObject({
    villaId: id.optional(),
    notes: notes.optional(),
    // Checking it as done moves it to the done list and stops its reminders; unchecking moves it back.
    done: z.boolean({ error: "validation.booleanInvalid" }).optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export type ListForemanMissionsQuery = z.output<typeof listForemanMissionsQuerySchema>;
export type CreateForemanMissionInput = z.output<typeof createForemanMissionSchema>;
export type UpdateForemanMissionInput = z.output<typeof updateForemanMissionSchema>;
