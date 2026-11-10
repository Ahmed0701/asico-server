import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// Export, delete, import again: for each of the seven resources, on a real PostgreSQL in a scratch schema that is created for
// this run and dropped at the end. The records are made with the ORM, exported with the real export (the real writer), deleted,
// and loaded again from the very file the export wrote, with the real import. What is in the tables afterwards is compared,
// field by field and by the natural keys (the ids and the times are new, as documented), with what was there before. No
// database is created or reset, and the asico schema is never touched. It COMMITS inside the scratch schema, which is why it
// is off unless ASICO_DB_TESTS=1. Run it with:
//   ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import { ContractorsImportService } from "../../src/modules/contractors/service/contractors-import.service.js";
import { DailyLabourImportService } from "../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { DailyReportsImportService } from "../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { ExportsService } from "../../src/modules/exports/service/exports.service.js";
import type { ParsedExport } from "../../src/modules/exports/validators/exports.validators.js";
import { OpenWorksImportService } from "../../src/modules/open-works/service/open-works-import.service.js";
import { SiteReportsImportService } from "../../src/modules/site-reports/service/site-reports-import.service.js";
import { SmallWorksImportService } from "../../src/modules/small-works/service/small-works-import.service.js";
import { VillasImportService } from "../../src/modules/villas/service/villas-import.service.js";
import { listContractorsQuerySchema } from "../../src/modules/contractors/index.js";
import { listDailyLabourQuerySchema } from "../../src/modules/daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../src/modules/daily-reports/index.js";
import { listOpenWorksQuerySchema } from "../../src/modules/open-works/index.js";
import { listSiteReportsQuerySchema } from "../../src/modules/site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../src/modules/small-works/index.js";
import { listVillasQuerySchema } from "../../src/modules/villas/index.js";

const ctx: RequestContext = { locale: "en", ip: "127.0.0.1", userAgent: "vitest", requestId: "db-test" };
const actor: Actor = { id: "admin", role: "ADMIN" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const LONG = `${"Line of text with a number 123 and words. ".repeat(114)}\nlast line`
  .slice(0, 5000)
  .trimEnd();

const parse = (schema: { parse: (input: unknown) => unknown }) =>
  ({ format: "xlsx", query: schema.parse({ page: "1", limit: "1000" }) }) as ParsedExport<never>;

type Exported = { write: (out: PassThrough) => Promise<unknown> };
async function bytesOf(input: Exported | Promise<Exported>): Promise<Buffer> {
  const file = await input;
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => out.on("end", resolve));
  await file.write(out);
  out.end();
  await done;
  return Buffer.concat(chunks);
}

