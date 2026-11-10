import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { databaseUrl } from "./connection.js";

// A scratch schema on the real PostgreSQL, for the tests that need to COMMIT (several connections at once): created for the
// run with every migration applied, and dropped by `dispose()`. No database is created or reset, and the asico schema is
// never touched. These tests run only with ASICO_DB_TESTS=1.
const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);

export type ScratchDatabase = {
  schema: string;
  // A plain connection whose search_path is the scratch schema, for fixtures and for reading back.
  admin: pg.Client;
  prisma: PrismaClient;
  q: (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
  dispose: () => Promise<void>;
};

// CONNECTION BUDGET: PostgreSQL allows 100 connections (about 97 for clients) and the DB test files run side by side, each
// with its own pool and its own admin connection. The pools of all the files together must stay well under that, or a file
// fails with 53300 "too many clients". Today: concurrency 32 + daily reports 20 + import 13 + small works 8 + site reports 5 + daily labour 5 + dashboard 1 + repository 5 + villas import 6 + export round trip 8 + contractor summary 4 + 11 admin = 117 if every file ran at the same
// moment, and the migration files (the slice 19 one too) hold one connection each while they run (the slice 19 cleanup file holds two: its own and the script's). They do not: the files that run at once are
// limited by the machine's cores (8 cores run at most 7 files together, about 70 connections), so the sum is the worst case on
// a machine with enough cores for all of them, where a pool would have to shrink.
export async function openScratch(prefix: string, poolSize = 24): Promise<ScratchDatabase> {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: databaseUrl() });
  const q = (text: string, values?: unknown[]) => admin.query(text, values);
  await admin.connect();
  let prisma: PrismaClient | undefined;
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path = ${schema}, public`);
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      await q(readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8"));
    }
    // The schema is given twice: to the adapter (it qualifies the ORM's queries) and to the connections (the raw SQL). The
    // pool is larger than the jobs of a round: some services read through the global client inside a transaction (the
    // villa update checks its contractor that way), so a pool as small as the round would starve before it could deadlock.
    const adapter = new PrismaPg(
      { connectionString: databaseUrl(), max: poolSize, options: `-c search_path=${schema}` },
      { schema },
    );
    // These tests check what the locks and rules DO, not how fast the machine is. Prisma's defaults (2 s to get a
    // connection, 5 s for an interactive transaction) are right for the API but expire on a busy machine, where the other
    // test files are also opening connections and running migrations; that was the flaky failure ("Unable to start a
    // transaction in the given time", "expired transaction"). The scratch client therefore waits much longer.
    prisma = new PrismaClient({ adapter, transactionOptions: { maxWait: 60_000, timeout: 120_000 } });
  } catch (err) {
    await prisma?.$disconnect().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw err;
  }
  const ready = prisma;
  return {
    schema,
    admin,
    prisma: ready,
    q,
    async dispose() {
      try {
        await ready.$disconnect();
      } finally {
        try {
          await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  };
}
