import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { alertWindow, zoneToday, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { PermissionsRepository } from "../../permissions/index.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isForeignKeyViolation, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  CONTRACTOR_SORT_FIELDS,
  SUMMARY_SECTION_PERMISSIONS,
  SUMMARY_SORT_FIELDS,
  isContractorSortField,
  isSummarySortField,
  type ContractorDto,
  type ContractorListResult,
  type ContractorOptionDto,
  type ContractorSort,
  type ContractorSummaryResult,
  type SummarySection,
  type SummarySort,
} from "../dto/contractors.dto.js";
import { toContractorDto, toOptionDto, toSummaryDto } from "../mapper/contractors.mapper.js";
import { ContractorsRepository, type ContractorRow, type Db } from "../repository/contractors.repository.js";
import type {
  ContractorSummaryQuery,
  CreateContractorInput,
  ListContractorsQuery,
  UpdateContractorInput,
} from "../validators/contractors.validators.js";

const DEFAULT_SORT: ContractorSort = { field: "name", direction: "asc" };
const DEFAULT_SUMMARY_SORT: SummarySort = { field: "villaNumber", direction: "asc" };
const ENTITY = "Contractor";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
const hasVillas = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.contractorHasVillas", "CONTRACTOR_HAS_VILLAS");

const snapshot = (row: Pick<ContractorRow, "name" | "phone" | "email" | "status">) => ({
  name: row.name,
  phone: row.phone,
  email: row.email,
  status: row.status,
});

// Who is asking: the summary's sections are cut to what they may read. Without one (the export, which needs
// contractors:summary only and shows no section) nothing is cut.
export type SummaryViewer = { id: string; role: "ADMIN" | "EMPLOYEE" };

export class ContractorsService {
  // `clock` and `policy` are injectable so the date rules of the summary can be tested at exact instants, in any zone.
  constructor(
    private readonly repository = new ContractorsRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: DeadlinePolicy = envDeadlinePolicy(),
    private readonly permissions = new PermissionsRepository(),
  ) {}

  async list(query: ListContractorsQuery): Promise<ContractorListResult> {
    const requested = parseSort(query.sort, CONTRACTOR_SORT_FIELDS);
    const sort: ContractorSort =
      requested && isContractorSortField(requested.field)
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
    return { items: rows.map(toContractorDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<ContractorOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<ContractorDto> {
    return toContractorDto(await this.requireContractor(id, ctx));
  }

  // Read-only, so it is not audited. The villas are the contractor's own; the sections about open works, small works, daily
  // reports and labour are counted through the contractor each of those records names, and a section the viewer may not read is
  // null and is not queried.
  async summary(
    id: string,
    query: ContractorSummaryQuery,
    ctx: RequestContext,
    viewer?: SummaryViewer,
  ): Promise<ContractorSummaryResult> {
    const contractor = await this.requireContractor(id, ctx);
    const requested = parseSort(query.sort, SUMMARY_SORT_FIELDS);
    const sort: SummarySort =
      requested && isSummarySortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SUMMARY_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.listVillas({ contractorId: id, sort, skip, take });
    const sections = await this.readableSections(viewer);
    const now = this.clock();
    const figures = await this.repository.figures(
      id,
      sections,
      // The open works' overdue day: today in APP_TIMEZONE, as in the open works list.
      zoneToday(now, this.policy.timeZone),
      alertWindow(now, this.policy),
    );
    return { summary: toSummaryDto(contractor, total, rows, figures), meta: buildMeta(page, limit, total) };
  }

  async create(actor: Actor, input: CreateContractorInput, ctx: RequestContext): Promise<ContractorDto> {
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
          action: "contractor.create",
          entity: ENTITY,
          entityId: row.id,
          after: snapshot(row),
        }),
      );
      return row;
    });
    return toContractorDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateContractorInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<ContractorDto> {
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
            action: "contractor.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toContractorDto(updated);
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
        // Villas, open works, daily reports, small works and labour rows all keep a contractor from being deleted.
        if ((await this.repository.countLinks(id, tx)) > 0) {
          throw hasVillas(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "contractor.delete",
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

  // Locks the contractor for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now: what the audit entry records as "before" is exactly what this write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ContractorRow> {
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

  private async readableSections(viewer: SummaryViewer | undefined): Promise<SummarySection[]> {
    const all = Object.keys(SUMMARY_SECTION_PERMISSIONS) as SummarySection[];
    if (viewer === undefined || viewer.role === "ADMIN") {
      return all;
    }
    const granted = new Set(await this.permissions.getUserCodes(viewer.id));
    return all.filter((section) => granted.has(SUMMARY_SECTION_PERMISSIONS[section]));
  }

  private async requireContractor(id: string, ctx: RequestContext): Promise<ContractorRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }
}
