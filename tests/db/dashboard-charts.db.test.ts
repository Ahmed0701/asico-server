import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The dashboard charts on a real PostgreSQL (scratch schema): the progress trend rebuilt from the open works' history,
// the open works of each phase by status, the workers of the last 14 days, the payments of the last 6 months, and each
// chart cut by the viewer's permissions.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { DashboardRepository } from "../../src/modules/dashboard/repository/dashboard.repository.js";
import { DashboardChartsRepository } from "../../src/modules/dashboard-charts/repository/dashboard-charts.repository.js";
import { DashboardChartsService } from "../../src/modules/dashboard-charts/service/dashboard-charts.service.js";
import { MonthlyProgressRepository } from "../../src/modules/monthly-progress/repository/monthly-progress.repository.js";

// 09:00 UTC on 2026-11-15: midday in Kuwait.
const NOW = new Date("2026-11-15T09:00:00.000Z");
const PH_A = "00000000-0000-4000-8000-00000000c0a1";
const PH_B = "00000000-0000-4000-8000-00000000c0b2";
const C1 = "00000000-0000-4000-8000-00000000c0c1";

describe.skipIf(!RUN)("dashboard charts on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = () =>
    new DashboardChartsService(
      new DashboardChartsRepository(),
      new MonthlyProgressRepository(),
      new DashboardRepository(),
      () => NOW,
    );

  beforeAll(async () => {
    scratch = await openScratch("scratchcharts", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','a@x.test','x','ADMIN',true,now()), ('emp','Emp','e@x.test','x','EMPLOYEE',true,now())`,
    );
    await q(
      `INSERT INTO "Permission" ("id","code") VALUES (gen_random_uuid()::text,'daily-labour:read') ON CONFLICT ("code") DO NOTHING`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") SELECT 'emp', "id" FROM "Permission" WHERE "code" = 'daily-labour:read'`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ('${C1}','Nile','0100','ACTIVE',now())`,
    );
    await q(`UPDATE "ElecPhase" SET "status" = 'INACTIVE'`);
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","progressRatio","status","updatedAt") VALUES
       ('${PH_A}','Chart A',701,50,'ACTIVE',now()), ('${PH_B}','Chart B',702,50,'ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","createdAt","updatedAt") VALUES
       ('v1','V-1','B','1','eng','admin','area','${C1}','2026-08-01T00:00:00Z',now()),
       ('v2','V-2','B','2','eng','admin','area','${C1}','2026-08-01T00:00:00Z',now())`,
    );
    // Open works: V-1 phase A done (since October), phase B delayed; V-2 phase A in progress, phase B not started.
    await q(
      `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","progress","source","createdAt","updatedAt") VALUES
       ('w1','v1','${PH_A}','DONE',100,'MANUAL','2026-09-01T00:00:00Z',now()),
       ('w2','v1','${PH_B}','DELAYED',40,'MANUAL','2026-09-01T00:00:00Z',now()),
       ('w3','v2','${PH_A}','IN_PROGRESS',60,'MANUAL','2026-09-01T00:00:00Z',now()),
       ('w4','v2','${PH_B}','NOT_STARTED',0,'MANUAL','2026-09-01T00:00:00Z',now())`,
    );
    // w1 went from 0 to 100 on 2026-10-10.
    await q(
      `INSERT INTO "AuditLog" ("id","actorId","action","entity","entityId","before","after","createdAt") VALUES
       (gen_random_uuid()::text,'admin','open_work.update','WorkItem','w1',
        '{"villaId":"v1","elecPhaseId":"${PH_A}","progress":0}','{"villaId":"v1","elecPhaseId":"${PH_A}","progress":100}','2026-10-10T08:00:00Z')`,
    );
    await q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","createdById","updatedAt") VALUES
       (gen_random_uuid()::text,'v1','2026-11-15','${C1}',12,'admin',now()),
       (gen_random_uuid()::text,'v2','2026-11-15','${C1}',8,'admin',now()),
       (gen_random_uuid()::text,'v1','2026-11-02','${C1}',5,'admin',now()),
       (gen_random_uuid()::text,'v1','2026-11-01','${C1}',99,'admin',now())`,
    );
    await q(
      `INSERT INTO "ContractorPayment" ("id","contractorId","amountMinor","status","paidDate","updatedAt") VALUES
       (gen_random_uuid()::text,'${C1}',1500000,'PAID','2026-11-03',now()),
       (gen_random_uuid()::text,'${C1}',500000,'PAID','2026-11-10',now()),
       (gen_random_uuid()::text,'${C1}',250000,'PAID','2026-07-20',now()),
       (gen_random_uuid()::text,'${C1}',999000,'PAID','2026-05-31',now())`,
    );
    await q(
      `INSERT INTO "ContractorPayment" ("id","contractorId","amountMinor","status","updatedAt") VALUES (gen_random_uuid()::text,'${C1}',777000,'PENDING',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("gives an admin every chart, with the figures of the database", async () => {
    const charts = await service().charts({ id: "admin", role: "ADMIN" });

    // V-1 reached 50 (phase A done) in October; V-2 has no done phase.
    expect(charts.progressTrend).toEqual([
      { month: "2026-06", average: 0, done: 0, villas: 0 },
      { month: "2026-07", average: 0, done: 0, villas: 0 },
      { month: "2026-08", average: 0, done: 0, villas: 2 },
      { month: "2026-09", average: 0, done: 0, villas: 2 },
      { month: "2026-10", average: 25, done: 0, villas: 2 },
      { month: "2026-11", average: 25, done: 0, villas: 2 },
    ]);
    expect(charts.phaseStatus).toEqual([
      { elecPhaseId: PH_A, name: "Chart A", notStarted: 0, inProgress: 1, delayed: 0, done: 1 },
      { elecPhaseId: PH_B, name: "Chart B", notStarted: 1, inProgress: 0, delayed: 1, done: 0 },
    ]);
    // The last 14 UTC days: 2026-11-02 to 2026-11-15 (the 1st is outside).
    expect(charts.labourByDay).toHaveLength(14);
    expect(charts.labourByDay![0]).toEqual({ day: "2026-11-02", workers: 5 });
    expect(charts.labourByDay![13]).toEqual({ day: "2026-11-15", workers: 20 });
    expect(charts.labourByDay!.reduce((sum, day) => sum + day.workers, 0)).toBe(25);
    // June to November; May and the pending one are left out.
    expect(charts.paymentsByMonth).toEqual([
      { month: "2026-06", paidMinor: 0 },
      { month: "2026-07", paidMinor: 250000 },
      { month: "2026-08", paidMinor: 0 },
      { month: "2026-09", paidMinor: 0 },
      { month: "2026-10", paidMinor: 0 },
      { month: "2026-11", paidMinor: 2000000 },
    ]);
    expect(charts.generatedAt).toBe(NOW.toISOString());
  });

  it("gives an employee only the charts its permissions allow", async () => {
    const charts = await service().charts({ id: "emp", role: "EMPLOYEE" });

    expect(charts.labourByDay).not.toBeNull();
    expect(charts.progressTrend).toBeNull();
    expect(charts.phaseStatus).toBeNull();
    expect(charts.paymentsByMonth).toBeNull();
  });
});
