import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RESTRICT_CODES } from "./connection.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The daily reports on a real PostgreSQL, in a scratch schema that is created for this run and dropped at the end (in a
// `finally`, so a failure drops it too). No database is created or reset, and the asico schema is never touched. It COMMITS
// inside the scratch schema, which is why it is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
//
// What it checks: the repository's SQL (list, locks, import queries); the one report per contractor per day under concurrent
// writes; and that writers and importers that share a contractor or an electrical engineer (create, update, delete, a
// switch-off, an import) never deadlock and never leave a file half saved. A report belongs to no villa.
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { AppError } from "../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { DailyReportsRepository } from "../../src/modules/daily-reports/repository/daily-reports.repository.js";
import { DailyReportsImportService } from "../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { DailyReportsService } from "../../src/modules/daily-reports/service/daily-reports.service.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const HEADER = ["Report Date", "Contractor", "Electrical Engineer", "Weather", "Workers", "Notes"];
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(!RUN)("the daily reports on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  const repository = new DailyReportsRepository();
  const reports = new DailyReportsService();
  const importer = new DailyReportsImportService();
  const actor: Actor = { id: "admin", role: "ADMIN" };
  const tx = () => scratch.prisma as unknown as Prisma.TransactionClient;

  beforeAll(async () => {
    scratch = await openScratch("scratch10d", 20);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES
        ('con1','Nile','010','ACTIVE',now()), ('con2','Giza','011','ACTIVE',now()), ('con3','Old Co','012','INACTIVE',now())`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","status","updatedAt") VALUES
        ('el1','Mona','0120','ACTIVE',now()), ('el2','Karim','0121','ACTIVE',now()), ('el3','Retired','0122','INACTIVE',now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  let counter = 0;
  // A contractor of its own, so a test never meets another test's reports.
  async function newContractor(
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  ): Promise<{ id: string; name: string }> {
    counter += 1;
    const id = `c${counter}`;
    const name = `Contractor ${counter}`;
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ($1,$2,$3,$4::"PartyStatus",now())`,
      [id, name, `050${counter}`, status],
    );
    return { id, name };
  }
  async function newEngineer(): Promise<{ id: string; name: string }> {
    counter += 1;
    const id = `e${counter}`;
    const name = `Engineer ${counter}`;
    await q(`INSERT INTO "ElectricalEngineer" ("id","name","phone","updatedAt") VALUES ($1,$2,$3,now())`, [
      id,
      name,
      `060${counter}`,
    ]);
    return { id, name };
  }

  const input = (contractorId: string, reportDate: string, extra: Record<string, unknown> = {}) => ({
    contractorId,
    preparedByEngineerId: "el1",
    reportDate: day(reportDate),
    weather: "SUNNY" as const,
    workersCount: 10,
    notes: "Work",
    ...extra,
  });
  const countReports = async (contractorId: string): Promise<number> =>
    (await q(`SELECT count(*)::int AS n FROM "DailyReport" WHERE "contractorId" = $1`, [contractorId]))
      .rows[0].n;

  let fileCounter = 0;
  // A different file every time, so that the file itself is never what stops an import.
  const fileOf = (...rows: unknown[][]): Promise<Buffer> => {
    fileCounter += 1;
    return workbookOf([HEADER, ...(rows as never[][])], { sheetName: `Sheet ${fileCounter}` });
  };
  const row = (contractor: string, date: string, extra: Partial<Record<string, unknown>> = {}) => [
    date,
    contractor,
    extra.engineer ?? "Mona",
    "Sunny",
    5,
    extra.notes ?? null,
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
    it("creates a report with its contractor, engineer and creator, and audit, in one transaction", async () => {
      const contractor = await newContractor();

      const report = await reports.create(actor, input(contractor.id, "2026-03-01", { notes: "Late" }), ctx);

      expect(report).toMatchObject({
        reportDate: "2026-03-01",
        contractor: { id: contractor.id, name: contractor.name },
        preparedBy: { id: "el1", name: "Mona" },
        createdBy: { id: "admin", name: "Root Admin" },
        notes: "Late",
        version: 1,
      });
      const audit = await q(`SELECT "action", "entity" FROM "AuditLog" WHERE "entityId" = $1`, [report.id]);
      expect(audit.rows).toEqual([{ action: "daily_report.create", entity: "DailyReport" }]);
    });

    it("keeps 5,000 characters of notes whole, and a date as the same calendar day", async () => {
      const contractor = await newContractor();

      const report = await reports.create(
        actor,
        input(contractor.id, "2026-03-31", { notes: "n".repeat(5000) }),
        ctx,
      );

      const stored = await reports.get(report.id, ctx);
      expect(stored.notes).toHaveLength(5000);
      expect(stored.reportDate).toBe("2026-03-31");
    });

    it("answers 409 DAILY_REPORT_EXISTS for a second report of the same contractor and day, on the unique index", async () => {
      const contractor = await newContractor();
      await reports.create(actor, input(contractor.id, "2026-03-01"), ctx);

      await expect(reports.create(actor, input(contractor.id, "2026-03-01"), ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "DAILY_REPORT_EXISTS",
      });
      expect(await countReports(contractor.id)).toBe(1);
    });

    it("lets two contractors report the same day, and one engineer prepare both", async () => {
      const a = await newContractor();
      const b = await newContractor();

      await reports.create(actor, input(a.id, "2026-03-02"), ctx);
      await reports.create(actor, input(b.id, "2026-03-02"), ctx);

      expect(await countReports(a.id)).toBe(1);
      expect(await countReports(b.id)).toBe(1);
    });

    it("refuses a contractor or an engineer that is unknown (404) or inactive (400)", async () => {
      const contractor = await newContractor();

      await expect(reports.create(actor, input("nope", "2026-03-02"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "CONTRACTOR_NOT_FOUND",
      });
      await expect(reports.create(actor, input("con3", "2026-03-02"), ctx)).rejects.toMatchObject({
        statusCode: 400,
        code: "CONTRACTOR_INACTIVE",
      });
      await expect(
        reports.create(actor, input(contractor.id, "2026-03-02", { preparedByEngineerId: "nope" }), ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "ELECTRICAL_ENGINEER_NOT_FOUND" });
      await expect(
        reports.create(actor, input(contractor.id, "2026-03-02", { preparedByEngineerId: "el3" }), ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: "ELECTRICAL_ENGINEER_INACTIVE" });
      expect(await countReports(contractor.id)).toBe(0);
    });

    it("updates with If-Match, answers 409 on the day another report holds, and 409 VERSION_CONFLICT on a stale version", async () => {
      const contractor = await newContractor();
      const a = await reports.create(actor, input(contractor.id, "2026-03-01"), ctx);
      await reports.create(actor, input(contractor.id, "2026-03-02"), ctx);

      const moved = await reports.update(actor, a.id, { reportDate: day("2026-03-05") }, ctx, 1);
      expect(moved).toMatchObject({ reportDate: "2026-03-05", version: 2 });
      await expect(
        reports.update(actor, a.id, { reportDate: day("2026-03-02") }, ctx, 2),
      ).rejects.toMatchObject({ statusCode: 409, code: "DAILY_REPORT_EXISTS" });
      await expect(reports.update(actor, a.id, { workersCount: 1 }, ctx, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      expect((await reports.get(a.id, ctx)).version).toBe(2);
    });

    it("moves a report to another contractor, onto that contractor's free day only", async () => {
      const a = await newContractor();
      const b = await newContractor();
      const report = await reports.create(actor, input(a.id, "2026-03-01"), ctx);
      await reports.create(actor, input(b.id, "2026-03-01"), ctx);

      await expect(reports.update(actor, report.id, { contractorId: b.id }, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "DAILY_REPORT_EXISTS",
      });
      const moved = await reports.update(
        actor,
        report.id,
        { contractorId: b.id, reportDate: day("2026-03-03") },
        ctx,
      );
      expect(moved.contractor.id).toBe(b.id);
    });

    it("deletes with If-Match, and a report that is gone is 404", async () => {
      const contractor = await newContractor();
      const a = await reports.create(actor, input(contractor.id, "2026-03-01"), ctx);

      await expect(reports.remove(actor, a.id, ctx, 9)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
      });
      await reports.remove(actor, a.id, ctx, 1);

      await expect(reports.get(a.id, ctx)).rejects.toMatchObject({ code: "DAILY_REPORT_NOT_FOUND" });
      await expect(reports.remove(actor, a.id, ctx)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("keeps a contractor and an engineer that a report names: the foreign keys refuse their delete", async () => {
      const contractor = await newContractor();
      const engineer = await newEngineer();
      await reports.create(
        actor,
        input(contractor.id, "2026-03-01", { preparedByEngineerId: engineer.id }),
        ctx,
      );

      await expect(q(`DELETE FROM "Contractor" WHERE "id" = $1`, [contractor.id])).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23001)$/),
      });
      await expect(
        q(`DELETE FROM "ElectricalEngineer" WHERE "id" = $1`, [engineer.id]),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23001)$/) });
    });

    it("has no villa column any more, and no workDone, issues or preparedBy", async () => {
      const columns = (
        await q(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DailyReport'`,
        )
      ).rows.map((r) => r.column_name as string);

      expect(columns).toEqual(
        expect.arrayContaining(["contractorId", "preparedByEngineerId", "notes", "reportDate"]),
      );
      for (const gone of ["villaId", "workDone", "issues", "preparedBy"]) expect(columns).not.toContain(gone);
    });
  });

  describe("the list", () => {
    it("filters, searches the notes, sorts and pages in SQL, with the same WHERE for the count", async () => {
      const a = await newContractor();
      const b = await newContractor();
      await q(`UPDATE "Contractor" SET "name" = 'L-2' WHERE "id" = $1`, [a.id]);
      await q(`UPDATE "Contractor" SET "name" = 'L-10' WHERE "id" = $1`, [b.id]);
      await reports.create(
        actor,
        input(a.id, "2025-01-01", { notes: "Poured 100% slab", weather: "HOT" }),
        ctx,
      );
      await reports.create(actor, input(a.id, "2025-01-02", { notes: "Cable_tray. Late cement" }), ctx);
      await reports.create(
        actor,
        input(b.id, "2025-01-02", { notes: "Formwork", preparedByEngineerId: "el2" }),
        ctx,
      );
      await reports.create(actor, input(b.id, "2025-01-03", { notes: "Plaster", workersCount: 99 }), ctx);
      const ask = (query: Record<string, unknown>) =>
        reports.list({
          page: 1,
          limit: 20,
          reportFrom: day("2025-01-01"),
          reportTo: day("2025-01-31"),
          ...query,
        } as never);

      const all = await ask({});
      expect(all.meta.total).toBe(4);
      expect(all.items.map((item) => item.reportDate)).toEqual([
        "2025-01-03",
        "2025-01-02",
        "2025-01-02",
        "2025-01-01",
      ]);

      const natural = await ask({ sort: "contractorName:asc" });
      expect(natural.items.map((item) => item.contractor.name)).toEqual(["L-2", "L-2", "L-10", "L-10"]);
      const byEngineer = await ask({ sort: "preparedByName:asc" });
      expect(byEngineer.items.map((item) => item.preparedBy.name)).toEqual(["Karim", "Mona", "Mona", "Mona"]);

      expect((await ask({ search: "100%" })).items).toHaveLength(1);
      expect((await ask({ search: "Cable_tray" })).items).toHaveLength(1);
      expect((await ask({ search: "cable-tray" })).items).toHaveLength(0);
      expect((await ask({ search: "late cement" })).items).toHaveLength(1);
      // The names of the contractor and the engineer are not searched: only the notes.
      expect((await ask({ search: "Karim" })).items).toHaveLength(0);
      expect((await ask({ search: "L-10" })).items).toHaveLength(0);
      expect((await ask({ weather: "HOT" })).meta.total).toBe(1);
      expect((await ask({ contractorId: a.id })).items.map((item) => item.notes)).toEqual([
        "Cable_tray. Late cement",
        "Poured 100% slab",
      ]);
      expect((await ask({ preparedByEngineerId: "el2" })).items.map((item) => item.notes)).toEqual([
        "Formwork",
      ]);

      const page = await ask({ limit: 2, page: 2 });
      expect(page.items.map((item) => item.reportDate)).toEqual(["2025-01-02", "2025-01-01"]);
      expect(page.meta.total).toBe(4);
    });

    it("sorts by weather in the database's own order (HOT, SUNNY, WINDY, RAINY, DUSTY)", async () => {
      const contractor = await newContractor();
      const kinds = ["DUSTY", "HOT", "RAINY", "SUNNY", "WINDY"] as const;
      for (const [n, weather] of kinds.entries()) {
        await reports.create(actor, input(contractor.id, `2025-02-0${n + 1}`, { weather }), ctx);
      }

      const sorted = await reports.list({
        page: 1,
        limit: 20,
        contractorId: contractor.id,
        sort: "weather:asc",
      } as never);

      expect(sorted.items.map((item) => item.weather)).toEqual(["HOT", "SUNNY", "WINDY", "RAINY", "DUSTY"]);
    });
  });

  describe("the repository's locks and queries", () => {
    it("has no villa lock any more", () => {
      expect((repository as unknown as Record<string, unknown>).lockVillaShared).toBeUndefined();
    });

    it("locks the contractors and the engineers of an import shared and answers each one's status; one that is gone is missing", async () => {
      const locked = await scratch.prisma.$transaction(async (t) => ({
        contractors: await repository.lockContractorsShared(["con1", "con3", "nope"].sort(), t),
        engineers: await repository.lockEngineersShared(["el1", "el3", "nope"].sort(), t),
      }));

      expect([...locked.contractors.entries()].sort()).toEqual([
        ["con1", "ACTIVE"],
        ["con3", "INACTIVE"],
      ]);
      expect([...locked.engineers.entries()].sort()).toEqual([
        ["el1", "ACTIVE"],
        ["el3", "INACTIVE"],
      ]);
    });

    it("saves the rows of an import in one go and returns the ids it made", async () => {
      const a = await newContractor();
      const base = {
        contractorId: a.id,
        preparedByEngineerId: "el1",
        weather: "HOT" as const,
        workersCount: 1,
        notes: null,
        createdById: "admin",
      };
      const ids = await scratch.prisma.$transaction((t) =>
        repository.createMany(
          [
            { ...base, reportDate: day("2026-08-01") },
            { ...base, reportDate: day("2026-08-02") },
          ],
          t,
        ),
      );

      const stored = (
        await q(`SELECT "id" FROM "DailyReport" WHERE "contractorId" = $1 ORDER BY "reportDate"`, [a.id])
      ).rows.map((r) => r.id);
      expect(stored).toEqual(ids);
    });

    it("reads the days already reported for the given contractors only", async () => {
      const a = await newContractor();
      const b = await newContractor();
      await reports.create(actor, input(a.id, "2026-09-01"), ctx);
      await reports.create(actor, input(b.id, "2026-09-02"), ctx);

      const found = await repository.existingDays([a.id], tx());

      expect(found.map((entry) => entry.contractorId)).toEqual([a.id]);
      expect(await repository.existingDays([], tx())).toEqual([]);
    });

    it("reads the contractors and the engineers an import checks against, with their status", async () => {
      const contractors = await repository.importContractors(tx());
      const engineers = await repository.importEngineers(tx());

      expect(contractors.find((c) => c.id === "con1")).toMatchObject({ name: "Nile", status: "ACTIVE" });
      expect(contractors.find((c) => c.id === "con3")).toMatchObject({ name: "Old Co", status: "INACTIVE" });
      expect(engineers.find((e) => e.id === "el1")).toMatchObject({ name: "Mona", status: "ACTIVE" });
      expect(engineers.find((e) => e.id === "el3")).toMatchObject({ name: "Retired", status: "INACTIVE" });
    });

    it("changes and deletes a report only at the version the caller read", async () => {
      const contractor = await newContractor();
      const report = await reports.create(actor, input(contractor.id, "2026-09-10"), ctx);

      expect(await repository.update(report.id, report.version + 1, { workersCount: 99 }, tx())).toBeNull();
      expect(await repository.delete(report.id, report.version + 1, tx())).toBe(false);
      expect(
        (await q(`SELECT "workersCount", "version" FROM "DailyReport" WHERE "id" = $1`, [report.id])).rows[0],
      ).toEqual({ workersCount: 10, version: report.version });

      const updated = await repository.update(report.id, report.version, { workersCount: 99 }, tx());
      expect(updated).toMatchObject({ workersCount: 99, version: report.version + 1 });
      expect(await repository.delete(report.id, report.version + 1, tx())).toBe(true);
      expect(await countReports(contractor.id)).toBe(0);
    });

    it("locks the report row so that nothing else can even share it until the transaction ends", async () => {
      const contractor = await newContractor();
      const report = await reports.create(actor, input(contractor.id, "2026-09-11"), ctx);

      const refusal = await scratch.prisma.$transaction(async (t) => {
        expect(await repository.lockVersion(report.id, t)).toBe(report.version);
        // Another connection asks for the weakest lock there is: a shared lock would be refused only by an exclusive one.
        return q(`SELECT 1 FROM "DailyReport" WHERE "id" = $1 FOR SHARE NOWAIT`, [report.id]).then(
          () => null,
          (err: { code?: string }) => err.code ?? "error",
        );
      });

      expect(refusal).toBe("55P03");
    });
  });

  describe("concurrent writers", () => {
    it("lets exactly one of twelve simultaneous creates for one contractor and day win, the others get 409 DAILY_REPORT_EXISTS", async () => {
      const contractor = await newContractor();

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, n) =>
          reports.create(actor, input(contractor.id, "2026-10-01", { workersCount: n }), ctx),
        ),
      );

      assertNoCrash(results, "twelve creates");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results.flatMap((result) => (result.status === "rejected" ? [(result.reason as AppError).code] : [])),
      ).toEqual(Array(11).fill("DAILY_REPORT_EXISTS"));
      expect(await countReports(contractor.id)).toBe(1);
    });

    it("never deadlocks creates on many days of one contractor, a move of dates and deletes", async () => {
      const contractor = await newContractor();
      const created = await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          reports.create(actor, input(contractor.id, `2026-01-0${n + 1}`), ctx),
        ),
      );

      const results = await Promise.allSettled([
        ...created
          .slice(0, 3)
          .map((report, n) =>
            reports.update(actor, report.id, { reportDate: day(`2026-02-0${n + 1}`) }, ctx),
          ),
        ...created.slice(3).map((report) => reports.remove(actor, report.id, ctx)),
        ...Array.from({ length: 3 }, (_, n) =>
          reports.create(actor, input(contractor.id, `2026-02-1${n}`), ctx),
        ),
      ]);

      assertNoCrash(results, "mixed writes");
      expect(await countReports(contractor.id)).toBe(6);
    });

    it("never deadlocks a create and the switch-off or delete of its contractor or engineer: a report never names a gone record", async () => {
      for (let round = 0; round < 8; round += 1) {
        const contractor = await newContractor();
        const engineer = await newEngineer();

        const results = await Promise.allSettled([
          reports.create(
            actor,
            input(contractor.id, "2026-10-05", { preparedByEngineerId: engineer.id }),
            ctx,
          ),
          q(`DELETE FROM "Contractor" WHERE "id" = $1`, [contractor.id]),
          q(`DELETE FROM "ElectricalEngineer" WHERE "id" = $1`, [engineer.id]),
        ]);

        const crashes = results.flatMap((result) =>
          result.status === "rejected" &&
          !(result.reason instanceof AppError && result.reason.statusCode < 500) &&
          !RESTRICT_CODES.includes((result.reason as { code?: string }).code ?? "")
            ? [String((result.reason as Error)?.message ?? result.reason)]
            : [],
        );
        expect(crashes, `create vs delete, round ${round}`).toEqual([]);
        const reportsLeft = await countReports(contractor.id);
        const contractorLeft = (await q(`SELECT 1 FROM "Contractor" WHERE "id" = $1`, [contractor.id]))
          .rowCount;
        expect(reportsLeft === 0 || contractorLeft === 1, "a report never outlives its contractor").toBe(
          true,
        );
      }
    });
  });

  describe("the import", () => {
    it("saves a file whole: 201, the rows, the engineer, 5,000 characters of notes, one audit entry", async () => {
      const a = await newContractor();
      const b = await newContractor();
      const file = await fileOf(
        row(a.name, "2026-03-04", { notes: "n".repeat(5000) }),
        row(b.name, "2026-03-04", { engineer: "Karim" }),
      );

      const outcome = await run(file);

      expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 2 } });
      const stored = (
        await q(
          `SELECT "contractorId", "notes", "preparedByEngineerId", "createdById", "version" FROM "DailyReport" WHERE "contractorId" = ANY($1) ORDER BY "contractorId"`,
          [[a.id, b.id]],
        )
      ).rows;
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({
        contractorId: a.id,
        preparedByEngineerId: "el1",
        createdById: "admin",
        version: 1,
      });
      expect(stored[0].notes).toHaveLength(5000);
      expect(stored[1]).toMatchObject({ preparedByEngineerId: "el2", notes: null });
      const audit = await q(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'daily_report.import' AND "after"->>'rows' = '2'`,
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("saves nothing when one row of the file is bad, or when the day is taken", async () => {
      const a = await newContractor();
      await reports.create(actor, input(a.id, "2026-03-10"), ctx);

      const taken = await run(
        await fileOf(row(a.name, "2026-03-09"), row(a.name, "2026-03-10"), row(a.name, "2026-03-11")),
      );
      const bad = await run(await fileOf(row(a.name, "2026-03-12"), row("NOPE", "2026-03-13")));

      expect(taken).toMatchObject({ status: 422 });
      expect(bad).toMatchObject({ status: 422 });
      expect(await countReports(a.id)).toBe(1);
    });

    it("answers a dry run without writing, and an identical file twice with 409 FILE_ALREADY_IMPORTED", async () => {
      const a = await newContractor();
      const file = await fileOf(row(a.name, "2026-03-20"));

      expect(await run(file, true)).toMatchObject({ status: 200 });
      expect(await countReports(a.id)).toBe(0);
      expect(await run(file)).toMatchObject({ status: 201 });
      await expect(run(file)).rejects.toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
      expect(await countReports(a.id)).toBe(1);
    });

    it("races a create of one of its days: the file is saved whole or not at all, never half", async () => {
      for (let round = 0; round < 6; round += 1) {
        const contractor = await newContractor();
        const file = await fileOf(
          row(contractor.name, "2026-04-01"),
          row(contractor.name, "2026-04-02"),
          row(contractor.name, "2026-04-03"),
        );

        const results = await Promise.allSettled([
          run(file),
          reports.create(actor, input(contractor.id, "2026-04-02", { notes: "By hand" }), ctx),
        ]);

        assertNoCrash(results, `import vs create, round ${round}`);
        const days = (
          await q(
            `SELECT "reportDate"::text AS d, "notes" FROM "DailyReport" WHERE "contractorId" = $1 ORDER BY 1`,
            [contractor.id],
          )
        ).rows;
        if (saved(results[0]!)) {
          expect(days.map((entry) => entry.d)).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
        } else {
          expect(days).toEqual([{ d: "2026-04-02", notes: "By hand" }]);
        }
      }
    });

    it("races the switch-off of a contractor of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 6; round += 1) {
        const keep = await newContractor();
        const doomed = await newContractor();
        const file = await fileOf(row(keep.name, "2026-04-10"), row(doomed.name, "2026-04-10"));

        const results = await Promise.allSettled([
          run(file),
          q(`UPDATE "Contractor" SET "status" = 'INACTIVE' WHERE "id" = $1`, [doomed.id]),
        ]);

        assertNoCrash(results, `import vs switch-off, round ${round}`);
        const total = (await countReports(keep.id)) + (await countReports(doomed.id));
        expect([0, 2]).toContain(total);
      }
    });

    it("races the switch-off of the engineer of the file: whole file or nothing, no deadlock", async () => {
      for (let round = 0; round < 6; round += 1) {
        const contractor = await newContractor();
        const engineer = await newEngineer();
        const file = await fileOf(
          row(contractor.name, "2026-04-11", { engineer: engineer.name }),
          row(contractor.name, "2026-04-12", { engineer: engineer.name }),
        );

        const results = await Promise.allSettled([
          run(file),
          q(`UPDATE "ElectricalEngineer" SET "status" = 'INACTIVE' WHERE "id" = $1`, [engineer.id]),
        ]);

        assertNoCrash(results, `import vs engineer switch-off, round ${round}`);
        expect([0, 2]).toContain(await countReports(contractor.id));
      }
    });

    it("races another import of the same contractor: both finish, the days are saved once", async () => {
      const a = await newContractor();
      const first = await fileOf(row(a.name, "2026-05-01"), row(a.name, "2026-05-02"));
      const second = await fileOf(row(a.name, "2026-05-02"), row(a.name, "2026-05-03"));

      const results = await Promise.allSettled([run(first), run(second)]);

      assertNoCrash(results, "two imports");
      const days = (
        await q(`SELECT "reportDate"::text AS d FROM "DailyReport" WHERE "contractorId" = $1 ORDER BY 1`, [
          a.id,
        ])
      ).rows.map((entry) => entry.d);
      // Both files name 2026-05-02, so only one of them can be saved, whole.
      expect([
        ["2026-05-01", "2026-05-02"],
        ["2026-05-02", "2026-05-03"],
      ]).toContainEqual(days);
    });
  });
});
