import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../../../core/config/env.js";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { downloadMode, toUploadError } from "../../villa-documents/controller/villa-documents.controller.js";
import { toContentDisposition } from "../../villa-documents/mapper/villa-documents.mapper.js";
import { MAX_PAYMENT_FILES } from "../dto/payments.dto.js";
import { PaymentsService } from "../service/payments.service.js";
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  UpdatePaymentInput,
} from "../validators/payments.validators.js";

const PROTECTED_PREFIX = "/protected-files/";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class PaymentsController {
  constructor(private readonly service = new PaymentsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, totals } = await this.service.list(req.validated.query as ListPaymentsQuery);
    res.status(200).json({ data: items, meta, totals });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.create(actorOf(req), req.body as CreatePaymentInput, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdatePaymentInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  // ---- the receipt and invoice files ----

  // Receives up to MAX_PAYMENT_FILES files, all named "file", into temp paths inside the upload folder; text fields are
  // refused.
  receiveFiles = (req: Request, res: Response, next: NextFunction): void => {
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
      limits: { fileSize: env.MAX_UPLOAD_BYTES, files: MAX_PAYMENT_FILES, fields: 0 },
      defParamCharset: "utf8",
    }).array("file", MAX_PAYMENT_FILES);
    upload(req, res, (err?: unknown) => next(err ? toUploadError(err, req.locale) : undefined));
  };

  uploadFiles = async (req: Request, res: Response): Promise<void> => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      throw new AppError(400, t(req.locale, "errors.paymentFileMissing"), "NO_FILE_PROVIDED");
    }
    const item = await this.service.uploadFiles(
      actorOf(req),
      idOf(req),
      files.map((file) => ({ tempPath: file.path, originalName: file.originalname })),
      contextOf(req),
    );
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  removeFile = async (req: Request, res: Response): Promise<void> => {
    const { id, fileId } = req.validated.params as { id: string; fileId: string };
    const item = await this.service.removeFile(actorOf(req), id, fileId, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  // One file, shown in the browser (inline). Streamed by this process or handed to nginx, like the villa documents.
  file = async (req: Request, res: Response): Promise<void> => {
    const ctx = contextOf(req);
    const { id, fileId } = req.validated.params as { id: string; fileId: string };
    const file = await this.service.file(id, fileId, ctx);
    const headers = () => {
      res.status(200);
      res.setHeader("Content-Type", file.mime);
      res.setHeader("Content-Disposition", toContentDisposition(file.name, "inline"));
      res.setHeader("Content-Language", "en");
      res.setHeader("Cache-Control", "private, no-store");
    };
    if (downloadMode() === "stream") {
      const { stream, size } = await this.service.openFile(file.key, ctx);
      headers();
      res.setHeader("Content-Length", size);
      await pipeline(stream, res).catch(() => res.destroy());
      return;
    }
    headers();
    res.setHeader("X-Accel-Redirect", `${PROTECTED_PREFIX}${file.key}`);
    res.status(200).end();
  };
}
