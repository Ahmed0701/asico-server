import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The site reports on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end (in a
// `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It COMMITS
// inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the repository's SQL (list, locks, import queries); the rating, the date and the long texts round trip
// exactly; writers that share a villa (create, update, delete, the villa's delete, an import) never deadlock and never leave
// a file half saved. At most four jobs run at once here: the pool is small on purpose (see CONNECTION BUDGET in scratch.ts).
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { SiteReportsRepository } from "../../src/modules/site-reports/repository/site-reports.repository.js";
import { SiteReportsImportService } from "../../src/modules/site-reports/service/site-reports-import.service.js";
import { SiteReportsService } from "../../src/modules/site-reports/service/site-reports.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const HEADER = [
  "Villa Number",
  "Title",
  "Visit Date",
  "Inspector",
  "Type",
  "Rating",
  "Findings",
  "Recommendations",
];
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!RUN)("the site reports on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const repository = new SiteReportsRepository();
  const reports = new SiteReportsService();
  const importer = new SiteReportsImportService();
  const villas = new VillasService();
  const actor: Actor = { id: "admin", role: "ADMIN" };
  const tx = () => scratch.prisma as unknown as Prisma.TransactionClient;

  beforeAll(async () => {
    scratch = await openScratch("scratch12d", 5);
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

  const input = (villaId: string, visitDate: string, extra: Record<string, unknown> = {}) => ({
    villaId,
    title: "First fix check",
    visitDate: day(visitDate),
    inspector: "Eng. Hamdy",
    type: "INSPECTION" as const,
    rating: 4,
    findings: "All good",
    ...extra,
  });
  const countReports = async (villaId: string): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "SiteReport" WHERE "villaId" = $1`, [villaId])).rows[0].n;

  let fileCounter = 0;
  // A different file every time, so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  const row = (villa: string, date: string, extra: Partial<Record<string, unknown>> = {}) => [
    villa,
    extra.title ?? "Round",
    date,
    extra.inspector ?? "Hamdy",
    extra.type ?? "Safety",
    extra.rating ?? 3,
    extra.findings ?? "Fine",
    extra.recommendations ?? null,
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
    it("creates a site report with the creator and audit, in one transaction", async () => {
      const villa = await newVilla();

      const report = await reports.create(actor, input(villa.id, "2026-03-01"), ctx);

      expect(report).toMatchObject({
        visitDate: "2026-03-01",
        rating: 4,
        type: "INSPECTION",
        recommendations: null,
        createdBy: { id: "admin", name: "Root Admin" },
        version: 1,
      });
      const audit = await q(`SELECT "action", "entity" FROM "AuditLog" WHERE "entityId" = $1`, [report.id]);
      expect(audit.rows).toEqual([{ action: "site_report.create", entity: "SiteReport" }]);
    });

    it.each([1, 2, 3, 4, 5])(
      "round-trips the rating %s through create, get, update and the list",
      async (rating) => {
        const villa = await newVilla();

        const created = await reports.create(actor, input(villa.id, "2026-03-02", { rating }), ctx);
        expect(created.rating).toBe(rating);
        expect((await reports.get(created.id, ctx)).rating).toBe(rating);
        const listed = await reports.list({ page: 1, limit: 20, villaId: villa.id } as never);
        expect(listed.items.map((item) => item.rating)).toEqual([rating]);

        const other = rating === 1 ? 5 : 1;
        expect((await reports.update(actor, created.id, { rating: other }, ctx)).rating).toBe(other);
      },
    );

    it("stores the longest title, inspector, findings and recommendations the validators let through, Arabic included", async () => {
      const villa = await newVilla();

      const created = await reports.create(
        actor,
        input(villa.id, "2026-03-03", {
          title: "ش".repeat(150),
          inspector: "n".repeat(100),
          findings: "ف".repeat(5000),
          recommendations: "r".repeat(5000),
        }),
        ctx,
      );

      expect(created.title).toHaveLength(150);
      expect(created.findings).toHaveLength(5000);
      expect(created.recommendations).toHaveLength(5000);
      const back = await reports.get(created.id, ctx);
      expect([back.title, back.inspector, back.findings, back.recommendations]).toEqual([
        "ش".repeat(150),
        "n".repeat(100),
        "ف".repeat(5000),
        "r".repeat(5000),
      ]);
    });

    it("keeps the visit date as the calendar day it was given, whatever the clock of the server", async () => {
      const villa = await newVilla();

      const created = await reports.create(actor, input(villa.id, "2026-01-01"), ctx);

      expect(created.visitDate).toBe("2026-01-01");
      expect(
        (await q(`SELECT "visitDate"::text AS d FROM "SiteReport" WHERE "id" = $1`, [created.id])).rows[0].d,
      ).toBe("2026-01-01");
    });

    it("refuses a visit date more than a day ahead with 400 and saves nothing", async () => {
      const villa = await newVilla();
      const far = new Date(Date.now() + 3 * 86_400_000);

      await expect(
        reports.create(actor, input(villa.id, "2026-03-01", { visitDate: far }), ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
      expect(await countReports(villa.id)).toBe(0);
    });

    it("updates with If-Match, answers 409 VERSION_CONFLICT on a stale version, and clears the recommendations", async () => {
      const villa = await newVilla();
      const a = await reports.create(
        actor,
        input(villa.id, "2026-03-01", { recommendations: "Redo it" }),
        ctx,
      );

      const updated = await reports.update(
        actor,
        a.id,
        { visitDate: day("2026-03-10"), type: "QUALITY", recommendations: null, inspector: "Mona" },
        ctx,
        1,
      );

      expect(updated).toMatchObject({
        visitDate: "2026-03-10",
        type: "QUALITY",
        recommendations: null,
        inspector: "Mona",
        version: 2,
      });
      await expect(reports.update(actor, a.id, { rating: 2 }, ctx, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      expect((await reports.get(a.id, ctx)).version).toBe(2);
    });

    it("lets the same visit be saved twice for one villa and day: there is no natural key", async () => {
      const villa = await newVilla();

      await reports.create(actor, input(villa.id, "2026-03-04"), ctx);
      await reports.create(actor, input(villa.id, "2026-03-04"), ctx);

      expect(await countReports(villa.id)).toBe(2);
    });

    it("deletes with If-Match, and a site report that is gone is 404", async () => {
      const villa = await newVilla();
      const a = await reports.create(actor, input(villa.id, "2026-03-01"), ctx);

      await expect(reports.remove(actor, a.id, ctx, 9)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      await reports.remove(actor, a.id, ctx, 1);

      await expect(reports.get(a.id, ctx)).rejects.toMatchObject({ code: "SITE_REPORT_NOT_FOUND" });
      await expect(reports.remove(actor, a.id, ctx)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("keeps a villa that has a site report: 409 VILLA_HAS_RECORDS, and the FK is the backstop", async () => {
      const villa = await newVilla();
      await reports.create(actor, input(villa.id, "2026-03-01"), ctx);

      await expect(villas.remove(actor, villa.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VILLA_HAS_RECORDS",
      });
      await expect(q(`DELETE FROM "Villa" WHERE "id" = $1`, [villa.id])).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
    });

    it("lets the villa go once its site reports are deleted", async () => {
      const villa = await newVilla();
      const a = await reports.create(actor, input(villa.id, "2026-03-01"), ctx);
      await reports.remove(actor, a.id, ctx);

      await villas.remove(actor, villa.id, ctx);

      expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(0);
    });

    it("answers 404 VILLA_NOT_FOUND for a villa that does not exist, and writes nothing", async () => {
      await expect(reports.create(actor, input("nope", "2026-03-01"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("keeps the report, with no author, when its author is deleted", async () => {
      const villa = await newVilla();
      await q(
        `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('gone','Gone','g@x.test','x','EMPLOYEE',now())`,
      );
      const created = await reports.create(
        { id: "gone", role: "EMPLOYEE" },
        input(villa.id, "2026-03-05"),
        ctx,
      );
      expect(created.createdBy).toEqual({ id: "gone", name: "Gone" });

      await q(`DELETE FROM "User" WHERE "id" = 'gone'`);

      expect((await reports.get(created.id, ctx)).createdBy).toBeNull();
    });
  });

  describe("the list", () => {
    it("filters, searches, sorts and pages in SQL, with the same WHERE for the count; the villa number sorts naturally", async () => {
      const a = await newVilla();
      const b = await newVilla();
      const c = await newVilla();
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-2' WHERE "id" = $1`, [a.id]);
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-10' WHERE "id" = $1`, [b.id]);
      await q(`UPDATE "Villa" SET "villaNumber" = 'L-1' WHERE "id" = $1`, [c.id]);
      await reports.create(
        actor,
        input(a.id, "2025-01-01", { title: "100% slab check", rating: 5, type: "QUALITY" }),
        ctx,
      );
      await reports.create(
        actor,
        input(a.id, "2025-01-02", { title: "Cable_tray", rating: 2, type: "SAFETY" }),
        ctx,
      );
      await reports.create(
        actor,
        input(b.id, "2025-01-02", { title: "Formwork", rating: 4, inspector: "Karim" }),
        ctx,
      );
      await reports.create(actor, input(c.id, "2025-01-03", { title: "Plaster", rating: 1 }), ctx);
      const ask = (query: Record<string, unknown>) =>
        reports.list({
          page: 1,
          limit: 20,
          visitFrom: day("2025-01-01"),
          visitTo: day("2025-01-31"),
          ...query,
        } as never);

      const all = await ask({});
      expect(all.meta.total).toBe(4);
      expect(all.items.map((item) => item.visitDate)).toEqual([
        "2025-01-03",
        "2025-01-02",
        "2025-01-02",
        "2025-01-01",
      ]);

      const natural = await ask({ sort: "villaNumber:asc" });
      expect(natural.items.map((item) => item.villa.villaNumber)).toEqual(["L-1", "L-2", "L-2", "L-10"]);
      // The reports of one villa come newest first.
      expect(
        natural.items.filter((item) => item.villa.villaNumber === "L-2").map((item) => item.visitDate),
      ).toEqual(["2025-01-02", "2025-01-01"]);

      expect((await ask({ sort: "rating:asc" })).items.map((item) => item.rating)).toEqual([1, 2, 4, 5]);
      expect((await ask({ sort: "rating:desc" })).items.map((item) => item.rating)).toEqual([5, 4, 2, 1]);

      const byType = await ask({ sort: "type:asc" });
      expect(byType.items.map((item) => item.type)).toEqual([
        "INSPECTION",
        "INSPECTION",
        "SAFETY",
        "QUALITY",
      ]);

      expect((await ask({ search: "100%" })).items).toHaveLength(1);
      expect((await ask({ search: "Cable_tray" })).items).toHaveLength(1);
      expect((await ask({ search: "cable-tray" })).items).toHaveLength(0);
      expect((await ask({ search: "karim" })).items).toHaveLength(1);
      expect((await ask({ search: "L-10" })).items.map((item) => item.title)).toEqual(["Formwork"]);
      expect((await ask({ search: "All good" })).items).toHaveLength(0);
      expect((await ask({ type: "SAFETY" })).meta.total).toBe(1);
      expect((await ask({ rating: 4 })).items.map((item) => item.title)).toEqual(["Formwork"]);
      expect((await ask({ rating: 3 })).meta.total).toBe(0);
      expect((await ask({ villaId: a.id })).meta.total).toBe(2);
      expect((await ask({ visitFrom: day("2025-01-02"), visitTo: day("2025-01-02") })).meta.total).toBe(2);

      const page = await ask({ limit: 2, page: 2 });
      expect(page.items.map((item) => item.visitDate)).toEqual(["2025-01-02", "2025-01-01"]);
      expect(page.meta.total).toBe(4);
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
        title: "Bulk",
        visitDate: day("2026-09-01"),
        inspector: "Hamdy",
        type: "PROGRESS" as const,
        findings: "Fine",
        recommendations: null,
        createdById: "admin",
      };

      const ids = await repository.createMany(
        [
          { ...base, rating: 1 },
          { ...base, rating: 3, recommendations: "Again" },
          { ...base, rating: 5 },
        ],
        tx(),
      );

      expect(new Set(ids).size).toBe(3);
      const stored = (
        await q(
          `SELECT "rating", "recommendations" FROM "SiteReport" WHERE "id" = ANY($1) ORDER BY "rating"`,
          [ids],
        )
      ).rows;
      expect(stored).toEqual([
        { rating: 1, recommendations: null },
        { rating: 3, recommendations: "Again" },
        { rating: 5, recommendations: null },
      ]);
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

    it("changes and deletes a site report only at the version the caller read", async () => {
      const villa = await newVilla();
      const report = await reports.create(actor, input(villa.id, "2026-09-10"), ctx);

      expect(await repository.update(report.id, report.version + 1, { rating: 1 }, tx())).toBeNull();
      expect(await repository.delete(report.id, report.version + 1, tx())).toBe(false);
      expect(
        (await q(`SELECT "rating", "version" FROM "SiteReport" WHERE "id" = $1`, [report.id])).rows[0],
      ).toEqual({ rating: 4, version: report.version });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await repository.update(report.id, report.version, { rating: 1, title: "Again" }, tx());
      expect(updated).toMatchObject({ rating: 1, title: "Again", version: report.version + 1 });
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(new Date(report.updatedAt).getTime());
      expect(await repository.delete(report.id, report.version + 1, tx())).toBe(true);
      expect(await countReports(villa.id)).toBe(0);
    });

    it("locks the row so that nothing else can even share it until the transaction ends", async () => {
      const villa = await newVilla();
      const report = await reports.create(actor, input(villa.id, "2026-09-11"), ctx);

      const refusal = await scratch.prisma.$transaction(async (t) => {
        expect(await repository.lockVersion(report.id, t)).toBe(report.version);
        // Another connection asks for the weakest lock there is: a shared lock would be refused only by an exclusive one.
        return q(`SELECT 1 FROM "SiteReport" WHERE "id" = $1 FOR SHARE NOWAIT`, [report.id]).then(
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
        Array.from({ length: 4 }, () => reports.create(actor, input(villa.id, "2026-10-01"), ctx)),
      );

      assertNoCrash(results, "four creates");
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(await countReports(villa.id)).toBe(4);
    });

    it("lets exactly one of two simultaneous updates with the same If-Match win, the other gets 409 VERSION_CONFLICT", async () => {
      const villa = await newVilla();
      const report = await reports.create(actor, input(villa.id, "2026-10-02"), ctx);

      const results = await Promise.allSettled([
        reports.update(actor, report.id, { rating: 1 }, ctx, 1),
        reports.update(actor, report.id, { rating: 2 }, ctx, 1),
      ]);

      assertNoCrash(results, "two updates");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
      expect((await reports.get(report.id, ctx)).version).toBe(2);
    });

    it("never deadlocks an update and a delete of the same row: one wins, the other is 404 or 409", async () => {
      for (let round = 0; round < 6; round += 1) {
        const villa = await newVilla();
        const report = await reports.create(actor, input(villa.id, "2026-10-03"), ctx);

        const results = await Promise.allSettled([
          reports.update(actor, report.id, { rating: 2 }, ctx),
          reports.remove(actor, report.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete, round ${round}`);
        expect(await countReports(villa.id)).toBe(0);
      }
    });

    it("never deadlocks a create and the delete of its villa: the report exists and the villa stays, or neither", async () => {
      for (let round = 0; round < 8; round += 1) {
        const villa = await newVilla();

        const results = await Promise.allSettled([
          reports.create(actor, input(villa.id, "2026-10-05"), ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `create vs delete villa, round ${round}`);
        const villaLeft = (await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount;
        const reportsLeft = await countReports(villa.id);
        expect(villaLeft === 1 || reportsLeft === 0, "a site report never outlives its villa").toBe(true);
        if (reportsLeft === 1) expect(villaLeft).toBe(1);
      }
    });

    it("never deadlocks an update of a site report and the delete of its villa", async () => {
      for (let round = 0; round < 6; round += 1) {
        const villa = await newVilla();
        const report = await reports.create(actor, input(villa.id, "2026-10-06"), ctx);

        const results = await Promise.allSettled([
          reports.update(actor, report.id, { rating: 1 }, ctx),
          villas.remove(actor, villa.id, ctx),
        ]);

        assertNoCrash(results, `update vs delete villa, round ${round}`);
        // The villa has a site report, so its delete is refused whichever came first.
        expect((await q(`SELECT 1 FROM "Villa" WHERE "id" = $1`, [villa.id])).rowCount).toBe(1);
        expect(await countReports(villa.id)).toBe(1);
      }
    });
  });

  describe("the import", () => {
    it("saves a file whole: 201, the rows, the importer as creator, the longest texts, one audit entry", async () => {
      const a = await newVilla();
      const b = await newVilla();
      const file = await fileOf(
        row(a.number, "2026-03-04", { type: "Quality", rating: 1 }),
        row(a.number, "2026-03-04", { rating: "5", recommendations: "Redo" }),
        row(b.number, "2026-03-04", {
          title: "t".repeat(150),
          inspector: "n".repeat(100),
          findings: "f".repeat(5000),
          recommendations: "r".repeat(5000),
        }),
        row(b.number, "2026-03-05", { type: "PROGRESS", rating: 3 }),
      );

      const outcome = await run(file);

      expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 4 } });
      const stored = (
        await q(
          `SELECT "villaId", "type", "rating", "createdById", "version", "title", "inspector", "findings", "recommendations"
           FROM "SiteReport" WHERE "villaId" = ANY($1) ORDER BY "villaId", "visitDate", "rating"`,
          [[a.id, b.id]],
        )
      ).rows;
      expect(stored.map((entry) => [entry.type, entry.rating])).toEqual([
        ["QUALITY", 1],
        ["SAFETY", 5],
        ["SAFETY", 3],
        ["PROGRESS", 3],
      ]);
      expect(stored.every((entry) => entry.createdById === "admin" && entry.version === 1)).toBe(true);
      expect(stored[0].recommendations).toBeNull();
      expect(stored[1].recommendations).toBe("Redo");
      expect(stored[2].title).toHaveLength(150);
      expect(stored[2].inspector).toHaveLength(100);
      expect(stored[2].findings).toHaveLength(5000);
      expect(stored[2].recommendations).toHaveLength(5000);
      const audit = await q(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'site_report.import' AND "after"->>'rows' = '4'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("saves two identical rows: there is no natural key", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-06"), row(a.number, "2026-03-06"));

      expect(await run(file)).toMatchObject({ status: 201, report: { imported: 2 } });
      expect(await countReports(a.id)).toBe(2);
    });

    it.each([
      ["0", 0],
      ["6", 6],
      ["a negative", -1],
      ["a fraction", 2.5],
      ["a fraction as text", "2.5"],
      ["a huge number", 32768],
    ])(
      "answers 422, never a database error, for a rating of %s, and saves nothing",
      async (_name, rating) => {
        const a = await newVilla();
        const file = await fileOf(row(a.number, "2026-03-07"), row(a.number, "2026-03-08", { rating }));

        const outcome = await run(file);

        expect(outcome.status).toBe(422);
        expect(outcome.report.errors.map((error) => [error.row, error.column])).toEqual([[3, "Rating"]]);
        expect(await countReports(a.id)).toBe(0);
      },
    );

    it("answers 422 for a date more than a day ahead and for a title one character over its limit, and saves nothing", async () => {
      const a = await newVilla();
      const far = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const file = await fileOf(
        row(a.number, far),
        row(a.number, "2026-03-09", { title: "t".repeat(151) }),
        row(a.number, "2026-03-09", { inspector: "n".repeat(101) }),
      );

      const outcome = await run(file);

      expect(outcome.status).toBe(422);
      expect(outcome.report.errors.map((error) => [error.row, error.column])).toEqual([
        [2, "Visit Date"],
        [3, "Title"],
        [4, "Inspector"],
      ]);
      expect(await countReports(a.id)).toBe(0);
    });

    it("refuses a file with a findings cell over 5,000 characters as a whole, with a client error, and saves nothing", async () => {
      const a = await newVilla();
      const file = await fileOf(
        row(a.number, "2026-03-09"),
        row(a.number, "2026-03-09", { findings: "f".repeat(5001) }),
      );

      await expect(run(file)).rejects.toMatchObject({ statusCode: 422 });
      expect(await countReports(a.id)).toBe(0);
    });

    it("saves nothing when one row of the file is bad", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-09"), row("NOPE-1", "2026-03-09"));

      expect(await run(file)).toMatchObject({ status: 422 });
      expect(await countReports(a.id)).toBe(0);
    });

    it("answers a dry run without writing, and an identical file twice with 409 FILE_ALREADY_IMPORTED", async () => {
      const a = await newVilla();
      const file = await fileOf(row(a.number, "2026-03-20"));

      expect(await run(file, true)).toMatchObject({ status: 200 });
      expect(await countReports(a.id)).toBe(0);
      expect(await run(file)).toMatchObject({ status: 201 });
      await expect(run(file)).rejects.toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
      expect(await countReports(a.id)).toBe(1);
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
          reports.create(actor, input(villa.id, "2026-04-02", { title: "By hand" }), ctx),
        ]);

        assertNoCrash(results, `import vs create, round ${round}`);
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        expect(saved(results[0]!)).toBe(true);
        expect(await countReports(villa.id)).toBe(4);
      }
    });

    it("races the delete of a villa of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 6; round += 1) {
        const keep = await newVilla();
        const doomed = await newVilla();
        const file = await fileOf(row(keep.number, "2026-04-10"), row(doomed.number, "2026-04-10"));

        const results = await Promise.allSettled([run(file), villas.remove(actor, doomed.id, ctx)]);

        assertNoCrash(results, `import vs delete villa, round ${round}`);
        const total = (await countReports(keep.id)) + (await countReports(doomed.id));
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
      expect(await countReports(villa.id)).toBe(4);
    });

    it("races four copies of one file: exactly one is saved, the others are 409 FILE_ALREADY_IMPORTED", async () => {
      const villa = await newVilla();
      const file = await fileOf(row(villa.number, "2026-06-01"));

      const results = await Promise.allSettled([run(file), run(file), run(file), run(file)]);

      assertNoCrash(results, "four copies");
      expect(results.filter(saved)).toHaveLength(1);
      expect(await countReports(villa.id)).toBe(1);
    });
  });
});
