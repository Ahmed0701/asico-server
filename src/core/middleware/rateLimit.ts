import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

type RateLimitOptions = {
  windowMs: number;
  // A function is read on every request, so the limit can follow the environment.
  limit: number | (() => number);
  // What a request is counted against. The default is the client IP.
  keyGenerator?: (req: Request) => string;
};

// Each limiter keeps its own counters. The default in-memory store is per instance;
// give it a shared `store` before scaling past one replica.
export function createRateLimiter({ windowMs, limit, keyGenerator }: RateLimitOptions) {
  return rateLimit({
    windowMs,
    limit: typeof limit === "function" ? () => limit() : limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (req, _res, next) => {
      next(new AppError(429, t(req.locale, "errors.tooManyRequests"), "TOO_MANY_REQUESTS"));
    },
  });
}

export const rateLimiter = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
});

// The signed-in user, so one person cannot use up another's allowance; the client IP when nobody is signed in.
export function userOrIpKey(req: Request): string {
  return req.user ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export const exportRateLimiter = createRateLimiter({
  windowMs: env.EXPORT_RATE_LIMIT_WINDOW_MS,
  limit: () => env.EXPORT_RATE_LIMIT_MAX,
  keyGenerator: userOrIpKey,
});

// The refresh endpoint, apart from the sign-in and password ones: it is called by every open tab when the access token
// expires. No user is known yet (the credential is the cookie), so it is counted per client IP.
export const refreshRateLimiter = createRateLimiter({
  windowMs: env.REFRESH_RATE_LIMIT_WINDOW_MS,
  limit: () => env.REFRESH_RATE_LIMIT_MAX,
});

// Imports and their templates share one allowance per user, apart from the export one.
export const importRateLimiter = createRateLimiter({
  windowMs: env.IMPORT_RATE_LIMIT_WINDOW_MS,
  limit: () => env.IMPORT_RATE_LIMIT_MAX,
  keyGenerator: userOrIpKey,
});
