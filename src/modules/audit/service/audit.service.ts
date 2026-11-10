import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import {
  AUDIT_SORT_FIELDS,
  type AuditFiltersDto,
  type AuditLogDetailDto,
  type AuditLogListResult,
  type AuditSort,
} from "../dto/audit.dto.js";
import { actionLabel, KNOWN_ACTIONS } from "../dto/actions.js";
import { ENTITY_LABEL_KEYS, entityLabel } from "../dto/entities.js";
import { toDetailDto, toListItemDto } from "../mapper/audit.mapper.js";
import { AuditRepository, type EntityRef } from "../repository/audit.repository.js";
import type { ListAuditLogsQuery } from "../validators/audit.validators.js";

const DEFAULT_SORT: AuditSort = { field: "createdAt", direction: "desc" };

export class AuditService {
  constructor(private readonly repository = new AuditRepository()) {}

  // With a request context the items are in that language and carry the entity's name. Without one (the audit
  // export) they are in English, by code, and no names are looked up.
  async list(query: ListAuditLogsQuery, ctx?: RequestContext): Promise<AuditLogListResult> {
    const requested = parseSort(query.sort, AUDIT_SORT_FIELDS);
    const sort: AuditSort = requested ? { field: "createdAt", direction: requested.direction } : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      filters: {
        actorId: query.actorId,
        action: query.action,
        entity: query.entity,
        entityId: query.entityId,
        from: query.from,
        to: query.to,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    const refs = ctx ? await this.repository.entityRefs(rows) : new Map<string, EntityRef>();
    return {
      items: rows.map((row) =>
        toListItemDto(row, {
          ...(ctx && { locale: ctx.locale }),
          entityName: refs.get(row.id)?.name ?? null,
          entityDetail: refs.get(row.id)?.detail ?? null,
        }),
      ),
      meta: buildMeta(page, limit, total),
    };
  }

  async get(id: string, ctx: RequestContext): Promise<AuditLogDetailDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new AppError(404, t(ctx.locale, "errors.auditLogNotFound"), "AUDIT_LOG_NOT_FOUND");
    }
    // The detail already holds the snapshots, so they are used as they are rather than fetched again.
    const ref = (await this.repository.entityRefs([row])).get(row.id);
    return toDetailDto(row, {
      locale: ctx.locale,
      entityName: ref?.name ?? null,
      entityDetail: ref?.detail ?? null,
    });
  }

  async filters(ctx: RequestContext): Promise<AuditFiltersDto> {
    const options = await this.repository.filterOptions();
    // Everything the application knows comes first (so an action nobody has done yet can still be chosen), then what only the log holds.
    const actions = [...new Set([...KNOWN_ACTIONS, ...options.actions])].sort();
    const entities = [...new Set([...Object.keys(ENTITY_LABEL_KEYS), ...options.entities])].sort();
    return {
      actions,
      actionLabels: Object.fromEntries(actions.map((code) => [code, actionLabel(code, ctx.locale)])),
      entities,
      entityLabels: Object.fromEntries(entities.map((code) => [code, entityLabel(code, ctx.locale)])),
      actors: options.actors,
    };
  }
}
