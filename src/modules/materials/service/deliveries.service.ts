import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { logger } from "../../../core/config/logger.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import {
  DELIVERY_SORT_FIELDS,
  MAX_NOTES,
  NOTE_HEAD_BYTES,
  isDeliverySortField,
  type BalanceListResult,
  type DeliverySort,
  type MaterialDeliveryDto,
  type MaterialDeliveryListResult,
  type MaterialsSummaryDto,
} from "../dto/materials.dto.js";
import {
  toBalanceRowDto,
  toDeliveryDto,
  toDeliverySnapshot,
  toSummaryDto,
} from "../mapper/materials.mapper.js";
import { BalanceRepository } from "../repository/balance.repository.js";
import {
  DeliveriesRepository,
  type Db,
  type DeliveryFields,
  type DeliveryRow,
  type LineInput,
  type NewNote,
  type NoteRow,
} from "../repository/deliveries.repository.js";
import {
  noteFileName,
  noteTypeOf,
  type CreateDeliveryInput,
  type ListBalanceQuery,
  type ListDeliveriesQuery,
  type UpdateDeliveryInput,
  type VillaRequirementsInput,
} from "../validators/materials.validators.js";

// The newest delivery first.
const DEFAULT_SORT: DeliverySort = { field: "deliveryDate", direction: "desc" };
const ENTITY = "MaterialDelivery";

const fail = (ctx: RequestContext, status: number, key: MessageKey, code: string): AppError =>
  new AppError(status, t(ctx.locale, key), code);
const notFound = (ctx: RequestContext) => fail(ctx, 404, "errors.deliveryNotFound", "DELIVERY_NOT_FOUND");
const villaNotFound = (ctx: RequestContext) => fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const factoryNotFound = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.factoryNotFound", "FACTORY_NOT_FOUND");
const itemNotFound = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.materialItemNotFound", "MATERIAL_ITEM_NOT_FOUND");
const wrongType = (ctx: RequestContext) =>
  fail(ctx, 422, "errors.materialItemWrongType", "MATERIAL_ITEM_WRONG_TYPE");
const noNote = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.deliveryNoteNotFound", "DELIVERY_NOTE_NOT_FOUND");
const badFile = (ctx: RequestContext) => fail(ctx, 400, "errors.deliveryNoteFileType", "INVALID_FILE_TYPE");
const noteLimit = (ctx: RequestContext) => fail(ctx, 409, "errors.deliveryNoteLimit", "DELIVERY_NOTE_LIMIT");

export type NoteUpload = { tempPath: string; originalName: string };

export class DeliveriesService {
  constructor(
    private readonly repository = new DeliveriesRepository(),
    private readonly storage: StorageService = new LocalDiskStorage(),
    private readonly clock: () => Date = () => new Date(),
    private readonly balance = new BalanceRepository(),
  ) {}

