import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl } from "./connection.js";

// Runs the daily report search indexes migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that
// is always rolled back: nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so
// `npm test` needs no database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const searchIndexes = names.find((name) => name.endsWith("_daily_report_search_indexes"))!;
// Only the migrations before it: the later ones (slice 19 among them) are written for the data the whole history leaves.
const before = names.filter((name) => name < searchIndexes);

describe.skipIf(!RUN)("the daily report search indexes migration, on a real database (rolled back)", () => {
  const client = new pg.Client({ connectionString: RUN ? databaseUrl() : "" });
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const one = async <T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T> =>
    (await q(text, values)).rows[0] as T;

  const indexesOf = async (): Promise<{ indexname: string; indexdef: string }[]> =>
    (
      await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch14b_data' AND tablename = 'DailyReport' ORDER BY indexname`,
      )
    ).rows;
  let beforeIndexes: string[] = [];
  let reportsBefore = 0;

  beforeAll(async () => {
    await client.connect();
    await q("BEGIN");
    await q("CREATE SCHEMA scratch14b_data");
    await q("SET LOCAL search_path = scratch14b_data, public");
    for (const name of before) await q(sqlOf(name));
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES ('u1','Admin','a@x.test','x',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce1','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now())`);
    await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
      ('v1','V-1','B1','1','ce1','u1','a1',now()), ('v2','V-2','B1','2','ce1','u1','a1',now())`);
    await q(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","issues","preparedBy","updatedAt") VALUES
      ('r1','v1','2026-03-01','SUNNY',10,'Slab on level 2','Late delivery of cement','Hamdy',now()),
      ('r2','v2','2026-03-01','HOT',8,'Shuttering',NULL,'Sara',now())`);
    beforeIndexes = (await indexesOf()).map((row) => row.indexname);
    reportsBefore = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyReport"`)).n;
    await q(sqlOf(searchIndexes));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'scratch14b_data'`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  it("sorts after the daily reports migration, whose table it indexes", () => {
    expect(names.indexOf(searchIndexes)).toBeGreaterThan(
      names.findIndex((name) => name.endsWith("_daily_reports")),
    );
  });

  it("adds exactly the two trigram indexes and removes none", async () => {
    const indexes = await indexesOf();

    expect(indexes.map((row) => row.indexname)).toEqual(
      [...beforeIndexes, "DailyReport_issues_trgm_idx", "DailyReport_preparedBy_trgm_idx"].sort(),
    );
    for (const [name, column] of [
      ["DailyReport_issues_trgm_idx", "issues"],
      ["DailyReport_preparedBy_trgm_idx", "preparedBy"],
    ]) {
      expect(indexes.find((row) => row.indexname === name)?.indexdef).toMatch(
        // PostgreSQL prints a column name without quotes when it needs none ("issues") and with them when it does.
        new RegExp(`USING gin \\("?${column}"? gin_trgm_ops\\)`),
      );
    }
  });

  it("changes no data: the reports are as they were, and the search still finds them", async () => {
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyReport"`)).n).toBe(reportsBefore);
    const found = (
      await q(
        `SELECT "id" FROM "DailyReport" WHERE "issues" ILIKE '%cement%' OR "preparedBy" ILIKE '%sara%' ORDER BY "id"`,
      )
    ).rows;
    expect(found.map((row) => row.id)).toEqual(["r1", "r2"]);
  });

  it("is a migration the planner can use: the issues index answers an ILIKE once the table is large enough to need it", async () => {
    await q(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","issues","preparedBy","updatedAt")
      SELECT 'bulk-' || d, 'v1', date '1900-01-01' + d, 'SUNNY', 1, 'work ' || d, 'issue number ' || d, 'Engineer', now()
      FROM generate_series(1, 20000) d`);
    await q(`ANALYZE "DailyReport"`);
    await q("SET LOCAL enable_seqscan = off");

    const plan = (
      await q(`EXPLAIN SELECT "id" FROM "DailyReport" WHERE "issues" ILIKE '%number 17777%'`)
    ).rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain("DailyReport_issues_trgm_idx");
  });
});
