import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The daily labour on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end (in a
// `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It COMMITS
// inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the repository's SQL (list, locks, import queries); the unique key (villa, contractor, day) answers a
// duplicate with 409 whichever of two racing writers comes second; the villa and the contractor cannot be deleted from
// under a labour row; writers that share a villa never deadlock. At most four jobs run at once here: the pool is small on
// purpose (see CONNECTION BUDGET in scratch.ts).
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { ContractorsService } from "../../src/modules/contractors/service/contractors.service.js";
import { DailyLabourRepository } from "../../src/modules/daily-labour/repository/daily-labour.repository.js";
import { DailyLabourImportService } from "../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { DailyLabourService } from "../../src/modules/daily-labour/service/daily-labour.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const HEADER = ["Villa Number", "Labour Date", "Labour Count", "Contractor", "Notes"];
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!RUN)("the daily labour on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const repository = new DailyLabourRepository();
  const labour = new DailyLabourService();
  const importer = new DailyLabourImportService();
  const villas = new VillasService();
  const contractors = new ContractorsService();
  const actor: Actor = { id: "admin", role: "ADMIN" };
  const tx = () => scratch.prisma as unknown as Prisma.TransactionClient;

  beforeAll(async () => {
    scratch = await openScratch("scratch13d", 5);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  let counter = 0;
  async function newContractor(
    name?: string,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  ): Promise<{ id: string; name: string }> {
    counter += 1;
    const id = `con${counter}`;
    const label = name ?? `Contractor ${counter}`;
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ($1,$2,$3,$4::"PartyStatus",now())`,
      [id, label, `0100${String(counter).padStart(7, "0")}`, status],
    );
    return { id, name: label };
  }
  async function newVilla(
    contractorId: string | null,
    number?: string,
  ): Promise<{ id: string; number: string }> {
    counter += 1;
    const id = `villa${counter}`;
    const label = number ?? `V-${counter}`;
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
       VALUES ($1,$2,'B1',$3,'eng','admin','area',$4,now())`,
      [id, label, String(counter), contractorId],
    );
    return { id, number: label };
  }
  // A villa with its own contractor, which is what almost every test needs.
  async function setup(): Promise<{
    villa: { id: string; number: string };
    contractor: { id: string; name: string };
  }> {
    const contractor = await newContractor();
    return { villa: await newVilla(contractor.id), contractor };
  }

  const input = (
    villaId: string,
    contractorId: string,
    labourDate: string,
    extra: Record<string, unknown> = {},
  ) => ({ villaId, contractorId, labourDate: day(labourDate), labourCount: 12, ...extra });
  const countRows = async (villaId: string): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "DailyLabour" WHERE "villaId" = $1`, [villaId])).rows[0].n;

  let fileCounter = 0;
  // A different file every time, so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  const row = (
    villa: string,
    date: string,
    contractor: string,
    extra: Partial<Record<string, unknown>> = {},
  ) => [villa, date, extra.labourCount ?? 7, contractor, extra.notes ?? null];
  const run = async (file: Buffer, dryRun = false) =>
    importer.importFile(actor, { name: "a.xlsx", bytes: file }, dryRun, ctx);

  // An import that saved its file answers 201; a refused one answers 422 or throws 409.
  const saved = (result: PromiseSettledResult<unknown>): boolean =>
    result.status === "fulfilled" && (result.value as { status: number }).status === 201;
  function assertNoCrash(results: PromiseSettledResult<unknown>[], label: string): void {
    const crashes = results.flatMap((result) =>
      result.status === "rejected" && !(result.reason instanceof AppError && result.reason.statusCode < 500)
        ? [String((result.reason as Error)?.message ?? result.reason)]
        : [],
    );
    expect(crashes, `${label}: nothing may fail with a database error`).toEqual([]);
  }
  const codeOf = (result: PromiseSettledResult<unknown>): string | undefined =>
    result.status === "rejected" ? (result.reason as AppError).code : undefined;

  describe("the service", () => {
    it("creates a labour row with the creator and audit, in one transaction", async () => {
      const { villa, contractor } = await setup();

      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-03-01"), ctx);

      expect(created).toMatchObject({
        labourDate: "2026-03-01",
        labourCount: 12,
        notes: null,
        contractor: { id: contractor.id, name: contractor.name },
        createdBy: { id: "admin", name: "Root Admin" },
        version: 1,
      });
      const audit = await q(`SELECT "action", "entity" FROM "AuditLog" WHERE "entityId" = $1`, [created.id]);
      expect(audit.rows).toEqual([{ action: "daily_labour.create", entity: "DailyLabour" }]);
    });

    it.each([0, 1, 100_000])("round-trips a count of %s through create, get and the list", async (count) => {
      const { villa, contractor } = await setup();

      const created = await labour.create(
        actor,
        input(villa.id, contractor.id, "2026-03-02", { labourCount: count }),
        ctx,
      );

      expect(created.labourCount).toBe(count);
      expect((await labour.get(created.id, ctx)).labourCount).toBe(count);
      const listed = await labour.list({ page: 1, limit: 20, villaId: villa.id } as never);
      expect(listed.items.map((item) => item.labourCount)).toEqual([count]);
    });

    it("stores the longest notes the validators let through, Arabic included, and clears them with null", async () => {
      const { villa, contractor } = await setup();

      const created = await labour.create(
        actor,
        input(villa.id, contractor.id, "2026-03-03", { notes: "ش".repeat(500) }),
        ctx,
      );

      expect((await labour.get(created.id, ctx)).notes).toBe("ش".repeat(500));
      expect((await labour.update(actor, created.id, { notes: null }, ctx)).notes).toBeNull();
    });

    it("keeps the labour date as the calendar day it was given, whatever the clock of the server", async () => {
      const { villa, contractor } = await setup();

      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-01-01"), ctx);

      expect(created.labourDate).toBe("2026-01-01");
      expect(
        (await q(`SELECT "labourDate"::text AS d FROM "DailyLabour" WHERE "id" = $1`, [created.id])).rows[0]
          .d,
      ).toBe("2026-01-01");
    });

    it("refuses a labour date more than a day ahead with 400 and saves nothing", async () => {
      const { villa, contractor } = await setup();
      const far = new Date(Date.now() + 3 * 86_400_000);

      await expect(
        labour.create(actor, input(villa.id, contractor.id, "2026-03-01", { labourDate: far }), ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
      expect(await countRows(villa.id)).toBe(0);
    });

    it("updates with If-Match, answers 409 VERSION_CONFLICT on a stale version", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-03-01"), ctx);

      const updated = await labour.update(
        actor,
        created.id,
        { labourDate: day("2026-03-10"), labourCount: 30, notes: "Roof" },
        ctx,
        1,
      );

      expect(updated).toMatchObject({ labourDate: "2026-03-10", labourCount: 30, notes: "Roof", version: 2 });
      await expect(labour.update(actor, created.id, { labourCount: 2 }, ctx, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      expect((await labour.get(created.id, ctx)).version).toBe(2);
    });

    it("deletes with If-Match, and a row that is gone is 404", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-03-01"), ctx);

      await expect(labour.remove(actor, created.id, ctx, 9)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      await labour.remove(actor, created.id, ctx, 1);

      await expect(labour.get(created.id, ctx)).rejects.toMatchObject({ code: "DAILY_LABOUR_NOT_FOUND" });
      await expect(labour.remove(actor, created.id, ctx)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("keeps the row, with no author, when its author is deleted", async () => {
      const { villa, contractor } = await setup();
      await q(
        `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('gone','Gone','g@x.test','x','EMPLOYEE',now())`,
      );
      const created = await labour.create(
        { id: "gone", role: "EMPLOYEE" },
        input(villa.id, contractor.id, "2026-03-05"),
        ctx,
      );
      expect(created.createdBy).toEqual({ id: "gone", name: "Gone" });

      await q(`DELETE FROM "User" WHERE "id" = 'gone'`);

      expect((await labour.get(created.id, ctx)).createdBy).toBeNull();
    });

    it("answers 404 VILLA_NOT_FOUND for a villa that does not exist, and writes nothing", async () => {
      const contractor = await newContractor();

      await expect(
        labour.create(actor, input("nope", contractor.id, "2026-03-01"), ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "VILLA_NOT_FOUND" });
    });
  });

  describe("the unique key (villa, contractor, day)", () => {
    it("answers 409 DAILY_LABOUR_EXISTS for the same villa, contractor and day, and keeps the first row", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-04-01"), ctx);

      await expect(
        labour.create(actor, input(villa.id, contractor.id, "2026-04-01", { labourCount: 99 }), ctx),
      ).rejects.toMatchObject({ statusCode: 409, code: "DAILY_LABOUR_EXISTS" });

      const rows = (await q(`SELECT "labourCount" FROM "DailyLabour" WHERE "villaId" = $1`, [villa.id])).rows;
      expect(rows).toEqual([{ labourCount: 12 }]);
    });

    it("lets the same day be saved for another villa, and another day for the same villa", async () => {
      const { villa, contractor } = await setup();
      const other = await newVilla(contractor.id);

      await labour.create(actor, input(villa.id, contractor.id, "2026-04-02"), ctx);
      await labour.create(actor, input(other.id, contractor.id, "2026-04-02"), ctx);
      await labour.create(actor, input(villa.id, contractor.id, "2026-04-03"), ctx);

      expect(await countRows(villa.id)).toBe(2);
      expect(await countRows(other.id)).toBe(1);
    });

    it("lets the same day be saved for a second contractor, once the villa has changed to it", async () => {
      const { villa, contractor } = await setup();
      const second = await newContractor();
      await labour.create(actor, input(villa.id, contractor.id, "2026-04-04"), ctx);
      await q(`UPDATE "Villa" SET "contractorId" = $1 WHERE "id" = $2`, [second.id, villa.id]);

      await labour.create(actor, input(villa.id, second.id, "2026-04-04"), ctx);

      expect(await countRows(villa.id)).toBe(2);
    });

    it("answers 409 DAILY_LABOUR_EXISTS when an update moves the date onto a taken one, and changes nothing", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-04-05"), ctx);
      const second = await labour.create(actor, input(villa.id, contractor.id, "2026-04-06"), ctx);

      await expect(
        labour.update(actor, second.id, { labourDate: day("2026-04-05") }, ctx),
      ).rejects.toMatchObject({ statusCode: 409, code: "DAILY_LABOUR_EXISTS" });

      expect((await labour.get(second.id, ctx)).labourDate).toBe("2026-04-06");
      expect((await labour.get(second.id, ctx)).version).toBe(1);
    });

    it("answers 409 DAILY_LABOUR_EXISTS when an update moves the contractor onto a taken key", async () => {
      const { villa, contractor } = await setup();
      const second = await newContractor();
      await labour.create(actor, input(villa.id, contractor.id, "2026-04-07"), ctx);
      await q(`UPDATE "Villa" SET "contractorId" = $1 WHERE "id" = $2`, [second.id, villa.id]);
      const moved = await labour.create(actor, input(villa.id, second.id, "2026-04-07"), ctx);
      await q(`UPDATE "Villa" SET "contractorId" = $1 WHERE "id" = $2`, [contractor.id, villa.id]);

      await expect(
        labour.update(actor, moved.id, { contractorId: contractor.id }, ctx),
      ).rejects.toMatchObject({ statusCode: 409, code: "DAILY_LABOUR_EXISTS" });
    });

    it("frees the key when the row is deleted", async () => {
      const { villa, contractor } = await setup();
      const first = await labour.create(actor, input(villa.id, contractor.id, "2026-04-08"), ctx);
      await labour.remove(actor, first.id, ctx);

      await labour.create(actor, input(villa.id, contractor.id, "2026-04-08"), ctx);

      expect(await countRows(villa.id)).toBe(1);
    });

    it("lets exactly one of two simultaneous creates for one key win, the other is 409 DAILY_LABOUR_EXISTS", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();

        const results = await Promise.allSettled([
          labour.create(actor, input(villa.id, contractor.id, "2026-04-10"), ctx),
          labour.create(actor, input(villa.id, contractor.id, "2026-04-10", { labourCount: 3 }), ctx),
        ]);

        assertNoCrash(results, `double create, round ${round}`);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(["DAILY_LABOUR_EXISTS"]);
        expect(await countRows(villa.id)).toBe(1);
      }
    });

    it("lets exactly one of four simultaneous creates for one key win", async () => {
      const { villa, contractor } = await setup();

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          labour.create(actor, input(villa.id, contractor.id, "2026-04-11"), ctx),
        ),
      );

      assertNoCrash(results, "four creates");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.map(codeOf).filter(Boolean)).toEqual(Array(3).fill("DAILY_LABOUR_EXISTS"));
    });

    it("lets all simultaneous creates for different days succeed", async () => {
      const { villa, contractor } = await setup();

      const results = await Promise.allSettled(
        [12, 13, 14, 15].map((d) =>
          labour.create(actor, input(villa.id, contractor.id, `2026-04-${d}`), ctx),
        ),
      );

      assertNoCrash(results, "four days");
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(await countRows(villa.id)).toBe(4);
    });

    it("lets one of a create and an update that want the same key win, the other is 409", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        const mover = await labour.create(actor, input(villa.id, contractor.id, "2026-04-20"), ctx);

        const results = await Promise.allSettled([
          labour.create(actor, input(villa.id, contractor.id, "2026-04-21"), ctx),
          labour.update(actor, mover.id, { labourDate: day("2026-04-21") }, ctx),
        ]);

        assertNoCrash(results, `create vs update, round ${round}`);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(["DAILY_LABOUR_EXISTS"]);
        const days = (
          await q(`SELECT "labourDate"::text AS d FROM "DailyLabour" WHERE "villaId" = $1 ORDER BY 1`, [
            villa.id,
          ])
        ).rows.map((entry) => entry.d);
        expect(new Set(days).size).toBe(days.length);
      }
    });
  });

  describe("the contractor of a row", () => {
    it("refuses a contractor that is not the villa's with 422 CONTRACTOR_NOT_ON_VILLA, and a villa with none", async () => {
      const { villa } = await setup();
      const stranger = await newContractor();
      const bare = await newVilla(null);

      await expect(
        labour.create(actor, input(villa.id, stranger.id, "2026-05-01"), ctx),
      ).rejects.toMatchObject({ statusCode: 422, code: "CONTRACTOR_NOT_ON_VILLA" });
      await expect(
        labour.create(actor, input(bare.id, stranger.id, "2026-05-01"), ctx),
      ).rejects.toMatchObject({ statusCode: 422, code: "CONTRACTOR_NOT_ON_VILLA" });
      expect(await countRows(villa.id)).toBe(0);
      expect(await countRows(bare.id)).toBe(0);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for a contractor that does not exist", async () => {
      const { villa } = await setup();

      await expect(labour.create(actor, input(villa.id, "ghost", "2026-05-02"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "CONTRACTOR_NOT_FOUND",
      });
    });

    it("refuses an inactive contractor with 400 CONTRACTOR_INACTIVE", async () => {
      const gone = await newContractor("Retired", "INACTIVE");
      const villa = await newVilla(gone.id);

      await expect(labour.create(actor, input(villa.id, gone.id, "2026-05-03"), ctx)).rejects.toMatchObject({
        statusCode: 400,
        code: "CONTRACTOR_INACTIVE",
      });
    });

    it("keeps a row whose contractor was later taken off the villa, and lets an unrelated change through", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-05-04"), ctx);
      await q(`UPDATE "Villa" SET "contractorId" = NULL WHERE "id" = $1`, [villa.id]);

      const updated = await labour.update(actor, created.id, { labourCount: 40 }, ctx);

      expect(updated).toMatchObject({ labourCount: 40, contractor: { id: contractor.id } });
    });

    it("checks the new contractor of an update against the villa", async () => {
      const { villa, contractor } = await setup();
      const stranger = await newContractor();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-05-05"), ctx);

      await expect(
        labour.update(actor, created.id, { contractorId: stranger.id }, ctx),
      ).rejects.toMatchObject({ statusCode: 422, code: "CONTRACTOR_NOT_ON_VILLA" });
      expect((await labour.get(created.id, ctx)).contractor.id).toBe(contractor.id);
    });
  });

  describe("the delete guards", () => {
    it("keeps a villa that has a labour row: 409 VILLA_HAS_RECORDS, and the FK is the backstop", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-06-01"), ctx);

      await expect(villas.remove(actor, villa.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
      });
      await expect(q(`DELETE FROM "Villa" WHERE "id" = $1`, [villa.id])).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
    });

    it("lets the villa go once its labour rows are deleted", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-06-02"), ctx);
      await labour.remove(actor, created.id, ctx);

      await villas.remove(actor, villa.id, ctx);

      expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(0);
    });

    it("keeps a contractor that a labour row names, even after no villa has it: 409 CONTRACTOR_HAS_VILLAS", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-06-03"), ctx);
      // No villa has the contractor now, so the villa count alone would let the delete through; the foreign key stops it.
      await q(`UPDATE "Villa" SET "contractorId" = NULL WHERE "id" = $1`, [villa.id]);

      await expect(contractors.remove(actor, contractor.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "CONTRACTOR_HAS_VILLAS",
      });
      await expect(q(`DELETE FROM "Contractor" WHERE "id" = $1`, [contractor.id])).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
      expect((await q(`SELECT 1 FROM "Contractor" WHERE "id" = $1`, [contractor.id])).rowCount).toBe(1);
    });

    it("lets the contractor go once nothing names it", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-06-04"), ctx);
      await labour.remove(actor, created.id, ctx);
      await q(`UPDATE "Villa" SET "contractorId" = NULL WHERE "id" = $1`, [villa.id]);

      await contractors.remove(actor, contractor.id, ctx);

      expect((await q(`SELECT 1 FROM "Contractor" WHERE "id" = $1`, [contractor.id])).rowCount).toBe(0);
    });
  });

  describe("the list", () => {
    it("filters, searches, sorts and pages in SQL, with the same WHERE for the count; the villa number sorts naturally", async () => {
      const nile = await newContractor("Nile Builders");
      const delta = await newContractor("Delta_Works");
      const a = await newVilla(nile.id, "L-2");
      const b = await newVilla(delta.id, "L-10");
      const c = await newVilla(nile.id, "L-1");
      await labour.create(
        actor,
        input(a.id, nile.id, "2025-01-01", { labourCount: 5, notes: "100% slab" }),
        ctx,
      );
      await labour.create(actor, input(a.id, nile.id, "2025-01-02", { labourCount: 9 }), ctx);
      await labour.create(
        actor,
        input(b.id, delta.id, "2025-01-02", { labourCount: 2, notes: "Cable_tray" }),
        ctx,
      );
      await labour.create(actor, input(c.id, nile.id, "2025-01-03", { labourCount: 7 }), ctx);
      const ask = (query: Record<string, unknown>) =>
        labour.list({
          page: 1,
          limit: 20,
          labourFrom: day("2025-01-01"),
          labourTo: day("2025-01-31"),
          ...query,
        } as never);

      const all = await ask({});
      expect(all.meta.total).toBe(4);
      expect(all.items.map((item) => item.labourDate)).toEqual([
        "2025-01-03",
        "2025-01-02",
        "2025-01-02",
        "2025-01-01",
      ]);

      const natural = await ask({ sort: "villaNumber:asc" });
      expect(natural.items.map((item) => item.villa.villaNumber)).toEqual(["L-1", "L-2", "L-2", "L-10"]);
      // The rows of one villa come newest first.
      expect(
        natural.items.filter((item) => item.villa.villaNumber === "L-2").map((item) => item.labourDate),
      ).toEqual(["2025-01-02", "2025-01-01"]);

      expect((await ask({ sort: "labourCount:asc" })).items.map((item) => item.labourCount)).toEqual([
        2, 5, 7, 9,
      ]);
      expect((await ask({ sort: "labourCount:desc" })).items.map((item) => item.labourCount)).toEqual([
        9, 7, 5, 2,
      ]);
      expect((await ask({ sort: "contractorName:asc" })).items.map((item) => item.contractor.name)).toEqual([
        "Delta_Works",
        "Nile Builders",
        "Nile Builders",
        "Nile Builders",
      ]);
      expect((await ask({ sort: "labourDate:asc" })).items.map((item) => item.labourDate)[0]).toBe(
        "2025-01-01",
      );

      expect((await ask({ search: "100%" })).items).toHaveLength(1);
      expect((await ask({ search: "Cable_tray" })).items).toHaveLength(1);
      expect((await ask({ search: "cable-tray" })).items).toHaveLength(0);
      expect((await ask({ search: "delta_works" })).items.map((item) => item.villa.villaNumber)).toEqual([
        "L-10",
      ]);
      expect((await ask({ search: "L-10" })).items).toHaveLength(1);
      expect((await ask({ search: "nile" })).meta.total).toBe(3);
      expect((await ask({ contractorId: delta.id })).meta.total).toBe(1);
      expect((await ask({ villaId: a.id })).meta.total).toBe(2);
      expect((await ask({ labourFrom: day("2025-01-02"), labourTo: day("2025-01-02") })).meta.total).toBe(2);

      const page = await ask({ limit: 2, page: 2 });
      expect(page.items.map((item) => item.labourDate)).toEqual(["2025-01-02", "2025-01-01"]);
      expect(page.meta.total).toBe(4);
    });
  });

  describe("the repository's locks and queries", () => {
    it("locks the villa shared and answers its contractor; a villa that is gone is null", async () => {
      const { villa, contractor } = await setup();
      const bare = await newVilla(null);

      expect(await scratch.prisma.$transaction((t) => repository.lockVillaShared(villa.id, t))).toEqual({
        contractorId: contractor.id,
      });
      expect(await scratch.prisma.$transaction((t) => repository.lockVillaShared(bare.id, t))).toEqual({
        contractorId: null,
      });
      expect(await scratch.prisma.$transaction((t) => repository.lockVillaShared("nope", t))).toBeNull();
    });

    it("locks the villas of an import and answers their contractors; a villa that is gone is missing", async () => {
      const { villa: a, contractor } = await setup();
      const b = await newVilla(null);

      const locked = await scratch.prisma.$transaction((t) =>
        repository.lockVillasShared([a.id, "gone", b.id], t),
      );

      expect([...locked.entries()].sort()).toEqual(
        [
          [a.id, contractor.id],
          [b.id, null],
        ].sort(),
      );
      expect([...(await scratch.prisma.$transaction((t) => repository.lockVillasShared([], t)))]).toEqual([]);
    });

    it("saves the rows of an import in one go and returns the ids it made", async () => {
      const { villa, contractor } = await setup();
      const base = {
        villaId: villa.id,
        contractorId: contractor.id,
        notes: null,
        createdById: "admin",
      };

      const ids = await repository.createMany(
        [
          { ...base, labourDate: day("2026-09-01"), labourCount: 1 },
          { ...base, labourDate: day("2026-09-02"), labourCount: 3, notes: "Again" },
          { ...base, labourDate: day("2026-09-03"), labourCount: 5 },
        ],
        tx(),
      );

      expect(new Set(ids).size).toBe(3);
      const stored = (
        await q(
          `SELECT "labourCount", "notes" FROM "DailyLabour" WHERE "id" = ANY($1) ORDER BY "labourCount"`,
          [ids],
        )
      ).rows;
      expect(stored).toEqual([
        { labourCount: 1, notes: null },
        { labourCount: 3, notes: "Again" },
        { labourCount: 5, notes: null },
      ]);
    });

    it("reads every villa and contractor for an import, and the keys that exist for some villas", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-09-05"), ctx);

      const found = (await repository.importVillas(tx())).find((entry) => entry.id === villa.id);
      expect(found).toMatchObject({ id: villa.id, villaNumber: villa.number, contractorId: contractor.id });
      expect(
        (await repository.importContractors(tx())).find((entry) => entry.id === contractor.id),
      ).toMatchObject({ id: contractor.id, name: contractor.name, status: "ACTIVE" });
      const keys = await repository.existingKeys([villa.id], tx());
      expect([...keys]).toHaveLength(1);
      // Two villas at once: the rows of both come back, and the rows of a villa that was not asked for do not.
      const { villa: second, contractor: secondContractor } = await setup();
      const third = await setup();
      await labour.create(actor, input(second.id, secondContractor.id, "2026-09-05"), ctx);
      await labour.create(actor, input(third.villa.id, third.contractor.id, "2026-09-05"), ctx);
      const both = await repository.existingKeys([villa.id, second.id], tx());
      expect(both.map((entry) => entry.villaId).sort()).toEqual([villa.id, second.id].sort());
      expect([...(await repository.existingKeys([], tx()))]).toEqual([]);
    });

    it("changes and deletes a labour row only at the version the caller read", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-09-10"), ctx);

      expect(await repository.update(created.id, created.version + 1, { labourCount: 1 }, tx())).toBeNull();
      expect(await repository.delete(created.id, created.version + 1, tx())).toBe(false);
      expect(
        (await q(`SELECT "labourCount", "version" FROM "DailyLabour" WHERE "id" = $1`, [created.id])).rows[0],
      ).toEqual({ labourCount: 12, version: created.version });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await repository.update(
        created.id,
        created.version,
        { labourCount: 1, notes: "n" },
        tx(),
      );
      expect(updated).toMatchObject({ labourCount: 1, notes: "n", version: created.version + 1 });
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
      expect(await repository.delete(created.id, created.version + 1, tx())).toBe(true);
      expect(await countRows(villa.id)).toBe(0);
    });

    it("locks the row so that nothing else can even share it until the transaction ends", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-09-11"), ctx);

      const refusal = await scratch.prisma.$transaction(async (t) => {
        expect(await repository.lockVersion(created.id, t)).toBe(created.version);
        return q(`SELECT 1 FROM "DailyLabour" WHERE "id" = $1 FOR SHARE NOWAIT`, [created.id]).then(
          () => null,
          (err: { code?: string }) => err.code ?? "error",
        );
      });

      expect(refusal).toBe("55P03");
    });

    it("takes the villa's lock shared: two writers hold it at once, a delete of the villa has to wait", async () => {
      const { villa } = await setup();

      const outcome = await scratch.prisma.$transaction(async (t) => {
        await repository.lockVillaShared(villa.id, t);
        const shared = await q(`SELECT 1 FROM "Villa" WHERE "id" = $1 FOR SHARE NOWAIT`, [villa.id]).then(
          () => null,
          (err: { code?: string }) => err.code ?? "error",
        );
        const exclusive = await q(`SELECT 1 FROM "Villa" WHERE "id" = $1 FOR UPDATE NOWAIT`, [villa.id]).then(
          () => null,
          (err: { code?: string }) => err.code ?? "error",
        );
        return { shared, exclusive };
      });

      expect(outcome).toEqual({ shared: null, exclusive: "55P03" });
    });
  });

  describe("concurrent writers", () => {
    it("lets exactly one of two simultaneous updates with the same If-Match win, the other gets 409 VERSION_CONFLICT", async () => {
      const { villa, contractor } = await setup();
      const created = await labour.create(actor, input(villa.id, contractor.id, "2026-10-02"), ctx);

      const results = await Promise.allSettled([
        labour.update(actor, created.id, { labourCount: 1 }, ctx, 1),
        labour.update(actor, created.id, { labourCount: 2 }, ctx, 1),
      ]);

      assertNoCrash(results, "two updates");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.map(codeOf).filter(Boolean)).toEqual(["VERSION_CONFLICT"]);
      expect((await labour.get(created.id, ctx)).version).toBe(2);
    });

    it("never deadlocks an update and a delete of the same row: one wins, the other is 404 or 409", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        const created = await labour.create(actor, input(villa.id, contractor.id, "2026-10-03"), ctx);

        const results = await Promise.allSettled([
          labour.update(actor, created.id, { labourCount: 2 }, ctx),
          labour.remove(actor, created.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete, round ${round}`);
        expect(await countRows(villa.id)).toBe(0);
      }
    });

    it("never deadlocks a create and the delete of its villa: the row exists and the villa stays, or neither", async () => {
      for (let round = 0; round < 8; round += 1) {
        const { villa, contractor } = await setup();

        const results = await Promise.allSettled([
          labour.create(actor, input(villa.id, contractor.id, "2026-10-05"), ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `create vs delete villa, round ${round}`);
        const villaLeft = (await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount;
        const rowsLeft = await countRows(villa.id);
        expect(villaLeft === 1 || rowsLeft === 0, "a labour row never outlives its villa").toBe(true);
        if (rowsLeft === 1) expect(villaLeft).toBe(1);
      }
    });

    it("never deadlocks an update of a labour row and the delete of its villa", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        const created = await labour.create(actor, input(villa.id, contractor.id, "2026-10-06"), ctx);

        const results = await Promise.allSettled([
          labour.update(actor, created.id, { labourCount: 1 }, ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete villa, round ${round}`);
        // The villa has a labour row, so its delete is refused whichever came first.
        expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(1);
        expect(await countRows(villa.id)).toBe(1);
      }
    });

    it("never deadlocks a create and a change of the villa's contractor: the row is saved for the old one, or refused", async () => {
      for (let round = 0; round < 8; round += 1) {
        const { villa, contractor } = await setup();
        const next = await newContractor();

        const results = await Promise.allSettled([
          labour.create(actor, input(villa.id, contractor.id, "2026-10-07"), ctx),
          villas.update(actor, villa.id, { contractorId: next.id }, ctx),
        ]);

        assertNoCrash(results, `create vs contractor change, round ${round}`);
        // The create ran either before the change (saved for the old contractor) or after it (refused: 422).
        const rows = (await q(`SELECT "contractorId" FROM "DailyLabour" WHERE "villaId" = $1`, [villa.id]))
          .rows;
        const create = results[0]!;
        if (create.status === "fulfilled") {
          expect(rows).toEqual([{ contractorId: contractor.id }]);
        } else {
          expect(codeOf(create)).toBe("CONTRACTOR_NOT_ON_VILLA");
          expect(rows).toEqual([]);
        }
        expect(
          (await q(`SELECT "contractorId" FROM "Villa" WHERE "id" = $1`, [villa.id])).rows[0].contractorId,
        ).toBe(next.id);
      }
    });

    it("never deadlocks a create and the delete of its contractor: the contractor stays with its row, or neither", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        await q(`UPDATE "Villa" SET "contractorId" = NULL WHERE "id" = $1`, [villa.id]);
        await q(`UPDATE "Villa" SET "contractorId" = $1 WHERE "id" = $2`, [contractor.id, villa.id]);

        const results = await Promise.allSettled([
          labour.create(actor, input(villa.id, contractor.id, "2026-10-08"), ctx),
          contractors.remove(actor, contractor.id, ctx),
        ]);

        assertNoCrash(results, `create vs delete contractor, round ${round}`);
        // The villa names the contractor, so its delete is refused whichever came first.
        expect((await q(`SELECT 1 FROM "Contractor" WHERE "id" = $1`, [contractor.id])).rowCount).toBe(1);
      }
    });
  });

  describe("the import", () => {
    it("saves a file whole: 201, the rows, the importer as creator, one audit entry", async () => {
      const { villa: a, contractor: nile } = await setup();
      const { villa: b, contractor: delta } = await setup();
      const file = await fileOf(
        row(a.number, "2026-03-04", nile.name, { labourCount: 0 }),
        row(a.number, "2026-03-05", nile.name, { labourCount: "100000", notes: "Roof" }),
        row(b.number, "2026-03-04", delta.name, { notes: "ش".repeat(500) }),
      );

      const outcome = await run(file);

      expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 3 } });
      const stored = (
        await q(
          `SELECT "villaId", "contractorId", "labourCount", "notes", "createdById", "version"
           FROM "DailyLabour" WHERE "villaId" = ANY($1) ORDER BY "villaId", "labourDate"`,
          [[a.id, b.id]],
        )
      ).rows;
      expect(
        stored.map((entry) => [entry.labourCount, entry.notes === null ? null : entry.notes.length]),
      ).toEqual([
        [0, null],
        [100000, 4],
        [7, 500],
      ]);
      expect(stored.map((entry) => entry.contractorId)).toEqual([nile.id, nile.id, delta.id]);
      expect(stored.every((entry) => entry.createdById === "admin" && entry.version === 1)).toBe(true);
      const audit = await q(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'daily_labour.import' AND "after"->>'rows' = '3'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("refuses a day twice in the file for one villa and contractor, and saves nothing", async () => {
      const { villa, contractor } = await setup();
      const file = await fileOf(
        row(villa.number, "2026-03-06", contractor.name),
        row(villa.number, "2026-03-06", contractor.name, { labourCount: 9 }),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [3, "Labour Date", "DUPLICATE_IN_FILE"],
      ]);
      expect(await countRows(villa.id)).toBe(0);
    });

    it("refuses a day that is already saved, and saves nothing of the file", async () => {
      const { villa, contractor } = await setup();
      await labour.create(actor, input(villa.id, contractor.id, "2026-03-07"), ctx);
      const file = await fileOf(
        row(villa.number, "2026-03-08", contractor.name),
        row(villa.number, "2026-03-07", contractor.name),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [3, "Labour Date", "DUPLICATE_EXISTING"],
      ]);
      expect(await countRows(villa.id)).toBe(1);
    });

    it.each([
      ["a negative count", -1],
      ["a fraction", 2.5],
      ["over the limit", 100_001],
      ["a huge number", 2_147_483_648],
    ])("answers 422, never a database error, for %s, and saves nothing", async (_name, labourCount) => {
      const { villa, contractor } = await setup();
      const file = await fileOf(
        row(villa.number, "2026-03-09", contractor.name),
        row(villa.number, "2026-03-10", contractor.name, { labourCount }),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column])).toEqual([[3, "Labour Count"]]);
      expect(await countRows(villa.id)).toBe(0);
    });

    it("answers 422 for another villa's contractor, an inactive one, and a date more than a day ahead", async () => {
      const { villa, contractor } = await setup();
      const stranger = await newContractor();
      const retired = await newContractor("Retired Crew", "INACTIVE");
      const retiredVilla = await newVilla(retired.id);
      const far = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const file = await fileOf(
        row(villa.number, "2026-03-11", stranger.name),
        row(retiredVilla.number, "2026-03-11", retired.name),
        row(villa.number, far, contractor.name),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column])).toEqual([
        [2, "Contractor"],
        [3, "Contractor"],
        [4, "Labour Date"],
      ]);
      expect(await countRows(villa.id)).toBe(0);
    });

    it("saves nothing when one row of the file is bad", async () => {
      const { villa, contractor } = await setup();
      const file = await fileOf(
        row(villa.number, "2026-03-12", contractor.name),
        row("NOPE-1", "2026-03-12", contractor.name),
      );

      expect(await run(file)).toMatchObject({ status: 422 });
      expect(await countRows(villa.id)).toBe(0);
    });

    it("answers a dry run without writing, and an identical file twice with 409 FILE_ALREADY_IMPORTED", async () => {
      const { villa, contractor } = await setup();
      const file = await fileOf(row(villa.number, "2026-03-20", contractor.name));

      expect(await run(file, true)).toMatchObject({ status: 200 });
      expect(await countRows(villa.id)).toBe(0);
      expect(await run(file)).toMatchObject({ status: 201 });
      await expect(run(file)).rejects.toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
      expect(await countRows(villa.id)).toBe(1);
    });

    it("races a create for a day of the file: one of them wins that day, the other is refused, no crash", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        const file = await fileOf(
          row(villa.number, "2026-04-01", contractor.name),
          row(villa.number, "2026-04-02", contractor.name),
          row(villa.number, "2026-04-03", contractor.name),
        );

        const results = await Promise.allSettled([
          run(file),
          labour.create(actor, input(villa.id, contractor.id, "2026-04-02", { notes: "By hand" }), ctx),
        ]);

        assertNoCrash(results, `import vs create, round ${round}`);
        const total = await countRows(villa.id);
        // Either the create came first and the file was refused whole (1 row), or the file came first and the create was
        // refused with 409 (3 rows). Never both, never a half file.
        if (saved(results[0]!)) {
          expect(total).toBe(3);
          expect(codeOf(results[1]!)).toBe("DAILY_LABOUR_EXISTS");
        } else {
          expect(total).toBe(1);
          expect(results[1]!.status).toBe("fulfilled");
        }
      }
    });

    it("races the delete of a villa of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa: keep, contractor: keepContractor } = await setup();
        const { villa: doomed, contractor: doomedContractor } = await setup();
        const file = await fileOf(
          row(keep.number, "2026-04-10", keepContractor.name),
          row(doomed.number, "2026-04-10", doomedContractor.name),
        );

        const results = await Promise.allSettled([run(file), villas.remove(actor, doomed.id, ctx)]);

        assertNoCrash(results, `import vs delete villa, round ${round}`);
        const total = (await countRows(keep.id)) + (await countRows(doomed.id));
        expect([0, 2]).toContain(total);
        if (total === 2) {
          expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [doomed.id])).rowCount).toBe(1);
        }
      }
    });

    it("races a change of the contractor of a villa of the file: whole file or nothing, no crash", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { villa, contractor } = await setup();
        const next = await newContractor();
        const file = await fileOf(
          row(villa.number, "2026-04-15", contractor.name),
          row(villa.number, "2026-04-16", contractor.name),
        );

        const results = await Promise.allSettled([
          run(file),
          villas.update(actor, villa.id, { contractorId: next.id }, ctx),
        ]);

        assertNoCrash(results, `import vs contractor change, round ${round}`);
        expect([0, 2]).toContain(await countRows(villa.id));
      }
    });

    it("races another import of the same villa: both finish, every row is saved once", async () => {
      const { villa, contractor } = await setup();
      const first = await fileOf(
        row(villa.number, "2026-05-01", contractor.name),
        row(villa.number, "2026-05-02", contractor.name),
      );
      const second = await fileOf(
        row(villa.number, "2026-05-03", contractor.name),
        row(villa.number, "2026-05-04", contractor.name),
      );

      const results = await Promise.allSettled([run(first), run(second)]);

      assertNoCrash(results, "two imports");
      expect(results.every(saved)).toBe(true);
      expect(await countRows(villa.id)).toBe(4);
    });

    it("races two files that both hold the same day: one is saved whole, the other is refused whole", async () => {
      for (let round = 0; round < 4; round += 1) {
        const { villa, contractor } = await setup();
        const first = await fileOf(
          row(villa.number, "2026-05-10", contractor.name),
          row(villa.number, "2026-05-11", contractor.name),
        );
        const second = await fileOf(
          row(villa.number, "2026-05-11", contractor.name),
          row(villa.number, "2026-05-12", contractor.name),
        );

        const results = await Promise.allSettled([run(first), run(second)]);

        assertNoCrash(results, `two overlapping files, round ${round}`);
        expect(results.filter(saved)).toHaveLength(1);
        expect(await countRows(villa.id)).toBe(2);
      }
    });

    it("races four copies of one file: exactly one is saved, the others are 409 FILE_ALREADY_IMPORTED", async () => {
      const { villa, contractor } = await setup();
      const file = await fileOf(row(villa.number, "2026-06-01", contractor.name));

      const results = await Promise.allSettled([run(file), run(file), run(file), run(file)]);

      assertNoCrash(results, "four copies");
      expect(results.filter(saved)).toHaveLength(1);
      expect(await countRows(villa.id)).toBe(1);
    });
  });
});
