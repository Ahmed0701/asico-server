import { PassThrough } from "node:stream";
import type { CellValue } from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../src/core/imports/repository.js";
import { ImportRunner, type ImportDefinition } from "../../../src/core/imports/runner.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { contractorImportDefinition } from "../../../src/modules/contractors/service/contractors-import.service.js";
import { dailyLabourImportDefinition } from "../../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { dailyReportsImportDefinition } from "../../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { ExportsService } from "../../../src/modules/exports/service/exports.service.js";
import {
  exportQuery,
  type ParsedExport,
} from "../../../src/modules/exports/validators/exports.validators.js";
import { openWorksImportDefinition } from "../../../src/modules/open-works/service/open-works-import.service.js";
import { siteReportsImportDefinition } from "../../../src/modules/site-reports/service/site-reports-import.service.js";
import { smallWorksImportDefinition } from "../../../src/modules/small-works/service/small-works-import.service.js";
import { VillasService } from "../../../src/modules/villas/service/villas.service.js";
import { villaImportDefinition } from "../../../src/modules/villas/service/villas-import.service.js";
import { listContractorsQuerySchema } from "../../../src/modules/contractors/index.js";
import { listDailyLabourQuerySchema } from "../../../src/modules/daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../../src/modules/daily-reports/index.js";
import { listOpenWorksQuerySchema } from "../../../src/modules/open-works/index.js";
import { listSiteReportsQuerySchema } from "../../../src/modules/site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../../src/modules/small-works/index.js";
import { listVillasQuerySchema } from "../../../src/modules/villas/index.js";

// A file the export wrote is a file the import reads, with no change in between. For each of the seven resources that have an
// import: the real export (the real spreadsheet writer) writes a list of tricky rows, and the real import definition, run by
// the real runner, reads the file and hands the rows to its (fake) repository. What the repository was given is compared
// with what the export was given. The databases are fakes; the files, the headers, the cell formats and the parsing are not.
const audit = vi.hoisted(() => ({ record: vi.fn(), recordMany: vi.fn() }));
vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit,
}));
vi.mock("../../../src/core/database/prisma.js", () => ({
  prisma: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
}));

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const actor: Actor = { id: "user-1", role: "ADMIN" };
const NOW = new Date("2026-10-12T13:55:00.000Z");
const tx = { tx: true } as unknown as Db;

const batches = { lock: vi.fn(), isImported: vi.fn(), create: vi.fn() };
const runner = () =>
  new ImportRunner(batches as never, (async (work: (db: Db) => unknown) => work(tx)) as never, tx);

beforeEach(() => {
  vi.clearAllMocks();
  batches.lock.mockResolvedValue(undefined);
  batches.isImported.mockResolvedValue(false);
  batches.create.mockResolvedValue({ id: "batch-1" });
  audit.record.mockResolvedValue(undefined);
  audit.recordMany.mockResolvedValue(undefined);
});

const parse = <Schema extends Parameters<typeof exportQuery>[0]>(schema: Schema) =>
  ({ format: "xlsx", query: schema.parse({ page: "1", limit: "1000" }) }) as ParsedExport<never>;

const listOf = <Item>(items: Item[]) => ({
  list: vi.fn(async () => ({ items, meta: { total: items.length } })),
});

async function bytesOf(file: { write: (out: PassThrough) => Promise<{ rows: number }> }): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => out.on("end", resolve));
  await file.write(out);
  out.end();
  await done;
  return Buffer.concat(chunks);
}

const exporter = (services: ConstructorParameters<typeof ExportsService>[0]) =>
  new ExportsService({ ...services, now: () => NOW });

const importFile = (definition: unknown, bytes: Buffer, dryRun = false) =>
  runner().run(definition as ImportDefinition<never, never, boolean>, {
    file: { name: "export.xlsx", bytes },
    dryRun,
    actor,
    ctx,
  });

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const LONG_5000 = `${"Line of text with a number 123 and words. ".repeat(114)}\nlast line`
  .slice(0, 5000)
  .trimEnd();
