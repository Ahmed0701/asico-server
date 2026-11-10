import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, withColumns } from "../../shared/import/xlsx-fixtures.js";
import {
  addSiteReport,
  InMemorySiteReportsRepository,
  siteReportRaces,
  siteReportTables,
} from "./in-memory-site-reports.repository.js";

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
vi.mock("../../../src/core/imports/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/imports/repository.js")>()),
  ImportBatchRepository: (await import("../imports/in-memory-import-batch.repository.js"))
    .InMemoryImportBatchRepository,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { IMPORT_TRANSACTION_TIMEOUT_MS } from "../../../src/core/imports/index.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// The cells of a row are named by short keys here; the file has the real headers.
const KEYS = [
  "villa",
  "title",
  "visitDate",
  "inspector",
  "type",
  "rating",
  "findings",
  "recommendations",
] as const;
type Header = (typeof KEYS)[number];
const TITLE: Record<Header, string> = {
  villa: "Villa Number",
  title: "Title",
  visitDate: "Visit Date",
  inspector: "Inspector",
  type: "Type",
  rating: "Rating",
  findings: "Findings",
  recommendations: "Recommendations",
};
const HEADER: string[] = KEYS.map((key) => TITLE[key]);
const ARABIC = /[؀-ۿ]/;
const original = { limit: env.IMPORT_RATE_LIMIT_MAX };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const daysFromToday = (offset: number): string =>
  new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let admin: User;
let villa1: StoredVilla;
let villa2: StoredVilla;
let villa3: StoredVilla;

