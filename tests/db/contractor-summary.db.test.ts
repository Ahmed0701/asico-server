import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The contractor summary's figures on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the
// end. No database is created or reset, and the asico schema is never touched. Off unless ASICO_DB_TESTS=1:
//   ASICO_DB_TESTS=1 npx vitest run tests/db/contractor-summary.db.test.ts
//
// What it checks: the data is created through EVERY relation that names a contractor (the open works and the small works by
// their own contractor, the daily reports by theirs, the labour by its own, the villas by theirs) and every number of the
// answer is asserted: the open works by status with delayed and overdue, the small works with overdue and dueSoon on both
// sides of each boundary, the daily reports with their count and last date, the labour with its entries, total and last date;
// that another contractor's rows are never counted; that bigint counts reach the answer as plain numbers; and that the
// sections are cut to what the viewer may read.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { RequestContext } from "../../src/core/middleware/requestContext.js";
import { ContractorsService } from "../../src/modules/contractors/service/contractors.service.js";
import { contractorSummaryQuerySchema } from "../../src/modules/contractors/validators/contractors.validators.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
// 15:37 UTC is 18:37 in Kuwait: the zone's today is 2026-10-12, and 8 hours on it is already the 13th (02:37), so the small
// works are "due soon" on the 12th only and "overdue" before it.
const NOW = new Date("2026-10-12T15:37:42.123Z");
const KUWAIT = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const TODAY = Date.UTC(2026, 9, 12);
const DAY = 86_400_000;
// A DATE, as YYYY-MM-DD, `offset` days from today.
const day = (offset: number): string => new Date(TODAY + offset * DAY).toISOString().slice(0, 10);
const query = contractorSummaryQuerySchema.parse({});