const HOSTILE = '=HYPERLINK("http://evil.test","click")';

const villaRef = { id: "v1", villaNumber: "P-001", location: "New Cairo, B1, 007" };
const created = "2026-03-04T05:06:07.890Z";

describe("contractors", () => {
  const items = [
    {
      id: "c1",
      name: "Nile Builders",
      phone: "0100 123 4567",
      email: "nile@example.test",
      status: "ACTIVE",
      villaCount: 3,
    },
    // A phone with a leading plus, which a spreadsheet would run as a formula without the guard.
    {
      id: "c2",
      name: "شركة النيل للمقاولات",
      phone: "+20 100 123 4567",
      email: null,
      status: "INACTIVE",
      villaCount: 0,
    },
    { id: "c3", name: HOSTILE, phone: "0111 222 3333", email: null, status: "ACTIVE", villaCount: 1 },
    // Starts with an apostrophe and then a formula sign: the guard doubles the apostrophe so the import gives it back.
    { id: "c4", name: "'=quoted", phone: "0122 333 4444", email: null, status: "ACTIVE", villaCount: 1 },
    { id: "c5", name: "-dash start", phone: "0133 444 5555", email: null, status: "ACTIVE", villaCount: 1 },
  ].map((item) => ({ ...item, createdAt: created, updatedAt: created }));

  const repository = { findByNormalizedNames: vi.fn(), createMany: vi.fn() };

  beforeEach(() => {
    repository.findByNormalizedNames.mockResolvedValue([]);
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `c-${n}`));
  });

  it("is saved as it was exported, whatever the characters", async () => {
    const file = await exporter({ contractors: listOf(items) as never }).contractorsExport(
      parse(listContractorsQuerySchema),
      actor,
      ctx,
    );

    const outcome = await importFile(contractorImportDefinition(repository as never), await bytesOf(file));

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 5, imported: 5, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      items.map((item) => ({
        name: item.name,
        phone: item.phone,
        email: item.email,
        status: item.status,
      })),
    );
  });
});

