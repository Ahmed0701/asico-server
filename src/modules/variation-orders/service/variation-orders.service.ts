import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { env } from "../../../core/config/env.js";
import { logger } from "../../../core/config/logger.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { localDayOf } from "../../../shared/utils/deadline.js";
import { isRecordNotFound, uniqueViolationConstraint } from "../../../shared/utils/index.js";
import { NOTE_HEAD_BYTES } from "../../materials/dto/materials.dto.js";
import { noteFileName, noteTypeOf } from "../../materials/validators/materials.validators.js";
import {
  MAX_VARIATION_ORDER_FILES,
  type VariationOrderDto,
  type VariationOrderListResult,
} from "../dto/variation-orders.dto.js";
import { toVariationOrderDto, toVariationOrderSnapshot } from "../mapper/variation-orders.mapper.js";
import {
  VariationOrdersRepository,
  type Db,
  type NewVariationOrderFile,
  type VariationOrderFields,
  type VariationOrderFileRow,
  type VariationOrderRow,
} from "../repository/variation-orders.repository.js";
import type {
  CreateVariationOrderInput,
  UpdateVariationOrderInput,
} from "../validators/variation-orders.validators.js";

const ENTITY = "VariationOrder";

const fail = (ctx: RequestContext, status: number, key: MessageKey, code: string) =>
  new AppError(status, t(ctx.locale, key), code);
const notFound = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.variationOrderNotFound", "VARIATION_ORDER_NOT_FOUND");
const villaNotFound = (ctx: RequestContext) => fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const numberTaken = (ctx: RequestContext) =>
  fail(ctx, 409, "errors.variationOrderNumberTaken", "VARIATION_ORDER_NUMBER_TAKEN");
const noFile = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.variationOrderFileNotFound", "VARIATION_ORDER_FILE_NOT_FOUND");
const badFile = (ctx: RequestContext) => fail(ctx, 400, "errors.variationOrderFileType", "INVALID_FILE_TYPE");
const fileLimit = (ctx: RequestContext) =>
  fail(ctx, 409, "errors.variationOrderFileLimit", "VARIATION_ORDER_FILE_LIMIT");

export type VariationOrderUpload = { tempPath: string; originalName: string };

const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

// The audit action of a change: marking it paid or back to pending alone has its own, anything else is an update.
function actionOf(input: UpdateVariationOrderInput): string {
  const onlyStatus = Object.keys(input).every((key) => key === "status");
  let action = "variation_order.update";
  if (onlyStatus && input.status === "PAID") action = "variation_order.paid";
  if (onlyStatus && input.status === "PENDING") action = "variation_order.paid_undo";
  return action;
}

