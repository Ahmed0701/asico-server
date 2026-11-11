import http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { addDailyReport, dailyReportRaces, dailyReportTables } from "./in-memory-daily-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock(
  "../../../src/modules/daily-reports/repository/daily-reports.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/daily-reports/repository/daily-reports.repository.js")
    >()),
    DailyReportsRepository: (await import("./in-memory-daily-reports.repository.js"))
      .InMemoryDailyReportsRepository,
  }),
);

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { DailyReportsService } from "../../../src/modules/daily-reports/service/daily-reports.service.js";

const app = createApp();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;
let mona: ReturnType<typeof addElectricalEngineer>;
let karim: ReturnType<typeof addElectricalEngineer>;

beforeEach(() => {
  store.reset();
  contractorTables.reset();
  electricalTables.reset();
  villaTables.reset();
  dailyReportRaces.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  mona = addElectricalEngineer({ name: "Mona Hassan" });
  karim = addElectricalEngineer({ name: "Karim Adel" });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.EXPORT_RATE_LIMIT_MAX = original.limit;
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}
const binary = (response: request.Response, done: (err: Error | null, body: Buffer) => void): void => {
  const incoming = response as unknown as http.IncomingMessage;
  const chunks: Buffer[] = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("end", () => done(null, Buffer.concat(chunks)));
};
const download = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language)
    .buffer(true)
    .parse(binary as never);
const listJson = async (query: string) =>
  request(app)
    .get(`/api/v1/daily-reports?limit=100${query ? `&${query}` : ""}`)
    .set(await as(admin));

async function sheetOf(res: request.Response): Promise<ExcelJS.Worksheet> {
  expect(res.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as unknown as ArrayBuffer);
  return workbook.worksheets[0]!;
}
function tableOf(sheet: ExcelJS.Worksheet): Record<string, ExcelJS.CellValue>[] {
  const titles = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1) as string[];
  const rows: Record<string, ExcelJS.CellValue>[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const values = (sheet.getRow(n).values as ExcelJS.CellValue[]).slice(1);
    rows.push(Object.fromEntries(titles.map((title, i) => [title, values[i] ?? null])));
  }
  return rows;
}
const exportedNotes = async (query: string): Promise<string[]> =>
  tableOf(await sheetOf(await download(`/daily-reports/export?format=xlsx${query ? `&${query}` : ""}`))).map(
    (row) => String(row["Notes"]),
  );
const exportAudits = () =>
  (store.auditRows as unknown as Record<string, unknown>[]).filter(
    (row) => row["action"] === "export.daily-reports",
  );

function seed() {
  addDailyReport({
    contractorId: nile.id,
    preparedByEngineerId: mona.id,
    reportDate: day("2026-03-01"),
    weather: "HOT",
    workersCount: 30,
    notes: "Excavation 100%_x. Water pipe burst",
  });
  addDailyReport({
    contractorId: nile.id,
    preparedByEngineerId: karim.id,
    reportDate: day("2026-03-03"),
    weather: "RAINY",
    workersCount: 5,
    notes: "Rebar tying",
  });
  addDailyReport({
    contractorId: delta.id,
    preparedByEngineerId: mona.id,
    reportDate: day("2026-03-02"),
    weather: "SUNNY",
    workersCount: 12,
    notes: "Formwork. Late steel",
  });
}

