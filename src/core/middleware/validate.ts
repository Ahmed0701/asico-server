import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors/AppError.js";
import { isMessageKey, t } from "../i18n/index.js";

type Source = "body" | "query" | "params";

// Schemas name their messages with translation keys; anything else (zod's own English text) becomes a generic key.
// Express 5 exposes `req.query` as a read-only getter, so parsed query/params are stored on `req.validated`.
export function validate(schema: ZodType, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: t(req.locale, isMessageKey(issue.message) ? issue.message : "validation.invalid"),
      }));
      next(new AppError(400, t(req.locale, "errors.validation"), "VALIDATION_ERROR", details));
      return;
    }
    if (source === "body") {
      req.body = result.data;
    } else {
      req.validated[source] = result.data;
    }
    next();
  };
}
