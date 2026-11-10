import "dotenv/config";
import { z } from "zod";
import { isTimeZone } from "../../shared/utils/deadline.js";

// A blank value in .env (SMTP_PORT=) means "not set", not an empty string or zero.
const blankIsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// "Name <user@example.com>", '"Name" <user@example.com>' or a bare address.
const MAIL_FROM_PATTERN =
  /^(?:[^<>"]*|"[^"]*")\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/;
// A line break in a header value would let one setting inject another header.
const HAS_LINE_BREAK = /[\r\n]/;

export function mailAddressOf(from: string): string | undefined {
  const match = MAIL_FROM_PATTERN.exec(from.trim());
  return (match?.[1] ?? match?.[2])?.toLowerCase();
}

// A cookie domain is a bare host name (example.com, api.example.com, localhost): no scheme, port, path or space.
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const SMTP_VARIABLES = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "MAIL_FROM",
] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z.url(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    UPLOAD_DIR: z.string().min(1).default("uploads"),
    // How a villa document reaches the browser: "stream" (this process sends the file) or "accel" (an empty answer with
    // X-Accel-Redirect, and nginx sends the file from an internal /protected-files/ location). Unset: stream in development,
    // accel everywhere else. Without that nginx location, accel downloads are EMPTY (0 KB) files: set "stream" then.
    FILE_DELIVERY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["stream", "accel"]).optional(),
    ),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    MAX_DOCUMENTS_PER_VILLA: z.coerce.number().int().positive().default(10),
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    BODY_LIMIT: z.string().min(1).default("100kb"),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    EXPORT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    EXPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    IMPORT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    IMPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // The time zone the deadline of a small work is counted in (the end of its endDate day). Nothing else uses it: "today"
    // everywhere else is the UTC day.
    APP_TIMEZONE: z.preprocess(
      blankIsUnset,
      z
        .string()
        .trim()
        .refine(isTimeZone, "must be an IANA time zone name such as Asia/Kuwait")
        .default("Asia/Kuwait"),
    ),
    // A pending small work is "due soon" from this many hours before the end of its endDate day.
    SMALL_WORKS_ALERT_HOURS_BEFORE: z.preprocess(
      blankIsUnset,
      z.coerce.number().int().min(1).max(72).default(8),
    ),
    // The hourly job that raises the due soon and overdue notifications (and the email digest). Off in tests.
    SMALL_WORKS_ALERT_JOB_ENABLED: z.preprocess(
      blankIsUnset,
      z
        .enum(["true", "false"])
        .default("true")
        .transform((value) => value === "true"),
    ),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    // /auth/refresh has its own allowance: every open tab refreshes when the access token expires, so it is far wider than
    // the one for sign-in and the password endpoints. Counted per client IP, apart from the others.
    REFRESH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    // The refresh cookie. Secure defaults to on everywhere but development; SameSite to strict (the frontend and the API on
    // one site). A frontend on another site needs SameSite=none, which browsers accept only with Secure. The domain is
    // unset (the cookie belongs to the API host alone) unless the frontend shares a parent domain.
    REFRESH_COOKIE_SECURE: z.preprocess(
      blankIsUnset,
      z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    ),
    REFRESH_COOKIE_SAMESITE: z.preprocess(blankIsUnset, z.enum(["strict", "lax", "none"]).default("strict")),
    REFRESH_COOKIE_DOMAIN: z.preprocess(
      blankIsUnset,
      z
        .string()
        .trim()
        .regex(HOST_NAME, "must be a bare host name such as example.com (no scheme, port or path)")
        .optional(),
    ),
    PASSWORD_RESET_URL: z
      .url()
      .refine((value) => /^https?:\/\//i.test(value), "must be an http or https URL")
      .default("http://localhost:5173/reset-password"),
    // Outgoing mail (Gmail with an App Password, for instance). All six or none; required in production.
    SMTP_HOST: z.preprocess(blankIsUnset, z.string().min(1).optional()),
    SMTP_PORT: z.preprocess(blankIsUnset, z.coerce.number().int().min(1).max(65535).optional()),
    // Parsed from the words, not coerced: Boolean("false") is true.
    SMTP_SECURE: z.preprocess(
      blankIsUnset,
      z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    ),
    SMTP_USER: z.preprocess(blankIsUnset, z.string().min(1).optional()),
    SMTP_PASS: z.preprocess(
      blankIsUnset,
      z
        .string()
        .refine(
          (value) => !/\s/.test(value),
          "must not contain spaces (an App Password is 16 characters, no spaces)",
        )
        .optional(),
    ),
    MAIL_FROM: z.preprocess(
      blankIsUnset,
      z
        .string()
        .refine(
          (value) => !HAS_LINE_BREAK.test(value) && mailAddressOf(value) !== undefined,
          'must be an address such as "Asico <you@gmail.com>"',
        )
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    const secureCookie = env.REFRESH_COOKIE_SECURE ?? env.NODE_ENV !== "development";
    if (env.NODE_ENV === "production" && env.REFRESH_COOKIE_SECURE === false) {
      ctx.addIssue({
        code: "custom",
        path: ["REFRESH_COOKIE_SECURE"],
        message: "must not be false in production (the refresh token would travel in the clear)",
      });
    }
    if (env.REFRESH_COOKIE_SAMESITE === "none" && !secureCookie) {
      ctx.addIssue({
        code: "custom",
        path: ["REFRESH_COOKIE_SAMESITE"],
        message: "none needs a secure cookie (browsers refuse SameSite=None without Secure)",
      });
    }
    const missing = SMTP_VARIABLES.filter((name) => env[name] === undefined);
    const anySet = missing.length < SMTP_VARIABLES.length;
    if (missing.length > 0 && (env.NODE_ENV === "production" || anySet)) {
      for (const name of missing) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message:
            env.NODE_ENV === "production"
              ? "is required in production (password reset emails are sent through it)"
              : "is required when any other SMTP setting is given",
        });
      }
      return;
    }
    // Gmail sends only as the authenticated account and rewrites any other From address.
    if (env.SMTP_HOST?.toLowerCase().endsWith("gmail.com") && env.SMTP_USER && env.MAIL_FROM) {
      if (mailAddressOf(env.MAIL_FROM) !== env.SMTP_USER.trim().toLowerCase()) {
        ctx.addIssue({
          code: "custom",
          path: ["MAIL_FROM"],
          message: "must be the Gmail account in SMTP_USER",
        });
      }
    }
  });

function loadEnv(): z.output<typeof envSchema> {
  const result = envSchema.safeParse(process.env);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
  console.error(`Invalid environment configuration:\n${problems.join("\n")}`);
  process.exit(1);
}

export const env = loadEnv();