describe("GET /daily-reports/export: access", () => {
  it("requires authentication (401)", async () => {
    expect((await request(app).get("/api/v1/daily-reports/export?format=xlsx")).status).toBe(401);
  });

  it("answers 403 to an employee with no permissions, in Arabic", async () => {
    const res = await download("/daily-reports/export?format=xlsx", employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("is opened by daily-reports:export alone: read and import do not open it, and it does not open the list", async () => {
    const others = employee(
      "o@example.test",
      "daily-reports:read",
      "daily-reports:import",
      "open-works:export",
      "villas:export",
    );
    expect((await download("/daily-reports/export?format=xlsx", others)).status).toBe(403);

    const exporter = employee("x@example.test", "daily-reports:export");
    expect((await download("/daily-reports/export?format=xlsx", exporter)).status).toBe(200);
    expect((await download("/daily-reports/export?format=pdf", exporter)).status).toBe(200);
    const list = await request(app)
      .get("/api/v1/daily-reports")
      .set(await as(exporter));
    expect(list.status).toBe(403);
  });

  it("is not read as a report id: /daily-reports/export never reaches /daily-reports/:id", async () => {
    const res = await download("/daily-reports/export?format=xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});

describe("GET /daily-reports/export: the file", () => {
  it("has these columns, in this order, and nothing else", async () => {
    seed();
    const sheet = await sheetOf(await download("/daily-reports/export?format=xlsx"));

    expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
      "Report Date",
      "Contractor",
      "Electrical Engineer",
      "Weather",
      "Workers",
      "Notes",
    ]);
    expect(sheet.name).toBe("Daily Reports");
  });

  it("writes each row in English words, whatever the language of the request", async () => {
    seed();
    const rows = tableOf(await sheetOf(await download("/daily-reports/export?format=xlsx", admin, "ar")));

    expect(rows).toHaveLength(3);
    const excavation = rows.find((row) => String(row["Notes"]).startsWith("Excavation"))!;
    expect(excavation).toMatchObject({
      Weather: "Hot",
      Workers: 30,
      Contractor: "Nile Builders",
      "Electrical Engineer": "Mona Hassan",
      Notes: "Excavation 100%_x. Water pipe burst",
    });
    expect((excavation["Report Date"] as Date).toISOString().slice(0, 10)).toBe("2026-03-01");

    const rebar = rows.find((row) => row["Notes"] === "Rebar tying")!;
    expect(rebar).toMatchObject({ Weather: "Rainy", Workers: 5, "Electrical Engineer": "Karim Adel" });
  });

  it("has no villa, work done, issues or prepared-by column any more", async () => {
    seed();
    const sheet = await sheetOf(await download("/daily-reports/export?format=xlsx"));
    const titles = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1);

    for (const gone of ["Villa Number", "Location", "Work Done", "Issues", "Prepared By"]) {
      expect(titles).not.toContain(gone);
    }
  });

  it("leaves the notes empty for a report without any", async () => {
    addDailyReport({ contractorId: nile.id, preparedByEngineerId: mona.id });

    const [row] = tableOf(await sheetOf(await download("/daily-reports/export?format=xlsx")));

    expect(row!["Notes"]).toBeNull();
  });

  it("spells each kind of weather in words", async () => {
    const kinds = ["HOT", "SUNNY", "WINDY", "RAINY", "DUSTY"] as const;
    kinds.forEach((weather, n) =>
      addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: mona.id,
        reportDate: day(`2026-03-0${n + 1}`),
        weather,
        notes: weather,
      }),
    );
    const rows = tableOf(await sheetOf(await download("/daily-reports/export?format=xlsx")));

    const spelled = Object.fromEntries(rows.map((row) => [String(row["Notes"]), row["Weather"]]));
    expect(spelled).toEqual({
      HOT: "Hot",
      SUNNY: "Sunny",
      WINDY: "Windy",
      RAINY: "Rainy",
      DUSTY: "Dusty",
    });
  });

  it("lists the rows in the order of the list (newest day by default, or the sort asked for)", async () => {
    seed();
    const listed = (await listJson("")).body.data.map((item: { notes: string }) => item.notes);

    expect(await exportedNotes("")).toEqual(listed);
    expect(listed[0]).toBe("Rebar tying");
    expect(await exportedNotes("sort=contractorName:desc")).toEqual(
      (await listJson("sort=contractorName:desc")).body.data.map((item: { notes: string }) => item.notes),
    );
    expect(await exportedNotes("sort=preparedByName:asc")).toEqual(
      (await listJson("sort=preparedByName:asc")).body.data.map((item: { notes: string }) => item.notes),
    );
  });

  it.each([
    ["contractorId", () => `contractorId=${delta.id}`],
    ["preparedByEngineerId", () => `preparedByEngineerId=${karim.id}`],
    ["weather", () => "weather=RAINY"],
    ["reportFrom/reportTo", () => "reportFrom=2026-03-02&reportTo=2026-03-02"],
    ["search", () => "search=steel"],
    ["search over the notes", () => "search=100%25_"],
  ])("takes the list's %s filter, and exports what the list shows", async (_name, query) => {
    seed();
    const listed = (await listJson(query())).body.data.map((item: { notes: string }) => item.notes);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(3);
    expect(await exportedNotes(query())).toEqual(listed);
  });

  it("reads the same filters into a PDF, and says which were applied", async () => {
    seed();
    const res = await download("/daily-reports/export?format=pdf&weather=RAINY&reportFrom=2026-03-01");

    expect(res.status).toBe(200);
    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Daily Reports");
    expect(text).toContain("Weather: Rainy");
    expect(text).toContain("Report from:");
    expect(text).toContain("Rebar tying");
    expect(text).toContain("Karim Adel");
    expect(text).not.toContain("Formwork");
  });

  it("gives every column a width of its own, wide enough for the longest cell", async () => {
    seed();
    addDailyReport({
      contractorId: delta.id,
      preparedByEngineerId: karim.id,
      reportDate: day("2026-04-01"),
      notes: "Install the main distribution board and the feeders to every floor",
    });
    const sheet = await sheetOf(await download("/daily-reports/export?format=xlsx"));

    for (let number = 1; number <= sheet.columnCount; number++) {
      const column = sheet.getColumn(number);
      let longest = 0;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const shown = cell.value instanceof Date ? cell.numFmt.replaceAll('"', "") : cell.text;
        longest = Math.max(longest, ...shown.split(/\r\n|\r|\n/).map((line) => line.length));
      });
      expect(column.width).not.toBe(9.140625);
      expect(column.width).toBeGreaterThanOrEqual(Math.min(60, longest));
    }
  });

  it("is a file with the header only when nothing matches", async () => {
    const sheet = await sheetOf(await download("/daily-reports/export?format=xlsx"));

    expect(tableOf(sheet)).toEqual([]);
    expect(sheet.getRow(1).getCell(6).value).toBe("Notes");
  });
});

describe("GET /daily-reports/export: texts of the longest allowed length", () => {
  const long = (letter: string): string => `${letter.repeat(49)} `.repeat(100).slice(0, 5000);
  const seedLong = () => {
    addDailyReport({
      contractorId: nile.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-01"),
      notes: long("w"),
    });
    addDailyReport({
      contractorId: delta.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-01"),
      notes: long("x"),
    });
  };

  it("keeps all 5,000 characters of the notes in the spreadsheet", async () => {
    seedLong();

    const rows = tableOf(await sheetOf(await download("/daily-reports/export?format=xlsx")));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row["Notes"])).toHaveLength(5000);
    }
  });

  it("writes a readable PDF of them, each cell clipped to a few lines so a row never takes a page", async () => {
    seedLong();
    addDailyReport({
      contractorId: nile.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-02"),
      notes: "Short work",
    });

    const res = await download("/daily-reports/export?format=pdf");

    expect(res.status).toBe(200);
    const pdf = await readPdf(res.body);
    const text = pdf.pages.flat().join(" ");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
    // Three rows fit on a couple of pages: the long texts are cut with an ellipsis, not spread over the document.
    expect(pdf.numPages).toBeLessThanOrEqual(2);
    expect(text).toContain("…");
    expect(text).toContain("Short work");
    expect(text.length).toBeLessThan(5000);
  });
});

