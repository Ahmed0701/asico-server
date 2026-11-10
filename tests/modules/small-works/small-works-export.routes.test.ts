import http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { addSmallWork, smallWorkRaces, smallWorkTables } from "./in-memory-small-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/small-works/repository/small-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/small-works/repository/small-works.repository.js")
  >()),
  SmallWorksRepository: (await import("./in-memory-small-works.repository.js")).InMemorySmallWorksRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { SmallWorksService } from "../../../src/modules/small-works/service/small-works.service.js";

const app = createApp();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let villa: StoredVilla;
let other: StoredVilla;
let hamdy: { id: string };
let mona: { id: string };
let karim: { id: string };

beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  smallWorkRaces.reset();
  smallWorkTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa = addVilla({ villaNumber: "P-001", area: "New Cairo", block: "B1", plot: "1" });
  other = addVilla({ villaNumber: "P-002", area: "6 October", block: "B2", plot: "2" });
  hamdy = addContractor({ name: "Hamdy Co", phone: "0100 000 0001" });
  mona = addContractor({ name: "Mona Co", phone: "0100 000 0002" });
  karim = addContractor({ name: "Karim Co", phone: "0100 000 0003" });
});
// A small work with the first contractor and a one-day range, unless the case says otherwise.
const work = (extra: Partial<Parameters<typeof addSmallWork>[0]> = {}) =>
  addSmallWork({ villaId: villa.id, contractorId: hamdy.id, ...extra });
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
    .get(`/api/v1/small-works?limit=100${query ? `&${query}` : ""}`)
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
const exportedWork = async (query: string): Promise<string[]> =>
  tableOf(await sheetOf(await download(`/small-works/export?format=xlsx${query ? `&${query}` : ""}`))).map(
    (row) => String(row["Description"]),
  );
const exportAudits = () =>
  (store.auditRows as unknown as Record<string, unknown>[]).filter(
    (row) => row["action"] === "export.small-works",
  );

function seed() {
  work({
    startDate: day("2026-03-01"),
    endDate: day("2026-03-02"),
    description: "Replaced a socket 100%_x",
    status: "DONE",
  });
  work({
    contractorId: mona.id,
    startDate: day("2026-03-03"),
    endDate: day("2026-03-10"),
    description: "Painted the gate",
  });
  work({
    villaId: other.id,
    contractorId: karim.id,
    startDate: day("2026-03-02"),
    endDate: day("2026-03-04"),
    description: "Fixed a tap",
  });
}

