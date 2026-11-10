export { auditRouter } from "./routes/audit.routes.js";

// What the exports module reuses: the list query, exactly as the endpoint runs it.
export { AuditService } from "./service/audit.service.js";
export { listAuditLogsQuerySchema, type ListAuditLogsQuery } from "./validators/audit.validators.js";
export type { AuditLogListItemDto } from "./dto/audit.dto.js";

// What the dashboard reuses for its recent activity: the same select and the same list item mapping.
export { toListItemDto } from "./mapper/audit.mapper.js";
export { auditLogListSelect, type AuditLogListRow } from "./repository/audit.repository.js";
export { actionLabel } from "./dto/actions.js";
export { entityLabel, nameFromSnapshots } from "./dto/entities.js";
export type { EntityNameRow, EntityRef } from "./repository/audit.repository.js";
export { AuditRepository } from "./repository/audit.repository.js";
