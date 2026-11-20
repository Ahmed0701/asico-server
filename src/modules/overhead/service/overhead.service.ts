import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import {
  OVERHEAD_SORT_FIELDS,
  type OverheadEmployeeDto,
  type OverheadListResult,
  type OverheadRole,
  type OverheadSort,
  type OverheadSortField,
} from "../dto/overhead.dto.js";
import {
  OverheadRepository,
  type Db,
  type OverheadFields,
  type OverheadRow,
} from "../repository/overhead.repository.js";
import type {
  CreateOverheadInput,
  ListOverheadQuery,
  UpdateOverheadInput,
} from "../validators/overhead.validators.js";

const ENTITY = "OverheadEmployee";
const DEFAULT_SORT: OverheadSort = { field: "name", direction: "asc" };

const notFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.overheadNotFound"), "OVERHEAD_EMPLOYEE_NOT_FOUND");

export function toOverheadDto(row: OverheadRow): OverheadEmployeeDto {
  return {
    id: row.id,
    name: row.name,
    // The database only holds one of OVERHEAD_ROLES (a CHECK constraint).
    role: row.role as OverheadRole,
    salaryMinor: Number(row.salaryMinor),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
const snapshotOf = (row: OverheadRow) => ({
  name: row.name,
  role: row.role,
  salaryMinor: Number(row.salaryMinor),
});

export class OverheadService {
  constructor(private readonly repository = new OverheadRepository()) {}

  async list(query: ListOverheadQuery): Promise<OverheadListResult> {
    const requested = parseSort(query.sort, OVERHEAD_SORT_FIELDS);
    const sort: OverheadSort = requested
      ? { field: requested.field as OverheadSortField, direction: requested.direction }
      : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total, salaries } = await this.repository.list({ search: query.search, sort, skip, take });
    return {
      items: rows.map(toOverheadDto),
      meta: buildMeta(page, limit, total),
      totals: { count: total, monthlySalaryMinor: Number(salaries) },
    };
  }

  async get(id: string, ctx: RequestContext): Promise<OverheadEmployeeDto> {
    const row = await this.repository.findById(id);
    if (!row) throw notFound(ctx);
    return toOverheadDto(row);
  }

  async create(actor: Actor, input: CreateOverheadInput, ctx: RequestContext): Promise<OverheadEmployeeDto> {
    const row = await this.repository.transaction(async (tx) => {
      const created = await this.repository.create(
        { name: input.name, role: input.role, salaryMinor: BigInt(input.salaryMinor) },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "overhead.create",
          entity: ENTITY,
          entityId: created.id,
          after: snapshotOf(created),
        }),
      );
      return created;
    });
    return toOverheadDto(row);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateOverheadInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<OverheadEmployeeDto> {
    const row = await this.repository.transaction(async (tx) => {
      const before = await this.lock(id, expectedVersion, ctx, tx);
      const data: OverheadFields = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.salaryMinor !== undefined && { salaryMinor: BigInt(input.salaryMinor) }),
      };
      const after = await this.repository.update(id, before.version, data, tx);
      if (!after)
        throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? before.version);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "overhead.update",
          entity: ENTITY,
          entityId: id,
          before: snapshotOf(before),
          after: snapshotOf(after),
        }),
      );
      return after;
    });
    return toOverheadDto(row);
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const before = await this.lock(id, expectedVersion, ctx, tx);
      if (!(await this.repository.delete(id, before.version, tx))) {
        throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? before.version);
      }
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "overhead.delete",
          entity: ENTITY,
          entityId: id,
          before: snapshotOf(before),
        }),
      );
    });
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<OverheadRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw notFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw notFound(ctx);
    return row;
  }
}