describe("GET /small-works/export: access", () => {
  it("requires authentication (401)", async () => {
    expect((await request(app).get("/api/v1/small-works/export?format=xlsx")).status).toBe(401);
  });

  it("answers 403 to an employee with no permissions, in Arabic", async () => {
    const res = await download("/small-works/export?format=xlsx", employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("is opened by small-works:export alone: read and import do not open it, and it does not open the list", async () => {
    const others = employee(
      "o@example.test",
      "small-works:read",
      "small-works:import",
      "daily-reports:export",
      "villas:export",
    );
    expect((await download("/small-works/export?format=xlsx", others)).status).toBe(403);

    const exporter = employee("x@example.test", "small-works:export");
    expect((await download("/small-works/export?format=xlsx", exporter)).status).toBe(200);
    expect((await download("/small-works/export?format=pdf", exporter)).status).toBe(200);
    const list = await request(app)
      .get("/api/v1/small-works")
      .set(await as(exporter));
    expect(list.status).toBe(403);
  });

  it("is not read as a small work id: /small-works/export never reaches /small-works/:id", async () => {
    const res = await download("/small-works/export?format=xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});

describe("GET /small-works/export: the file", () => {
  it("has these columns, in this order, and nothing else", async () => {
    seed();
    const sheet = await sheetOf(await download("/small-works/export?format=xlsx"));

    expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
      "Villa Number",
      "Start Date",
      "End Date",
      "Description",
      "Contractor",
      "Status",
      "Location",
    ]);
    expect(sheet.name).toBe("Daily Small Works");
  });

  it("writes each row in English words, whatever the language of the request", async () => {
    seed();
    const rows = tableOf(await sheetOf(await download("/small-works/export?format=xlsx", admin, "ar")));

    const socket = rows.find((row) => row["Description"] === "Replaced a socket 100%_x")!;
    expect(socket).toMatchObject({
      "Villa Number": "P-001",
      Contractor: "Hamdy Co",
      Status: "Done",
    });
    expect(String(socket["Location"])).toContain("New Cairo");
    expect((socket["Start Date"] as Date).toISOString().slice(0, 10)).toBe("2026-03-01");
    expect((socket["End Date"] as Date).toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(Object.keys(socket)).not.toContain("Done By");
    expect(Object.keys(socket)).not.toContain("Work Date");

    const tap = rows.find((row) => row["Description"] === "Fixed a tap")!;
    expect(tap).toMatchObject({ Status: "Pending" });
  });

  it("lists the rows in the order of the list (the latest end date by default, or the sort asked for)", async () => {
    seed();
    const listed = (await listJson("")).body.data.map((item: { description: string }) => item.description);

    expect(await exportedWork("")).toEqual(listed);
    expect(listed[0]).toBe("Painted the gate");
    expect(await exportedWork("sort=contractorName:desc")).toEqual(
      (await listJson("sort=contractorName:desc")).body.data.map(
        (item: { description: string }) => item.description,
      ),
    );
  });

  it.each([
    ["villaId", () => `villaId=${villa.id}`],
    ["status", () => "status=DONE"],
    ["startFrom/startTo", () => "startFrom=2026-03-02&startTo=2026-03-02"],
    ["endFrom/endTo", () => "endFrom=2026-03-04&endTo=2026-03-04"],
    ["contractorId", () => `contractorId=${karim.id}`],
    ["overdue", () => "overdue=true"],
    ["dueSoon", () => "dueSoon=false&status=PENDING"],
    ["search", () => "search=tap"],
    ["search over the description", () => "search=100%25_"],
  ])("takes the list's %s filter, and exports what the list shows", async (_name, query) => {
    seed();
    const listed = (await listJson(query())).body.data.map(
      (item: { description: string }) => item.description,
    );

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(3);
    expect(await exportedWork(query())).toEqual(listed);
  });

  it("reads the same filters into a PDF, and says which were applied", async () => {
    seed();
    const res = await download(
      "/small-works/export?format=pdf&status=PENDING&endFrom=2026-03-02&endTo=2026-03-31&overdue=true",
    );

    expect(res.status).toBe(200);
    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Daily Small Works");
    expect(text).toContain("Status: Pending");
    expect(text).toContain("End from:");
    expect(text).toContain("End to:");
    expect(text).toContain("Overdue: Yes");
    expect(text).toContain("Mona Co");
    expect(text).toContain("Painted the gate");
    expect(text).not.toContain("Replaced a socket");
  });

  it("gives every column a width of its own, wide enough for the longest cell", async () => {
    seed();
    work({
      villaId: other.id,
      startDate: day("2026-04-01"),
      endDate: day("2026-04-01"),
      description: "Install the main distribution board and the feeders to every floor",
    });
    const sheet = await sheetOf(await download("/small-works/export?format=xlsx"));

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
    const sheet = await sheetOf(await download("/small-works/export?format=xlsx"));

    expect(tableOf(sheet)).toEqual([]);
    expect(sheet.getRow(1).getCell(4).value).toBe("Description");
  });
});

describe("GET /small-works/export: texts of the longest allowed length", () => {
  const long = (letter: string): string => `${letter.repeat(49)} `.repeat(10).slice(0, 500);

  it("keeps all 500 characters of the description in the spreadsheet", async () => {
    work({ startDate: day("2026-03-01"), endDate: day("2026-03-01"), description: long("w") });
    work({
      villaId: other.id,
      startDate: day("2026-03-01"),
      endDate: day("2026-03-01"),
      description: long("x"),
    });

    const rows = tableOf(await sheetOf(await download("/small-works/export?format=xlsx")));

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(String(row["Description"])).toHaveLength(500);
  });

  it("shows the start date and the end date of each work in the PDF, in two columns", async () => {
    seed();

    const res = await download("/small-works/export?format=pdf&status=PENDING");

    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("2026-03-03");
    expect(text).toContain("2026-03-10");
  });

  it("writes a readable PDF of them, each cell clipped so a row never takes a page", async () => {
    work({ startDate: day("2026-03-01"), endDate: day("2026-03-01"), description: long("w") });
    work({ startDate: day("2026-03-02"), endDate: day("2026-03-02"), description: "Short work" });

    const res = await download("/small-works/export?format=pdf");

    expect(res.status).toBe(200);
    const pdf = await readPdf(res.body);
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.numPages).toBeLessThanOrEqual(2);
    expect(pdf.pages.flat().join(" ")).toContain("Short work");
  });
});

describe("GET /small-works/export: the request", () => {
  it.each([
    ["no format", ""],
    ["a format that does not exist", "format=csv"],
    ["a page", "format=xlsx&page=1"],
    ["a limit", "format=xlsx&limit=5"],
    ["a status that does not exist", "format=xlsx&status=CANCELLED"],
    ["a sort that does not exist", "format=xlsx&sort=bogus"],
    ["a villa id that is not an id", "format=xlsx&villaId=7"],
    ["an inverted start range", "format=xlsx&startFrom=2026-10-06&startTo=2026-10-05"],
    ["an inverted end range", "format=xlsx&endFrom=2026-10-06&endTo=2026-10-05"],
    ["a flag that is not a boolean", "format=xlsx&overdue=maybe"],
  ])("refuses %s with 400, in Arabic", async (_name, query) => {
    const res = await download(`/small-works/export?${query}`, admin, "ar");

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE before generating anything, in Arabic", async () => {
    vi.spyOn(SmallWorksService.prototype, "list").mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 1000, total: 10_001, totalPages: 11 },
    });

    const res = await download("/small-works/export?format=xlsx", admin, "ar");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(exportAudits()).toHaveLength(0);
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    for (let n = 0; n < 10_000; n++) work({ description: `Work ${n}` });

    const res = await download("/small-works/export?format=xlsx");

    const rows = tableOf(await sheetOf(res));
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row["Description"])).size, "every page is a different page").toBe(
      10_000,
    );
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  }, 120_000);
});

