import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import { listAreasQuerySchema } from "../../../src/modules/areas/index.js";
import { listAuditLogsQuerySchema } from "../../../src/modules/audit/index.js";
import { listCivilEngineersQuerySchema } from "../../../src/modules/civil-engineers/index.js";
import { listElectricalEngineersQuerySchema } from "../../../src/modules/electrical-engineers/index.js";
import {
  contractorSummaryQuerySchema,
  listContractorsQuerySchema,
} from "../../../src/modules/contractors/index.js";
import { ExportsService } from "../../../src/modules/exports/service/exports.service.js";
import {
  exportQuery,
  type ParsedExport,
} from "../../../src/modules/exports/validators/exports.validators.js";
import { listDailyLabourQuerySchema } from "../../../src/modules/daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../../src/modules/daily-reports/index.js";
import { listOpenWorksQuerySchema } from "../../../src/modules/open-works/index.js";
import { listSiteReportsQuerySchema } from "../../../src/modules/site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../../src/modules/small-works/index.js";
import { listVillasQuerySchema } from "../../../src/modules/villas/index.js";
import type { ExportDocument, ExportFormat, ExportRow } from "../../../src/shared/export/types.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
const transaction = vi.hoisted(() => ({ marker: "tx" }));
vi.mock("../../../src/core/database/prisma.js", () => ({
  prisma: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transaction) },
}));
import { audit } from "../../../src/core/audit/audit.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const actor: Actor = { id: "user-1", role: "EMPLOYEE" };
const NOW = new Date("2026-10-12T13:55:00.000Z");
const CONTRACTOR = "11111111-1111-4111-8111-111111111111";

// The reference book of a fake villas service: every area and party is written as its name.
const names = {
  area: ({ name }: { name: string }) => name,
  party: (_kind: string, { name }: { name: string }) => name,
};

const villa = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  villaNumber: `P-${String(n).padStart(3, "0")}`,
  ownerName: "Khaled Mansour",
  area: "New Cairo",
  areaId: "a1",
  block: "B1",
  plot: "007",
  civilEngineer: { id: "e1", name: "Mona Hassan" },
  electricalEngineer: { id: "x1", name: "Hany Wagdy" },
  contractor: { id: "c1", name: "Nile Builders" },
  startDate: "2026-01-05",
  targetDate: null,
  budgetMinor: 1_250_500,
  currency: "KWD",
  progress: 62.5,
  createdAt: "2026-03-04T05:06:07.890Z",
  updatedAt: "2026-03-05T05:06:07.890Z",
  ...overrides,
});

