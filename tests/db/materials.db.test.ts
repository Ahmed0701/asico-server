import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RESTRICT_CODES } from "./connection.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The materials queries and rules on a real PostgreSQL, in a scratch schema made for this run and dropped after it.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { BalanceRepository } from "../../src/modules/materials/repository/balance.repository.js";
import { DeliveriesRepository } from "../../src/modules/materials/repository/deliveries.repository.js";
import { FactoriesRepository } from "../../src/modules/materials/repository/factories.repository.js";
import { ItemsRepository } from "../../src/modules/materials/repository/items.repository.js";
import { MaterialsTransferService } from "../../src/modules/materials/service/materials-transfer.service.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

describe.skipIf(!RUN)("materials on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const item = async (name: string): Promise<string> =>
    (await q(`SELECT "id" FROM "MaterialItem" WHERE "name" = $1`, [name])).rows[0].id as string;
  const sort = { field: "deliveryDate" as const, direction: "desc" as const };

  beforeAll(async () => {
    scratch = await openScratch("scratchmat", 2);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Root','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah Al Ahmad','Kuwait',now())`,
    );
    for (const villa of ["v1", "v2"]) {
      await q(
        `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
         VALUES ($1,$1,'B1',$1,'eng','admin','area',now())`,
        [villa],
      );
    }
    await q(
      `INSERT INTO "Factory" ("id","name","type","updatedAt") VALUES
       ('sw','Gulf Switchgear','SWITCHGEAR',now()),('cb','Kuwait Cables','CABLE',now())`,
    );
    // The catalog starts empty: materials are added by hand.
    const empty = await q(`SELECT count(*)::int AS n FROM "MaterialItem"`);
    expect(empty.rows[0].n).toBe(0);
    const items = new ItemsRepository();
    // A material added without a quantity is needed once per villa.
    const added = await items.create({ name: "MSB Box", type: "SWITCHGEAR", unit: "pcs" });
    expect(added.requiredPerVilla).toBe(1);
    await items.create({ name: "DB Interior", type: "SWITCHGEAR", unit: "pcs", requiredPerVilla: 3 });
    await items.create({ name: "Cut-out Box", type: "SWITCHGEAR", unit: "pcs", requiredPerVilla: 0 });
    // Every villa needs 1 MSB Box and 3 DB Interiors; v1 needs 4 DB Interiors.
    await q(`INSERT INTO "VillaMaterialRequirement" ("villaId","itemId","quantity") VALUES ('v1',$1,4)`, [
      await item("DB Interior"),
    ]);
    const repo = new DeliveriesRepository();
    await repo.create({
      villaId: "v1",
      factoryId: "sw",
      noteNumber: "DN-1",
      deliveryDate: new Date("2026-10-20"),
      lines: [
        { itemId: await item("MSB Box"), quantity: 1 },
        { itemId: await item("DB Interior"), quantity: 1.5 },
      ],
    });
    await repo.create({
      villaId: "v2",
      factoryId: "sw",
      noteNumber: "DN-2",
      deliveryDate: new Date("2026-10-21"),
      lines: [{ itemId: await item("DB Interior"), quantity: 2 }],
    });
  }, 120_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("lists the catalog by type, then in the order the materials were added", async () => {
    const items = await new ItemsRepository().list("SWITCHGEAR");

    expect(items.map((i) => [i.name, i.unit, i.sortOrder])).toEqual([
      ["MSB Box", "pcs", 10],
      ["DB Interior", "pcs", 20],
      ["Cut-out Box", "pcs", 30],
    ]);
  });

  it("stores the lines with exact decimals and returns them in catalog order", async () => {
    const { rows } = await new DeliveriesRepository().list({ villaId: "v1", sort, skip: 0, take: 10 });

    expect(rows[0]?.lines.map((l) => [l.item.name, l.quantity])).toEqual([
      ["MSB Box", 1],
      ["DB Interior", 1.5],
    ]);
  });

  it("finds deliveries by a material and by its name in the search", async () => {
    const repo = new DeliveriesRepository();

    const byItem = await repo.list({ itemId: await item("MSB Box"), sort, skip: 0, take: 10 });
    const bySearch = await repo.list({ search: "interior", sort, skip: 0, take: 10 });

    expect(byItem.rows.map((r) => r.noteNumber)).toEqual(["DN-1"]);
    expect(bySearch.rows.map((r) => r.noteNumber)).toEqual(["DN-2", "DN-1"]);
  });

  it("works out the balance of every villa: the villa's own quantity first, else the catalog's", async () => {
    const { rows, total, totals } = await new BalanceRepository().list({
      status: "PENDING",
      skip: 0,
      take: 50,
    });

    expect(rows.map((r) => [r.villaNumber, r.name, r.required, r.delivered, r.custom])).toEqual([
      ["v1", "DB Interior", 4, 1.5, true],
      ["v2", "MSB Box", 1, 0, false],
      ["v2", "DB Interior", 3, 2, false],
    ]);
    expect(total).toBe(3);
    expect(totals.map((t) => [t.name, t.balance, t.villas])).toEqual([
      ["MSB Box", 1, 1],
      ["DB Interior", 3.5, 2],
    ]);
  });

  it("sets and clears a villa's own quantity", async () => {
    const balance = new BalanceRepository();
    const msb = await item("MSB Box");

    await balance.setRequirements("v2", [{ itemId: msb, quantity: 2 }]);
    const set = (await balance.ofVilla("v2")).find((r) => r.itemId === msb);
    await balance.setRequirements("v2", [{ itemId: msb, quantity: null }]);
    const cleared = (await balance.ofVilla("v2")).find((r) => r.itemId === msb);

    expect([set?.required, set?.custom]).toEqual([2, true]);
    expect([cleared?.required, cleared?.custom]).toEqual([1, false]);
  });

  it("finds a factory or an item by name ignoring case, only within its type, reading % and _ literally", async () => {
    expect(await new FactoriesRepository().findByName("CABLE", "kuwait CABLES")).toEqual({ id: "cb" });
    expect(await new FactoriesRepository().findByName("SWITCHGEAR", "Kuwait Cables")).toBeNull();
    expect(await new ItemsRepository().findByName("SWITCHGEAR", "msb box")).not.toBeNull();
    expect(await new ItemsRepository().findByName("SWITCHGEAR", "MSB_Box")).toBeNull();
  });

  it("refuses a zero quantity, deleting an item that is on a delivery, and deleting a villa with deliveries", async () => {
    const msb = await item("MSB Box");
    const delivery = (await q(`SELECT "id" FROM "MaterialDelivery" WHERE "noteNumber" = 'DN-2'`)).rows[0].id;

    await expect(
      q(`INSERT INTO "MaterialDeliveryLine" ("id","deliveryId","itemId","quantity") VALUES ('z',$1,$2,0)`, [
        delivery,
        msb,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(q(`DELETE FROM "MaterialItem" WHERE "id" = $1`, [msb])).rejects.toSatisfy(
      (err: { code?: string }) => RESTRICT_CODES.includes(err.code ?? ""),
    );
    await expect(q(`DELETE FROM "Villa" WHERE "id" = 'v2'`)).rejects.toSatisfy((err: { code?: string }) =>
      RESTRICT_CODES.includes(err.code ?? ""),
    );
  });

  it("deletes a delivery's lines with it", async () => {
    const { rows } = await q(`SELECT "id","version" FROM "MaterialDelivery" WHERE "noteNumber" = 'DN-2'`);
    const id = rows[0].id as string;

    expect(await new DeliveriesRepository().delete(id, rows[0].version as number)).toBe(true);
    const left = await q(`SELECT count(*)::int AS n FROM "MaterialDeliveryLine" WHERE "deliveryId" = $1`, [
      id,
    ]);
    expect(left.rows[0].n).toBe(0);
  });

  it("imports a workbook: the rows of one delivery note become one delivery with its materials, in one transaction", async () => {
    const file = await workbookOf([
      ["Villa Number", "Factory", "Material", "Quantity", "Delivery Date", "Delivery Note No."],
      ["v1", "Gulf Switchgear", "MSB Box", 1, "2026-11-08", "DN-IMP"],
      ["v1", "gulf switchgear", "Cut-out Box", 2, "2026-11-08", "DN-IMP"],
    ]);
    const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;

    const outcome = await new MaterialsTransferService().importFile(
      { id: "admin", role: "ADMIN" } as never,
      { name: "materials.xlsx", bytes: file },
      false,
      ctx,
    );

    expect(outcome.status).toBe(201);
    const delivery = await q(`SELECT "id" FROM "MaterialDelivery" WHERE "noteNumber" = 'DN-IMP'`);
    expect(delivery.rows).toHaveLength(1);
    const lines = await q(
      `SELECT i."name", l."quantity"::text AS "quantity" FROM "MaterialDeliveryLine" l JOIN "MaterialItem" i ON i."id" = l."itemId"
       WHERE l."deliveryId" = $1 ORDER BY i."name"`,
      [delivery.rows[0].id],
    );
    expect(lines.rows).toEqual([
      { name: "Cut-out Box", quantity: "2.00" },
      { name: "MSB Box", quantity: "1.00" },
    ]);
  });
});
