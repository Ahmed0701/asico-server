import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionOf,
  findSlice19Problems,
  isSlice19Applied,
  type Query,
  type Slice19Problem,
} from "../../scripts/check-slice19.js";
import { databaseUrl, RESTRICT_CODES } from "./connection.js";

// Runs the slice 19 migration against a real PostgreSQL, in a scratch schema, inside ONE transaction that is always rolled back:
// nothing is ever committed and no database is created or reset. Off unless ASICO_DB_TESTS=1, so `npm test` needs no database.
//   ASICO_DB_TESTS=1 npx vitest run tests/db/slice19.migration.db.test.ts
//
// What it checks: the backfill (open works filed under their phase, daily reports under their contractor and engineer, the
// notes kept); every case in which the migration must STOP rather than guess, with the message listing every problem and
// nothing changed; and that `npm run check:slice19` (scripts/check-slice19.ts) finds exactly the rows the migration stops on.
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const slice19 = names.find((name) => name.endsWith("_slice19_schema"))!;
// Only the migrations before it: the database as it is when the migration is run.
const before = names.filter((name) => name < slice19);

describe("the slice 19 migration file", () => {
  it("comes before the later migrations (villa type, open work notifications, MEW follow up, progress ratio, no automatic open works, MEW states and inspection, MEW inspection passed, MEW inspection date, no ready for inspection, maintenance villas, material deliveries, material items, delivery note files, required default, no fixed materials, users delete permission), and the script that checks it exists", () => {
    expect(names.slice(-17)).toEqual([
      slice19,
      "20261112090000_villa_type",
      "20261113090000_open_work_notifications",
      "20261114090000_mew_follow_up",
      "20261115090000_elec_phase_progress_ratio",
      "20261116090000_remove_automatic_open_works",
      "20261117090000_mew_states_and_inspection",
      "20261118090000_mew_inspection_passed",
      "20261119090000_mew_inspection_date",
      "20261120090000_remove_ready_for_inspection",
      "20261121090000_maintenance_villas",
      "20261122090000_material_deliveries",
      "20261123090000_material_items",
      "20261124090000_delivery_note_files",
      "20261125090000_material_required_default",
      "20261126090000_remove_fixed_materials",
      "20261127090000_users_delete_permission",
    ]);
    expect(connectionOf("postgresql://u:p@localhost:5432/asico?schema=public")).toEqual({
      connectionString: "postgresql://u:p@localhost:5432/asico",
      schema: "public",
    });
    expect(connectionOf("postgresql://u:p@localhost:5432/asico").schema).toBe("public");
  });
});

