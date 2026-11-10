import type { NextFunction, Request, Response } from "express";
import { prisma } from "../database/prisma.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";
import { ExpiredAccessTokenError, InvalidAccessTokenError, verifyAccessToken } from "../security/jwt.js";

function bearerToken(header: string | undefined): string | undefined {
  const [scheme, token, ...rest] = (header ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token && rest.length === 0 ? token : undefined;
}

// Verifies the access token, then loads the user's current id and role. Reading them on every request
// means deactivating a user or changing their role takes effect immediately, not when the token expires.
export async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const unauthorized = new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");

  const token = bearerToken(req.headers.authorization);
  if (!token) {
    next(unauthorized);
    return;
  }

  let userId: string;
  try {
    ({ userId } = await verifyAccessToken(token));
  } catch (err) {
    if (err instanceof ExpiredAccessTokenError) {
      next(new AppError(401, t(req.locale, "errors.tokenExpired"), "TOKEN_EXPIRED"));
      return;
    }
    if (err instanceof InvalidAccessTokenError) {
      next(unauthorized);
      return;
    }
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) {
    next(unauthorized);
    return;
  }

  req.user = { id: user.id, role: user.role };
  next();
}
