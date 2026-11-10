import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, t(req.locale, "errors.notFound"), "NOT_FOUND"));
}
