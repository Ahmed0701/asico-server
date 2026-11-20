import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";
import { PostgresRateLimitStore } from "./rateLimitStore.js";

type RateLimitOptions = {
  // Names the limiter's counters in the shared store.
  name: string;
  windowMs: number;
  // A function is read on every request, so the limit can follow the environment.
  limit: number | (() => number);
  // What a request is counted against. The default is the client IP.
  keyGenerator?: (req: Request) => string;
};

// The server processes of the cluster (dist/cluster.js sets it for its workers); 1 without a cluster.
export const clusterWorkers = Math.max(1, Number(process.env["ASICO_CLUSTER_WORKERS"] ?? "1") || 1);

// Each limiter keeps its own counters. One process keeps them in memory. Under a cluster they live in PostgreSQL, shared by
// every worker, so a limit stays the same however many processes serve it; if the database cannot be reached, a request is
// let through rather than refused.
export function createRateLimiter({ name, windowMs, limit, keyGenerator }: RateLimitOptions) {
  return rateLimit({
    windowMs,
    limit: typeof limit === "function" ? () => limit() : limit,
    ...(clusterWorkers > 1 && { store: new PostgresRateLimitStore(name), passOnStoreError: true }),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (req, _res, next) => {
      next(new AppError(429, t(req.locale, "errors.tooManyRequests"), "TOO_MANY_REQUESTS"));
    },
  });
}

// The general limit on every request stays in each process's memory (a database write on every request would cost more
// than it protects): under a cluster each worker allows its share of it.
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: Math.max(1, Math.ceil(env.RATE_LIMIT_MAX / clusterWorkers)),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, _res, next) => {
    next(new AppError(429, t(req.locale, "errors.tooManyRequests"), "TOO_MANY_REQUESTS"));
  },
});

// The signed-in user, so one person cannot use up another's allowance; the client IP when nobody is signed in.
export function userOrIpKey(req: Request): string {
  return req.user ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export const exportRateLimiter = createRateLimiter({
  name: "export",
  windowMs: env.EXPORT_RATE_LIMIT_WINDOW_MS,
  limit: () => env.EXPORT_RATE_LIMIT_MAX,
  keyGenerator: userOrIpKey,
});

// The refresh endpoint, apart from the sign-in and password ones: it is called by every open tab when the access token
// expires. No user is known yet (the credential is the cookie), so it is counted per client IP.
export const refreshRateLimiter = createRateLimiter({
  name: "refresh",
  windowMs: env.REFRESH_RATE_LIMIT_WINDOW_MS,
  limit: () => env.REFRESH_RATE_LIMIT_MAX,
});

// Imports and their templates share one allowance per user, apart from the export one.
export const importRateLimiter = createRateLimiter({
  name: "import",
  windowMs: env.IMPORT_RATE_LIMIT_WINDOW_MS,
  limit: () => env.IMPORT_RATE_LIMIT_MAX,
  keyGenerator: userOrIpKey,
});
