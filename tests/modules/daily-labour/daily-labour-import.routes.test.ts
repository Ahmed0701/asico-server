import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, withColumns } from "../../shared/import/xlsx-fixtures.js";
import {
  addDailyLabour,
  dailyLabourRaces,
  dailyLabourTables,
  InMemoryDailyLabourRepository,
  uniqueError,
} from "./in-memory-daily-labour.repository.js";

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
const KEYS = ["villa", "labourDate", "labourCount", "contractor", "notes"] as const;
type Header = (typeof KEYS)[number];
const TITLE: Record<Header, string> = {
  villa: "Villa Number",
  labourDate: "Labour Date",
  labourCount: "Labour Count",
  contractor: "Contractor",
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
let villa1: StoredVilla;
let villa2: StoredVilla;
let villa3: StoredVilla;

beforeEach(() => {
  store.reset();
  contractorTables.reset();
  villaTables.reset();
  dailyLabourRaces.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  nile = addContractor({ name: "Nile Builders", phone: "0100 111 2222" });
  delta = addContractor({ name: "Delta Works", phone: "0111 333 4444" });
  villa1 = addVilla({ id: "villa-c", villaNumber: "P-001", contractorId: nile.id });
  villa2 = addVilla({ id: "villa-b", villaNumber: "P-002", contractorId: delta.id });
  villa3 = addVilla({ id: "villa-a", villaNumber: "P-003", contractorId: null });
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
const one = (cells: Partial<Record<Header, ExcelJS.CellValue>> = {}): Promise<Buffer> =>
  sheet(
    row({
      villa: "P-001",
      labourDate: "2026-03-04",
      labourCount: 25,
      contractor: "Nile Builders",
      ...cells,
    }),
  );
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
    filename = "daily-labour.xlsx",
  } = options;
  const req = request(app)
    .post(`/api/v1/daily-labour/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "daily_labour.import");
const created = () => dailyLabourTables.rows;
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
    ["get", "/daily-labour/import/template"],
    ["post", "/daily-labour/import"],
  ] as const;
  const others = [
    "daily-labour:read",
    "daily-labour:create",
    "daily-labour:update",
    "daily-labour:delete",
    "daily-labour:export",
    "daily-reports:import",
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

  it("does not let daily-labour:import open the other daily labour routes", async () => {
    const headers = await as(employee("importer@example.test", "daily-labour:import"));

    expect((await request(app).get("/api/v1/daily-labour").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/daily-labour").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/daily-labour/export?format=xlsx").set(headers)).status).toBe(403);
  });

  it("lets the holder of daily-labour:import use both routes", async () => {
    const user = employee("importer@example.test", "daily-labour:import");

    expect(
      (
        await request(app)
          .get("/api/v1/daily-labour/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one(), { user })).status).toBe(201);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /daily-labour/:id", async () => {
    const res = await request(app)
      .get("/api/v1/daily-labour/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /daily-labour/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/daily-labour/import/template")
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
      'attachment; filename="daily-labour-import-template.xlsx"',
    );
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, in order", async () => {
    const workbook = await workbookOfTemplate();

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Daily labour", "Instructions", "Lists"]);
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, ...HEADER]);
  });

  it("has an example row on a villa that does not exist, so it cannot be imported by mistake", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(1).value).toBe("EX-000");
    expect(data.getRow(2).getCell(3).value).toBe("25");
    expect(data.getRow(2).getCell(4).value).toBe("Example Contracting Co.");
  });

  it("says which columns are required: every one but the notes", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const required: Record<string, string> = {};
    instructions.eachRow((r) => {
      if (HEADER.includes(r.getCell(1).text as never)) required[r.getCell(1).text] = r.getCell(2).text;
    });

    expect(required).toEqual({
      [TITLE.villa]: "Yes",
      [TITLE.labourDate]: "Yes",
      [TITLE.labourCount]: "Yes",
      [TITLE.contractor]: "Yes",
      [TITLE.notes]: "No",
    });
  });

  it("names what the file holds on its instructions sheet", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));

    expect(text).toContain("Import daily labour rows");
  });

  it("explains every column, the contractor rule, the day limit, the count and the notes limit", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    const all = text.join(" | ");

    for (const header of HEADER) expect(all).toContain(header);
    expect(all).toContain("villa's own contractor");
    expect(all).toContain("Tomorrow is the latest day allowed");
    expect(all).toContain("A villa has one row per contractor per day");
    expect(all).toContain("a whole number from 0 to 100,000");
    expect(all).toContain("up to 500 characters");
    expect(all).toContain("A cell holds up to 2,000 characters.");
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });
});

describe("POST /daily-labour/import: a good file", () => {
  it("saves every row in one go: 201, the report, the rows with the importer as creator", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          labourDate: "2026-03-04",
          labourCount: 25,
          contractor: "Nile Builders",
          notes: "Roof",
        }),
        row({
          villa: " p-002 ",
          labourDate: day("2026-03-05"),
          labourCount: "0",
          contractor: "delta works",
        }),
        row({
          villa: "P-001",
          labourDate: "2026-03-06",
          labourCount: 100000,
          contractor: "0100-111-2222",
          notes: "  Slab  ",
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
    const byDay = (iso: string) =>
      created().find((entry) => entry.labourDate.getTime() === day(iso).getTime())!;
    expect(byDay("2026-03-04")).toMatchObject({
      villaId: villa1.id,
      contractorId: nile.id,
      labourCount: 25,
      notes: "Roof",
      createdById: admin.id,
      version: 1,
    });
    expect(byDay("2026-03-05")).toMatchObject({
      villaId: villa2.id,
      contractorId: delta.id,
      labourCount: 0,
      notes: null,
    });
    expect(byDay("2026-03-06")).toMatchObject({ labourCount: 100000, notes: "Slab", contractorId: nile.id });
  });

  it("writes one daily_labour.import audit entry on DailyLabour, with the batch, the count and the ids", async () => {
    const file = await sheet(
      row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
      row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
    );

    await upload(file);

    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "DailyLabour",
      after: { rows: 2, fileHash: sha256(file), createdIds: created().map((entry) => entry.id) },
    });
    expect(importBatchTable.rows).toMatchObject([{ entity: "DailyLabour", rows: 2, userId: admin.id }]);
  });

  it("takes the days in any order and ignores blank rows between the records", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-05", labourCount: 1, contractor: "Nile Builders" }),
        [],
        row({ villa: "P-001", labourDate: "2026-03-01", labourCount: 1, contractor: "Nile Builders" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
  });

  it("imports a file of 2,000 rows", async () => {
    const rows = Array.from({ length: 2000 }, (_, n) =>
      row({
        villa: "P-001",
        labourDate: new Date(Date.UTC(2000, 0, 1 + n)),
        labourCount: n,
        contractor: "Nile Builders",
      }),
    );

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(2000);
  }, 120_000);

  it("runs in a transaction with the import's time allowance", async () => {
    const spy = vi.spyOn(InMemoryDailyLabourRepository.prototype, "transaction");

    await upload(await one());

    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
  });

  it("locks the villas of the file once each, in the order of their ids", async () => {
    // The ids are reversed against the file's order and one villa is used twice.
    const spy = vi.spyOn(InMemoryDailyLabourRepository.prototype, "lockVillasShared");
    villa3.contractorId = nile.id;

    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
        row({ villa: "P-001", labourDate: "2026-03-05", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-003", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual([villa3.id, villa2.id, villa1.id]);
  });

  it("answers 500, not the changed-data conflict, when the write fails for another reason", async () => {
    vi.spyOn(InMemoryDailyLabourRepository.prototype, "createMany").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });
});

describe("POST /daily-labour/import: the text limits", () => {
  it("accepts notes of 500 characters, Arabic ones included, and stores them whole", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          labourDate: "2026-03-01",
          labourCount: 1,
          contractor: "Nile Builders",
          notes: "n".repeat(500),
        }),
        row({
          villa: "P-001",
          labourDate: "2026-03-02",
          labourCount: 1,
          contractor: "Nile Builders",
          notes: "ش".repeat(500),
        }),
      ),
    );

    expect(res.status).toBe(201);
    expect(created().map((entry) => entry.notes?.length)).toEqual([500, 500]);
  });

  it("refuses notes of 501 characters as a row error, with the API's message, in Arabic too", async () => {
    const file = await one({ notes: "n".repeat(501) });

    const english = await upload(file);
    const arabic = await upload(file, { language: "ar" });

    expect(english.status).toBe(422);
    expect(errorsOf(english)).toEqual([[2, TITLE.notes, "INVALID_VALUE"]]);
    expect(english.body.data.errors[0].message).toBe("Notes must be at most 500 characters");
    expect(arabic.body.data.errors[0].message).toBe("يجب ألا تزيد الملاحظات عن 500 حرف");
    nothingWritten();
  });

  it("keeps the default cell limit: a notes cell of 2,001 characters is refused for the whole file", async () => {
    const res = await upload(await one({ notes: "n".repeat(2001) }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
    expect(res.body.details).toEqual([{ path: "E2", message: "A cell holds more than 2,000 characters" }]);
    nothingWritten();
  });

  it.each(KEYS)(
    "refuses a cell of 2,001 characters in %s with the 2,000 message: the default is unchanged",
    async (header) => {
      const res = await upload(await one({ [header]: "x".repeat(2001) }));

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
});

describe("POST /daily-labour/import: a file that was exported", () => {
  it("can be imported again: every column of the export is a column the import reads", async () => {
    const source = [
      addDailyLabour({
        villaId: villa1.id,
        contractorId: nile.id,
        labourDate: day("2026-03-01"),
        labourCount: 30,
        notes: "n".repeat(500),
      }),
      addDailyLabour({
        villaId: villa2.id,
        contractorId: delta.id,
        labourDate: day("2026-03-02"),
        labourCount: 0,
      }),
    ];
    const exported = await request(app)
      .get("/api/v1/daily-labour/export?format=xlsx")
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
        labourDate: cell(n, "Labour Date"),
        labourCount: cell(n, "Labour Count"),
        contractor: cell(n, "Contractor"),
        notes: cell(n, "Notes"),
      }),
    );
    // The rows are deleted, so the file imports onto empty days.
    dailyLabourTables.reset();

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);
    const restored = (id: string) => created().find((entry) => entry.villaId === id)!;
    expect(restored(villa1.id)).toMatchObject({
      labourDate: source[0]!.labourDate,
      contractorId: nile.id,
      labourCount: 30,
      notes: source[0]!.notes,
    });
    expect(restored(villa2.id)).toMatchObject({
      labourDate: source[1]!.labourDate,
      contractorId: delta.id,
      labourCount: 0,
      notes: null,
    });
  });
});

describe("POST /daily-labour/import: dry run", () => {
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
    const file = await one({ labourCount: -1 });

    const first = await upload(file, { query: "?dryRun=true" });
    const second = await upload(file, { query: "?dryRun=true" });

    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(false);
    expect(errorsOf(first)).toEqual([[2, TITLE.labourCount, "INVALID_VALUE"]]);
    expect(second.status).toBe(200);
    nothingWritten();
  });

  it("reports a duplicate of a stored row too, and saves nothing", async () => {
    addDailyLabour({ villaId: villa1.id, contractorId: nile.id, labourDate: day("2026-03-04") });

    const res = await upload(await one(), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res)).toEqual([[2, TITLE.labourDate, "DUPLICATE_EXISTING"]]);
    expect(importBatchTable.rows).toHaveLength(0);
  });

  it("does not stop the real import of the same file afterwards", async () => {
    const file = await one();
    await upload(file, { query: "?dryRun=true" });

    expect((await upload(file)).status).toBe(201);
  });
});

describe("POST /daily-labour/import: row errors (422, nothing is saved)", () => {
  it("lists every bad cell of every row, with the row, the column, the code and the value", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-999", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-001", labourDate: "nope", labourCount: -1, contractor: "Nile Builders" }),
        row({ villa: "P-001", labourDate: "2026-03-05", labourCount: 1.5, contractor: "Nile Builders" }),
        row({ villa: "P-001", labourDate: "2026-03-06", labourCount: "many" }),
        row({}),
        row({ villa: "P-001" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.imported).toBe(0);
    expect(errorsOf(res)).toEqual([
      [2, TITLE.villa, "REFERENCE_NOT_FOUND"],
      [3, TITLE.labourDate, "INVALID_VALUE"],
      [3, TITLE.labourCount, "INVALID_VALUE"],
      [4, TITLE.labourCount, "INVALID_VALUE"],
      [5, TITLE.labourCount, "INVALID_VALUE"],
      [5, TITLE.contractor, "REQUIRED"],
      [7, TITLE.labourDate, "REQUIRED"],
      [7, TITLE.labourCount, "REQUIRED"],
      [7, TITLE.contractor, "REQUIRED"],
    ]);
    nothingWritten();
  });

  it("says what is wrong in the language of the request", async () => {
    const res = await upload(await one({ labourCount: 100001 }), { language: "ar" });

    const messages = (res.body.data.errors as ReportError[]).map((error) => error.message);
    expect(messages).toEqual(["يجب أن يكون عدد العمال عددًا صحيحًا من 0 إلى 100,000"]);
  });

  it("refuses a date more than one day past today, and takes tomorrow", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          labourDate: daysFromToday(1),
          labourCount: 1,
          contractor: "Nile Builders",
        }),
        row({
          villa: "P-001",
          labourDate: daysFromToday(2),
          labourCount: 1,
          contractor: "Nile Builders",
        }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[3, TITLE.labourDate, "INVALID_VALUE"]]);
    expect(res.body.data.errors[0].message).toBe("The labour date cannot be more than one day after today");
  });

  it("refuses a number where text is expected", async () => {
    const res = await upload(await one({ notes: 12 as unknown as string }));

    expect(errorsOf(res)).toEqual([[2, TITLE.notes, "NOT_TEXT"]]);
  });

  describe("the contractor", () => {
    it("is required: an empty cell is REQUIRED, and it is never filled in", async () => {
      const res = await upload(await one({ contractor: null }));

      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REQUIRED"]]);
      nothingWritten();
    });

    it("must be the villa's own: another is CONTRACTOR_NOT_ON_VILLA, an unknown one REFERENCE_NOT_FOUND", async () => {
      const res = await upload(
        await sheet(
          row({ villa: "P-001", labourDate: "2026-03-01", labourCount: 1, contractor: "Delta Works" }),
          row({ villa: "P-003", labourDate: "2026-03-01", labourCount: 1, contractor: "Nile Builders" }),
          row({ villa: "P-001", labourDate: "2026-03-02", labourCount: 1, contractor: "Nobody" }),
        ),
      );

      expect(errorsOf(res)).toEqual([
        [2, TITLE.contractor, "CONTRACTOR_NOT_ON_VILLA"],
        [3, TITLE.contractor, "CONTRACTOR_NOT_ON_VILLA"],
        [4, TITLE.contractor, "REFERENCE_NOT_FOUND"],
      ]);
      expect(res.body.data.errors[0].message).toBe("This contractor is not the contractor of this villa");
    });

    it("must be active: a switched-off one is INVALID_VALUE, with a message about daily labour", async () => {
      nile.status = "INACTIVE";

      const res = await upload(await one());

      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe(
        "This contractor is inactive and cannot be given a daily labour row",
      );
    });
  });

  describe("one row per villa, contractor and day", () => {
    it("refuses the same villa, contractor and day twice in the file, on every later row, however they are spelled", async () => {
      const res = await upload(
        await sheet(
          row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
          row({
            villa: " p-001",
            labourDate: day("2026-03-04"),
            labourCount: 2,
            contractor: "0100-111-2222",
          }),
          row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
          row({ villa: "P-001", labourDate: "2026-03-05", labourCount: 1, contractor: "Nile Builders" }),
          row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 3, contractor: "NILE BUILDERS" }),
        ),
      );

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([
        [3, TITLE.labourDate, "DUPLICATE_IN_FILE"],
        [6, TITLE.labourDate, "DUPLICATE_IN_FILE"],
      ]);
      expect(res.body.data.errors[0].message).toBe(
        "This villa, contractor and date appear more than once in the file",
      );
      nothingWritten();
    });

    it("refuses a key the table already has, and says so in Arabic", async () => {
      addDailyLabour({ villaId: villa1.id, contractorId: nile.id, labourDate: day("2026-03-04") });

      const res = await upload(await one(), { language: "ar" });

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.labourDate, "DUPLICATE_EXISTING"]]);
      expect(res.body.data.errors[0].message).toBe(
        "هذه الفيلا لديها سجل عمالة لهذا المقاول في هذا التاريخ بالفعل",
      );
      expect(created()).toHaveLength(1);
    });

    it("says a duplicate inside the file in Arabic on request", async () => {
      const res = await upload(
        await sheet(
          row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
          row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 2, contractor: "Nile Builders" }),
        ),
        { language: "ar" },
      );

      expect(errorsOf(res)).toEqual([[3, TITLE.labourDate, "DUPLICATE_IN_FILE"]]);
      expect(res.body.data.errors[0].message).toBe("هذه الفيلا وهذا المقاول وهذا التاريخ مكررة في الملف");
    });

    it("says it in English too", async () => {
      addDailyLabour({ villaId: villa1.id, contractorId: nile.id, labourDate: day("2026-03-04") });

      const res = await upload(await one());

      expect(res.body.data.errors[0].message).toBe(
        "This villa already has a labour row for this contractor on this date",
      );
    });

    it("lets the day through for another villa, another day, and another contractor on the same villa", async () => {
      addDailyLabour({ villaId: villa1.id, contractorId: nile.id, labourDate: day("2026-03-04") });
      // The stored row was written when the villa had another contractor.
      addDailyLabour({ villaId: villa2.id, contractorId: nile.id, labourDate: day("2026-03-04") });

      const res = await upload(
        await sheet(
          row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
          row({ villa: "P-001", labourDate: "2026-03-05", labourCount: 1, contractor: "Nile Builders" }),
        ),
      );

      expect(res.status).toBe(201);
    });

    it("saves nothing when one row of many is bad", async () => {
      const rows = Array.from({ length: 5 }, (_, n) =>
        row({
          villa: "P-001",
          labourDate: `2026-03-0${n + 1}`,
          labourCount: 1,
          contractor: "Nile Builders",
        }),
      );
      rows.push(
        row({ villa: "P-001", labourDate: "2026-03-09", labourCount: -1, contractor: "Nile Builders" }),
      );

      const res = await upload(await sheet(...rows));

      expect(res.status).toBe(422);
      nothingWritten();
    });
  });
});

describe("POST /daily-labour/import: the same file twice", () => {
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

  it("answers the rows already stored, not the file hash, to a changed file with the same keys", async () => {
    expect((await upload(await one())).status).toBe(201);

    const second = await upload(await one({ labourCount: 26 }));

    expect(second.status).toBe(422);
    expect(errorsOf(second)).toEqual([[2, TITLE.labourDate, "DUPLICATE_EXISTING"]]);
    expect(created()).toHaveLength(1);
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

describe("POST /daily-labour/import: a villa, its contractor or the keys change during the import", () => {
  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when a villa's contractor changed after the check", async () => {
    dailyLabourRaces.beforeImportLock = () => {
      villaTables.villas.find((candidate) => candidate.id === villa1.id)!.contractorId = delta.id;
    };

    const res = await upload(await one());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("answers 409 when the villa went away after the check", async () => {
    dailyLabourRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa2.id);
    };

    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("leaves a unique violation of anything but the key to the runner: it is not a change of the data", async () => {
    vi.spyOn(InMemoryDailyLabourRepository.prototype, "createMany").mockRejectedValueOnce(
      uniqueError("DailyLabour_pkey"),
    );

    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FILE_ALREADY_IMPORTED");
    expect(importAudit()).toHaveLength(0);
  });

  it("answers 409 IMPORT_DATA_CHANGED, saving nothing, when someone saved a row for one of the keys in the meantime: the unique index has the last word", async () => {
    dailyLabourRaces.beforeImportLock = () => {
      addDailyLabour({ villaId: villa2.id, contractorId: delta.id, labourDate: day("2026-03-04") });
    };

    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    expect(res.body.message).toBe(
      "A villa or its contractor changed while the file was being imported. Nothing was saved. Upload the file again",
    );
    // The other request's row is rolled back with the fake's transaction; what matters is that none of the file's rows stayed.
    expect(created().filter((entry) => entry.villaId === villa1.id)).toHaveLength(0);
    expect(importBatchTable.rows).toHaveLength(0);
    expect(importAudit()).toHaveLength(0);
  });

  it("is thrown by a contractor change on any villa of the file, as the contractor is required on every row", async () => {
    dailyLabourRaces.beforeImportLock = () => {
      villaTables.villas.find((candidate) => candidate.id === villa2.id)!.contractorId = null;
    };

    const res = await upload(
      await sheet(
        row({ villa: "P-001", labourDate: "2026-03-04", labourCount: 1, contractor: "Nile Builders" }),
        row({ villa: "P-002", labourDate: "2026-03-04", labourCount: 1, contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
  });

  it("is not thrown by a change on a villa the file does not use", async () => {
    dailyLabourRaces.beforeImportLock = () => {
      villaTables.villas.find((candidate) => candidate.id === villa3.id)!.contractorId = delta.id;
    };

    const res = await upload(await one());

    expect(res.status).toBe(201);
  });
});

describe("POST /daily-labour/import: the request", () => {
  it("answers 400 NO_FILE_PROVIDED without a file", async () => {
    const res = await upload(null);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 415 to a file that is not .xlsx", async () => {
    const res = await upload(await one(), { filename: "labour.csv" });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 IMPORT_HEADER_MISMATCH when a column is missing, unknown or repeated", async () => {
    const missing = await upload(
      await workbookOf([
        ["villa", "labourDate"],
        ["P-001", "2026-03-04"],
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

    for (const res of [missing, unknown, repeated]) {
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
          row({
            villa: "P-001",
            labourDate: new Date(Date.UTC(2000, 0, 1 + n)),
            labourCount: 1,
            contractor: "Nile Builders",
          }),
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
    const user = employee("limited@example.test", "daily-labour:import");

    expect((await upload(await one({ labourCount: 1 }), { user })).status).toBe(201);
    expect((await upload(await one({ labourCount: 2, labourDate: "2026-03-05" }), { user })).status).toBe(
      201,
    );
    const third = await upload(await one({ labourCount: 3, labourDate: "2026-03-06" }), { user });

    expect(third.status).toBe(429);
  });

  it("counts the template against the same allowance", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("template@example.test", "daily-labour:import");

    const first = await request(app)
      .get("/api/v1/daily-labour/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/daily-labour/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });

  it("answers 422 when the Idempotency-Key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({ labourCount: 1 }), { key });
    const other = await upload(await one({ labourCount: 2, labourDate: "2026-03-05" }), { key });

    const dryKey = newKey();
    const file = await one({ labourCount: 3, labourDate: "2026-03-06" });
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

describe("POST /daily-labour/import: a file that was exported", () => {
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

describe("GET /daily-labour/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/daily-labour/import/template")
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
  });

  it("has a dropdown on the villa and the contractor, and on no other", async () => {
    expect(dropdownsOf(await template())).toEqual({
      "Villa Number": ["P-001", "P-002", "P-003"],
      Contractor: ["Delta Works", "Nile Builders"],
    });
  });

  it("offers only values the import accepts: a file with every choice, one per row, has no reference or option error", async () => {
    const choices = dropdownsOf(await template());
    const rows = Array.from({ length: 3 }, (_, at) =>
      row({
        villa: choices["Villa Number"]![at % choices["Villa Number"]!.length],
        labourDate: `2026-03-0${at + 1}`,
        labourCount: 10 + at,
        contractor: choices.Contractor![at % choices.Contractor!.length],
      }),
    );
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res).filter(([, , code]) => code !== "CONTRACTOR_NOT_ON_VILLA")).toEqual([]);
    expect(res.body.data.total).toBe(3);
  });

  it("imports a filled-in template with the Lists sheet still in it, choosing a villa and its own contractor", async () => {
    const bytes = await filledTemplate(await template(), ["P-001", "2026-03-04", 25, "Nile Builders"]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ villaId: villa1.id, contractorId: nile.id });
  });
});
