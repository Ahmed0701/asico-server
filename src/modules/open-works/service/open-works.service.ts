import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { toDay } from "../../../shared/utils/day.js";
import { zoneToday, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { foreignKeyConstraint, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  OPEN_WORK_SORT_FIELDS,
  isOpenWorkSortField,
  type OpenWorkDto,
  type OpenWorkListResult,
  type OpenWorkSort,
  type WorkStatusValue,
} from "../dto/open-works.dto.js";
import { toOpenWorkDto, toSnapshot } from "../mapper/open-works.mapper.js";
import {
  OpenWorksRepository,
  type Db,
  type OpenWorkPatch,
  type OpenWorkRow,
} from "../repository/open-works.repository.js";
import type {
  CreateOpenWorkInput,
  ListOpenWorksQuery,
  UpdateOpenWorkInput,
} from "../validators/open-works.validators.js";

const ENTITY = "WorkItem";
const DEFAULT_SORT: OpenWorkSort = { field: "location", direction: "asc" };
const MAX_PROGRESS = 100;

// The fields a PATCH can change.
const PATCH_KEYS = [
  "elecPhaseId",
  "status",
  "priority",
  "progress",
  "contractorId",
  "startDate",
  "endDate",
] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.workItemNotFound", "WORK_ITEM_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const elecPhaseNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.elecPhaseNotFound", "ELEC_PHASE_NOT_FOUND");
// A manual work is filed under an ACTIVE phase. The code and the status are the ones the progress update uses for a switched-off
// phase (the phase is in the state, not the request body's syntax); the message says what was refused.
const elecPhaseInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.workElecPhaseInactive", "ELEC_PHASE_INACTIVE");
// A villa has at most one open work per electrical phase: the existing one is edited instead. 409, on the phase field.
const phaseTaken = (ctx: RequestContext): AppError => {
  const message = t(ctx.locale, "errors.openWorkPhaseTaken");
  return new AppError(409, message, "OPEN_WORK_PHASE_TAKEN", [{ path: "elecPhaseId", message }]);
};
const contractorNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
// A contractor that is switched off cannot be put on an item. 400, as for any other value the request may not carry.
const contractorInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.workContractorInactive", "CONTRACTOR_INACTIVE");
// The contractor of an item is the villa's one contractor. 422: the request is well formed but does not fit the villa.
const contractorNotOnVilla = (ctx: RequestContext): AppError =>
  fail(ctx, 422, "errors.contractorNotOnVilla", "CONTRACTOR_NOT_ON_VILLA");

function withDetail(
  ctx: RequestContext,
  status: number,
  key: MessageKey,
  code: string,
  path: string,
): AppError {
  const message = t(ctx.locale, key);
  return new AppError(status, message, code, [{ path, message }]);
}

const statusProgressMismatch = (ctx: RequestContext): AppError =>
  withDetail(ctx, 422, "validation.workStatusProgress", "WORK_STATUS_PROGRESS_MISMATCH", "status");

const dateOrder = (ctx: RequestContext): AppError =>
  new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path: "endDate", message: t(ctx.locale, "validation.dateRangeInvalid") },
  ]);

// DONE is exactly 100, NOT_STARTED is exactly 0; IN_PROGRESS and DELAYED are anything below 100.
export function statusAgreesWithProgress(status: WorkStatusValue, progress: number): boolean {
  if (status === "DONE") return progress === MAX_PROGRESS;
  if (status === "NOT_STARTED") return progress === 0;
  return progress < MAX_PROGRESS;
}

// What an omitted status or progress is on creation: the one the other implies, or the starting point.
export function startingPair(input: Pick<CreateOpenWorkInput, "status" | "progress">): {
  status: WorkStatusValue;
  progress: number;
} {
  if (input.status !== undefined && input.progress !== undefined) {
    return { status: input.status, progress: input.progress };
  }
  if (input.progress !== undefined) {
    const { progress } = input;
    return {
      status: progress === 0 ? "NOT_STARTED" : progress === MAX_PROGRESS ? "DONE" : "IN_PROGRESS",
      progress,
    };
  }
  const status = input.status ?? "NOT_STARTED";
  return { status, progress: status === "DONE" ? MAX_PROGRESS : 0 };
}

function patchOf(input: UpdateOpenWorkInput): OpenWorkPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as OpenWorkPatch;
}

export class OpenWorksService {
  // `clock` and `policy` are injectable so "overdue" can be tested at exact instants, in any zone.
  constructor(
    private readonly repository = new OpenWorksRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: Pick<DeadlinePolicy, "timeZone"> = envDeadlinePolicy(),
  ) {}

  // Today in APP_TIMEZONE, like the small works and the alert job: a work is overdue from the first moment of the day after
  // its end date, local time.
  private today(): Date {
    return zoneToday(this.clock(), this.policy.timeZone);
  }