// A list service that answers page by page, like the real ones.
function paged<Item>(total: number, make: (n: number) => Item, pageSize = 1000) {
  return vi.fn(async (query: { page: number }) => {
    const start = (query.page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    return {
      items: Array.from({ length: count }, (_, i) => make(start + i + 1)),
      meta: {
        page: query.page,
        limit: pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  });
}

type Captured = { document: ExportDocument; rows: ExportRow[] };

// A writer that reads every row, as a real one does, and keeps what it was given.
function recordingWriter() {
  const seen: Captured[] = [];
  const write = vi.fn(async (document: ExportDocument) => {
    const rows: ExportRow[] = [];
    for await (const chunk of document.rows) rows.push(...chunk);
    seen.push({ document, rows });
    return { rows: rows.length };
  });
  return { write, seen };
}

function setup(lists: { total?: number } = {}) {
  const total = lists.total ?? 3;
  const villas = { list: paged(total, villa), referenceBook: vi.fn(async () => names) };
  const contractors = {
    list: paged(total, (n) => ({
      id: `c${n}`,
      name: `Contractor ${n}`,
      phone: "0100 123 4567",
      email: n === 2 ? "second@example.test" : null,
      status: n === 2 ? "INACTIVE" : "ACTIVE",
      villaCount: n,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-04T05:06:07.890Z",
    })),
    summary: vi.fn(async (_id: string, query: { page: number }) => {
      const page = await paged(total, (n) => ({
        id: `p${n}`,
        villaNumber: `P-${String(n).padStart(3, "0")}`,
        area: "New Cairo",
        block: "B1",
        plot: "007",
        startDate: null,
        targetDate: "2026-02-01",
      }))(query);
      return {
        summary: {
          contractor: { id: CONTRACTOR, name: "Nile Builders", phone: "0102 000 0001" },
          villaCount: 40,
          villas: page.items,
        },
        meta: page.meta,
      };
    }),
  };
  const civilEngineers = {
    list: paged(total, (n) => ({
      id: `e${n}`,
      name: `Engineer ${n}`,
      phone: "0101 765 4321",
      email: n === 2 ? "second@example.test" : null,
      status: n === 2 ? "INACTIVE" : "ACTIVE",
      villaCount: 0,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-04T05:06:07.890Z",
    })),
  };
  const electricalEngineers = {
    list: paged(total, (n) => ({
      id: `x${n}`,
      name: `Electrician ${n}`,
      phone: "0101 765 4321",
      email: n === 2 ? "second@example.test" : null,
      status: n === 2 ? "INACTIVE" : "ACTIVE",
      villaCount: n,
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-04T05:06:07.890Z",
    })),
  };
  const areas = {
    list: paged(total, (n) => ({
      id: `ar${n}`,
      name: `Area ${n}`,
      city: n === 2 ? "Giza" : "Cairo",
      villaCount: n,
      version: 1,
      createdAt: "2026-03-04T05:06:07.890Z",
      updatedAt: "2026-03-04T05:06:07.890Z",
    })),
  };
  const auditLogs = {
    list: paged(total, (n) => ({
      id: `a${n}`,
      actor: n % 2 === 0 ? null : { id: "u1", name: "Root Admin", email: "root@example.test" },
      action: "villa.create",
      actionLabel: "إنشاء فيلا",
      // The list item is in the request language; the export reads the stable codes, so it stays English.
      entity: "مشروع",
      entityCode: "Villa",
      entityId: `p${n}`,
      entityName: null,
      entityDetail: null,
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req",
      createdAt: "2026-03-04T05:06:00.000Z",
    })),
  };
  const xlsx = recordingWriter();
  const pdf = recordingWriter();
  const service = new ExportsService({
    villas: villas as never,
    contractors: contractors as never,
    civilEngineers: civilEngineers as never,
    electricalEngineers: electricalEngineers as never,
    areas: areas as never,
    auditLogs: auditLogs as never,
    writers: { xlsx: xlsx.write, pdf: pdf.write },
    now: () => NOW,
  });
  return {
    service,
    villas,
    contractors,
    civilEngineers,
    electricalEngineers,
    areas,
    auditLogs,
    xlsx,
    pdf,
  };
}

const parse = <Schema extends Parameters<typeof exportQuery>[0]>(
  schema: Schema,
  input: Record<string, string> = {},
  format: ExportFormat = "xlsx",
) => ({ format, query: schema.parse({ page: "1", limit: "1000", ...input }) }) as ParsedExport<never>;

type Runner = [
  string,
  (
    s: ReturnType<typeof setup>,
    format?: ExportFormat,
    context?: RequestContext,
  ) => Promise<{
    filename: string;
    contentType: string;
    write: (out: PassThrough) => Promise<{ rows: number }>;
  }>,
];

const runners: Runner[] = [
  [
    "villas",
    (s, f = "xlsx", c = ctx) => s.service.villasExport(parse(listVillasQuerySchema, {}, f), actor, c),
  ],
  [
    "contractors",
    (s, f = "xlsx", c = ctx) =>
      s.service.contractorsExport(parse(listContractorsQuerySchema, {}, f), actor, c),
  ],
  [
    "civil engineers",
    (s, f = "xlsx", c = ctx) =>
      s.service.civilEngineersExport(parse(listCivilEngineersQuerySchema, {}, f), actor, c),
  ],
  [
    "contractor summary",
    (s, f = "xlsx", c = ctx) =>
      s.service.contractorSummaryExport(CONTRACTOR, parse(contractorSummaryQuerySchema, {}, f), actor, c),
  ],
  [
    "audit log",
    (s, f = "xlsx", c = ctx) => s.service.auditLogsExport(parse(listAuditLogsQuerySchema, {}, f), actor, c),
  ],
  [
    "electrical engineers",
    (s, f = "xlsx", c = ctx) =>
      s.service.electricalEngineersExport(parse(listElectricalEngineersQuerySchema, {}, f), actor, c),
  ],
  ["areas", (s, f = "xlsx", c = ctx) => s.service.areasExport(parse(listAreasQuerySchema, {}, f), actor, c)],
];

beforeEach(() => {
  vi.mocked(audit.record).mockReset();
});

describe("the row cap", () => {
  it.each(runners)(
    "%s: more than 10,000 rows is 422 EXPORT_TOO_LARGE, decided by the first page alone",
    async (_name, run) => {
      const s = setup({ total: 10_001 });

      const failure = await run(s).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ statusCode: 422, code: "EXPORT_TOO_LARGE" });
      const lists = [
        s.villas.list,
        s.contractors.list,
        s.civilEngineers.list,
        s.electricalEngineers.list,
        s.areas.list,
        s.auditLogs.list,
        s.contractors.summary,
      ];
      expect(lists.reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1);
      expect(s.xlsx.write).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it.each(runners)("%s: exactly 10,000 rows is allowed", async (_name, run) => {
    const s = setup({ total: 10_000 });

    await expect(run(s)).resolves.toBeDefined();
  });

  it("the refusal is translated", async () => {
    const s = setup({ total: 10_001 });

    const en = await runners[0]![1](s).catch((e: AppError) => e);
    const ar = await runners[0]![1](s, "xlsx", ctxAr).catch((e: AppError) => e);

    expect((en as AppError).message).toBe(
      "This export has more than 10,000 records. Narrow the filters and try again",
    );
    expect((ar as AppError).message).toBe(
      "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    );
  });

  it("an empty list is fine", async () => {
    const s = setup({ total: 0 });

    const file = await runners[0]![1](s);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows).toEqual([]);
  });
});

describe("reading the list", () => {
  it("asks for page 1 once, and uses it for both the count and the first rows", async () => {
    const s = setup({ total: 5 });

    const file = await runners[0]![1](s);
    await file.write(new PassThrough());

    expect(s.villas.list).toHaveBeenCalledTimes(1);
    expect(s.xlsx.seen[0]?.rows).toHaveLength(5);
  });

  it("reads the following pages, one per 1000 rows, each once and in order", async () => {
    const s = setup({ total: 2_500 });

    const file = await runners[0]![1](s);
    await file.write(new PassThrough());

    expect(s.villas.list.mock.calls.map(([query]) => query.page)).toEqual([1, 2, 3]);
    expect(s.xlsx.seen[0]?.rows.map((row) => row["Villa Number"])).toEqual(
      Array.from({ length: 2_500 }, (_, i) => `P-${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("passes the list the filters it was given, with page and the biggest page size", async () => {
    const s = setup();

    await s.service.villasExport(
      parse(listVillasQuerySchema, { block: "B1", area: "New Cairo", sort: "villaNumber:desc" }),
      actor,
      ctx,
    );

    expect(s.villas.list).toHaveBeenCalledWith(
      expect.objectContaining({
        block: "B1",
        area: "New Cairo",
        sort: "villaNumber:desc",
        page: 1,
        limit: 1000,
      }),
    );
  });

  it("is lazy: later pages are not read until the writer asks for them", async () => {
    const s = setup({ total: 3_000 });

    const file = await runners[0]![1](s);

    expect(s.villas.list).toHaveBeenCalledTimes(1);
    await file.write(new PassThrough());
    expect(s.villas.list).toHaveBeenCalledTimes(3);
  });

  it("stops if a later page comes back empty (the data shrank)", async () => {
    const s = setup({ total: 2_500 });
    s.villas.list.mockImplementation(async (query: { page: number }) => ({
      items: query.page === 1 ? Array.from({ length: 1000 }, (_, i) => villa(i + 1)) : [],
      meta: { page: query.page, limit: 1000, total: 2_500, totalPages: 3 },
    }));

    const file = await runners[0]![1](s);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows).toHaveLength(1000);
    expect(s.villas.list).toHaveBeenCalledTimes(2);
  });

  it("each export reads from its own module's list service", async () => {
    const s = setup();
    for (const [, run] of runners) await run(s);

    expect(s.villas.list).toHaveBeenCalledTimes(1);
    expect(s.contractors.list).toHaveBeenCalledTimes(1);
    expect(s.civilEngineers.list).toHaveBeenCalledTimes(1);
    expect(s.electricalEngineers.list).toHaveBeenCalledTimes(1);
    expect(s.areas.list).toHaveBeenCalledTimes(1);
    expect(s.auditLogs.list).toHaveBeenCalledTimes(1);
    expect(s.contractors.summary).toHaveBeenCalledWith(CONTRACTOR, expect.objectContaining({ page: 1 }), ctx);
  });
});

describe("the audit entry", () => {
  it("is written inside a transaction, before the file is generated", async () => {
    const s = setup();
    const order: string[] = [];
    vi.mocked(audit.record).mockImplementation(async () => void order.push("audit"));
    s.xlsx.write.mockImplementation(async () => (order.push("write"), { rows: 0 }));

    const file = await runners[0]![1](s);
    order.push("prepared");
    await file.write(new PassThrough());

    expect(order).toEqual(["audit", "prepared", "write"]);
    expect(vi.mocked(audit.record).mock.calls[0]?.[0]).toBe(transaction);
  });

  it("holds the filters, the format and the counted rows, with the actor and request details", async () => {
    const s = setup({ total: 42 });

    await s.service.villasExport(
      parse(listVillasQuerySchema, { block: "B2", search: "cairo", plot: "7" }, "pdf"),
      actor,
      ctx,
    );

    expect(vi.mocked(audit.record).mock.calls[0]?.[1]).toEqual({
      actorId: "user-1",
      action: "export.villas",
      entity: "Villa",
      after: {
        format: "pdf",
        filters: { block: "B2", search: "cairo", plot: "7" },
        rowCount: 42,
      },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
  });

  it.each([
    ["villas", 0, "export.villas", "Villa"],
    ["contractors", 1, "export.contractors", "Contractor"],
    ["civil engineers", 2, "export.civil-engineers", "CivilEngineer"],
    ["contractor summary", 3, "export.contractor-summary", "Contractor"],
    ["audit log", 4, "export.audit-logs", "AuditLog"],
    ["electrical engineers", 5, "export.electrical-engineers", "ElectricalEngineer"],
    ["areas", 6, "export.areas", "Area"],
  ])("%s: action %s... entity %s", async (_name, index, action, entity) => {
    const s = setup({ total: 7 });

    await runners[index]![1](s);

    expect(vi.mocked(audit.record).mock.calls[0]?.[1]).toMatchObject({
      action,
      entity,
      after: { rowCount: 7 },
    });
  });

  it("never records data rows", async () => {
    const s = setup({ total: 3 });

    const file = await runners[0]![1](s);
    await file.write(new PassThrough());

    const recorded = JSON.stringify(vi.mocked(audit.record).mock.calls);
    expect(recorded).not.toContain("P-001");
    expect(recorded).not.toContain("Nile");
    expect(recorded).not.toContain("Mona");
  });

  it("the contractor summary entry carries the contractor id", async () => {
    const s = setup();

    await runners[3]![1](s);

    expect(vi.mocked(audit.record).mock.calls[0]?.[1]).toMatchObject({ entityId: CONTRACTOR });
    expect(vi.mocked(audit.record).mock.calls[1]).toBeUndefined();
  });

  it("a failing audit write stops the export before any file is made", async () => {
    const s = setup();
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(runners[0]![1](s)).rejects.toThrow("audit down");

    expect(s.xlsx.write).not.toHaveBeenCalled();
  });
});

describe("the document handed to the writer", () => {
  async function documentOf(run: Runner[1], format: ExportFormat = "xlsx", total = 3, context = ctx) {
    const s = setup({ total });
    const file = await run(s, format, context);
    await file.write(new PassThrough());
    const writer = format === "xlsx" ? s.xlsx : s.pdf;
    return { s, file, captured: writer.seen[0]! };
  }

  it("uses the writer for the format, and the right content type and file name", async () => {
    const xlsx = await documentOf(runners[0]![1], "xlsx");
    const pdf = await documentOf(runners[0]![1], "pdf");

    expect(xlsx.s.xlsx.write).toHaveBeenCalledTimes(1);
    expect(xlsx.s.pdf.write).not.toHaveBeenCalled();
    expect(pdf.s.pdf.write).toHaveBeenCalledTimes(1);
    expect(xlsx.file).toMatchObject({
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "asico-villas-2026-10-12.xlsx",
    });
    expect(pdf.file).toMatchObject({
      contentType: "application/pdf",
      filename: "asico-villas-2026-10-12.pdf",
    });
  });

  it.each([
    [0, "asico-villas-2026-10-12", "Villas"],
    [1, "asico-contractors-2026-10-12", "Contractors"],
    [2, "asico-civil-engineers-2026-10-12", "Civil Engineers"],
    [3, "asico-contractor-summary-2026-10-12", "Contractor Summary"],
    [4, "asico-audit-logs-2026-10-12", "Audit Log"],
  ])("export %i: file name %s, title %s", async (index, stem, title) => {
    const { file, captured } = await documentOf(runners[index]![1]);

    expect(file.filename).toBe(`${stem}.xlsx`);
    expect(captured.document.title).toBe(title);
    expect(captured.document.generatedAt).toEqual(NOW);
  });

  it("is English whatever the request language", async () => {
    const english = await documentOf(runners[0]![1], "xlsx", 3, ctx);
    const arabic = await documentOf(runners[0]![1], "xlsx", 3, ctxAr);

    expect(arabic.captured.document.title).toBe(english.captured.document.title);
    expect(arabic.captured.document.columns).toEqual(english.captured.document.columns);
    expect(arabic.captured.rows).toEqual(english.captured.rows);
    expect(arabic.captured.document.filters).toEqual(english.captured.document.filters);
    expect(arabic.file.filename).toBe(english.file.filename);
  });

  it("villas, in a workbook: the columns of the import first, then the others, one row of cells under their headers", async () => {
    const { captured } = await documentOf(runners[0]![1]);

    expect(captured.document.columns.map((c) => [c.key, c.title, c.kind])).toEqual([
      ["Villa Number", "Villa Number", "text"],
      ["Owner Name", "Owner Name", "text"],
      ["Area", "Area", "text"],
      ["Block", "Block", "text"],
      ["Plot", "Plot", "text"],
      ["Contractor", "Contractor", "text"],
      ["Electrical Engineer", "Electrical Engineer", "text"],
      ["Civil Engineer", "Civil Engineer", "text"],
      ["Start Date", "Start Date", "date"],
      ["Target Date", "Target Date", "date"],
      ["Budget", "Budget", "amount"],
      ["Currency", "Currency", "text"],
      ["Progress", "Progress", "text"],
      ["Created (UTC)", "Created (UTC)", "datetime"],
    ]);
    expect(captured.rows[0]).toEqual({
      "Villa Number": "P-001",
      "Owner Name": "Khaled Mansour",
      Area: "New Cairo",
      Block: "B1",
      Plot: "007",
      Contractor: "Nile Builders",
      "Electrical Engineer": "Hany Wagdy",
      "Civil Engineer": "Mona Hassan",
      "Start Date": new Date("2026-01-05T00:00:00.000Z"),
      "Target Date": null,
      Budget: 1250.5,
      Currency: "KWD",
      Progress: "62.5%",
      "Created (UTC)": new Date("2026-03-04T05:06:07.890Z"),
    });
  });

  it("villas, in a PDF: the columns it had before, with the budget written with its currency", async () => {
    const { captured } = await documentOf(runners[0]![1], "pdf");

    expect(captured.document.columns.map((c) => c.title)).toEqual([
      "Villa Number",
      "Owner Name",
      "Area",
      "Block",
      "Plot",
      "Civil Engineer",
      "Electrical Engineer",
      "Contractor",
      "Start Date",
      "Target Date",
      "Budget",
      "Progress",
      "Created (UTC)",
    ]);
    expect(captured.rows[0]).toEqual({
      villaNumber: "P-001",
      ownerName: "Khaled Mansour",
      area: "New Cairo",
      block: "B1",
      plot: "007",
      civilEngineer: "Mona Hassan",
      electricalEngineer: "Hany Wagdy",
      contractor: "Nile Builders",
      startDate: new Date("2026-01-05T00:00:00.000Z"),
      targetDate: null,
      budget: "1250.500 KWD",
      progress: "62.5%",
      createdAt: new Date("2026-03-04T05:06:07.890Z"),
    });
  });

  it("the progress is text with one decimal, whole numbers and the bounds included", async () => {
    const s = setup({ total: 4 });
    s.villas.list.mockResolvedValue({
      items: [
        villa(1, { progress: 0 }),
        villa(2, { progress: 100 }),
        villa(3, { progress: 7 }),
        villa(4, { progress: 33.3 }),
      ],
      meta: { page: 1, limit: 1000, total: 4, totalPages: 1 },
    });

    const file = await s.service.villasExport(parse(listVillasQuerySchema, {}, "pdf"), actor, ctx);
    await file.write(new PassThrough());

    expect(s.pdf.seen[0]?.rows.map((row) => row["progress"])).toEqual(["0.0%", "100.0%", "7.0%", "33.3%"]);
    expect(s.pdf.seen[0]?.document.columns.find((c) => c.key === "progress")?.kind).toBe("text");
  });

  it("a villa without a contractor has an empty contractor cell", async () => {
    const s = setup({ total: 1 });
    s.villas.list.mockResolvedValue({
      items: [villa(1, { contractor: null })],
      meta: { page: 1, limit: 1000, total: 1, totalPages: 1 },
    });

    const file = await s.service.villasExport(parse(listVillasQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows[0]?.["Contractor"]).toBeNull();
  });

  it("a villa without an owner, electrical engineer or budget has empty cells", async () => {
    const s = setup({ total: 1 });
    s.villas.list.mockResolvedValue({
      items: [villa(1, { ownerName: null, electricalEngineer: null, budgetMinor: null, currency: null })],
      meta: { page: 1, limit: 1000, total: 1, totalPages: 1 },
    });

    const file = await s.service.villasExport(parse(listVillasQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows[0]).toMatchObject({
      "Owner Name": null,
      "Electrical Engineer": null,
      Budget: null,
      Currency: null,
    });
  });

  it("a budget is a number in its currency's own units in a workbook, and text with the currency in a PDF", async () => {
    const s = setup({ total: 1 });
    s.villas.list.mockResolvedValue({
      items: [
        villa(1, { budgetMinor: 5, currency: "JPY" }),
        villa(2, { budgetMinor: 0, currency: "USD" }),
        villa(3, { budgetMinor: 1250050, currency: "KWD" }),
        villa(4, { budgetMinor: 125050, currency: "EGP" }),
        villa(5, { budgetMinor: 1, currency: "KWD" }),
      ],
      meta: { page: 1, limit: 1000, total: 5, totalPages: 1 },
    });

    const sheet = await s.service.villasExport(parse(listVillasQuerySchema), actor, ctx);
    await sheet.write(new PassThrough());
    const pdf = await s.service.villasExport(parse(listVillasQuerySchema, {}, "pdf"), actor, ctx);
    await pdf.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows.map((row) => [row["Budget"], row["Currency"]])).toEqual([
      [5, "JPY"],
      [0, "USD"],
      [1250.05, "KWD"],
      [1250.5, "EGP"],
      [0.001, "KWD"],
    ]);
    expect(s.pdf.seen[0]?.rows.map((row) => row["budget"])).toEqual([
      "5 JPY",
      "0.00 USD",
      "1250.050 KWD",
      "1250.50 EGP",
      "0.001 KWD",
    ]);
  });

  it("plot numbers and villa numbers are text columns", async () => {
    const { captured } = await documentOf(runners[0]![1]);

    const kinds = Object.fromEntries(captured.document.columns.map((c) => [c.key, c.kind]));
    expect(kinds).toMatchObject({
      "Villa Number": "text",
      Plot: "text",
      "Start Date": "date",
      "Target Date": "date",
      "Created (UTC)": "datetime",
    });
  });

  it("contractors in a workbook have the columns of the import, then the others", async () => {
    const { captured } = await documentOf(runners[1]![1]);

    expect(captured.document.columns.map((c) => [c.key, c.title, c.kind])).toEqual([
      ["Name", "Name", "text"],
      ["Phone", "Phone", "text"],
      ["Email", "Email", "text"],
      ["Status", "Status", "text"],
      ["Villas", "Villas", "integer"],
      ["Created (UTC)", "Created (UTC)", "datetime"],
    ]);
    expect(captured.rows[0]).toEqual({
      Name: "Contractor 1",
      Phone: "0100 123 4567",
      Email: null,
      Status: "Active",
      Villas: 1,
      "Created (UTC)": new Date("2026-03-04T05:06:07.890Z"),
    });
  });

  it("contractors in a PDF and civil engineers share the people columns", async () => {
    const contractors = await documentOf(runners[1]![1], "pdf");
    const engineers = await documentOf(runners[2]![1]);

    expect(contractors.captured.document.columns.map((c) => c.title)).toEqual([
      "Name",
      "Phone",
      "Email",
      "Status",
      "Villas",
      "Created (UTC)",
    ]);
    expect(engineers.captured.document.columns).toEqual(contractors.captured.document.columns);
    expect(contractors.captured.rows[0]).toMatchObject({
      name: "Contractor 1",
      phone: "0100 123 4567",
      email: "",
      status: "Active",
      villaCount: 1,
    });
  });

  it("the people exports show each record's email and a readable status, English whatever the language", async () => {
    for (const index of [1, 2, 5]) {
      const { captured } = await documentOf(runners[index]![1], "pdf");

      expect(captured.rows.map((row) => [row["email"], row["status"]])).toEqual([
        ["", "Active"],
        ["second@example.test", "Inactive"],
        ["", "Active"],
      ]);
    }
  });

  it("electrical engineers have name, phone, email, status, the number of villas and created", async () => {
    const { captured } = await documentOf(runners[5]![1]);

    expect(captured.document.columns.map((c) => c.title)).toEqual([
      "Name",
      "Phone",
      "Email",
      "Status",
      "Villas",
      "Created (UTC)",
    ]);
    expect(captured.rows.map((row) => row["villaCount"])).toEqual([1, 2, 3]);
  });

  it("areas have name, city, the number of villas and created, with the count as a whole number", async () => {
    const { captured } = await documentOf(runners[6]![1]);

    expect(captured.document.columns.map((c) => [c.key, c.title, c.kind])).toEqual([
      ["name", "Name", "text"],
      ["city", "City", "text"],
      ["villaCount", "Villas", "integer"],
      ["createdAt", "Created (UTC)", "datetime"],
    ]);
    expect(captured.rows[0]).toEqual({
      name: "Area 1",
      city: "Cairo",
      villaCount: 1,
      createdAt: new Date("2026-03-04T05:06:07.890Z"),
    });
    expect(captured.rows[1]).toMatchObject({ city: "Giza", villaCount: 2 });
  });

  it("the areas export is called Areas and its file asico-areas-<date>", async () => {
    const { file, captured } = await documentOf(runners[6]![1]);

    expect(file.filename).toBe("asico-areas-2026-10-12.xlsx");
    expect(captured.document.title).toBe("Areas");
    expect(captured.document.sheetName).toBe("Areas");
  });

  it("audit rows hold the actor and no snapshots", async () => {
    const { captured } = await documentOf(runners[4]![1]);

    expect(captured.document.columns.map((c) => c.key)).toEqual([
      "time",
      "actorName",
      "actorEmail",
      "action",
      "entity",
      "entityId",
      "ip",
      "userAgent",
      "requestId",
    ]);
    expect(captured.rows[0]).toMatchObject({ actorName: "Root Admin", actorEmail: "root@example.test" });
    expect(captured.rows[0]).toMatchObject({ action: "Created a villa", entity: "Villa" });
    expect(captured.rows[1]).toMatchObject({ actorName: "System", actorEmail: "" });
    expect(JSON.stringify(captured)).not.toMatch(/before|after/);
  });

  describe("contractor summary", () => {
    it("has the header and the villa count, which covers every villa", async () => {
      const s = setup({ total: 4 });

      const file = await s.service.contractorSummaryExport(
        CONTRACTOR,
        parse(contractorSummaryQuerySchema, { sort: "villaNumber:desc" }),
        actor,
        ctx,
      );
      await file.write(new PassThrough());

      expect(s.xlsx.seen[0]?.document.summary).toEqual([
        ["Contractor", "Nile Builders"],
        ["Phone", "0102 000 0001"],
        ["Total villas", "40"],
      ]);
      expect(s.xlsx.seen[0]?.document.filters).toEqual(["Sort: villaNumber desc"]);
      expect(s.xlsx.seen[0]?.rows).toHaveLength(4);
    });

    it("has the same header lines whatever the query", async () => {
      const { captured } = await documentOf(runners[3]![1]);

      expect(captured.document.summary?.map(([label]) => label)).toEqual([
        "Contractor",
        "Phone",
        "Total villas",
      ]);
    });

    it("the villa rows have the villa number, place and dates, and no status or assignment time", async () => {
      const { captured } = await documentOf(runners[3]![1]);

      expect(captured.document.columns.map((c) => c.title)).toEqual([
        "Villa Number",
        "Area",
        "Block",
        "Plot",
        "Start Date",
        "Target Date",
      ]);
      expect(captured.rows[0]).toEqual({
        villaNumber: "P-001",
        area: "New Cairo",
        block: "B1",
        plot: "007",
        startDate: null,
        targetDate: new Date("2026-02-01T00:00:00.000Z"),
      });
    });

    it("the row count is the listed villas", async () => {
      await runners[3]![1](setup({ total: 4 }));

      expect(vi.mocked(audit.record).mock.calls[0]?.[1]).toMatchObject({ after: { rowCount: 4 } });
    });
  });

  it("describes the applied filters, one line each, for the report", async () => {
    const s = setup();

    const file = await s.service.villasExport(
      parse(listVillasQuerySchema, {
        area: "New Cairo",
        block: "B1",
        startFrom: "2026-01-01",
        startTo: "2026-01-31",
        search: "nile",
        sort: "villaNumber:desc",
      }),
      actor,
      ctx,
    );
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.document.filters).toEqual([
      "Area: New Cairo",
      "Block: B1",
      "Start from: 2026-01-01",
      "Start to: 2026-01-31",
      "Search: nile",
      "Sort: villaNumber desc",
    ]);
  });

  it("describes the MEW follow-up filter in words, before the search and the sort", async () => {
    for (const [value, words] of [
      ["true", "Yes"],
      ["false", "No"],
    ] as const) {
      const s = setup();

      const file = await s.service.villasExport(
        parse(listVillasQuerySchema, { mewFollowUp: value, search: "nile", sort: "villaNumber" }),
        actor,
        ctx,
      );
      await file.write(new PassThrough());

      expect(s.xlsx.seen[0]?.document.filters).toEqual([
        `MEW follow up: ${words}`,
        "Search: nile",
        "Sort: villaNumber",
      ]);
    }
  });

  it("describes a party status filter in words, next to the search", async () => {
    const s = setup();

    const file = await s.service.contractorsExport(
      parse(listContractorsQuerySchema, { status: "INACTIVE", search: "nile" }),
      actor,
      ctx,
    );
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.document.filters).toEqual(["Status: Inactive", "Search: nile"]);
  });

  it("passes a party status filter on to the list, whatever the export format", async () => {
    const s = setup();

    await (
      await s.service.civilEngineersExport(
        parse(listCivilEngineersQuerySchema, { status: "ACTIVE" }),
        actor,
        ctx,
      )
    ).write(new PassThrough());
    await (
      await s.service.electricalEngineersExport(
        parse(listElectricalEngineersQuerySchema, { status: "INACTIVE", search: "a@b.test" }),
        actor,
        ctx,
      )
    ).write(new PassThrough());

    expect(s.civilEngineers.list.mock.calls[0]?.[0]).toMatchObject({ status: "ACTIVE" });
    expect(s.electricalEngineers.list.mock.calls[0]?.[0]).toMatchObject({
      status: "INACTIVE",
      search: "a@b.test",
    });
  });

  it("passes the search and the sort on to the areas list, and describes them in the file", async () => {
    const { s, captured } = await documentOf((svc, format = "xlsx", context = ctx) =>
      svc.service.areasExport(
        parse(listAreasQuerySchema, { search: "cairo", sort: "villaCount:desc" }, format),
        actor,
        context,
      ),
    );

    expect(s.areas.list.mock.calls[0]?.[0]).toMatchObject({ search: "cairo", sort: "villaCount:desc" });
    expect(captured.document.filters).toEqual(["Search: cairo", "Sort: villaCount desc"]);
  });

  it("no filters means an empty list of filter lines", async () => {
    const { captured } = await documentOf(runners[0]![1]);

    expect(captured.document.filters).toEqual([]);
  });
});

describe("site reports", () => {
  it("reads the site reports from the service it was given, one row each, with the rating as a number", async () => {
    const xlsx = recordingWriter();
    const siteReports = {
      list: paged(2, (n) => ({
        id: `s${n}`,
        villa: { id: "p1", villaNumber: "P-001", location: "New Cairo, B1, 007" },
        visitDate: "2026-03-04",
        title: `Visit ${n}`,
        inspector: "Eng. Hamdy",
        type: "SAFETY",
        rating: n + 2,
        findings: "Fine",
        recommendations: null,
        createdBy: null,
        version: 1,
        createdAt: "2026-03-04T05:06:07.890Z",
        updatedAt: "2026-03-04T05:06:07.890Z",
      })),
    };
    const service = new ExportsService({
      siteReports: siteReports as never,
      writers: { xlsx: xlsx.write, pdf: xlsx.write },
      now: () => NOW,
    });

    const file = await service.siteReportsExport(
      parse(listSiteReportsQuerySchema, { rating: "3" }),
      actor,
      ctx,
    );
    await file.write(new PassThrough());

    expect(siteReports.list).toHaveBeenCalledTimes(1);
    expect(
      xlsx.seen[0]?.rows.map((row) => [row["Title"], row["Type"], row["Rating"], row["Recommendations"]]),
    ).toEqual([
      ["Visit 1", "Safety", 3, null],
      ["Visit 2", "Safety", 4, null],
    ]);
  });
});

// What a cell of the workbook holds when the row has more than one way to be written: the words (not the stored codes), the
// reference book told which kind of record it is writing, and the villa's location. The import reads these cells back.
describe("the workbook cells", () => {
  const LOCATION = "New Cairo, B1, 007";
  const villaRef = { id: "p1", villaNumber: "P-001", location: LOCATION };
  const created = "2026-03-04T05:06:07.890Z";
  const base = {
    id: "i1",
    villa: villaRef,
    createdBy: null,
    version: 1,
    createdAt: created,
    updatedAt: created,
  };

  const openWork = {
    ...base,
    elecPhase: { id: "ep1", name: "First fix" },
    status: "IN_PROGRESS",
    priority: "HIGH",
    progress: 40,
    contractor: null,
    startDate: null,
    endDate: null,
    overdue: false,
  };
  const dailyReport = {
    ...base,
    reportDate: "2026-03-01",
    weather: "SUNNY",
    workersCount: 10,
    notes: "Poured the slab",
    preparedBy: { id: "x1", name: "Hamdy" },
    contractor: { id: "c1", name: "Nile Builders" },
  };
  const smallWork = {
    ...base,
    contractor: { id: "c1", name: "Nile Builders" },
    startDate: "2026-03-01",
    endDate: "2026-03-03",
    deadlineAt: "2026-03-03T21:00:00.000Z",
    overdue: true,
    dueSoon: false,
    description: "Replaced a socket",
    status: "PENDING",
  };
  const siteReport = {
    ...base,
    visitDate: "2026-03-04",
    title: "Visit",
    inspector: "Eng. Hamdy",
    type: "SAFETY",
    rating: 3,
    findings: "Fine",
    recommendations: null,
  };
  const dailyLabour = {
    ...base,
    labourDate: "2026-03-01",
    contractor: { id: "c1", name: "Nile Builders" },
    labourCount: 5,
    notes: null,
  };

  const oneRow = <Item>(item: Item) => ({
    list: vi.fn(async () => ({
      items: [item],
      meta: { page: 1, limit: 1000, total: 1, totalPages: 1 },
    })),
  });

  // Each of the four exports about a villa's records writes the villa's location, not its number, in the Location cell.
  it.each([
    [
      "open works",
      (service: ExportsService) => service.openWorksExport(parse(listOpenWorksQuerySchema), actor, ctx),
      { openWorks: oneRow(openWork) },
    ],
    [
      "small works",
      (service: ExportsService) => service.smallWorksExport(parse(listSmallWorksQuerySchema), actor, ctx),
      { smallWorks: oneRow(smallWork) },
    ],
    [
      "site reports",
      (service: ExportsService) => service.siteReportsExport(parse(listSiteReportsQuerySchema), actor, ctx),
      { siteReports: oneRow(siteReport) },
    ],
    [
      "daily labour",
      (service: ExportsService) => service.dailyLabourExport(parse(listDailyLabourQuerySchema), actor, ctx),
      { dailyLabour: oneRow(dailyLabour) },
    ],
  ])(
    "%s: the Location cell is the villa's location and the Villa Number cell its number",
    async (_name, run, lists) => {
      const xlsx = recordingWriter();
      const service = new ExportsService({
        ...lists,
        villas: { referenceBook: async () => names },
        writers: { xlsx: xlsx.write, pdf: xlsx.write },
        now: () => NOW,
      } as never);

      const file = await run(service);
      await file.write(new PassThrough());

      expect(xlsx.seen[0]?.rows[0]).toMatchObject({ Location: LOCATION, "Villa Number": "P-001" });
    },
  );

  it("daily reports: no villa, the contractor and the electrical engineer written as the import reads them", async () => {
    const xlsx = recordingWriter();
    const service = new ExportsService({
      dailyReports: oneRow(dailyReport),
      villas: { referenceBook: async () => names },
      writers: { xlsx: xlsx.write, pdf: xlsx.write },
      now: () => NOW,
    } as never);

    const file = await service.dailyReportsExport(parse(listDailyReportsQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    const row = xlsx.seen[0]?.rows[0];
    expect(row).toMatchObject({
      Contractor: "Nile Builders",
      "Electrical Engineer": "Hamdy",
      Weather: "Sunny",
      Workers: 10,
      Notes: "Poured the slab",
    });
    expect(Object.keys(row!)).toEqual([
      "Report Date",
      "Contractor",
      "Electrical Engineer",
      "Weather",
      "Workers",
      "Notes",
    ]);
  });

  it("open works: the status, the priority and the electrical phase are the words of the import, not the stored codes", async () => {
    const xlsx = recordingWriter();
    const service = new ExportsService({
      openWorks: oneRow(openWork),
      writers: { xlsx: xlsx.write, pdf: xlsx.write },
      now: () => NOW,
    } as never);

    const file = await service.openWorksExport(parse(listOpenWorksQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    expect(xlsx.seen[0]?.rows[0]).toMatchObject({
      "Electrical Phase": "First fix",
      Status: "In progress",
      Priority: "High",
    });
  });

  it("villas: each record is written by the reference book of its own kind", async () => {
    const s = setup({ total: 1 });
    s.villas.referenceBook.mockResolvedValue({
      area: ({ name }: { name: string }) => `area:${name}`,
      party: (kind: string, { name }: { name: string }) => `${kind}:${name}`,
    } as never);

    const file = await s.service.villasExport(parse(listVillasQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows[0]).toMatchObject({
      Area: "area:New Cairo",
      Contractor: "contractor:Nile Builders",
      "Electrical Engineer": "electricalEngineer:Hany Wagdy",
      "Civil Engineer": "civilEngineer:Mona Hassan",
    });
  });

  it("villas: the reference book is read for a workbook and not for a PDF, which writes the names", async () => {
    const sheet = setup({ total: 1 });
    const pdf = setup({ total: 1 });

    await (
      await sheet.service.villasExport(parse(listVillasQuerySchema), actor, ctx)
    ).write(new PassThrough());
    await (
      await pdf.service.villasExport(parse(listVillasQuerySchema, {}, "pdf"), actor, ctx)
    ).write(new PassThrough());

    expect(sheet.villas.referenceBook).toHaveBeenCalledTimes(1);
    expect(pdf.villas.referenceBook).not.toHaveBeenCalled();
  });

  it("villas: a villa with no budget has an empty Currency cell, whatever currency it carries", async () => {
    const s = setup({ total: 1 });
    s.villas.list.mockResolvedValue({
      items: [
        villa(1, { budgetMinor: null, currency: "USD" }),
        villa(2, { budgetMinor: 0, currency: "USD" }),
      ],
      meta: { page: 1, limit: 1000, total: 2, totalPages: 1 },
    });

    const file = await s.service.villasExport(parse(listVillasQuerySchema), actor, ctx);
    await file.write(new PassThrough());

    expect(s.xlsx.seen[0]?.rows.map((row) => [row["Budget"], row["Currency"]])).toEqual([
      [null, null],
      [0, "USD"],
    ]);
  });
});
