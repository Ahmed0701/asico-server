import http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addPhase,
  addStartingPhases,
  phaseTables,
  type StoredPhase,
} from "../elec-phases/in-memory-elec-phases.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { addWorkItem, workItemTables } from "./in-memory-open-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/open-works/repository/open-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/open-works/repository/open-works.repository.js")
  >()),
  OpenWorksRepository: (await import("./in-memory-open-works.repository.js")).InMemoryOpenWorksRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { OpenWorksService } from "../../../src/modules/open-works/service/open-works.service.js";

const app = createApp();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let villa: StoredVilla;
let other: StoredVilla;
let phases: StoredPhase[];
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  workItemTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  phases = addStartingPhases();
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
    .get(`/api/v1/open-works?limit=100${query ? `&${query}` : ""}`)
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
// An open work has no title: the tests tell the rows apart by the name of the electrical phase.
const exportedTitles = async (query: string): Promise<string[]> =>
  tableOf(await sheetOf(await download(`/open-works/export?format=xlsx${query ? `&${query}` : ""}`))).map(
    (row) => String(row["Electrical Phase"]),
  );
const phaseNameOf = (item: { elecPhase: { name: string } }): string => item.elecPhase.name;
const exportAudits = () =>
  (store.auditRows as unknown as Record<string, unknown>[]).filter(
    (row) => row["action"] === "export.open-works",
  );

function seed() {
  addWorkItem({
    villaId: villa.id,
    elecPhaseId: phases[4]!.id,
    status: "IN_PROGRESS",
    progress: 40,
    priority: "HIGH",
    contractorId: nile.id,
    startDate: day("2020-01-01"),
    endDate: day("2020-02-01"),
  });
  addWorkItem({
    villaId: villa.id,
    elecPhaseId: phases[5]!.id,
    status: "DONE",
    progress: 100,
    priority: "LOW",
    endDate: day("2020-01-02"),
  });
  addWorkItem({
    villaId: other.id,
    elecPhaseId: phases[0]!.id,
    status: "DELAYED",
    progress: 60,
    contractorId: delta.id,
    startDate: day("2026-03-05"),
    endDate: day("2099-01-01"),
  });
  addWorkItem({ villaId: other.id, elecPhaseId: phases[1]!.id });
}

