import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isWithinYears, toDay } from "../../../shared/utils/day.js";
import { alertWindow, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { foreignKeyConstraint, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  MAX_YEARS_AWAY,
  SMALL_WORK_SORT_FIELDS,
  isSmallWorkSortField,
  type SmallWorkDto,
  type SmallWorkListResult,
  type SmallWorkSort,
} from "../dto/small-works.dto.js";
import { toSmallWorkDto, toSnapshot, type DeadlineContext } from "../mapper/small-works.mapper.js";
import {
  SmallWorksRepository,
  type Db,
  type SmallWorkPatch,
  type SmallWorkRow,
} from "../repository/small-works.repository.js";
import type {
  CreateSmallWorkInput,
  ListSmallWorksQuery,
  UpdateSmallWorkInput,
} from "../validators/small-works.validators.js";

const ENTITY = "DailySmallWork";
const DEFAULT_SORT: SmallWorkSort = { field: "endDate", direction: "desc" };

// The fields a PATCH can change.
const PATCH_KEYS = ["contractorId", "startDate", "endDate", "description", "status"] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.smallWorkNotFound", "SMALL_WORK_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");

const contractorNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
// A contractor that is switched off cannot be given a small work. 400, as for any other value the request may not carry.
const contractorInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.smallWorkContractorInactive", "CONTRACTOR_INACTIVE");
// The range runs backwards. 422: each date is fine alone, the pair is not.
const dateRangeInvalid = (ctx: RequestContext): AppError =>
  fail(ctx, 422, "errors.smallWorkDateRange", "SMALL_WORK_DATE_RANGE_INVALID");
// A planned date far from today (a typo in the year). 400 on the field.
const dateOutOfRange = (ctx: RequestContext, field: "startDate" | "endDate"): AppError =>
  new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path: field, message: t(ctx.locale, "validation.plannedDateOutOfRange") },
  ]);

function patchOf(input: UpdateSmallWorkInput): SmallWorkPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as SmallWorkPatch;
}

export class SmallWorksService {
  // `clock` and `policy` are injectable so the bound on the dates, "overdue" and "due soon" can be tested at exact instants,
  // in any zone.
  constructor(
    private readonly repository = new SmallWorksRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: DeadlinePolicy = envDeadlinePolicy(),
  ) {}

  // The two days and the rules every DTO of one response is counted against.
  private deadlineContext(): DeadlineContext {
    return { window: alertWindow(this.clock(), this.policy), policy: this.policy };
  }