describe("GET /daily-reports/export: the request", () => {
  it.each([
    ["no format", ""],
    ["a format that does not exist", "format=csv"],
    ["a page", "format=xlsx&page=1"],
    ["a limit", "format=xlsx&limit=5"],
    ["a weather that does not exist", "format=xlsx&weather=SNOWY"],
    ["a sort that does not exist", "format=xlsx&sort=bogus"],
    ["a contractor id that is not an id", "format=xlsx&contractorId=7"],
    ["an engineer id that is not an id", "format=xlsx&preparedByEngineerId=7"],
    ["the retired villaId filter", "format=xlsx&villaId=7"],
    ["an inverted range", "format=xlsx&reportFrom=2026-10-06&reportTo=2026-10-05"],
  ])("refuses %s with 400, in Arabic", async (_name, query) => {
    const res = await download(`/daily-reports/export?${query}`, admin, "ar");

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE before generating anything, in Arabic", async () => {
    vi.spyOn(DailyReportsService.prototype, "list").mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 1000, total: 10_001, totalPages: 11 },
    });

    const res = await download("/daily-reports/export?format=xlsx", admin, "ar");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(exportAudits()).toHaveLength(0);
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    // One report a day for each of 10,000 contractors would be slow to build: one contractor, one day each.
    for (let n = 0; n < 10_000; n++) {
      addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: mona.id,
        reportDate: new Date(Date.UTC(2000, 0, 1 + n)),
        notes: `Work ${n}`,
      });
    }

    const res = await download("/daily-reports/export?format=xlsx");

    const rows = tableOf(await sheetOf(res));
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row["Notes"])).size, "every page is a different page").toBe(10_000);
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  }, 120_000);
});

describe("GET /daily-reports/export: the audit entry and the allowance", () => {
  it("writes one export.daily-reports entry on DailyReport with the filters, the format and the count, never the rows", async () => {
    seed();

    await download("/daily-reports/export?format=xlsx&weather=RAINY", admin);

    expect(exportAudits()).toHaveLength(1);
    const [entry] = exportAudits() as { actorId: string; entity: string; after: Record<string, unknown> }[];
    expect(entry).toMatchObject({
      actorId: admin.id,
      entity: "DailyReport",
      after: { format: "xlsx", filters: expect.objectContaining({ weather: "RAINY" }), rowCount: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain("Rebar");
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/daily-reports/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("shares the export allowance of the user, and counts the daily reports export in it", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "daily-reports:export");

    expect((await download("/daily-reports/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/daily-reports/export?format=xlsx", user)).status).toBe(200);
    const third = await download("/daily-reports/export?format=xlsx", user);

    expect(third.status).toBe(429);
  });

  it("names the file after the export", async () => {
    const res = await download("/daily-reports/export?format=xlsx");

    expect(res.headers["content-disposition"]).toMatch(/elecico-daily-reports-\d{4}-\d{2}-\d{2}\.xlsx/);
  });
});

describe("the exported reports are the stored ones", () => {
  it("exports nothing it does not have: the table is untouched by an export", async () => {
    seed();

    await download("/daily-reports/export?format=xlsx");

    expect(dailyReportTables.reports).toHaveLength(3);
  });
});
