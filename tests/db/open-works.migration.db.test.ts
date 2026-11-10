import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the migrations against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always rolled back:
// nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test` needs no
// database. Run it with:  ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const openWorks = names.find((name) => name.endsWith("_open_works"))!;
// Only the migrations before it: the later ones (slice 19 among them) are written for the data the whole history leaves.
const before = names.filter((name) => name < openWorks);

// node-pg reads a DATE as midnight in the machine's time zone: its calendar day is the local one.
const isoDay = (date: Date | null): string | null =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : null;

type ItemRow = {
  id: string;
  villaId: string;
  elecPhaseId: string | null;
  startDate: Date | null;
  createdById: string | null;
  contractorId: string | null;
};

describe.skipIf(!RUN)("the open works migration, on a real database (rolled back)", () => {
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

  let auditBefore = 0;

  async function schemaWithEveryMigrationBeforeThisOne(schema: string): Promise<void> {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET LOCAL search_path = ${schema}, public`);
    for (const name of before) await q(sqlOf(name));
  }

  beforeAll(async () => {
    await client.connect();

    // An empty database first: the backfill has nothing to do and the migration still applies.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch9_empty");
    await q(sqlOf(openWorks));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkItem"`)).n).toBe(0);
    await q("ROLLBACK");

    // Then one with data, kept open (and rolled back in afterAll) for the tests below.
    await q("BEGIN");
    await schemaWithEveryMigrationBeforeThisOne("scratch9_data");
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
      ('v2','V-2','B1','2','ce1','u1','a1',NULL,now()),
      ('v3','V-3','B1','3','ce1','u1','a1','c2',now())`);
    await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES
      ('pa','Wall piping X',901,now()), ('pb','Cabling X',902,now()), ('pc','Panels X',903,now())`);
    await q(`INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","completedAt","version","updatedAt") VALUES
      ('v1','pa',40,NULL,1,'2026-10-20 23:30:00'),
      ('v1','pb',100,'2026-10-21 08:00:00',1,'2026-10-21 08:00:00'),
      ('v1','pc',0,NULL,1,'2026-10-22 08:00:00'),
      ('v2','pa',100,'2026-10-19 10:00:00',1,'2026-10-19 10:00:00'),
      ('v2','pb',0,NULL,1,now()),
      ('v2','pc',0,NULL,1,now()),
      ('v3','pa',0,NULL,1,now()),
      ('v3','pb',0,NULL,1,now()),
      ('v3','pc',1,NULL,1,'2026-10-23 00:00:00')`);
    auditBefore = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog"`)).n;
    await q(sqlOf(openWorks));
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('scratch9_empty', 'scratch9_data')`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  const enumValues = async (name: string): Promise<string[]> =>
    (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typname = $1 AND n.nspname = 'scratch9_data' ORDER BY e.enumsortorder`,
        [name],
      )
    ).rows.map((row: { enumlabel: string }) => row.enumlabel);

  const items = async () =>
    (await q(`SELECT * FROM "WorkItem" ORDER BY "villaId","elecPhaseId"`)).rows as ItemRow[];
  const itemOf = async (villa: string, phase: string) =>
    (await items()).find((item) => item.villaId === villa && item.elecPhaseId === phase);

  it("creates the four enums", async () => {
    expect(await enumValues("WorkPhase")).toEqual([
      "FOUNDATION",
      "STRUCTURE",
      "MEP",
      "FINISHING",
      "EXTERNAL",
    ]);
    expect(await enumValues("WorkStatus")).toEqual(["NOT_STARTED", "IN_PROGRESS", "DELAYED", "DONE"]);
    expect(await enumValues("Priority")).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(await enumValues("WorkItemSource")).toEqual(["MANUAL", "PHASE"]);
  });

  describe("the backfill", () => {
    it("makes one item for each progress above 0, and none for the rows at 0", async () => {
      expect(await items()).toHaveLength(4);
      expect(await itemOf("v1", "pc")).toBeUndefined();
      expect(await itemOf("v2", "pb")).toBeUndefined();
      expect(await itemOf("v3", "pa")).toBeUndefined();
    });

    it("copies the progress, names the item after the phase, and starts it on the progress row's last UTC day", async () => {
      const item = await itemOf("v1", "pa");

      expect(item).toMatchObject({
        title: "Wall piping X",
        phase: "MEP",
        priority: "MEDIUM",
        status: "IN_PROGRESS",
        progress: 40,
        source: "PHASE",
        version: 1,
        endDate: null,
      });
      expect(isoDay(item!.startDate)).toBe("2026-10-20");
      expect(item!.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("has the system as the creator (NULL), the villa's contractor, and DONE at 100", async () => {
      expect((await itemOf("v1", "pa"))!.createdById).toBeNull();
      expect((await itemOf("v1", "pa"))!.contractorId).toBe("c1");
      expect(await itemOf("v2", "pa")).toMatchObject({ status: "DONE", progress: 100, contractorId: null });
      expect(await itemOf("v1", "pb")).toMatchObject({ status: "DONE", progress: 100 });
      expect(await itemOf("v3", "pc")).toMatchObject({
        status: "IN_PROGRESS",
        progress: 1,
        contractorId: "c2",
      });
      expect(isoDay((await itemOf("v1", "pb"))!.startDate)).toBe("2026-10-21");
    });

    it("appends one audit entry per item with no actor, and leaves the audit log append-only", async () => {
      const rows = (await q(`SELECT * FROM "AuditLog" WHERE "action" = 'open_work.auto_sync'`)).rows;

      expect(rows).toHaveLength(4);
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog"`)).n).toBe(auditBefore + 4);
      expect(rows.every((row) => row.actorId === null && row.entity === "WorkItem")).toBe(true);
      expect(rows.every((row) => row.before === null)).toBe(true);
      const created = await items();
      expect(rows.map((row) => row.entityId).sort()).toEqual(created.map((item) => item.id).sort());
      const forA = rows.find(
        (row) => row.entityId === created.find((i) => i.elecPhaseId === "pa" && i.villaId === "v1")!.id,
      );
      expect(Object.keys(forA.after).sort()).toEqual([
        "elecPhaseId",
        "progress",
        "status",
        "title",
        "villaId",
      ]);
      expect(forA.after).toMatchObject({
        villaId: "v1",
        elecPhaseId: "pa",
        title: "Wall piping X",
        status: "IN_PROGRESS",
        progress: 40,
      });
      expect(await codeOf(`UPDATE "AuditLog" SET "action" = 'x'`)).not.toBeNull();
      expect(await codeOf(`TRUNCATE "AuditLog"`)).not.toBeNull();
    });

    it("leaves the progress rows as they were", async () => {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "VillaPhaseProgress"`)).n).toBe(9);
    });
  });

  describe("the table", () => {
    it("has a nullable creator, phase, contractor and dates, and a SMALLINT progress", async () => {
      const columns = (
        await q(
          `SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'scratch9_data' AND table_name = 'WorkItem'`,
        )
      ).rows as { column_name: string; is_nullable: string; data_type: string }[];
      const column = (name: string) => columns.find((c) => c.column_name === name)!;

      for (const name of ["createdById", "elecPhaseId", "contractorId", "startDate", "endDate"]) {
        expect(column(name).is_nullable, name).toBe("YES");
      }
      for (const name of [
        "villaId",
        "title",
        "phase",
        "status",
        "priority",
        "progress",
        "source",
        "version",
      ]) {
        expect(column(name).is_nullable, name).toBe("NO");
      }
      expect(column("progress").data_type).toBe("smallint");
      expect(column("startDate").data_type).toBe("date");
    });

    it("has the indexes, the title one a trigram GIN and the automatic one unique and partial", async () => {
      const indexes = (
        await q(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scratch9_data' AND tablename = 'WorkItem'`,
        )
      ).rows as { indexname: string; indexdef: string }[];

      expect(indexes.map((i) => i.indexname).sort()).toEqual(
        [
          "WorkItem_pkey",
          "WorkItem_villaId_status_idx",
          "WorkItem_status_idx",
          "WorkItem_endDate_idx",
          "WorkItem_contractorId_idx",
          "WorkItem_elecPhaseId_idx",
          "WorkItem_createdById_idx",
          "WorkItem_title_trgm_idx",
          "WorkItem_villa_phase_auto_key",
        ].sort(),
      );
      expect(indexes.find((i) => i.indexname === "WorkItem_title_trgm_idx")!.indexdef).toMatch(
        /USING gin \(title gin_trgm_ops\)/,
      );
      const auto = indexes.find((i) => i.indexname === "WorkItem_villa_phase_auto_key")!.indexdef;
      expect(auto).toMatch(/UNIQUE/);
      expect(auto).toMatch(/WHERE \(source = 'PHASE'/);
    });

    it("answers an ILIKE on the title from the trigram index", async () => {
      await q(`SET LOCAL enable_seqscan = off`);
      const plan = (await q(`EXPLAIN SELECT 1 FROM "WorkItem" WHERE "title" ILIKE '%pip%'`)).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(plan).toMatch(/WorkItem_title_trgm_idx/);
    });
  });

  describe("the rules", () => {
    let serial = 0;
    const insert = (over: Record<string, unknown> = {}): [string, unknown[]] => {
      serial += 1;
      const row = {
        id: `t-${serial}`,
        villaId: "v3",
        title: "T",
        phase: "MEP",
        elecPhaseId: null,
        status: "NOT_STARTED",
        priority: "LOW",
        progress: 0,
        contractorId: null,
        startDate: null,
        endDate: null,
        source: "MANUAL",
        createdById: "u2",
        ...over,
      };
      return [
        `INSERT INTO "WorkItem" ("id","villaId","title","phase","elecPhaseId","status","priority","progress","contractorId","startDate","endDate","source","createdById","updatedAt")
         VALUES ($1,$2,$3,$4::"WorkPhase",$5,$6::"WorkStatus",$7::"Priority",$8,$9,$10,$11,$12::"WorkItemSource",$13,now())`,
        [
          row.id,
          row.villaId,
          row.title,
          row.phase,
          row.elecPhaseId,
          row.status,
          row.priority,
          row.progress,
          row.contractorId,
          row.startDate,
          row.endDate,
          row.source,
          row.createdById,
        ],
      ];
    };
    const code = (over?: Record<string, unknown>) => codeOf(...insert(over));

    it("accepts a plain manual item, one with no creator, and two alike", async () => {
      expect(await code()).toBeNull();
      expect(await code({ createdById: null })).toBeNull();
      expect(await code({ title: "same" })).toBeNull();
      expect(await code({ title: "same" })).toBeNull();
    });

    it("keeps the progress between 0 and 100 (23514)", async () => {
      expect(await code({ progress: 101, status: "DONE" })).toBe("23514");
      expect(await code({ progress: -1 })).toBe("23514");
    });

    it("keeps the end date from the start date (23514), and accepts equal days and a lone end", async () => {
      expect(await code({ startDate: "2026-10-10", endDate: "2026-10-09" })).toBe("23514");
      expect(await code({ startDate: "2026-10-10", endDate: "2026-10-10" })).toBeNull();
      expect(await code({ endDate: "2026-10-10" })).toBeNull();
    });

    it("gives an automatic item a phase (23514)", async () => {
      expect(await code({ source: "PHASE", elecPhaseId: null })).toBe("23514");
    });

    it("keeps DONE exactly at 100 and NOT_STARTED exactly at 0 (23514)", async () => {
      expect(await code({ status: "DONE", progress: 50 })).toBe("23514");
      expect(await code({ status: "IN_PROGRESS", progress: 100 })).toBe("23514");
      expect(await code({ status: "DELAYED", progress: 100 })).toBe("23514");
      expect(await code({ status: "NOT_STARTED", progress: 10 })).toBe("23514");
      expect(await code({ status: "IN_PROGRESS", progress: 0 })).toBeNull();
      expect(await code({ status: "DELAYED", progress: 0 })).toBeNull();
      expect(await code({ status: "DONE", progress: 100 })).toBeNull();
    });

    it("allows one automatic item per villa and phase (23505), but not a second manual-vs-automatic clash", async () => {
      expect(await code({ villaId: "v1", source: "PHASE", elecPhaseId: "pa" })).toBe("23505");
      expect(await code({ villaId: "v1", source: "MANUAL", elecPhaseId: "pa" })).toBeNull();
      expect(await code({ villaId: "v3", source: "PHASE", elecPhaseId: "pa" })).toBeNull();
    });

    it("refuses what points nowhere (23503) and values that are not in the enums (22P02)", async () => {
      expect(await code({ villaId: "nope" })).toBe("23503");
      expect(await code({ elecPhaseId: "nope" })).toBe("23503");
      expect(await code({ contractorId: "nope" })).toBe("23503");
      expect(await code({ createdById: "nope" })).toBe("23503");
      expect(await code({ priority: "URGENT" })).toBe("22P02");
      expect(await code({ phase: "CIVIL" })).toBe("22P02");
    });
  });

  describe("the foreign keys", () => {
    it("refuse to delete a phase or a contractor that an item points at (23503)", async () => {
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "ElecPhase" WHERE "id" = 'pa'`));
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c1'`));
    });

    it("null the creator when the user is deleted", async () => {
      await q(
        `INSERT INTO "WorkItem" ("id","villaId","title","phase","source","createdById","updatedAt") VALUES ('by-u2','v3','x','MEP','MANUAL','u2',now())`,
      );

      await q(`DELETE FROM "User" WHERE "id" = 'u2'`);

      expect(
        (
          await one<{ createdById: string | null }>(
            `SELECT "createdById" FROM "WorkItem" WHERE "id" = 'by-u2'`,
          )
        ).createdById,
      ).toBeNull();
    });

    it("delete a villa's items with the villa", async () => {
      expect(
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = 'v2'`)).n,
      ).toBe(1);

      await q(`DELETE FROM "Villa" WHERE "id" = 'v2'`);

      expect(
        (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = 'v2'`)).n,
      ).toBe(0);
    });
  });
});
