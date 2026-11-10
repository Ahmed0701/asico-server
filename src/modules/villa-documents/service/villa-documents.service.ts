import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { logger } from "../../../core/config/logger.js";
import { env } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import {
  PDF_MIME,
  PDF_SIGNATURE,
  type UploadInput,
  type VillaDocumentDto,
} from "../dto/villa-documents.dto.js";
import { toDocumentSnapshot, toVillaDocumentDto } from "../mapper/villa-documents.mapper.js";
import { VillaDocumentsRepository } from "../repository/villa-documents.repository.js";
import { hasPdfSignature, sanitizeOriginalName } from "../validators/villa-documents.validators.js";

const ENTITY = "VillaDocument";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const fileNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.fileNotFound", "FILE_NOT_FOUND");
const documentLimit = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaDocumentLimit", "VILLA_DOCUMENT_LIMIT");
const notAPdf = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.invalidFileType", "INVALID_FILE_TYPE");

export class VillaDocumentsService {
  constructor(
    private readonly repository = new VillaDocumentsRepository(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  // Checked before the upload body is read, so a request that cannot succeed is refused early. The
  // transaction in upload() checks again under a row lock, which is the check that counts.
  async assertCanUpload(villaId: string, ctx: RequestContext): Promise<void> {
    if (!(await this.repository.villaExists(villaId))) {
      throw villaNotFound(ctx);
    }
    if ((await this.repository.countDocuments(villaId)) >= env.MAX_DOCUMENTS_PER_VILLA) {
      throw documentLimit(ctx);
    }
  }

  async listByVilla(villaId: string, ctx: RequestContext): Promise<VillaDocumentDto[]> {
    if (!(await this.repository.villaExists(villaId))) {
      throw villaNotFound(ctx);
    }
    return (await this.repository.listByVilla(villaId)).map(toVillaDocumentDto);
  }

  // The received file is at a temp path. It is checked, moved to its final key, and then recorded in one
  // transaction. Whatever happens, the temp file is gone afterwards, and a stored file whose transaction
  // failed is deleted again, so only committed rows have files.
  async upload(actor: Actor, input: UploadInput, ctx: RequestContext): Promise<VillaDocumentDto> {
    const { villaId, tempPath } = input;
    try {
      const { size, head } = await this.storage.inspectTemp(tempPath, PDF_SIGNATURE.length);
      if (!hasPdfSignature(head)) {
        throw notAPdf(ctx);
      }

      const storageKey = `villas/${villaId}/${randomUUID()}.pdf`;
      await this.storage.moveIn(tempPath, storageKey);
      try {
        const row = await this.repository.transaction(async (tx) => {
          if (!(await this.repository.lockVilla(villaId, tx))) {
            throw villaNotFound(ctx);
          }
          if ((await this.repository.countDocuments(villaId, tx)) >= env.MAX_DOCUMENTS_PER_VILLA) {
            throw documentLimit(ctx);
          }
          const created = await this.repository.createDocument(
            {
              villaId,
              storageKey,
              originalName: sanitizeOriginalName(input.originalName),
              sizeBytes: size,
              mimeType: PDF_MIME,
              uploadedById: actor.id,
            },
            tx,
          );
          await audit.record(
            tx,
            withMeta(ctx, {
              actorId: actor.id,
              action: "villa_document.upload",
              entity: ENTITY,
              entityId: created.id,
              after: {
                id: created.id,
                villaId,
                originalName: created.originalName,
                sizeBytes: created.sizeBytes,
                mimeType: created.mimeType,
                storageKey,
              },
            }),
          );
          return created;
        });
        return toVillaDocumentDto(row);
      } catch (err) {
        await this.removeStored(storageKey);
        throw err;
      }
    } finally {
      await this.discardTemp(tempPath);
    }
  }

  async discardTemp(tempPath: string): Promise<void> {
    try {
      await this.storage.discardTemp(tempPath);
    } catch (err) {
      logger.warn({ err }, "could not remove a temporary upload file");
    }
  }

  async getForDownload(
    id: string,
    ctx: RequestContext,
  ): Promise<{ storageKey: string; originalName: string }> {
    const file = await this.repository.findStored(id);
    if (!file) {
      throw fileNotFound(ctx);
    }
    return { storageKey: file.storageKey, originalName: file.originalName };
  }

  // Only used where the app serves the file itself (development). A row whose file is missing is a 404.
  async openForDownload(
    storageKey: string,
    ctx: RequestContext,
  ): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(storageKey);
      return { stream: this.storage.createReadStream(storageKey), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw fileNotFound(ctx);
      }
      throw err;
    }
  }

  // The row goes first, inside the transaction, together with the audit entry.
  // The file on disk is removed after the commit: if that fails the request still succeeds and the leftover
  // file is only logged (a file with no row is harmless; a row with no file would not be).
  async remove(actor: Actor, id: string, ctx: RequestContext): Promise<void> {
    let storageKey: string;
    try {
      storageKey = await this.repository.transaction(async (tx) => {
        const file = await this.repository.findStored(id, tx);
        if (!file) {
          throw fileNotFound(ctx);
        }

        await this.repository.deleteDocument(id, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa_document.delete",
            entity: ENTITY,
            entityId: id,
            before: toDocumentSnapshot(file),
          }),
        );
        return file.storageKey;
      });
    } catch (err) {
      // Someone else deleted it between our read and our delete.
      if (isRecordNotFound(err)) {
        throw fileNotFound(ctx);
      }
      throw err;
    }
    await this.removeStored(storageKey);
  }

  private async removeStored(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, storageKey }, "could not remove a villa file from disk; it is now an orphan");
      }
    }
  }
}
