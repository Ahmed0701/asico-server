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
  DAILY_REPORT_SORT_FIELDS,
  isDailyReportSortField,
  type DailyReportDto,
  type DailyReportListResult,
  type DailyReportSort,
} from "../dto/daily-reports.dto.js";
import { toDailyReportDto, toSnapshot } from "../mapper/daily-reports.mapper.js";
import {
  DailyReportsRepository,
  type Db,
  type DailyReportPatch,
  type DailyReportRow,
} from "../repository/daily-reports.repository.js";
import type {
  CreateDailyReportInput,
  ListDailyReportsQuery,
  UpdateDailyReportInput,
} from "../validators/daily-reports.validators.js";

const ENTITY = "DailyReport";
const DEFAULT_SORT: DailyReportSort = { field: "reportDate", direction: "desc" };

// The fields a PATCH can change.
const PATCH_KEYS = [
  "contractorId",
  "preparedByEngineerId",
  "reportDate",
  "weather",
  "workersCount",
  "notes",
] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.dailyReportNotFound", "DAILY_REPORT_NOT_FOUND");
const contractorNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
const engineerNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.electricalEngineerNotFound", "ELECTRICAL_ENGINEER_NOT_FOUND");
// One report per contractor per day: the unique index has the last word, so this is also the answer to a race.
const exists = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.dailyReportExists", "DAILY_REPORT_EXISTS");
// A contractor or an engineer that is switched off cannot be put on a report. 400, as for any other value the request may not
// carry.
const contractorInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.reportContractorInactive", "CONTRACTOR_INACTIVE");
const engineerInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.reportEngineerInactive", "ELECTRICAL_ENGINEER_INACTIVE");

const futureDate = (ctx: RequestContext): AppError =>
  new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path: "reportDate", message: t(ctx.locale, "validation.reportDateFuture") },
  ]);

// The rule itself lives in shared/utils/day.ts (the small works use it too); the tests of this module import it from here.
export { isTooFarAhead };

function patchOf(input: UpdateDailyReportInput): DailyReportPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as DailyReportPatch;
}

export class DailyReportsService {
  // `clock` is injectable so the future-date rule can be tested at exact instants.
  constructor(
    private readonly repository = new DailyReportsRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListDailyReportsQuery): Promise<DailyReportListResult> {
    const requested = parseSort(query.sort, DAILY_REPORT_SORT_FIELDS);
    const sort: DailyReportSort =
      requested && isDailyReportSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      filters: {
        contractorId: query.contractorId,
        preparedByEngineerId: query.preparedByEngineerId,
        weather: query.weather,
        reportFrom: query.reportFrom,
        reportTo: query.reportTo,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    return { items: rows.map(toDailyReportDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<DailyReportDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toDailyReportDto(row);
  }

  async create(actor: Actor, input: CreateDailyReportInput, ctx: RequestContext): Promise<DailyReportDto> {
    if (isTooFarAhead(input.reportDate, this.clock())) {
      throw futureDate(ctx);
    }
    try {
      const created = await this.repository.transaction(async (tx) => {
        if (!(await this.repository.userExists(actor.id, tx))) {
          throw fail(ctx, 401, "errors.unauthorized", "UNAUTHORIZED");
        }
        await this.requireActiveContractor(input.contractorId, ctx, tx);
        await this.requireActiveEngineer(input.preparedByEngineerId, ctx, tx);
        const row = await this.repository.create(
          {
            contractorId: input.contractorId,
            preparedByEngineerId: input.preparedByEngineerId,
            reportDate: input.reportDate,
            weather: input.weather,
            workersCount: input.workersCount,
            notes: input.notes ?? null,
            createdById: actor.id,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "daily_report.create",
            entity: ENTITY,
            entityId: row.id,
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toDailyReportDto(created);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateDailyReportInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<DailyReportDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const current = await this.lock(id, expectedVersion, ctx, tx);

        // The date is checked only when this request moves it: a report that is already saved stays saveable.
        if (
          input.reportDate !== undefined &&
          toDay(input.reportDate) !== toDay(current.reportDate) &&
          isTooFarAhead(input.reportDate, this.clock())
        ) {
          throw futureDate(ctx);
        }
        // The contractor and the engineer are checked only when this request changes them: a report whose contractor or
        // engineer was switched off since stays valid and can still be saved.
        if (input.contractorId !== undefined && input.contractorId !== current.contractorId) {
          await this.requireActiveContractor(input.contractorId, ctx, tx);
        }
        if (
          input.preparedByEngineerId !== undefined &&
          input.preparedByEngineerId !== current.preparedByEngineerId
        ) {
          await this.requireActiveEngineer(input.preparedByEngineerId, ctx, tx);
        }

        const row = await this.repository.update(id, current.version, patchOf(input), tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "daily_report.update",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toDailyReportDto(updated);
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
            action: "daily_report.delete",
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

  // Locks the report for this transaction (it belongs to no villa, so its row is the only lock), refuses a version the caller
  // did not read, and returns the report as it is now.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<DailyReportRow> {
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

  // The contractor must exist and be active. It does not have to be tied to any villa: a report has none.
  private async requireActiveContractor(contractorId: string, ctx: RequestContext, tx: Db): Promise<void> {
    const status = await this.repository.contractorStatus(contractorId, tx);
    if (status === null) {
      throw contractorNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw contractorInactive(ctx);
    }
  }

  // The electrical engineer must exist and be active.
  private async requireActiveEngineer(engineerId: string, ctx: RequestContext, tx: Db): Promise<void> {
    const status = await this.repository.engineerStatus(engineerId, tx);
    if (status === null) {
      throw engineerNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw engineerInactive(ctx);
    }
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    if (uniqueViolationConstraint(err)?.includes("reportDate")) {
      throw exists(ctx);
    }
    const foreignKey = foreignKeyConstraint(err);
    if (foreignKey?.includes("contractorId")) {
      throw contractorNotFound(ctx);
    }
    if (foreignKey?.includes("preparedByEngineerId")) {
      throw engineerNotFound(ctx);
    }
    if (isRecordNotFound(err)) {
      throw notFound(ctx);
    }
    throw err;
  }
}
