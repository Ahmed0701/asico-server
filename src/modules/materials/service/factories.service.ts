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
import type { FactoryDto } from "../dto/materials.dto.js";
import { toFactoryDto, toFactorySnapshot } from "../mapper/materials.mapper.js";
import { FactoriesRepository, type Db, type FactoryRow } from "../repository/factories.repository.js";
import type {
  CreateFactoryInput,
  ListFactoriesQuery,
  UpdateFactoryInput,
} from "../validators/materials.validators.js";

const ENTITY = "Factory";

export const factoryNotFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.factoryNotFound"), "FACTORY_NOT_FOUND");

const taken = (ctx: RequestContext): AppError => {
  const message = t(ctx.locale, "errors.factoryTaken");
  return new AppError(409, message, "FACTORY_TAKEN", [{ path: "name", message }]);
};

const hasDeliveries = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.factoryHasDeliveries"), "FACTORY_HAS_DELIVERIES");

export class FactoriesService {
  constructor(private readonly repository = new FactoriesRepository()) {}

  async list(query: ListFactoriesQuery): Promise<FactoryDto[]> {
    return (await this.repository.list(query.type)).map(toFactoryDto);
  }

  async create(actor: Actor, input: CreateFactoryInput, ctx: RequestContext): Promise<FactoryDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        await this.assertFree(input.type, input.name, undefined, ctx, tx);
        const created = await this.repository.create({ name: input.name, type: input.type }, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "factory.create",
            entity: ENTITY,
            entityId: created.id,
            after: toFactorySnapshot(created),
          }),
        );
        return created;
      });
      return toFactoryDto(row);
    } catch (err) {
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateFactoryInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<FactoryDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        await this.assertFree(input.type ?? target.type, input.name ?? target.name, id, ctx, tx);
        const updated = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.type !== undefined && { type: input.type }),
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
            action: "factory.update",
            entity: ENTITY,
            entityId: id,
            before: toFactorySnapshot(target),
            after: toFactorySnapshot(updated),
          }),
        );
        return updated;
      });
      return toFactoryDto(row);
    } catch (err) {
      if (isRecordNotFound(err)) throw factoryNotFound(ctx);
      throw uniqueViolationConstraint(err) !== undefined ? taken(ctx) : err;
    }
  }

  // A factory that delivered something cannot be deleted: its deliveries would lose where they came from.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if ((await this.repository.countDeliveries(id, tx)) > 0) {
          throw hasDeliveries(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "factory.delete",
            entity: ENTITY,
            entityId: id,
            before: toFactorySnapshot(target),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) throw factoryNotFound(ctx);
      throw isForeignKeyViolation(err) ? hasDeliveries(ctx) : err;
    }
  }

  // The name must not belong to another factory of the same type, ignoring case.
  private async assertFree(
    type: FactoryTypeValue,
    name: string,
    selfId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const existing = await this.repository.findByName(type, name, tx);
    if (existing && existing.id !== selfId) {
      throw taken(ctx);
    }
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<FactoryRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw factoryNotFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw factoryNotFound(ctx);
    return row;
  }
}
