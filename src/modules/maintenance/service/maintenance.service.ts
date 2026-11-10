import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import {
  MAINTENANCE_SORT_FIELDS,
  isMaintenanceSortField,
  type MaintenanceDto,
  type MaintenanceListResult,
  type MaintenanceSort,
} from "../dto/maintenance.dto.js";
import { toMaintenanceDto, toMaintenanceSnapshot } from "../mapper/maintenance.mapper.js";
import {
  MaintenanceRepository,
  type Db,
  type MaintenanceFields,
  type MaintenanceRow,
} from "../repository/maintenance.repository.js";
import type {
  CreateMaintenanceInput,
  ListMaintenanceQuery,
  UpdateMaintenanceInput,
} from "../validators/maintenance.validators.js";

// The newest handover first: the villas handed over most recently are on top.
const DEFAULT_SORT: MaintenanceSort = { field: "handoverDate", direction: "desc" };
const ENTITY = "MaintenanceVilla";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.maintenanceNotFound"), "MAINTENANCE_NOT_FOUND");

// The audit action of a change: checking or unchecking "solved" alone has its own, anything else is an update.
function actionOf(input: UpdateMaintenanceInput): string {
  const onlySolved = Object.keys(input).every((key) => key === "solved");
  let action = "maintenance.update";
  if (onlySolved && input.solved === true) action = "maintenance.solved";
  if (onlySolved && input.solved === false) action = "maintenance.solved_undo";
  return action;
}

export class MaintenanceService {
  constructor(
    private readonly repository = new MaintenanceRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListMaintenanceQuery): Promise<MaintenanceListResult> {
    const requested = parseSort(query.sort, MAINTENANCE_SORT_FIELDS);
    const sort: MaintenanceSort =
      requested && isMaintenanceSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total } = await this.repository.list({
      search: query.search,
      solved: query.solved,
      sort,
      skip,
      take,
    });
    return { items: rows.map(toMaintenanceDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<MaintenanceDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toMaintenanceDto(row);
  }

  async create(actor: Actor, input: CreateMaintenanceInput, ctx: RequestContext): Promise<MaintenanceDto> {
    const created = await this.repository.transaction(async (tx) => {
      const row = await this.repository.create(
        {
          villaNumber: input.villaNumber,
          location: input.location,
          handoverDate: input.handoverDate,
          issue: input.issue,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "maintenance.create",
          entity: ENTITY,
          entityId: row.id,
          after: toMaintenanceSnapshot(row),
        }),
      );
      return row;
    });
    return toMaintenanceDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateMaintenanceInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<MaintenanceDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        const data: MaintenanceFields = {
          ...(input.villaNumber !== undefined && { villaNumber: input.villaNumber }),
          ...(input.location !== undefined && { location: input.location }),
          ...(input.handoverDate !== undefined && { handoverDate: input.handoverDate }),
          ...(input.issue !== undefined && { issue: input.issue }),
        };
        // Checking an already solved one keeps its time; unchecking clears it.
        if (input.solved === true && target.solvedAt === null) {
          data.solvedAt = this.clock();
        } else if (input.solved === false) {
          data.solvedAt = null;
        }
        const row = await this.repository.update(id, target.version, data, tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: actionOf(input),
            entity: ENTITY,
            entityId: id,
            before: toMaintenanceSnapshot(target),
            after: toMaintenanceSnapshot(row),
          }),
        );
        return row;
      });
      return toMaintenanceDto(updated);
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "maintenance.delete",
            entity: ENTITY,
            entityId: id,
            before: toMaintenanceSnapshot(target),
          }),
        );
      });
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
  }

  // Locks the row for this transaction, refuses a version the caller did not read, and returns the row as it is now.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<MaintenanceRow> {
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
