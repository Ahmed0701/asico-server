import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { logger } from "../../../core/config/logger.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { foreignKeyConstraint } from "../../../shared/utils/index.js";
import { NOTE_HEAD_BYTES } from "../../materials/dto/materials.dto.js";
import { noteFileName, noteTypeOf } from "../../materials/validators/materials.validators.js";
import { MAX_IMAGES_PER_VILLA, type VillaImageDto } from "../dto/villa-images.dto.js";
import {
  VillaImagesRepository,
  type NewVillaImage,
  type VillaImageRow,
} from "../repository/villa-images.repository.js";

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const imageNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaImageNotFound"), "VILLA_IMAGE_NOT_FOUND");
const badFile = (ctx: RequestContext) =>
  new AppError(400, t(ctx.locale, "errors.villaImageType"), "INVALID_FILE_TYPE");
const imageLimit = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.villaImageLimit"), "VILLA_IMAGE_LIMIT");

export type ImageUpload = { tempPath: string; originalName: string };

export function toVillaImageDto(row: VillaImageRow): VillaImageDto {
  return {
    id: row.id,
    villaId: row.villaId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

export class VillaImagesService {
  constructor(
    private readonly repository = new VillaImagesRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  async list(villaId: string, ctx: RequestContext): Promise<VillaImageDto[]> {
    if ((await this.repository.villaNumber(villaId)) === null) throw villaNotFound(ctx);
    return (await this.repository.listByVilla(villaId)).map(toVillaImageDto);
  }

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  // Adds photos (JPEG or PNG, told by their first bytes), up to MAX_IMAGES_PER_VILLA on the villa. If one is not such a
  // photo, none is kept. They go in the villa's folder (removed with the villa), moved there before the transaction and
  // deleted again if it fails. Whatever happens, the temp files are gone afterwards.
  async upload(
    actor: Actor,
    villaId: string,
    uploads: ImageUpload[],
    ctx: RequestContext,
  ): Promise<VillaImageDto[]> {
    const stored: string[] = [];
    try {
      if ((await this.repository.villaNumber(villaId)) === null) throw villaNotFound(ctx);
      const images: NewVillaImage[] = [];
      for (const upload of uploads) {
        const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
        const type = noteTypeOf(head);
        if (!type || type.extension === "pdf") throw badFile(ctx);
        images.push({
          key: `villas/${villaId}/images/${randomUUID()}.${type.extension}`,
          name: noteFileName(upload.originalName, type.extension),
          mime: type.mime,
          size,
          uploadedAt: this.clock(),
        });
      }
      for (const [index, upload] of uploads.entries()) {
        const image = images[index]!;
        await this.storage.moveIn(upload.tempPath, image.key);
        stored.push(image.key);
      }
      await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockVilla(villaId, tx))) throw villaNotFound(ctx);
        if ((await this.repository.count(villaId, tx)) + images.length > MAX_IMAGES_PER_VILLA)
          throw imageLimit(ctx);
        await this.repository.addMany(villaId, actor.id, images, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa_image.upload",
            entity: "Villa",
            entityId: villaId,
            after: {
              villaNumber: await this.repository.villaNumber(villaId, tx),
              images: images.map((image) => ({ name: image.name, key: image.key })),
            },
          }),
        );
      });
      return (await this.repository.listByVilla(villaId)).map(toVillaImageDto);
    } catch (err) {
      for (const key of stored) await this.removeStored(key);
      if (foreignKeyConstraint(err) !== undefined) throw villaNotFound(ctx);
      throw err;
    } finally {
      for (const upload of uploads) await this.discardTemp(upload.tempPath);
    }
  }

  // Removes one image: its row in the transaction, the file after the commit.
  async remove(actor: Actor, id: string, ctx: RequestContext): Promise<void> {
    let key: string | null = null;
    await this.repository.transaction(async (tx) => {
      const image = await this.repository.findById(id, tx);
      if (!image) throw imageNotFound(ctx);
      if (!(await this.repository.delete(id, tx))) throw imageNotFound(ctx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "villa_image.delete",
          entity: "Villa",
          entityId: image.villaId,
          before: {
            villaNumber: await this.repository.villaNumber(image.villaId, tx),
            image: { name: image.name, key: image.key },
          },
        }),
      );
      key = image.key;
    });
    if (key) await this.removeStored(key);
  }

  // One image, to send.
  async file(id: string, ctx: RequestContext): Promise<VillaImageRow> {
    const image = await this.repository.findById(id);
    if (!image) throw imageNotFound(ctx);
    return image;
  }

  async openFile(key: string, ctx: RequestContext): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(key);
      return { stream: this.storage.createReadStream(key), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw imageNotFound(ctx);
      throw err;
    }
  }

  private async discardTemp(tempPath: string): Promise<void> {
    try {
      await this.storage.discardTemp(tempPath);
    } catch (err) {
      logger.warn({ err }, "could not remove a temporary upload file");
    }
  }

  private async removeStored(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, key }, "could not remove a villa image from disk; it is now an orphan");
      }
    }
  }
}
