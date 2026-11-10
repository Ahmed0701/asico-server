import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./core/config/env.js";
import { errorHandler } from "./core/errors/errorHandler.js";
import { notFound } from "./core/middleware/notFound.js";
import { rateLimiter } from "./core/middleware/rateLimit.js";
import { requestContext } from "./core/middleware/requestContext.js";
import { v1Router } from "./routes/index.js";

export function createApp(): Express {
  const app = express();

  app.set("trust proxy", env.TRUST_PROXY);

  // requestContext runs first so every error, including body-parser failures, has a locale and request id.
  app.use(requestContext);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      // So a browser on another origin can read them (see docs/write-safety.md).
      exposedHeaders: ["Idempotent-Replayed", "Retry-After", "ETag", "X-Request-Id", "Content-Disposition"],
    }),
  );
  app.use(rateLimiter);
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(cookieParser());
  app.use("/api/v1", v1Router);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
