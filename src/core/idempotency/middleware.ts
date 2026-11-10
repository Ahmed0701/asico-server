import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../config/logger.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";
import { requestHash } from "./hash.js";
import { IdempotencyRepository } from "./repository.js";

// Idempotency-Key: a client that repeats a write with the same key (a double click, a retry after a timeout) gets the
// first answer back instead of doing the work twice.
//
//  - Same user, same key, same request, finished: the stored response is replayed (Idempotent-Replayed: true) and
//    nothing runs.
//  - Same key, a different request: 422 IDEMPOTENCY_KEY_REUSED.
//  - Same key while the first request is still running: 409 IDEMPOTENCY_IN_PROGRESS, retryable (Retry-After).
//  - Only a successful (2xx) response is kept. A failure gives the key back, so the same key can be retried.
//  - The request is never stored, only an HMAC of it. Keys are per user and last 24 hours.
//
// Mount it after authentication, the permission check and validation, so it only ever sees requests that would run.
// Never mount it on /auth routes: those carry passwords and tokens.

export const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;
// A response larger than this is not kept (and the key is given back).
export const MAX_STORED_BODY_BYTES = 1024 * 1024;

export type IdempotencyOptions = {
  // Without the header the request is refused (400), for the endpoints that must never run twice.
  required?: boolean;
  // Extra input for the request hash that the body does not carry (an upload's file).
  fingerprint?: (req: Request) => Promise<string> | string;
  // Called when the request will not run (a replay, a conflict): to remove what it left behind (an upload's temp file).
  discard?: (req: Request) => Promise<void> | void;
  store?: IdempotencyRepository;
};

export function idempotent(options: IdempotencyOptions = {}): RequestHandler {
  const store = options.store ?? new IdempotencyRepository();

  // Removes what the request left behind (best effort: a failure here must not hide the real answer).
  const discard = async (req: Request): Promise<void> => {
    try {
      await options.discard?.(req);
    } catch (err) {
      logger.warn({ err }, "idempotency: could not discard what a refused request left behind");
    }
  };
  const refuse = async (req: Request, next: NextFunction, error: AppError): Promise<void> => {
    await discard(req);
    next(error);
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers["idempotency-key"];
      if (header === undefined) {
        if (options.required) {
          await refuse(
            req,
            next,
            new AppError(400, t(req.locale, "errors.idempotencyKeyRequired"), "IDEMPOTENCY_KEY_REQUIRED"),
          );
          return;
        }
        next();
        return;
      }
      const key = typeof header === "string" ? header : "";
      if (!KEY_PATTERN.test(key)) {
        await refuse(
          req,
          next,
          new AppError(400, t(req.locale, "errors.idempotencyKeyInvalid"), "INVALID_IDEMPOTENCY_KEY"),
        );
        return;
      }
      if (!req.user) {
        throw new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");
      }

      const url = req.originalUrl;
      const claim = await store.claim({
        userId: req.user.id,
        key,
        method: req.method,
        path: url.split("?")[0] ?? url,
        requestHash: requestHash({
          method: req.method,
          url,
          body: req.body as unknown,
          extra: await options.fingerprint?.(req),
        }),
        now: new Date(),
      });

      if (claim.kind === "mismatch") {
        await refuse(
          req,
          next,
          new AppError(422, t(req.locale, "errors.idempotencyKeyReused"), "IDEMPOTENCY_KEY_REUSED"),
        );
        return;
      }
      if (claim.kind === "in_progress") {
        res.setHeader("Retry-After", "1");
        await refuse(
          req,
          next,
          new AppError(409, t(req.locale, "errors.idempotencyInProgress"), "IDEMPOTENCY_IN_PROGRESS"),
        );
        return;
      }
      if (claim.kind === "replay") {
        await discard(req);
        res.setHeader("Idempotent-Replayed", "true");
        if (claim.body === null || claim.body === undefined) {
          res.status(claim.status).end();
        } else {
          res.status(claim.status).json(claim.body);
        }
        return;
      }

      // We own the key. Whatever the handler answers is settled (stored or given back) BEFORE it is sent, so a client
      // that retries the instant it has the response finds the stored result and not an unfinished claim.
      const settle = async (status: number, body: unknown): Promise<void> => {
        try {
          const size = body === null || body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body));
          if (status >= 200 && status < 300 && size <= MAX_STORED_BODY_BYTES) {
            if (await store.complete(claim, status, body ?? null)) {
              return;
            }
          }
          await store.release(claim);
        } catch (err) {
          logger.error({ err }, "idempotency: could not settle a key");
          await store.release(claim).catch(() => undefined);
        }
      };

      const sendJson = res.json.bind(res);
      const sendEnd = res.end.bind(res) as (...args: unknown[]) => Response;
      let settled = false;
      res.json = ((body: unknown): Response => {
        if (settled) {
          return sendJson(body);
        }
        settled = true;
        const status = res.statusCode;
        settle(status, body)
          .then(() => void sendJson(body))
          .catch(next);
        return res;
      }) as Response["json"];
      res.end = ((...args: unknown[]): Response => {
        if (settled) {
          return sendEnd(...args);
        }
        settled = true;
        settle(res.statusCode, null)
          .then(() => void sendEnd(...args))
          .catch(next);
        return res;
      }) as Response["end"];
      next();
    } catch (err) {
      next(err);
    }
  };
}
