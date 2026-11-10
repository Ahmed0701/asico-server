import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the daily labour migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always
// rolled back: nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test`
// needs no database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const dailyLabour = names.find((name) => name.endsWith("_daily_labour"))!;
// Only the migrations before it: the later ones (slice 19 among them) are written for the data the whole history leaves.
const before = names.filter((name) => name < dailyLabour);

describe.skipIf(!RUN)("the daily labour migration, on a real database (rolled back)", () => {
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
    for (const table of [
      "User",
      "Contractor",
      "Villa",
      "WorkItem",
      "DailyReport",
      "DailySmallWork",
      "SiteReport",
      "AuditLog",
      "Permission",
    ]) {
      result[table] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).n;
    }
    return result;
  };
  let tablesBefore: Record<string, number> = {};

  const labour = (
    id: string,
    villa: string,
    contractor: string,
    date: string,
    extra: Record<string, unknown> = {},
  ) => {
    const values = { labourCount: 10, notes: null, createdById: null, ...extra };
    return q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","notes","createdById","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [id, villa, date, contractor, values.labourCount, values.notes, values.createdById],
    );
  };

  beforeAll(async () => {
    await client.connect();

    // An empty database first: nothing to backfill and the migration still applies.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch13_empty");
    await q(sqlOf(dailyLabour));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyLabour"`)).n).toBe(0);
    await q("ROLLBACK");

    // Then one with data, kept open (and rolled back in afterAll) for the tests below.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch13_data");
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
      ('v2','V-2','B1','2','ce1','u1','a1','c2',now())`);
    tablesBefore = await counts();
    await q(sqlOf(dailyLabour));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('scratch13_empty', 'scratch13_data')`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  it("sorts after the migrations it builds on (the site reports are the last one before it)", () => {
    expect(names.indexOf(dailyLabour)).toBeGreaterThan(
      names.findIndex((name) => name.endsWith("_site_reports")),
    );
  });

  it("changes nothing that was there: the rows of the other tables are as they were", async () => {
    expect(await counts()).toEqual(tablesBefore);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyLabour"`)).n).toBe(0);
  });

  it("makes no type of its own: there is no enum", async () => {
    const types = (
      await q(
        `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'scratch13_data' AND t.typname LIKE 'DailyLabour%' AND t.typtype = 'e'`,
      )
    ).rows;

    expect(types).toEqual([]);
  });

  it("has the columns, with a DATE for the day and a version that starts at 1", async () => {
    const columns = (
      await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'scratch13_data' AND table_name = 'DailyLabour' ORDER BY ordinal_position`,
      )
    ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);

    expect(columns).toEqual([
      "id:text:NO",
      "villaId:text:NO",
      "labourDate:date:NO",
      "contractorId:text:NO",
      "labourCount:integer:NO",
      "notes:text:YES",
      "createdById:text:YES",
      "version:integer:NO",
      "createdAt:timestamp without time zone:NO",
      "updatedAt:timestamp without time zone:NO",
    ]);
    await labour("r-default", "v1", "c1", "2026-03-01");
    expect(
      (await one<{ version: number }>(`SELECT "version" FROM "DailyLabour" WHERE "id" = 'r-default'`))
        .version,
    ).toBe(1);
  });

  it("has the indexes, the unique key among them", async () => {
    const indexes = (
      await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch13_data' AND tablename = 'DailyLabour' ORDER BY indexname`,
      )
    ).rows;

    expect(indexes.map((row) => row.indexname)).toEqual([
      "DailyLabour_contractorId_idx",
      "DailyLabour_createdById_idx",
      "DailyLabour_labourDate_idx",
      "DailyLabour_pkey",
      "DailyLabour_villaId_contractorId_labourDate_key",
      "DailyLabour_villaId_labourDate_idx",
    ]);
    const unique = indexes.find((row) => row.indexname === "DailyLabour_villaId_contractorId_labourDate_key");
    // The id is the primary key, not merely unique.
    expect(
      (
        await q(
          `SELECT contype FROM pg_constraint WHERE conname = 'DailyLabour_pkey' AND conrelid = '"DailyLabour"'::regclass`,
        )
      ).rows,
    ).toEqual([{ contype: "p" }]);
    expect(unique?.indexdef).toContain("UNIQUE");
    expect(unique?.indexdef).toContain(`("villaId", "contractorId", "labourDate")`);
    expect(indexes.find((row) => row.indexname === "DailyLabour_villaId_labourDate_idx")?.indexdef).toContain(
      `("villaId", "labourDate" DESC)`,
    );
  });

  describe("one row per villa, contractor and day", () => {
    it("refuses a second row for the same villa, contractor and day with 23505, on the unique index", async () => {
      await labour("u-1", "v2", "c2", "2026-04-01");

      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('u-2','v2','2026-04-01','c2',1,now())`),
      ).toBe("23505");
    });

    it("lets the day through for another contractor, another villa and on another day", async () => {
      await labour("d-1", "v1", "c1", "2026-05-01");

      // Another contractor on the same villa and day (the table does not know which contractor a villa has).
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('d-2','v1','2026-05-01','c2',1,now())`),
      ).toBeNull();
      // Another villa, same contractor and day.
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('d-3','v2','2026-05-01','c1',1,now())`),
      ).toBeNull();
      // Another day.
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('d-4','v1','2026-05-02','c1',1,now())`),
      ).toBeNull();
    });

    it("refuses an update that moves a row onto the key of another (23505)", async () => {
      await labour("m-1", "v1", "c1", "2026-05-10");
      await labour("m-2", "v1", "c1", "2026-05-11");

      expect(await codeOf(`UPDATE "DailyLabour" SET "labourDate" = '2026-05-10' WHERE "id" = 'm-2'`)).toBe(
        "23505",
      );
      expect(await codeOf(`UPDATE "DailyLabour" SET "contractorId" = 'c2' WHERE "id" = 'm-2'`)).toBeNull();
    });
  });

  describe("the rules (CHECK constraints, 23514)", () => {
    // Every probe uses its own day, so only the rule under test can fail.
    let day = 0;
    const insert = (extra: Record<string, unknown>) => {
      day += 1;
      return codeOf(
        `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","notes","updatedAt")
         VALUES ($1,'v2',('2027-01-01'::date + $2::int),'c2',$3,$4,now())`,
        [`chk-${day}`, day, extra.labourCount ?? 1, extra.notes ?? null],
      );
    };

    it.each([
      [0, null],
      [100000, null],
      [-1, "23514"],
      [100001, "23514"],
    ])("labourCount %i -> %s", async (labourCount, code) => {
      expect(await insert({ labourCount })).toBe(code);
    });

    it.each([
      [null, null],
      ["n", null],
      ["n".repeat(500), null],
      ["", "23514"],
      ["n".repeat(501), "23514"],
    ])("notes of %#", async (notes, code) => {
      expect(await insert({ notes })).toBe(code);
    });

    it("counts characters, not bytes: 500 Arabic letters fit", async () => {
      expect(await insert({ notes: "ش".repeat(500) })).toBeNull();
    });

    it("refuses an update that breaks a rule", async () => {
      await labour("up-1", "v2", "c2", "2026-06-03");

      expect(await codeOf(`UPDATE "DailyLabour" SET "labourCount" = 100001 WHERE "id" = 'up-1'`)).toBe(
        "23514",
      );
      expect(await codeOf(`UPDATE "DailyLabour" SET "notes" = '' WHERE "id" = 'up-1'`)).toBe("23514");
    });

    it("refuses a missing contractor (23502): the contractor is required", async () => {
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","labourCount","updatedAt")
        VALUES ('nc-1','v2','2026-06-04',1,now())`),
      ).toBe("23502");
    });
  });

  describe("the foreign keys", () => {
    it("refuses a row for a villa or a contractor that does not exist (23503)", async () => {
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('f-1','nope','2026-07-01','c1',1,now())`),
      ).toBe("23503");
      expect(
        await codeOf(`INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
        VALUES ('f-2','v1','2026-07-01','nope',1,now())`),
      ).toBe("23503");
    });

    it("keeps a villa that has a labour row: deleting it is refused (RESTRICT, 23503)", async () => {
      await labour("keep-1", "v1", "c1", "2026-07-02");

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v1'`));
    });

    it("keeps a contractor named on a labour row: deleting it is refused (RESTRICT, 23503)", async () => {
      await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c8','Named','018',now())`);
      await labour("keep-2", "v2", "c8", "2026-07-03");

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c8'`));
    });

    it("lets a villa with no labour row go, and a contractor with none", async () => {
      await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
        VALUES ('v9','V-9','B1','9','ce1','u1','a1',now())`);
      await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c9','Free','019',now())`);

      expect(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v9'`)).toBeNull();
      expect(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c9'`)).toBeNull();
    });

    it("keeps the row when its author is deleted: createdById becomes NULL (SET NULL)", async () => {
      await labour("author-1", "v2", "c2", "2026-07-04", { createdById: "u2" });

      await q(`DELETE FROM "User" WHERE "id" = 'u2'`);

      expect(
        await one(`SELECT "createdById", "labourCount" FROM "DailyLabour" WHERE "id" = 'author-1'`),
      ).toEqual({
        createdById: null,
        labourCount: 10,
      });
    });
  });
});
