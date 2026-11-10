import type { NextFunction, Request, Response } from "express";
import type { Permission } from "../../shared/constants/permissions.js";
import { prisma } from "../database/prisma.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

// Must run after `auth`. ADMIN passes every check; EMPLOYEE needs the code granted in the database.
export function requirePermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      next(new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED"));
      return;
    }
    if (req.user.role === "ADMIN") {
      next();
      return;
    }

    const grant = await prisma.userPermission.findFirst({
      where: { userId: req.user.id, permission: { code: permission } },
      select: { userId: true },
    });
    if (!grant) {
      next(new AppError(403, t(req.locale, "errors.forbidden"), "FORBIDDEN"));
      return;
    }
    next();
  };
}