describe("villas", () => {
  // Two areas and two parties of each kind share a name, which the file writes as the name and the city, or the phone.
  const areas = [
    { id: "a1", name: "New Cairo", city: "Cairo" },
    { id: "a2", name: "New Cairo", city: "Giza" },
    { id: "a3", name: "Maadi", city: "Cairo" },
  ];
  const party = (id: string, name: string, phone: string) => ({ id, name, phone, status: "ACTIVE" as const });
  const civilEngineers = [
    party("e1", "Eng. Mona Adel", "0100 111 2222"),
    party("e2", "Mona", "0100 333 4444"),
    party("e3", "Mona", "0100 555 6666"),
  ];
  // Two electricians share a name too, so the kind of the reference matters: a civil engineer of that name would not tell them apart.
  const electricalEngineers = [
    party("x1", "Hany Wagdy", "0101 777 8888"),
    party("x2", "Hany Wagdy", "0101 999 0000"),
  ];
  const contractors = [
    party("c1", "Nile Builders", "0102 111 1111"),
    party("c2", "Nile", "0102 222 2222"),
    party("c3", "Nile", "0102 333 3333"),
  ];
  const repository = {
    importAreas: vi.fn(async () => areas),
    importCivilEngineers: vi.fn(async () => civilEngineers),
    importElectricalEngineers: vi.fn(async () => electricalEngineers),
    importContractors: vi.fn(async () => contractors),
    storedVillaNumbers: vi.fn(async () => []),
    storedPlots: vi.fn(async () => []),
    lockPhaseSet: vi.fn(),
    lockRefsShared: vi.fn(async () => ({
      areas: new Set(areas.map((a) => a.id)),
      civilEngineers: new Map(civilEngineers.map((p) => [p.id, "ACTIVE"])),
      electricalEngineers: new Map(electricalEngineers.map((p) => [p.id, "ACTIVE"])),
      contractors: new Map(contractors.map((p) => [p.id, "ACTIVE"])),
    })),
    createMany: vi.fn(async (rows: unknown[]) => rows.map((_, n) => `villa-${n}`)),
    insertProgressRowsForMany: vi.fn(),
  };

  const villa = (n: number, overrides: Record<string, unknown>) => ({
    id: `v${n}`,
    villaNumber: `V-${n}`,
    ownerName: null,
    area: "Maadi",
    areaId: "a3",
    block: "B1",
    plot: String(n),
    civilEngineer: { id: "e1", name: "Eng. Mona Adel" },
    electricalEngineer: null,
    contractor: null,
    startDate: null,
    targetDate: null,
    budgetMinor: null,
    currency: null,
    progress: 0,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });

  // What the import is expected to hand to the repository, per row.
  const expected = [
    {
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
      budgetMinor: 0,
      currency: "KWD",
    },
    {
      villaNumber: "V-2",
      ownerName: null,
      areaId: "a2",
      block: "B2",
      plot: "2",
      civilEngineerId: "e2",
      electricalEngineerId: null,
      contractorId: "c3",
      startDate: null,
      targetDate: null,
      budgetMinor: 29,
      currency: "EGP",
    },
    {
      villaNumber: "V-3",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "3",
      civilEngineerId: "e3",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: 125_000_050,
      currency: "EGP",
    },
    {
      villaNumber: "V-4",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "4",
      civilEngineerId: "e1",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: 1234,
      currency: "KWD",
    },
    {
      villaNumber: "V-5",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "5",
      civilEngineerId: "e1",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: 5,
      currency: "JPY",
    },
    {
      villaNumber: "V-6",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "6",
      civilEngineerId: "e1",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: Number.MAX_SAFE_INTEGER,
      currency: "KWD",
    },
    {
      villaNumber: "=V-7",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "7",
      civilEngineerId: "e1",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: null,
      currency: null,
    },
    {
      villaNumber: "V-8",
      ownerName: null,
      areaId: "a3",
      block: "B1",
      plot: "8",
      civilEngineerId: "e1",
      electricalEngineerId: null,
      contractorId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: 1,
      currency: "KWD",
    },
  ];

  const items = [
    villa(1, {
      villaNumber: "007",
      ownerName: "خالد منصور",
      area: "New Cairo",
      areaId: "a1",
      block: "B-1",
      plot: "12",
      electricalEngineer: { id: "x1", name: "Hany Wagdy" },
      contractor: { id: "c1", name: "Nile Builders" },
      startDate: "2026-01-05",
      targetDate: "2026-12-31",
      budgetMinor: 0,
      currency: "KWD",
    }),
    villa(2, {
      area: "New Cairo",
      areaId: "a2",
      block: "B2",
      civilEngineer: { id: "e2", name: "Mona" },
      contractor: { id: "c3", name: "Nile" },
      budgetMinor: 29,
      currency: "EGP",
    }),
    villa(3, { civilEngineer: { id: "e3", name: "Mona" }, budgetMinor: 125_000_050, currency: "EGP" }),
    villa(4, { budgetMinor: 1234, currency: "KWD" }),
    villa(5, { budgetMinor: 5, currency: "JPY" }),
    villa(6, { budgetMinor: Number.MAX_SAFE_INTEGER, currency: "KWD" }),
    villa(7, { villaNumber: "=V-7" }),
    // 0.001 KWD: the smallest amount of a three-decimal currency.
    villa(8, { budgetMinor: 1, currency: "KWD" }),
  ];

  const villasExport = () =>
    exporter({
      villas: {
        ...listOf(items),
        referenceBook: () => new VillasService(repository as never).referenceBook(),
      } as never,
    }).villasExport(parse(listVillasQuerySchema), actor, ctx);

  it("is saved as it was exported: areas and parties found again, budgets exact in every currency (0, 2 and 3 decimals)", async () => {
    const outcome = await importFile(
      villaImportDefinition(repository as never, actor, ctx),
      await bytesOf(await villasExport()),
    );

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 8, imported: 8, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      // The file has no villa type column, so an imported villa has none.
      expected.map((row) => ({ ...row, villaType: null, createdById: actor.id })),
    );
  });

  it("writes an area, a contractor and an engineer that share a name as the import wants them: name and city, or phone", async () => {
    const file = await bytesOf(await villasExport());
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    const rows = workbook.worksheets[0]!;

    const cell = (row: number, header: string): CellValue => {
      const headers = (rows.getRow(1).values as CellValue[]).slice(1);
      return rows.getRow(row).getCell(headers.indexOf(header) + 1).value;
    };
    expect(cell(2, "Area")).toBe("New Cairo, Cairo");
    expect(cell(3, "Area")).toBe("New Cairo, Giza");
    expect(cell(4, "Area")).toBe("Maadi");
    expect(cell(3, "Civil Engineer")).toBe("0100 333 4444");
    expect(cell(3, "Contractor")).toBe("0102 333 3333");
    expect(cell(2, "Civil Engineer")).toBe("Eng. Mona Adel");
    expect(cell(2, "Electrical Engineer")).toBe("0101 777 8888");
  });

  it("imports the same file with the informational columns removed and with the Currency column removed, as KWD", async () => {
    const file = await bytesOf(await villasExport());
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    // Drop Currency (column 12) and the four columns after it; the budgets of the rows are in KWD then.
    sheet.spliceColumns(12, 5);
    const without = Buffer.from(await workbook.xlsx.writeBuffer());

    const outcome = await importFile(villaImportDefinition(repository as never, actor, ctx), without);

    // Without the column every budget is read in the default currency, KWD: a budget exported in EGP or JPY is read as
    // KWD, wrong for that row but a valid file (no currency has more than three decimals). This is why the export writes
    // the Currency column.
    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 8, imported: 8 } });
    const created = repository.createMany.mock.calls.at(-1)![0] as {
      budgetMinor: number | null;
      currency: string | null;
    }[];
    expect(created.map((row) => [row.budgetMinor, row.currency])).toEqual([
      [0, "KWD"],
      [290, "KWD"],
      [1_250_000_500, "KWD"],
      [1234, "KWD"],
      [5000, "KWD"],
      [Number.MAX_SAFE_INTEGER, "KWD"],
      [null, null],
      [1, "KWD"],
    ]);
  });
});

