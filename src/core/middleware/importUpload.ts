import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { IMPORT_MAX_BYTES } from "../../shared/import/limits.js";
import type { LocaleCode } from "../../shared/constants/enums.js";
import { AppError } from "../errors/AppError.js";
import { t, type MessageKey } from "../i18n/index.js";

function uploadError(status: number, locale: LocaleCode, key: MessageKey, code: string): AppError {
  return new AppError(status, t(locale, key), code);
}

// The upload library's own errors, as the API's errors.
function toUploadError(err: unknown, locale: LocaleCode): unknown {
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
        : uploadError(400, locale, "import.noFile", "NO_FILE_PROVIDED");
    default:
      return uploadError(400, locale, "errors.badRequest", "BAD_REQUEST");
  }
}

// Receives one spreadsheet, named "file", into memory (it is at most IMPORT_MAX_BYTES, and it is read whole
// anyway). Text fields and a second file are refused. Nothing is written to disk, so there is nothing to clean up.
export function receiveImportFile(req: Request, res: Response, next: NextFunction): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 0 },
    defParamCharset: "utf8",
  }).single("file");
  upload(req, res, (err?: unknown) => next(err ? toUploadError(err, req.locale) : undefined));
}

export function fileHashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// What makes one import "the same request" as another for an Idempotency-Key: the file's content and whether it is a
// dry run. The file's name is not part of it: renaming a file does not make it another one.
export function importFingerprint(req: Request): string {
  const dryRun = (req.validated.query as { dryRun?: boolean } | undefined)?.dryRun === true;
  return `import:${req.file ? fileHashOf(req.file.buffer) : "no-file"}:dryRun=${dryRun}`;
}
