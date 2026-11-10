import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { env } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import {
  FILE_LINK_TTL_SECONDS,
  signFileLink,
  verifyFileLink,
  type FileDisposition,
} from "../../../core/security/fileLinkToken.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";
import { PDF_MIME } from "../dto/villa-documents.dto.js";
import { toContentDisposition } from "../mapper/villa-documents.mapper.js";
import { VillaDocumentsService } from "../service/villa-documents.service.js";

// Files are read from disk by nginx in production (X-Accel-Redirect) and by this process in development,
// where there is no nginx. Every other NODE_ENV, tests included, behaves like production. FILE_DELIVERY overrides it:
// a server with no nginx /protected-files/ location must stream, or every download is an empty file.
export type DownloadMode = "accel" | "stream";
export function downloadMode(): DownloadMode {
  return env.FILE_DELIVERY ?? (env.NODE_ENV === "development" ? "stream" : "accel");
}

const PROTECTED_PREFIX = "/protected-files/";

function uploadError(status: number, locale: LocaleCode, key: MessageKey, code: string): AppError {
  return new AppError(status, t(locale, key), code);
}

// The upload library's own errors, as the API's errors (the material delivery notes use it too).
export function toUploadError(err: unknown, locale: LocaleCode): unknown {
  if (!(err instanceof MulterError)) {
    // A broken or truncated multipart body.
    return uploadError(400, locale, "errors.badRequest", "BAD_REQUEST");
  }
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return uploadError(413, locale, "errors.fileTooLarge", "FILE_TOO_LARGE");
    case "LIMIT_FILE_COUNT":
      return uploadError(400, locale, "errors.tooManyFiles", "TOO_MANY_FILES");
    case "LIMIT_UNEXPECTED_FILE":
      return err.field === "file"
        ? uploadError(400, locale, "errors.tooManyFiles", "TOO_MANY_FILES")
        : uploadError(400, locale, "errors.noFileProvided", "NO_FILE_PROVIDED");
    default:
      return uploadError(400, locale, "errors.badRequest", "BAD_REQUEST");
  }
}

export class VillaDocumentsController {
  constructor(private readonly service = new VillaDocumentsService()) {}

  // Refuse what cannot succeed before the body is read.
  guardUpload = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    await this.service.assertCanUpload(villaId, contextOf(req));
    next();
  };

  // Receives one file, named "file", into a temp path inside the upload folder. The limits are read per
  // request, so they follow the environment. Text fields and a second file are refused.
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
    const { file } = req;
    if (!file) {
      throw uploadError(400, req.locale, "errors.noFileProvided", "NO_FILE_PROVIDED");
    }
    const { villaId } = req.validated.params as { villaId: string };
    const created = await this.service.upload(
      actorOf(req),
      { villaId, tempPath: file.path, originalName: file.originalname },
      contextOf(req),
    );
    res.status(201).json({ data: created });
  };

  listByVilla = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    res.status(200).json({ data: await this.service.listByVilla(villaId, contextOf(req)) });
  };

  // The same headers either way. The file's content is English-agnostic, so Content-Language is "en"
  // whatever the request asked for; errors above still follow Accept-Language.
  download = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    await this.send(req, res, id, "attachment");
  };

  // POST /villa-documents/:id/link: a signed URL to this one document, valid for FILE_LINK_TTL_SECONDS, that the browser opens
  // itself (no Authorization header needed). The caller's access is checked here, before the link is made.
  link = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    const { disposition } = req.body as { disposition: FileDisposition };
    await this.service.getForDownload(id, contextOf(req));
    const now = new Date();
    const token = await signFileLink({ documentId: id, userId: actorOf(req).id, disposition }, now);
    res.status(200).json({
      data: {
        url: `${req.baseUrl}/villa-documents/${id}/file?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(now.getTime() + FILE_LINK_TTL_SECONDS * 1000).toISOString(),
      },
    });
  };

  // GET /villa-documents/:id/file?token=: the file, for a valid link to THIS document. A link to another document, an expired
  // one, or one that was tampered with is 401 FILE_LINK_INVALID.
  file = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    const { token } = req.validated.query as { token: string };
    let claims;
    try {
      claims = await verifyFileLink(token);
    } catch {
      throw new AppError(401, t(req.locale, "errors.fileLinkInvalid"), "FILE_LINK_INVALID");
    }
    if (claims.documentId !== id) {
      throw new AppError(401, t(req.locale, "errors.fileLinkInvalid"), "FILE_LINK_INVALID");
    }
    await this.send(req, res, id, claims.disposition);
  };

  // The file itself: streamed by this process, or handed to nginx (see downloadMode). The same headers either way.
  private async send(req: Request, res: Response, id: string, disposition: FileDisposition): Promise<void> {
    const ctx = contextOf(req);
    const file = await this.service.getForDownload(id, ctx);

    if (downloadMode() === "stream") {
      const { stream, size } = await this.service.openForDownload(file.storageKey, ctx);
      this.setDownloadHeaders(res, file.originalName, disposition);
      res.setHeader("Content-Length", size);
      await pipeline(stream, res).catch(() => res.destroy());
      return;
    }

    this.setDownloadHeaders(res, file.originalName, disposition);
    res.setHeader("X-Accel-Redirect", `${PROTECTED_PREFIX}${file.storageKey}`);
    res.status(200).end();
  }

  remove = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    await this.service.remove(actorOf(req), id, contextOf(req));
    res.status(204).end();
  };

  private setDownloadHeaders(
    res: Response,
    originalName: string,
    disposition: FileDisposition = "attachment",
  ): void {
    res.status(200);
    res.setHeader("Content-Type", PDF_MIME);
    res.setHeader("Content-Disposition", toContentDisposition(originalName, disposition));
    res.setHeader("Content-Language", "en");
    res.setHeader("Cache-Control", "private, no-store");
  }
}
