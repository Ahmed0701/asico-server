import { emptyTemplates } from "../../helpers/template-services.js";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext, Actor } from "../../../src/core/middleware/requestContext.js";
import { listAreasQuerySchema } from "../../../src/modules/areas/index.js";
import { listAuditLogsQuerySchema } from "../../../src/modules/audit/index.js";
import { listCivilEngineersQuerySchema } from "../../../src/modules/civil-engineers/index.js";
import {
  contractorSummaryQuerySchema,
  listContractorsQuerySchema,
} from "../../../src/modules/contractors/index.js";
import { listDailyLabourQuerySchema } from "../../../src/modules/daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../../src/modules/daily-reports/index.js";
import { listElectricalEngineersQuerySchema } from "../../../src/modules/electrical-engineers/index.js";
import { ExportsService } from "../../../src/modules/exports/service/exports.service.js";
import {
  exportQuery,
  type ParsedExport,
} from "../../../src/modules/exports/validators/exports.validators.js";
import { listOpenWorksQuerySchema } from "../../../src/modules/open-works/index.js";
import { listSiteReportsQuerySchema } from "../../../src/modules/site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../../src/modules/small-works/index.js";
import { listVillasQuerySchema } from "../../../src/modules/villas/index.js";
import { formatDate, formatDateTime, formatDecimal } from "../../../src/shared/export/format.js";
import {
  columnWidth,
  displayWidth,
  MAX_COLUMN_CHARACTERS,
  widestLine,
} from "../../../src/shared/export/layout.js";
import { EXPORT_NAMES, FILTER_LABELS } from "../../../src/shared/export/labels.js";
import { readPdf } from "../../shared/export/helpers.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
vi.mock("../../../src/core/database/prisma.js", () => ({
  prisma: { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
}));

// All twelve exports, written by the real spreadsheet and PDF writers from the real export service, over fake list services
// (so the rows are the ones below), and read back. What is checked is what every file must have in common, whatever it is
// about: the same header, the same widths, the same cell formats, the same words, English, and no formula a spreadsheet would run.

const ctx: RequestContext = { locale: "ar", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const actor: Actor = { id: "user-1", role: "ADMIN" };
const NOW = new Date("2026-10-12T13:55:00.000Z");
const CONTRACTOR = "11111111-1111-4111-8111-111111111111";

const HOSTILE = '=HYPERLINK("http://evil.test","click")';
const LONG =
  "A long line of text that has to wrap within its column and never make it wider than the most allowed. ".repeat(
    3,
  );
const MULTILINE = "first line\nsecond line is a little longer\nthird";
const ARABIC = "شركة النيل للمقاولات";

// The reference book of a fake villas service: every area and party is written as its name.
const names = {
  area: ({ name }: { name: string }) => name,
  party: (_kind: string, { name }: { name: string }) => name,
};

const person = { id: "x1", name: "Mona Hassan" };
const villaRef = { id: "p1", villaNumber: "007", location: "New Cairo, B1, 007" };
const created = "2026-03-04T05:06:07.890Z";

// Four rows each: a plain one, one with a formula in every free text, one with long and multi-line text, one with Arabic text
// and every optional value empty.
const rowsOf = <Item>(make: (n: 1 | 2 | 3 | 4) => Item): Item[] => ([1, 2, 3, 4] as const).map(make);
const text = (n: number, plain: string): string =>
  n === 1 ? plain : n === 2 ? HOSTILE : n === 3 ? `${LONG}\n${MULTILINE}` : ARABIC;

function lists() {
  const page = <Item>(items: Item[]) => vi.fn(async () => ({ items, meta: { total: items.length } }));
  return {
    villas: {
      referenceBook: vi.fn(async () => names),
      list: page(
        rowsOf((n) => ({
          id: `v${n}`,
          villaNumber: n === 2 ? HOSTILE : `P-00${n}`,
          ownerName: n === 4 ? null : text(n, "Khaled Mansour"),
          area: text(n, "New Cairo"),
          areaId: "a1",
          block: "B1",
          plot: "007",
          civilEngineer: person,
          electricalEngineer: n === 4 ? null : person,
          contractor: n === 4 ? null : { id: "c1", name: text(n, "Nile Builders") },
          startDate: n === 4 ? null : "2026-01-05",
          targetDate: "2026-12-31",
          budgetMinor: n === 4 ? null : 125050,
          currency: n === 4 ? null : "KWD",
          progress: 62.5,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    contractors: {
      list: page(
        rowsOf((n) => ({
          id: `c${n}`,
          name: text(n, "Nile Builders"),
          phone: n === 4 ? "0100 123 4567" : "0100 123 4567",
          email: n === 4 ? null : "nile@example.test",
          status: n === 3 ? "INACTIVE" : "ACTIVE",
          villaCount: n,
          createdAt: created,
          updatedAt: created,
        })),
      ),
      summary: vi.fn(async () => ({
        summary: {
          contractor: { id: CONTRACTOR, name: HOSTILE, phone: "0102 000 0001" },
          villaCount: 4,
          villas: rowsOf((n) => ({
            id: `s${n}`,
            villaNumber: `P-00${n}`,
            area: text(n, "New Cairo"),
            block: "B1",
            plot: "007",
            startDate: n === 4 ? null : "2026-01-05",
            targetDate: "2026-12-31",
          })),
        },
        meta: { total: 4 },
      })),
    },
    civilEngineers: {
      list: page(
        rowsOf((n) => ({
          id: `e${n}`,
          name: text(n, "Eng. Mona"),
          phone: "0101 765 4321",
          email: n === 4 ? null : "mona@example.test",
          status: "ACTIVE",
          villaCount: n,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    electricalEngineers: {
      list: page(
        rowsOf((n) => ({
          id: `x${n}`,
          name: text(n, "Eng. Hany"),
          phone: "0101 765 4321",
          email: n === 4 ? null : "hany@example.test",
          status: "INACTIVE",
          villaCount: n,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    areas: {
      list: page(
        rowsOf((n) => ({
          id: `a${n}`,
          name: text(n, "New Cairo"),
          city: "Cairo",
          villaCount: n,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    auditLogs: {
      list: page(
        rowsOf((n) => ({
          id: `l${n}`,
          actor: n === 4 ? null : { id: "u1", name: text(n, "Root Admin"), email: "root@example.test" },
          action: n === 3 ? "widget.explode" : "villa.create",
          actionLabel: "إنشاء فيلا",
          entity: "مشروع",
          entityCode: n === 3 ? "Widget" : n === 2 ? "DailyReport" : "Villa",
          entityId: n === 4 ? null : `p${n}`,
          entityName: "ignored",
          entityDetail: null,
          ip: n === 4 ? null : "203.0.113.5",
          userAgent: n === 2 ? HOSTILE : n === 3 ? LONG : null,
          requestId: n === 4 ? null : "req",
          createdAt: "2026-03-04T05:06:00.000Z",
        })),
      ),
    },
    openWorks: {
      list: page(
        rowsOf((n) => ({
          id: `w${n}`,
          villa: villaRef,
          elecPhase: { id: "ep", name: text(n, "First fix") },
          status: n === 3 ? "DONE" : "IN_PROGRESS",
          priority: "HIGH",
          progress: 40,
          contractor: n === 4 ? null : { id: "c1", name: "Nile Builders" },
          startDate: n === 4 ? null : "2026-01-05",
          endDate: "2026-02-01",
          source: n === 1 ? "PHASE" : "MANUAL",
          managed: false,
          overdue: n === 2,
          createdBy: null,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    dailyReports: {
      list: page(
        rowsOf((n) => ({
          id: `d${n}`,
          reportDate: `2026-03-0${n}`,
          weather: "SUNNY",
          workersCount: 10 * n,
          notes: n === 4 ? null : text(n, "Late delivery"),
          preparedBy: { id: "x1", name: text(n, "Eng. Hamdy") },
          contractor: { id: "c1", name: text(n, "Nile Builders") },
          createdBy: null,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    smallWorks: {
      list: page(
        rowsOf((n) => ({
          id: `m${n}`,
          villa: villaRef,
          contractor: { id: "c1", name: "Nile Builders" },
          startDate: `2026-03-0${n}`,
          endDate: `2026-03-0${n + 1}`,
          deadlineAt: `2026-03-0${n + 1}T21:00:00.000Z`,
          overdue: n !== 1,
          dueSoon: false,
          description: text(n, "Replaced a socket"),
          status: n === 1 ? "DONE" : "PENDING",
          createdBy: null,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    siteReports: {
      list: page(
        rowsOf((n) => ({
          id: `r${n}`,
          villa: villaRef,
          visitDate: `2026-03-0${n}`,
          title: text(n, "Weekly walk"),
          inspector: text(n, "Eng. Hamdy"),
          type: "SAFETY",
          rating: n,
          findings: text(n, "All fine"),
          recommendations: n === 4 ? null : text(n, "Keep it up"),
          createdBy: null,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
    dailyLabour: {
      list: page(
        rowsOf((n) => ({
          id: `b${n}`,
          villa: villaRef,
          labourDate: `2026-03-0${n}`,
          contractor: { id: "c1", name: text(n, "Nile Builders") },
          labourCount: 5 * n,
          notes: n === 4 ? null : text(n, "Two shifts"),
          createdBy: null,
          version: 1,
          createdAt: created,
          updatedAt: created,
        })),
      ),
    },
  };
}

const parse = <Schema extends Parameters<typeof exportQuery>[0]>(schema: Schema, format: "xlsx" | "pdf") =>
  ({ format, query: schema.parse({ page: "1", limit: "1000" }) }) as ParsedExport<never>;

type Format = "xlsx" | "pdf";
type Case = {
  name: string;
  stem: string;
  names: { title: string; sheet: string };
  summaryLines: number;
  run: (service: ExportsService, format: Format) => ReturnType<ExportsService["villasExport"]>;
};

const CASES: Case[] = [
  {
    name: "villas",
    stem: "villas",
    names: EXPORT_NAMES.villas,
    summaryLines: 0,
    run: (s, f) => s.villasExport(parse(listVillasQuerySchema, f), actor, ctx),
  },
  {
    name: "open works",
    stem: "open-works",
    names: EXPORT_NAMES.openWorks,
    summaryLines: 0,
    run: (s, f) => s.openWorksExport(parse(listOpenWorksQuerySchema, f), actor, ctx),
  },
  {
    name: "daily reports",
    stem: "daily-reports",
    names: EXPORT_NAMES.dailyReports,
    summaryLines: 0,
    run: (s, f) => s.dailyReportsExport(parse(listDailyReportsQuerySchema, f), actor, ctx),
  },
  {
    name: "small works",
    stem: "small-works",
    names: EXPORT_NAMES.smallWorks,
    summaryLines: 0,
    run: (s, f) => s.smallWorksExport(parse(listSmallWorksQuerySchema, f), actor, ctx),
  },
  {
    name: "site reports",
    stem: "site-reports",
    names: EXPORT_NAMES.siteReports,
    summaryLines: 0,
    run: (s, f) => s.siteReportsExport(parse(listSiteReportsQuerySchema, f), actor, ctx),
  },
  {
    name: "daily labour",
    stem: "daily-labour",
    names: EXPORT_NAMES.dailyLabour,
    summaryLines: 0,
    run: (s, f) => s.dailyLabourExport(parse(listDailyLabourQuerySchema, f), actor, ctx),
  },
  {
    name: "contractors",
    stem: "contractors",
    names: EXPORT_NAMES.contractors,
    summaryLines: 0,
    run: (s, f) => s.contractorsExport(parse(listContractorsQuerySchema, f), actor, ctx),
  },
  {
    name: "civil engineers",
    stem: "civil-engineers",
    names: EXPORT_NAMES.civilEngineers,
    summaryLines: 0,
    run: (s, f) => s.civilEngineersExport(parse(listCivilEngineersQuerySchema, f), actor, ctx),
  },
  {
    name: "electrical engineers",
    stem: "electrical-engineers",
    names: EXPORT_NAMES.electricalEngineers,
    summaryLines: 0,
    run: (s, f) => s.electricalEngineersExport(parse(listElectricalEngineersQuerySchema, f), actor, ctx),
  },
  {
    name: "areas",
    stem: "areas",
    names: EXPORT_NAMES.areas,
    summaryLines: 0,
    run: (s, f) => s.areasExport(parse(listAreasQuerySchema, f), actor, ctx),
  },
  {
    name: "contractor summary",
    stem: "contractor-summary",
    names: EXPORT_NAMES.contractorSummary,
    summaryLines: 3,
    run: (s, f) => s.contractorSummaryExport(CONTRACTOR, parse(contractorSummaryQuerySchema, f), actor, ctx),
  },
  {
    name: "audit log",
    stem: "audit-logs",
    names: EXPORT_NAMES.auditLogs,
    summaryLines: 0,
    run: (s, f) => s.auditLogsExport(parse(listAuditLogsQuerySchema, f), actor, ctx),
  },
];

function service() {
  const fake = lists();
  return new ExportsService({
    villas: fake.villas as never,
    contractors: fake.contractors as never,
    civilEngineers: fake.civilEngineers as never,
    electricalEngineers: fake.electricalEngineers as never,
    areas: fake.areas as never,
    auditLogs: fake.auditLogs as never,
    openWorks: fake.openWorks as never,
    dailyReports: fake.dailyReports as never,
    smallWorks: fake.smallWorks as never,
    siteReports: fake.siteReports as never,
    dailyLabour: fake.dailyLabour as never,
    now: () => NOW,
  });
}

async function bytesOf(file: { write: (out: PassThrough) => Promise<{ rows: number }> }): Promise<{
  bytes: Buffer;
  rows: number;
}> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => out.on("end", resolve));
  const { rows } = await file.write(out);
  out.end();
  await done;
  return { bytes: Buffer.concat(chunks), rows };
}

type Sheet = { workbook: ExcelJS.Workbook; sheet: ExcelJS.Worksheet; headerRow: number; titles: string[] };

async function load(bytes: Buffer, summaryLines: number): Promise<Sheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  const headerRow = summaryLines === 0 ? 1 : summaryLines + 2;
  const titles = (sheet.getRow(headerRow).values as ExcelJS.CellValue[]).slice(1).map(String);
  return { workbook, sheet, headerRow, titles };
}

// What a cell shows, as the writer measured it.
function shown(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return cell.numFmt?.includes("hh:mm") ? formatDateTime(value) : formatDate(value);
  }
  if (typeof value === "number") {
    return cell.numFmt === "#,##0.000" ? formatDecimal(value) : String(value);
  }
  return String(value);
}

const everyExport = async () => {
  const exported: Record<string, Sheet & { rows: number; bytes: Buffer }> = {};
  for (const c of CASES) {
    const file = await c.run(service(), "xlsx");
    const { bytes, rows } = await bytesOf(file);
    exported[c.name] = { ...(await load(bytes, c.summaryLines)), rows, bytes };
  }
  return exported;
};

let exported: Awaited<ReturnType<typeof everyExport>>;
beforeEach(async () => {
  exported ??= await everyExport();
});

describe.each(CASES)("$name: the file", (c) => {
  it("is named asico-<what>-<UTC day>.xlsx, with a spreadsheet's content type", async () => {
    const file = await c.run(service(), "xlsx");

    expect(file.filename).toBe(`asico-${c.stem}-2026-10-12.xlsx`);
    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("is one sheet, named as the export is called, within a spreadsheet's 31 characters", () => {
    const { workbook, sheet } = exported[c.name]!;

    expect(workbook.worksheets).toHaveLength(1);
    expect(sheet.name).toBe(c.names.title);
    expect(sheet.name).toBe(c.names.sheet);
    expect(sheet.name.length).toBeLessThanOrEqual(31);
    expect(sheet.name).not.toMatch(/[\\/?*[\]:]/);
  });

  it("is made by Asico, and writes every row of the list under its header", () => {
    const { workbook, rows, sheet, headerRow } = exported[c.name]!;

    expect(workbook.creator).toBe("Asico");
    expect(rows).toBe(4);
    expect(sheet.rowCount).toBe(headerRow + 4);
  });

  it("has one header row, in the same style as every other export, frozen with a filter over the table", () => {
    const { sheet, headerRow, titles } = exported[c.name]!;

    for (let column = 1; column <= titles.length; column++) {
      const cell = sheet.getRow(headerRow).getCell(column);
      expect(cell.font, `${cell.address} font`).toMatchObject({ bold: true, color: { argb: "FFFFFFFF" } });
      expect(cell.fill, `${cell.address} fill`).toMatchObject({
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F3A5F" },
      });
    }
    expect(sheet.getRow(headerRow).height).toBe(20);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: headerRow, xSplit: 0 });
    expect(sheet.autoFilter).toBe(`A${headerRow}:${sheet.getColumn(titles.length).letter}${headerRow + 4}`);
  });

  it("has headers that are written out: Title Case, no blanks, no repeats, English only", () => {
    const { titles } = exported[c.name]!;

    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) {
      expect(title, title).toMatch(/^[A-Z0-9][A-Za-z0-9]*(?: \(?[A-Z0-9][A-Za-z0-9]*\)?)*$/);
      expect(title, title).not.toMatch(/[؀-ۿ]/);
    }
  });

  it("says which date a date column is: none is called just Date", () => {
    const { sheet, headerRow, titles } = exported[c.name]!;

    titles.forEach((title, index) => {
      const format = sheet.getRow(headerRow + 1).getCell(index + 1).numFmt;
      if (format === "yyyy-mm-dd" || format?.startsWith("yyyy-mm-dd hh")) {
        expect(title, title).toMatch(/Date|\(UTC\)/);
        expect(title).not.toBe("Date");
      }
    });
    expect(titles).not.toContain("Date");
  });

  it("is as wide as the shared fit makes it: the longest value or the header, within 8 and 60", () => {
    const { sheet, headerRow, titles } = exported[c.name]!;

    titles.forEach((title, index) => {
      const column = sheet.getColumn(index + 1);
      let longest = 0;
      column.eachCell({ includeEmpty: false }, (cell, row) => {
        if (row !== headerRow) longest = Math.max(longest, widestLine(shown(cell)));
      });
      const expected = columnWidth(displayWidth(title), longest);

      expect(column.width, title).toBe(expected.width);
      expect(column.width!, title).toBeGreaterThanOrEqual(8);
      expect(column.width!, title).toBeLessThanOrEqual(MAX_COLUMN_CHARACTERS);
      if (expected.wraps) {
        const wrapped = column.values.some(
          (_, row) => row > headerRow && sheet.getRow(row).getCell(index + 1).alignment?.wrapText === true,
        );
        expect(wrapped, `${title} wraps`).toBe(true);
      }
    });
  });

  it("never has a cell a spreadsheet would run as a formula", () => {
    const { sheet } = exported[c.name]!;
    let protectedCells = 0;

    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value === "string") {
          expect(cell.value, cell.address).not.toMatch(/^[=+\-@\t\r]/);
          if (cell.value.startsWith("'=")) protectedCells++;
        }
        expect(typeof cell.value === "object" && cell.value !== null && !(cell.value instanceof Date)).toBe(
          false,
        );
      }),
    );
    // The formula was in the rows (it was not left out), and it was kept as plain text.
    expect(protectedCells).toBeGreaterThan(0);
  });

  it("keeps text as text and dates as real dates, in the format every export uses for them", () => {
    const { sheet, headerRow, titles } = exported[c.name]!;

    titles.forEach((title, index) => {
      for (let row = headerRow + 1; row <= headerRow + 4; row++) {
        const cell = sheet.getRow(row).getCell(index + 1);
        if (cell.value instanceof Date) {
          expect(cell.numFmt, `${title} ${cell.address}`).toMatch(/^yyyy-mm-dd( hh:mm "UTC")?$/);
        } else if (typeof cell.value === "string") {
          expect(cell.numFmt, `${title} ${cell.address}`).toBe("@");
        } else if (typeof cell.value === "number") {
          expect(cell.numFmt, `${title} ${cell.address}`).toMatch(/^(0|#,##0\.000|#,##0\.00#)$/);
        }
      }
    });
  });

  it("is English whatever the language of the request: no Arabic in the header, the sheet or the words of the file", () => {
    const { sheet, headerRow, titles } = exported[c.name]!;

    expect(`${sheet.name} ${titles.join(" ")}`).not.toMatch(/[؀-ۿ]/);
    // The Arabic of the fixtures is data, written as it came; only the columns that hold words of the application are checked.
    const words = new Set([
      "Status",
      "Priority",
      "Weather",
      "Type",
      "Source",
      "Overdue",
      "Work Phase",
      "Action",
      "Entity",
    ]);
    titles.forEach((title, index) => {
      if (!words.has(title)) return;
      for (let row = headerRow + 1; row <= headerRow + 4; row++) {
        expect(shown(sheet.getRow(row).getCell(index + 1)), `${title} row ${row}`).not.toMatch(/[؀-ۿ]/);
      }
    });
  });
});

describe("across the twelve files", () => {
  it("a column that is the same thing has the same title and the same format everywhere", () => {
    const formats = new Map<string, Set<string>>();
    for (const c of CASES) {
      const { sheet, headerRow, titles } = exported[c.name]!;
      titles.forEach((title, index) => {
        const format = sheet.getRow(headerRow + 1).getCell(index + 1).numFmt ?? "general";
        formats.set(title, (formats.get(title) ?? new Set()).add(format));
      });
    }

    // Progress is two things: a villa's average (text, one decimal) and an open work's whole percent (a number, which the
    // import reads back).
    for (const [title, set] of formats) {
      if (title !== "Progress") expect([...set], `${title} is formatted one way`).toHaveLength(1);
    }
    expect(formats.get("Progress")).toEqual(new Set(["@", "0"]));
    expect(formats.get("Created (UTC)")).toEqual(new Set(['yyyy-mm-dd hh:mm "UTC"']));
    expect(formats.get("Villa Number")).toEqual(new Set(["@"]));
    expect(formats.get("Contractor")).toEqual(new Set(["@"]));
  });

  it("the audit log reads its action and its entity as words, not codes, even for one it does not know", () => {
    const { sheet, headerRow, titles } = exported["audit log"]!;
    const at = (title: string) => titles.indexOf(title) + 1;
    const cells = (title: string) =>
      [1, 2, 3, 4].map((n) => String(sheet.getRow(headerRow + n).getCell(at(title)).value));

    expect(cells("Action")).toEqual([
      "Created a villa",
      "Created a villa",
      "widget.explode",
      "Created a villa",
    ]);
    // A two-word entity reads as words ("Daily report", not DailyReport), in English whatever the list item says.
    expect(cells("Entity")).toEqual(["Villa", "Daily report", "Widget", "Villa"]);
  });

  it("the daily report and the small work say whose date their dates are", () => {
    expect(exported["daily reports"]!.titles).toContain("Report Date");
    expect(exported["small works"]!.titles).toEqual(expect.arrayContaining(["Start Date", "End Date"]));
    expect(exported["site reports"]!.titles).toContain("Visit Date");
    expect(exported["daily labour"]!.titles).toContain("Labour Date");
  });

  it("every spreadsheet is a different size of table, but the header row sits at row 1 unless a summary is above it", () => {
    for (const c of CASES) {
      expect(exported[c.name]!.headerRow, c.name).toBe(c.summaryLines === 0 ? 1 : c.summaryLines + 2);
    }
  });

  it("an empty value is an empty cell, never a space or a dash", () => {
    for (const c of CASES) {
      const { sheet } = exported[c.name]!;
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          expect(String(cell.value), `${c.name} ${cell.address}`).not.toMatch(
            /^\s+$|^[-–—]$|^null$|^undefined$/,
          );
        }),
      );
    }
  });
});

describe("the contractor summary", () => {
  it("has the contractor, phone and total above the table, with the formula in the name kept as text", () => {
    const { sheet } = exported["contractor summary"]!;

    expect([1, 2, 3].map((row) => sheet.getRow(row).getCell(1).value)).toEqual([
      "Contractor",
      "Phone",
      "Total villas",
    ]);
    expect(sheet.getRow(1).getCell(2).value).toBe(`'${HOSTILE}`);
    expect(sheet.getRow(4).getCell(1).value).toBeNull();
  });
});

// Columns only the workbook has: the PDF keeps the columns it had before the import and the export were made to match.
const XLSX_ONLY = new Set(["Currency"]);

describe("the PDF of each export", () => {
  it.each(CASES)(
    "$name: has its title and every column header, in English",
    async (c) => {
      const file = await c.run(service(), "pdf");
      const { bytes } = await bytesOf(file);
      const { titles } = exported[c.name]!;

      const { pages } = await readPdf(bytes);
      const text = pages.flat().join(" ");

      expect(file.filename).toBe(`asico-${c.stem}-2026-10-12.pdf`);
      expect(file.contentType).toBe("application/pdf");
      expect(text).toContain(c.names.title);
      for (const title of titles.filter((title) => !XLSX_ONLY.has(title))) {
        // A header that does not fit on one line is broken between words, so its words are looked for.
        for (const word of title.replace(/[()]/g, "").split(" ")) {
          expect(text, `${c.name}: ${word}`).toContain(word);
        }
      }
    },
    30_000,
  );
});

describe("the import templates fit their columns the way the exports do", () => {
  const templates = Object.entries(emptyTemplates);

  it.each(templates)(
    "%s: every column of every sheet is within 8 and 60 and holds its longest cell",
    async (_name, make) => {
      const { bytes } = await make();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

      expect(workbook.worksheets.length).toBeGreaterThanOrEqual(2);
      for (const sheet of workbook.worksheets) {
        for (let number = 1; number <= sheet.columnCount; number++) {
          const column = sheet.getColumn(number);
          let header = 0;
          let longest = 0;
          column.eachCell({ includeEmpty: false }, (cell, row) => {
            if (row === 1) header = displayWidth(cell.text);
            else longest = Math.max(longest, widestLine(cell.text));
          });
          const label = `${sheet.name} column ${number}`;
          expect(column.width, label).toBeGreaterThanOrEqual(8);
          expect(column.width, label).toBeLessThanOrEqual(MAX_COLUMN_CHARACTERS);
          expect(column.width, label).toBeGreaterThanOrEqual(
            Math.min(MAX_COLUMN_CHARACTERS, Math.ceil(header * 1.1 + 3)),
          );
          expect(column.width, label).toBeGreaterThanOrEqual(Math.min(MAX_COLUMN_CHARACTERS, longest + 2));
        }
      }
    },
  );
});

describe("the filters a file reports", () => {
  const schemas = {
    villas: listVillasQuerySchema,
    "open works": listOpenWorksQuerySchema,
    "daily reports": listDailyReportsQuerySchema,
    "small works": listSmallWorksQuerySchema,
    "site reports": listSiteReportsQuerySchema,
    "daily labour": listDailyLabourQuerySchema,
    contractors: listContractorsQuerySchema,
    "contractor summary": contractorSummaryQuerySchema,
    "civil engineers": listCivilEngineersQuerySchema,
    "electrical engineers": listElectricalEngineersQuerySchema,
    areas: listAreasQuerySchema,
    "audit log": listAuditLogsQuerySchema,
  } as const;
  const keysOf = (schema: { shape: Record<string, unknown> }) =>
    Object.keys(schema.shape).filter((key) => key !== "page" && key !== "limit");

  it.each(Object.entries(schemas))(
    "%s: every filter its list takes has a label of its own",
    (_name, schema) => {
      const unlabelled = keysOf(schema).filter((key) => !Object.hasOwn(FILTER_LABELS, key));

      expect(unlabelled).toEqual([]);
    },
  );

  it("every label is for a filter some list takes (none is left over)", () => {
    const taken = new Set(Object.values(schemas).flatMap(keysOf));

    expect(Object.keys(FILTER_LABELS).filter((key) => !taken.has(key))).toEqual([]);
  });
});