  async list(query: ListOpenWorksQuery): Promise<OpenWorkListResult> {
    const requested = parseSort(query.sort, OPEN_WORK_SORT_FIELDS);
    const sort: OpenWorkSort =
      requested && isOpenWorkSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const today = this.today();

    const { rows, total } = await this.repository.list({
      filters: {
        villaId: query.villaId,
        elecPhaseId: query.elecPhaseId,
        status: query.status,
        priority: query.priority,
        contractorId: query.contractorId,
        startFrom: query.startFrom,
        startTo: query.startTo,
        endFrom: query.endFrom,
        endTo: query.endTo,
        overdue: query.overdue,
        done: query.done,
        search: query.search,
      },
      sort,
      today,
      skip,
      take,
    });
    return { items: rows.map((row) => toOpenWorkDto(row, today)), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<OpenWorkDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toOpenWorkDto(row, this.today());
  }

  async create(actor: Actor, input: CreateOpenWorkInput, ctx: RequestContext): Promise<OpenWorkDto> {
    const { status, progress } = startingPair(input);
    if (!statusAgreesWithProgress(status, progress)) {
      throw statusProgressMismatch(ctx);
    }
    try {
      const created = await this.repository.transaction(async (tx) => {
        // LOCK ORDER: the villa first (shared), so this takes turns with a change of the villa's contractor.
        const villa = await this.repository.lockVillaShared(input.villaId, tx);
        if (!villa) {
          throw villaNotFound(ctx);
        }
        await this.requireActivePhase(input.elecPhaseId, ctx, tx);
        await this.requirePhaseFree(input.villaId, input.elecPhaseId, undefined, ctx, tx);
        if (input.contractorId) {
          await this.requireVillaContractor(input.contractorId, villa.contractorId, ctx, tx);
        }
        const row = await this.repository.create(
          {
            villaId: input.villaId,
            elecPhaseId: input.elecPhaseId,
            status,
            priority: input.priority ?? "MEDIUM",
            progress,
            contractorId: input.contractorId ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
            createdById: actor.id,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "open_work.create",
            entity: ENTITY,
            entityId: row.id,
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toOpenWorkDto(created, this.today());
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateOpenWorkInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<OpenWorkDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const { current, villaContractorId } = await this.lock(id, expectedVersion, ctx, tx);

        const status = input.status ?? current.status;
        const progress = input.progress ?? current.progress;
        if (!statusAgreesWithProgress(status, progress)) {
          throw statusProgressMismatch(ctx);
        }
        // The phase and the contractor are checked only when this request sets or changes them: an item whose phase was
        // switched off, or whose villa moved to another contractor, since stays valid and can still be saved.
        if (input.elecPhaseId !== undefined && input.elecPhaseId !== current.elecPhaseId) {
          await this.requireActivePhase(input.elecPhaseId, ctx, tx);
          await this.requirePhaseFree(current.villa.id, input.elecPhaseId, id, ctx, tx);
        }
        if (input.contractorId && input.contractorId !== current.contractorId) {
          await this.requireVillaContractor(input.contractorId, villaContractorId, ctx, tx);
        }
        this.checkDateOrder(input, current, ctx);

        const patch = patchOf(input);
        const row = await this.repository.update(id, current.version, patch, tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? current.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "open_work.update",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(current),
            after: toSnapshot(row),
          }),
        );
        return row;
      });
      return toOpenWorkDto(updated, this.today());
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
            action: "open_work.delete",
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

  // Takes the locks of a write to one item in the one order everything uses (the villa, then the item), refuses a
  // version the caller did not read, and returns the item as it is now with the villa's contractor.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<{ current: OpenWorkRow; villaContractorId: string | null }> {
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

  // The villa must have no other open work under this phase. The lock makes two writers of the same villa and phase take
  // turns, so they cannot both find it free.
  private async requirePhaseFree(
    villaId: string,
    elecPhaseId: string,
    exceptId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    await this.repository.lockVillaPhase(villaId, elecPhaseId, tx);
    if (await this.repository.findItemForPhase(villaId, elecPhaseId, exceptId, tx)) {
      throw phaseTaken(ctx);
    }
  }

  // The phase must exist and be active.
  private async requireActivePhase(elecPhaseId: string, ctx: RequestContext, tx: Db): Promise<void> {
    const status = await this.repository.elecPhaseStatus(elecPhaseId, tx);
    if (status === null) {
      throw elecPhaseNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw elecPhaseInactive(ctx);
    }
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

  // The body schema can only compare dates that are both in the request. This compares the values the item will have
  // after the update, so sending one date cannot leave the pair inverted.
  private checkDateOrder(input: UpdateOpenWorkInput, current: OpenWorkRow, ctx: RequestContext): void {
    const dayOf = (sent: Date | null | undefined, stored: Date | null): string | null =>
      sent === undefined ? (stored ? toDay(stored) : null) : sent === null ? null : toDay(sent);
    const start = dayOf(input.startDate, current.startDate);
    const end = dayOf(input.endDate, current.endDate);
    if (start !== null && end !== null && end < start) {
      throw dateOrder(ctx);
    }
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    const foreignKey = foreignKeyConstraint(err);
    if (foreignKey?.includes("villaId")) {
      throw villaNotFound(ctx);
    }
    if (foreignKey?.includes("elecPhaseId")) {
      throw elecPhaseNotFound(ctx);
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
