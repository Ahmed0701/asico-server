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
import { MAX_IMAGES_PER_UPLOAD } from "../dto/villa-images.dto.js";
import { VillaImagesService } from "../service/villa-images.service.js";

const PROTECTED_PREFIX = "/protected-files/";

const villaIdOf = (req: Request): string => (req.validated.params as { villaId: string }).villaId;
const idOf = (req: Request): string => (req.validated.params as { id: string }).id;

export class VillaImagesController {
  constructor(private readonly service = new VillaImagesService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.list(villaIdOf(req), contextOf(req)) });
  };

  // Receives up to MAX_IMAGES_PER_UPLOAD files, all named "file", into temp paths inside the upload folder; text fields are
  // refused.
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
      limits: { fileSize: env.MAX_UPLOAD_BYTES, files: MAX_IMAGES_PER_UPLOAD, fields: 0 },
      defParamCharset: "utf8",
    }).array("file", MAX_IMAGES_PER_UPLOAD);
    upload(req, res, (err?: unknown) => next(err ? toUploadError(err, req.locale) : undefined));
  };

  upload = async (req: Request, res: Response): Promise<void> => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      throw new AppError(400, t(req.locale, "errors.villaImageMissing"), "NO_FILE_PROVIDED");
    }
    const items = await this.service.upload(
      actorOf(req),
      villaIdOf(req),
      files.map((file) => ({ tempPath: file.path, originalName: file.originalname })),
      contextOf(req),
    );
    res.status(201).json({ data: items });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req));
    res.status(204).end();
  };

  // One image, shown in the browser (inline). Streamed by this process or handed to nginx, like the villa documents.
  file = async (req: Request, res: Response): Promise<void> => {
    const ctx = contextOf(req);
    const image = await this.service.file(idOf(req), ctx);
    const headers = () => {
      res.status(200);
      res.setHeader("Content-Type", image.mime);
      res.setHeader("Content-Disposition", toContentDisposition(image.name, "inline"));
      res.setHeader("Cache-Control", "private, max-age=3600");
    };
    if (downloadMode() === "stream") {
      const { stream, size } = await this.service.openFile(image.key, ctx);
      headers();
      res.setHeader("Content-Length", size);
      await pipeline(stream, res).catch(() => res.destroy());
      return;
    }
    headers();
    res.setHeader("X-Accel-Redirect", `${PROTECTED_PREFIX}${image.key}`);
    res.status(200).end();
  };
}
