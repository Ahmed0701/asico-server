import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import {
  FOREMAN_MISSION_SORT_FIELDS,
  isForemanMissionSortField,
  type ForemanMissionDto,
  type ForemanMissionListResult,
  type ForemanMissionSort,
} from "../dto/foreman-missions.dto.js";
import { toForemanMissionDto, toForemanMissionSnapshot } from "../mapper/foreman-missions.mapper.js";
import {
  ForemanMissionsRepository,
  type Db,
  type ForemanMissionFields,
  type ForemanMissionRow,
} from "../repository/foreman-missions.repository.js";
import type {
  CreateForemanMissionInput,
  ListForemanMissionsQuery,
  UpdateForemanMissionInput,
} from "../validators/foreman-missions.validators.js";

// The newest note first.
const DEFAULT_SORT: ForemanMissionSort = { field: "createdAt", direction: "desc" };
const ENTITY = "ForemanMission";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.foremanMissionNotFound"), "FOREMAN_MISSION_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");

// The audit action of a change: checking or unchecking "done" alone has its own, anything else is an update.
function actionOf(input: UpdateForemanMissionInput): string {
  const onlyDone = Object.keys(input).every((key) => key === "done");
  let action = "foreman_mission.update";
  if (onlyDone && input.done === true) action = "foreman_mission.done";
  if (onlyDone && input.done === false) action = "foreman_mission.done_undo";
  return action;
}

export class ForemanMissionsService {
  constructor(
    private readonly repository = new ForemanMissionsRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListForemanMissionsQuery): Promise<ForemanMissionListResult> {
    const requested = parseSort(query.sort, FOREMAN_MISSION_SORT_FIELDS);
    const sort: ForemanMissionSort =
      requested && isForemanMissionSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total } = await this.repository.list({
      search: query.search,
      done: query.done,
      villaId: query.villaId,
      sort,
      skip,
      take,
    });
    return { items: rows.map(toForemanMissionDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<ForemanMissionDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toForemanMissionDto(row);
  }

  async create(
    actor: Actor,
    input: CreateForemanMissionInput,
    ctx: RequestContext,
  ): Promise<ForemanMissionDto> {
    const created = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.villaExists(input.villaId, tx))) {
        throw villaNotFound(ctx);
      }
      const row = await this.repository.create({ villaId: input.villaId, notes: input.notes }, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "foreman_mission.create",
          entity: ENTITY,
          entityId: row.id,
          after: toForemanMissionSnapshot(row),
        }),
      );
      return row;
    });
    return toForemanMissionDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateForemanMissionInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<ForemanMissionDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.villaId !== undefined && !(await this.repository.villaExists(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        const data: ForemanMissionFields = {
          ...(input.villaId !== undefined && { villaId: input.villaId }),
          ...(input.notes !== undefined && { notes: input.notes }),
        };
        // Checking an already done one keeps its time; unchecking clears it (and the reminders start again).
        if (input.done === true && target.doneAt === null) {
          data.doneAt = this.clock();
        } else if (input.done === false) {
          data.doneAt = null;
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
            before: toForemanMissionSnapshot(target),
            after: toForemanMissionSnapshot(row),
          }),
        );
        return row;
      });
      return toForemanMissionDto(updated);
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
            action: "foreman_mission.delete",
            entity: ENTITY,
            entityId: id,
            before: toForemanMissionSnapshot(target),
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
  ): Promise<ForemanMissionRow> {
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
