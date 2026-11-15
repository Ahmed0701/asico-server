import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import {
  OWNER_NOTE_SORT_FIELDS,
  isOwnerNoteSortField,
  type OwnerNoteDto,
  type OwnerNoteListResult,
  type OwnerNoteSort,
} from "../dto/owner-notes.dto.js";
import { toOwnerNoteDto, toOwnerNoteSnapshot } from "../mapper/owner-notes.mapper.js";
import {
  OwnerNotesRepository,
  type Db,
  type OwnerNoteFields,
  type OwnerNoteRow,
} from "../repository/owner-notes.repository.js";
import type {
  CreateOwnerNoteInput,
  ListOwnerNotesQuery,
  UpdateOwnerNoteInput,
} from "../validators/owner-notes.validators.js";

// The newest note first.
const DEFAULT_SORT: OwnerNoteSort = { field: "createdAt", direction: "desc" };
const ENTITY = "OwnerNote";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.ownerNoteNotFound"), "OWNER_NOTE_NOT_FOUND");
const villaNotFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");

// The audit action of a change: checking or unchecking "done" alone has its own, anything else is an update.
function actionOf(input: UpdateOwnerNoteInput): string {
  const onlyDone = Object.keys(input).every((key) => key === "done");
  let action = "owner_note.update";
  if (onlyDone && input.done === true) action = "owner_note.done";
  if (onlyDone && input.done === false) action = "owner_note.done_undo";
  return action;
}

export class OwnerNotesService {
  constructor(
    private readonly repository = new OwnerNotesRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: ListOwnerNotesQuery): Promise<OwnerNoteListResult> {
    const requested = parseSort(query.sort, OWNER_NOTE_SORT_FIELDS);
    const sort: OwnerNoteSort =
      requested && isOwnerNoteSortField(requested.field)
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
    return { items: rows.map(toOwnerNoteDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<OwnerNoteDto> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toOwnerNoteDto(row);
  }

  async create(actor: Actor, input: CreateOwnerNoteInput, ctx: RequestContext): Promise<OwnerNoteDto> {
    const created = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.villaExists(input.villaId, tx))) {
        throw villaNotFound(ctx);
      }
      const row = await this.repository.create({ villaId: input.villaId, notes: input.notes }, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "owner_note.create",
          entity: ENTITY,
          entityId: row.id,
          after: toOwnerNoteSnapshot(row),
        }),
      );
      return row;
    });
    return toOwnerNoteDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateOwnerNoteInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<OwnerNoteDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.villaId !== undefined && !(await this.repository.villaExists(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        const data: OwnerNoteFields = {
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
            before: toOwnerNoteSnapshot(target),
            after: toOwnerNoteSnapshot(row),
          }),
        );
        return row;
      });
      return toOwnerNoteDto(updated);
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
            action: "owner_note.delete",
            entity: ENTITY,
            entityId: id,
            before: toOwnerNoteSnapshot(target),
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
  ): Promise<OwnerNoteRow> {
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
