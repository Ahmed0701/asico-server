import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isTooFarAhead, toDay } from "../../../shared/utils/day.js";
import {
  foreignKeyConstraint,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../../shared/utils/index.js";
import {
  DAILY_LABOUR_SORT_FIELDS,
  isDailyLabourSortField,
  type DailyLabourDto,
  type DailyLabourListResult,
  type DailyLabourSort,
} from "../dto/daily-labour.dto.js";
import { toDailyLabourDto, toSnapshot } from "../mapper/daily-labour.mapper.js";
import {
  DailyLabourRepository,
  type Db,
  type DailyLabourPatch,
  type DailyLabourRow,
} from "../repository/daily-labour.repository.js";
import type {
  CreateDailyLabourInput,
  ListDailyLabourQuery,
  UpdateDailyLabourInput,
} from "../validators/daily-labour.validators.js";

const ENTITY = "DailyLabour";
const DEFAULT_SORT: DailyLabourSort = { field: "labourDate", direction: "desc" };

// The fields a PATCH can change.
const PATCH_KEYS = ["labourDate", "contractorId", "labourCount", "notes"] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.dailyLabourNotFound", "DAILY_LABOUR_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const contractorNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
// One row per villa, contractor and day: the unique index has the last word, so this is also the answer to a race.
const exists = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.dailyLabourExists", "DAILY_LABOUR_EXISTS");
// A contractor that is switched off cannot be put on a labour row. 400, as for any other value the request may not carry.
const contractorInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.labourContractorInactive", "CONTRACTOR_INACTIVE");
// The contractor of a labour row is the villa's one contractor. 422: the request is well formed but does not fit the villa.
const contractorNotOnVilla = (ctx: RequestContext): AppError =>
  fail(ctx, 422, "errors.contractorNotOnVilla", "CONTRACTOR_NOT_ON_VILLA");

const futureDate = (ctx: RequestContext): AppError =>
  new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path: "labourDate", message: t(ctx.locale, "validation.labourDateFuture") },
  ]);

function patchOf(input: UpdateDailyLabourInput): DailyLabourPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as DailyLabourPatch;
}

export class DailyLabourService {
  // `clock` is injectable so the future-date rule can be tested at exact instants.
  constructor(
    private readonly repository = new DailyLabourRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListDailyLabourQuery): Promise<DailyLabourListResult> {
    const requested = parseSort(query.sort, DAILY_LABOUR_SORT_FIELDS);
    const sort: DailyLabourSort =
      requested && isDailyLabourSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      filters: {
        villaId: query.villaId,
        contractorId: query.contractorId,
        labourFrom: query.labourFrom,
        labourTo: query.labourTo,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    return { items: rows.map(toDailyLabourDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<DailyLabourDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toDailyLabourDto(row);
  }

  async create(actor: Actor, input: CreateDailyLabourInput, ctx: RequestContext): Promise<DailyLabourDto> {
    if (isTooFarAhead(input.labourDate, this.clock())) {
      throw futureDate(ctx);
    }
    try {
      const created = await this.repository.transaction(async (tx) => {
        // LOCK ORDER: the villa first (shared), so this takes turns with a delete of the villa and with a change of its
        // contractor.
        const villa = await this.repository.lockVillaShared(input.villaId, tx);
        if (!villa) {
          throw villaNotFound(ctx);
        }
        await this.requireVillaContractor(input.contractorId, villa.contractorId, ctx, tx);
        const row = await this.repository.create(
          {
            villaId: input.villaId,
            labourDate: input.labourDate,
            contractorId: input.contractorId,
            labourCount: input.labourCount,
            notes: input.notes ?? null,
            createdById: actor.id,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "daily_labour.create",
            entity: ENTITY,
            entityId: row.id,
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toDailyLabourDto(created);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateDailyLabourInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<DailyLabourDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const { current, villaContractorId } = await this.lock(id, expectedVersion, ctx, tx);

        // The date is checked only when this request moves it: a labour row that is already saved stays saveable.
        if (
          input.labourDate !== undefined &&
          toDay(input.labourDate) !== toDay(current.labourDate) &&
          isTooFarAhead(input.labourDate, this.clock())
        ) {
          throw futureDate(ctx);
        }
        // The contractor is checked only when this request sets or changes it: a row whose villa moved to another
        // contractor since stays valid and can still be saved.
        if (input.contractorId !== undefined && input.contractorId !== current.contractorId) {
          await this.requireVillaContractor(input.contractorId, villaContractorId, ctx, tx);
        }

        const row = await this.repository.update(id, current.version, patchOf(input), tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "daily_labour.update",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toDailyLabourDto(updated);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const { current } = await this.lock(id, expectedVersion, ctx, tx);
        if (!(await this.repository.delete(id, current.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "daily_labour.delete",
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

  // Takes the locks of a write to one labour row in the one order everything uses (the villa, then the row), refuses a
  // version the caller did not read, and returns the row as it is now with the villa's contractor.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<{ current: DailyLabourRow; villaContractorId: string | null }> {
    const villaId = await this.repository.findVillaId(id, tx);
    if (villaId === null) {
      throw notFound(ctx);
    }
    const villa = await this.repository.lockVillaShared(villaId, tx);
    if (!villa) {
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
    return { current, villaContractorId: villa.contractorId };
  }

  // The contractor must exist, be the villa's one contractor, and be active.
  private async requireVillaContractor(
    contractorId: string,
    villaContractorId: string | null,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const status = await this.repository.contractorStatus(contractorId, tx);
    if (status === null) {
      throw contractorNotFound(ctx);
    }
    if (contractorId !== villaContractorId) {
      throw contractorNotOnVilla(ctx);
    }
    if (status === "INACTIVE") {
      throw contractorInactive(ctx);
    }
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    // The only unique index besides the id is the one on (villa, contractor, day), and its name ends in the day.
    if (uniqueViolationConstraint(err)?.includes("labourDate")) {
      throw exists(ctx);
    }
    const foreignKey = foreignKeyConstraint(err);
    if (foreignKey?.includes("villaId")) {
      throw villaNotFound(ctx);
    }
    if (foreignKey?.includes("contractorId")) {
      throw contractorNotFound(ctx);
    }
    if (isRecordNotFound(err)) {
      throw notFound(ctx);
    }
    throw err;
  }
}