  async list(query: ListSmallWorksQuery): Promise<SmallWorkListResult> {
    const requested = parseSort(query.sort, SMALL_WORK_SORT_FIELDS);
    const sort: SmallWorkSort =
      requested && isSmallWorkSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const deadline = this.deadlineContext();

    const { rows, total } = await this.repository.list({
      filters: {
        villaId: query.villaId,
        contractorId: query.contractorId,
        status: query.status,
        startFrom: query.startFrom,
        startTo: query.startTo,
        endFrom: query.endFrom,
        endTo: query.endTo,
        overdue: query.overdue,
        dueSoon: query.dueSoon,
        alert: query.overdue === undefined && query.dueSoon === undefined ? undefined : deadline.window,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    return { items: rows.map((row) => toSmallWorkDto(row, deadline)), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<SmallWorkDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toSmallWorkDto(row, this.deadlineContext());
  }

  async create(actor: Actor, input: CreateSmallWorkInput, ctx: RequestContext): Promise<SmallWorkDto> {
    this.checkNewDates(input.startDate, input.endDate, ctx);
    try {
      const created = await this.repository.transaction(async (tx) => {
        // LOCK ORDER: the villa first (shared), so this takes turns with a delete of the villa.
        if (!(await this.repository.lockVillaShared(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        await this.requireUser(actor, ctx, tx);
        await this.requireActiveContractor(input.contractorId, ctx, tx);
        const row = await this.repository.create(
          {
            villaId: input.villaId,
            contractorId: input.contractorId,
            startDate: input.startDate,
            endDate: input.endDate,
            description: input.description,
            status: input.status ?? "PENDING",
            createdById: actor.id,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "small_work.create",
            entity: ENTITY,
            entityId: row.id,
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toSmallWorkDto(created, this.deadlineContext());
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateSmallWorkInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<SmallWorkDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const current = await this.lock(id, expectedVersion, ctx, tx);

        // A date is checked against today only when this request moves it: a row that is already saved stays saveable. The
        // order of the two is checked on the pair as it will be.
        for (const field of ["startDate", "endDate"] as const) {
          const moved = input[field];
          if (moved !== undefined && toDay(moved) !== toDay(current[field])) {
            this.checkWithinBound(moved, field, ctx);
          }
        }
        if (input.startDate !== undefined || input.endDate !== undefined) {
          this.checkOrder(input.startDate ?? current.startDate, input.endDate ?? current.endDate, ctx);
        }
        // The contractor is checked only when this request changes it: a row whose contractor was switched off since stays
        // saveable.
        if (input.contractorId !== undefined && input.contractorId !== current.contractorId) {
          await this.requireActiveContractor(input.contractorId, ctx, tx);
        }

        const row = await this.repository.update(id, current.version, patchOf(input), tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "small_work.update",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toSmallWorkDto(updated, this.deadlineContext());
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const current = await this.lock(id, expectedVersion, ctx, tx);
        if (!(await this.repository.delete(id, current.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "small_work.delete",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw err;
    }
  }

  // Takes the locks of a write to one small work in the one order everything uses (the villa, then the row), refuses a
  // version the caller did not read, and returns the row as it is now.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<SmallWorkRow> {
    const villaId = await this.repository.findVillaId(id, tx);
    if (villaId === null || !(await this.repository.lockVillaShared(villaId, tx))) {
      throw notFound(ctx);
    }
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) {
      throw notFound(ctx);
    }
    assertVersion(ctx.locale, expectedVersion, version);
    const current = await this.repository.findById(id, tx);
    if (!current) {
      throw notFound(ctx);
    }
    return current;
  }

  // Both dates of a new work: within the bound around today, and in order.
  private checkNewDates(startDate: Date, endDate: Date, ctx: RequestContext): void {
    this.checkWithinBound(startDate, "startDate", ctx);
    this.checkWithinBound(endDate, "endDate", ctx);
    this.checkOrder(startDate, endDate, ctx);
  }

  private checkWithinBound(day: Date, field: "startDate" | "endDate", ctx: RequestContext): void {
    if (!isWithinYears(day, this.clock(), MAX_YEARS_AWAY)) {
      throw dateOutOfRange(ctx, field);
    }
  }

  private checkOrder(startDate: Date, endDate: Date, ctx: RequestContext): void {
    if (endDate.getTime() < startDate.getTime()) {
      throw dateRangeInvalid(ctx);
    }
  }

  // The contractor must exist and be active. It does not have to be the villa's own.
  private async requireActiveContractor(contractorId: string, ctx: RequestContext, tx: Db): Promise<void> {
    const status = await this.repository.contractorStatus(contractorId, tx);
    if (status === null) {
      throw contractorNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw contractorInactive(ctx);
    }
  }

  // A row is saved with its creator: a user who is gone cannot be one.
  private async requireUser(actor: Actor, ctx: RequestContext, tx: Db): Promise<void> {
    if (!(await this.repository.userExists(actor.id, tx))) {
      throw fail(ctx, 401, "errors.unauthorized", "UNAUTHORIZED");
    }
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    const foreignKey = foreignKeyConstraint(err);
    if (foreignKey?.includes("villaId")) {
      throw villaNotFound(ctx);
    }
    // The contractor was deleted between the check and the write.
    if (foreignKey?.includes("contractorId")) {
      throw contractorNotFound(ctx);
    }
    if (isRecordNotFound(err)) {
      throw notFound(ctx);
    }
    throw err;
  }
}
