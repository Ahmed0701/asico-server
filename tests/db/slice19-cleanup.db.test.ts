import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_WORK_ID, REPORT_ID, main } from "../../scripts/slice19-cleanup.js";
import { findSlice19Problems } from "../../scripts/check-slice19.js";
import { databaseUrl } from "./connection.js";

// `npm run cleanup:slice19` (scripts/slice19-cleanup.ts), against a scratch schema built from the OLD migrations only (everything
// before the slice 19 one), because that is the database it is meant for. The schema is committed (the script opens its own
// connection and commits) and dropped at the end; no database is created or reset and asico is never touched. Off unless
// ASICO_DB_TESTS=1.
const RUN = process.env.ASICO_DB_TESTS === "1";

const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const names = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string): string => readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");
const slice19 = names.find((name) => name.endsWith("_slice19_schema"))!;
const before = names.filter((name) => name < slice19);

describe.skipIf(!RUN)("npm run cleanup:slice19, on the old schema", () => {
  const schema = `cleanup19_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = new pg.Client({ connectionString: RUN ? databaseUrl() : "" });
  const q = (text: string, values?: unknown[]) => admin.query(text, values);
  const count = async (table: string, where = "true"): Promise<number> =>
    Number((await q(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`)).rows[0]!["n"]);
  const urlOfSchema = (): string => {
    const url = new URL(databaseUrl());
    url.searchParams.set("schema", schema);
    return url.toString();
  };

  // What the script printed.
  let out: string[] = [];
  let err: string[] = [];
  const text = (): string => out.join("\n");
  const run = (...args: string[]): Promise<number> => main(urlOfSchema(), args);

  const openWork = (
    id: string,
    extra: { title?: string; phase?: string; source?: string; elecPhaseId?: string | null } = {},
  ) =>
    q(
      `INSERT INTO "WorkItem" ("id","villaId","title","phase","elecPhaseId","status","priority","progress","source","updatedAt")
       VALUES ($1,'v1',$2,$3::"WorkPhase",$4,'IN_PROGRESS','MEDIUM',10,$5::"WorkItemSource",now())`,
      [id, extra.title ?? "tutle", extra.phase ?? "MEP", extra.elecPhaseId ?? null, extra.source ?? "MANUAL"],
    );
  const report = (id: string, date: string, preparedBy = "Administrator1") =>
    q(
      `INSERT INTO "DailyReport" ("id","villaId","reportDate","weather","workersCount","workDone","preparedBy","contractorId","updatedAt")
       VALUES ($1,'v1',$2::date,'SUNNY',12,'Work',$3,NULL,now())`,
      [id, date, preparedBy],
    );
  // The state asico is in: exactly the two rows.
  const asicoRows = async (): Promise<void> => {
    await openWork(OPEN_WORK_ID);
    await report(REPORT_ID, "2026-10-29");
  };

  beforeAll(async () => {
    await admin.connect();
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path = ${schema}, public`);
    for (const name of before) await q(sqlOf(name));
    // The phases and engineers the earlier migrations may have made would take part in the name matching.
    await q(`DELETE FROM "ElecPhase"`);
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","updatedAt") VALUES ('u1','Admin','a@x.test','x',now())`,
    );
    await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c1','Nile','010',now())`);
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce1','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now())`);
    await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
             VALUES ('v1','V-001','B1','1','ce1','u1','a1','c1',now())`);
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES ('e1','Hany Wagdy','0101',now())`,
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Back to the empty tables (the audit log is append-only and keeps its rows; the schema is dropped at the end).
    await q(`DROP TABLE IF EXISTS "Dependent"`);
    await q(`DROP TRIGGER IF EXISTS fail_report_delete ON "DailyReport"`);
    await q(`DELETE FROM "WorkItem"`);
    await q(`DELETE FROM "DailyReport"`);
    await q(`DELETE FROM "ElecPhase"`);
    await q(`DELETE FROM "ElectricalEngineer" WHERE "id" <> 'e1'`);
  });

  it("a dry run (the default) says which database first, lists the two rows and changes nothing", async () => {
    await asicoRows();
    const auditBefore = await count("AuditLog");

    const code = await run();

    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Database: .+\(schema cleanup19_/);
    expect(text()).toContain("DRY RUN");
    expect(text()).toContain(
      `open work ${OPEN_WORK_ID}: delete "tutle" (work phase MEP, status IN_PROGRESS, manual)`,
    );
    expect(text()).toContain(
      `daily report ${REPORT_ID}: delete the report of 2026-10-29, prepared by "Administrator1"`,
    );
    expect(text()).toContain("Would delete 2 rows. Nothing was changed.");
    expect(text()).toContain("nothing would stop the slice 19 migration");
    expect(await count("WorkItem")).toBe(1);
    expect(await count("DailyReport")).toBe(1);
    expect(await count("AuditLog")).toBe(auditBefore);
  });

  it("a dry run is a read-only transaction: it cannot write even by mistake", async () => {
    await asicoRows();
    // The statement that would delete, tried inside the same kind of transaction the dry run opens.
    const probe = new pg.Client({
      connectionString: databaseUrl(),
      options: `-c search_path=${schema},public`,
    });
    await probe.connect();
    try {
      await probe.query("BEGIN READ ONLY");
      await expect(probe.query(`DELETE FROM "WorkItem"`)).rejects.toMatchObject({ code: "25006" });
    } finally {
      await probe.query("ROLLBACK");
      await probe.end();
    }
    expect(await count("WorkItem")).toBe(1);
  });

  it("--yes deletes exactly the two rows, adds one audit entry for each, and then the check is clean", async () => {
    await asicoRows();
    await q(
      `INSERT INTO "AuditLog" ("id","action","entity","entityId") VALUES ('old-audit','open_work.create','WorkItem','${OPEN_WORK_ID}')`,
    );
    const auditBefore = await count("AuditLog");

    const code = await run("--yes");

    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Database: /);
    expect(await count("WorkItem")).toBe(0);
    expect(await count("DailyReport")).toBe(0);
    expect(text()).toContain("Deleted 2 rows; one audit entry added for each.");
    expect(text()).toContain("Check after the delete: nothing would stop the slice 19 migration any more.");
    // Append-only: the old entry is still there, and the new ones were added.
    expect(await count("AuditLog", `"id" = 'old-audit'`)).toBe(1);
    expect(await count("AuditLog")).toBe(auditBefore + 2);
    const entries = (
      await q(
        `SELECT "action","entity","entityId","actorId","before","userAgent" FROM "AuditLog" WHERE "action" LIKE '%.delete' ORDER BY "action"`,
      )
    ).rows;
    expect(entries.map((e) => [e.action, e.entity, e.entityId, e.actorId])).toEqual([
      ["daily_report.delete", "DailyReport", REPORT_ID, null],
      ["open_work.delete", "WorkItem", OPEN_WORK_ID, null],
    ]);
    expect(entries[0]!.before).toMatchObject({ preparedBy: "Administrator1", workDone: "Work" });
    expect(entries[1]!.before).toMatchObject({ title: "tutle", phase: "MEP" });
    // The same logic as check:slice19, run by hand.
    expect(await findSlice19Problems((t, v) => admin.query(t, v))).toEqual([]);
  });

  it("deletes only the two ids: a lookalike row stays, and the check prints what is left", async () => {
    await asicoRows();
    await openWork("other-work"); // the same title and phase, another id
    await report("other-report", "2026-10-30"); // the same engineer text, another id

    const code = await run("--yes");

    expect(code).toBe(1);
    expect((await q(`SELECT "id" FROM "WorkItem"`)).rows).toEqual([{ id: "other-work" }]);
    expect((await q(`SELECT "id" FROM "DailyReport"`)).rows).toEqual([{ id: "other-report" }]);
    expect(text()).toContain("Check after the delete: 2 other rows:");
    expect(text()).toContain("[OPEN_WORK_PHASE]");
    expect(text()).toContain("other-work");
    expect(text()).toContain("[REPORT_ENGINEER]");
    expect(text()).toContain("other-report");
  });

  it("a dry run also says what would be left, without the two rows", async () => {
    await asicoRows();
    await report("other-report", "2026-10-30");

    const code = await run();

    expect(code).toBe(1);
    expect(text()).toContain("After that, the check would still find: 1 other row:");
    expect(text()).toContain("other-report");
    expect(await count("DailyReport")).toBe(2);
  });

  describe("refuses a row that is no longer the problem the check found, and deletes nothing of it", () => {
    it("the open work now has an electrical phase named MEP", async () => {
      await asicoRows();
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('p-mep','MEP',1,now())`);

      const code = await run("--yes");

      expect(code).toBe(1);
      expect(text()).toContain(`open work ${OPEN_WORK_ID}: REFUSED`);
      // The report is still the problem the check found: it is deleted, on its own.
      expect(await count("WorkItem")).toBe(1);
      expect(await count("DailyReport")).toBe(0);
    });

    it("the open work was given an electrical phase", async () => {
      await asicoRows();
      await q(
        `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('p-x','Wall Piping',1,now())`,
      );
      await q(`UPDATE "WorkItem" SET "elecPhaseId" = 'p-x'`);

      expect(await run("--yes")).toBe(1);
      expect(await count("WorkItem")).toBe(1);
    });

    it("the open work is automatic, or has another work phase", async () => {
      await q(
        `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('p-auto','Sleeves',1,now())`,
      );
      await openWork(OPEN_WORK_ID, { source: "PHASE", elecPhaseId: "p-auto" });
      expect(await run("--yes")).toBe(1);
      expect(await count("WorkItem")).toBe(1);

      await q(`DELETE FROM "WorkItem"`);
      await openWork(OPEN_WORK_ID, { phase: "FINISHING" });
      expect(await run("--yes")).toBe(1);
      expect(await count("WorkItem")).toBe(1);
    });

    it("the report is by someone else now, or the engineer exists", async () => {
      await report(REPORT_ID, "2026-10-29", "Hany Wagdy");
      expect(await run("--yes")).toBe(1);
      expect(await count("DailyReport")).toBe(1);

      await q(`UPDATE "DailyReport" SET "preparedBy" = 'Administrator1'`);
      await q(
        `INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES ('e-admin',' administrator1 ','0199',now())`,
      );
      expect(await run("--yes")).toBe(1);
      expect(text()).toContain(`daily report ${REPORT_ID}: REFUSED`);
      expect(await count("DailyReport")).toBe(1);
    });

    it("something still points at the open work", async () => {
      await asicoRows();
      await q(
        `CREATE TABLE "Dependent" ("id" text PRIMARY KEY, "workItemId" text NOT NULL REFERENCES "WorkItem"("id"))`,
      );
      await q(`INSERT INTO "Dependent" VALUES ('d1', '${OPEN_WORK_ID}')`);

      const code = await run("--yes");

      expect(code).toBe(1);
      expect(text()).toMatch(/REFUSED, still referenced by 1 row of "?Dependent"? \(workItemId\)/);
      expect(await count("WorkItem")).toBe(1);
      expect(await count("Dependent")).toBe(1);
    });
  });

  it("a row that is already gone is not an error", async () => {
    await report(REPORT_ID, "2026-10-29");

    const code = await run("--yes");

    expect(code).toBe(0);
    expect(text()).toContain(`open work ${OPEN_WORK_ID}: not there any more`);
    expect(await count("DailyReport")).toBe(0);
  });

  it("is one transaction: when the second delete fails, the first is undone too, with no audit entry", async () => {
    await asicoRows();
    await q(
      `CREATE OR REPLACE FUNCTION fail_report_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no deleting'; END $$`,
    );
    await q(
      `CREATE TRIGGER fail_report_delete BEFORE DELETE ON "DailyReport" FOR EACH ROW EXECUTE FUNCTION fail_report_delete()`,
    );
    const auditBefore = await count("AuditLog");

    await expect(run("--yes")).rejects.toThrow("no deleting");

    expect(await count("WorkItem")).toBe(1);
    expect(await count("DailyReport")).toBe(1);
    expect(await count("AuditLog")).toBe(auditBefore);
  });

  it("refuses to run once the slice 19 migration is applied", async () => {
    await asicoRows();
    await q(`DELETE FROM "WorkItem"`);
    await q(`DELETE FROM "DailyReport"`);
    // The migration, in a schema of its own so the other tests keep the old one.
    const late = `${schema}_late`;
    await q(`CREATE SCHEMA ${late}`);
    try {
      await q(`SET search_path = ${late}, public`);
      for (const name of [...before, slice19]) await q(sqlOf(name));
      const url = new URL(databaseUrl());
      url.searchParams.set("schema", late);

      const code = await main(url.toString(), ["--yes"]);

      expect(code).toBe(1);
      expect(text()).toContain("REFUSED: the slice 19 migration is already applied");
    } finally {
      await q(`SET search_path = ${schema}, public`);
      await q(`DROP SCHEMA ${late} CASCADE`);
    }
  });

  it("refuses an argument it does not know, and an empty DATABASE_URL", async () => {
    expect(await run("--force")).toBe(2);
    expect(err.join("\n")).toContain("Unknown argument: --force");
    expect(await main("", [])).toBe(2);
  });
});
