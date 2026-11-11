import http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { addDailyLabour, dailyLabourRaces, dailyLabourTables } from "./in-memory-daily-labour.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/daily-labour/repository/daily-labour.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/daily-labour/repository/daily-labour.repository.js")
  >()),
  DailyLabourRepository: (await import("./in-memory-daily-labour.repository.js"))
    .InMemoryDailyLabourRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { DailyLabourService } from "../../../src/modules/daily-labour/service/daily-labour.service.js";

const app = createApp();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let villa: StoredVilla;
let other: StoredVilla;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  dailyLabourRaces.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  villa = addVilla({
    villaNumber: "P-001",
    contractorId: nile.id,
    area: "New Cairo",
    block: "B1",
    plot: "1",
  });
  other = addVilla({
    villaNumber: "P-002",
    contractorId: delta.id,
    area: "6 October",
    block: "B2",
    plot: "2",
  });
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
    .get(`/api/v1/daily-labour?limit=100${query ? `&${query}` : ""}`)
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
const labourOf = (item: {
  villa: { villaNumber: string };
  labourCount: number;
  labourDate: string;
}): string => `${item.villa.villaNumber}|${item.labourDate}|${item.labourCount}`;
const exportedKeys = async (query: string): Promise<string[]> =>
  tableOf(await sheetOf(await download(`/daily-labour/export?format=xlsx${query ? `&${query}` : ""}`))).map(
    (row) =>
      `${row["Villa Number"]}|${(row["Labour Date"] as Date).toISOString().slice(0, 10)}|${row["Labour Count"]}`,
  );
const exportAudits = () =>
  (store.auditRows as unknown as Record<string, unknown>[]).filter(
    (row) => row["action"] === "export.daily-labour",
  );

function seed() {
  addDailyLabour({
    villaId: villa.id,
    contractorId: nile.id,
    labourDate: day("2026-03-01"),
    labourCount: 30,
    notes: "Excavation 100%_x",
  });
  addDailyLabour({
    villaId: villa.id,
    contractorId: nile.id,
    labourDate: day("2026-03-03"),
    labourCount: 5,
  });
  addDailyLabour({
    villaId: other.id,
    contractorId: delta.id,
    labourDate: day("2026-03-02"),
    labourCount: 12,
    notes: "Formwork steel",
  });
}

