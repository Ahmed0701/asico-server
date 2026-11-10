import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, withColumns } from "../../shared/import/xlsx-fixtures.js";
import {
  addDailyReport,
  dailyReportRaces,
  dailyReportTables,
  InMemoryDailyReportsRepository,
} from "./in-memory-daily-reports.repository.js";

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
const KEYS = ["reportDate", "contractor", "engineer", "weather", "workersCount", "notes"] as const;
type Header = (typeof KEYS)[number];
const TITLE: Record<Header, string> = {
  reportDate: "Report Date",
  contractor: "Contractor",
  engineer: "Electrical Engineer",
  weather: "Weather",
  workersCount: "Workers",
  notes: "Notes",
};
const HEADER: string[] = KEYS.map((key) => TITLE[key]);
const ARABIC = /[؀-ۿ]/;
const original = { limit: env.IMPORT_RATE_LIMIT_MAX };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const daysFromToday = (offset: number): string =>
  new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  nile = addContractor({ name: "Nile Builders", phone: "0100 111 2222" });
  delta = addContractor({ name: "Delta Works", phone: "0111 333 4444" });
  mona = addElectricalEngineer({ name: "Mona Hassan", phone: "0100 999 0001" });
  karim = addElectricalEngineer({ name: "Karim Adel", phone: "0100 999 0002" });
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
const FULL: Record<Header, ExcelJS.CellValue> = {
  reportDate: "2026-03-04",
  contractor: "Nile Builders",
  engineer: "Mona Hassan",
  weather: "Sunny",
  workersCount: 25,
  notes: null,
};
// A key given as null is an empty cell; a key not given is the valid default. Pass `{}` for a whole valid row.
const row = (cells: Partial<Record<Header, ExcelJS.CellValue>>): ExcelJS.CellValue[] =>
  KEYS.map((key) => (key in cells ? cells[key]! : FULL[key]));
