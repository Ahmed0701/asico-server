import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isTooFarAhead, toDay } from "../../../shared/utils/day.js";
import { foreignKeyConstraint, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  SITE_REPORT_SORT_FIELDS,
  isSiteReportSortField,
  type SiteReportDto,
  type SiteReportListResult,
  type SiteReportSort,
} from "../dto/site-reports.dto.js";
import { toSiteReportDto, toSnapshot } from "../mapper/site-reports.mapper.js";
import {
  SiteReportsRepository,
  type Db,
  type SiteReportPatch,
  type SiteReportRow,
} from "../repository/site-reports.repository.js";
import type {
  CreateSiteReportInput,
  ListSiteReportsQuery,
  UpdateSiteReportInput,
} from "../validators/site-reports.validators.js";

const ENTITY = "SiteReport";
const DEFAULT_SORT: SiteReportSort = { field: "visitDate", direction: "desc" };

// The fields a PATCH can change.
const PATCH_KEYS = [
  "title",
  "visitDate",
  "inspector",
  "type",
  "rating",
  "findings",
  "recommendations",
] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.siteReportNotFound", "SITE_REPORT_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");

const futureDate = (ctx: RequestContext): AppError =>
  new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path: "visitDate", message: t(ctx.locale, "validation.visitDateFuture") },
  ]);

function patchOf(input: UpdateSiteReportInput): SiteReportPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as SiteReportPatch;
}

export class SiteReportsService {
  // `clock` is injectable so the future-date rule can be tested at exact instants.
  constructor(
    private readonly repository = new SiteReportsRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListSiteReportsQuery): Promise<SiteReportListResult> {
    const requested = parseSort(query.sort, SITE_REPORT_SORT_FIELDS);
    const sort: SiteReportSort =
      requested && isSiteReportSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      filters: {
        villaId: query.villaId,
        type: query.type,
        rating: query.rating,
        visitFrom: query.visitFrom,
        visitTo: query.visitTo,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    return { items: rows.map(toSiteReportDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<SiteReportDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toSiteReportDto(row);
  }

  async create(actor: Actor, input: CreateSiteReportInput, ctx: RequestContext): Promise<SiteReportDto> {
    if (isTooFarAhead(input.visitDate, this.clock())) {
      throw futureDate(ctx);
    }
    try {
      const created = await this.repository.transaction(async (tx) => {
        // LOCK ORDER: the villa first (shared), so this takes turns with a delete of the villa.
        if (!(await this.repository.lockVillaShared(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        await this.requireUser(actor, ctx, tx);
        const row = await this.repository.create(
          {
            villaId: input.villaId,
            title: input.title,
            visitDate: input.visitDate,
            inspector: input.inspector,
            type: input.type,
            rating: input.rating,
            findings: input.findings,
            recommendations: input.recommendations ?? null,
            createdById: actor.id,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "site_report.create",
            entity: ENTITY,
            entityId: row.id,
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toSiteReportDto(created);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateSiteReportInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<SiteReportDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const current = await this.lock(id, expectedVersion, ctx, tx);

        // The date is checked only when this request moves it: a row that is already saved stays saveable.
        if (
          input.visitDate !== undefined &&
          toDay(input.visitDate) !== toDay(current.visitDate) &&
          isTooFarAhead(input.visitDate, this.clock())
        ) {
          throw futureDate(ctx);
        }

        const row = await this.repository.update(id, current.version, patchOf(input), tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "site_report.update",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toSiteReportDto(updated);
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
            action: "site_report.delete",
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

  // Takes the locks of a write to one site report in the one order everything uses (the villa, then the row), refuses a
  // version the caller did not read, and returns the row as it is now.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<SiteReportRow> {
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

  // A row is saved with its creator: a user who is gone cannot be one.
  private async requireUser(actor: Actor, ctx: RequestContext, tx: Db): Promise<void> {
    if (!(await this.repository.userExists(actor.id, tx))) {
      throw fail(ctx, 401, "errors.unauthorized", "UNAUTHORIZED");
    }
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    if (foreignKeyConstraint(err)?.includes("villaId")) {
      throw villaNotFound(ctx);
    }
    if (isRecordNotFound(err)) {
      throw notFound(ctx);
    }
    throw err;
  }
}
