import { readFileSync } from "node:fs";
import { parse } from "dotenv";

// The real connection string for the tests that need a database: DATABASE_URL from .env, since the test setup only
// fills in a placeholder when none is set. These tests run only with ASICO_DB_TESTS=1.
export function databaseUrl(): string {
  try {
    const fromFile = parse(readFileSync(new URL("../../.env", import.meta.url))).DATABASE_URL;
    if (fromFile) return fromFile;
  } catch {
    // no .env: fall through to the environment
  }
  return process.env.DATABASE_URL ?? "";
}

// The codes PostgreSQL gives a delete that ON DELETE RESTRICT refuses: 23001 (restrict_violation) from PostgreSQL 18,
// 23503 (foreign_key_violation) before it. Prisma maps both to P2003.
export const RESTRICT_CODES: string[] = ["23503", "23001"];
