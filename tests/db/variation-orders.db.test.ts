import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTRICT_CODES } from "./connection.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The variation orders of a villa on a real PostgreSQL, in a scratch schema made for this run and dropped after it: the
// list and its totals, the VO number unique in the villa, the database checks, the villa kept while it has variation
// orders, and the PDF files (with an in-memory storage).

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { StorageService } from "../../src/core/storage/StorageService.js";
import { VariationOrdersRepository } from "../../src/modules/variation-orders/repository/variation-orders.repository.js";
import { VariationOrdersService } from "../../src/modules/variation-orders/service/variation-orders.service.js";

// 09:00 UTC is 12:00 in Kuwait: the same day, 2026-11-15.
const NOW = new Date("2026-11-15T09:00:00.000Z");
const actor = { id: "admin", role: "ADMIN" } as never;
const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const PDF = Buffer.from("%PDF-1.7\n%test\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// Temp files and stored files in memory.
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

describe.skipIf(!RUN)("variation orders on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  let memory = memoryStorage();
  const service = () =>
    new VariationOrdersService(new VariationOrdersRepository(), () => NOW, memory.storage);

  beforeAll(async () => {
    scratch = await openScratch("scratchvo", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','a@x.test','x','ADMIN',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah Al Ahmad','Kuwait',now())`,
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
    memory = memoryStorage();
    await q(`DELETE FROM "VariationOrder"`);
  });

  it("adds, lists newest first with the totals, edits, marks paid and deletes, with an audit entry each time", async () => {
    const first = await service().create(
      actor,
      "v1",
      { voNumber: "VO-1", amountMinor: 1_500_000, dateAdded: day("2026-11-01"), notes: "Extra sockets" },
      ctx,
    );
    // Without a date: today in Kuwait. Without a status: pending.
    const second = await service().create(actor, "v1", { voNumber: "VO-2", amountMinor: 250_500 }, ctx);
    expect(second).toMatchObject({ dateAdded: "2026-11-15", status: "PENDING", notes: null });

    const paid = await service().update(actor, first.id, { status: "PAID" }, ctx, first.version);
    expect(paid).toMatchObject({ status: "PAID", version: first.version + 1 });

    const list = await service().listByVilla("v1", ctx);
    expect(list.items.map((item) => item.voNumber)).toEqual(["VO-2", "VO-1"]);
    expect(list.totals).toEqual({ pendingMinor: 250_500, paidMinor: 1_500_000 });
    expect((await service().listByVilla("v2", ctx)).items).toEqual([]);

    await service().remove(actor, second.id, ctx, second.version);
    expect((await service().listByVilla("v1", ctx)).items).toHaveLength(1);

    const actions = await q(
      `SELECT "action" FROM "AuditLog" WHERE "entity" = 'VariationOrder' ORDER BY "createdAt", "id"`,
    );
    expect(actions.rows.map((row: { action: string }) => row.action)).toEqual([
      "variation_order.create",
      "variation_order.create",
      "variation_order.paid",
      "variation_order.delete",
    ]);
  });

  it("keeps the VO number unique in the villa (ignoring case), but not across villas", async () => {
    const one = await service().create(actor, "v1", { voNumber: "VO-7", amountMinor: 1 }, ctx);
    await expect(
      service().create(actor, "v1", { voNumber: "vo-7", amountMinor: 2 }, ctx),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "VARIATION_ORDER_NUMBER_TAKEN",
    });
    await expect(
      service().create(actor, "v2", { voNumber: "VO-7", amountMinor: 2 }, ctx),
    ).resolves.toMatchObject({
      voNumber: "VO-7",
    });
    const other = await service().create(actor, "v1", { voNumber: "VO-8", amountMinor: 3 }, ctx);
    await expect(service().update(actor, other.id, { voNumber: "VO-7" }, ctx)).rejects.toMatchObject({
      code: "VARIATION_ORDER_NUMBER_TAKEN",
    });
    // Its own number again is no clash.
    await expect(
      service().update(actor, one.id, { voNumber: "VO-7", notes: "same" }, ctx),
    ).resolves.toMatchObject({
      notes: "same",
    });
  });

  it("answers 404 for a missing villa, and a stale version with a conflict", async () => {
    await expect(service().listByVilla("nope", ctx)).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
    await expect(
      service().create(actor, "nope", { voNumber: "X", amountMinor: 1 }, ctx),
    ).rejects.toMatchObject({
      code: "VILLA_NOT_FOUND",
    });
    const vo = await service().create(actor, "v1", { voNumber: "VO-1", amountMinor: 1 }, ctx);
    await expect(
      service().update(actor, vo.id, { amountMinor: 2 }, ctx, vo.version + 5),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  it("refuses a negative amount and a duplicate number in the database itself, and keeps a villa with variation orders", async () => {
    await expect(
      q(
        `INSERT INTO "VariationOrder" ("id","villaId","voNumber","amountMinor","dateAdded","updatedAt") VALUES ('neg','v1','N',-1,'2026-11-15',now())`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await q(
      `INSERT INTO "VariationOrder" ("id","villaId","voNumber","amountMinor","dateAdded","updatedAt") VALUES ('a','v2','D',1,'2026-11-15',now())`,
    );
    await expect(
      q(
        `INSERT INTO "VariationOrder" ("id","villaId","voNumber","amountMinor","dateAdded","updatedAt") VALUES ('b','v2','D',1,'2026-11-15',now())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(q(`DELETE FROM "Villa" WHERE "id" = 'v2'`)).rejects.toSatisfy((err: { code?: string }) =>
      RESTRICT_CODES.includes(err.code ?? ""),
    );
  });

  it("keeps PDF files only, up to 10, and removes them with the variation order", async () => {
    const vo = await service().create(actor, "v1", { voNumber: "VO-1", amountMinor: 1 }, ctx);
    memory.temp.set("t1", PDF);
    memory.temp.set("t2", PDF);
    const withFiles = await service().uploadFiles(
      actor,
      vo.id,
      [
        { tempPath: "t1", originalName: "vo-1.pdf" },
        { tempPath: "t2", originalName: "drawing" },
      ],
      ctx,
    );
    expect(withFiles.files.map((file) => [file.name, file.mime]).sort()).toEqual([
      ["drawing.pdf", "application/pdf"],
      ["vo-1.pdf", "application/pdf"],
    ]);
    expect(memory.stored.size).toBe(2);
    expect(memory.temp.size).toBe(0);

    // A PNG is refused, and nothing of that upload is kept.
    memory.temp.set("t3", PNG);
    await expect(
      service().uploadFiles(actor, vo.id, [{ tempPath: "t3", originalName: "photo.png" }], ctx),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
    expect(memory.stored.size).toBe(2);
    expect(memory.temp.size).toBe(0);

    // Over 10 in all is refused.
    const many = Array.from({ length: 9 }, (_, i) => {
      memory.temp.set(`m${i}`, PDF);
      return { tempPath: `m${i}`, originalName: `m${i}.pdf` };
    });
    await expect(service().uploadFiles(actor, vo.id, many, ctx)).rejects.toMatchObject({
      code: "VARIATION_ORDER_FILE_LIMIT",
    });

    const one = withFiles.files[0]!;
    const after = await service().removeFile(actor, vo.id, one.id, ctx);
    expect(after.files).toHaveLength(1);
    expect(memory.stored.size).toBe(1);
    await expect(service().file(vo.id, one.id, ctx)).rejects.toMatchObject({
      code: "VARIATION_ORDER_FILE_NOT_FOUND",
    });

    await service().remove(actor, vo.id, ctx);
    expect(memory.stored.size).toBe(0);
    const rows = await q(`SELECT count(*)::int AS n FROM "VariationOrderFile"`);
    expect(rows.rows[0].n).toBe(0);
  });
});
