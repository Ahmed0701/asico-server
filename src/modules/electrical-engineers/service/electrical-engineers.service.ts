import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isForeignKeyViolation, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  ELECTRICAL_ENGINEER_SORT_FIELDS,
  isElectricalEngineerSortField,
  type ElectricalEngineerDto,
  type ElectricalEngineerListResult,
  type ElectricalEngineerOptionDto,
  type ElectricalEngineerSort,
} from "../dto/electrical-engineers.dto.js";
import { toElectricalEngineerDto, toOptionDto } from "../mapper/electrical-engineers.mapper.js";
import {
  ElectricalEngineersRepository,
  type Db,
  type ElectricalEngineerRow,
} from "../repository/electrical-engineers.repository.js";
import type {
  CreateElectricalEngineerInput,
  ListElectricalEngineersQuery,
  UpdateElectricalEngineerInput,
} from "../validators/electrical-engineers.validators.js";

const DEFAULT_SORT: ElectricalEngineerSort = { field: "name", direction: "asc" };
const ENTITY = "ElectricalEngineer";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.electricalEngineerNotFound"), "ELECTRICAL_ENGINEER_NOT_FOUND");

const inUse = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.electricalEngineerInUse"), "ELECTRICAL_ENGINEER_IN_USE");

const snapshot = (row: Pick<ElectricalEngineerRow, "name" | "phone" | "email" | "status">) => ({
  name: row.name,
  phone: row.phone,
  email: row.email,
  status: row.status,
});

export class ElectricalEngineersService {
  constructor(private readonly repository = new ElectricalEngineersRepository()) {}

  async list(query: ListElectricalEngineersQuery): Promise<ElectricalEngineerListResult> {
    const requested = parseSort(query.sort, ELECTRICAL_ENGINEER_SORT_FIELDS);
    const sort: ElectricalEngineerSort =
      requested && isElectricalEngineerSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      search: query.search,
      status: query.status,
      sort,
      skip,
      take,
    });
    return { items: rows.map(toElectricalEngineerDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<ElectricalEngineerOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<ElectricalEngineerDto> {
    return toElectricalEngineerDto(await this.requireEngineer(id, ctx));
  }

  async create(
    actor: Actor,
    input: CreateElectricalEngineerInput,
    ctx: RequestContext,
  ): Promise<ElectricalEngineerDto> {
    const created = await this.repository.transaction(async (tx) => {
      const row = await this.repository.create(
        {
          name: input.name,
          phone: input.phone,
          email: input.email ?? null,
          status: input.status ?? "ACTIVE",
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "electrical_engineer.create",
          entity: ENTITY,
          entityId: row.id,
          after: snapshot(row),
        }),
      );
      return row;
    });
    return toElectricalEngineerDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateElectricalEngineerInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<ElectricalEngineerDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        const before = snapshot(target);
        const row = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.phone !== undefined && { phone: input.phone }),
            ...(input.email !== undefined && { email: input.email }),
            ...(input.status !== undefined && { status: input.status }),
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
            action: "electrical_engineer.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toElectricalEngineerDto(updated);
    } catch (err) {
      // Someone deleted it between the lookup above and the write.
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw err;
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        // Villas and the daily reports the engineer prepared both keep an engineer from being deleted.
        if (target._count.villas > 0 || target._count.dailyReports > 0) {
          throw inUse(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "electrical_engineer.delete",
            entity: ENTITY,
            entityId: id,
            before: snapshot(target),
          }),
        );
      });
    } catch (err) {
      // A villa was linked after the check above: the foreign key (onDelete: Restrict) still stops the delete.
      if (isForeignKeyViolation(err)) {
        throw inUse(ctx);
      }
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw err;
    }
  }

  // Locks the engineer for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now: what the audit entry records as "before" is exactly what this write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ElectricalEngineerRow> {
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

  private async requireEngineer(id: string, ctx: RequestContext): Promise<ElectricalEngineerRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }
}