const sheet = (...rows: ExcelJS.CellValue[][]): Promise<Buffer> => workbookOf([[...HEADER], ...rows]);
const one = (cells: Partial<Record<Header, ExcelJS.CellValue>> = {}): Promise<Buffer> => sheet(row(cells));
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
    filename = "daily-reports.xlsx",
  } = options;
  const req = request(app)
    .post(`/api/v1/daily-reports/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "daily_report.import");
const created = () => dailyReportTables.reports;
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
    ["get", "/daily-reports/import/template"],
    ["post", "/daily-reports/import"],
  ] as const;
  const others = [
    "daily-reports:read",
    "daily-reports:create",
    "daily-reports:update",
    "daily-reports:delete",
    "daily-reports:export",
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

  it("does not let daily-reports:import open the other daily reports routes", async () => {
    const headers = await as(employee("importer@example.test", "daily-reports:import"));

    expect((await request(app).get("/api/v1/daily-reports").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/daily-reports").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/daily-reports/export?format=xlsx").set(headers)).status).toBe(
      403,
    );
  });

  it("lets the holder of daily-reports:import use both routes", async () => {
    const user = employee("importer@example.test", "daily-reports:import");

    expect(
      (
        await request(app)
          .get("/api/v1/daily-reports/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one(), { user })).status).toBe(201);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /daily-reports/:id", async () => {
    const res = await request(app)
      .get("/api/v1/daily-reports/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /daily-reports/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/daily-reports/import/template")
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
      'attachment; filename="daily-reports-import-template.xlsx"',
    );
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, in order: no villa, no work done, no issues, no prepared by", async () => {
    const workbook = await workbookOfTemplate();

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Daily reports", "Instructions", "Lists"]);
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, ...HEADER]);
    expect(HEADER).toEqual([
      "Report Date",
      "Contractor",
      "Electrical Engineer",
      "Weather",
      "Workers",
      "Notes",
    ]);
  });

  it("has an example row on a contractor and an engineer that do not exist, so it cannot be imported by mistake", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(2).value).toBe("Example Contracting Co.");
    expect(data.getRow(2).getCell(3).value).toBe("Example Engineer");
    expect(data.getRow(2).getCell(4).value).toBe("Sunny");
  });

  it("explains every column, the one-report-per-contractor-day rule, the day limit and both cell limits", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    const all = text.join(" | ");

    for (const header of HEADER) expect(all).toContain(header);
    expect(all).toContain("A contractor has one report per day");
    expect(all).toContain("Tomorrow is the latest day allowed");
    expect(all).toContain("A cell holds up to 2,000 characters (a long-text column says how many more)");
    expect(all).toContain("up to 5,000 characters");
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });
});

describe("POST /daily-reports/import: a good file", () => {
  it("saves every row in one go: 201, the reports with the importer as creator", async () => {
    const res = await upload(
      await sheet(
        row({
          reportDate: "2026-03-04",
          contractor: "Nile Builders",
          engineer: "Mona Hassan",
          weather: "Sunny",
          workersCount: 25,
          notes: "Late cement",
        }),
        row({
          reportDate: day("2026-03-05"),
          contractor: " delta works ",
          engineer: "karim adel",
          weather: "rainy",
          workersCount: "0",
        }),
        row({
          reportDate: "2026-03-04",
          contractor: "Delta Works",
          engineer: "Mona Hassan",
          weather: "DUSTY",
          workersCount: 100000,
          notes: "  Trimmed  ",
        }),
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
    const of = (contractorId: string, date: string) =>
      created().find(
        (report) =>
          report.contractorId === contractorId && report.reportDate.getTime() === day(date).getTime(),
      )!;
    expect(of(nile.id, "2026-03-04")).toMatchObject({
      preparedByEngineerId: mona.id,
      weather: "SUNNY",
      workersCount: 25,
      notes: "Late cement",
      createdById: admin.id,
      version: 1,
    });
    expect(of(delta.id, "2026-03-05")).toMatchObject({
      preparedByEngineerId: karim.id,
      weather: "RAINY",
      workersCount: 0,
      notes: null,
    });
    expect(of(delta.id, "2026-03-04")).toMatchObject({
      weather: "DUSTY",
      workersCount: 100000,
      notes: "Trimmed",
    });
  });

  it("writes one daily_report.import audit entry on DailyReport, with the batch, the count and the ids", async () => {
    const file = await sheet(
      row({ contractor: "Nile Builders", reportDate: "2026-03-04" }),
      row({ contractor: "Delta Works", reportDate: "2026-03-04" }),
    );

    await upload(file);

    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "DailyReport",
      after: { rows: 2, fileHash: sha256(file), createdIds: created().map((report) => report.id) },
    });
    expect(importBatchTable.rows).toMatchObject([{ entity: "DailyReport", rows: 2, userId: admin.id }]);
  });

  it("accepts a weather by code or by label, in any case", async () => {
    const res = await upload(
      await sheet(
        row({ reportDate: "2026-03-01", weather: "HOT" }),
        row({ reportDate: "2026-03-02", weather: "windy" }),
        row({ reportDate: "2026-03-03", weather: "Dusty" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(created().map((report) => report.weather)).toEqual(["HOT", "WINDY", "DUSTY"]);
  });

  it("finds the contractor and the engineer by name or by phone, in any case", async () => {
    const res = await upload(
      await sheet(
        row({ reportDate: "2026-03-01", contractor: "NILE builders", engineer: "MONA hassan" }),
        row({ reportDate: "2026-03-02", contractor: "0100-111-2222", engineer: "0100-999-0001" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(created().map((report) => [report.contractorId, report.preparedByEngineerId])).toEqual([
      [nile.id, mona.id],
      [nile.id, mona.id],
    ]);
  });

  it("takes any active contractor: it needs no villa", async () => {
    const lone = addContractor({ name: "Lone Contractor", phone: "0100 555 0000" });

    const res = await upload(await one({ contractor: "Lone Contractor" }));

    expect(res.status).toBe(201);
    expect(created()[0]?.contractorId).toBe(lone.id);
  });

  it("takes the days in any order and ignores blank rows between the records", async () => {
    const res = await upload(
      await sheet(row({ reportDate: "2026-03-05" }), [], row({ reportDate: "2026-03-01" })),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
  });

  it("imports a file of 2,000 rows", async () => {
    const rows = Array.from({ length: 2000 }, (_, n) =>
      row({ reportDate: new Date(Date.UTC(2000, 0, 1 + n)), workersCount: n }),
    );

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(2000);
  }, 120_000);

  it("runs in a transaction with the import's time allowance", async () => {
    const spy = vi.spyOn(InMemoryDailyReportsRepository.prototype, "transaction");

    await upload(await one());

    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
  });

  it("locks the contractors, then the engineers, of the file once each, in the order of their ids", async () => {
    const contractorLock = vi.spyOn(InMemoryDailyReportsRepository.prototype, "lockContractorsShared");
    const engineerLock = vi.spyOn(InMemoryDailyReportsRepository.prototype, "lockEngineersShared");

    const res = await upload(
      await sheet(
        row({ contractor: "Nile Builders", engineer: "Mona Hassan", reportDate: "2026-03-04" }),
        row({ contractor: "Delta Works", engineer: "Karim Adel", reportDate: "2026-03-04" }),
        row({ contractor: "Nile Builders", engineer: "Mona Hassan", reportDate: "2026-03-05" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(contractorLock).toHaveBeenCalledTimes(1);
    expect(engineerLock).toHaveBeenCalledTimes(1);
    expect(contractorLock.mock.calls[0]![0]).toEqual([nile.id, delta.id].sort());
    expect(engineerLock.mock.calls[0]![0]).toEqual([mona.id, karim.id].sort());
    expect(contractorLock.mock.invocationCallOrder[0]!).toBeLessThan(
      engineerLock.mock.invocationCallOrder[0]!,
    );
  });

  it("answers 401 and saves nothing when the importing user is gone", async () => {
    vi.spyOn(InMemoryDailyReportsRepository.prototype, "userExists").mockResolvedValue(false);

    const res = await upload(await one());

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    nothingWritten();
  });

  it("answers 500, not the changed-data conflict, when the write fails for another reason", async () => {
    vi.spyOn(InMemoryDailyReportsRepository.prototype, "createMany").mockRejectedValue(
      new Error("disk full"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });
});

describe("POST /daily-reports/import: the text limits", () => {
  const text = (length: number, letter = "n"): string => letter.repeat(length);

  it("accepts 5,000 characters in the notes, as the API does, and stores them whole", async () => {
    const res = await upload(await one({ notes: text(5000) }));

    expect(res.status).toBe(201);
    expect(created()[0]?.notes).toHaveLength(5000);
  });

  it("refuses notes of 5,001 characters with 422 IMPORT_CELL_TOO_LONG naming the cell and the 5,000 limit, in Arabic too", async () => {
    const file = await sheet(
      row({ reportDate: "2026-03-01", notes: "ok" }),
      row({ reportDate: "2026-03-02", notes: text(5001) }),
    );

    const english = await upload(file);
    const arabic = await upload(file, { language: "ar" });

    expect(english.status).toBe(422);
    expect(english.body.code).toBe("IMPORT_CELL_TOO_LONG");
    expect(english.body.details).toEqual([
      { path: "F3", message: "A cell holds more than 5,000 characters" },
    ]);
    expect(arabic.body.details).toEqual([
      { path: "F3", message: "تحتوي إحدى الخلايا على أكثر من 5,000 حرف" },
    ]);
    nothingWritten();
  });

  it.each(["reportDate", "contractor", "engineer", "weather", "workersCount"] as const)(
    "still refuses a cell of 2,001 characters in %s, with the 2,000 message: the default is unchanged",
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

  it("applies the long limit by the column's header, wherever the column is in the file", async () => {
    const shuffled = ["notes", "weather", "reportDate", "workersCount", "engineer", "contractor"] as const;
    const values: Record<string, ExcelJS.CellValue> = {
      notes: text(5000),
      weather: "Sunny",
      reportDate: "2026-03-04",
      workersCount: 3,
      engineer: "Mona Hassan",
      contractor: "Nile Builders",
    };
    const file = await workbookOf([
      shuffled.map((key) => TITLE[key]),
      shuffled.map((key) => values[key] ?? null),
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(created()[0]?.notes).toHaveLength(5000);
  });

  it("counts characters as the cell does for a Unicode text, in a dry run too", async () => {
    const res = await upload(await one({ notes: "ش".repeat(5001) }), { query: "?dryRun=true" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
  });
});

describe("POST /daily-reports/import: a file that was exported", () => {
  it("can be imported again: every column of the export is a column the import reads", async () => {
    const source = [
      addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: mona.id,
        reportDate: day("2026-03-01"),
        weather: "HOT",
        workersCount: 30,
        notes: "n".repeat(5000),
      }),
      addDailyReport({
        contractorId: delta.id,
        preparedByEngineerId: karim.id,
        reportDate: day("2026-03-02"),
        weather: "RAINY",
        workersCount: 0,
        notes: null,
      }),
    ];
    const exported = await request(app)
      .get("/api/v1/daily-reports/export?format=xlsx")
      .set(await as(admin))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    // The reports are deleted, so the file imports onto empty days.
    dailyReportTables.reset();

    const res = await upload(exported.body as Buffer);

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);
    const restored = (id: string) => created().find((report) => report.contractorId === id)!;
    expect(restored(nile.id)).toMatchObject({
      reportDate: source[0]!.reportDate,
      weather: "HOT",
      workersCount: 30,
      notes: source[0]!.notes,
      preparedByEngineerId: mona.id,
    });
    expect(restored(delta.id)).toMatchObject({
      reportDate: source[1]!.reportDate,
      weather: "RAINY",
      workersCount: 0,
      notes: null,
      preparedByEngineerId: karim.id,
    });
  });

  it("writes the phone instead of the name when two records of a kind share a name, and still imports back to the right one", async () => {
    const twin = addContractor({ name: "Nile Builders", phone: "0100 777 8888" });
    addDailyReport({
      contractorId: twin.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-01"),
    });
    const exported = await request(app)
      .get("/api/v1/daily-reports/export?format=xlsx")
      .set(await as(admin))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    dailyReportTables.reset();

    const res = await upload(exported.body as Buffer);

    expect(res.status).toBe(201);
    expect(created()[0]?.contractorId).toBe(twin.id);
  });
});

describe("POST /daily-reports/import: dry run", () => {
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
    const file = await one({ weather: "Snowy" });

    const first = await upload(file, { query: "?dryRun=true" });
    const second = await upload(file, { query: "?dryRun=true" });

    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(false);
    expect(errorsOf(first)).toEqual([[2, TITLE.weather, "INVALID_OPTION"]]);
    expect(second.status).toBe(200);
    nothingWritten();
  });

  it("does not stop the real import of the same file afterwards", async () => {
    const file = await one();
    await upload(file, { query: "?dryRun=true" });

    expect((await upload(file)).status).toBe(201);
  });
});

describe("POST /daily-reports/import: row errors (422, nothing is saved)", () => {
  it("lists every bad cell of every row, with the row, the column, the code and the value", async () => {
    const res = await upload(
      await sheet(
        row({
          reportDate: "someday",
          contractor: "Nobody",
          engineer: "Nobody",
          weather: "Snowy",
          workersCount: -1,
        }),
        row({
          reportDate: null,
          contractor: null,
          engineer: null,
          weather: null,
          workersCount: null,
          notes: "only notes",
        }),
        row({
          reportDate: "2026-03-04",
          contractor: "Nile Builders",
          engineer: "Mona Hassan",
          weather: "Hot",
          workersCount: 1,
        }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 3, imported: 0, truncated: false });
    expect(errorsOf(res)).toEqual([
      [2, TITLE.reportDate, "INVALID_VALUE"],
      [2, TITLE.contractor, "REFERENCE_NOT_FOUND"],
      [2, TITLE.engineer, "REFERENCE_NOT_FOUND"],
      [2, TITLE.weather, "INVALID_OPTION"],
      [2, TITLE.workersCount, "INVALID_VALUE"],
      [3, TITLE.reportDate, "REQUIRED"],
      [3, TITLE.contractor, "REQUIRED"],
      [3, TITLE.engineer, "REQUIRED"],
      [3, TITLE.weather, "REQUIRED"],
      [3, TITLE.workersCount, "REQUIRED"],
    ]);
    expect(res.body.data.errors[1]).toMatchObject({
      row: 2,
      column: TITLE.contractor,
      message: "No contractor has this name or phone",
      value: "Nobody",
    });
    nothingWritten();
  });

  it("says what is wrong in the language of the request", async () => {
    const res = await upload(await one({ contractor: "Nobody", weather: "Snowy" }), { language: "ar" });

    expect(res.status).toBe(422);
    for (const error of res.body.data.errors as ReportError[]) expect(error.message).toMatch(ARABIC);
  });

  it("refuses a date more than one day past today, and takes tomorrow", async () => {
    const far = await upload(await one({ reportDate: daysFromToday(2) }));
    const tomorrow = await upload(await one({ reportDate: daysFromToday(1) }));

    expect(errorsOf(far)).toEqual([[2, TITLE.reportDate, "INVALID_VALUE"]]);
    expect(tomorrow.status).toBe(201);
  });

  it("refuses numbers where text is expected, and text where a number is expected", async () => {
    const res = await upload(await one({ contractor: 42, workersCount: "many" }));

    expect(res.status).toBe(422);
    expect(errorsOf(res).map(([, column]) => column)).toEqual(expect.arrayContaining([TITLE.workersCount]));
  });

  describe("the contractor", () => {
    it("is any contractor by name or phone: an unknown one is REFERENCE_NOT_FOUND", async () => {
      const res = await upload(await one({ contractor: "Nobody" }));

      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REFERENCE_NOT_FOUND"]]);
    });

    it("must be active: a switched-off one is INVALID_VALUE, with a message about daily reports", async () => {
      nile.status = "INACTIVE";

      const res = await upload(await one({ contractor: "Nile Builders" }));

      expect(res.status).toBe(422);
      expect(res.body.data.errors).toEqual([
        {
          row: 2,
          column: TITLE.contractor,
          code: "INVALID_VALUE",
          message: "This contractor is inactive and cannot be assigned to a daily report",
          value: "Nile Builders",
        },
      ]);
    });

    it("is required: an empty cell is REQUIRED, even on a file that used to leave it empty", async () => {
      const res = await upload(await one({ contractor: null }));

      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REQUIRED"]]);
    });
  });

  describe("the electrical engineer", () => {
    it("must exist: an unknown one is REFERENCE_NOT_FOUND, with the engineer message", async () => {
      const res = await upload(await one({ engineer: "Nobody" }));

      expect(res.body.data.errors).toEqual([
        {
          row: 2,
          column: TITLE.engineer,
          code: "REFERENCE_NOT_FOUND",
          message: "No electrical engineer has this name or phone",
          value: "Nobody",
        },
      ]);
    });

    it("must be active: a switched-off one is INVALID_VALUE, with a message about daily reports", async () => {
      mona.status = "INACTIVE";

      const res = await upload(await one({ engineer: "Mona Hassan" }));

      expect(res.body.data.errors).toEqual([
        {
          row: 2,
          column: TITLE.engineer,
          code: "INVALID_VALUE",
          message: "This electrical engineer is inactive and cannot be given a daily report",
          value: "Mona Hassan",
        },
      ]);
    });

    it("is required: an empty cell is REQUIRED, not filled in from the importing user", async () => {
      const res = await upload(await one({ engineer: null }));

      expect(errorsOf(res)).toEqual([[2, TITLE.engineer, "REQUIRED"]]);
    });
  });

  describe("one report per contractor per day", () => {
    it("refuses the same contractor and day twice in the file, on every later row, however the contractor is spelled", async () => {
      const res = await upload(
        await sheet(
          row({ reportDate: "2026-03-04", contractor: "Nile Builders" }),
          row({ reportDate: "2026-03-04", contractor: "nile builders", engineer: "Karim Adel" }),
          row({ reportDate: "2026-03-04", contractor: "0100-111-2222" }),
          row({ reportDate: "2026-03-05", contractor: "Nile Builders" }),
        ),
      );

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([
        [3, TITLE.reportDate, "DUPLICATE_IN_FILE"],
        [4, TITLE.reportDate, "DUPLICATE_IN_FILE"],
      ]);
      expect(res.body.data.errors[0].message).toBe(
        "This contractor and date appear more than once in the file",
      );
      nothingWritten();
    });

    it("refuses a day the contractor already has a report for, and says so in Arabic", async () => {
      addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: karim.id,
        reportDate: day("2026-03-04"),
      });

      const res = await upload(await one({ contractor: "Nile Builders" }), { language: "ar" });

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.reportDate, "DUPLICATE_EXISTING"]]);
      expect(res.body.data.errors[0].message).toBe("هذا المقاول لديه تقرير يومي لهذا التاريخ بالفعل");
      expect(created()).toHaveLength(1);
    });

    it("lets the same day through for another contractor, and another day for the same contractor", async () => {
      const res = await upload(
        await sheet(
          row({ reportDate: "2026-03-04", contractor: "Nile Builders" }),
          row({ reportDate: "2026-03-04", contractor: "Delta Works" }),
          row({ reportDate: "2026-03-05", contractor: "Nile Builders" }),
        ),
      );

      expect(res.status).toBe(201);
      expect(created()).toHaveLength(3);
    });

    it("lets one engineer prepare the reports of several contractors on one day", async () => {
      const res = await upload(
        await sheet(
          row({ reportDate: "2026-03-04", contractor: "Nile Builders", engineer: "Mona Hassan" }),
          row({ reportDate: "2026-03-04", contractor: "Delta Works", engineer: "Mona Hassan" }),
        ),
      );

      expect(res.status).toBe(201);
    });

    it("saves nothing when one row of many is bad", async () => {
      const res = await upload(
        await sheet(
          row({ reportDate: "2026-03-01" }),
          row({ reportDate: "2026-03-02" }),
          row({ reportDate: "2026-03-03", weather: "Snowy" }),
        ),
      );

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[4, TITLE.weather, "INVALID_OPTION"]]);
      nothingWritten();
    });
  });
});

describe("POST /daily-reports/import: the same file twice", () => {
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

describe("POST /daily-reports/import: the contractors, the engineers or the days change during the import", () => {
  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when the contractor was switched off after the check", async () => {
    dailyReportRaces.beforeImportLock = () => {
      nile.status = "INACTIVE";
    };

    const res = await upload(await one({ contractor: "Nile Builders" }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("answers 409 when the contractor was deleted after the check", async () => {
    dailyReportRaces.beforeImportLock = () => {
      contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== delta.id);
    };

    const res = await upload(
      await sheet(
        row({ reportDate: "2026-03-04", contractor: "Nile Builders" }),
        row({ reportDate: "2026-03-04", contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("answers 409 when the engineer was switched off or deleted after the check", async () => {
    dailyReportRaces.beforeImportLock = () => {
      mona.status = "INACTIVE";
    };
    const off = await upload(await one());

    mona.status = "ACTIVE";
    dailyReportRaces.beforeImportLock = () => {
      electricalTables.engineers = electricalTables.engineers.filter((e) => e.id !== mona.id);
    };
    const gone = await upload(await one({ reportDate: "2026-03-05" }));

    expect([off.status, off.body.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
    expect([gone.status, gone.body.code]).toEqual([409, "IMPORT_DATA_CHANGED"]);
    nothingWritten();
  });

  it("answers 409 IMPORT_DATA_CHANGED, saving nothing, when someone saved a report for one of the days in the meantime: the unique index has the last word", async () => {
    dailyReportRaces.beforeImportLock = () => {
      addDailyReport({
        contractorId: delta.id,
        preparedByEngineerId: karim.id,
        reportDate: day("2026-03-04"),
      });
    };

    const res = await upload(
      await sheet(
        row({ reportDate: "2026-03-04", contractor: "Nile Builders" }),
        row({ reportDate: "2026-03-04", contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    expect(created().filter((report) => report.contractorId === nile.id)).toHaveLength(0);
    expect(importBatchTable.rows).toHaveLength(0);
    expect(importAudit()).toHaveLength(0);
  });
});

describe("POST /daily-reports/import: the request", () => {
  it("answers 400 NO_FILE_PROVIDED without a file", async () => {
    const res = await upload(null);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 415 to a file that is not .xlsx", async () => {
    const res = await upload(await one(), { filename: "reports.csv" });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 IMPORT_HEADER_MISMATCH when a column is missing, unknown or repeated", async () => {
    const missing = await upload(
      await workbookOf([
        ["reportDate", "contractor"],
        ["2026-03-04", "Nile Builders"],
      ]),
    );
    const unknown = await upload(await withColumns(await one(), { extra: "x" }));
    const repeated = await upload(await withColumns(await one(), { [TITLE.weather]: "Hot" }));

    for (const res of [missing, unknown, repeated]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("IMPORT_HEADER_MISMATCH");
    }
    nothingWritten();
  });

  it("refuses the columns a report no longer has: Villa Number, Work Done, Issues, Prepared By", async () => {
    for (const gone of ["Villa Number", "Work Done", "Issues", "Prepared By", "Location"]) {
      const res = await upload(await withColumns(await one(), { [gone]: "x" }));

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ path: gone, message: "This column is not part of the template" }]);
    }
    nothingWritten();
  });

  it("answers 422 to a header with no rows, and to more than 2,000 data rows", async () => {
    const empty = await upload(await sheet());
    const tall = await upload(
      await sheet(
        ...Array.from({ length: 2001 }, (_, n) => row({ reportDate: new Date(Date.UTC(2000, 0, 1 + n)) })),
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
    const user = employee("limited@example.test", "daily-reports:import");

    expect((await upload(await one({ workersCount: 1 }), { user })).status).toBe(201);
    expect((await upload(await one({ workersCount: 2, reportDate: "2026-03-05" }), { user })).status).toBe(
      201,
    );
    const third = await upload(await one({ workersCount: 3, reportDate: "2026-03-06" }), { user });

    expect(third.status).toBe(429);
  });

  it("counts the template against the same allowance", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("template@example.test", "daily-reports:import");

    const first = await request(app)
      .get("/api/v1/daily-reports/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/daily-reports/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });

  it("answers 422 when the Idempotency-Key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({ workersCount: 1 }), { key });
    const other = await upload(await one({ workersCount: 2, reportDate: "2026-03-05" }), { key });

    const dryKey = newKey();
    const file = await one({ workersCount: 3, reportDate: "2026-03-06" });
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

describe("GET /daily-reports/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/daily-reports/import/template")
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

  beforeEach(() => {
    addContractor({ name: "Old Co", phone: "0100 000 0001", status: "INACTIVE" });
    addElectricalEngineer({ name: "Retired Rami", phone: "0100 000 0002", status: "INACTIVE" });
  });

  it("has a dropdown on the contractor, the electrical engineer and the weather, and on no other", async () => {
    expect(dropdownsOf(await template())).toEqual({
      Contractor: ["Delta Works", "Nile Builders"],
      "Electrical Engineer": ["Karim Adel", "Mona Hassan"],
      Weather: ["Hot", "Sunny", "Windy", "Rainy", "Dusty"],
    });
  });

  it("offers only values the import accepts: a file with every choice, one per row, has no reference or option error", async () => {
    const choices = dropdownsOf(await template());
    const rows = Array.from({ length: 5 }, (_, at) =>
      row({
        reportDate: `2026-03-0${at + 1}`,
        contractor: choices.Contractor![at % choices.Contractor!.length],
        engineer: choices["Electrical Engineer"]![at % choices["Electrical Engineer"]!.length],
        weather: choices.Weather![at % choices.Weather!.length],
        workersCount: 20 + at,
      }),
    );
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, total: 5, errors: [] });
  });

  it("imports a filled-in template with the Lists sheet still in it", async () => {
    const bytes = await filledTemplate(await template(), [
      "2026-03-04",
      "Delta Works",
      "Karim Adel",
      "Sunny",
      25,
      "",
    ]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ contractorId: delta.id, preparedByEngineerId: karim.id });
  });
});
