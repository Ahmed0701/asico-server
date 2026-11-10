import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportDefinition } from "../../../src/core/imports/runner.js";
import { ImportRunner } from "../../../src/core/imports/runner.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import {
  CONTRACTOR_IGNORED_COLUMNS,
  CONTRACTOR_IMPORT_COLUMNS,
  listContractorsQuerySchema,
} from "../../../src/modules/contractors/index.js";
import {
  DAILY_LABOUR_IGNORED_COLUMNS,
  DAILY_LABOUR_IMPORT_COLUMNS,
  listDailyLabourQuerySchema,
} from "../../../src/modules/daily-labour/index.js";
import {
  DAILY_REPORT_IGNORED_COLUMNS,
  DAILY_REPORT_IMPORT_COLUMNS,
  listDailyReportsQuerySchema,
} from "../../../src/modules/daily-reports/index.js";
import { ExportsService } from "../../../src/modules/exports/service/exports.service.js";
import type { ParsedExport } from "../../../src/modules/exports/validators/exports.validators.js";
import {
  listOpenWorksQuerySchema,
  OPEN_WORK_IGNORED_COLUMNS,
  OPEN_WORK_IMPORT_COLUMNS,
} from "../../../src/modules/open-works/index.js";
import {
  listSiteReportsQuerySchema,
  SITE_REPORT_IGNORED_COLUMNS,
  SITE_REPORT_IMPORT_COLUMNS,
} from "../../../src/modules/site-reports/index.js";
import {
  listSmallWorksQuerySchema,
  SMALL_WORK_IGNORED_COLUMNS,
  SMALL_WORK_IMPORT_COLUMNS,
} from "../../../src/modules/small-works/index.js";
import {
  listVillasQuerySchema,
  VILLA_IGNORED_COLUMNS,
  VILLA_IMPORT_COLUMNS,
} from "../../../src/modules/villas/index.js";
import { contractorImportDefinition } from "../../../src/modules/contractors/service/contractors-import.service.js";
import { dailyLabourImportDefinition } from "../../../src/modules/daily-labour/service/daily-labour-import.service.js";
import { dailyReportsImportDefinition } from "../../../src/modules/daily-reports/service/daily-reports-import.service.js";
import { openWorksImportDefinition } from "../../../src/modules/open-works/service/open-works-import.service.js";
import { siteReportsImportDefinition } from "../../../src/modules/site-reports/service/site-reports-import.service.js";
import { smallWorksImportDefinition } from "../../../src/modules/small-works/service/small-works-import.service.js";
import { villaImportDefinition } from "../../../src/modules/villas/service/villas-import.service.js";
import type { IgnoredColumn, ImportColumn } from "../../../src/shared/import/index.js";

// The header of the export and the header of the template are one list: the columns the import takes, in the order of
// the import, and then (in the export only) the columns the import reads past. A column added, renamed or moved in one
// place and not the other fails here, for each of the seven resources.
vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn(async () => undefined), recordMany: vi.fn(async () => undefined) },
}));
vi.mock("../../../src/core/database/prisma.js", () => ({
  prisma: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
}));

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const actor: Actor = { id: "user-1", role: "ADMIN" };

const parse = (schema: { parse: (input: unknown) => unknown }) =>
  ({ format: "xlsx", query: schema.parse({ page: "1", limit: "1000" }) }) as ParsedExport<never>;
const empty = () => ({ list: vi.fn(async () => ({ items: [], meta: { total: 0 } })) });

async function headerOf(bytes: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const row = workbook.worksheets[0]!.getRow(1);
  const header: string[] = [];
  row.eachCell({ includeEmpty: false }, (cell) => header.push(String(cell.value)));
  return header;
}

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

const exporter = new ExportsService({
  villas: {
    ...empty(),
    referenceBook: vi.fn(async () => ({
      areas: [],
      civilEngineers: [],
      electricalEngineers: [],
      contractors: [],
    })),
  } as never,
  contractors: empty() as never,
  openWorks: empty() as never,
  dailyReports: empty() as never,
  smallWorks: empty() as never,
  siteReports: empty() as never,
  dailyLabour: empty() as never,
  now: () => new Date("2026-10-12T13:55:00.000Z"),
});

type Case = {
  name: string;
  columns: readonly ImportColumn[];
  ignored: readonly IgnoredColumn[];
  // Columns older exports had: the import still accepts them (and does not read them), the export no longer has them.
  retired?: readonly string[];
  exported: () => Promise<{ write: (out: PassThrough) => Promise<unknown> }>;
  definition: () => ImportDefinition<never, never, boolean>;
};

