import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";

// ?unread=true lists only the notifications the user has not read; false and no value list all of them.
export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(["true", "false"], { error: "validation.booleanInvalid" })
    .transform((value) => value === "true")
    .optional(),
});

export type ListNotificationsQuery = z.output<typeof listNotificationsQuerySchema>;
