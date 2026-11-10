import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The daily small works on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end (in a
// `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It COMMITS
// inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the repository's SQL (list, locks, import queries); that the table has no quantity or unit any more;
// writers that share a villa (create, update, delete, the villa's delete, an import) never deadlock and never leave a
// file half saved. At most four jobs run at once here: the pool is small on purpose (see CONNECTION BUDGET in scratch.ts).
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { ContractorsService } from "../../src/modules/contractors/service/contractors.service.js";
import { SmallWorksRepository } from "../../src/modules/small-works/repository/small-works.repository.js";
import { SmallWorksImportService } from "../../src/modules/small-works/service/small-works-import.service.js";
import { SmallWorksService } from "../../src/modules/small-works/service/small-works.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const HEADER = ["Villa Number", "Start Date", "End Date", "Description", "Contractor", "Status"];
const KUWAIT = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!RUN)("the daily small works on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const repository = new SmallWorksRepository();
  const works = new SmallWorksService();
  const importer = new SmallWorksImportService();
  const villas = new VillasService();
  const contractors = new ContractorsService();
  const actor: Actor = { id: "admin", role: "ADMIN" };
  const tx = () => scratch.prisma as unknown as Prisma.TransactionClient;

  beforeAll(async () => {
    scratch = await openScratch("scratch11d", 8);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','New Cairo','Cairo',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
         ('c1','Hamdy Co','0100','ACTIVE',now()), ('c2','Mona Co','0101','ACTIVE',now()), ('c3','Off Co','0102','INACTIVE',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  let villaCounter = 0;
  async function newVilla(): Promise<{ id: string; number: string }> {
    villaCounter += 1;
    const id = `villa${villaCounter}`;
    const number = `V-${villaCounter}`;
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt")
       VALUES ($1,$2,'B1',$3,'eng','admin','area',now())`,
      [id, number, String(villaCounter)],
    );
    return { id, number };
  }

  // A one-day work of the contractor c1, unless the case says otherwise.
  const input = (villaId: string, date: string, extra: Record<string, unknown> = {}) => ({
    villaId,
    contractorId: "c1",
    startDate: day(date),
    endDate: day(date),
    description: "Replaced a socket",
    ...extra,
  });
  const countWorks = async (villaId: string): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "DailySmallWork" WHERE "villaId" = $1`, [villaId])).rows[0].n;

  let fileCounter = 0;
  // A different file every time, so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  const row = (villa: string, date: string, extra: Partial<Record<string, unknown>> = {}) => [
    villa,
    date,
    extra.endDate ?? date,
    extra.description ?? "Work",
    extra.contractor ?? "Hamdy Co",
    extra.status ?? null,
  ];
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

  describe("the service", () => {
    it("creates a small work with the creator, PENDING, and audit, in one transaction", async () => {
      const villa = await newVilla();

      const work = await works.create(actor, input(villa.id, "2026-03-01"), ctx);

      expect(work).toMatchObject({
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        contractor: { id: "c1", name: "Hamdy Co" },
        status: "PENDING",
        createdBy: { id: "admin", name: "Root Admin" },
        version: 1,
      });
      const audit = await q(`SELECT "action", "entity" FROM "AuditLog" WHERE "entityId" = $1`, [work.id]);
      expect(audit.rows).toEqual([{ action: "small_work.create", entity: "DailySmallWork" }]);
    });

    it("has no quantity or unit column any more", async () => {
      const columns = (
        await q(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DailySmallWork'`,
        )
      ).rows.map((column) => column.column_name);

      expect(columns).not.toContain("qty");
      expect(columns).not.toContain("unit");
      expect(columns).toEqual(
        expect.arrayContaining(["description", "startDate", "endDate", "contractorId", "status", "version"]),
      );
    });

    it("stores a description of the longest allowed length, and refuses a longer one in the database", async () => {
      const villa = await newVilla();

      const created = await works.create(
        actor,
        input(villa.id, "2026-03-03", { description: "d".repeat(500) }),
        ctx,
      );

      expect(created.description).toHaveLength(500);
      await expect(
        q(
          `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","createdById","updatedAt")
           VALUES ('long',$1,'c1','2026-03-05','2026-03-05',$2,'admin',now())`,
          [villa.id, "d".repeat(501)],
        ),
      ).rejects.toBeTruthy();
    });

    it("updates with If-Match, answers 409 VERSION_CONFLICT on a stale version, and moves the date and the status", async () => {
      const villa = await newVilla();
      const a = await works.create(actor, input(villa.id, "2026-03-01"), ctx);

      const updated = await works.update(
        actor,
        a.id,
        { endDate: day("2026-03-10"), status: "DONE", contractorId: "c2" },
        ctx,
        1,
      );

      expect(updated).toMatchObject({
        startDate: "2026-03-01",
        endDate: "2026-03-10",
        status: "DONE",
        contractor: { id: "c2", name: "Mona Co" },
        version: 2,
      });
      await expect(works.update(actor, a.id, { description: "Changed" }, ctx, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      expect((await works.get(a.id, ctx)).version).toBe(2);
    });

    it("lets the same job be saved twice for one villa and day: there is no natural key", async () => {
      const villa = await newVilla();

      await works.create(actor, input(villa.id, "2026-03-04"), ctx);
      await works.create(actor, input(villa.id, "2026-03-04"), ctx);

      expect(await countWorks(villa.id)).toBe(2);
    });

    it("deletes with If-Match, and a small work that is gone is 404", async () => {
      const villa = await newVilla();
      const a = await works.create(actor, input(villa.id, "2026-03-01"), ctx);

      await expect(works.remove(actor, a.id, ctx, 9)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      await works.remove(actor, a.id, ctx, 1);

      await expect(works.get(a.id, ctx)).rejects.toMatchObject({ code: "SMALL_WORK_NOT_FOUND" });
      await expect(works.remove(actor, a.id, ctx)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("keeps a villa that has a small work: 409 VILLA_HAS_RECORDS, and the FK is the backstop", async () => {
      const villa = await newVilla();
      await works.create(actor, input(villa.id, "2026-03-01"), ctx);

      await expect(villas.remove(actor, villa.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
      });
      await expect(q(`DELETE FROM "Villa" WHERE "id" = $1`, [villa.id])).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
    });

    it("lets the villa go once its small works are deleted", async () => {
      const villa = await newVilla();
      const a = await works.create(actor, input(villa.id, "2026-03-01"), ctx);
      await works.remove(actor, a.id, ctx);

      await villas.remove(actor, villa.id, ctx);

      expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(0);
    });

    it("answers 404 VILLA_NOT_FOUND for a villa that does not exist, and writes nothing", async () => {
      await expect(works.create(actor, input("nope", "2026-03-01"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("answers 404 CONTRACTOR_NOT_FOUND and 400 CONTRACTOR_INACTIVE, and writes nothing", async () => {
      const villa = await newVilla();

      await expect(
        works.create(actor, input(villa.id, "2026-03-01", { contractorId: "nope" }), ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "CONTRACTOR_NOT_FOUND" });
      await expect(
        works.create(actor, input(villa.id, "2026-03-01", { contractorId: "c3" }), ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: "CONTRACTOR_INACTIVE" });
      expect(await countWorks(villa.id)).toBe(0);
    });

    it("refuses a range that runs backwards with 422, and the database check is the backstop", async () => {
      const villa = await newVilla();

      await expect(
        works.create(actor, input(villa.id, "2026-03-05", { endDate: day("2026-03-04") }), ctx),
      ).rejects.toMatchObject({ statusCode: 422, code: "SMALL_WORK_DATE_RANGE_INVALID" });
      await expect(
        q(
          `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","createdById","updatedAt")
           VALUES ('bad',$1,'c1','2026-03-05','2026-03-04','x','admin',now())`,
          [villa.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("keeps a contractor that has a small work: the foreign key refuses the delete, as CONTRACTOR_HAS_VILLAS", async () => {
      const villa = await newVilla();
      await q(
        `INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('c9','Used Co','0109',now())`,
      );
      await works.create(actor, input(villa.id, "2026-03-01", { contractorId: "c9" }), ctx);

      await expect(contractors.remove(actor, "c9", ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "CONTRACTOR_HAS_VILLAS",
      });
      await expect(q(`DELETE FROM "Contractor" WHERE "id" = 'c9'`)).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
    });
  });

  describe("the list", () => {
    it("filters, searches, sorts and pages in SQL, with the same WHERE for the count", async () => {
      const a = await newVilla();
      const b = await newVilla();
      const c = await newVilla();
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-2' WHERE "id" = $1`, [a.id]);
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-10' WHERE "id" = $1`, [b.id]);
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-1' WHERE "id" = $1`, [c.id]);
      await works.create(
        actor,
        input(a.id, "2025-01-01", { description: "Poured 100% slab", status: "DONE" }),
        ctx,
      );
      await works.create(actor, input(a.id, "2025-01-02", { description: "Cable_tray" }), ctx);
      await works.create(
        actor,
        input(b.id, "2025-01-02", { description: "Formwork", contractorId: "c2" }),
        ctx,
      );
      await works.create(actor, input(c.id, "2025-01-03", { description: "Plaster" }), ctx);
      const ask = (query: Record<string, unknown>) =>
        works.list({
          page: 1,
          limit: 20,
          endFrom: day("2025-01-01"),
          endTo: day("2025-01-31"),
          ...query,
        } as never);

      const all = await ask({});
      expect(all.meta.total).toBe(4);
      expect(all.items.map((item) => item.endDate)).toEqual([
        "2025-01-03",
        "2025-01-02",
        "2025-01-02",
        "2025-01-01",
      ]);

      const natural = await ask({ sort: "villaNumber:asc" });
      expect(natural.items.map((item) => item.villa.villaNumber)).toEqual(["L-1", "L-2", "L-2", "L-10"]);

      const byStatus = await ask({ sort: "status:asc" });
      expect(byStatus.items.map((item) => item.status)).toEqual(["PENDING", "PENDING", "PENDING", "DONE"]);

      expect((await ask({ search: "100%" })).items).toHaveLength(1);
      expect((await ask({ search: "Cable_tray" })).items).toHaveLength(1);
      expect((await ask({ search: "cable-tray" })).items).toHaveLength(0);
      expect((await ask({ search: "mona co" })).items).toHaveLength(1);
      expect((await ask({ contractorId: "c2" })).items.map((item) => item.description)).toEqual(["Formwork"]);
      const byContractor = await ask({ sort: "contractorName:asc" });
      expect(byContractor.items.map((item) => item.contractor.name)).toEqual([
        "Hamdy Co",
        "Hamdy Co",
        "Hamdy Co",
        "Mona Co",
      ]);
      expect((await ask({ search: "L-10" })).items.map((item) => item.description)).toEqual(["Formwork"]);
      expect((await ask({ search: "pcs" })).items).toHaveLength(0);
      expect((await ask({ status: "DONE" })).meta.total).toBe(1);
      expect((await ask({ villaId: a.id })).meta.total).toBe(2);
      expect((await ask({ endFrom: day("2025-01-02"), endTo: day("2025-01-02") })).meta.total).toBe(2);
      expect((await ask({ startFrom: day("2025-01-03") })).meta.total).toBe(1);
      expect((await ask({ startTo: day("2025-01-01") })).meta.total).toBe(1);

      const page = await ask({ limit: 2, page: 2 });
      expect(page.items.map((item) => item.endDate)).toEqual(["2025-01-02", "2025-01-01"]);
      expect(page.meta.total).toBe(4);
    });

    // The days of a work are compared with the days of the alert window, in the application's zone. 2026-11-05 in Kuwait:
    // due soon from 16:00 local (13:00Z), overdue from the next midnight (21:00Z).
    describe("overdue and dueSoon, in SQL and in the flags, at the instants around the boundaries", () => {
      const at = (now: string) => new SmallWorksService(repository, () => new Date(now), KUWAIT);
      const instants = [
        "2026-11-05T12:59:59.000Z",
        "2026-11-05T13:00:00.000Z",
        "2026-11-05T20:59:59.000Z",
        "2026-11-05T21:00:00.000Z",
        "2026-11-05T21:00:01.000Z",
      ];

      it("gives a filter the same answer as the flag of the row", async () => {
        const villa = await newVilla();
        await works.create(
          actor,
          input(villa.id, "2026-11-01", { endDate: day("2026-11-05"), description: "pending" }),
          ctx,
        );
        await works.create(
          actor,
          input(villa.id, "2026-11-01", { endDate: day("2026-11-05"), description: "done", status: "DONE" }),
          ctx,
        );
        await works.create(
          actor,
          input(villa.id, "2026-11-01", { endDate: day("2026-11-04"), description: "late" }),
          ctx,
        );

        for (const now of instants) {
          const service = at(now);
          const page = await service.list({ page: 1, limit: 50, villaId: villa.id } as never);
          for (const flag of ["overdue", "dueSoon"] as const) {
            for (const wanted of [true, false]) {
              const filtered = await service.list({
                page: 1,
                limit: 50,
                villaId: villa.id,
                [flag]: wanted,
              } as never);
              expect(
                filtered.items.map((item) => item.description).sort(),
                `${flag}=${wanted} at ${now}`,
              ).toEqual(
                page.items
                  .filter((item) => item[flag] === wanted)
                  .map((item) => item.description)
                  .sort(),
              );
            }
          }
        }
      });

      it("flags the pending work on its deadline exactly: one second before 16:00 and 00:00 local, and at them", async () => {
        const villa = await newVilla();
        const work = await works.create(
          actor,
          input(villa.id, "2026-11-01", { endDate: day("2026-11-05") }),
          ctx,
        );
        const flags = async (now: string) => {
          const dto = await at(now).get(work.id, ctx);
          return [dto.dueSoon, dto.overdue, dto.deadlineAt];
        };

        expect(await flags("2026-11-05T12:59:59.000Z")).toEqual([false, false, "2026-11-05T21:00:00.000Z"]);
        expect(await flags("2026-11-05T13:00:00.000Z")).toEqual([true, false, "2026-11-05T21:00:00.000Z"]);
        expect(await flags("2026-11-05T20:59:59.000Z")).toEqual([true, false, "2026-11-05T21:00:00.000Z"]);
        expect(await flags("2026-11-05T21:00:00.000Z")).toEqual([false, true, "2026-11-05T21:00:00.000Z"]);
      });
    });
  });

  describe("the repository's locks and queries", () => {
    it("locks the villa shared; a villa that is gone is false", async () => {
      const villa = await newVilla();

      expect(await scratch.prisma.$transaction((t) => repository.lockVillaShared(villa.id, t))).toBe(true);
      expect(await scratch.prisma.$transaction((t) => repository.lockVillaShared("nope", t))).toBe(false);
    });

    it("locks the villas of an import and answers the ones that exist; a villa that is gone is missing", async () => {
      const a = await newVilla();
      const b = await newVilla();

      const locked = await scratch.prisma.$transaction((t) =>
        repository.lockVillasShared([a.id, "gone", b.id], t),
      );

      expect([...locked].sort()).toEqual([a.id, b.id].sort());
      expect([...(await scratch.prisma.$transaction((t) => repository.lockVillasShared([], t)))]).toEqual([]);
    });

    it("saves the rows of an import in one go and returns the ids it made", async () => {
      const villa = await newVilla();
      const base = {
        villaId: villa.id,
        contractorId: "c1",
        startDate: day("2026-09-01"),
        endDate: day("2026-09-02"),
        status: "PENDING" as const,
        createdById: "admin",
      };

      const ids = await repository.createMany(
        [
          { ...base, description: "Bulk 1" },
          { ...base, description: "Bulk 2" },
          { ...base, description: "d".repeat(500) },
        ],
        tx(),
      );

      expect(new Set(ids).size).toBe(3);
      expect(await countWorks(villa.id)).toBe(3);
    });

    it("reads every villa with its number for an import, and whether the acting user exists", async () => {
      const villa = await newVilla();

      expect((await repository.importVillas(tx())).find((entry) => entry.id === villa.id)).toEqual({
        id: villa.id,
        villaNumber: villa.number,
      });
      expect(await repository.userExists("admin", tx())).toBe(true);
      expect(await repository.userExists("nobody", tx())).toBe(false);
    });

    it("reads every contractor for an import, one contractor's status, and locks the contractors shared", async () => {
      expect((await repository.importContractors(tx())).find((entry) => entry.id === "c2")).toEqual({
        id: "c2",
        name: "Mona Co",
        phone: "0101",
        status: "ACTIVE",
      });
      expect(await repository.contractorStatus("c3", tx())).toBe("INACTIVE");
      expect(await repository.contractorStatus("nope", tx())).toBeNull();

      const locked = await scratch.prisma.$transaction((t) =>
        repository.lockContractorsShared(["c1", "gone", "c3"], t),
      );

      expect([...locked]).toEqual([
        ["c1", "ACTIVE"],
        ["c3", "INACTIVE"],
      ]);
    });

    it("changes and deletes a small work only at the version the caller read", async () => {
      const villa = await newVilla();
      const work = await works.create(actor, input(villa.id, "2026-09-10"), ctx);

      expect(await repository.update(work.id, work.version + 1, { description: "Changed" }, tx())).toBeNull();
      expect(await repository.delete(work.id, work.version + 1, tx())).toBe(false);
      expect(
        (await q(`SELECT "description", "version" FROM "DailySmallWork" WHERE "id" = $1`, [work.id])).rows[0],
      ).toEqual({
        description: "Replaced a socket",
        version: work.version,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await repository.update(work.id, work.version, { description: "Changed" }, tx());
      expect(updated).toMatchObject({ description: "Changed", version: work.version + 1 });
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(new Date(work.updatedAt).getTime());
      expect(await repository.delete(work.id, work.version + 1, tx())).toBe(true);
      expect(await countWorks(villa.id)).toBe(0);
    });

    it("locks the row so that nothing else can even share it until the transaction ends", async () => {
      const villa = await newVilla();
      const work = await works.create(actor, input(villa.id, "2026-09-11"), ctx);

      const refusal = await scratch.prisma.$transaction(async (t) => {
        expect(await repository.lockVersion(work.id, t)).toBe(work.version);
        // Another connection asks for the weakest lock there is: a shared lock would be refused only by an exclusive one.
        return q(`SELECT 1 FROM "DailySmallWork" WHERE "id" = $1 FOR SHARE NOWAIT`, [work.id]).then(
          () => null,
          (err: { code?: string }) => err.code ?? "error",
        );
      });

      expect(refusal).toBe("55P03");
    });

    it("takes the villa's lock shared: two writers hold it at once, a delete of the villa has to wait", async () => {
      const villa = await newVilla();

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
    it("lets four simultaneous creates for one villa and day all succeed: no natural key, no conflict", async () => {
      const villa = await newVilla();

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => works.create(actor, input(villa.id, "2026-10-01"), ctx)),
      );

      assertNoCrash(results, "four creates");
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(await countWorks(villa.id)).toBe(4);
    });

    it("lets exactly one of two simultaneous updates with the same If-Match win, the other gets 409 VERSION_CONFLICT", async () => {
      const villa = await newVilla();
      const work = await works.create(actor, input(villa.id, "2026-10-02"), ctx);

      const results = await Promise.allSettled([
        works.update(actor, work.id, { description: "First" }, ctx, 1),
        works.update(actor, work.id, { description: "Second" }, ctx, 1),
      ]);

      assertNoCrash(results, "two updates");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect((await works.get(work.id, ctx)).version).toBe(2);
    });

    it("never deadlocks an update and a delete of the same row: one wins, the other is 404 or 409", async () => {
      for (let round = 0; round < 6; round += 1) {
        const villa = await newVilla();
        const work = await works.create(actor, input(villa.id, "2026-10-03"), ctx);

        const results = await Promise.allSettled([
          works.update(actor, work.id, { description: "Changed" }, ctx),
          works.remove(actor, work.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete, round ${round}`);
        expect(await countWorks(villa.id)).toBe(0);
      }
    });

    it("never deadlocks a create and the delete of its villa: the small work exists and the villa stays, or neither", async () => {
      for (let round = 0; round < 8; round += 1) {
        const villa = await newVilla();

        const results = await Promise.allSettled([
          works.create(actor, input(villa.id, "2026-10-05"), ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `create vs delete villa, round ${round}`);
        const villaLeft = (await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount;
        const worksLeft = await countWorks(villa.id);
        expect(villaLeft === 1 || worksLeft === 0, "a small work never outlives its villa").toBe(true);
        if (worksLeft === 1) expect(villaLeft).toBe(1);
      }
    });

    it("never deadlocks an update of a small work and the delete of its villa", async () => {
      for (let round = 0; round < 6; round += 1) {
        const villa = await newVilla();
        const work = await works.create(actor, input(villa.id, "2026-10-06"), ctx);

        const results = await Promise.allSettled([
          works.update(actor, work.id, { description: "Changed" }, ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete villa, round ${round}`);
        // The villa has a small work, so its delete is refused whichever came first.
        expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(1);
        expect(await countWorks(villa.id)).toBe(1);
      }
    });
  });

  describe("the import", () => {
    it("saves a file whole: 201, the rows, PENDING by default, the importer as creator, one audit entry", async () => {
      const a = await newVilla();
      const b = await newVilla();
      const file = await fileOf(
        row(a.number, "2026-03-04", { description: "First", status: "Done" }),
        row(a.number, "2026-03-04", { description: "Second" }),
        row(b.number, "2026-03-04", { description: "d".repeat(500) }),
        row(b.number, "2026-03-05", { contractor: "Mona Co", endDate: "2026-03-09" }),
      );

      const outcome = await run(file);

      expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 4 } });
      const stored = (
        await q(
          `SELECT "villaId", "status", "createdById", "version", "description", "contractorId", "startDate"::text AS "start", "endDate"::text AS "end"
           FROM "DailySmallWork" WHERE "villaId" = ANY($1) ORDER BY "villaId", "startDate", "description"`,
          [[a.id, b.id]],
        )
      ).rows;
      expect(stored.map((entry) => entry.status)).toEqual(["DONE", "PENDING", "PENDING", "PENDING"]);
      expect(stored.every((entry) => entry.createdById === "admin" && entry.version === 1)).toBe(true);
      expect(stored[2].description).toHaveLength(500);
      expect(stored.map((entry) => entry.contractorId)).toEqual(["c1", "c1", "c1", "c2"]);
      expect(stored[3]).toMatchObject({ start: "2026-03-05", end: "2026-03-09" });
      const audit = await q(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'small_work.import' AND "after"->>'rows' = '4'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("saves two identical rows: there is no natural key", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-06"), row(a.number, "2026-03-06"));

      expect(await run(file)).toMatchObject({ status: 201, report: { imported: 2 } });
      expect(await countWorks(a.id)).toBe(2);
    });

    it("answers 422, never a database error, for a description of 501 characters, and saves nothing", async () => {
      const a = await newVilla();
      const file = await fileOf(
        row(a.number, "2026-03-07"),
        row(a.number, "2026-03-08", { description: "d".repeat(501) }),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column])).toEqual([[3, "Description"]]);
      expect(await countWorks(a.id)).toBe(0);
    });

    it("answers 422 for an inactive, unknown or ambiguous contractor and for a range that runs backwards, saving nothing", async () => {
      const a = await newVilla();
      const file = await fileOf(
        row(a.number, "2026-03-07", { contractor: "Off Co" }),
        row(a.number, "2026-03-07", { contractor: "Nobody Co" }),
        row(a.number, "2026-03-07", { endDate: "2026-03-06" }),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
        [2, "Contractor", "INVALID_VALUE"],
        [3, "Contractor", "REFERENCE_NOT_FOUND"],
        [4, "End Date", "INVALID_VALUE"],
      ]);
      expect(await countWorks(a.id)).toBe(0);
    });

    it("races the switching off of a contractor of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 4; round += 1) {
        const villa = await newVilla();
        const contractorId = `race${round}`;
        await q(`INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ($1,$2,$3,now())`, [
          contractorId,
          `Race Co ${round}`,
          `07${round}`,
        ]);
        const file = await fileOf(row(villa.number, "2026-04-20", { contractor: `Race Co ${round}` }));

        const results = await Promise.allSettled([
          run(file),
          q(`UPDATE "Contractor" SET "status" = 'INACTIVE' WHERE "id" = $1`, [contractorId]),
        ]);

        assertNoCrash(results, `import vs switching a contractor off, round ${round}`);
        expect([0, 1]).toContain(await countWorks(villa.id));
      }
    });

    it("saves nothing when one row of the file is bad", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-09"), row("NOPE-1", "2026-03-09"));

      expect(await run(file)).toMatchObject({ status: 422 });
      expect(await countWorks(a.id)).toBe(0);
    });

    it("answers a dry run without writing, and an identical file twice with 409 FILE_ALREADY_IMPORTED", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-20"));

      expect(await run(file, true)).toMatchObject({ status: 200 });
      expect(await countWorks(a.id)).toBe(0);
      expect(await run(file)).toMatchObject({ status: 201 });
      await expect(run(file)).rejects.toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
      expect(await countWorks(a.id)).toBe(1);
    });

    it("races a create for a day of the file: both succeed, the file is saved whole", async () => {
      for (let round = 0; round < 4; round += 1) {
        const villa = await newVilla();
        const file = await fileOf(
          row(villa.number, "2026-04-01"),
          row(villa.number, "2026-04-02"),
          row(villa.number, "2026-04-03"),
        );

        const results = await Promise.allSettled([
          run(file),
          works.create(actor, input(villa.id, "2026-04-02", { description: "By hand" }), ctx),
        ]);

        assertNoCrash(results, `import vs create, round ${round}`);
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        expect(saved(results[0]!)).toBe(true);
        expect(await countWorks(villa.id)).toBe(4);
      }
    });

    it("races the delete of a villa of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 6; round += 1) {
        const keep = await newVilla();
        const doomed = await newVilla();
        const file = await fileOf(row(keep.number, "2026-04-10"), row(doomed.number, "2026-04-10"));

        const results = await Promise.allSettled([run(file), villas.remove(actor, doomed.id, ctx)]);

        assertNoCrash(results, `import vs delete villa, round ${round}`);
        const total = (await countWorks(keep.id)) + (await countWorks(doomed.id));
        expect([0, 2]).toContain(total);
        if (total === 2) {
          expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [doomed.id])).rowCount).toBe(1);
        }
      }
    });

    it("races another import of the same villa: both finish, every row is saved once", async () => {
      const villa = await newVilla();
      const first = await fileOf(row(villa.number, "2026-05-01"), row(villa.number, "2026-05-02"));
      const second = await fileOf(row(villa.number, "2026-05-03"), row(villa.number, "2026-05-04"));

      const results = await Promise.allSettled([run(first), run(second)]);

      assertNoCrash(results, "two imports");
      expect(results.every(saved)).toBe(true);
      expect(await countWorks(villa.id)).toBe(4);
    });

    it("races four copies of one file: exactly one is saved, the others are 409 FILE_ALREADY_IMPORTED", async () => {
      const villa = await newVilla();
      const file = await fileOf(row(villa.number, "2026-06-01"));

      const results = await Promise.allSettled([run(file), run(file), run(file), run(file)]);

      assertNoCrash(results, "four copies");
      expect(results.filter(saved)).toHaveLength(1);
      expect(await countWorks(villa.id)).toBe(1);
    });
  });
});
