import type { ErrorRequestHandler } from "express";
import { logger } from "../config/logger.js";
import { t } from "../i18n/index.js";
import type { LocaleCode } from "../../shared/constants/enums.js";
import { AppError } from "./AppError.js";

function clientStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) {
    return undefined;
  }
  const { status } = err;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

// Body-parser and other http-errors carry a 4xx `status`; they are client mistakes, not 500s.
function fromClientError(err: unknown, locale: LocaleCode): AppError | undefined {
  const status = clientStatus(err);
  if (status === undefined) {
    return undefined;
  }
  if (status === 413) {
    return new AppError(413, t(locale, "errors.payloadTooLarge"), "PAYLOAD_TOO_LARGE");
  }
  return new AppError(400, t(locale, "errors.badRequest"), "BAD_REQUEST");
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = err instanceof AppError ? err : fromClientError(err, req.locale);
  if (appError && appError.statusCode < 500) {
    res.status(appError.statusCode).json({
      code: appError.code,
      message: appError.message,
      details: appError.details,
      requestId: req.requestId,
    });
    return;
  }

  logger.error({ err, requestId: req.requestId }, "unhandled error");
  res.status(appError?.statusCode ?? 500).json({
    code: appError?.code ?? "INTERNAL_ERROR",
    message: appError?.message ?? t(req.locale, "errors.internal"),
    requestId: req.requestId,
  });
};
