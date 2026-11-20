import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The Material Orders tab on a real PostgreSQL (scratch schema): each villa twice (switchgear, cables) with its MR, PO
// and due dates, the dates on its delivery notes, and whether all, part or none of what it needs came; overdue once the
// due date has passed with materials still to come.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { MaterialOrdersRepository } from "../../src/modules/material-orders/repository/material-orders.repository.js";
import { MaterialOrdersService } from "../../src/modules/material-orders/service/material-orders.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const admin = { id: "admin", role: "ADMIN" } as never;
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 50, ...extra }) as never;
const day = (text: string) => new Date(`${text}T00:00:00.000Z`);

describe.skipIf(!RUN)("material orders on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  // Today is 1 December 2026 in Kuwait.
  const service = new MaterialOrdersService(
    new MaterialOrdersRepository(),
    () => new Date("2026-12-01T09:00:00.000Z"),
    { timeZone: "Asia/Kuwait" },
  );

  beforeAll(async () => {
    scratch = await openScratch("scratchmatorders", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root','a@x.test','x','ADMIN',true,now())`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Factory" ("id","name","type","updatedAt") VALUES
       ('sw','Gulf Switchgear','SWITCHGEAR',now()),('cb','Kuwait Cables','CABLE',now())`,
    );
    for (const villa of ["V-1", "V-2", "V-3"]) {
      await q(
        `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
         VALUES ($1,$1,'B1',$1,'eng','admin','area',now())`,
        [villa],
      );
    }
    await q(`UPDATE "Villa" SET "switchgearFactoryId" = 'sw' WHERE "id" = 'V-1'`);
    // Switchgear: MSB (1 each) and DB (2 each). Cables: none needed.
    await q(
      `INSERT INTO "MaterialItem" ("id","name","type","unit","requiredPerVilla","updatedAt") VALUES
       ('msb','MSB Box','SWITCHGEAR','pcs',1,now()), ('db','DB Interior','SWITCHGEAR','pcs',2,now())`,
    );
    // V-1: everything. V-2: the MSB only. V-3: nothing.
    await q(
      `INSERT INTO "MaterialDelivery" ("id","villaId","factoryId","deliveryDate","mrDate","poDate","updatedAt") VALUES
       ('d1','V-1','sw','2026-10-05','2026-09-01','2026-09-10',now()),
       ('d2','V-1','sw','2026-10-20','2026-09-15',NULL,now()),
       ('d3','V-2','sw','2026-10-07',NULL,NULL,now())`,
    );
    await q(
      `INSERT INTO "MaterialDeliveryLine" ("id","deliveryId","itemId","quantity") VALUES
       ('l1','d1','msb',1), ('l2','d2','db',2), ('l3','d3','msb',1)`,
    );
  });

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("gives each villa its switchgear and cables, with what came and the dates of its delivery notes", async () => {
    const result = await service.list(query({ type: "SWITCHGEAR" }));
    expect(
      result.items.map((row) => [row.villa.villaNumber, row.status, row.completeItems, row.requiredItems]),
    ).toEqual([
      ["V-1", "DELIVERED", 2, 2],
      ["V-2", "PARTIAL", 1, 2],
      ["V-3", "NOT_DELIVERED", 0, 2],
    ]);
    expect(result.items[0]).toMatchObject({
      factory: { id: "sw", name: "Gulf Switchgear" },
      deliveryMrDate: "2026-09-01",
      deliveryPoDate: "2026-09-10",
      lastDeliveryDate: "2026-10-20",
      mrDate: null,
      overdue: false,
    });
    const cables = await service.list(query({ type: "CABLE" }));
    expect(cables.items.every((row) => row.status === "NOT_REQUIRED")).toBe(true);
    expect((await service.list(query())).meta.total).toBe(6);
  });

  it("sets the dates, and is overdue once the due date passed with materials still to come", async () => {
    const row = await service.set(
      admin,
      "V-2",
      "SWITCHGEAR",
      { mrDate: day("2026-08-01"), poDate: day("2026-08-10"), dueDate: day("2026-11-30") },
      ctx,
    );
    expect(row).toMatchObject({
      mrDate: "2026-08-01",
      poDate: "2026-08-10",
      dueDate: "2026-11-30",
      overdue: true,
    });
    // Due today is not late yet; a villa with everything is never late.
    await service.set(
      admin,
      "V-3",
      "SWITCHGEAR",
      { mrDate: null, poDate: null, dueDate: day("2026-12-01") },
      ctx,
    );
    await service.set(
      admin,
      "V-1",
      "SWITCHGEAR",
      { mrDate: null, poDate: null, dueDate: day("2026-01-01") },
      ctx,
    );

    const overdue = await service.list(query({ overdue: true }));
    expect(overdue.items.map((item) => item.villa.villaNumber)).toEqual(["V-2"]);
    const summary = (await service.list(query({ type: "SWITCHGEAR" }))).summary;
    expect(summary).toEqual({ total: 3, delivered: 1, partial: 1, notDelivered: 1, overdue: 1 });
    const byDue = await service.list(query({ type: "SWITCHGEAR", sort: "dueDate:asc" }));
    expect(byDue.items.map((item) => item.villa.villaNumber)).toEqual(["V-1", "V-2", "V-3"]);

    // Cleared again.
    const cleared = await service.set(
      admin,
      "V-2",
      "SWITCHGEAR",
      { mrDate: null, poDate: null, dueDate: null },
      ctx,
    );
    expect(cleared).toMatchObject({ mrDate: null, dueDate: null, overdue: false });

    const audit = await q(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'material_order.update'`,
    );
    expect(audit.rows[0].n).toBe(4);
  });

  it("refuses a PO before the MR, and a villa that does not exist", async () => {
    await expect(
      service.set(
        admin,
        "V-1",
        "CABLE",
        { mrDate: day("2026-05-02"), poDate: day("2026-05-01"), dueDate: null },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "MATERIAL_ORDER_DATES_INVALID" });
    await expect(
      service.set(admin, "nope", "CABLE", { mrDate: null, poDate: null, dueDate: null }, ctx),
    ).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
  });

  it("goes with the villa", async () => {
    await service.set(admin, "V-3", "CABLE", { mrDate: day("2026-05-01"), poDate: null, dueDate: null }, ctx);
    await q(`DELETE FROM "VillaMaterialOrder" WHERE "villaId" = 'V-3' AND "type" = 'SWITCHGEAR'`);
    await q(`DELETE FROM "Villa" WHERE "id" = 'V-3'`);
    const left = await q(`SELECT count(*)::int AS n FROM "VillaMaterialOrder" WHERE "villaId" = 'V-3'`);
    expect(left.rows[0].n).toBe(0);
  });
});