const repo = {} as never;
const cases: Case[] = [
  {
    name: "villas",
    columns: VILLA_IMPORT_COLUMNS,
    ignored: VILLA_IGNORED_COLUMNS,
    retired: ["Ready", "Ready Date"],
    exported: () => exporter.villasExport(parse(listVillasQuerySchema) as never, actor, ctx),
    definition: () => villaImportDefinition(repo, actor, ctx) as never,
  },
  {
    name: "contractors",
    columns: CONTRACTOR_IMPORT_COLUMNS,
    ignored: CONTRACTOR_IGNORED_COLUMNS,
    exported: async () => exporter.contractorsExport(parse(listContractorsQuerySchema) as never, actor, ctx),
    definition: () => contractorImportDefinition(repo) as never,
  },
  {
    name: "open works",
    columns: OPEN_WORK_IMPORT_COLUMNS,
    ignored: OPEN_WORK_IGNORED_COLUMNS,
    exported: async () => exporter.openWorksExport(parse(listOpenWorksQuerySchema) as never, actor, ctx),
    definition: () => openWorksImportDefinition(repo, actor, ctx) as never,
  },
  {
    name: "daily reports",
    columns: DAILY_REPORT_IMPORT_COLUMNS,
    ignored: DAILY_REPORT_IGNORED_COLUMNS,
    exported: async () =>
      exporter.dailyReportsExport(parse(listDailyReportsQuerySchema) as never, actor, ctx),
    definition: () => dailyReportsImportDefinition(repo, actor, ctx, () => new Date()) as never,
  },
  {
    name: "small works",
    columns: SMALL_WORK_IMPORT_COLUMNS,
    ignored: SMALL_WORK_IGNORED_COLUMNS,
    exported: async () => exporter.smallWorksExport(parse(listSmallWorksQuerySchema) as never, actor, ctx),
    definition: () => smallWorksImportDefinition(repo, actor, ctx, () => new Date()) as never,
  },
  {
    name: "site reports",
    columns: SITE_REPORT_IMPORT_COLUMNS,
    ignored: SITE_REPORT_IGNORED_COLUMNS,
    exported: async () => exporter.siteReportsExport(parse(listSiteReportsQuerySchema) as never, actor, ctx),
    definition: () => siteReportsImportDefinition(repo, actor, ctx, () => new Date()) as never,
  },
  {
    name: "daily labour",
    columns: DAILY_LABOUR_IMPORT_COLUMNS,
    ignored: DAILY_LABOUR_IGNORED_COLUMNS,
    exported: async () => exporter.dailyLabourExport(parse(listDailyLabourQuerySchema) as never, actor, ctx),
    definition: () => dailyLabourImportDefinition(repo, actor, ctx, () => new Date()) as never,
  },
];

beforeEach(() => vi.clearAllMocks());

describe.each(cases)("$name: one list of columns for the export, the template and the import", (c) => {
  const importable = c.columns.map((column) => column.header);
  const informational = c.ignored.map((column) => column.header);

  it("has the importable columns first in the export, then the informational ones, and nothing else", async () => {
    const header = await headerOf(await bytesOf(await c.exported()));

    expect(header).toEqual([...importable, ...informational]);
  });

  it("has only the importable columns in the template, in the same order", async () => {
    const template = await new ImportRunner().template(c.definition());

    expect(await headerOf(template.bytes)).toEqual(importable);
  });

  it("keeps that header, and the order of the columns, when every column has a dropdown", async () => {
    const lists = Object.fromEntries(importable.map((header) => [header, ["A, B", "C"]]));

    const template = await new ImportRunner().template(c.definition(), lists);

    expect(await headerOf(template.bytes)).toEqual(importable);
  });

  it("gives the definition the same two lists as the module exports (and the retired columns)", () => {
    const definition = c.definition();

    expect(definition.columns.map((column) => column.header)).toEqual(importable);
    expect((definition.ignoredColumns ?? []).map((column) => column.header)).toEqual([
      ...informational,
      ...(c.retired ?? []),
    ]);
  });

  it("has no header twice, and no informational column that is also importable", () => {
    const all = [...importable, ...informational];

    expect(new Set(all).size).toBe(all.length);
  });

  it("has an optional header only at the end of the importable columns", () => {
    const flags = c.columns.map((column) => column.optionalHeader === true);
    const firstOptional = flags.indexOf(true);

    if (firstOptional >= 0) {
      expect(flags.slice(firstOptional).every(Boolean)).toBe(true);
    }
    expect(
      c.columns.filter((column) => column.optionalHeader === true).map((column) => column.required),
    ).not.toContain(true);
  });
});

describe("what differs between the resources", () => {
  it("only villas have a column that may be left out of the file: Currency, the last importable one", () => {
    const optional = Object.fromEntries(
      cases.map((c) => [
        c.name,
        c.columns.filter((column) => column.optionalHeader === true).map((column) => column.header),
      ]),
    );

    expect(optional).toEqual({
      villas: ["Currency"],
      contractors: [],
      "open works": [],
      "daily reports": [],
      "small works": [],
      "site reports": [],
      "daily labour": [],
    });
    expect(VILLA_IMPORT_COLUMNS.at(-1)?.header).toBe("Currency");
  });

  it("lists the informational columns the export has today, after the importable ones", () => {
    expect(Object.fromEntries(cases.map((c) => [c.name, c.ignored.map((column) => column.header)]))).toEqual({
      villas: ["Progress", "Created (UTC)"],
      contractors: ["Villas", "Created (UTC)"],
      "open works": ["Location", "Overdue"],
      "daily reports": [],
      "small works": ["Location"],
      "site reports": ["Location"],
      "daily labour": ["Location"],
    });
  });
});