describe("open works", () => {
  const phases = [
    { id: "ep1", name: "First fix", status: "ACTIVE" },
    { id: "ep2", name: "التمديدات", status: "ACTIVE" },
  ];
  const work = (n: number, overrides: Record<string, unknown>) => ({
    id: `w${n}`,
    villa: villaRef,
    elecPhase: { id: "ep1", name: "First fix" },
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    progress: 40,
    contractor: null,
    startDate: null,
    endDate: null,
    overdue: false,
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });
  const items = [
    work(1, {
      priority: "HIGH",
      contractor: { id: "c1", name: "Nile Builders" },
      startDate: "2026-01-05",
      endDate: "2026-02-01",
      overdue: true,
    }),
    work(2, {
      elecPhase: { id: "ep2", name: "التمديدات" },
      status: "DONE",
      priority: "LOW",
      progress: 100,
    }),
  ];

  const repository = {
    importVillas: vi.fn(),
    importContractors: vi.fn(),
    importElecPhases: vi.fn(),
    lockVillasShared: vi.fn(),
    lockElecPhasesShared: vi.fn(),
    lockVillaPhase: vi.fn(),
    takenVillaPhases: vi.fn(),
    createMany: vi.fn(),
  };

  beforeEach(() => {
    repository.lockVillaPhase.mockResolvedValue(undefined);
    repository.takenVillaPhases.mockResolvedValue(new Set());
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001", contractorId: "c1" }]);
    repository.importContractors.mockResolvedValue([
      { id: "c1", name: "Nile Builders", phone: "0100 111 2222", status: "ACTIVE" },
    ]);
    repository.importElecPhases.mockResolvedValue(phases);
    repository.lockVillasShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "c1"])),
    );
    repository.lockElecPhasesShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `w-${n}`));
  });

  const exported = (list: unknown[]) =>
    exporter({ openWorks: listOf(list) as never })
      .openWorksExport(parse(listOpenWorksQuerySchema), actor, ctx)
      .then(bytesOf);

  it("is saved as it was exported, with the informational columns in the file", async () => {
    const outcome = await importFile(
      openWorksImportDefinition(repository as never, actor, ctx),
      await exported(items),
    );

    expect(outcome).toMatchObject({
      status: 201,
      report: { ok: true, total: 2, imported: 2, skipped: 0, errors: [] },
    });
    expect(repository.createMany.mock.calls[0]![0]).toEqual([
      {
        villaId: "v1",
        elecPhaseId: "ep1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        progress: 40,
        contractorId: "c1",
        startDate: day("2026-01-05"),
        endDate: day("2026-02-01"),
        createdById: actor.id,
      },
      {
        villaId: "v1",
        elecPhaseId: "ep2",
        status: "DONE",
        priority: "LOW",
        progress: 100,
        contractorId: null,
        startDate: null,
        endDate: null,
        createdById: actor.id,
      },
    ]);
  });

  it("checks the file in a dry run, and saves nothing", async () => {
    const outcome = await importFile(
      openWorksImportDefinition(repository as never, actor, ctx),
      await exported(items),
      true,
    );

    expect(outcome).toMatchObject({
      status: 200,
      report: { ok: true, total: 2, imported: 0, skipped: 0, errors: [] },
    });
    expect(repository.createMany).not.toHaveBeenCalled();
  });
});

