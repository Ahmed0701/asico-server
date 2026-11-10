import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import {
  isForeignKeyViolation,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../../shared/utils/index.js";
import type { MaterialItemDto } from "../dto/materials.dto.js";
import { toItemDto, toItemSnapshot } from "../mapper/materials.mapper.js";
import { ItemsRepository, type Db, type ItemRow } from "../repository/items.repository.js";
import type { CreateItemInput, ListItemsQuery, UpdateItemInput } from "../validators/materials.validators.js";

const ENTITY = "MaterialItem";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.materialItemNotFound"), "MATERIAL_ITEM_NOT_FOUND");

const taken = (ctx: RequestContext): AppError => {
  const message = t(ctx.locale, "errors.materialItemTaken");
  return new AppError(409, message, "MATERIAL_ITEM_TAKEN", [{ path: "name", message }]);
};

const inUse = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.materialItemInUse"), "MATERIAL_ITEM_IN_USE");

// The catalog of materials the deliveries pick their lines from.
export class ItemsService {
  constructor(private readonly repository = new ItemsRepository()) {}

  async list(query: ListItemsQuery): Promise<MaterialItemDto[]> {
    return (await this.repository.list(query.type)).map(toItemDto);
  }

  async create(actor: Actor, input: CreateItemInput, ctx: RequestContext): Promise<MaterialItemDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        await this.assertFree(input.type, input.name, undefined, ctx, tx);
        const created = await this.repository.create(input, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "material_item.create",
            entity: ENTITY,
            entityId: created.id,
            after: toItemSnapshot(created),
          }),
        );
        return created;
      });
      return toItemDto(row);
    } catch (err) {
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  // An item already on deliveries keeps its type: its lines were checked against their factory's type.
  async update(
    actor: Actor,
    id: string,
    input: UpdateItemInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<MaterialItemDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.type !== undefined && input.type !== target.type && target._count.lines > 0) {
          throw inUse(ctx);
        }
        await this.assertFree(input.type ?? target.type, input.name ?? target.name, id, ctx, tx);
        const updated = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.type !== undefined && { type: input.type }),
            ...(input.unit !== undefined && { unit: input.unit }),
            ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
            ...(input.requiredPerVilla !== undefined && { requiredPerVilla: input.requiredPerVilla }),
          },
          tx,
        );
        if (!updated) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "material_item.update",
            entity: ENTITY,
            entityId: id,
            before: toItemSnapshot(target),
            after: toItemSnapshot(updated),
          }),
        );
        return updated;
      });
      return toItemDto(row);
    } catch (err) {
      if (isRecordNotFound(err)) throw notFound(ctx);
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  // An item that a delivery brought cannot be deleted: the delivery would lose a line.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if ((await this.repository.countLines(id, tx)) > 0) throw inUse(ctx);
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "material_item.delete",
            entity: ENTITY,
            entityId: id,
            before: toItemSnapshot(target),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) throw notFound(ctx);
      throw isForeignKeyViolation(err) ? inUse(ctx) : err;
    }
  }

  private async assertFree(
    type: FactoryTypeValue,
    name: string,
    selfId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const existing = await this.repository.findByName(type, name, tx);
    if (existing && existing.id !== selfId) throw taken(ctx);
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ItemRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw notFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw notFound(ctx);
    return row;
  }
}