describe("GET /small-works/export: the audit entry and the allowance", () => {
  it("writes one export.small-works entry on DailySmallWork with the filters, the format and the count, never the rows", async () => {
    seed();

    await download("/small-works/export?format=xlsx&status=PENDING", admin);

    expect(exportAudits()).toHaveLength(1);
    const [entry] = exportAudits() as { actorId: string; entity: string; after: Record<string, unknown> }[];
    expect(entry).toMatchObject({
      actorId: admin.id,
      entity: "DailySmallWork",
      after: { format: "xlsx", filters: expect.objectContaining({ status: "PENDING" }), rowCount: 2 },
    });
    expect(JSON.stringify(entry)).not.toContain("Painted");
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/small-works/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("shares the export allowance of the user, and counts the small works export in it", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "small-works:export");

    expect((await download("/small-works/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/small-works/export?format=xlsx", user)).status).toBe(200);
    const third = await download("/small-works/export?format=xlsx", user);

    expect(third.status).toBe(429);
  });

  it("names the file after the export", async () => {
    const res = await download("/small-works/export?format=xlsx");

    expect(res.headers["content-disposition"]).toMatch(/asico-small-works-\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  it("leaves the table untouched", async () => {
    seed();

    await download("/small-works/export?format=xlsx");

    expect(smallWorkTables.works).toHaveLength(3);
  });
});