describe("daily reports", () => {
  const contractors = [
    { id: "c1", name: "Nile Builders", phone: "0100 111 2222", status: "ACTIVE" },
    { id: "c2", name: "حمدي", phone: "0100 333 4444", status: "ACTIVE" },
  ];
  const engineers = [
    { id: "x1", name: "Mona Hassan", phone: "0101 111 1111", status: "ACTIVE" },
    { id: "x2", name: "المهندس حمدي", phone: "0101 222 2222", status: "ACTIVE" },
  ];
  const report = (n: number, overrides: Record<string, unknown>) => ({
    id: `d${n}`,
    reportDate: `2026-03-0${n}`,
    weather: "SUNNY",
    workersCount: 10,
    notes: null,
    contractor: { id: "c1", name: "Nile Builders" },
    preparedBy: { id: "x1", name: "Mona Hassan" },
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });
  const items = [
    report(1, { workersCount: 0, notes: LONG_5000 }),
    report(2, {
      workersCount: 100_000,
      weather: "DUSTY",
      contractor: { id: "c2", name: "حمدي" },
      preparedBy: { id: "x2", name: "المهندس حمدي" },
      notes: HOSTILE,
    }),
    report(3, { weather: "RAINY", notes: "'=quoted" }),
    report(4, { notes: "Late delivery\nof cement" }),
  ];
  const repository = {
    userExists: vi.fn(),
    importContractors: vi.fn(),
    importEngineers: vi.fn(),
    existingDays: vi.fn(),
    lockContractorsShared: vi.fn(),
    lockEngineersShared: vi.fn(),
    createMany: vi.fn(),
  };
  const references = () =>
    new VillasService({
      importAreas: async () => [],
      importCivilEngineers: async () => [],
      importElectricalEngineers: async () => engineers,
      importContractors: async () => contractors,
    } as never).referenceBook();
  beforeEach(() => {
    repository.userExists.mockResolvedValue(true);
    repository.importContractors.mockResolvedValue(contractors);
    repository.importEngineers.mockResolvedValue(engineers);
    repository.existingDays.mockResolvedValue([]);
    repository.lockContractorsShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.lockEngineersShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `r-${n}`));
  });

  it("is saved as it was exported: the long text, the guarded texts, the Arabic and the bounds", async () => {
    const file = await exporter({
      dailyReports: listOf(items) as never,
      villas: { referenceBook: references } as never,
    }).dailyReportsExport(parse(listDailyReportsQuerySchema), actor, ctx);

    const outcome = await importFile(
      dailyReportsImportDefinition(repository as never, actor, ctx, () => NOW),
      await bytesOf(file),
    );

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 4, imported: 4, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      items.map((item) => ({
        contractorId: item.contractor.id,
        preparedByEngineerId: item.preparedBy.id,
        reportDate: day(item.reportDate),
        weather: item.weather,
        workersCount: item.workersCount,
        notes: item.notes,
        createdById: actor.id,
      })),
    );
  });
});

