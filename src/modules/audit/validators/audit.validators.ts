import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { dateField } from "../../../shared/validation/dates.js";
import { AUDIT_SORT_FIELDS } from "../dto/audit.dto.js";

// "createdAt", "createdAt:asc" or "createdAt:desc". Anything else is a 400, not ignored.
const sortPattern = new RegExp(`^(${AUDIT_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const text = z.string().trim().max(100, { error: "validation.invalid" });

export const listAuditLogsQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.auditSortInvalid" }).optional(),
    actorId: z.uuid({ error: "validation.idInvalid" }).optional(),
    action: text.optional(),
    entity: text.optional(),
    entityId: text.optional(),
    from: dateField("start").optional(),
    to: dateField("end").optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    error: "validation.dateRangeInvalid",
    path: ["to"],
  });

export type ListAuditLogsQuery = z.output<typeof listAuditLogsQuerySchema>;
