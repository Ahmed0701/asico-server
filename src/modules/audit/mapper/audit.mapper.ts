import { redact } from "../../../core/audit/redact.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";
import type { AuditLogDetailDto, AuditLogListItemDto } from "../dto/audit.dto.js";
import { actionLabel } from "../dto/actions.js";
import { entityLabel } from "../dto/entities.js";
import type { AuditLogDetailRow, AuditLogListRow } from "../repository/audit.repository.js";

export type ItemView = { locale?: LocaleCode; entityName?: string | null; entityDetail?: string | null };

// The actor is null when the user is gone (the foreign key is SET NULL). Without a view the label is English and
// there is no entity name: that is how the audit export reads items, in English and by code.
export function toListItemDto(
  row: AuditLogListRow,
  { locale = "en", entityName = null, entityDetail = null }: ItemView = {},
): AuditLogListItemDto {
  return {
    id: row.id,
    actor: row.actor ? { id: row.actor.id, name: row.actor.name, email: row.actor.email } : null,
    action: row.action,
    actionLabel: actionLabel(row.action, locale),
    entity: entityLabel(row.entity, locale),
    entityCode: row.entity,
    entityId: row.entityId,
    entityName,
    entityDetail,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    // Date#toISOString is always UTC.
    createdAt: row.createdAt.toISOString(),
  };
}

// Values were already redacted when written. Redacting again is defence in depth, and idempotent.
export function toDetailDto(row: AuditLogDetailRow, view: ItemView = {}): AuditLogDetailDto {
  return {
    ...toListItemDto(row, view),
    before: redact(row.before) ?? null,
    after: redact(row.after) ?? null,
  };
}
