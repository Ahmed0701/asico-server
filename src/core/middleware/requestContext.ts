import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Role } from "../../generated/prisma/client.js";
import type { LocaleCode } from "../../shared/constants/enums.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  req.validated = {};
  const header = req.headers["accept-language"] ?? "";
  req.locale = header.toLowerCase().startsWith("ar") ? "ar" : "en";
  res.setHeader("X-Request-Id", req.requestId);
  // Messages and labels depend on this header, so a cache must not share a response between languages.
  res.vary("Accept-Language");
  next();
}

// What a service needs to know about a request: the language for messages, and audit metadata.
export type RequestContext = {
  locale: LocaleCode;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
};

export type Actor = { id: string; role: Role };

export function contextOf(req: Request): RequestContext {
  return { locale: req.locale, ip: req.ip, userAgent: req.get("user-agent"), requestId: req.requestId };
}

// The signed-in user. Routes using it sit behind `auth`, so a missing user is a wiring mistake: answer 401.
export function actorOf(req: Request): Actor {
  if (!req.user) {
    throw new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");
  }
  return { id: req.user.id, role: req.user.role };
}