describe("small works", () => {
  const smallWork = (n: number, overrides: Record<string, unknown>) => ({
    id: `m${n}`,
    villa: villaRef,
    contractor: { id: "c1", name: "Nile Builders" },
    startDate: `2026-03-0${n}`,
    endDate: `2026-03-0${n + 1}`,
    deadlineAt: `2026-03-0${n + 1}T21:00:00.000Z`,
    overdue: true,
    dueSoon: false,
    description: "Replaced a socket",
    status: "PENDING",
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });
  const items = [
    smallWork(1, { description: "x".repeat(500) }),
    smallWork(2, {
      status: "DONE",
      contractor: { id: "c4", name: "حمدي" },
      description: HOSTILE,
    }),
    // One of the two contractors named Nile: the file carries what tells it from the other (its phone).
    smallWork(3, { contractor: { id: "c3", name: "Nile" } }),
  ];
  const contractors = [
    { id: "c1", name: "Nile Builders", phone: "0102 111 1111", status: "ACTIVE" },
    { id: "c2", name: "Nile", phone: "0102 222 2222", status: "ACTIVE" },
    { id: "c3", name: "Nile", phone: "0102 333 3333", status: "ACTIVE" },
    { id: "c4", name: "حمدي", phone: "0102 444 4444", status: "ACTIVE" },
  ];
  const repository = {
    userExists: vi.fn(),
    importVillas: vi.fn(),
    importContractors: vi.fn(),
    lockVillasShared: vi.fn(),
    lockContractorsShared: vi.fn(),
    createMany: vi.fn(),
  };
  const references = () =>
    new VillasService({
      importAreas: async () => [],
      importCivilEngineers: async () => [],
      importElectricalEngineers: async () => [],
      importContractors: async () => contractors,
    } as never).referenceBook();
  beforeEach(() => {
    repository.userExists.mockResolvedValue(true);
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001" }]);
    repository.importContractors.mockResolvedValue(contractors);
    repository.lockVillasShared.mockImplementation(async (ids: string[]) => new Set(ids));
    repository.lockContractorsShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `s-${n}`));
  });

  it("is saved as it was exported: a description of 500 characters, the guarded texts and two contractors of one name", async () => {
    const file = await exporter({
      smallWorks: listOf(items) as never,
      villas: { referenceBook: references } as never,
    }).smallWorksExport(parse(listSmallWorksQuerySchema), actor, ctx);

    const outcome = await importFile(
      smallWorksImportDefinition(repository as never, actor, ctx, () => NOW),
      await bytesOf(file),
    );

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 3, imported: 3, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      items.map((item) => ({
        villaId: "v1",
        contractorId: item.contractor.id,
        startDate: day(item.startDate),
        endDate: day(item.endDate),
        description: item.description,
        status: item.status,
        createdById: actor.id,
      })),
    );
  });
});

