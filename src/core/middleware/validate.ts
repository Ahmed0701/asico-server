import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors/AppError.js";
import { isMessageKey, t } from "../i18n/index.js";

type Source = "body" | "query" | "params";

// The path of the first string (or key) holding a NUL character, or undefined. PostgreSQL text cannot hold one, so such a
// value would fail in the database (a 500) instead of being refused here. Depth is bounded by the JSON body limit.
export function nulPath(value: unknown, path: string[] = []): string | undefined {
  if (typeof value === "string") return value.includes("\u0000") ? path.join(".") || "value" : undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = nulPath(item, [...path, String(index)]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("\u0000")) return [...path, "key"].join(".");
      const found = nulPath(item, [...path, key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Schemas name their messages with translation keys; anything else (zod's own English text) becomes a generic key.
// Express 5 exposes `req.query` as a read-only getter, so parsed query/params are stored on `req.validated`.
export function validate(schema: ZodType, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const nul = nulPath(req[source]);
    if (nul !== undefined) {
      next(
        new AppError(400, t(req.locale, "errors.validation"), "VALIDATION_ERROR", [
          { path: nul, message: t(req.locale, "validation.nulCharacter") },
        ]),
      );
      return;
    }
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