  async list(query: ListDeliveriesQuery): Promise<MaterialDeliveryListResult> {
    const requested = parseSort(query.sort, DELIVERY_SORT_FIELDS);
    const sort: DeliverySort =
      requested && isDeliverySortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total } = await this.repository.list({
      search: query.search,
      villaId: query.villaId,
      factoryId: query.factoryId,
      itemId: query.itemId,
      type: query.type,
      deliveryFrom: query.deliveryFrom,
      deliveryTo: query.deliveryTo,
      hasNote: query.hasNote,
      sort,
      skip,
      take,
    });
    return { items: rows.map(toDeliveryDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<MaterialDeliveryDto> {
    const row = await this.repository.findById(id);
    if (!row) throw notFound(ctx);
    return toDeliveryDto(row);
  }

  // What a villa needs, received and still waits for, per catalog item.
  async summary(villaId: string, ctx: RequestContext): Promise<MaterialsSummaryDto> {
    if (!(await this.repository.villaExists(villaId))) throw villaNotFound(ctx);
    const [counts, rows] = await Promise.all([
      this.repository.countsOfVilla(villaId),
      this.balance.ofVilla(villaId),
    ]);
    return toSummaryDto(villaId, counts, rows);
  }

  // The balance list: every villa and material it needs or received, with what is still to come.
  async balanceList(query: ListBalanceQuery): Promise<BalanceListResult> {
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total, totals } = await this.balance.list({
      search: query.search,
      villaId: query.villaId,
      itemId: query.itemId,
      type: query.type,
      status: query.status,
      skip,
      take,
    });
    return {
      items: rows.map(toBalanceRowDto),
      meta: buildMeta(page, limit, total),
      totals: totals.map((row) => ({
        item: { id: row.itemId, name: row.name, unit: row.unit, type: row.type },
        balance: row.balance,
        villas: row.villas,
      })),
    };
  }

  // Sets a villa's own quantities (null: back to the catalog's), audited as one change of the villa, and answers its summary.
  async setRequirements(
    actor: Actor,
    villaId: string,
    input: VillaRequirementsInput,
    ctx: RequestContext,
  ): Promise<MaterialsSummaryDto> {
    await this.repository.transaction(async (tx) => {
      if (!(await this.repository.villaExists(villaId, tx))) throw villaNotFound(ctx);
      const types = await this.repository.itemTypes(
        input.items.map((row) => row.itemId),
        tx,
      );
      if (types.size !== input.items.length) throw itemNotFound(ctx);
      const before = await this.balance.ofVilla(villaId, tx);
      await this.balance.setRequirements(villaId, input.items, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "villa.material_requirements",
          entity: "Villa",
          entityId: villaId,
          before: { requirements: before.filter((row) => row.custom).map((row) => [row.name, row.required]) },
          after: { requirements: input.items.map((row) => [row.itemId, row.quantity]) },
        }),
      );
    });
    return this.summary(villaId, ctx);
  }

  async create(actor: Actor, input: CreateDeliveryInput, ctx: RequestContext): Promise<MaterialDeliveryDto> {
    const row = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.villaExists(input.villaId, tx))) throw villaNotFound(ctx);
      await this.assertLines(input.factoryId, input.lines, ctx, tx);
      const created = await this.repository.create(
        {
          villaId: input.villaId,
          factoryId: input.factoryId,
          noteNumber: input.noteNumber ?? null,
          deliveryDate: input.deliveryDate,
          lines: input.lines,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "material_delivery.create",
          entity: ENTITY,
          entityId: created.id,
          after: toDeliverySnapshot(created),
        }),
      );
      return created;
    });
    return toDeliveryDto(row);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateDeliveryInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<MaterialDeliveryDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (input.villaId !== undefined && !(await this.repository.villaExists(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        // The lines must fit the factory: both as they will be after this change.
        if (input.factoryId !== undefined || input.lines !== undefined) {
          await this.assertLines(
            input.factoryId ?? target.factoryId,
            input.lines ?? target.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
            ctx,
            tx,
          );
        }
        const data: DeliveryFields = {
          ...(input.villaId !== undefined && { villaId: input.villaId }),
          ...(input.factoryId !== undefined && { factoryId: input.factoryId }),
          ...(input.noteNumber !== undefined && { noteNumber: input.noteNumber }),
          ...(input.deliveryDate !== undefined && { deliveryDate: input.deliveryDate }),
        };
        const updated = await this.repository.update(id, target.version, data, input.lines, tx);
        if (!updated) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "material_delivery.update",
            entity: ENTITY,
            entityId: id,
            before: toDeliverySnapshot(target),
            after: toDeliverySnapshot(updated),
          }),
        );
        return updated;
      });
      return toDeliveryDto(row);
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
  }

  // The row goes in the transaction (its note rows with it); the note files are removed after the commit.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    let keys: string[] = [];
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
            action: "material_delivery.delete",
            entity: ENTITY,
            entityId: id,
            before: toDeliverySnapshot(target),
          }),
        );
        keys = target.notes.map((note) => note.key);
      });
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
    for (const key of keys) await this.removeStored(key);
  }

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  async discardTemp(tempPath: string): Promise<void> {
    try {
      await this.storage.discardTemp(tempPath);
    } catch (err) {
      logger.warn({ err }, "could not remove a temporary upload file");
    }
  }

  // Adds delivery note files to the delivery, up to MAX_NOTES in all. Every file must really be a PDF, JPG or PNG, or none is
  // kept. The files are moved to their final keys before the transaction and deleted again if it fails. Whatever happens,
  // the temp files are gone afterwards.
  async uploadNotes(
    actor: Actor,
    id: string,
    uploads: NoteUpload[],
    ctx: RequestContext,
  ): Promise<MaterialDeliveryDto> {
    const stored: string[] = [];
    try {
      const existing = await this.repository.findById(id);
      if (!existing) throw notFound(ctx);
      if (existing.notes.length + uploads.length > MAX_NOTES) throw noteLimit(ctx);
      const notes: NewNote[] = [];
      for (const upload of uploads) {
        const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
        const type = noteTypeOf(head);
        if (!type) throw badFile(ctx);
        notes.push({
          key: `deliveries/${id}/${randomUUID()}.${type.extension}`,
          name: noteFileName(upload.originalName, type.extension),
          mime: type.mime,
          size,
          uploadedAt: this.clock(),
        });
      }
      for (const [index, upload] of uploads.entries()) {
        const note = notes[index]!;
        await this.storage.moveIn(upload.tempPath, note.key);
        stored.push(note.key);
      }
      const row = await this.repository.transaction(async (tx) => {
        // The delivery's row lock keeps two uploads from passing the limit together.
        if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
        if ((await this.repository.countNotes(id, tx)) + notes.length > MAX_NOTES) throw noteLimit(ctx);
        await this.repository.addNotes(id, notes, tx);
        const updated = await this.repository.findById(id, tx);
        if (!updated) throw notFound(ctx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "material_delivery.note_upload",
            entity: ENTITY,
            entityId: id,
            after: {
              noteNumber: updated.noteNumber,
              files: notes.map((note) => ({ name: note.name, key: note.key })),
            },
          }),
        );
        return updated;
      });
      return toDeliveryDto(row);
    } catch (err) {
      for (const key of stored) await this.removeStored(key);
      throw err;
    } finally {
      for (const upload of uploads) await this.discardTemp(upload.tempPath);
    }
  }

  // Removes one delivery note file: its row in the transaction, the file after the commit.
  async removeNote(
    actor: Actor,
    id: string,
    noteId: string,
    ctx: RequestContext,
  ): Promise<MaterialDeliveryDto> {
    let key: string | null = null;
    const row = await this.repository.transaction(async (tx) => {
      if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
      const note = await this.repository.findNote(id, noteId, tx);
      if (!note) throw noNote(ctx);
      await this.repository.deleteNote(noteId, tx);
      const updated = await this.repository.findById(id, tx);
      if (!updated) throw notFound(ctx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "material_delivery.note_delete",
          entity: ENTITY,
          entityId: id,
          before: { noteNumber: updated.noteNumber, file: { name: note.name, key: note.key } },
        }),
      );
      key = note.key;
      return updated;
    });
    if (key) await this.removeStored(key);
    return toDeliveryDto(row);
  }

  // One delivery note file, to send. A file of another delivery, or a missing one, is a 404.
  async noteFile(id: string, noteId: string, ctx: RequestContext): Promise<NoteRow> {
    const note = await this.repository.findNote(id, noteId);
    if (!note) throw noNote(ctx);
    return note;
  }

  async openNote(key: string, ctx: RequestContext): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(key);
      return { stream: this.storage.createReadStream(key), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw noNote(ctx);
      throw err;
    }
  }

  // The factory must exist and every line must be a catalog item of the factory's type.
  private async assertLines(
    factoryId: string,
    lines: LineInput[],
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const type = await this.repository.factoryType(factoryId, tx);
    if (!type) throw factoryNotFound(ctx);
    const types = await this.repository.itemTypes(
      lines.map((line) => line.itemId),
      tx,
    );
    if (types.size !== lines.length) throw itemNotFound(ctx);
    if ([...types.values()].some((itemType) => itemType !== type)) throw wrongType(ctx);
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<DeliveryRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw notFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw notFound(ctx);
    return row;
  }

  private async removeStored(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, key }, "could not remove a delivery note from disk; it is now an orphan");
      }
    }
  }
}