describe.skipIf(!RUN)("the slice 19 migration, on a real database (rolled back)", () => {
  const client = new pg.Client({ connectionString: RUN ? databaseUrl() : "" });
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const query: Query = (text, values) => client.query(text, values);
  const one = async <T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T> =>
    (await q(text, values)).rows[0] as T;

  // Work done between a SAVEPOINT and its ROLLBACK leaves no trace: every test starts from the same data.
  async function isolated<T>(work: () => Promise<T>): Promise<T> {
    await q("SAVEPOINT test");
    try {
      return await work();
    } finally {
      await q("ROLLBACK TO SAVEPOINT test");
      await q("RELEASE SAVEPOINT test");
    }
  }

  // The message the migration fails with (null when it runs), and whether anything was changed by it.
  async function migrationError(): Promise<string | null> {
    await q("SAVEPOINT attempt");
    try {
      await q(sqlOf(slice19));
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      await q("ROLLBACK TO SAVEPOINT attempt");
      await q("RELEASE SAVEPOINT attempt");
    }
  }

  const columnsOf = async (table: string): Promise<string[]> =>
    (
      await q(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'scratch19' AND table_name = $1 ORDER BY column_name`,
        [table],
      )
    ).rows.map((row: { column_name: string }) => row.column_name);
  const indexesOf = async (table: string): Promise<string[]> =>
    (
      await q(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'scratch19' AND tablename = $1 ORDER BY indexname`,
        [table],
      )
    ).rows.map((row: { indexname: string }) => row.indexname);
  const codeOf = async (text: string, values?: unknown[]): Promise<string | null> => {
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
  };
  const kinds = (problems: Slice19Problem[]): string[] => problems.map((problem) => problem.kind).sort();

  // ---- fixtures -------------------------------------------------------------------------------------------------------

  const work = (
    id: string,
    villa: string,
    phase: string,
    extra: { title?: string; elecPhaseId?: string | null; source?: string } = {},
  ) =>
    q(
      `INSERT INTO "WorkItem" ("id","villaId","title","phase","elecPhaseId","status","priority","progress","source","updatedAt")
       VALUES ($1,$2,$3,$4::"WorkPhase",$5,'IN_PROGRESS','MEDIUM',10,$6::"WorkItemSource",now())`,
      [
        id,
        villa,
        extra.title ?? `Title of ${id}`,
        phase,
        extra.elecPhaseId ?? null,
        extra.source ?? "MANUAL",
      ],
    );
  const report = (
    id: string,
    villa: string,
    date: string,
    preparedBy: string,
    extra: { contractorId?: string | null; issues?: string | null; workDone?: string } = {},
  ) =>
    q(
      `INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","issues","preparedBy","contractorId","updatedAt")
       VALUES ($1,$2,$3::date,'SUNNY',12,$4,$5,$6,$7,now())`,
      [
        id,
        villa,
        date,
        extra.workDone ?? `Work of ${id}`,
        extra.issues ?? null,
        preparedBy,
        extra.contractorId ?? null,
      ],
    );

  beforeAll(async () => {
    await client.connect();
    await q("BEGIN");
    await q("CREATE SCHEMA scratch19");
    await q("SET LOCAL search_path = scratch19, public");
    for (const name of before) await q(sqlOf(name));
    // The phases the earlier migrations may have made would take part in the name matching: start from phases of our own.
    await q(`DELETE FROM "ElecPhase"`);
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES ('u1','Admin','a@x.test','x',now())`,
    );
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
      ('v3','V-3','B1','3','ce1','u1','a1','c2',now()),
      ('v4','V-4','B1','4','ce1','u1','a1','c1',now())`);
    await q(`INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES
      ('e1','Hany Wagdy','0101',now()), ('e2','Mona Ali','0102',now()),
      ('e3','Twin Name','0103',now()), ('e4','twin name','0104',now())`);
  }, 120_000);

  afterAll(async () => {
    await q("ROLLBACK").catch(() => undefined);
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'scratch19'`,
    ).catch(() => ({ n: 0 }));
    await client.end().catch(() => undefined);
    expect(left.n, "no scratch schema is left behind").toBe(0);
  });

  // ---- an empty database ----------------------------------------------------------------------------------------------

  it("applies to a database with no rows in the three tables, and the check says nothing", async () => {
    await isolated(async () => {
      expect(await findSlice19Problems(query)).toEqual([]);
      expect(await migrationError()).toBeNull();
      await q(sqlOf(slice19));
      expect(await isSlice19Applied(query)).toBe(true);
    });
  });

  // ---- the cases the migration must stop on ---------------------------------------------------------------------------

  describe("stops, changes nothing and names the rows, instead of guessing", () => {
    const cases: [string, () => Promise<unknown>, Slice19Problem["kind"], RegExp][] = [
      [
        "a manual open work whose old work phase matches no electrical phase",
        async () => {
          await q(
            `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
          );
          await work("w1", "v1", "MEP", { title: "tutle" });
        },
        "OPEN_WORK_PHASE",
        /WorkItem: 1 open work\(s\).*"MEP" x1/s,
      ],
      [
        "a manual open work whose old work phase matches two electrical phases",
        async () => {
          await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES
            ('pa','Finishing',901,now()), ('pb',' FINISHING ',902,now())`);
          await work("w1", "v1", "FINISHING");
        },
        "OPEN_WORK_PHASE",
        /WorkItem: 1 open work\(s\).*"FINISHING" x1/s,
      ],
      [
        "a daily report with no contractor, on a villa with none",
        async () => {
          await q(
            `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
          );
          await report("r1", "v2", "2026-03-01", "Hany Wagdy");
        },
        "REPORT_NO_CONTRACTOR",
        /DailyReport: 1 report\(s\) have no contractor.*V-2 2026-03-01/s,
      ],
      [
        "two reports of one contractor on one day (through their villas)",
        async () => {
          await report("r1", "v1", "2026-03-01", "Hany Wagdy");
          await report("r2", "v4", "2026-03-01", "Mona Ali");
        },
        "REPORT_COLLISION",
        /DailyReport: 1 \(contractor, date\) pair\(s\).*Nile on 2026-03-01 \(V-1, V-4\)/s,
      ],
      [
        "two reports of one contractor on one day (one with its own contractor, one through its villa)",
        async () => {
          await report("r1", "v3", "2026-03-01", "Hany Wagdy", { contractorId: "c1" });
          await report("r2", "v1", "2026-03-01", "Mona Ali");
        },
        "REPORT_COLLISION",
        /DailyReport: 1 \(contractor, date\) pair\(s\).*Nile on 2026-03-01 \(V-1, V-3\)/s,
      ],
      [
        "a report prepared by a name that is no electrical engineer's",
        async () => report("r1", "v1", "2026-03-01", "Administrator1"),
        "REPORT_ENGINEER",
        /DailyReport: 1 report\(s\) were prepared by a name.*"Administrator1" x1/s,
      ],
      [
        "a report prepared by a name two electrical engineers have (case ignored)",
        async () => report("r1", "v1", "2026-03-01", "TWIN NAME"),
        "REPORT_ENGINEER",
        /DailyReport: 1 report\(s\) were prepared by a name.*"TWIN NAME" x1/s,
      ],
    ];

    it.each(cases)("%s", async (_name, arrange, kind, message) => {
      await isolated(async () => {
        await arrange();
        const workItemsBefore = await columnsOf("WorkItem");
        const reportsBefore = await columnsOf("DailyReport");
        const rows = (
          await one<{ n: number }>(
            `SELECT (SELECT count(*) FROM "WorkItem") + (SELECT count(*) FROM "DailyReport") AS n`,
          )
        ).n;

        const failure = await migrationError();

        expect(failure, "the migration stops").toMatch(/Slice 19 stopped, nothing was changed/);
        expect(failure).toMatch(message);
        expect(failure).toContain("npm run check:slice19");
        // The check names the same row, and only it.
        expect(kinds(await findSlice19Problems(query))).toEqual([kind]);
        // Nothing was changed: the columns, the rows.
        expect(await columnsOf("WorkItem")).toEqual(workItemsBefore);
        expect(await columnsOf("DailyReport")).toEqual(reportsBefore);
        expect(
          (
            await one<{ n: number }>(
              `SELECT (SELECT count(*) FROM "WorkItem") + (SELECT count(*) FROM "DailyReport") AS n`,
            )
          ).n,
        ).toBe(rows);
        expect(await isSlice19Applied(query)).toBe(false);
      });
    });

    it("lists EVERY problem in one message, so that all of them can be fixed before the next try, and the check lists the same ones", async () => {
      await isolated(async () => {
        await q(
          `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
        );
        await work("w1", "v1", "MEP", { title: "tutle" });
        await work("w2", "v1", "EXTERNAL");
        await report("r1", "v2", "2026-03-01", "Administrator1");
        await report("r2", "v1", "2026-03-02", "Hany Wagdy");
        await report("r3", "v4", "2026-03-02", "Hany Wagdy");

        const failure = await migrationError();
        const problems = await findSlice19Problems(query);

        expect(failure).toMatch(/WorkItem: 2 open work\(s\).*"EXTERNAL" x1, "MEP" x1/s);
        expect(failure).toMatch(/DailyReport: 1 report\(s\) have no contractor.*V-2 2026-03-01/s);
        expect(failure).toMatch(/DailyReport: 1 \(contractor, date\) pair\(s\).*Nile on 2026-03-02/s);
        expect(failure).toMatch(/DailyReport: 1 report\(s\) were prepared by a name.*"Administrator1" x1/s);
        expect(kinds(problems)).toEqual([
          "OPEN_WORK_PHASE",
          "OPEN_WORK_PHASE",
          "REPORT_COLLISION",
          "REPORT_ENGINEER",
          "REPORT_NO_CONTRACTOR",
        ]);
        // Each description names the row the way a person finds it.
        const text = problems.map((problem) => problem.description).join("\n");
        expect(text).toContain('Open work "tutle"');
        expect(text).toContain("villa V-1, work phase MEP");
        expect(text).toContain('prepared by "Administrator1"');
        expect(text).toContain("villa V-2");
      });
    });

    it("stops on the same data once the cause is fixed only in part, and runs once all of it is fixed", async () => {
      await isolated(async () => {
        await q(
          `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
        );
        await work("w1", "v1", "MEP", { title: "tutle" });
        await report("r1", "v1", "2026-03-01", "Administrator1");
        expect(kinds(await findSlice19Problems(query))).toEqual(["OPEN_WORK_PHASE", "REPORT_ENGINEER"]);

        await q(`UPDATE "WorkItem" SET "elecPhaseId" = 'pa' WHERE "id" = 'w1'`);
        expect(kinds(await findSlice19Problems(query))).toEqual(["REPORT_ENGINEER"]);
        expect(await migrationError()).toMatch(/Slice 19 stopped/);

        await q(`UPDATE "DailyReport" SET "preparedBy" = 'hany wagdy ' WHERE "id" = 'r1'`);
        expect(await findSlice19Problems(query)).toEqual([]);
        expect(await migrationError()).toBeNull();
      });
    });

    it("does not count a PHASE item, or a manual item that already has its phase, as a problem", async () => {
      await isolated(async () => {
        await q(
          `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
        );
        await work("w1", "v1", "MEP", { source: "PHASE", elecPhaseId: "pa" });
        await work("w2", "v1", "FOUNDATION", { elecPhaseId: "pa" });

        expect(await findSlice19Problems(query)).toEqual([]);
        expect(await migrationError()).toBeNull();
      });
    });
  });

  // ---- the check is read only -----------------------------------------------------------------------------------------

  it("writes nothing: it runs in a read only transaction, and the database refuses a write in it", async () => {
    await isolated(async () => {
      await q(
        `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('pa','Wall piping X',901,now())`,
      );
      await work("w1", "v1", "MEP", { title: "tutle" });
      await q("SET LOCAL transaction_read_only = on");

      const problems = await findSlice19Problems(query);
      expect(problems).toHaveLength(1);
      expect(await isSlice19Applied(query)).toBe(false);
      // PostgreSQL itself refuses a write in this mode (SQLSTATE 25006), so a read only check cannot have written.
      expect(await codeOf(`UPDATE "WorkItem" SET "progress" = 99`)).toBe("25006");
    });
  });

  // ---- the backfill ---------------------------------------------------------------------------------------------------

  describe("the backfill, on data every row of which can be placed", () => {
    beforeAll(async () => {
      await q("SAVEPOINT backfill");
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES
        ('pa','Wall piping X',901,now()), ('pm','MEP',902,now()), ('pf','Finishing',903,now())`);
      // Open works: matched by the old work phase (case and spaces ignored), already filed, and an automatic one.
      await work("w-match", "v1", "MEP", { title: "tutle" });
      await work("w-case", "v1", "FINISHING", { title: "Paint" });
      await work("w-keep", "v3", "MEP", { title: "Already filed", elecPhaseId: "pa" });
      await work("w-auto", "v1", "MEP", { title: "Wall piping X", source: "PHASE", elecPhaseId: "pa" });
      // Small works lose their quantity and unit.
      await q(`INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","qty","unit","status","updatedAt")
        VALUES ('s1','v1','c1','2026-03-01','2026-03-02','Replaced a socket',2.5,'pcs','PENDING',now()),
               ('s2','v3','c2','2026-03-05','2026-03-05','Painted',1000,'m2','DONE',now())`);
      // Daily reports: the report's own contractor wins over the villa's; a villa's contractor fills the gap; notes are the old
      // issues; the engineer is found by name, ignoring case and spaces.
      await report("r1", "v1", "2026-03-01", "Hany Wagdy", { issues: "Late delivery", workDone: "Slab" });
      await report("r2", "v3", "2026-03-05", " mona ali ", { contractorId: "c1", issues: null });
      await report("r3", "v3", "2026-03-02", "MONA ALI");
      await report("r4", "v1", "2026-03-03", "Hany Wagdy", { issues: "x".repeat(5000) });
      expect(await findSlice19Problems(query)).toEqual([]);
      await q(sqlOf(slice19));
    }, 60_000);

    afterAll(async () => {
      await q("ROLLBACK TO SAVEPOINT backfill").catch(() => undefined);
    });

    it("files a manual open work under the phase its old work phase names, ignoring case and spaces", async () => {
      const rows = (
        await q(`SELECT "id","elecPhaseId","source"::text AS source FROM "WorkItem" ORDER BY "id"`)
      ).rows;

      expect(rows).toEqual([
        { id: "w-auto", elecPhaseId: "pa", source: "PHASE" },
        { id: "w-case", elecPhaseId: "pf", source: "MANUAL" },
        { id: "w-keep", elecPhaseId: "pa", source: "MANUAL" },
        { id: "w-match", elecPhaseId: "pm", source: "MANUAL" },
      ]);
    });

    it("drops the title, the work phase and its enum from the open works, and makes the phase required", async () => {
      const columns = await columnsOf("WorkItem");

      expect(columns).not.toContain("title");
      expect(columns).not.toContain("phase");
      expect(columns).toContain("elecPhaseId");
      expect(
        await codeOf(
          `INSERT INTO "WorkItem" ("id","villaId","source","updatedAt") VALUES ('x','v1','MANUAL',now())`,
        ),
      ).toBe("23502");
      expect(
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'WorkPhase' AND n.nspname = 'scratch19'`,
        ),
      ).toEqual({ n: 0 });
      expect(await indexesOf("WorkItem")).not.toContain("WorkItem_title_trgm_idx");
    });

    it("keeps every open work, and the unique automatic item per villa and phase", async () => {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkItem"`)).n).toBe(4);
      expect(
        await codeOf(
          `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","source","updatedAt") VALUES ('dup','v1','pa','PHASE',now())`,
        ),
      ).toBe("23505");
      // A manual item is not unique per phase.
      expect(
        await codeOf(
          `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","source","updatedAt") VALUES ('m2','v1','pm','MANUAL',now())`,
        ),
      ).toBeNull();
    });

    it("keeps the phase of an open work against deleting the phase (RESTRICT)", async () => {
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "ElecPhase" WHERE "id" = 'pm'`));
    });

    it("drops the quantity and the unit of the small works and keeps the rest of the rows", async () => {
      const columns = await columnsOf("DailySmallWork");
      const rows = (
        await q(
          `SELECT "id","description","status"::text AS status,"startDate"::text AS "startDate","endDate"::text AS "endDate","contractorId" FROM "DailySmallWork" ORDER BY "id"`,
        )
      ).rows;

      expect(columns).not.toContain("qty");
      expect(columns).not.toContain("unit");
      expect(rows).toEqual([
        {
          id: "s1",
          description: "Replaced a socket",
          status: "PENDING",
          startDate: "2026-03-01",
          endDate: "2026-03-02",
          contractorId: "c1",
        },
        {
          id: "s2",
          description: "Painted",
          status: "DONE",
          startDate: "2026-03-05",
          endDate: "2026-03-05",
          contractorId: "c2",
        },
      ]);
      // The checks that stayed still hold.
      expect(
        await codeOf(
          `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","updatedAt") VALUES ('bad','v1','c1','2026-03-05','2026-03-04','x',now())`,
        ),
      ).toBe("23514");
    });

    it("moves every daily report to a contractor and an engineer: the report's own contractor first, else its villa's", async () => {
      const rows = (
        await q(
          `SELECT r."id", r."contractorId", r."preparedByEngineerId", r."reportDate"::text AS "reportDate", r."notes"
           FROM "DailyReport" r ORDER BY r."id"`,
        )
      ).rows;

      expect(rows.map((row) => [row.id, row.contractorId, row.preparedByEngineerId, row.reportDate])).toEqual(
        [
          ["r1", "c1", "e1", "2026-03-01"],
          ["r2", "c1", "e2", "2026-03-05"],
          ["r3", "c2", "e2", "2026-03-02"],
          ["r4", "c1", "e1", "2026-03-03"],
        ],
      );
    });

    it("renames the issues to notes, keeps them to the letter, and drops the villa, the work done and the prepared-by text", async () => {
      const columns = await columnsOf("DailyReport");
      const notes = (await q(`SELECT "id","notes" FROM "DailyReport" ORDER BY "id"`)).rows;

      expect(columns).toEqual(
        expect.arrayContaining([
          "notes",
          "contractorId",
          "preparedByEngineerId",
          "reportDate",
          "weather",
          "workersCount",
          "version",
        ]),
      );
      for (const gone of ["villaId", "workDone", "issues", "preparedBy"]) expect(columns).not.toContain(gone);
      expect(notes.map((row) => row.notes)).toEqual(["Late delivery", null, null, "x".repeat(5000)]);
    });

    it("keeps every daily report", async () => {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "DailyReport"`)).n).toBe(4);
    });

    it("has the new unique key on (contractor, date) and refuses a second report in the same day", async () => {
      expect(await indexesOf("DailyReport")).toContain("DailyReport_contractorId_reportDate_key");
      expect(
        await codeOf(
          `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","contractorId","preparedByEngineerId","updatedAt") VALUES ('dup','2026-03-01','SUNNY',1,'c1','e1',now())`,
        ),
      ).toBe("23505");
      // The same day for another contractor is fine.
      expect(
        await codeOf(
          `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","contractorId","preparedByEngineerId","updatedAt") VALUES ('ok','2026-03-01','SUNNY',1,'c2','e1',now())`,
        ),
      ).toBeNull();
    });

    it("requires the contractor and the engineer, and keeps them against deleting (RESTRICT)", async () => {
      expect(
        await codeOf(
          `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","preparedByEngineerId","updatedAt") VALUES ('x','2026-04-01','SUNNY',1,'e1',now())`,
        ),
      ).toBe("23502");
      expect(
        await codeOf(
          `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","contractorId","updatedAt") VALUES ('x','2026-04-01','SUNNY',1,'c1',now())`,
        ),
      ).toBe("23502");
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "ElectricalEngineer" WHERE "id" = 'e1'`));
      expect(RESTRICT_CODES).toContain(await codeOf(`DELETE FROM "Contractor" WHERE "id" = 'c1'`));
    });

    it("keeps the checks: workers 0..100000, notes 1..5000 characters when set", async () => {
      const insert = (workers: number, notes: string | null) =>
        codeOf(
          `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","notes","contractorId","preparedByEngineerId","updatedAt") VALUES ('c','2027-01-01','SUNNY',$1,$2,'c2','e2',now())`,
          [workers, notes],
        );

      expect(await insert(100_001, null)).toBe("23514");
      expect(await insert(-1, null)).toBe("23514");
      expect(await insert(0, "")).toBe("23514");
      expect(await insert(5, "x".repeat(5001))).toBe("23514");
      expect(await insert(100_000, "x".repeat(5000))).toBeNull();
    });

    it("has the indexes the searches use: the trigram index on the notes under its new name, none on the dropped columns", async () => {
      const indexes = await indexesOf("DailyReport");

      expect(indexes).toContain("DailyReport_notes_trgm_idx");
      expect(indexes).toContain("DailyReport_contractorId_reportDate_key");
      for (const gone of [
        "DailyReport_issues_trgm_idx",
        "DailyReport_workDone_trgm_idx",
        "DailyReport_preparedBy_trgm_idx",
        "DailyReport_villaId_reportDate_key",
      ]) {
        expect(indexes).not.toContain(gone);
      }
      const definition = (
        await one<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE schemaname = 'scratch19' AND indexname = 'DailyReport_notes_trgm_idx'`,
        )
      ).indexdef;
      expect(definition).toContain("USING gin (notes gin_trgm_ops)");
    });

    it("leaves the audit log as it was: the migration writes no audit entry and cannot touch the append-only table", async () => {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog"`)).n).toBe(0);
    });

    it("is recognised as applied by the check, which then has nothing to say", async () => {
      expect(await isSlice19Applied(query)).toBe(true);
    });
  });
});