beforeEach(() => {
  store.reset();
  villaTables.reset();
  siteReportRaces.reset();
  siteReportTables.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa1 = addVilla({ id: "villa-c", villaNumber: "P-001" });
  villa2 = addVilla({ id: "villa-b", villaNumber: "P-002" });
  villa3 = addVilla({ id: "villa-a", villaNumber: "P-003" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

// One row of the file, from the cells it names (the others are empty).
const row = (cells: Partial<Record<Header, ExcelJS.CellValue>>): ExcelJS.CellValue[] =>
  KEYS.map((key) => cells[key] ?? null);
const sheet = (...rows: ExcelJS.CellValue[][]): Promise<Buffer> => workbookOf([[...HEADER], ...rows]);
const GOOD = {
  villa: "P-001",
  title: "First fix check",
  visitDate: "2026-03-04",
  inspector: "Eng. Hamdy",
  type: "Inspection",
  rating: 4,
  findings: "Conduits are fixed",
} as const;
const one = (cells: Partial<Record<Header, ExcelJS.CellValue>> = {}): Promise<Buffer> =>
  sheet(row({ ...GOOD, ...cells }));
const newKey = (): string => `key-${randomUUID()}`;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

type UploadOptions = {
  user?: User;
  language?: string;
  key?: string | null;
  query?: string;
  filename?: string;
  field?: string;
};
async function upload(file: Buffer | null, options: UploadOptions = {}) {
  const {
    user = admin,
    language = "en",
    key = newKey(),
    query = "",
    filename = "site-reports.xlsx",
  } = options;
  const req = request(app)
    .post(`/api/v1/site-reports/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "site_report.import");
const created = () => siteReportTables.reports;
const nothingWritten = (): void => {
  expect(created()).toHaveLength(0);
  expect(importBatchTable.rows).toHaveLength(0);
  expect(importAudit()).toHaveLength(0);
};
type ReportError = { row: number; column: string; code: string; message: string; value: unknown };
const errorsOf = (res: request.Response): [number, string, string][] =>
  (res.body.data.errors as ReportError[]).map((error) => [error.row, error.column, error.code]);

describe("access control", () => {
  const endpoints = [
    ["get", "/site-reports/import/template"],
    ["post", "/site-reports/import"],
  ] as const;
  const others = [
    "site-reports:read",
    "site-reports:create",
    "site-reports:update",
    "site-reports:delete",
    "site-reports:export",
    "small-works:import",
    "daily-reports:import",
    "open-works:import",
    "contractors:import",
    "villas:read",
  ];
  const call = (verb: "get" | "post", path: string) => request(app)[verb](`/api/v1${path}`);

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it.each(endpoints)(
    "%s %s answers 403 to an employee with no permissions, in Arabic",
    async (verb, path) => {
      const res = await call(verb, path)
        .set(await as(employee("e@example.test")))
        .set("Accept-Language", "ar");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)("%s %s is not opened by any other permission", async (verb, path) => {
    const res = await call(verb, path).set(await as(employee("e@example.test", ...others)));

    expect(res.status).toBe(403);
  });

  it("does not let site-reports:import open the other site reports routes", async () => {
    const headers = await as(employee("importer@example.test", "site-reports:import"));

    expect((await request(app).get("/api/v1/site-reports").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/site-reports").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/site-reports/export?format=xlsx").set(headers)).status).toBe(403);
  });

  it("lets the holder of site-reports:import use both routes", async () => {
    const user = employee("importer@example.test", "site-reports:import");

    expect(
      (
        await request(app)
          .get("/api/v1/site-reports/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one(), { user })).status).toBe(201);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /site-reports/:id", async () => {
    const res = await request(app)
      .get("/api/v1/site-reports/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /site-reports/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/site-reports/import/template")
      .set(await as(admin))
      .set("Accept-Language", language)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
  const workbookOfTemplate = async (language = "en"): Promise<ExcelJS.Workbook> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await download(language)).body as ExcelJS.Buffer);
    return workbook;
  };

  it("sends an .xlsx file, English whatever the request language, never cached", async () => {
    const res = await download("ar");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="site-reports-import-template.xlsx"',
    );
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, in order", async () => {
    const workbook = await workbookOfTemplate();

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Site reports", "Instructions", "Lists"]);
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, ...HEADER]);
  });

  it("has an example row on a villa that does not exist, so it cannot be imported by mistake", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(1).value).toBe("EX-000");
    expect(data.getRow(2).getCell(5).value).toBe("Inspection");
  });

  it("has a dropdown on the type, fed by the Lists sheet", async () => {
    const workbook = await workbookOfTemplate();
    const data = workbook.worksheets[0]!;
    const lists = workbook.getWorksheet("Lists")!;

    expect(data.getCell("E2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$E$1:$E$4"] });
    expect(lists.getColumn(5).values).toEqual([undefined, "Inspection", "Safety", "Progress", "Quality"]);
  });

  it("explains every column, the rating rule, the day limit and the text limits", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    const all = text.join(" | ");

    for (const header of HEADER) expect(all).toContain(header);
    expect(all).toContain("Import site reports");
    expect(all).toContain("a whole number from 1 to 5");
    expect(all).toContain("Tomorrow is the latest day allowed");
    expect(all).toContain("up to 150 characters");
    expect(all).toContain("up to 100 characters");
    expect(all).toContain("What was found, up to 5,000 characters");
    expect(all).toContain("What should be done, up to 5,000 characters");
  });

  it("says which columns are required: every one but the recommendations", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const required: Record<string, string> = {};
    instructions.eachRow((r) => {
      if (HEADER.includes(r.getCell(1).text as never)) required[r.getCell(1).text] = r.getCell(2).text;
    });

    expect(required).toEqual({
      [TITLE.villa]: "Yes",
      [TITLE.title]: "Yes",
      [TITLE.visitDate]: "Yes",
      [TITLE.inspector]: "Yes",
      [TITLE.type]: "Yes",
      [TITLE.rating]: "Yes",
      [TITLE.findings]: "Yes",
      [TITLE.recommendations]: "No",
    });
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });
});

describe("POST /site-reports/import: a good file", () => {
  it("saves every row in one go: 201, the report, the rows with the importer as creator and null recommendations by default", async () => {
    const res = await upload(
      await sheet(
        row({ ...GOOD, type: "Safety", rating: 2, recommendations: "Tie it down" }),
        row({
          ...GOOD,
          villa: " p-002 ",
          visitDate: day("2026-03-05"),
          title: "  Tile quality ",
          inspector: " Mona ",
          type: "QUALITY",
          rating: "3",
          findings: " Uneven ",
        }),
        row({ ...GOOD, villa: "P-003", type: "progress", rating: 5 }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      ok: true,
      total: 3,
      imported: 3,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    expect(created()).toHaveLength(3);
    const byVilla = (id: string) => created().find((report) => report.villaId === id)!;
    expect(byVilla(villa1.id)).toMatchObject({
      title: "First fix check",
      visitDate: day("2026-03-04"),
      inspector: "Eng. Hamdy",
      type: "SAFETY",
      rating: 2,
      findings: "Conduits are fixed",
      recommendations: "Tie it down",
      createdById: admin.id,
      version: 1,
    });
    expect(byVilla(villa2.id)).toMatchObject({
      title: "Tile quality",
      visitDate: day("2026-03-05"),
      inspector: "Mona",
      type: "QUALITY",
      rating: 3,
      findings: "Uneven",
      recommendations: null,
    });
    expect(byVilla(villa3.id)).toMatchObject({ type: "PROGRESS", rating: 5, recommendations: null });
  });

  it("writes one site_report.import audit entry on SiteReport, with the batch, the count and the ids", async () => {
    const file = await sheet(row({ ...GOOD, title: "A" }), row({ ...GOOD, villa: "P-002", title: "B" }));

    await upload(file);

    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "SiteReport",
      after: { rows: 2, fileHash: sha256(file), createdIds: created().map((report) => report.id) },
    });
    expect(importBatchTable.rows).toMatchObject([{ entity: "SiteReport", rows: 2, userId: admin.id }]);
  });

  it("accepts a type by code or by label, in any case", async () => {
    const res = await sheet(
      row({ ...GOOD, title: "1", type: "INSPECTION" }),
      row({ ...GOOD, title: "2", type: "safety" }),
      row({ ...GOOD, title: "3", type: "Progress" }),
      row({ ...GOOD, title: "4", type: "quality" }),
    ).then((file) => upload(file));

    expect(res.status).toBe(201);
    expect(created().map((report) => report.type)).toEqual(["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"]);
  });

  it("has no natural key: the same villa, day and title may appear twice in the file and again in the table", async () => {
    addSiteReport({
      villaId: villa1.id,
      visitDate: day("2026-03-04"),
      title: "First fix check",
      inspector: "Eng. Hamdy",
    });

    const res = await upload(await sheet(row(GOOD), row(GOOD)));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(3);
  });

  it("takes the days in any order and ignores blank rows between the records", async () => {
    const res = await upload(
      await sheet(
        row({ ...GOOD, visitDate: "2026-03-05", title: "later" }),
        [],
        row({ ...GOOD, visitDate: "2026-03-01", title: "earlier" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
  });

  it("imports a file of 2,000 rows", async () => {
    const rows = Array.from({ length: 2000 }, (_, n) =>
      row({
        ...GOOD,
        visitDate: new Date(Date.UTC(2000, 0, 1 + (n % 300))),
        title: `Visit ${n}`,
        rating: (n % 5) + 1,
      }),
    );

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(2000);
  }, 120_000);

  it("runs in a transaction with the import's time allowance", async () => {
    const spy = vi.spyOn(InMemorySiteReportsRepository.prototype, "transaction");

    await upload(await one());

    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
  });

  it("locks the villas of the file once each, in the order of their ids", async () => {
    // The ids are reversed against the file's order and one villa is used twice.
    const spy = vi.spyOn(InMemorySiteReportsRepository.prototype, "lockVillasShared");

    const res = await upload(
      await sheet(
        row({ ...GOOD, villa: "P-001" }),
        row({ ...GOOD, villa: "P-002" }),
        row({ ...GOOD, villa: "P-001" }),
        row({ ...GOOD, villa: "P-003" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual([villa3.id, villa2.id, villa1.id]);
  });

  it("answers 401 and saves nothing when the importing user cannot be found", async () => {
    vi.spyOn(InMemorySiteReportsRepository.prototype, "userExists").mockResolvedValue(false);

    const res = await upload(await one());

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    nothingWritten();
  });

  it("answers 500, not the changed-data conflict, when the write fails for another reason", async () => {
    vi.spyOn(InMemorySiteReportsRepository.prototype, "createMany").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });
});

describe("POST /site-reports/import: the rating, as a number cell and as a text cell", () => {
  const accepted: [string, number | string, number][] = [
    ["1 as a number", 1, 1],
    ["1 as text", "1", 1],
    ["3 as a number", 3, 3],
    ["3 as text", "3", 3],
    ["5 as a number", 5, 5],
    ["5 as text", " 5 ", 5],
    ["3 written 3.0 in a number cell", 3.0, 3],
  ];
  const refused: [string, number | string][] = [
    ["0 as a number", 0],
    ["0 as text", "0"],
    ["a negative number", -1],
    ["a negative as text", "-1"],
    ["6 as a number", 6],
    ["6 as text", "6"],
    ["a fraction as a number", 2.5],
    ["a fraction as text", "2.5"],
    ["3.0 as text", "3.0"],
    ["a number far above", 1_000_000],
    ["an exponent as text", "1e0"],
    ["words", "good"],
  ];

  it.each(accepted)("accepts %s and stores it", async (_name, rating, stored) => {
    const res = await upload(await one({ rating }));

    expect(res.status).toBe(201);
    expect(created()[0]?.rating).toBe(stored);
  });

  it.each(refused)(
    "refuses %s with 422 on the rating cell, never a 500, and saves nothing",
    async (_name, rating) => {
      const res = await upload(await one({ rating }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.rating, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe("Rating must be a whole number from 1 to 5");
      nothingWritten();
    },
  );

  it("says what is wrong in Arabic, and refuses the same values in a dry run", async () => {
    const file = await one({ rating: 0 });

    const arabic = await upload(file, { language: "ar" });
    const dry = await upload(file, { query: "?dryRun=true" });

    expect(arabic.body.data.errors[0].message).toBe("يجب أن يكون التقييم عددًا صحيحًا من 1 إلى 5");
    expect(dry.status).toBe(200);
    expect(errorsOf(dry)).toEqual([[2, TITLE.rating, "INVALID_VALUE"]]);
  });

  it("reports an empty rating as REQUIRED", async () => {
    const res = await upload(await one({ rating: null }));

    expect(errorsOf(res)).toEqual([[2, TITLE.rating, "REQUIRED"]]);
  });
});

describe("POST /site-reports/import: the text limits are the API's", () => {
  const text = (length: number, letter = "w"): string => letter.repeat(length);

  it("accepts 150 characters of title, 100 of inspector and 5,000 of findings and recommendations, and stores them whole", async () => {
    const res = await upload(
      await one({
        title: text(150),
        inspector: text(100, "n"),
        findings: text(5000, "f"),
        recommendations: text(5000, "r"),
      }),
    );

    expect(res.status).toBe(201);
    expect(created()[0]?.title).toHaveLength(150);
    expect(created()[0]?.inspector).toHaveLength(100);
    expect(created()[0]?.findings).toHaveLength(5000);
    expect(created()[0]?.recommendations).toHaveLength(5000);
  });

  it.each([
    ["title", 151],
    ["inspector", 101],
  ] as const)("refuses %s of %i characters as a row error on its own column", async (header, length) => {
    const res = await upload(await one({ [header]: text(length) }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE[header], "INVALID_VALUE"]]);
    nothingWritten();
  });

  it("explains the title limit in the language of the request", async () => {
    const res = await upload(await one({ title: text(151) }), { language: "ar" });

    expect(res.body.data.errors[0].message).toBe("يجب أن يكون العنوان بين 1 و150 حرفًا");
  });

  it.each([
    ["findings", "G"],
    ["recommendations", "H"],
  ] as const)(
    "refuses a %s cell of 5,001 characters with 422 IMPORT_CELL_TOO_LONG naming the cell and the 5,000 limit, in Arabic too",
    async (header, letter) => {
      const file = await sheet(
        row({ ...GOOD, title: "ok" }),
        row({ ...GOOD, title: "long", [header]: text(5001) }),
      );

      const english = await upload(file);
      const arabic = await upload(file, { language: "ar" });

      expect(english.status).toBe(422);
      expect(english.body.code).toBe("IMPORT_CELL_TOO_LONG");
      expect(english.body.details).toEqual([
        { path: `${letter}3`, message: "A cell holds more than 5,000 characters" },
      ]);
      expect(arabic.body.details).toEqual([
        { path: `${letter}3`, message: "تحتوي إحدى الخلايا على أكثر من 5,000 حرف" },
      ]);
      nothingWritten();
    },
  );

  it("counts Unicode characters of the long texts as the cell does", async () => {
    expect((await upload(await one({ findings: "ش".repeat(5000) }))).status).toBe(201);
    siteReportTables.reset();
    importBatchTable.reset();
    const res = await upload(await one({ findings: "ش".repeat(5001) }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
  });

  it("says so in a dry run too: a cell over its column's limit is refused with the same answer", async () => {
    const res = await upload(await one({ recommendations: text(5001) }), { query: "?dryRun=true" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
  });

  it.each(["villa", "title", "visitDate", "inspector", "type", "rating"] as const)(
    "still refuses a cell of 2,001 characters in %s with the file-level 2,000 message: the default is unchanged",
    async (header) => {
      const res = await upload(await one({ [header]: text(2001) }));

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
      expect(res.body.details).toEqual([
        {
          path: `${String.fromCharCode(65 + KEYS.indexOf(header))}2`,
          message: "A cell holds more than 2,000 characters",
        },
      ]);
      nothingWritten();
    },
  );

  it("takes 2,000 characters in the villa column up to its own rule (a villa number that long is just unknown)", async () => {
    const res = await upload(await one({ villa: text(2000) }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.villa, "REFERENCE_NOT_FOUND"]]);
  });

  it("applies the long limit by the column's header, wherever the column is in the file", async () => {
    const shuffled = [
      "findings",
      "villa",
      "recommendations",
      "title",
      "visitDate",
      "inspector",
      "type",
      "rating",
    ];
    const values: Record<string, ExcelJS.CellValue> = {
      findings: text(5000),
      villa: "P-001",
      recommendations: text(4999),
      title: "Shuffled",
      visitDate: "2026-03-04",
      inspector: "Eng. Hamdy",
      type: "Quality",
      rating: 3,
    };
    const file = await workbookOf([
      shuffled.map((key) => TITLE[key as Header]),
      shuffled.map((key) => values[key] ?? null),
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(created()[0]?.findings).toHaveLength(5000);
    expect(created()[0]?.recommendations).toHaveLength(4999);
  });

  it("counts Unicode characters of the title as the cell does", async () => {
    expect((await upload(await one({ title: "ش".repeat(150) }))).status).toBe(201);
    siteReportTables.reset();
    importBatchTable.reset();
    const res = await upload(await one({ title: "ش".repeat(151) }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.title, "INVALID_VALUE"]]);
  });
});

describe("POST /site-reports/import: a file that was exported", () => {
  it("can be imported again: every column of the export is a column the import reads", async () => {
    const source = [
      addSiteReport({
        villaId: villa1.id,
        visitDate: day("2026-03-01"),
        title: "t".repeat(150),
        inspector: "n".repeat(100),
        type: "SAFETY",
        rating: 1,
        findings: "f".repeat(5000),
        recommendations: "r".repeat(5000),
      }),
      addSiteReport({
        villaId: villa2.id,
        visitDate: day("2026-03-02"),
        title: "Tile quality",
        inspector: "Mona",
        type: "QUALITY",
        rating: 5,
        findings: "Even",
        recommendations: null,
      }),
    ];
    const exported = await request(app)
      .get("/api/v1/site-reports/export?format=xlsx")
      .set(await as(admin))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body as ExcelJS.Buffer);
    const exportedSheet = workbook.worksheets[0]!;
    const titles = (exportedSheet.getRow(1).values as ExcelJS.CellValue[]).slice(1) as string[];
    const cell = (n: number, title: string): ExcelJS.CellValue =>
      (exportedSheet.getRow(n).values as ExcelJS.CellValue[]).slice(1)[titles.indexOf(title)] ?? null;
    // The same cells under the import's headers.
    const rows = [2, 3].map((n) =>
      row({
        villa: cell(n, "Villa Number"),
        title: cell(n, "Title"),
        visitDate: cell(n, "Visit Date"),
        inspector: cell(n, "Inspector"),
        type: cell(n, "Type"),
        rating: cell(n, "Rating"),
        findings: cell(n, "Findings"),
        recommendations: cell(n, "Recommendations"),
      }),
    );
    // The rows are deleted, so the file imports onto an empty table.
    siteReportTables.reset();

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);
    const restored = (id: string) => created().find((report) => report.villaId === id)!;
    expect(restored(villa1.id)).toMatchObject({
      visitDate: source[0]!.visitDate,
      title: source[0]!.title,
      inspector: source[0]!.inspector,
      type: "SAFETY",
      rating: 1,
      findings: source[0]!.findings,
      recommendations: source[0]!.recommendations,
    });
    expect(restored(villa2.id)).toMatchObject({
      title: "Tile quality",
      type: "QUALITY",
      rating: 5,
      recommendations: null,
    });
  });
});

describe("POST /site-reports/import: dry run", () => {
  it("checks the same rules and saves nothing: 200 and the report", async () => {
    const res = await upload(await one(), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: true,
      total: 1,
      imported: 0,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    nothingWritten();
  });

  it("reports the row errors with 200, and the same file can be dry-run again", async () => {
    const file = await one({ type: "Audit" });

    const first = await upload(file, { query: "?dryRun=true" });
    const second = await upload(file, { query: "?dryRun=true" });

    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(false);
    expect(errorsOf(first)).toEqual([[2, TITLE.type, "INVALID_OPTION"]]);
    expect(second.status).toBe(200);
    nothingWritten();
  });

  it("does not stop the real import of the same file afterwards", async () => {
    const file = await one();
    await upload(file, { query: "?dryRun=true" });

    expect((await upload(file)).status).toBe(201);
  });
});

describe("POST /site-reports/import: row errors (422, nothing is saved)", () => {
  it("lists every bad cell of every row, with the row, the column and the code", async () => {
    const res = await upload(
      await sheet(
        row({ ...GOOD, villa: "P-999" }),
        row({ ...GOOD, visitDate: "nope", type: "Cancelled", rating: -1 }),
        row({ ...GOOD, title: null, rating: 1.5 }),
        row({ ...GOOD, inspector: null, findings: null, rating: "many" }),
        row({}),
        row({ villa: "P-001" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.imported).toBe(0);
    expect(errorsOf(res)).toEqual([
      [2, TITLE.villa, "REFERENCE_NOT_FOUND"],
      [3, TITLE.visitDate, "INVALID_VALUE"],
      [3, TITLE.type, "INVALID_OPTION"],
      [3, TITLE.rating, "INVALID_VALUE"],
      [4, TITLE.title, "REQUIRED"],
      [4, TITLE.rating, "INVALID_VALUE"],
      [5, TITLE.inspector, "REQUIRED"],
      [5, TITLE.rating, "INVALID_VALUE"],
      [5, TITLE.findings, "REQUIRED"],
      [7, TITLE.title, "REQUIRED"],
      [7, TITLE.visitDate, "REQUIRED"],
      [7, TITLE.inspector, "REQUIRED"],
      [7, TITLE.type, "REQUIRED"],
      [7, TITLE.rating, "REQUIRED"],
      [7, TITLE.findings, "REQUIRED"],
    ]);
    nothingWritten();
  });

  it("requires the inspector: there is no default", async () => {
    const res = await upload(await one({ inspector: null }));

    expect(errorsOf(res)).toEqual([[2, TITLE.inspector, "REQUIRED"]]);
  });

  it("requires the findings, and not the recommendations", async () => {
    const without = await upload(await one({ findings: null }));
    const with_ = await upload(await one({ recommendations: null, title: "other" }));

    expect(errorsOf(without)).toEqual([[2, TITLE.findings, "REQUIRED"]]);
    expect(with_.status).toBe(201);
  });

  it("refuses a date more than one day past today, and takes tomorrow", async () => {
    const res = await upload(
      await sheet(
        row({ ...GOOD, visitDate: daysFromToday(1), title: "tomorrow" }),
        row({ ...GOOD, visitDate: daysFromToday(2), title: "later" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[3, TITLE.visitDate, "INVALID_VALUE"]]);
    expect(res.body.data.errors[0].message).toBe("The visit date cannot be more than one day after today");
  });

  it("refuses numbers where text is expected", async () => {
    const res = await upload(
      await one({
        title: 12 as unknown as string,
        inspector: 5 as unknown as string,
        findings: 7 as unknown as string,
        recommendations: 9 as unknown as string,
      }),
    );

    expect(errorsOf(res)).toEqual([
      [2, TITLE.title, "NOT_TEXT"],
      [2, TITLE.inspector, "NOT_TEXT"],
      [2, TITLE.findings, "NOT_TEXT"],
      [2, TITLE.recommendations, "NOT_TEXT"],
    ]);
  });

  it("says what is wrong in the language of the request", async () => {
    const res = await upload(await one({ type: "Audit", rating: 0 }), { language: "ar" });

    const messages = (res.body.data.errors as ReportError[]).map((error) => error.message);
    expect(messages).toContain("هذه القيمة ليست من القيم المسموح بها");
    expect(messages).toContain("يجب أن يكون التقييم عددًا صحيحًا من 1 إلى 5");
  });

  it("saves nothing when one row of many is bad", async () => {
    const res = await upload(
      await sheet(
        row({ ...GOOD, title: "1" }),
        row({ ...GOOD, villa: "P-002", title: "2" }),
        row({ ...GOOD, villa: "P-003", title: "3", rating: 0 }),
      ),
    );

    expect(res.status).toBe(422);
    nothingWritten();
  });
});

describe("POST /site-reports/import: the same file twice (the only guard against a double import)", () => {
  it("answers 409 FILE_ALREADY_IMPORTED to a second import of the same file under a new key, and changes nothing", async () => {
    const file = await one();
    expect((await upload(file)).status).toBe(201);

    const second = await upload(file);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("FILE_ALREADY_IMPORTED");
    expect(created()).toHaveLength(1);
    expect(importBatchTable.rows).toHaveLength(1);
    expect(importAudit()).toHaveLength(1);
  });

  it("lets a file with one cell changed through, even when every other row is the same", async () => {
    expect((await upload(await one())).status).toBe(201);

    const changed = await upload(await one({ rating: 5 }));

    expect(changed.status).toBe(201);
    expect(created()).toHaveLength(2);
  });

  it("replays the first answer for the same Idempotency-Key", async () => {
    const file = await one();
    const key = newKey();

    const first = await upload(file, { key });
    const again = await upload(file, { key });

    expect(again.status).toBe(first.status);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(created()).toHaveLength(1);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await upload(await one(), { key: null });

    expect(res.status).toBe(400);
    nothingWritten();
  });
});

describe("POST /site-reports/import: a villa goes away during the import", () => {
  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when the villa went away after the check", async () => {
    siteReportRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa2.id);
    };

    const res = await upload(
      await sheet(row({ ...GOOD, title: "a" }), row({ ...GOOD, villa: "P-002", title: "b" })),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("is not thrown by a villa the file does not use going away", async () => {
    siteReportRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa3.id);
    };

    const res = await upload(await one());

    expect(res.status).toBe(201);
  });
});

describe("POST /site-reports/import: the request", () => {
  it("answers 400 NO_FILE_PROVIDED without a file", async () => {
    const res = await upload(null);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 415 to a file that is not .xlsx", async () => {
    const res = await upload(await one(), { filename: "site-reports.csv" });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 IMPORT_HEADER_MISMATCH when a column is missing, unknown or repeated", async () => {
    const missing = await upload(
      await workbookOf([
        ["villa", "title"],
        ["P-001", "x"],
      ]),
    );
    const unknown = await upload(
      await workbookOf([
        [...HEADER, "extra"],
        [...row({ villa: "P-001" }), "x"],
      ]),
    );
    const repeated = await upload(
      await workbookOf([
        [...HEADER, TITLE.villa],
        [...row({ villa: "P-001" }), "x"],
      ]),
    );
    const contractor = await upload(
      await workbookOf([
        [...HEADER, "Contractor"],
        [...row({ villa: "P-001" }), "x"],
      ]),
    );

    for (const res of [missing, unknown, repeated, contractor]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("IMPORT_HEADER_MISMATCH");
    }
    nothingWritten();
  });

  it("answers 422 to a header with no rows, and to more than 2,000 data rows", async () => {
    const empty = await upload(await sheet());
    const tall = await upload(
      await sheet(
        ...Array.from({ length: 2001 }, (_, n) =>
          row({ ...GOOD, visitDate: new Date(Date.UTC(2000, 0, 1 + n)), title: "x" }),
        ),
      ),
    );

    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe("IMPORT_NO_ROWS");
    expect(tall.status).toBe(422);
    expect(tall.body.code).toBe("IMPORT_TOO_MANY_ROWS");
    nothingWritten();
  }, 120_000);

  it.each(["?dryRun=yes", "?dryRun=1", "?dryRun=TRUE", "?extra=1"])(
    "refuses the query %s with 400",
    async (query) => {
      const res = await upload(await one(), { query });

      expect(res.status).toBe(400);
    },
  );

  it("shares the import allowance of the user", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "site-reports:import");

    expect((await upload(await one({ title: "a" }), { user })).status).toBe(201);
    expect((await upload(await one({ title: "b" }), { user })).status).toBe(201);
    const third = await upload(await one({ title: "c" }), { user });

    expect(third.status).toBe(429);
  });

  it("counts the template against the same allowance", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("template@example.test", "site-reports:import");

    const first = await request(app)
      .get("/api/v1/site-reports/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/site-reports/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });

  it("answers 422 when the Idempotency-Key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({ title: "First" }), { key });
    const other = await upload(await one({ title: "Second" }), { key });

    const dryKey = newKey();
    const file = await one({ title: "Third" });
    await upload(file, { key: dryKey, query: "?dryRun=true" });
    const real = await upload(file, { key: dryKey });

    expect([other.status, other.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect([real.status, real.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect(created()).toHaveLength(1);
  });

  it("saves nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    expect(created()).toHaveLength(0);
  });
});

describe("POST /site-reports/import: a file that was exported", () => {
  it("takes the Location column the export adds, ignores whatever it holds, and saves the rows as without it", async () => {
    const res = await upload(await withColumns(await one(), { Location: "P-001, B1, 7" }));

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      ok: true,
      total: 1,
      imported: 1,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    expect(created()).toHaveLength(1);
  });

  it("does not read the Location cell: an empty one, a number and a long text are all fine", async () => {
    for (const location of [null, 42, "x".repeat(1500)]) {
      const res = await upload(await withColumns(await one(), { Location: location }), {
        query: "?dryRun=true",
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ ok: true, total: 1, skipped: 0, errors: [] });
    }
  });

  it("refuses a column that is in neither list, even next to Location", async () => {
    const res = await upload(await withColumns(await one(), { Location: "P-001", Region: "Giza" }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "IMPORT_HEADER_MISMATCH" });
    expect(res.body.details).toEqual([
      { path: "Region", message: "This column is not part of the template" },
    ]);
    nothingWritten();
  });

  it("refuses the Location column twice", async () => {
    const res = await upload(
      await withColumns(await withColumns(await one(), { Location: "a" }), { Location: "b" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "Location", message: "This column appears more than once in the header row" },
    ]);
    nothingWritten();
  });
});

describe("GET /site-reports/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/site-reports/import/template")
      .set(await as(admin))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (chunk: Buffer) => chunks.push(chunk));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as ExcelJS.Buffer);
    return workbook;
  };

  it("has a dropdown on the villa, the type and the rating from 1 to 5, and on no other column", async () => {
    expect(dropdownsOf(await template())).toEqual({
      "Villa Number": ["P-001", "P-002", "P-003"],
      Type: ["Inspection", "Safety", "Progress", "Quality"],
      Rating: ["1", "2", "3", "4", "5"],
    });
  });

  it("offers only values the import accepts: a file with every choice, one per row, is good", async () => {
    const choices = dropdownsOf(await template());
    const rows = Array.from({ length: 5 }, (_, at) =>
      row({
        ...GOOD,
        villa: choices["Villa Number"]![at % choices["Villa Number"]!.length],
        title: `Visit ${at}`,
        type: choices.Type![at % choices.Type!.length],
        // The rating is the text the dropdown puts in the cell.
        rating: choices.Rating![at],
      }),
    );
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res)).toEqual([]);
    expect(res.body.data).toMatchObject({ ok: true, total: 5 });
  });

  it("imports a filled-in template with the Lists sheet still in it", async () => {
    const bytes = await filledTemplate(await template(), [
      "P-002",
      "First fix check",
      "2026-03-04",
      "Eng. Hamdy",
      "Safety",
      "5",
      "Conduits are fixed",
    ]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ villaId: villa2.id, rating: 5 });
  });
});
