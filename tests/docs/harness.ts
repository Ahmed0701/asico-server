import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { vi } from "vitest";
import { emptyTemplates } from "../helpers/template-services.js";
import type { Actor, RequestContext } from "../../src/core/middleware/requestContext.js";
import { listAreasQuerySchema } from "../../src/modules/areas/index.js";
import { listAuditLogsQuerySchema } from "../../src/modules/audit/index.js";
import { listCivilEngineersQuerySchema } from "../../src/modules/civil-engineers/index.js";
import {
  contractorSummaryQuerySchema,
  listContractorsQuerySchema,
} from "../../src/modules/contractors/index.js";
import { listDailyLabourQuerySchema } from "../../src/modules/daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../src/modules/daily-reports/index.js";
import { listElectricalEngineersQuerySchema } from "../../src/modules/electrical-engineers/index.js";
import { ExportsService } from "../../src/modules/exports/service/exports.service.js";
import { exportQuery, type ParsedExport } from "../../src/modules/exports/validators/exports.validators.js";
import { listOpenWorksQuerySchema } from "../../src/modules/open-works/index.js";
import { listSiteReportsQuerySchema } from "../../src/modules/site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../src/modules/small-works/index.js";
import { listVillasQuerySchema } from "../../src/modules/villas/index.js";

// The twelve exports and the seven import templates, produced by the real code over empty data, so a test can read the header each
// one writes. The caller mocks the audit and the database (see the tests that use this).

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req" };
const actor: Actor = { id: "user-1", role: "ADMIN" };
const NOW = new Date("2026-10-12T13:55:00.000Z");
const CONTRACTOR = "11111111-1111-4111-8111-111111111111";

// The reference book of a fake villas service: every area and party is written as its name.
const names = {
  area: ({ name }: { name: string }) => name,
  party: (_kind: string, { name }: { name: string }) => name,
};

const empty = () => ({ list: vi.fn(async () => ({ items: [], meta: { total: 0 } })) });

function service(): ExportsService {
  return new ExportsService({
    villas: { ...empty(), referenceBook: async () => names } as never,
    contractors: {
      ...empty(),
      summary: vi.fn(async () => ({
        summary: {
          contractor: { id: CONTRACTOR, name: "Nile Builders", phone: "0100" },
          villaCount: 0,
          villas: [],
        },
        meta: { total: 0 },
      })),
    } as never,
    civilEngineers: empty() as never,
    electricalEngineers: empty() as never,
    areas: empty() as never,
    auditLogs: empty() as never,
    openWorks: empty() as never,
    dailyReports: empty() as never,
    smallWorks: empty() as never,
    siteReports: empty() as never,
    dailyLabour: empty() as never,
    now: () => NOW,
  });
}

const parse = <Schema extends Parameters<typeof exportQuery>[0]>(schema: Schema) =>
  ({ format: "xlsx", query: schema.parse({ page: "1", limit: "1000" }) }) as ParsedExport<never>;

type Run = (s: ExportsService) => ReturnType<ExportsService["villasExport"]>;

