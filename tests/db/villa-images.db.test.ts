import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The site images of a villa on a real PostgreSQL (scratch schema), with an in-memory storage: JPEG and PNG photos kept in
// the villa's folder, anything else refused with nothing kept, the limit, removing one, and the rows going with the villa.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { StorageService } from "../../src/core/storage/StorageService.js";
import { MAX_IMAGES_PER_VILLA } from "../../src/modules/villa-images/dto/villa-images.dto.js";
import { VillaImagesRepository } from "../../src/modules/villa-images/repository/villa-images.repository.js";
import { VillaImagesService } from "../../src/modules/villa-images/service/villa-images.service.js";

const NOW = new Date("2026-11-19T09:00:00.000Z");
const actor = { id: "admin", role: "ADMIN" } as never;
const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const V1 = "b0000000-0000-4000-8000-000000000001";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n%test\n");

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

describe.skipIf(!RUN)("villa site images on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const memory = memoryStorage();
  const service = new VillaImagesService(new VillaImagesRepository(), () => NOW, memory.storage);

  beforeAll(async () => {
    scratch = await openScratch("scratchimages", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES ($1,'V-1','B','1','eng','admin','area',now())`,
      [V1],
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("keeps JPEG and PNG photos in the villa's folder, lists them, and audits the upload", async () => {
    expect(await service.list(V1, ctx)).toEqual([]);
    memory.temp.set("t1", JPEG);
    memory.temp.set("t2", PNG);
    const images = await service.upload(
      actor,
      V1,
      [
        { tempPath: "t1", originalName: "front.jpeg" },
        { tempPath: "t2", originalName: "roof" },
      ],
      ctx,
    );
    expect(images.map((image) => [image.name, image.mime]).sort()).toEqual([
      ["front.jpg", "image/jpeg"],
      ["roof.png", "image/png"],
    ]);
    expect(images[0]!.uploadedBy).toEqual({ id: "admin", name: "Root Admin" });
    expect([...memory.stored.keys()].every((key) => key.startsWith(`villas/${V1}/images/`))).toBe(true);
    expect(memory.temp.size).toBe(0);
    const audit = await q(`SELECT "entity","entityId" FROM "AuditLog" WHERE "action" = 'villa_image.upload'`);
    expect(audit.rows[0]).toEqual({ entity: "Villa", entityId: V1 });
  });

  it("refuses a PDF or any other file, and keeps nothing of that upload", async () => {
    memory.temp.set("t3", PNG);
    memory.temp.set("t4", PDF);
    await expect(
      service.upload(
        actor,
        V1,
        [
          { tempPath: "t3", originalName: "a.png" },
          { tempPath: "t4", originalName: "b.pdf" },
        ],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
    expect(memory.stored.size).toBe(2);
    expect(memory.temp.size).toBe(0);
    await expect(
      service.upload(actor, "b0000000-0000-4000-8000-000000000099", [], ctx),
    ).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
  });

  it("refuses going over the limit of a villa", async () => {
    await q(
      `INSERT INTO "VillaImage" ("id","villaId","key","name","mime","size")
       SELECT gen_random_uuid()::text, $1, 'k' || g, 'x.png', 'image/png', 1 FROM generate_series(1, $2::int) g`,
      [V1, MAX_IMAGES_PER_VILLA - 2],
    );
    memory.temp.set("t5", PNG);
    await expect(
      service.upload(actor, V1, [{ tempPath: "t5", originalName: "one-too-many.png" }], ctx),
    ).rejects.toMatchObject({ code: "VILLA_IMAGE_LIMIT" });
    await q(`DELETE FROM "VillaImage" WHERE "key" LIKE 'k%'`);
  });

  it("removes one image and its file, and the rest go with the villa", async () => {
    const [first] = await service.list(V1, ctx);
    const row = await service.file(first!.id, ctx);
    expect((await service.openFile(row.key, ctx)).size).toBeGreaterThan(0);
    await service.remove(actor, first!.id, ctx);
    expect(await service.list(V1, ctx)).toHaveLength(1);
    expect(memory.stored.size).toBe(1);
    await expect(service.remove(actor, first!.id, ctx)).rejects.toMatchObject({
      code: "VILLA_IMAGE_NOT_FOUND",
    });

    await q(`DELETE FROM "Villa" WHERE "id" = $1`, [V1]);
    const left = await q(`SELECT count(*)::int AS n FROM "VillaImage"`);
    expect(left.rows[0].n).toBe(0);
  });
});
