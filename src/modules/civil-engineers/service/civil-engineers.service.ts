import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isForeignKeyViolation, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  CIVIL_ENGINEER_SORT_FIELDS,
  isCivilEngineerSortField,
  type CivilEngineerDto,
  type CivilEngineerListResult,
  type CivilEngineerOptionDto,
  type CivilEngineerSort,
} from "../dto/civil-engineers.dto.js";
import { toCivilEngineerDto, toOptionDto } from "../mapper/civil-engineers.mapper.js";
import {
  CivilEngineersRepository,
  type CivilEngineerRow,
  type Db,
} from "../repository/civil-engineers.repository.js";
import type {
  CreateCivilEngineerInput,
  ListCivilEngineersQuery,
  UpdateCivilEngineerInput,
} from "../validators/civil-engineers.validators.js";

const DEFAULT_SORT: CivilEngineerSort = { field: "name", direction: "asc" };
const ENTITY = "CivilEngineer";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.civilEngineerNotFound", "CIVIL_ENGINEER_NOT_FOUND");
const hasVillas = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.civilEngineerHasVillas", "CIVIL_ENGINEER_HAS_VILLAS");

const snapshot = (row: Pick<CivilEngineerRow, "name" | "phone" | "email" | "status">) => ({
  name: row.name,
  phone: row.phone,
  email: row.email,
  status: row.status,
});

export class CivilEngineersService {
  constructor(private readonly repository = new CivilEngineersRepository()) {}

  async list(query: ListCivilEngineersQuery): Promise<CivilEngineerListResult> {
    const requested = parseSort(query.sort, CIVIL_ENGINEER_SORT_FIELDS);
    const sort: CivilEngineerSort =
      requested && isCivilEngineerSortField(requested.field)
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
    return { items: rows.map(toCivilEngineerDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<CivilEngineerOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<CivilEngineerDto> {
    return toCivilEngineerDto(await this.requireEngineer(id, ctx));
  }

  async create(
    actor: Actor,
    input: CreateCivilEngineerInput,
    ctx: RequestContext,
  ): Promise<CivilEngineerDto> {
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
          action: "civil_engineer.create",
          entity: ENTITY,
          entityId: row.id,
          after: snapshot(row),
        }),
      );
      return row;
    });
    return toCivilEngineerDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateCivilEngineerInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<CivilEngineerDto> {
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
            action: "civil_engineer.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toCivilEngineerDto(updated);
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
        if (target._count.villas > 0) {
          throw hasVillas(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "civil_engineer.delete",
            entity: ENTITY,
            entityId: id,
            before: snapshot(target),
          }),
        );
      });
    } catch (err) {
      // A villa was linked after the check above: the foreign key (onDelete: Restrict) still stops the delete.
      if (isForeignKeyViolation(err)) {
        throw hasVillas(ctx);
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
  ): Promise<CivilEngineerRow> {
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

  private async requireEngineer(id: string, ctx: RequestContext): Promise<CivilEngineerRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }
}
