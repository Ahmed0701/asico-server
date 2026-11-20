import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// A villa's budget figures on a real PostgreSQL (scratch schema): read before anything is saved, the first save and the
// next ones with their versions, the total and what remains, the database's own checks, and the row going with the villa.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { VillaFinanceService } from "../../src/modules/villa-finance/service/villa-finance.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const admin = { id: "admin", role: "ADMIN" } as never;

describe.skipIf(!RUN)("villa budget figures on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = new VillaFinanceService();

  beforeAll(async () => {
    scratch = await openScratch("scratchfinance", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',true,now())`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","budgetMinor","currency","updatedAt") VALUES
       ('v1','V-1','B','1','eng','admin','area',100000000,'KWD',now()),
       ('v2','V-2','B','2','eng','admin','area',NULL,NULL,now()),
       ('v3','V-3','B','3','eng','admin','area',5000,'USD',now())`,
    );
  }, 180_000);

  // Runs last (the tests above leave every share empty): the salaries of a villa are its share of the overhead.
  async function shareOf(villaId: string, salaryShareBp: number | null) {
    return service.update(admin, villaId, { salaryShareBp }, ctx);
  }

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("reads a villa with nothing saved: the budget, no figures, version 0", async () => {
    expect(await service.get("v1", ctx)).toMatchObject({
      budgetMinor: 100_000_000,
      currency: "KWD",
      workOrderMinor: null,
      totalCostsMinor: 0,
      remainingMinor: 100_000_000,
      version: 0,
      updatedBy: null,
    });
    await expect(service.get("nope", ctx)).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
  });

  it("saves the figures, adds them up, keeps what is not sent, and checks the version", async () => {
    const first = await service.update(
      admin,
      "v1",
      { workOrderMinor: 60_000_000, pettyCashMinor: 15_500_000 },
      ctx,
    );
    expect(first).toMatchObject({ version: 1, totalCostsMinor: 75_500_000, remainingMinor: 24_500_000 });
    expect(first.updatedBy).toEqual({ id: "admin", name: "Root Admin" });

    const second = await service.update(
      admin,
      "v1",
      { materialsMinor: 30_000_000, pettyCashMinor: 15_750_500 },
      ctx,
      first.version,
    );
    expect(second).toMatchObject({
      workOrderMinor: 60_000_000,
      salariesMinor: null,
      materialsMinor: 30_000_000,
      pettyCashMinor: 15_750_500,
      totalCostsMinor: 105_750_500,
      // Over budget: the remainder goes negative.
      remainingMinor: -5_750_500,
      version: 2,
    });

    // A stale version is refused, and changes nothing.
    await expect(service.update(admin, "v1", { pettyCashMinor: 1 }, ctx, 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    // null clears one figure.
    const cleared = await service.update(admin, "v1", { materialsMinor: null }, ctx, 2);
    expect(cleared).toMatchObject({ materialsMinor: null, pettyCashMinor: 15_750_500, version: 3 });

    const audits = await q(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'villa.finance' AND "entityId" = 'v1'`,
    );
    expect(audits.rows[0].n).toBe(3);
  });

  it("works out no remainder without a budget, or with a budget that is not in KWD", async () => {
    expect((await service.update(admin, "v2", { workOrderMinor: 1000 }, ctx)).remainingMinor).toBeNull();
    expect((await service.update(admin, "v3", { workOrderMinor: 1000 }, ctx)).remainingMinor).toBeNull();
  });

  it("adds the variation orders to the budget, and measures what remains against that total", async () => {
    await q(
      `INSERT INTO "VariationOrder" ("id","villaId","voNumber","amountMinor","dateAdded","status","updatedAt") VALUES
       ('vo1','v1','VO-1',4000000,'2026-11-01','PENDING',now()), ('vo2','v1','VO-2',2000000,'2026-11-02','PAID',now())`,
    );
    const finance = await service.get("v1", ctx);
    expect(finance).toMatchObject({
      budgetMinor: 100_000_000,
      variationOrdersMinor: 6_000_000,
      totalBudgetMinor: 106_000_000,
    });
    expect(finance.remainingMinor).toBe(106_000_000 - finance.totalCostsMinor);
  });

  it("saves the villa budget in KWD, moves the villa on, and clears it with null", async () => {
    const before = await q(`SELECT "version" FROM "Villa" WHERE "id" = 'v3'`);
    const current = await service.get("v3", ctx);
    const saved = await service.update(admin, "v3", { budgetMinor: 80_000_000 }, ctx, current.version);
    expect(saved).toMatchObject({ budgetMinor: 80_000_000, currency: "KWD", totalBudgetMinor: 80_000_000 });
    const after = await q(`SELECT "version" FROM "Villa" WHERE "id" = 'v3'`);
    expect(after.rows[0].version).toBe(before.rows[0].version + 1);

    const cleared = await service.update(admin, "v3", { budgetMinor: null }, ctx, saved.version);
    expect(cleared).toMatchObject({
      budgetMinor: null,
      currency: null,
      totalBudgetMinor: null,
      remainingMinor: null,
    });
  });

  it("lists every villa with its figures, searched and sorted, with the totals", async () => {
    const all = await service.list({ page: 1, limit: 20 } as never);
    expect(all.items.map((item) => item.villa.villaNumber)).toEqual(["V-1", "V-2", "V-3"]);
    expect(all.items[0]!.villa.location).toBe("Sabah . B . 1");
    expect(all.summary.villaCount).toBe(3);
    expect(all.summary.variationOrdersMinor).toBe(6_000_000);
    expect(all.summary.totalBudgetMinor).toBe(106_000_000);

    const byRemaining = await service.list({ page: 1, limit: 20, sort: "remaining:desc" } as never);
    // V-1 has a remainder; the others have no total budget and go last.
    expect(byRemaining.items[0]!.villa.villaNumber).toBe("V-1");

    const found = await service.list({ page: 1, limit: 20, search: "v-2" } as never);
    expect(found.items.map((item) => item.villa.villaNumber)).toEqual(["V-2"]);
  });

  it("refuses a negative figure in the database itself, and goes with its villa", async () => {
    await expect(
      q(`UPDATE "VillaFinance" SET "salariesMinor" = -1 WHERE "villaId" = 'v1'`),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await q(`DELETE FROM "Villa" WHERE "id" = 'v2'`);
    const left = await q(`SELECT count(*)::int AS n FROM "VillaFinance" WHERE "villaId" = 'v2'`);
    expect(left.rows[0].n).toBe(0);
  });

  it("works out a villa's salaries as its share of the Department Overhead salaries, and keeps up with them", async () => {
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES ('v4','V-4','B','4','eng','admin','area',now())`,
    );
    await q(
      `INSERT INTO "OverheadEmployee" ("id","name","role","salaryMinor","updatedAt") VALUES
       ('e1','Ahmad','ENGINEER',700000,now()), ('e2','Bader','DRIVER',300000,now())`,
    );
    const before = await service.get("v1", ctx);
    const saved = await shareOf("v1", 2500);
    expect(saved).toMatchObject({
      salaryShareBp: 2500,
      overheadSalariesMinor: 1_000_000,
      salariesMinor: 250_000,
    });
    expect(saved.totalCostsMinor).toBe(before.totalCostsMinor + 250_000);

    // A salary changes in the Department Overhead: the villa's salaries follow.
    await q(`UPDATE "OverheadEmployee" SET "salaryMinor" = 500000 WHERE "id" = 'e2'`);
    expect((await service.get("v1", ctx)).salariesMinor).toBe(300_000);
    // A share that does not divide evenly is rounded to the fils.
    expect((await shareOf("v4", 3333)).salariesMinor).toBe(399_960);
  });

  it("refuses shares that would take all villas over 100%, and tells how much is left", async () => {
    // 25% + 33.33% given: 41.67% left.
    await expect(shareOf("v3", 4168)).rejects.toMatchObject({
      code: "SALARY_SHARE_OVER_LIMIT",
      statusCode: 422,
      message: expect.stringContaining("41.67%"),
    });
    expect((await shareOf("v3", 4167)).salaryShareBp).toBe(4167);
    // Giving less is always allowed; then the freed share can go elsewhere.
    await shareOf("v1", 2000);
    expect((await shareOf("v3", 4667)).salaryShareBp).toBe(4667);
    expect((await shareOf("v3", null)).salaryShareBp).toBeNull();

    const list = await service.list({ page: 1, limit: 20 } as never);
    expect(list.summary).toMatchObject({ overheadSalariesMinor: 1_200_000, allocatedShareBp: 2000 + 3333 });
  });

  it("two villas taking the last share at once: only one gets it", async () => {
    // 53.33% given, 46.67% left: two saves of 40% each cannot both pass.
    const results = await Promise.allSettled([shareOf("v1", 6000), shareOf("v3", 4000)]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "SALARY_SHARE_OVER_LIMIT" });
    const total = await q(`SELECT sum("salaryShareBp")::int AS n FROM "VillaFinance"`);
    expect(total.rows[0].n).toBeLessThanOrEqual(10_000);
  });

  it("the database refuses a share over 100% on its own", async () => {
    await expect(
      q(`UPDATE "VillaFinance" SET "salaryShareBp" = 10001 WHERE "villaId" = 'v1'`),
    ).rejects.toThrow();
  });
});
