import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The monthly progress on a real PostgreSQL (scratch schema): open works created and edited through the service in
// October and November, then each villa's progress at the end of October and now, the summary, the search and the sort.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { MonthlyProgressRepository } from "../../src/modules/monthly-progress/repository/monthly-progress.repository.js";
import { MonthlyProgressService } from "../../src/modules/monthly-progress/service/monthly-progress.service.js";
import { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import { OpenWorksService } from "../../src/modules/open-works/service/open-works.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const admin = { id: "admin", role: "ADMIN" } as never;
const PH_A = "00000000-0000-4000-8000-0000000000a1";
const PH_B = "00000000-0000-4000-8000-0000000000b2";
// 09:00 UTC on 2026-11-15 is midday in Kuwait.
const NOW = new Date("2026-11-15T09:00:00.000Z");

describe.skipIf(!RUN)("monthly progress on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = new MonthlyProgressService(new MonthlyProgressRepository(), () => NOW);

  beforeAll(async () => {
    scratch = await openScratch("scratchmonthly", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root','a@x.test','x','ADMIN',true,now())`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ('c1','Nile Builders','0100','ACTIVE',now())`,
    );
    await q(`UPDATE "ElecPhase" SET "status" = 'INACTIVE'`);
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","progressRatio","status","updatedAt") VALUES
       ('${PH_A}','Monthly A',801,40,'ACTIVE',now()), ('${PH_B}','Monthly B',802,60,'ACTIVE',now())`,
    );
    // V-2 and V-10 from September, V-3 added in November, V-9 stamped December 1st: after the clock of the test, as a
    // database clock ahead of the app's would make it. The current month still lists it; October does not.
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","createdAt","updatedAt") VALUES
       ('v2','V-2','B1','2','eng','admin','area','c1','2026-09-01T00:00:00Z',now()),
       ('v10','V-10','B1','10','eng','admin','area',NULL,'2026-09-01T00:00:00Z',now()),
       ('v3','V-3','B1','3','eng','admin','area',NULL,'2026-11-05T00:00:00Z',now()),
       ('v9','V-9','B1','9','eng','admin','area',NULL,'2026-12-01T00:00:00Z',now())`,
    );

    const works = new OpenWorksService(new OpenWorksRepository());
    const create = (villaId: string, elecPhaseId: string, progress: number) =>
      works.create(
        admin,
        { villaId, elecPhaseId, progress, status: progress >= 100 ? "DONE" : "IN_PROGRESS" } as never,
        ctx,
      );
    // V-2: phase A done in October; phase B done in November. V-10: phase A at 50 in October, done in November.
    // V-3: phase B done in November.
    const v2a = await create("v2", PH_A, 100);
    const v2b = await create("v2", PH_B, 40);
    const v10a = await create("v10", PH_A, 50);
    await works.update(admin, v2b.id, { progress: 100, status: "DONE" } as never, ctx, v2b.version);
    await works.update(admin, v10a.id, { progress: 100, status: "DONE" } as never, ctx, v10a.version);
    await create("v3", PH_B, 100);
    // Dates: the creates in October, the November edits and V-3 in November (the audit log is append-only, so the times
    // are set on the open works and through a scratch-only copy of the log).
    await q(`ALTER TABLE "AuditLog" DISABLE TRIGGER USER`);
    await q(
      `UPDATE "AuditLog" SET "createdAt" = '2026-10-10T08:00:00Z' WHERE "action" = 'open_work.create' AND "entityId" IN ($1,$2,$3)`,
      [v2a.id, v2b.id, v10a.id],
    );
    await q(
      `UPDATE "AuditLog" SET "createdAt" = '2026-11-08T08:00:00Z' WHERE "action" IN ('open_work.update') OR ("action" = 'open_work.create' AND "entityId" NOT IN ($1,$2,$3))`,
      [v2a.id, v2b.id, v10a.id],
    );
    await q(`ALTER TABLE "AuditLog" ENABLE TRIGGER USER`);
    await q(`UPDATE "WorkItem" SET "createdAt" = '2026-10-10T08:00:00Z' WHERE "villaId" IN ('v2','v10')`);
    await q(`UPDATE "WorkItem" SET "createdAt" = '2026-11-08T08:00:00Z' WHERE "villaId" = 'v3'`);
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("gives each villa its progress at the end of October and now, with the change and the summary", async () => {
    const result = await service.list({ page: 1, limit: 20 } as never, ctx);

    expect(
      result.items.map((item) => [
        item.villa.villaNumber,
        item.previousProgress,
        item.currentProgress,
        item.change,
      ]),
    ).toEqual([
      ["V-2", 40, 100, 60],
      ["V-3", null, 60, 60],
      ["V-9", null, 0, 0],
      ["V-10", 0, 40, 40],
    ]);
    expect(result.items[0]!.contractor).toEqual({ id: "c1", name: "Nile Builders" });
    expect(result.summary).toEqual({
      month: "2026-11",
      previousMonth: "2026-10",
      isCurrentMonth: true,
      villaCount: 4,
      averagePrevious: 20,
      averageCurrent: 50,
      averageChange: 40,
      improvedCount: 3,
      unchangedCount: 1,
    });
  });

  it("shows a past month as at its end, without the villas added after it", async () => {
    const october = await service.list({ page: 1, limit: 20, month: "2026-10" } as never, ctx);

    expect(
      october.items.map((item) => [item.villa.villaNumber, item.previousProgress, item.currentProgress]),
    ).toEqual([
      ["V-2", 0, 40],
      ["V-10", 0, 0],
    ]);
    expect(october.summary).toMatchObject({
      month: "2026-10",
      previousMonth: "2026-09",
      isCurrentMonth: false,
    });
  });

  it("searches, sorts and pages, and refuses a month after the current one", async () => {
    const byChange = await service.list({ page: 1, limit: 2, sort: "change:desc" } as never, ctx);
    expect(byChange.items.map((item) => item.villa.villaNumber)).toEqual(["V-2", "V-3"]);
    expect(byChange.meta.total).toBe(4);

    const found = await service.list({ page: 1, limit: 20, search: "nile" } as never, ctx);
    expect(found.items.map((item) => item.villa.villaNumber)).toEqual(["V-2"]);

    await expect(service.list({ page: 1, limit: 20, month: "2026-12" } as never, ctx)).rejects.toMatchObject({
      code: "MONTH_IN_FUTURE",
    });
  });
});
