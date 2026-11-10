import http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { addSiteReport, siteReportRaces, siteReportTables } from "./in-memory-site-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/site-reports/repository/site-reports.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/site-reports/repository/site-reports.repository.js")
  >()),
  SiteReportsRepository: (await import("./in-memory-site-reports.repository.js"))
    .InMemorySiteReportsRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { SiteReportsService } from "../../../src/modules/site-reports/service/site-reports.service.js";

const app = createApp();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let villa: StoredVilla;
let other: StoredVilla;

beforeEach(() => {
  store.reset();
  villaTables.reset();
  siteReportRaces.reset();
  siteReportTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa = addVilla({ villaNumber: "P-001", area: "New Cairo", block: "B1", plot: "1" });
  other = addVilla({ villaNumber: "P-002", area: "6 October", block: "B2", plot: "2" });
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
    .get(`/api/v1/site-reports?limit=100${query ? `&${query}` : ""}`)
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
const exportedTitles = async (query: string): Promise<string[]> =>
  tableOf(await sheetOf(await download(`/site-reports/export?format=xlsx${query ? `&${query}` : ""}`))).map(
    (row) => String(row["Title"]),
  );
const exportAudits = () =>
  (store.auditRows as unknown as Record<string, unknown>[]).filter(
    (row) => row["action"] === "export.site-reports",
  );

function seed() {
  addSiteReport({
    villaId: villa.id,
    visitDate: day("2026-03-01"),
    title: "Foundation check 100%_x",
    inspector: "Hamdy",
    type: "INSPECTION",
    rating: 5,
    findings: "Solid",
    recommendations: "Keep it",
  });
  addSiteReport({
    villaId: villa.id,
    visitDate: day("2026-03-03"),
    title: "Scaffold safety round",
    inspector: "Mona",
    type: "SAFETY",
    rating: 2,
    findings: "Loose",
    recommendations: null,
  });
  addSiteReport({
    villaId: other.id,
    visitDate: day("2026-03-02"),
    title: "Tile quality",
    inspector: "Karim",
    type: "QUALITY",
    rating: 3,
    findings: "Uneven",
  });
}

describe("GET /site-reports/export: access", () => {
  it("requires authentication (401)", async () => {
    expect((await request(app).get("/api/v1/site-reports/export?format=xlsx")).status).toBe(401);
  });

  it("answers 403 to an employee with no permissions, in Arabic", async () => {
    const res = await download("/site-reports/export?format=xlsx", employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("is opened by site-reports:export alone: read and import do not open it, and it does not open the list", async () => {
    const others = employee(
      "o@example.test",
      "site-reports:read",
      "site-reports:import",
      "small-works:export",
      "villas:export",
    );
    expect((await download("/site-reports/export?format=xlsx", others)).status).toBe(403);

    const exporter = employee("x@example.test", "site-reports:export");
    expect((await download("/site-reports/export?format=xlsx", exporter)).status).toBe(200);
    expect((await download("/site-reports/export?format=pdf", exporter)).status).toBe(200);
    const list = await request(app)
      .get("/api/v1/site-reports")
      .set(await as(exporter));
    expect(list.status).toBe(403);
  });

  it("is not read as a site report id: /site-reports/export never reaches /site-reports/:id", async () => {
    const res = await download("/site-reports/export?format=xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});

describe("GET /site-reports/export: the file", () => {
  it("has these columns, in this order, and nothing else", async () => {
    seed();
    const sheet = await sheetOf(await download("/site-reports/export?format=xlsx"));

    expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
      "Villa Number",
      "Title",
      "Visit Date",
      "Inspector",
      "Type",
      "Rating",
      "Findings",
      "Recommendations",
      "Location",
    ]);
    expect(sheet.name).toBe("Site Reports");
  });

  it("writes each row in English words, whatever the language of the request, the rating as a number", async () => {
    seed();
    const rows = tableOf(await sheetOf(await download("/site-reports/export?format=xlsx", admin, "ar")));

    const foundation = rows.find((row) => row["Title"] === "Foundation check 100%_x")!;
    expect(foundation).toMatchObject({
      "Villa Number": "P-001",
      Type: "Inspection",
      Rating: 5,
      Inspector: "Hamdy",
      Findings: "Solid",
      Recommendations: "Keep it",
    });
    expect(String(foundation["Location"])).toContain("New Cairo");
    expect((foundation["Visit Date"] as Date).toISOString().slice(0, 10)).toBe("2026-03-01");

    const scaffold = rows.find((row) => row["Title"] === "Scaffold safety round")!;
    expect(scaffold).toMatchObject({ Type: "Safety", Rating: 2 });
    expect(scaffold["Recommendations"] ?? "").toBe("");
    expect(rows.find((row) => row["Title"] === "Tile quality")).toMatchObject({ Type: "Quality", Rating: 3 });
  });

  it("writes every type as its English label", async () => {
    for (const type of ["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"] as const) {
      addSiteReport({ villaId: villa.id, title: type, type });
    }

    const rows = tableOf(await sheetOf(await download("/site-reports/export?format=xlsx")));

    expect(Object.fromEntries(rows.map((row) => [row["Title"], row["Type"]]))).toEqual({
      INSPECTION: "Inspection",
      SAFETY: "Safety",
      PROGRESS: "Progress",
      QUALITY: "Quality",
    });
  });

  it("keeps the rating as a whole number in the cell, with no decimals", async () => {
    seed();
    const sheet = await sheetOf(await download("/site-reports/export?format=xlsx"));

    const titles = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1);
    const ratingColumn = titles.indexOf("Rating") + 1;
    const values: number[] = [];
    for (let n = 2; n <= sheet.rowCount; n++) {
      const cell = sheet.getRow(n).getCell(ratingColumn);
      expect(cell.numFmt).not.toContain(".");
      values.push(cell.value as number);
    }
    expect(values.sort()).toEqual([2, 3, 5]);
  });

  it("lists the rows in the order of the list (newest day by default, or the sort asked for)", async () => {
    seed();
    const listed = (await listJson("")).body.data.map((item: { title: string }) => item.title);

    expect(await exportedTitles("")).toEqual(listed);
    expect(listed[0]).toBe("Scaffold safety round");
    expect(await exportedTitles("sort=rating:desc")).toEqual(
      (await listJson("sort=rating:desc")).body.data.map((item: { title: string }) => item.title),
    );
  });

  it.each([
    ["villaId", () => `villaId=${villa.id}`],
    ["type", () => "type=SAFETY"],
    ["rating", () => "rating=3"],
    ["visitFrom/visitTo", () => "visitFrom=2026-03-02&visitTo=2026-03-02"],
    ["search", () => "search=tile"],
    ["search over the title", () => "search=100%25_"],
  ])("takes the list's %s filter, and exports what the list shows", async (_name, query) => {
    seed();
    const listed = (await listJson(query())).body.data.map((item: { title: string }) => item.title);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(3);
    expect(await exportedTitles(query())).toEqual(listed);
  });

  it("reads the same filters into a PDF, and says which were applied", async () => {
    seed();
    const res = await download(
      "/site-reports/export?format=pdf&type=QUALITY&rating=3&visitFrom=2026-03-02&visitTo=2026-03-31",
    );

    expect(res.status).toBe(200);
    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Site Reports");
    expect(text).toContain("Type: Quality");
    expect(text).toContain("Rating: 3");
    expect(text).toContain("Visit from:");
    expect(text).toContain("Visit to:");
    expect(text).toContain("Tile quality");
    expect(text).not.toContain("Foundation check");
  });

  it("gives every column a width of its own, wide enough for the longest cell", async () => {
    seed();
    addSiteReport({
      villaId: other.id,
      visitDate: day("2026-04-01"),
      title: "Main distribution board and the feeders to every floor",
    });
    const sheet = await sheetOf(await download("/site-reports/export?format=xlsx"));

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
    const sheet = await sheetOf(await download("/site-reports/export?format=xlsx"));

    expect(tableOf(sheet)).toEqual([]);
    expect(sheet.getRow(1).getCell(2).value).toBe("Title");
  });
});

describe("GET /site-reports/export: texts of the longest allowed length", () => {
  const long = (letter: string): string => `${letter.repeat(49)} `.repeat(100).slice(0, 5000);
  const seedLong = () => {
    addSiteReport({
      villaId: villa.id,
      visitDate: day("2026-03-01"),
      title: "t".repeat(150),
      findings: long("f"),
      recommendations: long("r"),
    });
    addSiteReport({
      villaId: other.id,
      visitDate: day("2026-03-01"),
      title: "u".repeat(150),
      findings: long("x"),
      recommendations: long("y"),
    });
  };

  it("keeps all 5,000 characters of findings and of recommendations, and the 150 of the title, in the spreadsheet", async () => {
    seedLong();

    const rows = tableOf(await sheetOf(await download("/site-reports/export?format=xlsx")));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row["Title"])).toHaveLength(150);
      expect(String(row["Findings"])).toHaveLength(5000);
      expect(String(row["Recommendations"])).toHaveLength(5000);
    }
  });

  it("writes a readable PDF of them, each cell clipped to a few lines so a row never takes a page", async () => {
    seedLong();
    addSiteReport({ villaId: villa.id, visitDate: day("2026-03-02"), title: "Short visit" });

    const res = await download("/site-reports/export?format=pdf");

    expect(res.status).toBe(200);
    const pdf = await readPdf(res.body);
    const text = pdf.pages.flat().join(" ");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
    // Three rows fit on a couple of pages: the long texts are cut with an ellipsis, not spread over the document.
    expect(pdf.numPages).toBeLessThanOrEqual(2);
    expect(text).toContain("…");
    expect(text).toContain("Short visit");
    expect(text.length).toBeLessThan(5000);
  });
});

describe("GET /site-reports/export: the request", () => {
  it.each([
    ["no format", ""],
    ["a format that does not exist", "format=csv"],
    ["a page", "format=xlsx&page=1"],
    ["a limit", "format=xlsx&limit=5"],
    ["a type that does not exist", "format=xlsx&type=AUDIT"],
    ["a rating out of range", "format=xlsx&rating=6"],
    ["a sort that does not exist", "format=xlsx&sort=bogus"],
    ["a villa id that is not an id", "format=xlsx&villaId=7"],
    ["an inverted range", "format=xlsx&visitFrom=2026-10-06&visitTo=2026-10-05"],
  ])("refuses %s with 400, in Arabic", async (_name, query) => {
    const res = await download(`/site-reports/export?${query}`, admin, "ar");

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE before generating anything, in Arabic", async () => {
    vi.spyOn(SiteReportsService.prototype, "list").mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 1000, total: 10_001, totalPages: 11 },
    });

    const res = await download("/site-reports/export?format=xlsx", admin, "ar");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(exportAudits()).toHaveLength(0);
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    for (let n = 0; n < 10_000; n++) addSiteReport({ villaId: villa.id, title: `Visit ${n}` });

    const res = await download("/site-reports/export?format=xlsx");

    const rows = tableOf(await sheetOf(res));
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row["Title"])).size, "every page is a different page").toBe(10_000);
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  }, 120_000);
});

