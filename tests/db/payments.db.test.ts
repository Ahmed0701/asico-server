import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTRICT_CODES } from "./connection.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The payments to contractors on a real PostgreSQL, in a scratch schema made for this run and dropped after it: the
// rules of the paid date, the totals and the overdue filter, the database checks, the daily overdue reminder, the
// dashboard counters, and the Excel import and export.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { DashboardRepository } from "../../src/modules/dashboard/repository/dashboard.repository.js";
import { SmallWorksAlertsRepository } from "../../src/modules/notifications/repository/small-works-alerts.repository.js";
import { SmallWorksAlertsService } from "../../src/modules/notifications/service/small-works-alerts.service.js";
import { PaymentsRepository } from "../../src/modules/payments/repository/payments.repository.js";
import { PaymentsTransferService } from "../../src/modules/payments/service/payments-transfer.service.js";
import { PaymentsService } from "../../src/modules/payments/service/payments.service.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

// 09:00 UTC is 12:00 in Kuwait: the same day, 2026-11-15.
const NOW = new Date("2026-11-15T09:00:00.000Z");
const KUWAIT = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const actor = { id: "admin", role: "ADMIN" } as never;
const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!RUN)("payments on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = () => new PaymentsService(new PaymentsRepository(), () => NOW);

  beforeAll(async () => {
    scratch = await openScratch("scratchpay", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','a@x.test','x','ADMIN',true,now()),
       ('reader','Reader','r@x.test','x','EMPLOYEE',true,now()),
       ('other','Other','o@x.test','x','EMPLOYEE',true,now())`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") SELECT 'reader', "id" FROM "Permission" WHERE "code" = 'payments:read'`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah Al Ahmad','Kuwait',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
       ('c1','Nile Builders','0100','ACTIVE',now()), ('c2','Gulf Electric','0101','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
       ('v1','V-1','B1','1','eng','admin','area',now()), ('v2','V-2','B1','2','eng','admin','area',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  beforeEach(async () => {
    await q(`DELETE FROM "Notification"`);
    await q(`DELETE FROM "ContractorPayment"`);
  });

  // Three payments: one pending and overdue, one pending and not due yet, one paid this month.
  async function seed(): Promise<{ late: string; soon: string; paid: string }> {
    const late = await service().create(
      actor,
      {
        contractorId: "c1",
        villaId: "v1",
        amountMinor: 1_000_000,
        dueDate: day("2026-11-10"),
        reference: "CHQ-1",
      },
      ctx,
    );
    const soon = await service().create(
      actor,
      { contractorId: "c1", villaId: null, amountMinor: 500_000, dueDate: day("2026-11-20") },
      ctx,
    );
    const paid = await service().create(
      actor,
      {
        contractorId: "c2",
        villaId: "v2",
        amountMinor: 750_250,
        status: "PAID",
        paidDate: day("2026-11-12"),
        method: "CHEQUE",
      },
      ctx,
    );
    return { late: late.id, soon: soon.id, paid: paid.id };
  }

  it("keeps the paid date with the status: today for PAID without one, none for PENDING", async () => {
    const paid = await service().create(actor, { contractorId: "c1", amountMinor: 100, status: "PAID" }, ctx);
    const pending = await service().create(
      actor,
      { contractorId: "c1", amountMinor: 100, paidDate: day("2026-11-01") },
      ctx,
    );

    expect(paid).toMatchObject({
      status: "PAID",
      paidDate: "2026-11-15",
      villa: null,
      contractor: { name: "Nile Builders" },
    });
    expect(pending).toMatchObject({ status: "PENDING", paidDate: null });

    const back = await service().update(actor, paid.id, { status: "PENDING" }, ctx);
    const again = await service().update(
      actor,
      back.id,
      { status: "PAID", paidDate: day("2026-11-03") },
      ctx,
    );
    expect(back.paidDate).toBeNull();
    expect(again.paidDate).toBe("2026-11-03");
    const actions = await q(
      `SELECT "action" FROM "AuditLog" WHERE "entityId" = $1 ORDER BY "createdAt", "id"`,
      [paid.id],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "payment.create",
      "payment.paid_undo",
      "payment.paid",
    ]);
  });

  it("adds up the totals of the filters, marks the overdue ones, and filters them", async () => {
    const { late } = await seed();

    const all = await service().list({ page: 1, limit: 20 } as never);
    const overdue = await service().list({ page: 1, limit: 20, overdue: true } as never);
    const forC1 = await service().list({ page: 1, limit: 20, contractorId: "c1" } as never);

    expect(all.totals).toEqual({ pendingMinor: 1_500_000, overdueMinor: 1_000_000, paidMinor: 750_250 });
    expect(overdue.items.map((item) => item.id)).toEqual([late]);
    expect(overdue.items[0]).toMatchObject({
      overdue: true,
      villa: { villaNumber: "V-1", location: "Sabah Al Ahmad . B1 . 1" },
    });
    expect(forC1.totals).toEqual({ pendingMinor: 1_500_000, overdueMinor: 1_000_000, paidMinor: 0 });
    const searched = await service().list({ page: 1, limit: 20, search: "gulf" } as never);
    expect(searched.items.map((item) => item.contractor.name)).toEqual(["Gulf Electric"]);
    const byAmount = await service().list({ page: 1, limit: 20, sort: "amount:desc" } as never);
    expect(byAmount.items.map((item) => item.amountMinor)).toEqual([1_000_000, 750_250, 500_000]);
  });

  it("refuses a negative amount and a PAID payment without a paid date in the database itself", async () => {
    await expect(
      q(
        `INSERT INTO "ContractorPayment" ("id","contractorId","amountMinor","updatedAt") VALUES ('neg','c1',-1,now())`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      q(
        `INSERT INTO "ContractorPayment" ("id","contractorId","amountMinor","status","updatedAt") VALUES ('nodate','c1',1,'PAID',now())`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps a contractor and a villa that have payments from being deleted", async () => {
    await seed();

    await expect(q(`DELETE FROM "Contractor" WHERE "id" = 'c2'`)).rejects.toSatisfy(
      (err: { code?: string }) => RESTRICT_CODES.includes(err.code ?? ""),
    );
    await expect(q(`DELETE FROM "Villa" WHERE "id" = 'v2'`)).rejects.toSatisfy((err: { code?: string }) =>
      RESTRICT_CODES.includes(err.code ?? ""),
    );
  });

  it("reminds each pending payment past its due date once a day, to the admins and who may read payments", async () => {
    const { late, paid } = await seed();
    const alerts = (at: Date) =>
      new SmallWorksAlertsService(
        new SmallWorksAlertsRepository(),
        () => at,
        KUWAIT,
        () => ({ send: async () => {} }),
      );

    const first = await alerts(NOW).run();
    const again = await alerts(NOW).run();
    const nextDay = await alerts(new Date("2026-11-16T09:00:00.000Z")).run();

    expect(first.raised.paymentsOverdue).toBe(1);
    expect(again.raised.paymentsOverdue).toBe(0);
    expect(nextDay.raised.paymentsOverdue).toBe(1);
    const rows = await q(
      `SELECT "paymentId", "endDate"::text AS "endDate", "data" FROM "Notification" WHERE "kind" = 'PAYMENT_OVERDUE' ORDER BY "endDate"`,
    );
    expect(rows.rows.map((row) => [row.paymentId, row.endDate])).toEqual([
      [late, "2026-11-15"],
      [late, "2026-11-16"],
    ]);
    expect(rows.rows[0].data).toMatchObject({
      villaNumber: "V-1",
      contractorName: "Nile Builders",
      description: "1000.000 KWD (CHQ-1)",
      endDate: "2026-11-10",
    });
    const copies = await q(`SELECT DISTINCT "userId" FROM "NotificationRecipient" ORDER BY "userId"`);
    expect(copies.rows.map((row) => row.userId)).toEqual(["admin", "reader"]);

    // Marked paid: no more reminders; deleted: its reminders go with it.
    await service().update(actor, late, { status: "PAID" }, ctx);
    expect((await alerts(new Date("2026-11-17T09:00:00.000Z")).run()).raised.paymentsOverdue).toBe(0);
    await service().remove(actor, late, ctx);
    const left = await q(`SELECT count(*)::int AS n FROM "Notification" WHERE "kind" = 'PAYMENT_OVERDUE'`);
    expect(left.rows[0].n).toBe(0);
    expect(paid).toBeTruthy();
  });

  it("counts the dashboard figures: pending, overdue, and paid this month", async () => {
    await seed();
    // Paid last month: not counted in this month's figure.
    await service().create(
      actor,
      { contractorId: "c2", amountMinor: 9_999, status: "PAID", paidDate: day("2026-10-31") },
      ctx,
    );

    const counters = await new DashboardRepository().paymentCounters("2026-11-15");

    expect(Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, Number(value)]))).toEqual({
      pendingCount: 2,
      pendingMinor: 1_500_000,
      overdueCount: 1,
      overdueMinor: 1_000_000,
      paidThisMonthMinor: 750_250,
    });
  });

  it("imports a workbook in one transaction, and exports the list with its totals", async () => {
    const file = await workbookOf([
      [
        "Contractor",
        "Villa Number",
        "Amount (KWD)",
        "Status",
        "Due Date",
        "Paid Date",
        "Method",
        "Reference",
        "Notes",
      ],
      ["Nile Builders", "V-1", 1250.5, "Pending", "2026-12-01", "", "Cheque", "CHQ-9", "Second installment"],
      ["gulf electric", "", 300, "Paid", "", "2026-11-14", "Bank transfer", "", ""],
    ]);

    const outcome = await new PaymentsTransferService().importFile(
      actor,
      { name: "payments.xlsx", bytes: file },
      false,
      ctx,
    );

    expect(outcome.status).toBe(201);
    const rows = await q(
      `SELECT c."name", p."amountMinor"::text AS "amount", p."status", p."paidDate"::text AS "paidDate", p."method", p."villaId"
       FROM "ContractorPayment" p JOIN "Contractor" c ON c."id" = p."contractorId" ORDER BY c."name"`,
    );
    expect(rows.rows).toEqual([
      {
        name: "Gulf Electric",
        amount: "300000",
        status: "PAID",
        paidDate: "2026-11-14",
        method: "BANK_TRANSFER",
        villaId: null,
      },
      {
        name: "Nile Builders",
        amount: "1250500",
        status: "PENDING",
        paidDate: null,
        method: "CHEQUE",
        villaId: "v1",
      },
    ]);

    const bad = await workbookOf([
      [
        "Contractor",
        "Villa Number",
        "Amount (KWD)",
        "Status",
        "Due Date",
        "Paid Date",
        "Method",
        "Reference",
        "Notes",
      ],
      ["Nobody", "V-404", -1, "Maybe", "", "", "", "", ""],
    ]);
    const refused = await new PaymentsTransferService().importFile(
      actor,
      { name: "bad.xlsx", bytes: bad },
      false,
      ctx,
    );
    // Not a dry run: a row with a problem saves nothing at all.
    expect(refused.status).toBe(422);
    expect(refused.report.errors.map((issue) => issue.column).sort()).toEqual(
      ["Amount (KWD)", "Contractor", "Status", "Villa Number"].sort(),
    );

    const exported = await new PaymentsTransferService().exportPayments(
      "xlsx",
      { page: 1, limit: 20 } as never,
      actor,
      ctx,
    );
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    await exported.write(out);
    expect(exported.filename).toMatch(/^elecico-payments-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(Buffer.concat(chunks).subarray(0, 2).toString()).toBe("PK");
    const audited = await q(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'export.payments'`);
    expect(audited.rows[0].n).toBe(1);
  });
});
