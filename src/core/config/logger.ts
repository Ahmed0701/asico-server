import pino, { type LoggerOptions } from "pino";
import { env } from "./env.js";

// Exported so a test can check what is masked.
export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "password",
      "token",
      "*.password",
      "*.token",
      "*.refreshToken",
      "SMTP_PASS",
      "*.SMTP_PASS",
      "*.pass",
      "*.auth.pass",
      "resetLink",
      "*.resetLink",
      "link",
      "*.link",
      "html",
      "*.html",
    ],
    censor: "[REDACTED]",
  },
};

export const logger = pino(loggerOptions);
