import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

// The Monthly Payments on a real PostgreSQL (scratch schema): each villa's progress now (from open works created and
// edited through the service), when they last changed, its last payment, and what its contractor is owed now (the
// progress since that payment times the Work Order Value); paying it, paying again after more progress, and taking a
// payment back.

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
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 20, ...extra }) as never;

describe.skipIf(!RUN)("monthly payments on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = new MonthlyProgressService(new MonthlyProgressRepository());
  const works = new OpenWorksService(new OpenWorksRepository());
  let v2b: { id: string; version: number };

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
       ('${PH_A}','Pay A',801,40,'ACTIVE',now()), ('${PH_B}','Pay B',802,60,'ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt") VALUES
       ('v2','V-2','B1','2','eng','admin','area','c1',now()),
       ('v10','V-10','B1','10','eng','admin','area',NULL,now()),
       ('v3','V-3','B1','3','eng','admin','area',NULL,now()),
       ('v9','V-9','B1','9','eng','admin','area',NULL,now())`,
    );
    // Work Order Values: V-2 10,000 KWD, V-10 5,000 KWD; V-3 has none.
    await q(
      `INSERT INTO "VillaFinance" ("villaId","workOrderMinor","updatedAt") VALUES ('v2',10000000,now()), ('v10',5000000,now())`,
    );
    const create = (villaId: string, elecPhaseId: string, progress: number) =>
      works.create(
        admin,
        { villaId, elecPhaseId, progress, status: progress >= 100 ? "DONE" : "IN_PROGRESS" } as never,
        ctx,
      );
    // A phase counts once its open work is done. V-2: phase A done (40%), phase B not done yet. V-10: phase A done (40%).
    // V-3: phase B done (60%). V-9: nothing.
    await create("v2", PH_A, 100);
    v2b = await create("v2", PH_B, 0);
    await create("v10", PH_A, 100);
    await create("v3", PH_B, 100);
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("gives each villa its progress now, when it last changed, and what its contractor is owed", async () => {
    const result = await service.list(query());

    expect(
      result.items.map((item) => [
        item.villa.villaNumber,
        item.currentProgress,
        item.paidProgress,
        item.unpaidProgress,
        item.workOrderMinor,
        item.dueMinor,
      ]),
    ).toEqual([
      ["V-2", 40, 0, 40, 10_000_000, 4_000_000],
      ["V-3", 60, 0, 60, null, 0],
      ["V-9", 0, 0, 0, null, 0],
      ["V-10", 40, 0, 40, 5_000_000, 2_000_000],
    ]);
    expect(result.items[0]!.lastUpdatedAt).not.toBeNull();
    expect(result.items[0]!.lastPayment).toBeNull();
    expect(result.items[2]!.lastUpdatedAt).toBeNull();
    expect(result.summary).toEqual({
      villaCount: 4,
      owedCount: 3,
      totalDueMinor: 6_000_000,
      missingWorkOrderCount: 1,
      contractors: [
        { contractor: { id: "c1", name: "Nile Builders" }, villaCount: 1, dueMinor: 4_000_000 },
        { contractor: null, villaCount: 2, dueMinor: 2_000_000 },
      ],
    });

    const owed = await service.list(query({ owed: true }));
    expect(owed.items.map((item) => item.villa.villaNumber)).toEqual(["V-2", "V-3", "V-10"]);
    const nile = await service.list(query({ contractorId: "c1" }));
    expect(nile.items.map((item) => item.villa.villaNumber)).toEqual(["V-2"]);
    const byDue = await service.list(query({ owed: true, sort: "due:desc" }));
    expect(byDue.items.map((item) => item.dueMinor)).toEqual([4_000_000, 2_000_000, 0]);
  });

  it("pays what is owed, at the progress now, and then nothing is owed until it moves", async () => {
    const payment = await service.pay(admin, "v2", ctx);
    expect(payment).toMatchObject({
      ratio: 40,
      amountMinor: 4_000_000,
      workOrderMinor: 10_000_000,
      contractor: { id: "c1", name: "Nile Builders" },
      paidBy: { id: "admin", name: "Root" },
    });

    const [v2] = (await service.list(query({ search: "V-2" }))).items;
    expect(v2).toMatchObject({ paidProgress: 40, unpaidProgress: 0, dueMinor: 0 });
    expect(v2!.lastPayment).toMatchObject({ id: payment.id, ratio: 40, amountMinor: 4_000_000 });

    await expect(service.pay(admin, "v2", ctx)).rejects.toMatchObject({ code: "NOTHING_TO_PAY" });
    await expect(service.pay(admin, "v3", ctx)).rejects.toMatchObject({ code: "WORK_ORDER_MISSING" });
    await expect(service.pay(admin, "nope", ctx)).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
  });

  it("owes only the progress since the last payment, and takes back the latest payment only", async () => {
    // Phase B done: 40% + 60% = 100%, so 60% more since the payment at 40%.
    await works.update(admin, v2b.id, { progress: 100, status: "DONE" } as never, ctx, v2b.version);
    const [before] = (await service.list(query({ search: "V-2" }))).items;
    expect(before).toMatchObject({
      currentProgress: 100,
      paidProgress: 40,
      unpaidProgress: 60,
      dueMinor: 6_000_000,
    });

    const first = before!.lastPayment!;
    const second = await service.pay(admin, "v2", ctx);
    expect(second).toMatchObject({ ratio: 100, amountMinor: 6_000_000 });

    // The villa's history: the latest first, each from the ratio before it.
    const history = await service.villaHistory("v2", ctx);
    expect(history.items.map((item) => [item.id, item.fromRatio, item.ratio, item.amountMinor])).toEqual([
      [second.id, 40, 100, 6_000_000],
      [first.id, 0, 40, 4_000_000],
    ]);
    expect(history.summary).toEqual({
      count: 2,
      totalPaidMinor: 10_000_000,
      paidProgress: 100,
      currentProgress: 100,
      unpaidProgress: 0,
      workOrderMinor: 10_000_000,
      dueMinor: 0,
    });
    expect((await service.villaHistory("v3", ctx)).summary).toMatchObject({
      count: 0,
      totalPaidMinor: 0,
      paidProgress: 0,
      workOrderMinor: null,
      dueMinor: 0,
    });
    await expect(service.villaHistory("nope", ctx)).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });

    // The same history as a workbook: the latest payment first, the amounts in dinars.
    const file = await service.exportVillaHistory("v2", admin, ctx);
    expect(file.filename).toMatch(/^elecico-payment-history-V-2-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    await file.write(out);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.concat(chunks) as never);
    const sheet = book.getWorksheet("Payments")!;
    const values: unknown[][] = [];
    sheet.eachRow((row) => values.push((row.values as unknown[]).slice(1)));
    const header = values.findIndex((row) => row[0] === "Paid At (UTC)");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(values[header]).toEqual([
      "Paid At (UTC)",
      "Contractor",
      "From (%)",
      "To (%)",
      "Progress Covered (%)",
      "Amount (KWD)",
      "Work Order Value (KWD)",
      "Recorded By",
    ]);
    expect(values[header + 1]!.slice(2, 7)).toEqual([40, 100, 60, 6000, 10000]);
    expect(values[header + 2]!.slice(2, 7)).toEqual([0, 40, 40, 4000, 10000]);
    const exported = await q(`SELECT "entityId" FROM "AuditLog" WHERE "action" = 'export.progress-payments'`);
    expect(exported.rows).toEqual([{ entityId: "v2" }]);

    await expect(service.undo(admin, first.id, ctx)).rejects.toMatchObject({
      code: "PROGRESS_PAYMENT_NOT_LATEST",
    });
    await service.undo(admin, second.id, ctx);
    const [after] = (await service.list(query({ search: "V-2" }))).items;
    expect(after).toMatchObject({ paidProgress: 40, unpaidProgress: 60, dueMinor: 6_000_000 });
    await expect(service.undo(admin, second.id, ctx)).rejects.toMatchObject({
      code: "PROGRESS_PAYMENT_NOT_FOUND",
    });

    const audit = await q(
      `SELECT "action" FROM "AuditLog" WHERE "action" LIKE 'progress_payment.%' ORDER BY "createdAt"`,
    );
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual([
      "progress_payment.create",
      "progress_payment.create",
      "progress_payment.delete",
    ]);
  });

  it("enters payments made before the system, in date order, and removes them at any time", async () => {
    // V-10 (WO 5,000 KWD) has no payment yet: enter two older ones by hand.
    const first = await service.addManual(
      admin,
      "v10",
      {
        paidOn: new Date("2026-01-10T00:00:00.000Z"),
        ratio: 10,
        amountMinor: 500_000,
        note: "Receipt 17",
      } as never,
      ctx,
    );
    expect(first).toMatchObject({ ratio: 10, amountMinor: 500_000, manual: true, note: "Receipt 17" });
    expect(first.paidAt).toBe("2026-01-10T00:00:00.000Z");
    const third = await service.addManual(
      admin,
      "v10",
      { paidOn: new Date("2026-03-10T00:00:00.000Z"), ratio: 30, amountMinor: 1_000_000 } as never,
      ctx,
    );
    // Between them by date: more than 10%, less than 30%.
    await expect(
      service.addManual(
        admin,
        "v10",
        { paidOn: new Date("2026-02-10T00:00:00.000Z"), ratio: 35, amountMinor: 1 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PAID_RATIO_OUT_OF_ORDER", message: expect.stringMatching(/10%.*30%/) });
    await expect(
      service.addManual(
        admin,
        "v10",
        { paidOn: new Date("2026-04-10T00:00:00.000Z"), ratio: 30, amountMinor: 1 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PAID_RATIO_OUT_OF_ORDER" });
    await expect(
      service.addManual(
        admin,
        "v10",
        { paidOn: new Date("2999-01-01T00:00:00.000Z"), ratio: 90, amountMinor: 1 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "PAID_DATE_IN_FUTURE" });
    await expect(
      service.addManual(
        admin,
        "v3",
        { paidOn: new Date("2026-01-01T00:00:00.000Z"), ratio: 5, amountMinor: 1 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "WORK_ORDER_MISSING" });
    await expect(
      service.addManual(
        admin,
        "v10",
        {
          paidOn: new Date("2026-02-10T00:00:00.000Z"),
          ratio: 20,
          amountMinor: 1,
          contractorId: "00000000-0000-4000-8000-00000000dead",
        } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "CONTRACTOR_NOT_FOUND" });
    const second = await service.addManual(
      admin,
      "v10",
      {
        paidOn: new Date("2026-02-10T00:00:00.000Z"),
        ratio: 20,
        amountMinor: 500_000,
        contractorId: null,
      } as never,
      ctx,
    );
    expect(second.contractor).toBeNull();

    const history = await service.villaHistory("v10", ctx);
    expect(history.items.map((item) => [item.ratio, item.fromRatio])).toEqual([
      [30, 20],
      [20, 10],
      [10, 0],
    ]);
    expect(history.summary).toMatchObject({ paidProgress: 30, totalPaidMinor: 2_000_000 });

    // A manual payment is removed even when it is not the latest; the list then owes from the latest left.
    await service.undo(admin, second.id, ctx);
    await service.undo(admin, third.id, ctx);
    const [row] = (await service.list(query({ search: "V-10" }))).items;
    expect(row).toMatchObject({ paidProgress: 10 });
    await service.undo(admin, first.id, ctx);
  });

  it("imports payments made before the system from Excel, checking the order against the stored payments", async () => {
    const HEADER = ["Villa Number", "Paid On", "Paid Up To (%)", "Amount (KWD)", "Contractor", "Note"];
    const good = [
      ["V-10", "2025-01-10", 10, 500, null, "R1"],
      ["V-10", "2025-02-10", 20, "500.000", null, null],
    ];
    const bad = [
      ...good,
      // V-2 already has a payment at 40%: an older one must be less.
      ["V-2", "2020-01-01", 50, 100, null, null],
      ["V-3", "2025-01-01", 5, 10, null, null],
      ["V-10", "2999-01-01", 90, 10, null, null],
      ["V-99", "2025-01-01", 5, 10, null, null],
    ];
    const checked = await service.importPrevious(
      admin,
      { name: "a.xlsx", bytes: await workbookOf([HEADER, ...bad] as never[][], { sheetName: "A" }) },
      true,
      ctx,
    );
    expect(checked.status).toBe(200);
    expect(checked.report.ok).toBe(false);
    const errors = checked.report.errors.map((error) => [error.row, error.column]);
    expect(errors).toEqual(
      expect.arrayContaining([
        [4, "Paid Up To (%)"],
        [5, "Villa Number"],
        [6, "Paid On"],
        [7, "Villa Number"],
      ]),
    );
    expect(errors.filter(([row]) => row === 2 || row === 3)).toEqual([]);

    const saved = await service.importPrevious(
      admin,
      { name: "b.xlsx", bytes: await workbookOf([HEADER, ...good] as never[][], { sheetName: "B" }) },
      false,
      ctx,
    );
    expect(saved.status).toBe(201);
    expect(saved.report.imported).toBe(2);
    const history = await service.villaHistory("v10", ctx);
    expect(
      history.items.map((item) => [item.ratio, item.fromRatio, item.amountMinor, item.manual, item.note]),
    ).toEqual([
      [20, 10, 500_000, true, null],
      [10, 0, 500_000, true, "R1"],
    ]);
    // The same rows again: they no longer fit after the ones just saved.
    const again = await service.importPrevious(
      admin,
      { name: "c.xlsx", bytes: await workbookOf([HEADER, ...good] as never[][], { sheetName: "C" }) },
      true,
      ctx,
    );
    expect(again.report.ok).toBe(false);
    for (const item of history.items) await service.undo(admin, item.id, ctx);
  });

  it("keeps a villa with payments, and the database checks the paid progress", async () => {
    await expect(q(`DELETE FROM "Villa" WHERE "id" = 'v2'`)).rejects.toThrow();
    await expect(
      q(
        `INSERT INTO "ProgressPayment" ("id","villaId","ratioTenths","amountMinor","workOrderMinor") VALUES ('x','v10',1001,0,0)`,
      ),
    ).rejects.toThrow();
  });
});
