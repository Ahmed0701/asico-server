import type { Request, Response } from "express";
import { logger } from "../../../core/config/logger.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { ImportQuery } from "../../../shared/import/index.js";
import { CONTENT_TYPES } from "../../../shared/export/types.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { MonthlyProgressService } from "../service/monthly-progress.service.js";
import type { ManualPaymentBody, MonthlyProgressQuery } from "../validators/monthly-progress.validators.js";

export class MonthlyProgressController {
  constructor(private readonly service = new MonthlyProgressService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, summary } = await this.service.list(req.validated.query as MonthlyProgressQuery);
    res.status(200).json({ data: items, meta, summary });
  };

  villaHistory = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const { items, summary } = await this.service.villaHistory(villaId, contextOf(req));
    res.status(200).json({ data: items, summary });
  };

  // The villa's payment history as an Excel file. The audit entry is written before the first byte, so a refusal is an
  // ordinary error; a client that leaves mid-download is not.
  exportVillaHistory = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const file = await this.service.exportVillaHistory(villaId, actorOf(req), contextOf(req));
    res.status(200);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
    try {
      await file.write(res);
    } catch (err) {
      if (res.destroyed) return;
      logger.error(
        { err, requestId: req.requestId },
        "a payment history export failed while it was being written",
      );
      res.destroy();
    }
  };

  // The template is English, whatever the request asked for, like an export.
  importTemplate = async (_req: Request, res: Response): Promise<void> => {
    const { fileName, bytes } = await this.service.importTemplate();
    res.status(200);
    res.setHeader("Content-Type", CONTENT_TYPES.xlsx);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  };

  // The report is the body whatever the outcome: 201 when the rows were saved, 200 for a dry run, 422 when a row has a
  // problem.
  importPrevious = async (req: Request, res: Response): Promise<void> => {
    const { file } = req;
    if (!file) {
      throw new AppError(400, t(req.locale, "import.noFile"), "NO_FILE_PROVIDED");
    }
    const { dryRun } = req.validated.query as ImportQuery;
    const { status, report } = await this.service.importPrevious(
      actorOf(req),
      { name: file.originalname, bytes: file.buffer },
      dryRun,
      contextOf(req),
    );
    res.status(status).json({ data: report });
  };

  pay = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const payment = await this.service.pay(actorOf(req), villaId, contextOf(req));
    res.status(201).json({ data: payment });
  };

  addManual = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const payment = await this.service.addManual(
      actorOf(req),
      villaId,
      req.body as ManualPaymentBody,
      contextOf(req),
    );
    res.status(201).json({ data: payment });
  };

  undo = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    await this.service.undo(actorOf(req), id, contextOf(req));
    res.status(204).end();
  };
}
