import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/core/config/env.js";

// .env.example is what a new machine is set up from: it must list every setting the application reads, and be a valid
// configuration once the placeholders are filled in.
const lines = readFileSync(join(process.cwd(), ".env.example"), "utf8").split("\n");
const assignments = lines
  .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
  .filter((match): match is RegExpExecArray => match !== null);
const given = Object.fromEntries(
  assignments.map((match) => [match[1], (match[2] ?? "").replace(/^"(.*)"$/, "$1")]),
);

describe(".env.example", () => {
  it("lists every setting the environment schema reads, each once", () => {
    const names = assignments.map((match) => match[1]);

    expect(Object.keys(envSchema.shape).filter((key) => !names.includes(key))).toEqual([]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("is a valid configuration for development once the secret and the database password are filled in", () => {
    const result = envSchema.safeParse({
      ...given,
      JWT_ACCESS_SECRET: "x".repeat(48),
      DATABASE_URL: "postgresql://asico:secret@localhost:5432/asico?schema=public",
    });

    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual([]);
  });

  it("leaves the refresh cookie on its safe defaults", () => {
    const parsed = envSchema.parse({
      ...given,
      JWT_ACCESS_SECRET: "x".repeat(48),
      DATABASE_URL: "postgresql://asico:secret@localhost:5432/asico?schema=public",
    });

    expect(parsed.REFRESH_COOKIE_SAMESITE).toBe("strict");
    expect(parsed.REFRESH_COOKIE_SECURE).toBeUndefined();
    expect(parsed.REFRESH_COOKIE_DOMAIN).toBeUndefined();
    expect(parsed.REFRESH_RATE_LIMIT_MAX).toBe(30);
    expect(parsed.REFRESH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});
