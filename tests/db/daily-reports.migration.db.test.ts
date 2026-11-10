import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the daily reports migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always
// rolled back: nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test`
// needs no database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const dailyReports = names.find((name) => name.endsWith("_daily_reports"))!;
// Only the migrations before it: the search indexes and slice 19 come after, and are written for the data this one makes.
const before = names.filter((name) => name < dailyReports);

describe.skipIf(!RUN)("the daily reports migration, on a real database (rolled back)", () => {
  const client = new pg.Client({ connectionString: RUN ? databaseUrl() : "" });
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const one = async <T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T> =>
    (await q(text, values)).rows[0] as T;

  // The SQLSTATE the statement fails with (null when it succeeds), without losing the transaction.
  async function codeOf(text: string, values?: unknown[]): Promise<string | null> {
    await q("SAVEPOINT probe");
    try {
      await q(text, values);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? String(err);
    } finally {
      await q("ROLLBACK TO SAVEPOINT probe");
      await q("RELEASE SAVEPOINT probe");
    }
  }

  async function schemaWithEveryMigrationBeforeThisOne(schema: string): Promise<void> {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET LOCAL search_path = ${schema}, public`);
    for (const name of before) await q(sqlOf(name));
  }

  const counts = async (): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const table of ["User", "Contractor", "Villa", "WorkItem", "AuditLog", "Permission"]) {
      result[table] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).n;
    }
    return result;
  };
  let tablesBefore: Record<string, number> = {};

  const report = (id: string, villa: string, date: string, extra: Record<string, unknown> = {}) => {
    const values = {
      workersCount: 10,
      workDone: "Work",
      issues: null,
      preparedBy: "Me",
      contractorId: null,
      createdById: null,
      ...extra,
    };
    return q(
      `INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","issues","preparedBy","contractorId","createdById","updatedAt")
       VALUES ($1,$2,$3,'SUNNY',$4,$5,$6,$7,$8,$9,now())`,
      [
        id,
        villa,
        date,
        values.workersCount,
        values.workDone,
        values.issues,
        values.preparedBy,
        values.contractorId,
        values.createdById,
      ],
    );
  };

  beforeAll(async () => {
    await client.connect();

    // An empty database first: nothing to backfill and the migration still applies.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch10_empty");
    await q(sqlOf(dailyReports));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyReport"`)).n).toBe(0);
    await q("ROLLBACK");

    // Then one with data, kept open (and rolled back in afterAll) for the tests below.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch10_data");
    await q(`INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES
      ('u1','Admin','a@x.test','x',now()), ('u2','Maker','m@x.test','x',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c1','Nile','010',now()), ('c2','Giza','011',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce1','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now())`);
    await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt") VALUES
      ('v1','V-1','B1','1','ce1','u1','a1','c1',now()),
      ('v2','V-2','B1','2','ce1','u1','a1',NULL,now())`);
    tablesBefore = await counts();
    await q(sqlOf(dailyReports));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('scratch10_empty', 'scratch10_data')`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  it("sorts after the migrations it builds on (the open works are the last one it needs)", () => {
    expect(names.indexOf(dailyReports)).toBeGreaterThan(
      names.findIndex((name) => name.endsWith("_open_works")),
    );
  });

  it("changes nothing that was there: the rows of the other tables are as they were", async () => {
    expect(await counts()).toEqual(tablesBefore);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyReport"`)).n).toBe(0);
  });

  it("makes the Weather type with the five values in order", async () => {
    const values = (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'Weather' AND n.nspname = 'scratch10_data' ORDER BY e.enumsortorder`,
      )
    ).rows.map((row) => row.enumlabel);

    expect(values).toEqual(["HOT", "SUNNY", "WINDY", "RAINY", "DUSTY"]);
  });

  it("has the columns, with a DATE for the day and a version that starts at 1", async () => {
    const columns = (
      await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'scratch10_data' AND table_name = 'DailyReport' ORDER BY ordinal_position`,
      )
    ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);

    expect(columns).toEqual([
      "id:text:NO",
      "villaId:text:NO",
      "reportDate:date:NO",
      "weather:USER-DEFINED:NO",
      "workersCount:integer:NO",
      "workDone:text:NO",
      "issues:text:YES",
      "preparedBy:text:NO",
      "contractorId:text:YES",
      "createdById:text:YES",
      "version:integer:NO",
      "createdAt:timestamp without time zone:NO",
      "updatedAt:timestamp without time zone:NO",
    ]);
    await report("r-default", "v1", "2026-03-01");
    expect(
      (await one<{ version: number }>(`SELECT "version" FROM "DailyReport" WHERE "id" = 'r-default'`))
        .version,
    ).toBe(1);
  });

  it("has the indexes, the unique day among them, and the trigram index on the work done", async () => {
    const indexes = (
      await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch10_data' AND tablename = 'DailyReport' ORDER BY indexname`,
      )
    ).rows;

    expect(indexes.map((row) => row.indexname)).toEqual([
      "DailyReport_contractorId_idx",
      "DailyReport_createdById_idx",
      "DailyReport_pkey",
      "DailyReport_reportDate_idx",
      "DailyReport_villaId_reportDate_key",
      "DailyReport_workDone_trgm_idx",
    ]);
    expect(indexes.find((row) => row.indexname === "DailyReport_villaId_reportDate_key")?.indexdef).toContain(
      "UNIQUE",
    );
    expect(indexes.find((row) => row.indexname === "DailyReport_workDone_trgm_idx")?.indexdef).toMatch(
      /USING gin .*gin_trgm_ops/,
    );
  });

  describe("one report per villa per day", () => {
    it("refuses a second report for the same villa and day with 23505, on the unique index", async () => {
      await report("u-1", "v2", "2026-04-01");

      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","updatedAt")
        VALUES ('u-2','v2','2026-04-01','HOT',1,'x','Me',now())`),
      ).toBe("23505");
    });

    it("lets the same day through on another villa and another day on the same villa", async () => {
      await report("d-1", "v1", "2026-05-01");

      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","updatedAt")
        VALUES ('d-2','v2','2026-05-01','HOT',1,'x','Me',now())`),
      ).toBeNull();
      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","updatedAt")
        VALUES ('d-3','v1','2026-05-02','HOT',1,'x','Me',now())`),
      ).toBeNull();
    });
  });

  describe("the rules (CHECK constraints, 23514)", () => {
    const insert = (extra: Record<string, unknown>, id = "chk") =>
      codeOf(
        `INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","issues","preparedBy","updatedAt")
         VALUES ($1,'v2','2026-06-01','HOT',$2,$3,$4,$5,now())`,
        [id, extra.workersCount ?? 1, extra.workDone ?? "x", extra.issues ?? null, extra.preparedBy ?? "Me"],
      );

    it.each([
      [0, null],
      [100000, null],
      [-1, "23514"],
      [100001, "23514"],
    ])("workersCount %i -> %s", async (workersCount, code) => {
      expect(await insert({ workersCount })).toBe(code);
    });

    it.each([
      ["x", null],
      ["w".repeat(5000), null],
      ["", "23514"],
      ["w".repeat(5001), "23514"],
    ])("workDone of %#", async (workDone, code) => {
      expect(await insert({ workDone })).toBe(code);
    });

    it.each([
      [null, null],
      ["i".repeat(5000), null],
      ["", "23514"],
      ["i".repeat(5001), "23514"],
    ])("issues of %#", async (issues, code) => {
      expect(await insert({ issues })).toBe(code);
    });

    it.each([
      ["p", null],
      ["p".repeat(100), null],
      ["", "23514"],
      ["p".repeat(101), "23514"],
    ])("preparedBy of %#", async (preparedBy, code) => {
      expect(await insert({ preparedBy })).toBe(code);
    });

    it("counts characters, not bytes: 5,000 Arabic letters fit", async () => {
      expect(await insert({ workDone: "ش".repeat(5000), issues: "ش".repeat(5000) })).toBeNull();
    });

    it("refuses a weather that is not one of the five (22P02) and an update that breaks a rule", async () => {
      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","updatedAt")
          VALUES ('w-1','v2','2026-06-02','SNOWY',1,'x','Me',now())`),
      ).toBe("22P02");
      await report("up-1", "v2", "2026-06-03");
      expect(await codeOf(`UPDATE "DailyReport" SET "workersCount" = 100001 WHERE "id" = 'up-1'`)).toBe(
        "23514",
      );
    });
  });

  describe("the foreign keys", () => {
    it("refuses a report for a villa or a contractor that does not exist (23503)", async () => {
      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","updatedAt")
        VALUES ('f-1','nope','2026-07-01','HOT',1,'x','Me',now())`),
      ).toBe("23503");
      expect(
        await codeOf(`INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","contractorId","updatedAt")
        VALUES ('f-2','v1','2026-07-01','HOT',1,'x','Me','nope',now())`),
      ).toBe("23503");
    });

    it("keeps a villa that has a report: deleting it is refused (RESTRICT, 23503)", async () => {
      await report("keep-1", "v1", "2026-07-02");

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v1'`));
    });

    it("keeps a contractor named on a report: deleting it is refused (RESTRICT, 23503)", async () => {
      await report("keep-2", "v2", "2026-07-03", { contractorId: "c2" });

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c2'`));
    });

    it("lets a villa with no report go, and a contractor with no report", async () => {
      await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
        VALUES ('v9','V-9','B1','9','ce1','u1','a1',now())`);
      await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c9','Free','019',now())`);

      expect(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v9'`)).toBeNull();
      expect(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c9'`)).toBeNull();
    });

    it("keeps the report when its author is deleted: createdById becomes NULL (SET NULL)", async () => {
      await report("author-1", "v2", "2026-07-04", { createdById: "u2" });

      await q(`DELETE FROM "User" WHERE "id" = 'u2'`);

      expect(
        await one(`SELECT "createdById", "preparedBy" FROM "DailyReport" WHERE "id" = 'author-1'`),
      ).toEqual({ createdById: null, preparedBy: "Me" });
    });
  });
});
