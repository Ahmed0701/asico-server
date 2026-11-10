import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The dashboard's counting queries on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the
// end (in a `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched.
// Off unless ASICO_DB_TESTS=1:
//   ASICO_DB_TESTS=1 npx vitest run tests/db/dashboard.db.test.ts
//
// What it checks: every card's figures against rows placed on both sides of each boundary (the day before the window, its first
// day, today, tomorrow); that the open works' overdue rule is the open works list's own; that bigint counts and sums reach the
// answer as plain numbers; and that a user's grants cut the cards on the real tables.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { DashboardService, dayRange } from "../../src/modules/dashboard/service/dashboard.service.js";
import { DashboardRepository } from "../../src/modules/dashboard/repository/dashboard.repository.js";
import { AuditRepository } from "../../src/modules/audit/repository/audit.repository.js";
import { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

const NOW = new Date("2026-10-12T15:37:42.123Z");
const TODAY = Date.UTC(2026, 9, 12);
const DAY = 86_400_000;
// A DATE, as YYYY-MM-DD, `offset` days from today.
const day = (offset: number): string => new Date(TODAY + offset * DAY).toISOString().slice(0, 10);

describe.skipIf(!RUN)("the dashboard on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = () =>
    new DashboardService(undefined, () => NOW, { timeZone: "Asia/Kuwait", hoursBefore: 8 });
  const ADMIN = { id: "admin", role: "ADMIN" } as const;

  let counter = 0;
  const id = (prefix: string): string => `${prefix}${++counter}`;

  beforeAll(async () => {
    scratch = await openScratch("scratch14a", 1);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES
       ('admin','Root Admin','a@x.test','x','ADMIN',now()),
       ('emp-open','Open Works Only','o@x.test','x','EMPLOYEE',now()),
       ('emp-top','Top Contractors','t@x.test','x','EMPLOYEE',now()),
       ('emp-none','Nothing','n@x.test','x','EMPLOYEE',now())`,
    );
    await q(
      `INSERT INTO "Permission" ("id","code") VALUES
       ('p1','open-works:read'),('p2','villas:read'),('p3','contractors:read'),('p4','daily-labour:read')`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") VALUES
       ('emp-open','p1'),('emp-open','p4'),('emp-top','p2'),('emp-top','p3')`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
       ('c1','Nile','0100','ACTIVE',now()),('c2','Delta','0101','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES ('elec1','Hany','0102',now())`,
    );
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('dph','Dash phase',900,now())`,
    );
    for (const [villa, contractor] of [
      ["v1", "c1"],
      ["v2", "c1"],
      ["v3", "c2"],
    ] as const) {
      await q(
        `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
         VALUES ($1,$1,'B1',$1,'eng','admin','area',$2,now())`,
        [villa, contractor],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  // The table's own checks: a done item is at 100 and a not started one at 0.
  const PROGRESS: Record<string, number> = { NOT_STARTED: 0, IN_PROGRESS: 50, DELAYED: 20, DONE: 100 };
  async function workItem(status: string, endDate: string | null): Promise<void> {
    await q(
      `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","progress","source","endDate","updatedAt")
       VALUES ($1,'v1','dph',$2::"WorkStatus",$3,'MANUAL',$4::date,now())`,
      [id("w"), status, PROGRESS[status], endDate],
    );
  }
  // A report belongs to a contractor, not to a villa: one per contractor and day.
  async function dailyReport(contractor: string, offset: number): Promise<void> {
    await q(
      `INSERT INTO "DailyReport" ("id","contractorId","preparedByEngineerId","reportDate","weather","workersCount","updatedAt")
       VALUES ($1,$2,'elec1',$3::date,'SUNNY',5,now())`,
      [id("r"), contractor, day(offset)],
    );
  }
  async function labour(villa: string, contractor: string, offset: number, count: number): Promise<void> {
    await q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
       VALUES ($1,$2,$3::date,$4,$5,now())`,
      [id("l"), villa, day(offset), contractor, count],
    );
  }

  it("answers zeros, an empty list and a null average on tables with nothing in them", async () => {
    const summary = await service().summary(ADMIN);

    expect(summary).toMatchObject({
      villas: { total: 3 },
      openWorks: { byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 0, DONE: 0 }, overdue: 0 },
      dailyReports: { today: 0, last7Days: 0 },
      smallWorks: { pending: 0, dueSoon: 0, overdue: 0, urgent: [] },
      siteReports: { count: 0, averageRating: null },
      labour: { today: 0, last7Days: 0 },
      totalLabour: { total: 0 },
      delayedSmallWorks: { overdue: 0, dueSoon: 0 },
    });
  });

  it("counts the open works by status, and the overdue ones by the list's own rule", async () => {
    await workItem("NOT_STARTED", day(-1));
    await workItem("IN_PROGRESS", day(-1));
    await workItem("IN_PROGRESS", day(0));
    await workItem("DELAYED", day(-30));
    await workItem("DELAYED", null);
    await workItem("DONE", day(-40));
    await workItem("DONE", null);

    const { openWorks } = await service().summary(ADMIN);

    expect(openWorks).toMatchObject({
      total: 7,
      delayed: 2,
      byStatus: { NOT_STARTED: 1, IN_PROGRESS: 2, DELAYED: 2, DONE: 2 },
      // Past end date and not done: the first, second and fourth. Today's end date, no end date and DONE are not.
      overdue: 3,
    });
    // The same three are listed, the earliest end date first, each with the whole days since it.
    expect(openWorks?.overdueList.map((work) => [work.endDate, work.overdueDays])).toEqual([
      [day(-30), 30],
      [day(-1), 1],
      [day(-1), 1],
    ]);
    // The open works list, asked for the overdue ones on the same day, finds the same three.
    const listed = await new OpenWorksRepository().list(
      {
        filters: { overdue: true },
        sort: { field: "endDate", direction: "asc" },
        today: new Date(TODAY),
        skip: 0,
        take: 100,
      },
      scratch.prisma as unknown as Prisma.TransactionClient,
    );
    expect(listed.total).toBe(3);
  });

  it("counts the daily reports of today and of the last 7 days, with the boundaries on both sides", async () => {
    await dailyReport("c1", -8);
    await dailyReport("c1", -7);
    await dailyReport("c1", -6);
    await dailyReport("c1", -1);
    await dailyReport("c1", 0);
    await dailyReport("c2", 0);
    await dailyReport("c1", 1);

    const { dailyReports } = await service().summary(ADMIN);

    // The window is today and the six days before it: -6 is in, -7 is out; tomorrow is in neither.
    expect(dailyReports).toEqual({ today: 2, last7Days: 4 });
  });

  it("adds up the labourers of today and of the last 7 days, not the rows", async () => {
    await labour("v1", "c1", -8, 1000);
    await labour("v1", "c1", -7, 2000);
    await labour("v1", "c1", -6, 7);
    await labour("v1", "c1", 0, 40);
    await labour("v2", "c1", 0, 25);
    await labour("v3", "c2", 0, 0);
    await labour("v1", "c1", 1, 500);

    const { labour: figures } = await service().summary(ADMIN);

    expect(figures).toEqual({ today: 65, last7Days: 72 });
    // The total labour card adds up the workers count of the labour daily reports (all dates), not the labour rows.
    const reports = await q(`SELECT COALESCE(sum("workersCount"), 0)::int AS "total" FROM "DailyReport"`);
    expect((await service().summary(ADMIN)).totalLabour).toEqual({ total: reports.rows[0].total });
  });

  // NOW is 18:37 on 2026-10-12 in Kuwait (UTC+3), and the alert window is 8 hours: a pending work ending that day is due soon (its
  // deadline is 5 hours away), one that ended before it is overdue, and one that ends tomorrow is neither.
  it("counts the pending small works over all time, and which of them are due soon and overdue in the application's time zone", async () => {
    const works = [
      ["PENDING", -500, "overdue-old"],
      ["PENDING", -1, "overdue-yesterday"],
      ["PENDING", 0, "due-today"],
      ["PENDING", 1, "tomorrow"],
      ["DONE", -3, "done-old"],
      ["DONE", 0, "done-today"],
    ] as const;
    for (const [status, offset, description] of works) {
      await q(
        `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","status","updatedAt")
         VALUES ($1,'v1','c1',$2::date - 1,$2::date,$3,$4::"SmallWorkStatus",now())`,
        [id("s"), day(offset), description, status],
      );
    }

    const summary = await service().summary(ADMIN);
    const { smallWorks } = summary;

    expect(smallWorks).toMatchObject({ total: 6, pending: 4, dueSoon: 1, overdue: 2 });
    expect(summary.delayedSmallWorks).toEqual({ overdue: 2, dueSoon: 1 });
    expect(smallWorks?.urgent.map((one) => [one.description, one.alert])).toEqual([
      ["overdue-old", "overdue"],
      ["overdue-yesterday", "overdue"],
      ["due-today", "dueSoon"],
    ]);
    expect(smallWorks?.urgent[2]).toMatchObject({
      villa: { id: "v1" },
      contractor: { id: "c1", name: "Nile" },
      endDate: day(0),
      deadlineAt: "2026-10-12T21:00:00.000Z",
    });
  });

  it("lists only the five most urgent small works, the earliest end date first", async () => {
    await q(`DELETE FROM "DailySmallWork"`);
    for (let index = 0; index < 8; index++) {
      await q(
        `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","status","updatedAt")
         VALUES ($1,'v1','c1',$2::date - 1,$2::date,$3,'PENDING',now())`,
        [id("s"), day(-index), `late-${index}`],
      );
    }

    const { smallWorks } = await service().summary(ADMIN);

    expect(smallWorks?.overdue).toBe(7);
    expect(smallWorks?.urgent.map((one) => one.description)).toEqual([
      "late-7",
      "late-6",
      "late-5",
      "late-4",
      "late-3",
    ]);
  });

  it("counts the site reports and averages their ratings to one decimal, over all time", async () => {
    for (const [rating, offset] of [
      [5, -900],
      [4, 0],
      [4, 3],
      [4, -2],
    ] as const) {
      await q(
        `INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","updatedAt")
         VALUES ($1,'v1','t',$2::date,'i','SAFETY',$3,'f',now())`,
        [id("sr"), day(offset), rating],
      );
    }

    // 17 over 4 reports is 4.25, which shows as 4.3 (halves go up).
    expect((await service().summary(ADMIN)).siteReports).toEqual({ count: 4, averageRating: 4.3 });
  });

  it("returns every count as a plain number, never a bigint (it would not serialise)", async () => {
    const summary = await service().summary(ADMIN);

    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(typeof summary.dailyReports?.today).toBe("number");
    expect(typeof summary.labour?.last7Days).toBe("number");
    expect(typeof summary.siteReports?.count).toBe("number");
  });

  it("names the audit entries of the work records from the real tables", async () => {
    const first = async (table: string, column: string): Promise<{ id: string; name: string }> => {
      const { rows } = await q(
        `SELECT "id", "${column}"::text AS "name" FROM "${table}" ORDER BY "id" LIMIT 1`,
      );
      return rows[0] as { id: string; name: string };
    };
    // An open work has no title of its own: it is named by its electrical phase and its villa.
    const work = (
      await q(
        `SELECT w."id", ep."name" || ' - ' || v."villaNumber" AS "name" FROM "WorkItem" w
         JOIN "ElecPhase" ep ON ep."id" = w."elecPhaseId" JOIN "Villa" v ON v."id" = w."villaId" ORDER BY w."id" LIMIT 1`,
      )
    ).rows[0] as { id: string; name: string };
    const report = await first("DailyReport", "reportDate");
    const small = await first("DailySmallWork", "description");
    const site = await first("SiteReport", "title");
    const labourRow = await first("DailyLabour", "labourDate");
    const entries = [
      ["WorkItem", work],
      ["DailyReport", report],
      ["DailySmallWork", small],
      ["SiteReport", site],
      ["DailyLabour", labourRow],
    ] as const;

    const names = await new AuditRepository().entityNames(
      entries.map(([entity, row], index) => ({ id: String(index), entity, entityId: row.id })),
      scratch.prisma as unknown as Prisma.TransactionClient,
    );

    expect([...names.values()]).toEqual(entries.map(([, row]) => row.name));
  });

  // Rows that are inserted, read and rolled back inside one transaction: nothing stays behind for the tests around them, and a
  // test may delete whatever it needs gone (the villas, the phases) to start from a table of its own making.
  class Rollback extends Error {}
  async function rolledBack<T>(work: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let result: T | undefined;
    try {
      await scratch.prisma.$transaction(async (db) => {
        result = await work(db as unknown as Prisma.TransactionClient);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return result as T;
  }
  const run = (db: Prisma.TransactionClient, text: string, ...values: unknown[]) =>
    db.$executeRawUnsafe(text, ...values);
  const repository = () => new DashboardRepository();

  type VillaOptions = { target?: number; ready?: boolean; contractor?: string; area?: string };
  const addVilla = (db: Prisma.TransactionClient, villa: string, options: VillaOptions = {}) =>
    run(
      db,
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","targetDate","mewFollowUpAt","updatedAt")
       VALUES ($1,$1,'B1',$1,'eng','admin',$2,$3,$4::date,$5,now())`,
      villa,
      options.area ?? "area",
      options.contractor ?? null,
      options.target === undefined ? null : day(options.target),
      options.ready ? new Date(NOW) : null,
    );
  const addArea = (db: Prisma.TransactionClient, area: string, name: string, city: string) =>
    run(db, `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ($1,$2,$3,now())`, area, name, city);
  const addContractor = (db: Prisma.TransactionClient, contractor: string, name: string) =>
    run(
      db,
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ($1,$2,'0100','ACTIVE',now())`,
      contractor,
      name,
    );
  const plain = (counts: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));

  it("counts the villas against the days: overdue before today, upcoming from today to 30 days, ready by the mark", async () => {
    const counters = await rolledBack(async (db) => {
      await addVilla(db, "t-90", { target: -90, ready: true });
      await addVilla(db, "t-5", { target: -5 });
      await addVilla(db, "t-1", { target: -1 });
      await addVilla(db, "t0", { target: 0 });
      await addVilla(db, "t29", { target: 29, ready: true });
      await addVilla(db, "t30", { target: 30 });
      return repository().villaCounters(dayRange(NOW), db);
    });

    // The three base villas have no target date, so they are neither. Due today is upcoming; the 30th day out is neither.
    expect(plain(counters)).toEqual({ total: 9, overdue: 3, upcoming: 2, mewFollowUp: 2, mewInspection: 0 });
  });

  it("counts the villas on the MEW inspection list that have not passed it, and the open and solved maintenance villas", async () => {
    const result = await rolledBack(async (db) => {
      await addVilla(db, "m1");
      await addVilla(db, "m2");
      await addVilla(db, "m3");
      await run(db, `UPDATE "Villa" SET "mewInspectionAt" = now() WHERE "id" IN ('m1','m2')`);
      await run(db, `UPDATE "Villa" SET "mewInspectionPassedAt" = now() WHERE "id" = 'm2'`);
      for (const [id, solved] of [
        ["x1", false],
        ["x2", false],
        ["x3", true],
      ] as const) {
        await run(
          db,
          `INSERT INTO "MaintenanceVilla" ("id","villaNumber","location","handoverDate","issue","solvedAt","updatedAt")
           VALUES ($1,'V-1','Block 1','2026-08-01'::date,'AC',$2,now())`,
          id,
          solved ? new Date(NOW) : null,
        );
      }
      return {
        villas: await repository().villaCounters(dayRange(NOW), db),
        maintenance: await repository().maintenanceCounters(db),
      };
    });

    expect(Number(result.villas.mewInspection)).toBe(1);
    expect(plain(result.maintenance)).toEqual({ open: 2, solved: 1 });
  });

  it("derives each villa's state from its ACTIVE phases only, and the average's sum and count", async () => {
    const row = await rolledBack(async (db) => {
      // The open works hold their phases (RESTRICT): they go first.
      await run(db, `DELETE FROM "WorkItem"`);
      await run(db, `DELETE FROM "ElecPhase"`);
      await run(
        db,
        `INSERT INTO "ElecPhase" ("id","name","sortOrder","status","updatedAt") VALUES
         ('pa','A',1,'ACTIVE',now()),('pb','B',2,'ACTIVE',now()),('px','X',3,'INACTIVE',now())`,
      );
      for (const villa of ["v4", "v5", "v6", "v7"]) await addVilla(db, villa);
      const progress = async (villa: string, phase: string, value: number) => {
        await run(
          db,
          // A phase at 100 carries its completion time (the table's own check).
          `INSERT INTO "VillaPhaseProgress" ("villaId","elecPhaseId","progress","completedAt","updatedAt")
           VALUES ($1,$2,$3::int,CASE WHEN $3::int = 100 THEN now() END,now())`,
          villa,
          phase,
          value,
        );
        // Villa progress is read from the open works: the villa's open work for the phase is at the same progress.
        await run(
          db,
          `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","progress","source","updatedAt")
           VALUES (gen_random_uuid()::text,$1,$2,
             (CASE WHEN $3::int = 0 THEN 'NOT_STARTED' WHEN $3::int = 100 THEN 'DONE' ELSE 'IN_PROGRESS' END)::"WorkStatus",
             $3::int,'MANUAL',now())`,
          villa,
          phase,
          value,
        );
      };
      // v1: nothing in the active phases (the inactive one does not count); v2, v5: done; v3, v6, v7: under way; v4: no row at all.
      await progress("v1", "pa", 0);
      await progress("v1", "pb", 0);
      await progress("v1", "px", 100);
      await progress("v2", "pa", 100);
      await progress("v2", "pb", 100);
      await progress("v3", "pa", 50);
      await progress("v3", "pb", 0);
      await progress("v5", "pa", 100);
      await progress("v5", "pb", 100);
      await progress("v5", "px", 0);
      await progress("v6", "pa", 100);
      await progress("v6", "pb", 99);
      await progress("v7", "pa", 100);
      await progress("v7", "pb", 0);
      const noRatios = await repository().progressCounters(db);
      // Then A adds 30 and B 70 to a villa once its open work for them is done; the states do not change.
      await run(db, `UPDATE "ElecPhase" SET "progressRatio" = 30 WHERE "id" = 'pa'`);
      await run(db, `UPDATE "ElecPhase" SET "progressRatio" = 70 WHERE "id" = 'pb'`);
      return { noRatios, withRatios: await repository().progressCounters(db) };
    });

    // Every ratio at 0: a done phase adds nothing, so every villa is at 0.
    expect(plain(row.noRatios)).toEqual({
      progressSum: 0,
      phaseCount: 2,
      notStarted: 2,
      inProgress: 3,
      done: 2,
    });
    // v2, v5: both done (100 each); v3: none (A at 50); v6: A done (30), B at 99; v7: A done (30). 100 + 100 + 30 + 30.
    expect(plain(row.withRatios)).toEqual({
      progressSum: 260,
      phaseCount: 2,
      notStarted: 2,
      inProgress: 3,
      done: 2,
    });
  });

  it("calls no villa done when there is no active phase, and answers zeros (not null) when there is no villa", async () => {
    const noPhases = await rolledBack(async (db) => {
      // The open works hold their phases (RESTRICT): they go first.
      await run(db, `DELETE FROM "WorkItem"`);
      await run(db, `DELETE FROM "ElecPhase"`);
      return repository().progressCounters(db);
    });
    const noVillas = await rolledBack(async (db) => {
      for (const table of ["DailyReport", "DailySmallWork", "SiteReport", "DailyLabour", "WorkItem"]) {
        await run(db, `DELETE FROM "${table}"`);
      }
      await run(db, `DELETE FROM "Villa"`);
      return repository().progressCounters(db);
    });

    expect(plain(noPhases)).toEqual({
      progressSum: 0,
      phaseCount: 0,
      notStarted: 3,
      inProgress: 0,
      done: 0,
    });
    expect(noVillas.progressSum).not.toBeNull();
    expect(plain(noVillas)).toMatchObject({ progressSum: 0, notStarted: 0, inProgress: 0, done: 0 });
  });

  // A name and city pair is unique (case-insensitively), so two areas never tie on both: the id is a last resort that cannot be reached.
  it("lists the busiest areas first, ties by name then city, at most 50", async () => {
    const rows = await rolledBack(async (db) => {
      const areas: [string, string, string, number][] = [
        ["g", "gamma", "giza", 2],
        ["z", "alpha", "dubai", 1],
        ["a", "alpha", "cairo", 1],
        ["m", "alpha", "aswan", 1],
        ["b", "beta", "cairo", 1],
        ...Array.from({ length: 46 }, (_, i): [string, string, string, number] => {
          const n = String(i).padStart(2, "0");
          return [`f${n}`, `t${n}`, "cairo", 1];
        }),
      ];
      for (const [area, name, city, villas] of areas) {
        await addArea(db, area, name, city);
        for (let i = 0; i < villas; i++) await addVilla(db, `${area}-${i}`, { area });
      }
      return repository().areaBreakdown(db);
    });

    // 52 areas in all; the base area (3 villas) and gamma (2) lead, then the one-villa areas in order; the last two are cut.
    const fillers = Array.from({ length: 44 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    expect(rows.map((row) => row.areaId)).toEqual(["area", "g", "m", "a", "z", "b", ...fillers]);
    expect(rows.map((row) => Number(row.total)).slice(0, 3)).toEqual([3, 2, 1]);
  });

  it("lists the busiest contractors first, ties by name and id, at most 10", async () => {
    const rows = await rolledBack(async (db) => {
      await run(db, `UPDATE "Contractor" SET "name" = 'nile' WHERE "id" = 'c1'`);
      await run(db, `UPDATE "Contractor" SET "name" = 'delta' WHERE "id" = 'c2'`);
      await addContractor(db, "k2", "aaa");
      await addContractor(db, "k1", "aaa");
      for (let i = 1; i <= 12; i++)
        await addContractor(db, `z${String(i).padStart(2, "0")}`, `zz${String(i).padStart(2, "0")}`);
      for (const contractor of [
        "k2",
        "k1",
        ...Array.from({ length: 12 }, (_, i) => `z${String(i + 1).padStart(2, "0")}`),
      ]) {
        await addVilla(db, `cv-${contractor}`, { contractor });
      }
      return repository().topContractors(db);
    });

    expect(rows.map((row) => row.id)).toEqual([
      "c1",
      "k1",
      "k2",
      "c2",
      "z01",
      "z02",
      "z03",
      "z04",
      "z05",
      "z06",
    ]);
    expect(rows.map((row) => Number(row.total))).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("does not count villas without a contractor", async () => {
    const rows = await rolledBack(async (db) => {
      await addVilla(db, "no-contractor");
      return repository().topContractors(db);
    });

    expect(rows.map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  it("reads the figures of one summary in a repeatable-read snapshot", async () => {
    const rows = await repository().snapshot(
      (db) => db.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`,
    );

    expect(rows).toEqual([{ transaction_isolation: "repeatable read" }]);
  });

  it("reads the newest audit entries first (ties by id), no more than asked for, each with the name of what it is about", async () => {
    const rows = await rolledBack(async (db) => {
      const entry = (id: string, entityId: string | null, offsetMs: number) =>
        run(
          db,
          `INSERT INTO "AuditLog" ("id","action","entity","entityId","createdAt") VALUES ($1,'villa.update','Villa',$2,$3)`,
          id,
          entityId,
          new Date(NOW.getTime() + offsetMs),
        );
      // Written in an order that is neither the age nor the id (the tied entries in no order), so only the query's own
      // ordering gives the answer.
      await entry("a1", null, -2000);
      for (const tied of ["b5", "b2", "b8", "b1", "b9", "b4", "b7", "b3", "b6"]) {
        await entry(tied, tied === "b1" ? "v2" : null, -1000);
      }
      await entry("a3", "v1", 0);
      return repository().recentAudit(5, db);
    });

    expect(rows.map((row) => row.id)).toEqual(["a3", "b1", "b2", "b3", "b4"]);
    expect(rows.map((row) => row.entityName)).toEqual(["v1", "v2", null, null, null]);
  });

  it("gives the recent activity of a user entry the user's name and email", async () => {
    const rows = await rolledBack(async (db) => {
      await run(
        db,
        `INSERT INTO "AuditLog" ("id","action","entity","entityId","createdAt") VALUES ($1,'user.update','User','emp-open',$2)`,
        "r-user",
        new Date(NOW.getTime() + 5000),
      );
      return repository().recentAudit(1, db);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r-user", entityName: "Open Works Only", entityDetail: "o@x.test" });
  });

  it("names a user by their name and email, from the user while they exist and from the entry's snapshot once they are gone", async () => {
    const refs = await rolledBack(async (db) => {
      const entry = (id: string, entityId: string, after: string | null) =>
        run(
          db,
          `INSERT INTO "AuditLog" ("id","action","entity","entityId","after") VALUES ($1,'user.update','User',$2,$3::jsonb)`,
          id,
          entityId,
          after,
        );
      await entry("u-live", "emp-open", null);
      await entry("u-gone", "no-such-user", JSON.stringify({ name: "Gone User", email: "gone@x.test" }));
      await entry("u-bare", "no-such-user", null);
      return new AuditRepository().entityRefs(
        [
          { id: "u-live", entity: "User", entityId: "emp-open" },
          { id: "u-gone", entity: "User", entityId: "no-such-user" },
          { id: "u-bare", entity: "User", entityId: "no-such-user" },
        ],
        db,
      );
    });

    expect(Object.fromEntries(refs)).toEqual({
      "u-live": { name: "Open Works Only", detail: "o@x.test" },
      "u-gone": { name: "Gone User", detail: "gone@x.test" },
    });
  });

  it("cuts the cards to the user's grants, on the real permission tables", async () => {
    const open = await service().summary({ id: "emp-open", role: "EMPLOYEE" });
    const top = await service().summary({ id: "emp-top", role: "EMPLOYEE" });
    const none = await service().summary({ id: "emp-none", role: "EMPLOYEE" });

    expect(open.openWorks).not.toBeNull();
    expect(open.labour).toEqual({ today: 65, last7Days: 72 });
    expect(open.villas).toBeNull();
    expect(open.topContractors).toBeNull();
    expect(open.dailyReports).toBeNull();
    expect(top.villas).toEqual({ total: 3 });
    // Villas and contractors together: Nile has two villas, Delta one.
    expect(top.topContractors).toEqual([
      { id: "c1", name: "Nile", total: 2 },
      { id: "c2", name: "Delta", total: 1 },
    ]);
    expect(top.openWorks).toBeNull();
    expect(Object.entries(none).filter(([key, value]) => key !== "generatedAt" && value !== null)).toEqual(
      [],
    );
  });
});
