import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import {
  isForeignKeyViolation,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../../shared/utils/index.js";
import type { ElecPhaseDto, ElecPhaseListResult, ElecPhaseOptionDto } from "../dto/elec-phases.dto.js";
import { toElecPhaseDto, toOptionDto } from "../mapper/elec-phases.mapper.js";
import { ElecPhasesRepository, type Db, type ElecPhaseRow } from "../repository/elec-phases.repository.js";
import type {
  CreateElecPhaseInput,
  ListElecPhasesQuery,
  ReorderElecPhasesInput,
  UpdateElecPhaseInput,
} from "../validators/elec-phases.validators.js";

const ENTITY = "ElecPhase";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.elecPhaseNotFound"), "ELEC_PHASE_NOT_FOUND");

const nameTaken = (ctx: RequestContext): AppError => {
  const message = t(ctx.locale, "errors.elecPhaseNameTaken");
  return new AppError(409, message, "ELEC_PHASE_NAME_TAKEN", [{ path: "name", message }]);
};

const inUse = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.elecPhaseInUse"), "ELEC_PHASE_IN_USE");

const listChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.elecPhasesChanged"), "ELEC_PHASES_CHANGED");

const snapshot = (row: Pick<ElecPhaseRow, "name" | "status" | "sortOrder" | "progressRatio">) => ({
  name: row.name,
  status: row.status,
  progressRatio: row.progressRatio,
  sortOrder: row.sortOrder,
});

export class ElecPhasesService {
  constructor(private readonly repository = new ElecPhasesRepository()) {}

  async list(query: ListElecPhasesQuery): Promise<ElecPhaseListResult> {
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total } = await this.repository.list({ status: query.status, skip, take });
    return { items: rows.map(toElecPhaseDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<ElecPhaseOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<ElecPhaseDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toElecPhaseDto(row);
  }

  async create(actor: Actor, input: CreateElecPhaseInput, ctx: RequestContext): Promise<ElecPhaseDto> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        await this.repository.lockOrder(tx);
        await this.assertNameFree(input.name, undefined, ctx, tx);
        const row = await this.repository.create(
          { name: input.name, status: input.status ?? "ACTIVE", progressRatio: input.progressRatio ?? 0 },
          tx,
        );
        // Every villa gets a progress row at 0 for the new phase, in this transaction.
        await this.repository.seedProgressRows(row.id, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "elec_phase.create",
            entity: ENTITY,
            entityId: row.id,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toElecPhaseDto(created);
    } catch (err) {
      // Someone created the same name between the check above and the write: the unique index caught it.
      throw uniqueViolationConstraint(err) !== undefined ? nameTaken(ctx) : err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateElecPhaseInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<ElecPhaseDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.name !== undefined) {
          await this.assertNameFree(input.name, id, ctx, tx);
        }
        const before = snapshot(target);
        const row = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.status !== undefined && { status: input.status }),
            ...(input.progressRatio !== undefined && { progressRatio: input.progressRatio }),
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
            action: "elec_phase.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toElecPhaseDto(updated);
    } catch (err) {
      // Deleted between the lookup and the write, or the name was taken in that gap.
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw uniqueViolationConstraint(err) !== undefined ? nameTaken(ctx) : err;
    }
  }

  // Gives the phases the order of `input.ids`, which must name every phase once. A list that does not (a phase was
  // added or deleted since the caller loaded it) is refused rather than guessed at. Only the phases that move are
  // written and audited, each with its old and new place.
  async reorder(actor: Actor, input: ReorderElecPhasesInput, ctx: RequestContext): Promise<ElecPhaseDto[]> {
    const reordered = await this.repository.transaction(async (tx) => {
      await this.repository.lockOrder(tx);
      const current = await this.repository.lockAll(tx);
      const known = new Set(current.map((row) => row.id));
      const asked = new Set(input.ids);
      if (
        asked.size !== known.size ||
        input.ids.length !== known.size ||
        !input.ids.every((id) => known.has(id))
      ) {
        throw listChanged(ctx);
      }
      const byId = new Map(current.map((row) => [row.id, row]));
      const result: ElecPhaseRow[] = [];
      for (const [index, id] of input.ids.entries()) {
        const row = byId.get(id)!;
        const sortOrder = index + 1;
        if (row.sortOrder === sortOrder) {
          result.push(row);
          continue;
        }
        const moved = await this.repository.setSortOrder(id, row.version, sortOrder, tx);
        if (!moved) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? row.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "elec_phase.reorder",
            entity: ENTITY,
            entityId: id,
            before: snapshot(row),
            after: snapshot(moved),
          }),
        );
        result.push(moved);
      }
      return result;
    });
    return reordered.map(toElecPhaseDto);
  }

  // A phase that something uses cannot be deleted: deactivate it instead. A phase whose progress rows are all at 0 is
  // not in use: those rows go with it.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        // The set lock first, then the row lock: the same order as every other writer, so none of them can deadlock.
        await this.repository.lockOrder(tx);
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if ((await this.repository.countUsage(id, tx)) > 0) {
          throw inUse(ctx);
        }
        await this.repository.deleteZeroProgress(id, tx);
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "elec_phase.delete",
            entity: ENTITY,
            entityId: id,
            before: snapshot(target),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      // A villa moved the phase above 0 between the check and the delete: the foreign key caught it.
      if (isForeignKeyViolation(err)) {
        throw inUse(ctx);
      }
      throw err;
    }
  }

  // The name must not belong to another phase, ignoring case. The phase being renamed may keep its own name.
  private async assertNameFree(
    name: string,
    selfId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const existing = await this.repository.findByName(name, tx);
    if (existing && existing.id !== selfId) {
      throw nameTaken(ctx);
    }
  }

  // Locks the phase for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now: what the audit entry records as "before" is exactly what this write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ElecPhaseRow> {
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