describe("site reports", () => {
  const siteReport = (n: number, overrides: Record<string, unknown>) => ({
    id: `r${n}`,
    villa: villaRef,
    visitDate: `2026-03-0${n}`,
    title: "Weekly walk",
    inspector: "Eng. Hamdy",
    type: "SAFETY",
    rating: 3,
    findings: "All fine",
    recommendations: null,
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });
  const items = [
    siteReport(1, { rating: 1, findings: LONG_5000, recommendations: LONG_5000 }),
    siteReport(2, { rating: 5, title: HOSTILE, inspector: "المهندس حمدي", type: "QUALITY" }),
    siteReport(3, { title: "t".repeat(150), recommendations: "Keep it up\nand keep it clean" }),
  ];
  const repository = {
    userExists: vi.fn(),
    importVillas: vi.fn(),
    lockVillasShared: vi.fn(),
    createMany: vi.fn(),
  };
  beforeEach(() => {
    repository.userExists.mockResolvedValue(true);
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001" }]);
    repository.lockVillasShared.mockImplementation(async (ids: string[]) => new Set(ids));
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `s-${n}`));
  });

  it("is saved as it was exported: texts of 5,000 characters, the ratings at both ends, Arabic and a formula", async () => {
    const file = await exporter({ siteReports: listOf(items) as never }).siteReportsExport(
      parse(listSiteReportsQuerySchema),
      actor,
      ctx,
    );

    const outcome = await importFile(
      siteReportsImportDefinition(repository as never, actor, ctx, () => NOW),
      await bytesOf(file),
    );

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 3, imported: 3, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      items.map((item) => ({
        villaId: "v1",
        visitDate: day(item.visitDate),
        title: item.title,
        inspector: item.inspector,
        type: item.type,
        rating: item.rating,
        findings: item.findings,
        recommendations: item.recommendations,
        createdById: actor.id,
      })),
    );
  });
});

describe("daily labour", () => {
  const labour = (n: number, overrides: Record<string, unknown>) => ({
    id: `b${n}`,
    villa: villaRef,
    labourDate: `2026-03-0${n}`,
    contractor: { id: "c1", name: "Nile Builders" },
    labourCount: 5,
    notes: null,
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  });
  const items = [
    labour(1, { labourCount: 1, notes: "Two shifts\nnight shift too" }),
    labour(2, { labourCount: 100_000, notes: HOSTILE }),
    labour(3, { notes: "ملاحظات بالعربي" }),
  ];
  const repository = {
    importVillas: vi.fn(),
    importContractors: vi.fn(),
    existingKeys: vi.fn(),
    lockVillasShared: vi.fn(),
    createMany: vi.fn(),
  };
  beforeEach(() => {
    repository.importVillas.mockResolvedValue([{ id: "v1", villaNumber: "P-001", contractorId: "c1" }]);
    repository.importContractors.mockResolvedValue([
      { id: "c1", name: "Nile Builders", phone: "0100 111 2222", status: "ACTIVE" },
    ]);
    repository.existingKeys.mockResolvedValue([]);
    repository.lockVillasShared.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, "c1"])),
    );
    repository.createMany.mockImplementation(async (rows: unknown[]) => rows.map((_, n) => `b-${n}`));
  });

  it("is saved as it was exported: the contractor found again, the counts at both ends, the notes", async () => {
    const file = await exporter({ dailyLabour: listOf(items) as never }).dailyLabourExport(
      parse(listDailyLabourQuerySchema),
      actor,
      ctx,
    );

    const outcome = await importFile(
      dailyLabourImportDefinition(repository as never, actor, ctx, () => NOW),
      await bytesOf(file),
    );

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, total: 3, imported: 3, skipped: 0 } });
    expect(repository.createMany.mock.calls[0]![0]).toEqual(
      items.map((item) => ({
        villaId: "v1",
        labourDate: day(item.labourDate),
        contractorId: "c1",
        labourCount: item.labourCount,
        notes: item.notes,
        createdById: actor.id,
      })),
    );
  });
});
