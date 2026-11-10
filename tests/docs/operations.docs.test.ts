import { describe, expect, it, vi } from "vitest";
import { code, doc, read, tables } from "./source.js";

// docs/operations.md names every environment variable the application reads, with its default.

vi.mock("../../src/core/database/prisma.js", () => ({ prisma: {} }));

// Variables the documents mention that the schema does not read: the seed, and the compose file.
const OUTSIDE_THE_SCHEMA = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
];

function documented(): Map<string, string> {
  const found = new Map<string, string>();
  for (const { table } of tables(doc("operations.md"))) {
    if (table.header[0] !== "Variable") continue;
    for (const row of table.rows) found.set(code(row[0] ?? ""), row[1] ?? "");
  }
  return found;
}

describe("docs/operations.md", async () => {
  const { envSchema } = await import("../../src/core/config/env.js");
  const keys = Object.keys(envSchema.shape);
  const docs = documented();

  it("lists every variable of the environment schema", () => {
    expect(keys.filter((key) => !docs.has(key))).toEqual([]);
  });

  it("lists no variable that is neither in the schema nor one of the few read elsewhere", () => {
    expect(
      [...docs.keys()].filter((key) => !keys.includes(key) && !OUTSIDE_THE_SCHEMA.includes(key)),
    ).toEqual([]);
  });

  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://u:p@localhost:5432/d",
    JWT_ACCESS_SECRET: "x".repeat(40),
  };

  it("gives each variable's default as the schema has it", () => {
    const parsed = envSchema.parse(base) as Record<string, unknown>;
    for (const key of keys) {
      const cell = docs.get(key) ?? "";
      const value = parsed[key];
      if (cell === "required") {
        expect(
          envSchema.safeParse({ ...base, [key]: undefined }).success,
          `${key} is documented as required`,
        ).toBe(false);
      } else if (cell === "unset") {
        expect(value, key).toBeUndefined();
      } else if (cell === "empty") {
        expect(value, key).toEqual([]);
      } else {
        expect(code(cell), `${key} default`).toBe(String(value));
      }
    }
  });

  it("is in step with .env.example about which variables are required", () => {
    const example = read(".env.example");
    for (const [key, cell] of docs) {
      if (cell !== "required" || !keys.includes(key)) continue;
      expect(example, key).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });

  it("names the scripts it tells people to run", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    for (const [, name] of doc("operations.md").matchAll(/`npm run ([a-z:-]+)`/g)) {
      expect(scripts, name).toHaveProperty(name!);
    }
  });

  it("says what the limiters default to, as the schema has them", () => {
    const parsed = envSchema.parse(base);
    const limiters = new Map<string, string>();
    for (const { table } of tables(doc("operations.md"))) {
      if (table.header[0] !== "Limiter") continue;
      for (const row of table.rows) limiters.set(row[0] ?? "", row[3] ?? "");
    }
    expect(limiters.get("Global")).toBe(`${parsed.RATE_LIMIT_MAX} per minute`);
    expect(limiters.get("Auth")).toBe(`${parsed.AUTH_RATE_LIMIT_MAX} per 15 minutes`);
    expect(limiters.get("Refresh")).toBe(`${parsed.REFRESH_RATE_LIMIT_MAX} per minute`);
    expect(limiters.get("Export")).toBe(`${parsed.EXPORT_RATE_LIMIT_MAX} per minute`);
    expect(limiters.get("Import")).toBe(`${parsed.IMPORT_RATE_LIMIT_MAX} per minute`);
    expect(parsed.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.AUTH_RATE_LIMIT_WINDOW_MS).toBe(15 * 60_000);
    expect(parsed.REFRESH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.EXPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.IMPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});