describe("GET /open-works/export: access", () => {
  it("requires authentication (401)", async () => {
    expect((await request(app).get("/api/v1/open-works/export?format=xlsx")).status).toBe(401);
  });

  it("answers 403 to an employee with no permissions, in Arabic", async () => {
    const res = await download("/open-works/export?format=xlsx", employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("is opened by open-works:export alone: read and import do not open it, and it does not open the list", async () => {
    const others = employee("o@example.test", "open-works:read", "open-works:import", "villas:export");
    expect((await download("/open-works/export?format=xlsx", others)).status).toBe(403);

    const exporter = employee("x@example.test", "open-works:export");
    expect((await download("/open-works/export?format=xlsx", exporter)).status).toBe(200);
    expect((await download("/open-works/export?format=pdf", exporter)).status).toBe(200);
    const list = await request(app)
      .get("/api/v1/open-works")
      .set(await as(exporter));
    expect(list.status).toBe(403);
  });

  it("is not read as an item id: /open-works/export never reaches /open-works/:id", async () => {
    const res = await download("/open-works/export?format=xlsx");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});

describe("GET /open-works/export: the file", () => {
  it("has these columns, in this order, and nothing else", async () => {
    seed();
    const sheet = await sheetOf(await download("/open-works/export?format=xlsx"));

    expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
      "Villa Number",
      "Electrical Phase",
      "Status",
      "Priority",
      "Progress",
      "Contractor",
      "Start Date",
      "End Date",
      "Location",
      "Overdue",
    ]);
    expect(sheet.name).toBe("Open Works");
  });

  it("writes each row in English words, whatever the language of the request", async () => {
    seed();
    const sheet = await sheetOf(
      await download("/open-works/export?format=xlsx&sort=elecPhaseName", admin, "ar"),
    );
    const rows = tableOf(sheet);

    const cable = rows.find((row) => row["Electrical Phase"] === phases[4]!.name)!;
    expect(cable).toMatchObject({
      "Villa Number": "P-001",
      Status: "In progress",
      Priority: "High",
      Progress: 40,
      Contractor: "Nile Builders",
      Overdue: "Yes",
    });
    expect(String(cable["Location"])).toContain("New Cairo");
    expect((cable["Start Date"] as Date).toISOString().slice(0, 10)).toBe("2020-01-01");
    expect((cable["End Date"] as Date).toISOString().slice(0, 10)).toBe("2020-02-01");

    const panel = rows.find((row) => row["Electrical Phase"] === phases[5]!.name)!;
    expect(panel).toMatchObject({
      Status: "Done",
      Priority: "Low",
      Progress: 100,
      Contractor: null,
      Overdue: "No",
      "Start Date": null,
    });

    const delayed = rows.find((row) => row["Electrical Phase"] === phases[0]!.name)!;
    expect(delayed).toMatchObject({
      "Electrical Phase": phases[0]!.name,
      Status: "Delayed",
      Progress: 60,
      Overdue: "No",
    });
    const untouched = rows.find((row) => row["Electrical Phase"] === phases[1]!.name)!;
    expect(untouched).toMatchObject({ Status: "Not started", Progress: 0 });
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("Source");
      expect(Object.keys(row)).not.toContain("Title");
      expect(Object.keys(row)).not.toContain("Work Phase");
    }
  });

  it("lists the rows in the order of the list (location by default, or the sort asked for)", async () => {
    seed();
    const listed = (await listJson("")).body.data.map(phaseNameOf);

    expect(await exportedTitles("")).toEqual(listed);
    expect(await exportedTitles("sort=elecPhaseName:desc")).toEqual(
      (await listJson("sort=elecPhaseName:desc")).body.data.map(phaseNameOf),
    );
  });

  it.each([
    ["villaId", () => `villaId=${villa.id}`],
    ["elecPhaseId", () => `elecPhaseId=${phases[0]!.id}`],
    ["status", () => "status=DELAYED"],
    ["priority", () => "priority=HIGH"],
    ["contractorId", () => `contractorId=${delta.id}`],
    ["startFrom/startTo", () => "startFrom=2020-01-01&startTo=2020-01-01"],
    ["endFrom/endTo", () => "endFrom=2020-01-02&endTo=2020-02-01"],
    ["overdue=true", () => "overdue=true"],
    ["overdue=false", () => "overdue=false"],
    ["search", () => "search=sleeves"],
  ])("takes the list's %s filter, and exports what the list shows", async (_name, query) => {
    seed();
    const listed = (await listJson(query())).body.data.map(phaseNameOf);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(4);
    expect(await exportedTitles(query())).toEqual(listed);
  });

  it("reads the same filters into a PDF, and says which were applied", async () => {
    seed();
    const res = await download("/open-works/export?format=pdf&status=DONE&priority=LOW&overdue=false");

    expect(res.status).toBe(200);
    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Open Works");
    expect(text).toContain("Status: Done");
    expect(text).toContain("Priority: Low");
    expect(text).toContain("Overdue: No");
    expect(text).toContain(phases[5]!.name);
    expect(text).not.toContain(phases[4]!.name);
  });

  it("gives every column a width of its own, wide enough for the longest cell", async () => {
    seed();
    const long = addPhase({ name: "Install the main distribution board and the feeders to every floor" });
    addWorkItem({ villaId: villa.id, elecPhaseId: long.id });
    const sheet = await sheetOf(await download("/open-works/export?format=xlsx"));

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
    const sheet = await sheetOf(await download("/open-works/export?format=xlsx"));

    expect(tableOf(sheet)).toEqual([]);
    expect(sheet.getRow(1).getCell(2).value).toBe("Electrical Phase");
  });
});

describe("GET /open-works/export: the request", () => {
  it.each([
    ["no format", ""],
    ["a format that does not exist", "format=csv"],
    ["a page", "format=xlsx&page=1"],
    ["a limit", "format=xlsx&limit=5"],
    ["a status that does not exist", "format=xlsx&status=LATE"],
    ["a sort that does not exist", "format=xlsx&sort=bogus"],
    ["a villa id that is not an id", "format=xlsx&villaId=7"],
    ["an inverted range", "format=xlsx&startFrom=2026-10-06&startTo=2026-10-05"],
    ["overdue that is not true or false", "format=xlsx&overdue=1"],
  ])("refuses %s with 400, in Arabic", async (_name, query) => {
    const res = await download(`/open-works/export?${query}`, admin, "ar");

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE before generating anything, in Arabic", async () => {
    vi.spyOn(OpenWorksService.prototype, "list").mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 1000, total: 10_001, totalPages: 11 },
    });

    const res = await download("/open-works/export?format=xlsx", admin, "ar");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(exportAudits()).toHaveLength(0);
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    for (let n = 0; n < 10_000; n++) {
      addWorkItem({
        villaId: villa.id,
        elecPhaseId: phases[0]!.id,
        startDate: new Date(Date.UTC(1990, 0, 1 + n)),
      });
    }

    const res = await download("/open-works/export?format=xlsx");

    const rows = tableOf(await sheetOf(res));
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((row) => String(row["Start Date"]))).size, "every page is a different page").toBe(
      10_000,
    );
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  }, 120_000);
});

describe("GET /open-works/export: the audit entry and the allowance", () => {
  it("writes one export.open-works entry on WorkItem with the filters, the format and the count, never the rows", async () => {
    seed();

    await download("/open-works/export?format=xlsx&status=DONE", admin);

    expect(exportAudits()).toHaveLength(1);
    const [entry] = exportAudits() as { actorId: string; entity: string; after: Record<string, unknown> }[];
    expect(entry).toMatchObject({
      actorId: admin.id,
      entity: "WorkItem",
      after: { format: "xlsx", filters: expect.objectContaining({ status: "DONE" }), rowCount: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain("Panel");
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/open-works/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("shares the export allowance of the user, and counts the open works export in it", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "open-works:export");

    expect((await download("/open-works/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/open-works/export?format=xlsx", user)).status).toBe(200);
    const third = await download("/open-works/export?format=xlsx", user);

    expect(third.status).toBe(429);
  });
});
