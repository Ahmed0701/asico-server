import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import {
  isForeignKeyViolation,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../../shared/utils/index.js";
import {
  AREA_SORT_FIELDS,
  isAreaSortField,
  type AreaDto,
  type AreaListResult,
  type AreaOptionDto,
  type AreaSort,
} from "../dto/areas.dto.js";
import { toAreaDto, toOptionDto } from "../mapper/areas.mapper.js";
import { AreasRepository, type AreaRow, type Db } from "../repository/areas.repository.js";
import type { CreateAreaInput, ListAreasQuery, UpdateAreaInput } from "../validators/areas.validators.js";

const DEFAULT_SORT: AreaSort = { field: "name", direction: "asc" };
const ENTITY = "Area";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.areaNotFound"), "AREA_NOT_FOUND");

const taken = (ctx: RequestContext): AppError => {
  const message = t(ctx.locale, "errors.areaTaken");
  return new AppError(409, message, "AREA_TAKEN", [{ path: "name", message }]);
};

const hasVillas = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.areaHasVillas"), "AREA_HAS_VILLAS");

// What the audit entry records. The villa count is derived, so it is not part of it.
const snapshot = (row: Pick<AreaRow, "name" | "city">) => ({ name: row.name, city: row.city });

export class AreasService {
  constructor(private readonly repository = new AreasRepository()) {}

  async list(query: ListAreasQuery): Promise<AreaListResult> {
    const requested = parseSort(query.sort, AREA_SORT_FIELDS);
    const sort: AreaSort =
      requested && isAreaSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total } = await this.repository.list({ search: query.search, sort, skip, take });
    return { items: rows.map(toAreaDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<AreaOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<AreaDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toAreaDto(row);
  }

  async create(actor: Actor, input: CreateAreaInput, ctx: RequestContext): Promise<AreaDto> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        await this.assertFree(input.name, input.city, undefined, ctx, tx);
        const row = await this.repository.create({ name: input.name, city: input.city }, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "area.create",
            entity: ENTITY,
            entityId: row.id,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toAreaDto(created);
    } catch (err) {
      // Someone created the same area between the check above and the write: the unique index caught it.
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateAreaInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<AreaDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.name !== undefined || input.city !== undefined) {
          await this.assertFree(input.name ?? target.name, input.city ?? target.city, id, ctx, tx);
        }
        const before = snapshot(target);
        const row = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.city !== undefined && { city: input.city }),
          },
          tx,
        );
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "area.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toAreaDto(updated);
    } catch (err) {
      // Deleted between the lookup and the write, or the name was taken in that gap.
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  // An area that has villas cannot be deleted. The count is checked first for a clean answer; the foreign key is the
  // guarantee if a villa is added in the gap.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if ((await this.repository.countVillas(id, tx)) > 0) {
          throw hasVillas(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "area.delete",
            entity: ENTITY,
            entityId: id,
            before: snapshot(target),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw isForeignKeyViolation(err) ? hasVillas(ctx) : err;
    }
  }

  // The name must not belong to another area of the same city, ignoring case. The area being edited may keep its own.
  private async assertFree(
    name: string,
    city: string,
    selfId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const existing = await this.repository.findByNameAndCity(name, city, tx);
    if (existing && existing.id !== selfId) {
      throw taken(ctx);
    }
  }

  // Locks the area for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now: what the audit entry records as "before" is exactly what this write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<AreaRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) {
      throw notFound(ctx);
    }
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }
}
