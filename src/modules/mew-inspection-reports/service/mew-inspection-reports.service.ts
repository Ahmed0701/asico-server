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
import type { MewReportDto } from "../dto/mew-inspection-reports.dto.js";
import {
  MewInspectionReportsRepository,
  type MewReportRow,
} from "../repository/mew-inspection-reports.repository.js";

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const reportNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.mewReportNotFound"), "MEW_REPORT_NOT_FOUND");
const badFile = (ctx: RequestContext) =>
  new AppError(400, t(ctx.locale, "errors.mewReportType"), "INVALID_FILE_TYPE");

export function toMewReportDto(row: MewReportRow): MewReportDto {
  return {
    villaId: row.villaId,
    name: row.name,
    size: row.size,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

/**
 * The MEW inspection report of a villa: one PDF, uploaded from the MEW Inspection list, replaced by a new upload. The file
 * is kept in the villa's folder (removed with the villa).
 */
export class MewInspectionReportsService {
  constructor(
    private readonly repository = new MewInspectionReportsRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  async ofVillas(villaIds: readonly string[]): Promise<MewReportDto[]> {
    if (villaIds.length === 0) return [];
    return (await this.repository.ofVillas(villaIds)).map(toMewReportDto);
  }

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  // Puts a PDF (told by its first bytes) in place of the villa's report. The new file is moved in before the transaction
  // and removed again if it fails; the old one is removed after the commit. The temp file is gone afterwards either way.
  async upload(
    actor: Actor,
    villaId: string,
    upload: { tempPath: string; originalName: string },
    ctx: RequestContext,
  ): Promise<MewReportDto> {
    let stored: string | null = null;
    try {
      if ((await this.repository.villaNumber(villaId)) === null) throw villaNotFound(ctx);
      const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
      if (noteTypeOf(head)?.extension !== "pdf") throw badFile(ctx);
      const report = {
        key: `villas/${villaId}/mew-inspection/${randomUUID()}.pdf`,
        name: noteFileName(upload.originalName, "pdf"),
        size,
        uploadedAt: this.clock(),
      };
      await this.storage.moveIn(upload.tempPath, report.key);
      stored = report.key;
      let replaced: string | null = null;
      const saved = await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lockVilla(villaId, tx))) throw villaNotFound(ctx);
        const before = await this.repository.find(villaId, tx);
        replaced = before?.key ?? null;
        const row = await this.repository.save(villaId, actor.id, report, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "mew_report.upload",
            entity: "Villa",
            entityId: villaId,
            ...(before && {
              before: { villaNumber: await this.repository.villaNumber(villaId, tx), report: before.name },
            }),
            after: {
              villaNumber: await this.repository.villaNumber(villaId, tx),
              report: report.name,
              key: report.key,
            },
          }),
        );
        return row;
      });
      stored = null;
      if (replaced) await this.removeStored(replaced);
      return toMewReportDto(saved);
    } catch (err) {
      if (stored) await this.removeStored(stored);
      if (foreignKeyConstraint(err) !== undefined) throw villaNotFound(ctx);
      throw err;
    } finally {
      await this.discardTemp(upload.tempPath);
    }
  }

  // Removes the villa's report: the row in the transaction, the file after the commit.
  async remove(actor: Actor, villaId: string, ctx: RequestContext): Promise<void> {
    let key: string | null = null;
    await this.repository.transaction(async (tx) => {
      const report = await this.repository.find(villaId, tx);
      if (!report) throw reportNotFound(ctx);
      if (!(await this.repository.delete(villaId, tx))) throw reportNotFound(ctx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "mew_report.delete",
          entity: "Villa",
          entityId: villaId,
          before: {
            villaNumber: await this.repository.villaNumber(villaId, tx),
            report: report.name,
            key: report.key,
          },
        }),
      );
      key = report.key;
    });
    if (key) await this.removeStored(key);
  }

  async file(villaId: string, ctx: RequestContext): Promise<MewReportRow> {
    const report = await this.repository.find(villaId);
    if (!report) throw reportNotFound(ctx);
    return report;
  }

  async openFile(key: string, ctx: RequestContext): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(key);
      return { stream: this.storage.createReadStream(key), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw reportNotFound(ctx);
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
        logger.warn({ err, key }, "could not remove a MEW inspection report from disk; it is now an orphan");
      }
    }
  }
}
