import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The additional expenses of the Department Overhead on a real PostgreSQL (scratch schema): adding them for a villa,
// the list with its filters and totals, versions, the database checks, the invoice files (PDF and photos, with an
// in-memory storage), the villa budget's new cost line, and a villa with expenses kept.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { StorageService } from "../../src/core/storage/StorageService.js";
import { OverheadExpensesRepository } from "../../src/modules/overhead-expenses/repository/overhead-expenses.repository.js";
import { OverheadExpensesService } from "../../src/modules/overhead-expenses/service/overhead-expenses.service.js";
import { VillaFinanceService } from "../../src/modules/villa-finance/service/villa-finance.service.js";

const NOW = new Date("2026-11-15T09:00:00.000Z");
const actor = { id: "admin", role: "ADMIN" } as never;
const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 20, ...extra }) as never;

const PDF = Buffer.from("%PDF-1.7\n%test\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const TEXT = Buffer.from("hello, not an invoice");

function memoryStorage() {
  const temp = new Map<string, Buffer>();
  const stored = new Map<string, Buffer>();
  const storage = {
    tempDir: async () => "/tmp",
    inspectTemp: async (path: string, headBytes: number) => {
      const data = temp.get(path)!;
      return { size: data.length, head: data.subarray(0, headBytes) };
    },
    moveIn: async (path: string, key: string) => {
      stored.set(key, temp.get(path)!);
      temp.delete(path);
    },
    discardTemp: async (path: string) => void temp.delete(path),
    delete: async (key: string) => void stored.delete(key),
    size: async (key: string) => stored.get(key)!.length,
    createReadStream: (key: string) => Readable.from(stored.get(key)!),
  } as unknown as StorageService;
  return { storage, temp, stored };
}

describe.skipIf(!RUN)("additional expenses on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const memory = memoryStorage();
  const service = new OverheadExpensesService(new OverheadExpensesRepository(), () => NOW, memory.storage);
  const finance = new VillaFinanceService();

  beforeAll(async () => {
    scratch = await openScratch("scratchexpenses", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','a@x.test','x','ADMIN',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","budgetMinor","currency","updatedAt") VALUES
       ('11111111-1111-4111-8111-111111111111','V-1','B','1','eng','admin','area',10000000,'KWD',now()),
       ('22222222-2222-4222-8222-222222222222','V-2','B','2','eng','admin','area',NULL,NULL,now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  const V1 = "11111111-1111-4111-8111-111111111111";
  const V2 = "22222222-2222-4222-8222-222222222222";

  it("adds expenses for a villa and lists them, newest first, with the totals over the filters", async () => {
    const invoice = await service.create(
      actor,
      {
        villaId: V1,
        type: "INVOICE",
        description: "Cable trays",
        amountMinor: 1_250_500,
        expenseDate: day("2026-11-10"),
        invoiceNumber: "INV-77",
      },
      ctx,
    );
    expect(invoice).toMatchObject({
      villa: { id: V1, villaNumber: "V-1" },
      type: "INVOICE",
      amountMinor: 1_250_500,
      expenseDate: "2026-11-10",
      invoiceNumber: "INV-77",
      files: [],
      version: 1,
    });
    await service.create(
      actor,
      {
        villaId: V1,
        type: "TRANSPORT",
        description: "Truck hire",
        amountMinor: 80_000,
        expenseDate: day("2026-11-12"),
      },
      ctx,
    );
    await service.create(
      actor,
      {
        villaId: V2,
        type: "PURCHASE",
        description: "Breakers",
        amountMinor: 300_000,
        expenseDate: day("2026-11-01"),
      },
      ctx,
    );

    const all = await service.list(query());
    expect(all.items.map((item) => item.description)).toEqual(["Truck hire", "Cable trays", "Breakers"]);
    expect(all.totals).toEqual({ count: 3, amountMinor: 1_630_500 });
    expect(all.items[0]!.invoiceNumber).toBeNull();

    expect((await service.list(query({ villaId: V1 }))).totals).toEqual({ count: 2, amountMinor: 1_330_500 });
    expect((await service.list(query({ type: "PURCHASE" }))).items.map((item) => item.description)).toEqual([
      "Breakers",
    ]);
    // Search looks in the description, the invoice number and the villa number.
    expect((await service.list(query({ search: "inv-7" }))).items).toHaveLength(1);
    expect((await service.list(query({ search: "v-2" }))).items).toHaveLength(1);
    expect(
      (await service.list(query({ sort: "amount:desc" }))).items.map((item) => item.amountMinor),
    ).toEqual([1_250_500, 300_000, 80_000]);
  });

  it("adds a villa's expenses to its budget as a cost", async () => {
    const figures = await finance.get(V1, ctx);
    expect(figures).toMatchObject({
      expensesMinor: 1_330_500,
      totalCostsMinor: 1_330_500,
      remainingMinor: 8_669_500,
    });
    const list = await finance.list(query());
    expect(list.items.find((item) => item.villaId === V2)?.expensesMinor).toBe(300_000);
  });

  it("refuses an unknown villa, changes with versions, and can move an expense to another villa", async () => {
    await expect(
      service.create(
        actor,
        {
          villaId: "33333333-3333-4333-8333-333333333333",
          type: "OTHER",
          description: "X",
          amountMinor: 1,
          expenseDate: day("2026-11-01"),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });

    const [truck] = (await service.list(query({ search: "Truck" }))).items;
    const moved = await service.update(actor, truck!.id, { villaId: V2, invoiceNumber: "T-1" }, ctx, 1);
    expect(moved).toMatchObject({ villa: { villaNumber: "V-2" }, invoiceNumber: "T-1", version: 2 });
    await expect(service.update(actor, truck!.id, { amountMinor: 5 }, ctx, 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    // An empty invoice number is none.
    expect(
      (await service.update(actor, truck!.id, { invoiceNumber: null }, ctx, 2)).invoiceNumber,
    ).toBeNull();
    expect((await finance.get(V2, ctx)).expensesMinor).toBe(380_000);

    const audit = await q(
      `SELECT "action" FROM "AuditLog" WHERE "entity" = 'OverheadExpense' AND "entityId" = $1 ORDER BY "createdAt"`,
      [truck!.id],
    );
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual([
      "overhead_expense.create",
      "overhead_expense.update",
      "overhead_expense.update",
    ]);
  });

  it("keeps PDF and photo invoices, refuses other files, and removes them with the expense", async () => {
    const [cable] = (await service.list(query({ search: "Cable" }))).items;
    memory.temp.set("t1", PDF);
    memory.temp.set("t2", PNG);
    memory.temp.set("t3", JPEG);
    const withFiles = await service.uploadFiles(
      actor,
      cable!.id,
      [
        { tempPath: "t1", originalName: "invoice.pdf" },
        { tempPath: "t2", originalName: "receipt" },
        { tempPath: "t3", originalName: "photo.jpeg" },
      ],
      ctx,
    );
    expect(withFiles.files.map((file) => [file.name, file.mime]).sort()).toEqual([
      ["invoice.pdf", "application/pdf"],
      ["photo.jpg", "image/jpeg"],
      ["receipt.png", "image/png"],
    ]);
    expect(memory.stored.size).toBe(3);

    // Anything else is refused, and nothing of that upload is kept.
    memory.temp.set("t4", TEXT);
    await expect(
      service.uploadFiles(actor, cable!.id, [{ tempPath: "t4", originalName: "notes.pdf" }], ctx),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
    expect(memory.stored.size).toBe(3);
    expect(memory.temp.size).toBe(0);

    // Over 10 in all is refused.
    const many = Array.from({ length: 8 }, (_, i) => {
      memory.temp.set(`m${i}`, PDF);
      return { tempPath: `m${i}`, originalName: `m${i}.pdf` };
    });
    await expect(service.uploadFiles(actor, cable!.id, many, ctx)).rejects.toMatchObject({
      code: "OVERHEAD_EXPENSE_FILE_LIMIT",
    });

    const one = withFiles.files[0]!;
    expect(await service.file(cable!.id, one.id, ctx)).toMatchObject({ name: one.name });
    const after = await service.removeFile(actor, cable!.id, one.id, ctx);
    expect(after.files).toHaveLength(2);
    expect(memory.stored.size).toBe(2);
    await expect(service.file(cable!.id, one.id, ctx)).rejects.toMatchObject({
      code: "OVERHEAD_EXPENSE_FILE_NOT_FOUND",
    });

    await service.remove(actor, cable!.id, ctx, after.version);
    expect(memory.stored.size).toBe(0);
    await expect(service.get(cable!.id, ctx)).rejects.toMatchObject({ code: "OVERHEAD_EXPENSE_NOT_FOUND" });
    expect((await finance.get(V1, ctx)).expensesMinor).toBe(0);
  });

  it("keeps a villa that has expenses, and the database checks the amount and the type on its own", async () => {
    await expect(q(`DELETE FROM "Villa" WHERE "id" = $1`, [V2])).rejects.toThrow();
    await expect(
      q(
        `INSERT INTO "OverheadExpense" ("id","villaId","type","description","amountMinor","expenseDate","updatedAt") VALUES ('x',$1,'OTHER','N',-1,'2026-11-01',now())`,
        [V1],
      ),
    ).rejects.toThrow();
    await expect(
      q(
        `INSERT INTO "OverheadExpense" ("id","villaId","type","description","amountMinor","expenseDate","updatedAt") VALUES ('y',$1,'FOOD','N',1,'2026-11-01',now())`,
        [V1],
      ),
    ).rejects.toThrow();
  });
});
