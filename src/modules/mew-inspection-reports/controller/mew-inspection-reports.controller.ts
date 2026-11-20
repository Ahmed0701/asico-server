import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { downloadMode, toUploadError } from "../../villa-documents/controller/villa-documents.controller.js";
import { toContentDisposition } from "../../villa-documents/mapper/villa-documents.mapper.js";
import { MewInspectionReportsService } from "../service/mew-inspection-reports.service.js";
import type { ReportsQuery } from "../validators/mew-inspection-reports.validators.js";

const PROTECTED_PREFIX = "/protected-files/";

const villaIdOf = (req: Request): string => (req.validated.params as { villaId: string }).villaId;

export class MewInspectionReportsController {
  constructor(private readonly service = new MewInspectionReportsService()) {}

  ofVillas = async (req: Request, res: Response): Promise<void> => {
    const { villaIds } = req.validated.query as ReportsQuery;
    res.status(200).json({ data: await this.service.ofVillas(villaIds) });
  };

  // Receives one file named "file" into a temp path inside the upload folder; text fields are refused.
  receive = (req: Request, res: Response, next: NextFunction): void => {
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, done) => {
          this.service
            .tempDir()
            .then((dir) => void done(null, dir))
            .catch((err: unknown) => done(err as Error, ""));
        },
        filename: (_req, _file, done) => done(null, `${randomUUID()}.upload`),
      }),
      limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 0 },
      defParamCharset: "utf8",
    }).single("file");
    upload(req, res, (err?: unknown) => next(err ? toUploadError(err, req.locale) : undefined));
  };

  upload = async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      throw new AppError(400, t(req.locale, "errors.mewReportMissing"), "NO_FILE_PROVIDED");
    }
    const report = await this.service.upload(
      actorOf(req),
      villaIdOf(req),
      { tempPath: file.path, originalName: file.originalname },
      contextOf(req),
    );
    res.status(201).json({ data: report });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), villaIdOf(req), contextOf(req));
    res.status(204).end();
  };

  // The report, shown in the browser (inline). Streamed by this process or handed to nginx, like the villa documents.
  file = async (req: Request, res: Response): Promise<void> => {
    const ctx = contextOf(req);
    const report = await this.service.file(villaIdOf(req), ctx);
    const headers = () => {
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", toContentDisposition(report.name, "inline"));
      res.setHeader("Cache-Control", "private, no-store");
    };
    if (downloadMode() === "stream") {
      const { stream, size } = await this.service.openFile(report.key, ctx);
      headers();
      res.setHeader("Content-Length", size);
      await pipeline(stream, res).catch(() => res.destroy());
      return;
    }
    headers();
    res.setHeader("X-Accel-Redirect", `${PROTECTED_PREFIX}${report.key}`);
    res.status(200).end();
  };
}
