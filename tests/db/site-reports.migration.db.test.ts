import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the site reports migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always
// rolled back: nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test`
// needs no database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const siteReports = names.find((name) => name.endsWith("_site_reports"))!;
const before = names.filter((name) => name < siteReports);

describe.skipIf(!RUN)("the site reports migration, on a real database (rolled back)", () => {
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
      "AuditLog",
      "Permission",
    ]) {
      result[table] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).n;
    }
    return result;
  };
  let tablesBefore: Record<string, number> = {};

  const report = (id: string, villa: string, extra: Record<string, unknown> = {}) => {
    const values = {
      title: "First fix check",
      inspector: "Eng. Hamdy",
      type: "INSPECTION",
      rating: 4,
      findings: "All good",
      recommendations: null,
      createdById: null,
      ...extra,
    };
    return q(
      `INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","recommendations","createdById","updatedAt")
       VALUES ($1,$2,$3,'2026-03-01',$4,$5::"SiteReportType",$6,$7,$8,$9,now())`,
      [
        id,
        villa,
        values.title,
        values.inspector,
        values.type,
        values.rating,
        values.findings,
        values.recommendations,
        values.createdById,
      ],
    );
  };
  // An insert that names the columns it is given and lets the rest default, for the rules.
  const insert = (extra: Record<string, unknown>, id = "chk") => {
    const values = {
      title: "t",
      inspector: "n",
      type: "SAFETY",
      rating: 3,
      findings: "f",
      recommendations: null,
      ...extra,
    };
    return codeOf(
      `INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","recommendations","updatedAt")
       VALUES ($1,'v2',$2,'2026-06-01',$3,$4::"SiteReportType",$5,$6,$7,now())`,
      [
        id,
        values.title,
        values.inspector,
        values.type,
        values.rating,
        values.findings,
        values.recommendations,
      ],
    );
  };

  beforeAll(async () => {
    await client.connect();

    // An empty database first: nothing to backfill and the migration still applies.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch12_empty");
    await q(sqlOf(siteReports));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "SiteReport"`)).n).toBe(0);
    await q("ROLLBACK");

    // Then one with data, kept open (and rolled back in afterAll) for the tests below.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch12_data");
    await q(`INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES
      ('u1','Admin','a@x.test','x',now()), ('u2','Maker','m@x.test','x',now())`);
    await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c1','Nile','010',now())`);
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce1','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now())`);
    await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt") VALUES
      ('v1','V-1','B1','1','ce1','u1','a1','c1',now()),
      ('v2','V-2','B1','2','ce1','u1','a1',NULL,now())`);
    await q(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
      VALUES ('sw1','v1','2026-03-01','x',1,'u','n',now())`);
    tablesBefore = await counts();
    await q(sqlOf(siteReports));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('scratch12_empty', 'scratch12_data')`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  it("sorts after the migrations it builds on (the villas, the users and the trigram extension)", () => {
    for (const earlier of ["_init", "_extras", "_villas", "_daily_reports", "_daily_small_works"]) {
      expect(names.indexOf(siteReports)).toBeGreaterThan(names.findIndex((name) => name.endsWith(earlier)));
    }
  });

  it("changes nothing that was there: the rows of the other tables are as they were", async () => {
    expect(await counts()).toEqual(tablesBefore);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "SiteReport"`)).n).toBe(0);
  });

  it("makes the SiteReportType type with its four values in order", async () => {
    const values = (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'SiteReportType' AND n.nspname = 'scratch12_data' ORDER BY e.enumsortorder`,
      )
    ).rows.map((row) => row.enumlabel);

    expect(values).toEqual(["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"]);
  });

  it("has the columns, with a DATE for the day, a SMALLINT rating, a nullable recommendations and a version that starts at 1", async () => {
    const columns = (
      await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'scratch12_data' AND table_name = 'SiteReport' ORDER BY ordinal_position`,
      )
    ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);

    expect(columns).toEqual([
      "id:text:NO",
      "villaId:text:NO",
      "title:text:NO",
      "visitDate:date:NO",
      "inspector:text:NO",
      "type:USER-DEFINED:NO",
      "rating:smallint:NO",
      "findings:text:NO",
      "recommendations:text:YES",
      "createdById:text:YES",
      "version:integer:NO",
      "createdAt:timestamp without time zone:NO",
      "updatedAt:timestamp without time zone:NO",
    ]);
    await report("r-default", "v1");
    expect(await one(`SELECT "version" FROM "SiteReport" WHERE "id" = 'r-default'`)).toEqual({ version: 1 });
  });

  it("has no contractor or engineer column", async () => {
    const found = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'scratch12_data' AND table_name = 'SiteReport'
         AND (column_name ILIKE '%contractor%' OR column_name ILIKE '%engineer%')`,
    );

    expect(found.n).toBe(0);
  });

  it("has the indexes, the trigram index on the title among them, and no unique one but the key", async () => {
    const indexes = (
      await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch12_data' AND tablename = 'SiteReport' ORDER BY indexname`,
      )
    ).rows;

    expect(indexes.map((row) => row.indexname)).toEqual([
      "SiteReport_createdById_idx",
      "SiteReport_pkey",
      "SiteReport_title_trgm_idx",
      "SiteReport_villaId_visitDate_idx",
      "SiteReport_visitDate_idx",
    ]);
    expect(indexes.filter((row) => /UNIQUE/.test(row.indexdef)).map((row) => row.indexname)).toEqual([
      "SiteReport_pkey",
    ]);
    expect(indexes.find((row) => row.indexname === "SiteReport_title_trgm_idx")?.indexdef).toMatch(
      /USING gin .*gin_trgm_ops/,
    );
    expect(indexes.find((row) => row.indexname === "SiteReport_villaId_visitDate_idx")?.indexdef).toContain(
      '"visitDate" DESC',
    );
  });

  it("lets the same visit be written twice on one day: there is no natural key", async () => {
    await report("twin-1", "v2");

    expect(
      await report("twin-2", "v2").then(
        () => null,
        (err: { code?: string }) => err.code ?? "?",
      ),
    ).toBeNull();
  });

  describe("the rating", () => {
    it.each([
      [1, null],
      [2, null],
      [3, null],
      [4, null],
      [5, null],
      [0, "23514"],
      [-1, "23514"],
      [6, "23514"],
      [100, "23514"],
      [32767, "23514"],
      [32768, "22003"],
    ])("rating %s -> %s", async (rating, code) => {
      expect(await insert({ rating })).toBe(code);
    });

    it("refuses an update out of range", async () => {
      await report("up-rating", "v2");

      expect(await codeOf(`UPDATE "SiteReport" SET "rating" = 0 WHERE "id" = 'up-rating'`)).toBe("23514");
      expect(await codeOf(`UPDATE "SiteReport" SET "rating" = 6 WHERE "id" = 'up-rating'`)).toBe("23514");
      expect(await codeOf(`UPDATE "SiteReport" SET "rating" = 5 WHERE "id" = 'up-rating'`)).toBeNull();
    });

    it("refuses a missing rating: it is required, with no default (23502)", async () => {
      expect(
        await codeOf(`INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","findings","updatedAt")
          VALUES ('n-r','v2','t','2026-06-02','n','SAFETY','f',now())`),
      ).toBe("23502");
    });
  });

  describe("the rules on the texts (CHECK constraints, 23514)", () => {
    it.each([
      ["x", null],
      ["t".repeat(150), null],
      ["", "23514"],
      ["t".repeat(151), "23514"],
    ])("title of %#", async (title, code) => {
      expect(await insert({ title })).toBe(code);
    });

    it.each([
      ["n", null],
      ["n".repeat(100), null],
      ["", "23514"],
      ["n".repeat(101), "23514"],
    ])("inspector of %#", async (inspector, code) => {
      expect(await insert({ inspector })).toBe(code);
    });

    it.each([
      ["f", null],
      ["f".repeat(5000), null],
      ["", "23514"],
      ["f".repeat(5001), "23514"],
    ])("findings of %#", async (findings, code) => {
      expect(await insert({ findings })).toBe(code);
    });

    it.each([
      [null, null],
      ["r", null],
      ["r".repeat(5000), null],
      ["", "23514"],
      ["r".repeat(5001), "23514"],
    ])("recommendations of %#", async (recommendations, code) => {
      expect(await insert({ recommendations })).toBe(code);
    });

    it("counts characters, not bytes: 150 Arabic letters of title and 5,000 of findings fit", async () => {
      expect(await insert({ title: "ش".repeat(150), findings: "ش".repeat(5000) })).toBeNull();
      expect(await insert({ title: "ش".repeat(151) })).toBe("23514");
      expect(await insert({ findings: "ش".repeat(5001) })).toBe("23514");
    });

    it("refuses a type that is not one of the four (22P02) and takes each of them", async () => {
      expect(await insert({ type: "AUDIT" })).toBe("22P02");
      for (const type of ["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"]) {
        expect(await insert({ type }, `t-${type}`)).toBeNull();
      }
    });

    it("refuses a missing inspector: it is required, with no default (23502)", async () => {
      expect(
        await codeOf(`INSERT INTO "SiteReport" ("id","villaId","title","visitDate","type","rating","findings","updatedAt")
          VALUES ('n-i','v2','t','2026-06-02','SAFETY',3,'f',now())`),
      ).toBe("23502");
    });
  });

  describe("the foreign keys", () => {
    it("refuses a site report for a villa that does not exist (23503)", async () => {
      expect(
        await codeOf(`INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","updatedAt")
        VALUES ('f-1','nope','t','2026-07-01','n','SAFETY',3,'f',now())`),
      ).toBe("23503");
    });

    it("keeps a villa that has a site report: deleting it is refused (RESTRICT, 23503)", async () => {
      await report("keep-1", "v1");

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v1'`));
    });

    it("lets a villa with no site report go, and a contractor named on a villa is not touched by site reports", async () => {
      await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
        VALUES ('v9','V-9','B1','9','ce1','u1','a1',now())`);

      expect(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v9'`)).toBeNull();
      await report("c-1", "v2");
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c1'`));
    });

    it("keeps the site report when its author is deleted: createdById becomes NULL (SET NULL)", async () => {
      await report("author-1", "v2", { createdById: "u2" });

      await q(`DELETE FROM "User" WHERE "id" = 'u2'`);

      expect(
        await one(`SELECT "createdById", "inspector" FROM "SiteReport" WHERE "id" = 'author-1'`),
      ).toEqual({ createdById: null, inspector: "Eng. Hamdy" });
    });
  });
});