export class VariationOrdersService {
  constructor(
    private readonly repository = new VariationOrdersRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  // Today in APP_TIMEZONE, YYYY-MM-DD: the date added of a variation order sent without one.
  today(): string {
    return localDayOf(this.clock(), env.APP_TIMEZONE);
  }

  async listByVilla(villaId: string, ctx: RequestContext): Promise<VariationOrderListResult> {
    if (!(await this.repository.villaExists(villaId))) throw villaNotFound(ctx);
    const rows = await this.repository.listByVilla(villaId);
    let pending = 0n;
    let paid = 0n;
    for (const row of rows) {
      if (row.status === "PAID") paid += row.amountMinor;
      else pending += row.amountMinor;
    }
    return {
      items: rows.map(toVariationOrderDto),
      totals: { pendingMinor: Number(pending), paidMinor: Number(paid) },
    };
  }

  async create(
    actor: Actor,
    villaId: string,
    input: CreateVariationOrderInput,
    ctx: RequestContext,
  ): Promise<VariationOrderDto> {
    try {
      const created = await this.repository.transaction(async (tx) => {
        if (!(await this.repository.villaExists(villaId, tx))) throw villaNotFound(ctx);
        if (await this.repository.numberTaken(villaId, input.voNumber, null, tx)) throw numberTaken(ctx);
        const row = await this.repository.create(
          {
            villaId,
            voNumber: input.voNumber,
            amountMinor: BigInt(input.amountMinor),
            dateAdded: input.dateAdded ?? asDay(this.today()),
            status: input.status ?? "PENDING",
            notes: input.notes ?? null,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "variation_order.create",
            entity: ENTITY,
            entityId: row.id,
            after: toVariationOrderSnapshot(row),
          }),
        );
        return row;
      });
      return toVariationOrderDto(created);
    } catch (err) {
      // Two saves of the same number at once: the unique index stops the second.
      if (uniqueViolationConstraint(err) !== undefined) throw numberTaken(ctx);
      throw err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateVariationOrderInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VariationOrderDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (
          input.voNumber !== undefined &&
          (await this.repository.numberTaken(target.villaId, input.voNumber, id, tx))
        ) {
          throw numberTaken(ctx);
        }
        const data: VariationOrderFields = {
          ...(input.voNumber !== undefined && { voNumber: input.voNumber }),
          ...(input.amountMinor !== undefined && { amountMinor: BigInt(input.amountMinor) }),
          ...(input.dateAdded !== undefined && { dateAdded: input.dateAdded }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.notes !== undefined && { notes: input.notes }),
        };
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
            before: toVariationOrderSnapshot(target),
            after: toVariationOrderSnapshot(row),
          }),
        );
        return row;
      });
      return toVariationOrderDto(updated);
    } catch (err) {
      if (isRecordNotFound(err)) throw notFound(ctx);
      if (uniqueViolationConstraint(err) !== undefined) throw numberTaken(ctx);
      throw err;
    }
  }

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
            action: "variation_order.delete",
            entity: ENTITY,
            entityId: id,
            before: toVariationOrderSnapshot(target),
          }),
        );
        keys = target.files.map((file) => file.key);
      });
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
    for (const key of keys) await this.removeStored(key);
  }

  // ---- the PDF files ----

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

  // Adds PDF files, up to MAX_VARIATION_ORDER_FILES in all. Every file must really be a PDF, or none is kept. The files
  // are moved to their final keys before the transaction and deleted again if it fails. Whatever happens, the temp files
  // are gone afterwards.
  async uploadFiles(
    actor: Actor,
    id: string,
    uploads: VariationOrderUpload[],
    ctx: RequestContext,
  ): Promise<VariationOrderDto> {
    const stored: string[] = [];
    try {
      const existing = await this.repository.findById(id);
      if (!existing) throw notFound(ctx);
      if (existing.files.length + uploads.length > MAX_VARIATION_ORDER_FILES) throw fileLimit(ctx);
      const files: NewVariationOrderFile[] = [];
      for (const upload of uploads) {
        const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
        const type = noteTypeOf(head);
        if (!type || type.extension !== "pdf") throw badFile(ctx);
        files.push({
          key: `variation-orders/${id}/${randomUUID()}.${type.extension}`,
          name: noteFileName(upload.originalName, type.extension),
          mime: type.mime,
          size,
          uploadedAt: this.clock(),
        });
      }
      for (const [index, upload] of uploads.entries()) {
        const file = files[index]!;
        await this.storage.moveIn(upload.tempPath, file.key);
        stored.push(file.key);
      }
      const row = await this.repository.transaction(async (tx) => {
        // The row lock keeps two uploads from passing the limit together.
        if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
        if ((await this.repository.countFiles(id, tx)) + files.length > MAX_VARIATION_ORDER_FILES) {
          throw fileLimit(ctx);
        }
        await this.repository.addFiles(id, files, tx);
        const updated = await this.repository.findById(id, tx);
        if (!updated) throw notFound(ctx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "variation_order.file_upload",
            entity: ENTITY,
            entityId: id,
            after: {
              villaNumber: updated.villa.villaNumber,
              voNumber: updated.voNumber,
              files: files.map((file) => ({ name: file.name, key: file.key })),
            },
          }),
        );
        return updated;
      });
      return toVariationOrderDto(row);
    } catch (err) {
      for (const key of stored) await this.removeStored(key);
      throw err;
    } finally {
      for (const upload of uploads) await this.discardTemp(upload.tempPath);
    }
  }

  // Removes one file: its row in the transaction, the file after the commit.
  async removeFile(
    actor: Actor,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<VariationOrderDto> {
    let key: string | null = null;
    const row = await this.repository.transaction(async (tx) => {
      if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
      const file = await this.repository.findFile(id, fileId, tx);
      if (!file) throw noFile(ctx);
      await this.repository.deleteFile(fileId, tx);
      const updated = await this.repository.findById(id, tx);
      if (!updated) throw notFound(ctx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "variation_order.file_delete",
          entity: ENTITY,
          entityId: id,
          before: {
            villaNumber: updated.villa.villaNumber,
            voNumber: updated.voNumber,
            file: { name: file.name, key: file.key },
          },
        }),
      );
      key = file.key;
      return updated;
    });
    if (key) await this.removeStored(key);
    return toVariationOrderDto(row);
  }

  // One file, to send. A file of another variation order, or a missing one, is a 404.
  async file(id: string, fileId: string, ctx: RequestContext): Promise<VariationOrderFileRow> {
    const file = await this.repository.findFile(id, fileId);
    if (!file) throw noFile(ctx);
    return file;
  }

  async openFile(key: string, ctx: RequestContext): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(key);
      return { stream: this.storage.createReadStream(key), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw noFile(ctx);
      throw err;
    }
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<VariationOrderRow> {
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
        logger.warn({ err, key }, "could not remove a variation order file from disk; it is now an orphan");
      }
    }
  }
}