describe.skipIf(!RUN)("the contractor summary on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const summary = (contractor: string, viewer?: { id: string; role: "ADMIN" | "EMPLOYEE" }) =>
    new ContractorsService(undefined, () => NOW, KUWAIT).summary(contractor, query, ctx, viewer);

  let counter = 0;
  const id = (prefix: string): string => `${prefix}${++counter}`;

  // The table's own checks: a done item is at 100 and a not started one at 0.
  const PROGRESS: Record<string, number> = { NOT_STARTED: 0, IN_PROGRESS: 50, DELAYED: 20, DONE: 100 };
  const openWork = (villa: string, contractor: string | null, status: string, endDate: string | null) =>
    q(
      `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","progress","source","contractorId","endDate","updatedAt")
       VALUES ($1,$2,'ph','${status}',$3,'MANUAL',$4,$5::date,now())`,
      [id("w"), villa, PROGRESS[status], contractor, endDate],
    );
  const smallWork = (villa: string, contractor: string, status: string, endOffset: number) =>
    q(
      `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","status","updatedAt")
       VALUES ($1,$2,$3,$4::date,$5::date,'work','${status}',now())`,
      [id("s"), villa, contractor, day(endOffset - 1), day(endOffset)],
    );
  const report = (contractor: string, offset: number) =>
    q(
      `INSERT INTO "DailyReport" ("id","contractorId","preparedByEngineerId","reportDate","weather","workersCount","updatedAt")
       VALUES ($1,$2,'elec',$3::date,'SUNNY',5,now())`,
      [id("r"), contractor, day(offset)],
    );
  const labour = (villa: string, contractor: string, offset: number, count: number) =>
    q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt")
       VALUES ($1,$2,$3::date,$4,$5,now())`,
      [id("l"), villa, day(offset), contractor, count],
    );

  beforeAll(async () => {
    scratch = await openScratch("scratch19s", 4);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES
       ('admin','Root Admin','a@x.test','x','ADMIN',now()),
       ('u-open','Open only','o@x.test','x','EMPLOYEE',now()),
       ('u-small','Small only','s@x.test','x','EMPLOYEE',now()),
       ('u-reports','Reports and labour','r@x.test','x','EMPLOYEE',now()),
       ('u-all','All four','all@x.test','x','EMPLOYEE',now()),
       ('u-none','Summary only','n@x.test','x','EMPLOYEE',now())`,
    );
    await q(
      `INSERT INTO "Permission" ("id","code") VALUES
       ('p1','open-works:read'),('p2','small-works:read'),('p3','daily-reports:read'),
       ('p4','daily-labour:read'),('p5','contractors:summary')`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") VALUES
       ('u-open','p1'),('u-small','p2'),('u-reports','p3'),('u-reports','p4'),
       ('u-all','p1'),('u-all','p2'),('u-all','p3'),('u-all','p4'),('u-none','p5')`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
       ('c1','Nile','0100','ACTIVE',now()),('c2','Delta','0101','ACTIVE',now()),('c3','Empty Co','0102','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES ('elec','Hany','0103',now())`,
    );
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ('ph','Summary phase',900,now())`,
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

    // ---- Nile (c1) ---------------------------------------------------------------------------------------------------
    // Open works: by status, each overdue boundary (the day before today is overdue, today is not), an unfinished one with no
    // end date, a finished overdue one (never overdue), and one on a villa of ANOTHER contractor (counted: it names Nile).
    await openWork("v1", "c1", "NOT_STARTED", day(-1)); // overdue
    await openWork("v1", "c1", "IN_PROGRESS", day(0)); // not yet
    await openWork("v2", "c1", "DELAYED", day(-30)); // overdue
    await openWork("v2", "c1", "DELAYED", null);
    await openWork("v1", "c1", "DONE", day(-40)); // done: never overdue
    await openWork("v3", "c1", "IN_PROGRESS", null);
    // ... and rows that must not be counted for Nile: Delta's, and one with no contractor on Nile's villa.
    await openWork("v1", "c2", "DELAYED", day(-5));
    await openWork("v3", "c2", "DONE", null);
    await openWork("v1", null, "NOT_STARTED", day(-9));

    // Small works: overdue (the day before today, ten days before), due soon (today only: the horizon is the 13th, exclusive),
    // neither (tomorrow), and done ones (never overdue or due soon, even today and in the past).
    await smallWork("v1", "c1", "PENDING", -1); // overdue
    await smallWork("v2", "c1", "PENDING", -10); // overdue
    await smallWork("v1", "c1", "PENDING", 0); // due soon
    await smallWork("v1", "c1", "PENDING", 1); // neither
    await smallWork("v1", "c1", "DONE", -5);
    await smallWork("v2", "c1", "DONE", 0);
    await smallWork("v3", "c2", "PENDING", -3); // Delta's

    // Daily reports: one per day; the last date is the greatest, not the latest written. Delta's, in the future, is not Nile's.
    await report("c1", -8);
    await report("c1", 0);
    await report("c1", -1);
    await report("c2", 5);

    // Labour: two villas on one day, then another day; Delta's is not counted.
    await labour("v1", "c1", -3, 10);
    await labour("v2", "c1", -3, 5);
    await labour("v1", "c1", -1, 7);
    await labour("v3", "c2", 2, 100);

    // ---- Delta (c2): one of everything, to see that its numbers are its own. -------------------------------------------
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  const ADMIN = { id: "admin", role: "ADMIN" } as const;

  it("counts every section of a contractor, through every relation that names it", async () => {
    const { summary: result } = await summary("c1", ADMIN);

    expect(result.contractor).toEqual({ id: "c1", name: "Nile", phone: "0100" });
    expect(result.villaCount).toBe(2);
    expect(result.villas.map((villa) => villa.villaNumber).sort()).toEqual(["v1", "v2"]);
    expect(result.openWorks).toEqual({
      total: 6,
      byStatus: { NOT_STARTED: 1, IN_PROGRESS: 2, DELAYED: 2, DONE: 1 },
      delayed: 2,
      overdue: 2,
    });
    expect(result.smallWorks).toEqual({ total: 6, pending: 4, done: 2, overdue: 2, dueSoon: 1 });
    expect(result.dailyReports).toEqual({ count: 3, lastReportDate: day(0) });
    expect(result.labour).toEqual({ entries: 3, totalLabour: 22, lastLabourDate: day(-1) });
  });

  it("answers every number as a plain number, a date as YYYY-MM-DD (bigint and DATE never leak)", async () => {
    const { summary: result } = await summary("c1", ADMIN);

    for (const section of [result.openWorks, result.smallWorks, result.dailyReports, result.labour]) {
      for (const [key, value] of Object.entries(section ?? {})) {
        if (key === "byStatus") {
          for (const n of Object.values(value as Record<string, unknown>)) expect(typeof n).toBe("number");
        } else if (!key.toLowerCase().includes("date")) {
          expect(typeof value, key).toBe("number");
        }
      }
    }
    expect(result.dailyReports?.lastReportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.labour?.lastLabourDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("counts another contractor by its own rows only", async () => {
    const { summary: result } = await summary("c2", ADMIN);

    expect(result.villaCount).toBe(1);
    expect(result.openWorks).toEqual({
      total: 2,
      byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 1, DONE: 1 },
      delayed: 1,
      overdue: 1,
    });
    expect(result.smallWorks).toEqual({ total: 1, pending: 1, done: 0, overdue: 1, dueSoon: 0 });
    expect(result.dailyReports).toEqual({ count: 1, lastReportDate: day(5) });
    expect(result.labour).toEqual({ entries: 1, totalLabour: 100, lastLabourDate: day(2) });
  });

  it("answers zeros and null dates for a contractor with no work at all, and no villas", async () => {
    const { summary: result, meta } = await summary("c3", ADMIN);

    expect(result.villaCount).toBe(0);
    expect(result.villas).toEqual([]);
    expect(meta.total).toBe(0);
    expect(result.openWorks).toEqual({
      total: 0,
      byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 0, DONE: 0 },
      delayed: 0,
      overdue: 0,
    });
    expect(result.smallWorks).toEqual({ total: 0, pending: 0, done: 0, overdue: 0, dueSoon: 0 });
    expect(result.dailyReports).toEqual({ count: 0, lastReportDate: null });
    expect(result.labour).toEqual({ entries: 0, totalLabour: 0, lastLabourDate: null });
  });

  it("moves the overdue and due-soon lines with the clock, in the zone's day", async () => {
    // 21:30 UTC on the 12th is 00:30 on the 13th in Kuwait: the small work due on the 12th is now overdue, and the horizon (8
    // hours on is still the 13th) leaves nothing due soon, because the horizon day itself is exclusive.
    const later = new Date("2026-10-12T21:30:00.000Z");
    const { summary: result } = await new ContractorsService(undefined, () => later, KUWAIT).summary(
      "c1",
      query,
      ctx,
      ADMIN,
    );

    expect(result.smallWorks).toMatchObject({ overdue: 3, dueSoon: 0 });
    // The open works' overdue rule counts from the zone's day too (the 13th in Kuwait), so the work due on the 12th is overdue now.
    expect(result.openWorks?.overdue).toBe(3);
  });

  describe("cuts the sections to what the viewer may read", () => {
    const sections = async (user: string) => {
      const { summary: result } = await summary("c1", { id: user, role: "EMPLOYEE" });
      return {
        openWorks: result.openWorks !== null,
        smallWorks: result.smallWorks !== null,
        dailyReports: result.dailyReports !== null,
        labour: result.labour !== null,
      };
    };

    it("opens only the open works for open-works:read", async () => {
      expect(await sections("u-open")).toEqual({
        openWorks: true,
        smallWorks: false,
        dailyReports: false,
        labour: false,
      });
    });

    it("opens only the small works for small-works:read", async () => {
      expect(await sections("u-small")).toEqual({
        openWorks: false,
        smallWorks: true,
        dailyReports: false,
        labour: false,
      });
    });

    it("opens the daily reports and the labour for their own two grants", async () => {
      expect(await sections("u-reports")).toEqual({
        openWorks: false,
        smallWorks: false,
        dailyReports: true,
        labour: true,
      });
    });

    it("opens all four for all four grants, with the numbers the administrator sees", async () => {
      const admin = (await summary("c1", ADMIN)).summary;
      const all = (await summary("c1", { id: "u-all", role: "EMPLOYEE" })).summary;

      expect(all).toEqual(admin);
    });

    it("leaves every section null with contractors:summary alone, and still answers the contractor and its villas", async () => {
      const { summary: result } = await summary("c1", { id: "u-none", role: "EMPLOYEE" });

      expect(result).toMatchObject({
        contractor: { id: "c1", name: "Nile" },
        villaCount: 2,
        openWorks: null,
        smallWorks: null,
        dailyReports: null,
        labour: null,
      });
      expect(result.villas).toHaveLength(2);
    });

    it("shows a cut section the figures of the real rows, not zeros: the cut is null, never 0", async () => {
      const cut = (await summary("c1", { id: "u-open", role: "EMPLOYEE" })).summary;

      expect(cut.openWorks).toMatchObject({ total: 6 });
      expect(cut.smallWorks).toBeNull();
      expect(cut.labour).toBeNull();
    });
  });
});
