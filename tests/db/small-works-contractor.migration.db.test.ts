import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the two slice 18 migrations (a contractor and a range of days on the small works; notifications) against a real
// PostgreSQL, in a scratch schema, inside ONE transaction that is always rolled back: nothing is ever committed and no database
// is created or reset. Off unless ASICO_DB_TESTS=1. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const reshape = names.find((name) => name.endsWith("_small_works_contractor_dates"))!;
const notifications = names.find((name) => name.endsWith("_notifications"))!;
const before = names.filter((name) => name < reshape);

describe.skipIf(!RUN)(
  "the small works contractor and dates migration, on a real database (rolled back)",
  () => {
    const client = new pg.Client({ connectionString: RUN ? databaseUrl() : "" });
    const q = (text: string, values?: unknown[]) => client.query(text, values);
    const one = async <T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T> =>
      (await q(text, values)).rows[0] as T;

    // What the statement fails with (null when it succeeds), without losing the transaction.
    async function failureOf(
      text: string,
      values?: unknown[],
    ): Promise<{ code?: string; message: string } | null> {
      await q("SAVEPOINT probe");
      try {
        await q(text, values);
        return null;
      } catch (err) {
        return err as { code?: string; message: string };
      } finally {
        await q("ROLLBACK TO SAVEPOINT probe");
        await q("RELEASE SAVEPOINT probe");
      }
    }

    async function freshSchema(schema: string): Promise<void> {
      await q(`CREATE SCHEMA ${schema}`);
      await q(`SET LOCAL search_path = ${schema}, public`);
      for (const name of before) await q(sqlOf(name));
      await q(
        `INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES ('u1','Admin','a@x.test','x',now())`,
      );
      await q(
        `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce1','Mona','012',now())`,
      );
      await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now())`);
      await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
             VALUES ('v1','V-1','B1','1','ce1','u1','a1',now())`);
    }

    const contractor = (id: string, name: string) =>
      q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ($1,$2,'010',now())`, [id, name]);
    const oldWork = (id: string, workDate: string, doneBy: string) =>
      q(
        `INSERT INTO "DailySmallWork" ("id","villaId","workDate","description","qty","unit","doneBy","updatedAt")
       VALUES ($1,'v1',$2,'Fixed a socket',2,'pcs',$3,now())`,
        [id, workDate, doneBy],
      );

    beforeAll(async () => {
      await client.connect();
      await q("BEGIN");
    }, 60_000);

    afterAll(async () => {
      await q("ROLLBACK").catch(() => undefined);
      const left = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.schemata WHERE left(schema_name, 10) = 'scratch18_'`,
      ).catch(() => ({ n: 0 }));
      await client.end().catch(() => undefined);
      expect(left.n, "no scratch schema is left behind").toBe(0);
    });

    it("sorts after the small works migration and before the notifications one", () => {
      expect(names.indexOf(reshape)).toBeGreaterThan(
        names.findIndex((name) => name.endsWith("_daily_small_works")),
      );
      expect(names.indexOf(notifications)).toBeGreaterThan(names.indexOf(reshape));
    });

    it("applies to an empty table, with the new columns and rules and without the old columns", async () => {
      await q("SAVEPOINT empty");
      await freshSchema("scratch18_empty");
      await q(sqlOf(reshape));
      const columns = (
        await q(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'scratch18_empty' AND table_name = 'DailySmallWork' ORDER BY ordinal_position`,
        )
      ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);

      expect(columns).toEqual([
        "id:text:NO",
        "villaId:text:NO",
        "description:text:NO",
        "qty:numeric:NO",
        "unit:text:NO",
        "status:USER-DEFINED:NO",
        "createdById:text:YES",
        "version:integer:NO",
        "createdAt:timestamp without time zone:NO",
        "updatedAt:timestamp without time zone:NO",
        "contractorId:text:NO",
        "startDate:date:NO",
        "endDate:date:NO",
      ]);
      const indexes = (
        await q(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'scratch18_empty' AND tablename = 'DailySmallWork' ORDER BY 1`,
        )
      ).rows.map((row) => row.indexname);
      expect(indexes).toEqual([
        "DailySmallWork_contractorId_idx",
        "DailySmallWork_createdById_idx",
        "DailySmallWork_description_trgm_idx",
        "DailySmallWork_endDate_idx",
        "DailySmallWork_pkey",
        "DailySmallWork_villaId_endDate_idx",
      ]);
      await q("ROLLBACK TO SAVEPOINT empty");
    });

    it("backfills the range from the old day, and the contractor from the old text (case and spaces ignored)", async () => {
      await q("SAVEPOINT data");
      await freshSchema("scratch18_data");
      await contractor("c-nile", "Nile Builders");
      await contractor("c-delta", "Delta Co");
      await oldWork("w1", "2026-03-01", "Nile Builders");
      await oldWork("w2", "2026-03-02", "  nile BUILDERS ");
      await oldWork("w3", "2026-03-03", "delta co");
      await q(sqlOf(reshape));

      const rows = (
        await q(
          `SELECT "id", "contractorId", "startDate"::text AS "startDate", "endDate"::text AS "endDate"
         FROM "DailySmallWork" ORDER BY "id"`,
        )
      ).rows;
      expect(rows).toEqual([
        { id: "w1", contractorId: "c-nile", startDate: "2026-03-01", endDate: "2026-03-01" },
        { id: "w2", contractorId: "c-nile", startDate: "2026-03-02", endDate: "2026-03-02" },
        { id: "w3", contractorId: "c-delta", startDate: "2026-03-03", endDate: "2026-03-03" },
      ]);
      await q("ROLLBACK TO SAVEPOINT data");
    });

    it("stops, and changes nothing, when a row names no contractor: the message has the count and the values", async () => {
      await q("SAVEPOINT unmatched");
      await freshSchema("scratch18_unmatched");
      await contractor("c-nile", "Nile Builders");
      await oldWork("w1", "2026-03-01", "Nile Builders");
      await oldWork("w2", "2026-03-02", "ahmed");
      await oldWork("w3", "2026-03-03", "ahmed");
      await oldWork("w4", "2026-03-04", "Sayed");

      const failure = await failureOf(sqlOf(reshape));

      expect(failure?.message).toContain("3 row(s) cannot be matched");
      expect(failure?.message).toContain('"ahmed"');
      expect(failure?.message).toContain('"Sayed"');
      expect(failure?.message).not.toContain("Nile Builders");
      // The failed migration was rolled back with its savepoint: the old text is still there, the new columns are not.
      expect(
        (
          await one<{ n: number }>(
            `SELECT count(*)::int AS n FROM "DailySmallWork" WHERE "doneBy" IS NOT NULL`,
          )
        ).n,
      ).toBe(4);
      await q("ROLLBACK TO SAVEPOINT unmatched");
    });

    it("does not guess between two contractors of the same name: that row stops the migration too", async () => {
      await q("SAVEPOINT ambiguous");
      await freshSchema("scratch18_ambiguous");
      await contractor("c1", "Nile Builders");
      await contractor("c2", "NILE builders");
      await oldWork("w1", "2026-03-01", "Nile Builders");

      const failure = await failureOf(sqlOf(reshape));

      expect(failure?.message).toContain("1 row(s) cannot be matched");
      await q("ROLLBACK TO SAVEPOINT ambiguous");
    });

    it("keeps the rules afterwards: the order of the range, the contractor's foreign key, and a contractor with small works", async () => {
      await q("SAVEPOINT rules");
      await freshSchema("scratch18_rules");
      await contractor("c1", "Nile Builders");
      await q(sqlOf(reshape));
      const insert = (id: string, contractorId: string, start: string, end: string) =>
        failureOf(
          `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","qty","unit","updatedAt")
         VALUES ('${id}','v1','${contractorId}','${start}','${end}','x',1,'pcs',now())`,
        );

      expect(await insert("ok", "c1", "2026-03-01", "2026-03-01")).toBeNull();
      expect((await insert("back", "c1", "2026-03-02", "2026-03-01"))?.code, "check violation").toBe("23514");
      expect((await insert("who", "nobody", "2026-03-01", "2026-03-01"))?.code, "foreign key violation").toBe(
        "23503",
      );
      await q(
        `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","qty","unit","updatedAt")
       VALUES ('w','v1','c1','2026-03-01','2026-03-05','x',1,'pcs',now())`,
      );
      expect(RESTRICT_CODES, "restrict").toContain(
        (await failureOf(`DELETE FROM "Contractor" WHERE "id" = 'c1'`))?.code,
      );
      await q("ROLLBACK TO SAVEPOINT rules");
    });

    it("makes the notification tables: one alert per work, kind and end date; deleted with the work; read state per user", async () => {
      await q("SAVEPOINT notifications");
      await freshSchema("scratch18_notifications");
      await contractor("c1", "Nile Builders");
      await q(sqlOf(reshape));
      await q(sqlOf(notifications));
      await q(
        `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","qty","unit","updatedAt")
       VALUES ('w','v1','c1','2026-03-01','2026-03-05','x',1,'pcs',now())`,
      );
      const alert = (id: string, kind: string, endDate: string) =>
        failureOf(
          `INSERT INTO "Notification" ("id","kind","smallWorkId","endDate","data") VALUES ('${id}','${kind}','w','${endDate}','{}')`,
        );

      expect(await alert("n1", "SMALL_WORK_DUE_SOON", "2026-03-05")).toBeNull();
      await q(
        `INSERT INTO "Notification" ("id","kind","smallWorkId","endDate","data") VALUES ('n1','SMALL_WORK_DUE_SOON','w','2026-03-05','{}')`,
      );
      expect((await alert("n2", "SMALL_WORK_DUE_SOON", "2026-03-05"))?.code, "the same situation twice").toBe(
        "23505",
      );
      expect(await alert("n3", "SMALL_WORK_OVERDUE", "2026-03-05"), "another kind").toBeNull();
      expect(await alert("n4", "SMALL_WORK_DUE_SOON", "2026-03-09"), "a moved end date").toBeNull();
      await q(`INSERT INTO "NotificationRecipient" ("notificationId","userId") VALUES ('n1','u1')`);
      expect(
        (
          await failureOf(
            `INSERT INTO "NotificationRecipient" ("notificationId","userId") VALUES ('n1','u1')`,
          )
        )?.code,
        "one copy per user",
      ).toBe("23505");

      await q(`DELETE FROM "DailySmallWork" WHERE "id" = 'w'`);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Notification"`)).n).toBe(0);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "NotificationRecipient"`)).n).toBe(0);
      await q("ROLLBACK TO SAVEPOINT notifications");
    });
  },
);
