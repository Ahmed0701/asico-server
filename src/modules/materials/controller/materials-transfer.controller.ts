import type { Request, Response } from "express";
import { logger } from "../../../core/config/logger.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { CONTENT_TYPES, type ExportFormat } from "../../../shared/export/types.js";
import type { ImportQuery } from "../../../shared/import/index.js";
import type { ParsedExport } from "../../exports/validators/exports.validators.js";
import { MaterialsTransferService } from "../service/materials-transfer.service.js";
import type { ListBalanceQuery, ListDeliveriesQuery } from "../validators/materials.validators.js";

type Prepared = Awaited<ReturnType<MaterialsTransferService["exportDeliveries"]>>;

// The Excel and PDF files of the materials, and their Excel import.
export class MaterialsTransferController {
  constructor(private readonly service = new MaterialsTransferService()) {}

  exportDeliveries = async (req: Request, res: Response): Promise<void> => {
    const { format, query } = req.validated.query as ParsedExport<ListDeliveriesQuery>;
    await this.send(req, res, () =>
      this.service.exportDeliveries(format, query, actorOf(req), contextOf(req)),
    );
  };

  exportBalance = async (req: Request, res: Response): Promise<void> => {
    const { format, query } = req.validated.query as ParsedExport<ListBalanceQuery>;
    await this.send(req, res, () => this.service.exportBalance(format, query, actorOf(req), contextOf(req)));
  };

  // The template is English, whatever the request asked for, like an export.
  template = async (_req: Request, res: Response): Promise<void> => {
    const { fileName, bytes } = await this.service.template();
    res.status(200);
    res.setHeader("Content-Type", CONTENT_TYPES.xlsx);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  };

  // The report is the body whatever the outcome: 201 when the rows were saved, 200 for a dry run, 422 when a row has a problem.
  import = async (req: Request, res: Response): Promise<void> => {
    const { file } = req;
    if (!file) {
      throw new AppError(400, t(req.locale, "import.noFile"), "NO_FILE_PROVIDED");
    }
    const { dryRun } = req.validated.query as ImportQuery;
    const { status, report } = await this.service.importFile(
      actorOf(req),
      { name: file.originalname, bytes: file.buffer },
      dryRun,
      contextOf(req),
    );
    res.status(status).json({ data: report });
  };

  // The count, the size check and the audit entry happen before the first byte, so a refusal is an ordinary error. The file is
  // then streamed; a client that leaves mid-download is not an error.
  private async send(req: Request, res: Response, prepare: () => Promise<Prepared>): Promise<void> {
    const file = await prepare();
    res.status(200);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
    let disconnected = false;
    const closed = new Promise<never>((_, reject) => {
      res.once("close", () => {
        if (!res.writableFinished) {
          disconnected = true;
          reject(new Error("the client disconnected"));
        }
      });
    });
    closed.catch(() => undefined);
    try {
      await Promise.race([file.write(res), closed]);
    } catch (err) {
      if (disconnected) return;
      logger.error({ err, requestId: req.requestId }, "a materials export failed while it was being written");
      // Part of a file may have been sent: ending the connection is the honest way to say it is incomplete.
      res.destroy();
    }
  }
}

export type { ExportFormat };