// The route of each export, the file it is called, how many lines of summary come before its header, and how to run it.
export const EXPORTS: { route: string; summaryLines: number; run: Run }[] = [
  {
    route: "/villas/export",
    summaryLines: 0,
    run: (s) => s.villasExport(parse(listVillasQuerySchema), actor, ctx),
  },
  {
    route: "/open-works/export",
    summaryLines: 0,
    run: (s) => s.openWorksExport(parse(listOpenWorksQuerySchema), actor, ctx),
  },
  {
    route: "/daily-reports/export",
    summaryLines: 0,
    run: (s) => s.dailyReportsExport(parse(listDailyReportsQuerySchema), actor, ctx),
  },
  {
    route: "/small-works/export",
    summaryLines: 0,
    run: (s) => s.smallWorksExport(parse(listSmallWorksQuerySchema), actor, ctx),
  },
  {
    route: "/site-reports/export",
    summaryLines: 0,
    run: (s) => s.siteReportsExport(parse(listSiteReportsQuerySchema), actor, ctx),
  },
  {
    route: "/daily-labour/export",
    summaryLines: 0,
    run: (s) => s.dailyLabourExport(parse(listDailyLabourQuerySchema), actor, ctx),
  },
  {
    route: "/contractors/export",
    summaryLines: 0,
    run: (s) => s.contractorsExport(parse(listContractorsQuerySchema), actor, ctx),
  },
  {
    route: "/civil-engineers/export",
    summaryLines: 0,
    run: (s) => s.civilEngineersExport(parse(listCivilEngineersQuerySchema), actor, ctx),
  },
  {
    route: "/electrical-engineers/export",
    summaryLines: 0,
    run: (s) => s.electricalEngineersExport(parse(listElectricalEngineersQuerySchema), actor, ctx),
  },
  {
    route: "/areas/export",
    summaryLines: 0,
    run: (s) => s.areasExport(parse(listAreasQuerySchema), actor, ctx),
  },
  {
    route: "/contractors/:id/summary/export",
    summaryLines: 3,
    run: (s) => s.contractorSummaryExport(CONTRACTOR, parse(contractorSummaryQuerySchema), actor, ctx),
  },
  {
    route: "/audit-logs/export",
    summaryLines: 0,
    run: (s) => s.auditLogsExport(parse(listAuditLogsQuerySchema), actor, ctx),
  },
];

export type ExportFile = { route: string; fileStem: string; sheet: string; headers: string[] };

async function bytesOf(file: { write: (out: PassThrough) => Promise<unknown> }): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => out.on("end", resolve));
  await file.write(out);
  out.end();
  await done;
  return Buffer.concat(chunks);
}

export async function exportFiles(): Promise<ExportFile[]> {
  const found: ExportFile[] = [];
  for (const entry of EXPORTS) {
    const file = await entry.run(service());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await bytesOf(file)) as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const headerRow = entry.summaryLines === 0 ? 1 : entry.summaryLines + 2;
    const headers = (sheet.getRow(headerRow).values as ExcelJS.CellValue[]).slice(1).map(String);
    found.push({
      route: entry.route,
      fileStem: /^asico-(.*)-\d{4}-\d{2}-\d{2}\.xlsx$/.exec(file.filename)?.[1] ?? file.filename,
      sheet: sheet.name,
      headers,
    });
  }
  return found;
}

export type TemplateColumn = { header: string; required: boolean };
export type Template = { name: string; sheet: string; columns: TemplateColumn[]; example: string[] };

const TEMPLATES = Object.entries(emptyTemplates);

// The header row of the data sheet, and the column table of the Instructions sheet (which says which are required).
export async function templates(): Promise<Template[]> {
  const found: Template[] = [];
  for (const [name, make] of TEMPLATES) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await make()).bytes as unknown as ArrayBuffer);
    const data = workbook.worksheets[0]!;
    const instructions = workbook.getWorksheet("Instructions")!;
    const headers = (data.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String);
    const example = (data.getRow(2).values as ExcelJS.CellValue[]).slice(1).map(String);
    let start = 0;
    instructions.eachRow((row, number) => {
      if (row.getCell(1).text === "Column" && row.getCell(2).text === "Required") start = number;
    });
    const columns: TemplateColumn[] = [];
    for (let number = start + 1; number <= instructions.rowCount; number++) {
      const row = instructions.getRow(number);
      if (row.getCell(1).text === "") continue;
      columns.push({ header: row.getCell(1).text, required: row.getCell(2).text === "Yes" });
    }
    found.push({ name, sheet: data.name, columns, example });
    expectHeaders(headers, columns);
  }
  return found;
}

function expectHeaders(headers: string[], columns: TemplateColumn[]): void {
  if (JSON.stringify(headers) !== JSON.stringify(columns.map((column) => column.header))) {
    throw new Error(
      `the data sheet and the instructions disagree: ${headers.join(",")} / ${columns.map((c) => c.header).join(",")}`,
    );
  }
}
