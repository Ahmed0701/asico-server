import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

// Must run after `auth` (and the route's permission): only an ADMIN goes on, whatever an EMPLOYEE was granted.
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED"));
    return;
  }
  if (req.user.role !== "ADMIN") {
    next(new AppError(403, t(req.locale, "errors.adminOnly"), "FORBIDDEN"));
    return;
  }
  next();
}
