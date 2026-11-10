import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the daily small works migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always
// rolled back: nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test`
// needs no database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const smallWorks = names.find((name) => name.endsWith("_daily_small_works"))!;
const before = names.filter((name) => name < smallWorks);

describe.skipIf(!RUN)("the daily small works migration, on a real database (rolled back)", () => {
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
      "AuditLog",
      "Permission",
    ]) {
      result[table] = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).n;
    }
    return result;
  };
  let tablesBefore: Record<string, number> = {};

  const work = (id: string, villa: string, extra: Record<string, unknown> = {}) => {
    const values = {
      qty: "2.500",
      description: "Replaced a socket",
      unit: "pcs",
      doneBy: "Hamdy",
      createdById: null,
      ...extra,
    };
    return q(
      `INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","createdById","updatedAt")
       VALUES ($1,$2,'2026-03-01',$3,$4,$5,$6,$7,now())`,
      [id, villa, values.description, values.qty, values.unit, values.doneBy, values.createdById],
    );
  };

  beforeAll(async () => {
    await client.connect();

    // An empty database first: nothing to backfill and the migration still applies.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch11_empty");
    await q(sqlOf(smallWorks));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailySmallWork"`)).n).toBe(0);
    await q("ROLLBACK");

    // Then one with data, kept open (and rolled back in afterAll) for the tests below.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch11_data");
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
    tablesBefore = await counts();
    await q(sqlOf(smallWorks));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('scratch11_empty', 'scratch11_data')`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  it("sorts after the migrations it builds on (the villas, the users and the trigram extension)", () => {
    for (const earlier of ["_init", "_extras", "_villas", "_daily_reports"]) {
      expect(names.indexOf(smallWorks)).toBeGreaterThan(names.findIndex((name) => name.endsWith(earlier)));
    }
  });

  it("changes nothing that was there: the rows of the other tables are as they were", async () => {
    expect(await counts()).toEqual(tablesBefore);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailySmallWork"`)).n).toBe(0);
  });

  it("makes the SmallWorkStatus type with its two values in order", async () => {
    const values = (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = 'SmallWorkStatus' AND n.nspname = 'scratch11_data' ORDER BY e.enumsortorder`,
      )
    ).rows.map((row) => row.enumlabel);

    expect(values).toEqual(["PENDING", "DONE"]);
  });

  it("has the columns, with a DATE for the day, a DECIMAL(12,3) quantity, and a version that starts at 1", async () => {
    const columns = (
      await q(
        `SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_schema = 'scratch11_data' AND table_name = 'DailySmallWork' ORDER BY ordinal_position`,
      )
    ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);

    expect(columns).toEqual([
      "id:text:NO",
      "villaId:text:NO",
      "workDate:date:NO",
      "description:text:NO",
      "qty:numeric:NO",
      "unit:text:NO",
      "doneBy:text:NO",
      "status:USER-DEFINED:NO",
      "createdById:text:YES",
      "version:integer:NO",
      "createdAt:timestamp without time zone:NO",
      "updatedAt:timestamp without time zone:NO",
    ]);
    const qty = await one<{ numeric_precision: number; numeric_scale: number }>(
      `SELECT numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_schema = 'scratch11_data' AND table_name = 'DailySmallWork' AND column_name = 'qty'`,
    );
    expect(qty).toEqual({ numeric_precision: 12, numeric_scale: 3 });
    await work("r-default", "v1");
    expect(await one(`SELECT "version", "status" FROM "DailySmallWork" WHERE "id" = 'r-default'`)).toEqual({
      version: 1,
      status: "PENDING",
    });
  });

  it("has no contractor column", async () => {
    const found = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'scratch11_data' AND table_name = 'DailySmallWork' AND column_name ILIKE '%contractor%'`,
    );

    expect(found.n).toBe(0);
  });

  it("has the indexes, the trigram index on the description among them, and no unique one but the key", async () => {
    const indexes = (
      await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch11_data' AND tablename = 'DailySmallWork' ORDER BY indexname`,
      )
    ).rows;

    expect(indexes.map((row) => row.indexname)).toEqual([
      "DailySmallWork_createdById_idx",
      "DailySmallWork_description_trgm_idx",
      "DailySmallWork_pkey",
      "DailySmallWork_villaId_workDate_idx",
      "DailySmallWork_workDate_idx",
    ]);
    expect(indexes.filter((row) => /UNIQUE/.test(row.indexdef)).map((row) => row.indexname)).toEqual([
      "DailySmallWork_pkey",
    ]);
    expect(indexes.find((row) => row.indexname === "DailySmallWork_description_trgm_idx")?.indexdef).toMatch(
      /USING gin .*gin_trgm_ops/,
    );
    expect(
      indexes.find((row) => row.indexname === "DailySmallWork_villaId_workDate_idx")?.indexdef,
    ).toContain('"workDate" DESC');
  });

  it("lets the same job be written twice on one day: there is no natural key", async () => {
    await work("twin-1", "v2");

    expect(
      await codeOf(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
      VALUES ('twin-2','v2','2026-03-01','Replaced a socket',2.5,'pcs','Hamdy',now())`),
    ).toBeNull();
  });

  describe("the quantity", () => {
    const insert = (qty: string | number, id = "qty") =>
      codeOf(
        `INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
       VALUES ($1,'v2','2026-06-01','x',$2,'u','n',now())`,
        [id, qty],
      );

    it.each([
      ["0.001", null],
      ["1.005", null],
      ["2.5", null],
      ["999999999.999", null],
      ["0", "23514"],
      ["-0.001", "23514"],
      ["-1", "23514"],
      ["1000000000", "22003"],
      ["1000000000.000", "22003"],
      ["9999999999999", "22003"],
    ])("qty %s -> %s", async (qty, code) => {
      expect(await insert(qty)).toBe(code);
    });

    it("keeps three decimals exactly, whatever the float", async () => {
      await work("exact-1", "v2", { qty: "1.005" });
      await work("exact-2", "v2", { qty: "999999999.999" });

      const rows = (
        await q(`SELECT "id", "qty"::text AS q FROM "DailySmallWork" WHERE "id" LIKE 'exact-%' ORDER BY "id"`)
      ).rows;
      expect(rows).toEqual([
        { id: "exact-1", q: "1.005" },
        { id: "exact-2", q: "999999999.999" },
      ]);
    });

    it("rounds a fourth decimal itself, which is why the application refuses one first: 0.0004 breaks the CHECK, 1.0005 becomes 1.001", async () => {
      expect(await insert("0.0004", "round-1")).toBe("23514");
      await work("round-2", "v2", { qty: "1.0005" });

      expect(
        (await one<{ q: string }>(`SELECT "qty"::text AS q FROM "DailySmallWork" WHERE "id" = 'round-2'`)).q,
      ).toBe("1.001");
    });

    it("refuses an update to zero", async () => {
      await work("up-qty", "v2");

      expect(await codeOf(`UPDATE "DailySmallWork" SET "qty" = 0 WHERE "id" = 'up-qty'`)).toBe("23514");
    });
  });

  describe("the rules on the texts (CHECK constraints, 23514)", () => {
    const insert = (extra: Record<string, unknown>) =>
      codeOf(
        `INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
         VALUES ('chk','v2','2026-06-01',$1,1,$2,$3,now())`,
        [extra.description ?? "x", extra.unit ?? "u", extra.doneBy ?? "n"],
      );

    it.each([
      ["x", null],
      ["d".repeat(500), null],
      ["", "23514"],
      ["d".repeat(501), "23514"],
    ])("description of %#", async (description, code) => {
      expect(await insert({ description })).toBe(code);
    });

    it.each([
      ["u", null],
      ["u".repeat(30), null],
      ["", "23514"],
      ["u".repeat(31), "23514"],
    ])("unit of %#", async (unit, code) => {
      expect(await insert({ unit })).toBe(code);
    });

    it.each([
      ["n", null],
      ["n".repeat(100), null],
      ["", "23514"],
      ["n".repeat(101), "23514"],
    ])("doneBy of %#", async (doneBy, code) => {
      expect(await insert({ doneBy })).toBe(code);
    });

    it("counts characters, not bytes: 500 Arabic letters fit", async () => {
      expect(await insert({ description: "ش".repeat(500) })).toBeNull();
      expect(await insert({ description: "ش".repeat(501) })).toBe("23514");
    });

    it("refuses a status that is not one of the two (22P02) and takes DONE", async () => {
      expect(
        await codeOf(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","status","updatedAt")
          VALUES ('s-1','v2','2026-06-02','x',1,'u','n','CANCELLED',now())`),
      ).toBe("22P02");
      expect(
        await codeOf(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","status","updatedAt")
          VALUES ('s-2','v2','2026-06-02','x',1,'u','n','DONE',now())`),
      ).toBeNull();
    });

    it("refuses a missing doneBy: it is required, with no default (23502)", async () => {
      expect(
        await codeOf(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","updatedAt")
          VALUES ('n-1','v2','2026-06-02','x',1,'u',now())`),
      ).toBe("23502");
    });
  });

  describe("the foreign keys", () => {
    it("refuses a small work for a villa that does not exist (23503)", async () => {
      expect(
        await codeOf(`INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
        VALUES ('f-1','nope','2026-07-01','x',1,'u','n',now())`),
      ).toBe("23503");
    });

    it("keeps a villa that has a small work: deleting it is refused (RESTRICT, 23503)", async () => {
      await work("keep-1", "v1");

      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v1'`));
    });

    it("lets a villa with no small work go, and a contractor named on a villa is not touched by small works", async () => {
      await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
        VALUES ('v9','V-9','B1','9','ce1','u1','a1',now())`);

      expect(await codeOf(`DELETE FROM "Villa" WHERE "id" = 'v9'`)).toBeNull();
      await work("c-1", "v2");
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c1'`));
    });

    it("keeps the small work when its author is deleted: createdById becomes NULL (SET NULL)", async () => {
      await work("author-1", "v2", { createdById: "u2" });

      await q(`DELETE FROM "User" WHERE "id" = 'u2'`);

      expect(
        await one(`SELECT "createdById", "doneBy" FROM "DailySmallWork" WHERE "id" = 'author-1'`),
      ).toEqual({ createdById: null, doneBy: "Hamdy" });
    });
  });
});