describe("GET /site-reports/export: the audit entry and the allowance", () => {
  it("writes one export.site-reports entry on SiteReport with the filters, the format and the count, never the rows", async () => {
    seed();

    await download("/site-reports/export?format=xlsx&type=SAFETY", admin);

    expect(exportAudits()).toHaveLength(1);
    const [entry] = exportAudits() as { actorId: string; entity: string; after: Record<string, unknown> }[];
    expect(entry).toMatchObject({
      actorId: admin.id,
      entity: "SiteReport",
      after: { format: "xlsx", filters: expect.objectContaining({ type: "SAFETY" }), rowCount: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain("Scaffold");
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/site-reports/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("shares the export allowance of the user, and counts the site reports export in it", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "site-reports:export");

    expect((await download("/site-reports/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/site-reports/export?format=xlsx", user)).status).toBe(200);
    const third = await download("/site-reports/export?format=xlsx", user);

    expect(third.status).toBe(429);
  });

  it("names the file after the export", async () => {
    const res = await download("/site-reports/export?format=xlsx");

    expect(res.headers["content-disposition"]).toMatch(/asico-site-reports-\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  it("leaves the table untouched", async () => {
    seed();

    await download("/site-reports/export?format=xlsx");

    expect(siteReportTables.reports).toHaveLength(3);
  });
});