describe.skipIf(!RUN)("export, delete and import again on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const exporter = new ExportsService();

  beforeAll(async () => {
    scratch = await openScratch("scratch16", 8);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    const db = scratch.prisma;
    await db.user.create({
      data: { id: "admin", name: "Root Admin", email: "a@x.test", passwordHash: "x", role: "ADMIN" },
    });
    // Two areas with one name, two civil engineers and two contractors with one name: the file must tell them apart.
    await db.area.createMany({
      data: [
        { id: "a1", name: "New Cairo", city: "Cairo" },
        { id: "a2", name: "New Cairo", city: "Giza" },
        { id: "a3", name: "Maadi", city: "Cairo" },
      ],
    });
    await db.civilEngineer.createMany({
      data: [
        { id: "e1", name: "Mona", phone: "0100 111 2222" },
        { id: "e2", name: "Mona", phone: "0100 333 4444" },
      ],
    });
    // Two electrical engineers with one name: a daily report's file must tell them apart, like the two Niles.
    await db.electricalEngineer.createMany({
      data: [
        { id: "x1", name: "Hany Wagdy", phone: "0101 777 8888" },
        { id: "x2", name: "Hany Wagdy", phone: "0101 999 0000" },
      ],
    });
    await db.contractor.createMany({
      data: [
        { id: "c1", name: "Nile Builders", phone: "0102 111 1111", email: "nile@example.test" },
        { id: "c2", name: "Nile", phone: "+20 102 222 2222" },
        { id: "c3", name: "Nile", phone: "0102 333 3333" },
        { id: "c4", name: "شركة النيل", phone: "0102 444 4444", status: "INACTIVE" },
        { id: "c5", name: '=HYPERLINK("http://evil.test")', phone: "0102 555 5555" },
      ],
    });
    await db.villa.createMany({
      data: [
        {
          id: "v1",
          villaNumber: "007",
          ownerName: "خالد منصور",
          areaId: "a1",
          block: "B-1",
          plot: "12",
          civilEngineerId: "e1",
          electricalEngineerId: "x1",
          contractorId: "c1",
          startDate: day("2026-01-05"),
          targetDate: day("2026-12-31"),
          budgetMinor: 0n,
          currency: "KWD",
          createdById: "admin",
        },
        {
          id: "v2",
          villaNumber: "V-2",
          areaId: "a2",
          block: "B2",
          plot: "2",
          civilEngineerId: "e2",
          contractorId: "c3",
          budgetMinor: 29n,
          currency: "KWD",
          createdById: "admin",
        },
        {
          id: "v3",
          villaNumber: "V-3",
          areaId: "a3",
          block: "B1",
          plot: "3",
          civilEngineerId: "e1",
          contractorId: "c2",
          budgetMinor: 125_000_050n,
          currency: "USD",
          createdById: "admin",
        },
        {
          id: "v4",
          villaNumber: "V-4",
          areaId: "a3",
          block: "B1",
          plot: "4",
          civilEngineerId: "e1",
          budgetMinor: 1_234_567n,
          currency: "KWD",
          createdById: "admin",
        },
        {
          id: "v5",
          villaNumber: "V-5",
          areaId: "a3",
          block: "B1",
          plot: "5",
          civilEngineerId: "e1",
          budgetMinor: 5n,
          currency: "JPY",
          createdById: "admin",
        },
        {
          id: "v6",
          villaNumber: "=V-6",
          areaId: "a3",
          block: "-B",
          plot: "6",
          civilEngineerId: "e1",
          contractorId: "c5",
          budgetMinor: BigInt(Number.MAX_SAFE_INTEGER),
          currency: "KWD",
          createdById: "admin",
        },
        // Two decimals (EGP) and the smallest amount of a three-decimal currency (0.001 KWD).
        {
          id: "v7",
          villaNumber: "V-7",
          areaId: "a3",
          block: "B1",
          plot: "7",
          civilEngineerId: "e1",
          budgetMinor: 12_345n,
          currency: "EGP",
          createdById: "admin",
        },
        {
          id: "v8",
          villaNumber: "V-8",
          areaId: "a3",
          block: "B1",
          plot: "8",
          civilEngineerId: "e1",
          budgetMinor: 1n,
          currency: "KWD",
          createdById: "admin",
        },
      ],
    });
    await db.elecPhase.createMany({
      data: [
        { id: "p1", name: "Wiring", sortOrder: 1 },
        { id: "p2", name: "Scratch plaster", sortOrder: 2 },
      ],
    });
    await db.workItem.createMany({
      data: [
        {
          villaId: "v1",
          elecPhaseId: "p2",
          status: "IN_PROGRESS",
          priority: "HIGH",
          progress: 40,
          contractorId: "c1",
          startDate: day("2026-02-01"),
          endDate: day("2026-03-01"),
          source: "MANUAL",
        },
        { villaId: "v2", elecPhaseId: "p2", source: "MANUAL", contractorId: "c3" },
      ],
    });
    // A report belongs to a contractor and to the engineer who prepared it, not to a villa.
    await db.dailyReport.createMany({
      data: [
        {
          contractorId: "c1",
          preparedByEngineerId: "x1",
          reportDate: day("2026-03-01"),
          weather: "SUNNY",
          workersCount: 0,
          notes: LONG,
        },
        {
          contractorId: "c3",
          preparedByEngineerId: "x1",
          reportDate: day("2026-03-02"),
          weather: "WINDY",
          workersCount: 100_000,
          notes: "=SUM(A1)",
        },
        {
          contractorId: "c1",
          preparedByEngineerId: "x2",
          reportDate: day("2026-03-02"),
          weather: "RAINY",
          workersCount: 7,
        },
      ],
    });
    await db.dailySmallWork.createMany({
      data: [
        {
          villaId: "v1",
          contractorId: "c1",
          startDate: day("2026-03-01"),
          endDate: day("2026-03-04"),
          description: "Replaced a socket",
        },
        {
          villaId: "v2",
          // One of the two contractors named Nile: the file must carry something that tells it from the other.
          contractorId: "c3",
          startDate: day("2026-03-02"),
          endDate: day("2026-03-02"),
          description: "Painted",
          status: "DONE",
        },
      ],
    });
    await db.siteReport.createMany({
      data: [
        {
          villaId: "v1",
          title: "First fix check",
          visitDate: day("2026-03-03"),
          inspector: "Eng. Hamdy",
          type: "SAFETY",
          rating: 1,
          findings: LONG,
          recommendations: LONG,
        },
        {
          villaId: "v2",
          title: "الزيارة الأولى",
          visitDate: day("2026-03-04"),
          inspector: "-dash",
          type: "QUALITY",
          rating: 5,
          findings: "@everyone",
        },
      ],
    });
    await db.dailyLabour.createMany({
      data: [
        { villaId: "v1", labourDate: day("2026-03-01"), contractorId: "c1", labourCount: 0, notes: "Roof" },
        { villaId: "v2", labourDate: day("2026-03-02"), contractorId: "c3", labourCount: 100_000 },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  // What is in the tables, by natural keys (never the ids, the versions or the times).
  const snapshot = {
    contractors: async () =>
      (
        await q(
          `SELECT "name","phone","email","status"::text AS status FROM "Contractor" ORDER BY "name","phone"`,
        )
      ).rows,
    villas: async () =>
      (
        await q(
          `SELECT v."villaNumber", v."ownerName", a."name" AS area, a."city", v."block", v."plot", c."name" AS contractor, c."phone" AS "contractorPhone",
                  x."name" AS electrical, e."name" AS civil, e."phone" AS "civilPhone", v."startDate"::text AS "startDate", v."targetDate"::text AS "targetDate",
                  v."budgetMinor"::text AS "budgetMinor", v."currency"
           FROM "Villa" v JOIN "Area" a ON a."id" = v."areaId" JOIN "CivilEngineer" e ON e."id" = v."civilEngineerId"
           LEFT JOIN "Contractor" c ON c."id" = v."contractorId" LEFT JOIN "ElectricalEngineer" x ON x."id" = v."electricalEngineerId"
           ORDER BY v."villaNumber"`,
        )
      ).rows,
    openWorks: async () =>
      (
        await q(
          `SELECT v."villaNumber", ep."name" AS phase, w."status"::text AS status, w."priority"::text AS priority, w."progress",
                  c."name" AS contractor, w."startDate"::text AS "startDate", w."endDate"::text AS "endDate", w."source"::text AS source
           FROM "WorkItem" w JOIN "Villa" v ON v."id" = w."villaId" JOIN "ElecPhase" ep ON ep."id" = w."elecPhaseId"
           LEFT JOIN "Contractor" c ON c."id" = w."contractorId"
           WHERE w."source" = 'MANUAL' ORDER BY v."villaNumber", ep."name"`,
        )
      ).rows,
    dailyReports: async () =>
      (
        await q(
          `SELECT r."reportDate"::text AS "reportDate", c."name" AS contractor, c."phone" AS "contractorPhone",
                  x."name" AS engineer, x."phone" AS "engineerPhone", r."weather"::text AS weather, r."workersCount", r."notes"
           FROM "DailyReport" r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" x ON x."id" = r."preparedByEngineerId"
           ORDER BY r."reportDate", c."name", c."phone"`,
        )
      ).rows,
    smallWorks: async () =>
      (
        await q(
          `SELECT v."villaNumber", s."startDate"::text AS "startDate", s."endDate"::text AS "endDate", s."description", c."name" AS contractor, s."status"::text AS status
           FROM "DailySmallWork" s JOIN "Villa" v ON v."id" = s."villaId" JOIN "Contractor" c ON c."id" = s."contractorId" ORDER BY v."villaNumber", s."startDate"`,
        )
      ).rows,
    siteReports: async () =>
      (
        await q(
          `SELECT v."villaNumber", s."title", s."visitDate"::text AS "visitDate", s."inspector", s."type"::text AS type, s."rating", s."findings", s."recommendations"
           FROM "SiteReport" s JOIN "Villa" v ON v."id" = s."villaId" ORDER BY v."villaNumber", s."visitDate"`,
        )
      ).rows,
    dailyLabour: async () =>
      (
        await q(
          `SELECT v."villaNumber", l."labourDate"::text AS "labourDate", c."name" AS contractor, l."labourCount", l."notes"
           FROM "DailyLabour" l JOIN "Villa" v ON v."id" = l."villaId" JOIN "Contractor" c ON c."id" = l."contractorId"
           ORDER BY v."villaNumber", l."labourDate"`,
        )
      ).rows,
  };

  it("loads every resource again from the file its export wrote, field by field", async () => {
    const before = {
      contractors: await snapshot.contractors(),
      villas: await snapshot.villas(),
      openWorks: await snapshot.openWorks(),
      dailyReports: await snapshot.dailyReports(),
      smallWorks: await snapshot.smallWorks(),
      siteReports: await snapshot.siteReports(),
      dailyLabour: await snapshot.dailyLabour(),
    };
    expect(before.villas).toHaveLength(8);
    expect(before.openWorks).toHaveLength(2);
    expect(before.dailyReports).toHaveLength(3);

    // The seven files, written while everything is there.
    const files = {
      contractors: await bytesOf(
        await exporter.contractorsExport(parse(listContractorsQuerySchema), actor, ctx),
      ),
      villas: await bytesOf(await exporter.villasExport(parse(listVillasQuerySchema), actor, ctx)),
      openWorks: await bytesOf(exporter.openWorksExport(parse(listOpenWorksQuerySchema), actor, ctx)),
      dailyReports: await bytesOf(
        exporter.dailyReportsExport(parse(listDailyReportsQuerySchema), actor, ctx),
      ),
      smallWorks: await bytesOf(exporter.smallWorksExport(parse(listSmallWorksQuerySchema), actor, ctx)),
      siteReports: await bytesOf(exporter.siteReportsExport(parse(listSiteReportsQuerySchema), actor, ctx)),
      dailyLabour: await bytesOf(exporter.dailyLabourExport(parse(listDailyLabourQuerySchema), actor, ctx)),
    };

    // Everything the files hold is deleted, children first. The areas and the engineers stay: they have no import.
    for (const table of [
      "DailyLabour",
      "SiteReport",
      "DailySmallWork",
      "DailyReport",
      "WorkItem",
      "VillaPhaseProgress",
      "Villa",
      "Contractor",
    ]) {
      await q(`DELETE FROM "${table}"`);
    }

    const open = (name: string, bytes: Buffer) => ({ name: `${name}.xlsx`, bytes });
    const results = {
      contractors: await new ContractorsImportService().importFile(
        actor,
        open("contractors", files.contractors),
        false,
        ctx,
      ),
      villas: await new VillasImportService().importFile(actor, open("villas", files.villas), false, ctx),
      openWorks: await new OpenWorksImportService().importFile(
        actor,
        open("open-works", files.openWorks),
        false,
        ctx,
      ),
      dailyReports: await new DailyReportsImportService().importFile(
        actor,
        open("daily-reports", files.dailyReports),
        false,
        ctx,
      ),
      smallWorks: await new SmallWorksImportService().importFile(
        actor,
        open("small-works", files.smallWorks),
        false,
        ctx,
      ),
      siteReports: await new SiteReportsImportService().importFile(
        actor,
        open("site-reports", files.siteReports),
        false,
        ctx,
      ),
      dailyLabour: await new DailyLabourImportService().importFile(
        actor,
        open("daily-labour", files.dailyLabour),
        false,
        ctx,
      ),
    };

    expect(
      Object.fromEntries(Object.entries(results).map(([name, r]) => [name, [r.status, r.report.errors]])),
    ).toEqual(Object.fromEntries(Object.keys(results).map((name) => [name, [201, []]])));
    expect(results.openWorks.report).toMatchObject({ total: 2, imported: 2, skipped: 0 });
    expect(results.villas.report).toMatchObject({ total: 8, imported: 8, skipped: 0 });

    expect(await snapshot.contractors()).toEqual(before.contractors);
    expect(await snapshot.villas()).toEqual(before.villas);
    // The two-decimal and the three-decimal currency, down to the smallest unit of each.
    const budgets = (await snapshot.villas()).map((villa) => [
      villa.villaNumber,
      villa.budgetMinor,
      villa.currency,
    ]);
    expect(budgets).toEqual(
      expect.arrayContaining([
        ["V-7", "12345", "EGP"],
        ["V-8", "1", "KWD"],
        ["V-4", "1234567", "KWD"],
        ["V-5", "5", "JPY"],
      ]),
    );
    expect(await snapshot.openWorks()).toEqual(before.openWorks);
    expect(await snapshot.dailyReports()).toEqual(before.dailyReports);
    expect(await snapshot.smallWorks()).toEqual(before.smallWorks);
    expect(await snapshot.siteReports()).toEqual(before.siteReports);
    expect(await snapshot.dailyLabour()).toEqual(before.dailyLabour);

    // Every open work comes back as one added by hand.
    expect((await q(`SELECT count(*)::int AS n FROM "WorkItem" WHERE "source" <> 'MANUAL'`)).rows[0].n).toBe(
      0,
    );
    // A restored villa is made as one created by hand: on no MEW list, and a progress row for each phase.
    expect(
      (await q(`SELECT count(*)::int AS n FROM "Villa" WHERE "mewFollowUpAt" IS NOT NULL`)).rows[0].n,
    ).toBe(0);
    const phases = (await q(`SELECT count(*)::int AS n FROM "ElecPhase"`)).rows[0].n;
    expect(phases).toBeGreaterThan(0);
    expect((await q(`SELECT count(*)::int AS n FROM "VillaPhaseProgress"`)).rows[0].n).toBe(8 * phases);
  }, 120_000);

  it("refuses the same files again, in the environment they came from, record by record", async () => {
    const villas = await bytesOf(await exporter.villasExport(parse(listVillasQuerySchema), actor, ctx));
    const labour = await bytesOf(
      await exporter.dailyLabourExport(parse(listDailyLabourQuerySchema), actor, ctx),
    );
    const contractors = await bytesOf(
      await exporter.contractorsExport(parse(listContractorsQuerySchema), actor, ctx),
    );
    const reports = await bytesOf(
      exporter.dailyReportsExport(parse(listDailyReportsQuerySchema), actor, ctx),
    );
    const open = (bytes: Buffer) => ({ name: "again.xlsx", bytes });

    const again = {
      villas: await new VillasImportService().importFile(actor, open(villas), true, ctx),
      labour: await new DailyLabourImportService().importFile(actor, open(labour), true, ctx),
      contractors: await new ContractorsImportService().importFile(actor, open(contractors), true, ctx),
      dailyReports: await new DailyReportsImportService().importFile(actor, open(reports), true, ctx),
    };

    expect(again.villas.report.errors.map((error) => error.code)).toContain("DUPLICATE_EXISTING");
    expect(new Set(again.labour.report.errors.map((error) => error.code))).toEqual(
      new Set(["DUPLICATE_EXISTING"]),
    );
    expect(new Set(again.contractors.report.errors.map((error) => error.code))).toEqual(
      new Set(["DUPLICATE_EXISTING"]),
    );
    expect(again.labour.report.errors).toHaveLength(2);
    expect(new Set(again.dailyReports.report.errors.map((error) => error.code))).toEqual(
      new Set(["DUPLICATE_EXISTING"]),
    );
    expect(again.dailyReports.report.errors).toHaveLength(3);
  }, 120_000);
});