describe("GET /daily-labour/export: access", () => {
  it("requires authentication (401)", async () => {
    expect((await request(app).get("/api/v1/daily-labour/export?format=xlsx")).status).toBe(401);
  });

  it("answers 403 to an employee with no permissions, in Arabic", async () => {
    const res = await download("/daily-labour/export?format=xlsx", employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("is opened by daily-labour:export alone: read and import do not open it, and it does not open the list", async () => {
    const others = employee(
      "o@example.test",
      "daily-labour:read",
      "daily-labour:import",
      "daily-reports:export",
      "villas:export",
    );
    expect((await download("/daily-labour/export?format=xlsx", others)).status).toBe(403);

    const exporter = employee("x@example.test", "daily-labour:export");
    expect((await download("/daily-labour/export?format=xlsx", exporter)).status).toBe(200);
    expect((await download("/daily-labour/export?format=pdf", exporter)).status).toBe(200);
    const list = await request(app)
      .get("/api/v1/daily-labour")
      .set(await as(exporter));
    expect(list.status).toBe(403);
  });

  it("is not read as a row id: /daily-labour/export never reaches /daily-labour/:id", async () => {
    const res = await download("/daily-labour/export?format=xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});

describe("GET /daily-labour/export: the file", () => {
  it("has these columns, in this order, and nothing else", async () => {
    seed();
    const sheet = await sheetOf(await download("/daily-labour/export?format=xlsx"));

    expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
      "Villa Number",
      "Labour Date",
      "Labour Count",
      "Contractor",
      "Notes",
      "Location",
    ]);
    expect(sheet.name).toBe("Daily Labour");
  });

  it("writes each row in English words, whatever the language of the request", async () => {
    seed();
    const rows = tableOf(await sheetOf(await download("/daily-labour/export?format=xlsx", admin, "ar")));

    const excavation = rows.find((row) => row["Notes"] === "Excavation 100%_x")!;
    expect(excavation).toMatchObject({
      "Villa Number": "P-001",
      Contractor: "Nile Builders",
      "Labour Count": 30,
    });
    expect(String(excavation["Location"])).toContain("New Cairo");
    expect((excavation["Labour Date"] as Date).toISOString().slice(0, 10)).toBe("2026-03-01");

    const plain = rows.find((row) => row["Labour Count"] === 5)!;
    expect(plain).toMatchObject({ Contractor: "Nile Builders", Notes: null });
  });

  it("writes a labour count of zero as 0, not as an empty cell", async () => {
    addDailyLabour({
      villaId: villa.id,
      contractorId: nile.id,
      labourDate: day("2026-03-01"),
      labourCount: 0,
    });

    const rows = tableOf(await sheetOf(await download("/daily-labour/export?format=xlsx")));

    expect(rows[0]!["Labour Count"]).toBe(0);
  });

  it("lists the rows in the order of the list (newest day by default, or the sort asked for)", async () => {
    seed();
    const listed = (await listJson("")).body.data.map(labourOf);

    expect(await exportedKeys("")).toEqual(listed);
    expect(listed[0]).toBe("P-001|2026-03-03|5");
    for (const sort of ["labourCount:desc", "contractorName", "villaNumber:desc"]) {
      expect(await exportedKeys(`sort=${sort}`)).toEqual(
        (await listJson(`sort=${sort}`)).body.data.map(labourOf),
      );
    }
  });

  it.each([
    ["villaId", () => `villaId=${villa.id}`],
    ["contractorId", () => `contractorId=${delta.id}`],
    ["labourFrom/labourTo", () => "labourFrom=2026-03-02&labourTo=2026-03-02"],
    ["search", () => "search=steel"],
    ["search over the notes", () => "search=100%25_"],
    ["search over the contractor", () => "search=delta"],
  ])("takes the list's %s filter, and exports what the list shows", async (_name, query) => {
    seed();
    const listed = (await listJson(query())).body.data.map(labourOf);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(3);
    expect(await exportedKeys(query())).toEqual(listed);
  });

  it("reads the same filters into a PDF, and says which were applied", async () => {
    seed();
    const res = await download(
      `/daily-labour/export?format=pdf&contractorId=${delta.id}&labourFrom=2026-03-01`,
    );

    expect(res.status).toBe(200);
    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Daily Labour");
    expect(text).toContain("Labour from:");

    const bounded = await download(`/daily-labour/export?format=pdf&labourTo=2026-03-31`);
    expect((await readPdf(bounded.body)).pages.flat().join(" ")).toContain("Labour to:");
    expect(text).toContain("Formwork");
    expect(text).not.toContain("Excavation");
  });

  it("gives every column a width of its own, wide enough for the longest cell", async () => {
    seed();
    addDailyLabour({
      villaId: other.id,
      contractorId: delta.id,
      labourDate: day("2026-04-01"),
      notes: "Install the main distribution board and the feeders to every floor",
    });
    const sheet = await sheetOf(await download("/daily-labour/export?format=xlsx"));

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
    const sheet = await sheetOf(await download("/daily-labour/export?format=xlsx"));

    expect(tableOf(sheet)).toEqual([]);
    expect(sheet.getRow(1).getCell(4).value).toBe("Contractor");
  });

  it("keeps all 500 characters of the notes in the spreadsheet", async () => {
    addDailyLabour({
      villaId: villa.id,
      contractorId: nile.id,
      labourDate: day("2026-03-01"),
      notes: `${"n".repeat(49)} `.repeat(10).slice(0, 500),
    });

    const rows = tableOf(await sheetOf(await download("/daily-labour/export?format=xlsx")));

    expect(String(rows[0]!["Notes"])).toHaveLength(500);
  });
});

describe("GET /daily-labour/export: the request", () => {
  it.each([
    ["no format", ""],
    ["a format that does not exist", "format=csv"],
    ["a page", "format=xlsx&page=1"],
    ["a limit", "format=xlsx&limit=5"],
    ["a sort that does not exist", "format=xlsx&sort=bogus"],
    ["a villa id that is not an id", "format=xlsx&villaId=7"],
    ["a contractor id that is not an id", "format=xlsx&contractorId=7"],
    ["an inverted range", "format=xlsx&labourFrom=2026-10-06&labourTo=2026-10-05"],
  ])("refuses %s with 400, in Arabic", async (_name, query) => {
    const res = await download(`/daily-labour/export?${query}`, admin, "ar");

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE before generating anything, in Arabic", async () => {
    vi.spyOn(DailyLabourService.prototype, "list").mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 1000, total: 10_001, totalPages: 11 },
    });

    const res = await download("/daily-labour/export?format=xlsx", admin, "ar");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(exportAudits()).toHaveLength(0);
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    for (let n = 0; n < 10_000; n++) {
      addDailyLabour({ villaId: villa.id, contractorId: nile.id, notes: `Note ${n}` });
    }

    const res = await download("/daily-labour/export?format=xlsx");

    const rows = tableOf(await sheetOf(res));
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => row["Notes"])).size, "every page is a different page").toBe(10_000);
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  }, 120_000);
});

describe("GET /daily-labour/export: the audit entry and the allowance", () => {
  it("writes one export.daily-labour entry on DailyLabour with the filters, the format and the count, never the rows", async () => {
    seed();

    await download(`/daily-labour/export?format=xlsx&contractorId=${delta.id}`, admin);

    expect(exportAudits()).toHaveLength(1);
    const [entry] = exportAudits() as { actorId: string; entity: string; after: Record<string, unknown> }[];
    expect(entry).toMatchObject({
      actorId: admin.id,
      entity: "DailyLabour",
      after: { format: "xlsx", filters: expect.objectContaining({ contractorId: delta.id }), rowCount: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain("Formwork");
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/daily-labour/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("shares the export allowance of the user, and counts the daily labour export in it", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "daily-labour:export");

    expect((await download("/daily-labour/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/daily-labour/export?format=xlsx", user)).status).toBe(200);
    const third = await download("/daily-labour/export?format=xlsx", user);

    expect(third.status).toBe(429);
  });

  it("names the file after the export", async () => {
    const res = await download("/daily-labour/export?format=xlsx");

    expect(res.headers["content-disposition"]).toMatch(/elecico-daily-labour-\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  it("exports nothing it does not have: the table is untouched by an export", async () => {
    seed();

    await download("/daily-labour/export?format=xlsx");

    expect(dailyLabourTables.rows).toHaveLength(3);
  });
});
