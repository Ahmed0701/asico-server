import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The MEW inspection report of a villa on a real PostgreSQL (scratch schema), with an in-memory storage: a PDF kept in the
// villa's folder, anything else refused with nothing kept, a new upload replacing the old file, removing it, and the row
// going with the villa.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { StorageService } from "../../src/core/storage/StorageService.js";
import { MewInspectionReportsRepository } from "../../src/modules/mew-inspection-reports/repository/mew-inspection-reports.repository.js";
import { MewInspectionReportsService } from "../../src/modules/mew-inspection-reports/service/mew-inspection-reports.service.js";

const NOW = new Date("2026-11-20T09:00:00.000Z");
const actor = { id: "admin", role: "ADMIN" } as never;
const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const V1 = "c0000000-0000-4000-8000-000000000001";
const V2 = "c0000000-0000-4000-8000-000000000002";
const PDF = Buffer.from("%PDF-1.7\n%report\n");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

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

describe.skipIf(!RUN)("MEW inspection reports on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const memory = memoryStorage();
  const service = new MewInspectionReportsService(
    new MewInspectionReportsRepository(),
    () => NOW,
    memory.storage,
  );

  beforeAll(async () => {
    scratch = await openScratch("scratchmewreports", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
       ($1,'V-1','B','1','eng','admin','area',now()), ($2,'V-2','B','2','eng','admin','area',now())`,
      [V1, V2],
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("keeps a PDF as the villa's report, in its folder, lists it and audits it", async () => {
    memory.temp.set("t1", PDF);
    const report = await service.upload(actor, V1, { tempPath: "t1", originalName: "inspection.pdf" }, ctx);
    expect(report).toMatchObject({
      villaId: V1,
      name: "inspection.pdf",
      size: PDF.length,
      uploadedBy: { id: "admin", name: "Root Admin" },
      uploadedAt: NOW.toISOString(),
    });
    expect([...memory.stored.keys()]).toEqual([
      expect.stringMatching(new RegExp(`^villas/${V1}/mew-inspection/.+\\.pdf$`)),
    ]);
    expect(memory.temp.size).toBe(0);
    expect((await service.ofVillas([V1, V2])).map((r) => r.villaId)).toEqual([V1]);
    const audit = await q(`SELECT "action" FROM "AuditLog" WHERE "entityId" = $1`, [V1]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(["mew_report.upload"]);
  });

  it("refuses anything but a PDF and keeps nothing of it", async () => {
    memory.temp.set("t2", JPEG);
    await expect(
      service.upload(actor, V2, { tempPath: "t2", originalName: "photo.pdf" }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
    expect(memory.temp.size).toBe(0);
    expect(await service.ofVillas([V2])).toEqual([]);
    memory.temp.set("t3", PDF);
    await expect(
      service.upload(
        actor,
        "c0000000-0000-4000-8000-0000000000ff",
        { tempPath: "t3", originalName: "x.pdf" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
    expect(memory.temp.size).toBe(0);
  });

  it("replaces the report with a new upload, and removes the old file", async () => {
    const before = [...memory.stored.keys()];
    memory.temp.set("t4", Buffer.from("%PDF-1.4\n%second\n"));
    const report = await service.upload(
      actor,
      V1,
      { tempPath: "t4", originalName: "second report.pdf" },
      ctx,
    );
    expect(report.name).toBe("second report.pdf");
    expect(memory.stored.size).toBe(1);
    expect(memory.stored.has(before[0]!)).toBe(false);
    const { stream } = await service.openFile((await service.file(V1, ctx)).key, ctx);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain("second");
  });

  it("removes the report, and answers that there is none after", async () => {
    await service.remove(actor, V1, ctx);
    expect(memory.stored.size).toBe(0);
    await expect(service.file(V1, ctx)).rejects.toMatchObject({ code: "MEW_REPORT_NOT_FOUND" });
    await expect(service.remove(actor, V1, ctx)).rejects.toMatchObject({ code: "MEW_REPORT_NOT_FOUND" });
  });

  it("goes with the villa", async () => {
    memory.temp.set("t5", PDF);
    await service.upload(actor, V2, { tempPath: "t5", originalName: "v2.pdf" }, ctx);
    await q(`DELETE FROM "Villa" WHERE "id" = $1`, [V2]);
    expect((await q(`SELECT count(*)::int AS n FROM "MewInspectionReport"`)).rows[0].n).toBe(0);
  });
});
