import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, withColumns } from "../../shared/import/xlsx-fixtures.js";
import {
  addSmallWork,
  InMemorySmallWorksRepository,
  smallWorkRaces,
  smallWorkTables,
} from "./in-memory-small-works.repository.js";

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
const KEYS = ["villa", "startDate", "endDate", "description", "contractor", "status"] as const;
type Header = (typeof KEYS)[number];
const TITLE: Record<Header, string> = {
  villa: "Villa Number",
  startDate: "Start Date",
  endDate: "End Date",
  description: "Description",
  contractor: "Contractor",
  status: "Status",
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
let hamdy: { id: string };
let mona: { id: string };

beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  smallWorkRaces.reset();
  smallWorkTables.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa1 = addVilla({ id: "villa-c", villaNumber: "P-001" });
  villa2 = addVilla({ id: "villa-b", villaNumber: "P-002" });
  villa3 = addVilla({ id: "villa-a", villaNumber: "P-003" });
  hamdy = addContractor({ name: "Hamdy Co", phone: "0100 000 0001" });
  mona = addContractor({ name: "Mona Co", phone: "0100 000 0002" });
});
// A small work written straight into the table, for the cases that start from rows already there.
const seedWork = (extra: Partial<Parameters<typeof addSmallWork>[0]> = {}) =>
  addSmallWork({ villaId: villa1.id, contractorId: hamdy.id, ...extra });
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
      startDate: "2026-03-04",
      endDate: "2026-03-06",
      description: "Replaced a broken socket",
      contractor: "Hamdy Co",
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
    filename = "small-works.xlsx",
  } = options;
  const req = request(app)
    .post(`/api/v1/small-works/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "small_work.import");
const created = () => smallWorkTables.works;
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
    ["get", "/small-works/import/template"],
    ["post", "/small-works/import"],
  ] as const;
  const others = [
    "small-works:read",
    "small-works:create",
    "small-works:update",
    "small-works:delete",
    "small-works:export",
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

  it("does not let small-works:import open the other small works routes", async () => {
    const headers = await as(employee("importer@example.test", "small-works:import"));

    expect((await request(app).get("/api/v1/small-works").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/small-works").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/small-works/export?format=xlsx").set(headers)).status).toBe(403);
  });

  it("lets the holder of small-works:import use both routes", async () => {
    const user = employee("importer@example.test", "small-works:import");

    expect(
      (
        await request(app)
          .get("/api/v1/small-works/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one(), { user })).status).toBe(201);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /small-works/:id", async () => {
    const res = await request(app)
      .get("/api/v1/small-works/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /small-works/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/small-works/import/template")
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
      'attachment; filename="small-works-import-template.xlsx"',
    );
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, in order", async () => {
    const workbook = await workbookOfTemplate();

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Small works", "Instructions", "Lists"]);
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, ...HEADER]);
  });

  it("has an example row on a villa that does not exist, so it cannot be imported by mistake", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(1).value).toBe("EX-000");
    expect(data.getRow(2).getCell(6).value).toBe("Pending");
  });

  it("has a dropdown on the status, fed by the Lists sheet", async () => {
    const workbook = await workbookOfTemplate();
    const data = workbook.worksheets[0]!;
    const lists = workbook.getWorksheet("Lists")!;

    expect(data.getCell("F2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$F$1:$F$2"] });
    expect(lists.getColumn(6).values).toEqual([undefined, "Pending", "Done"]);
  });

  it("explains every column, the dates and the text limit", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    const all = text.join(" | ");

    for (const header of HEADER) expect(all).toContain(header);
    expect(all).not.toContain("Quantity");
    expect(all).not.toContain("Unit");
    expect(all).toContain("the same day as the start or later");
    expect(all).toContain("Within 10 years of today");
    expect(all).toContain("Any active contractor");
    expect(all).toContain("up to 500 characters");
    expect(all).not.toContain("Tomorrow is the latest day allowed");
    expect(all).not.toContain("up to 100 characters");
    expect(all).toContain("Leave it empty for Pending");
  });

  it("says which columns are required: every one but the status", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const required: Record<string, string> = {};
    instructions.eachRow((r) => {
      if (HEADER.includes(r.getCell(1).text as never)) required[r.getCell(1).text] = r.getCell(2).text;
    });

    expect(required).toEqual({
      [TITLE.villa]: "Yes",
      [TITLE.startDate]: "Yes",
      [TITLE.endDate]: "Yes",
      [TITLE.description]: "Yes",
      [TITLE.contractor]: "Yes",
      [TITLE.status]: "No",
    });
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });
});

const baseCells = {
  villa: "P-001",
  startDate: "2026-03-04",
  endDate: "2026-03-04",
  description: "a",
  contractor: "Hamdy Co",
} as const;

describe("POST /small-works/import: a good file", () => {
  it("saves every row in one go: 201, the report, the rows with the importer as creator and PENDING by default", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          startDate: "2026-03-04",
          endDate: "2026-03-08",
          description: "Replaced a broken socket",
          contractor: "Hamdy Co",
          status: "Done",
        }),
        row({
          villa: " p-002 ",
          startDate: day("2026-03-05"),
          endDate: day("2026-03-05"),
          description: "  Painted the gate ",
          contractor: " mona  CO ",
        }),
        row({
          villa: "P-003",
          startDate: "2026-03-04",
          endDate: "2026-03-04",
          description: "D",
          contractor: "0100-000-0002",
          status: "pending",
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
    const byVilla = (id: string) => created().find((work) => work.villaId === id)!;
    expect(byVilla(villa1.id)).toMatchObject({
      contractorId: hamdy.id,
      startDate: day("2026-03-04"),
      endDate: day("2026-03-08"),
      description: "Replaced a broken socket",
      status: "DONE",
      createdById: admin.id,
      version: 1,
    });
    expect(byVilla(villa2.id)).toMatchObject({
      contractorId: mona.id,
      startDate: day("2026-03-05"),
      endDate: day("2026-03-05"),
      description: "Painted the gate",
      status: "PENDING",
    });
    expect(byVilla(villa3.id)).toMatchObject({ status: "PENDING", contractorId: mona.id });
  });

  it("writes one small_work.import audit entry on DailySmallWork, with the batch, the count and the ids", async () => {
    const file = await sheet(
      row({ ...baseCells, villa: "P-001", description: "A" }),
      row({ ...baseCells, villa: "P-002", description: "B" }),
    );

    await upload(file);

    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "DailySmallWork",
      after: { rows: 2, fileHash: sha256(file), createdIds: created().map((work) => work.id) },
    });
    expect(importBatchTable.rows).toMatchObject([{ entity: "DailySmallWork", rows: 2, userId: admin.id }]);
  });

  it("accepts a status by code or by label, in any case", async () => {
    const cells = { villa: "P-001", description: "a", contractor: "Hamdy Co" } as const;
    const res = await sheet(
      row({ ...cells, startDate: "2026-03-01", endDate: "2026-03-01", status: "DONE" }),
      row({ ...cells, startDate: "2026-03-02", endDate: "2026-03-02", status: "pending" }),
      row({ ...cells, startDate: "2026-03-03", endDate: "2026-03-03", status: "Done" }),
    ).then((file) => upload(file));

    expect(res.status).toBe(201);
    expect(created().map((work) => work.status)).toEqual(["DONE", "PENDING", "DONE"]);
  });

  it("has no natural key: the same villa, day and text may appear twice in the file and again in the table", async () => {
    seedWork({
      startDate: day("2026-03-04"),
      endDate: day("2026-03-06"),
      description: "Replaced a broken socket",
    });
    const cells = {
      villa: "P-001",
      startDate: "2026-03-04",
      endDate: "2026-03-06",
      description: "Replaced a broken socket",
      contractor: "Hamdy Co",
    } as const;

    const res = await upload(await sheet(row(cells), row(cells)));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(3);
  });

  it("takes the days in any order and ignores blank rows between the records", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          startDate: "2026-03-05",
          endDate: "2026-03-05",
          description: "later",
          contractor: "Hamdy Co",
        }),
        [],
        row({
          villa: "P-001",
          startDate: "2026-03-01",
          endDate: "2026-03-01",
          description: "earlier",
          contractor: "Hamdy Co",
        }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
  });

  it("imports a file of 2,000 rows", async () => {
    const rows = Array.from({ length: 2000 }, (_, n) =>
      row({
        villa: "P-001",
        startDate: new Date(Date.UTC(2020, 0, 1 + (n % 300))),
        endDate: new Date(Date.UTC(2020, 0, 1 + (n % 300))),
        description: `Work ${n}`,
        contractor: "Hamdy Co",
      }),
    );

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(2000);
  }, 120_000);

  it("runs in a transaction with the import's time allowance", async () => {
    const spy = vi.spyOn(InMemorySmallWorksRepository.prototype, "transaction");

    await upload(await one());

    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
  });

  it("locks the villas of the file once each, in the order of their ids", async () => {
    // The ids are reversed against the file's order and one villa is used twice.
    const spy = vi.spyOn(InMemorySmallWorksRepository.prototype, "lockVillasShared");
    const cells = {
      description: "a",
      contractor: "Hamdy Co",
      startDate: "2026-03-04",
      endDate: "2026-03-04",
    } as const;

    const res = await upload(
      await sheet(
        row({ ...cells, villa: "P-001" }),
        row({ ...cells, villa: "P-002" }),
        row({ ...cells, villa: "P-001" }),
        row({ ...cells, villa: "P-003" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual([villa3.id, villa2.id, villa1.id]);
  });

  it("locks the contractors of the file once each, in the order of their ids, after the villas", async () => {
    const villas = vi.spyOn(InMemorySmallWorksRepository.prototype, "lockVillasShared");
    const contractors = vi.spyOn(InMemorySmallWorksRepository.prototype, "lockContractorsShared");

    const res = await upload(
      await sheet(
        row({ ...baseCells, villa: "P-001", contractor: "Mona Co" }),
        row({ ...baseCells, villa: "P-002", contractor: "Hamdy Co" }),
        row({ ...baseCells, villa: "P-003", contractor: "Mona Co" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(contractors).toHaveBeenCalledTimes(1);
    expect(contractors.mock.calls[0]![0]).toEqual([hamdy.id, mona.id].sort());
    expect(villas.mock.invocationCallOrder[0]!).toBeLessThan(contractors.mock.invocationCallOrder[0]!);
  });

  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when a contractor was switched off after the check", async () => {
    smallWorkRaces.beforeImportLock = () => {
      contractorTables.contractors.find((c) => c.id === hamdy.id)!.status = "INACTIVE";
    };

    const res = await upload(await one());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when a contractor was deleted after the check", async () => {
    smallWorkRaces.beforeImportLock = () => {
      contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== hamdy.id);
    };

    const res = await upload(await one());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("is not thrown by a contractor the file does not use going away or being switched off", async () => {
    smallWorkRaces.beforeImportLock = () => {
      contractorTables.contractors.find((c) => c.id === mona.id)!.status = "INACTIVE";
    };

    const res = await upload(await one());

    expect(res.status).toBe(201);
  });

  it("answers 401 and saves nothing when the importing user cannot be found", async () => {
    vi.spyOn(InMemorySmallWorksRepository.prototype, "userExists").mockResolvedValue(false);

    const res = await upload(await one());

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    nothingWritten();
  });

  it("answers 500, not the changed-data conflict, when the write fails for another reason", async () => {
    vi.spyOn(InMemorySmallWorksRepository.prototype, "createMany").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });
});

describe("POST /small-works/import: the quantity and the unit are gone", () => {
  it("does not take a Quantity or a Unit column: a file that still has them is refused", async () => {
    const res = await upload(
      await workbookOf([
        [...HEADER, "Quantity", "Unit"],
        ["P-001", "2026-03-04", "2026-03-06", "a", "Hamdy Co", "", 2.5, "pcs"],
      ]),
    );

    expect(res.status).toBe(400);
    expect(created()).toHaveLength(0);
  });
});

describe("POST /small-works/import: the text limits are the API's", () => {
  const text = (length: number, letter = "w"): string => letter.repeat(length);

  it("accepts 500 characters of description, and stores them whole", async () => {
    const res = await upload(await one({ description: text(500) }));

    expect(res.status).toBe(201);
    expect(created()[0]?.description).toHaveLength(500);
  });

  it.each([["description", 501, "description"]] as const)(
    "refuses %s of %i characters as a row error on its own column",
    async (header, length, column) => {
      const res = await upload(await one({ [header]: text(length) }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE[column], "INVALID_VALUE"]]);
      nothingWritten();
    },
  );

  it("explains the description limit in the language of the request", async () => {
    const res = await upload(await one({ description: text(501) }), { language: "ar" });

    expect(res.body.data.errors[0].message).toBe("يجب أن يكون الوصف بين 1 و500 حرف");
  });

  it.each(KEYS)(
    "still refuses a cell of 2,001 characters in %s with the file-level 2,000 message",
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

  it("counts Unicode characters as the cell does", async () => {
    expect((await upload(await one({ description: "ش".repeat(500) }))).status).toBe(201);
    smallWorkTables.reset();
    importBatchTable.reset();
    const res = await upload(await one({ description: "ش".repeat(501) }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.description, "INVALID_VALUE"]]);
  });
});

describe("POST /small-works/import: a file that was exported", () => {
  it("can be imported again: every column of the export is a column the import reads", async () => {
    const source = [
      seedWork({
        startDate: day("2026-03-01"),
        endDate: day("2026-03-09"),
        description: "d".repeat(500),
        status: "DONE",
      }),
      seedWork({
        villaId: villa2.id,
        contractorId: mona.id,
        startDate: day("2026-03-02"),
        endDate: day("2026-03-02"),
        description: "Painted the gate",
      }),
    ];
    const exported = await request(app)
      .get("/api/v1/small-works/export?format=xlsx")
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
        startDate: cell(n, "Start Date"),
        endDate: cell(n, "End Date"),
        description: cell(n, "Description"),
        contractor: cell(n, "Contractor"),
        status: cell(n, "Status"),
      }),
    );
    // The rows are deleted, so the file imports onto an empty table.
    smallWorkTables.reset();

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2);
    const restored = (id: string) => created().find((work) => work.villaId === id)!;
    expect(restored(villa1.id)).toMatchObject({
      startDate: source[0]!.startDate,
      endDate: source[0]!.endDate,
      contractorId: hamdy.id,
      description: source[0]!.description,
      status: "DONE",
    });
    expect(restored(villa2.id)).toMatchObject({
      description: "Painted the gate",
      status: "PENDING",
      contractorId: mona.id,
    });
  });
});

describe("POST /small-works/import: dry run", () => {
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
    const file = await one({ status: "Cancelled" });

    const first = await upload(file, { query: "?dryRun=true" });
    const second = await upload(file, { query: "?dryRun=true" });

    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(false);
    expect(errorsOf(first)).toEqual([[2, TITLE.status, "INVALID_OPTION"]]);
    expect(second.status).toBe(200);
    nothingWritten();
  });

  it("does not stop the real import of the same file afterwards", async () => {
    const file = await one();
    await upload(file, { query: "?dryRun=true" });

    expect((await upload(file)).status).toBe(201);
  });
});

describe("POST /small-works/import: row errors (422, nothing is saved)", () => {
  it("lists every bad cell of every row, with the row, the column and the code", async () => {
    const res = await upload(
      await sheet(
        row({ ...baseCells, villa: "P-999" }),
        row({
          ...baseCells,
          villa: "P-001",
          startDate: "nope",
          description: "b",
          status: "Cancelled",
        }),
        row({
          villa: "P-001",
          startDate: "2026-03-05",
          endDate: "2026-03-05",
          contractor: "Hamdy Co",
        }),
        row({
          villa: "P-001",
          startDate: "2026-03-06",
          endDate: "2026-03-06",
          description: "d",
        }),
        row({}),
        row({ villa: "P-001" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.imported).toBe(0);
    expect(errorsOf(res)).toEqual([
      [2, TITLE.villa, "REFERENCE_NOT_FOUND"],
      [3, TITLE.startDate, "INVALID_VALUE"],
      [3, TITLE.status, "INVALID_OPTION"],
      [4, TITLE.description, "REQUIRED"],
      [5, TITLE.contractor, "REQUIRED"],
      [7, TITLE.startDate, "REQUIRED"],
      [7, TITLE.endDate, "REQUIRED"],
      [7, TITLE.description, "REQUIRED"],
      [7, TITLE.contractor, "REQUIRED"],
    ]);
    nothingWritten();
  });

  it("requires the contractor: there is no default", async () => {
    const res = await upload(await one({ contractor: null }));

    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REQUIRED"]]);
  });

  describe("the contractor cell", () => {
    it("is found by name or by phone, any case and spacing", async () => {
      const res = await upload(
        await sheet(
          row({ ...baseCells, villa: "P-001", contractor: "  MONA   co " }),
          row({ ...baseCells, villa: "P-002", contractor: "0100000 0001" }),
        ),
      );

      expect(res.status).toBe(201);
      expect(created().map((work) => work.contractorId)).toEqual([mona.id, hamdy.id]);
    });

    it("is refused as REFERENCE_NOT_FOUND when nobody has the name, with the message of the import", async () => {
      const res = await upload(await one({ contractor: "Nobody Co" }), { language: "ar" });

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REFERENCE_NOT_FOUND"]]);
      expect(res.body.data.errors[0].message).toBe("لا يوجد مقاول بهذا الاسم أو رقم الهاتف");
      nothingWritten();
    });

    it("is refused when the contractor is inactive, with the small works message", async () => {
      addContractor({ name: "Off Co", phone: "0100 000 0009", status: "INACTIVE" });

      const res = await upload(await one({ contractor: "Off Co" }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe(
        "This contractor is inactive and cannot be given a daily small work",
      );
      nothingWritten();
    });

    it("is refused as AMBIGUOUS_REFERENCE when two contractors have the name", async () => {
      addContractor({ name: "hamdy co", phone: "0100 000 0010" });

      const res = await upload(await one({ contractor: "Hamdy Co" }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "AMBIGUOUS_REFERENCE"]]);
    });

    it("is not the villa's: any active contractor does", async () => {
      villa1.contractorId = hamdy.id;

      const res = await upload(await one({ contractor: "Mona Co" }));

      expect(res.status).toBe(201);
      expect(created()[0]?.contractorId).toBe(mona.id);
    });
  });

  describe("the dates", () => {
    const bound = (years: number, offsetDays = 0): string => {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() + years);
      date.setUTCDate(date.getUTCDate() + offsetDays);
      return date.toISOString().slice(0, 10);
    };

    it("take a future date and a past one: there is no future rule", async () => {
      const res = await upload(
        await sheet(
          row({ ...baseCells, startDate: daysFromToday(1), endDate: daysFromToday(30) }),
          row({ ...baseCells, startDate: "2020-01-01", endDate: "2020-01-02" }),
        ),
      );

      expect(res.status).toBe(201);
    });

    it("refuse a date more than 10 years from today, on its own column, translated", async () => {
      const res = await upload(
        await sheet(
          row({ ...baseCells, startDate: bound(9), endDate: bound(10, -1) }),
          row({ ...baseCells, startDate: bound(11), endDate: bound(11) }),
        ),
        { language: "ar" },
      );

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([
        [3, TITLE.startDate, "INVALID_VALUE"],
        [3, TITLE.endDate, "INVALID_VALUE"],
      ]);
      expect(res.body.data.errors[0].message).toBe("يجب أن يكون التاريخ ضمن 10 سنوات من اليوم");
    });

    it("refuse an end before the start on the end date's column, and take one day", async () => {
      const res = await upload(
        await sheet(
          row({ ...baseCells, startDate: "2026-03-05", endDate: "2026-03-05" }),
          row({ ...baseCells, startDate: "2026-03-05", endDate: "2026-03-04" }),
        ),
      );

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[3, TITLE.endDate, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe("The end date cannot be before the start date");
      nothingWritten();
    });

    it("are required, each on its own column", async () => {
      const res = await upload(await one({ startDate: null, endDate: null }));

      expect(errorsOf(res)).toEqual([
        [2, TITLE.startDate, "REQUIRED"],
        [2, TITLE.endDate, "REQUIRED"],
      ]);
    });
  });

  it("refuses numbers where text is expected", async () => {
    const res = await upload(
      await one({
        description: 12 as unknown as string,
        contractor: 7 as unknown as string,
      }),
    );

    expect(errorsOf(res)).toEqual([
      [2, TITLE.description, "NOT_TEXT"],
      [2, TITLE.contractor, "NOT_TEXT"],
    ]);
  });

  it("says what is wrong in the language of the request", async () => {
    const res = await upload(await one({ status: "Cancelled", description: "x".repeat(501) }), {
      language: "ar",
    });

    const messages = (res.body.data.errors as ReportError[]).map((error) => error.message);
    expect(messages).toContain("هذه القيمة ليست من القيم المسموح بها");
    expect(messages).toContain("يجب أن يكون الوصف بين 1 و500 حرف");
  });

  it("saves nothing when one row of many is bad", async () => {
    const res = await upload(
      await sheet(
        row({ ...baseCells, villa: "P-001" }),
        row({ ...baseCells, villa: "P-002" }),
        row({ ...baseCells, villa: "P-003", status: "Cancelled" }),
      ),
    );

    expect(res.status).toBe(422);
    nothingWritten();
  });
});

describe("POST /small-works/import: the same file twice (the only guard against a double import)", () => {
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

    const changed = await upload(await one({ description: "A different socket" }));

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

describe("POST /small-works/import: a villa goes away during the import", () => {
  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when the villa went away after the check", async () => {
    smallWorkRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa2.id);
    };

    const res = await upload(
      await sheet(
        row({ ...baseCells, villa: "P-001" }),
        row({ ...baseCells, villa: "P-002", description: "b" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("is not thrown by a villa the file does not use going away", async () => {
    smallWorkRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa3.id);
    };

    const res = await upload(await one());

    expect(res.status).toBe(201);
  });
});

describe("POST /small-works/import: the request", () => {
  it("answers 400 NO_FILE_PROVIDED without a file", async () => {
    const res = await upload(null);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 415 to a file that is not .xlsx", async () => {
    const res = await upload(await one(), { filename: "small-works.csv" });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 IMPORT_HEADER_MISMATCH when a column is missing, unknown or repeated", async () => {
    const missing = await upload(
      await workbookOf([
        ["villa", "startDate"],
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
    const doneBy = await upload(
      await workbookOf([
        [...HEADER, "Done By"],
        [...row({ villa: "P-001" }), "x"],
      ]),
    );
    const workDate = await upload(
      await workbookOf([
        [...HEADER.filter((title) => title !== TITLE.startDate), "Work Date"],
        [...row({ villa: "P-001" }).filter((_, at) => at !== 1), "2026-03-04"],
      ]),
    );

    for (const res of [missing, unknown, repeated, doneBy, workDate]) {
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
            startDate: new Date(Date.UTC(2020, 0, 1 + (n % 300))),
            endDate: new Date(Date.UTC(2020, 0, 1 + (n % 300))),
            description: "x",
            contractor: "Hamdy Co",
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
    const user = employee("limited@example.test", "small-works:import");

    expect((await upload(await one({ description: "a" }), { user })).status).toBe(201);
    expect((await upload(await one({ description: "b" }), { user })).status).toBe(201);
    const third = await upload(await one({ description: "c" }), { user });

    expect(third.status).toBe(429);
  });

  it("counts the template against the same allowance", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("template@example.test", "small-works:import");

    const first = await request(app)
      .get("/api/v1/small-works/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/small-works/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });

  it("answers 422 when the Idempotency-Key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({ description: "First" }), { key });
    const other = await upload(await one({ description: "Second" }), { key });

    const dryKey = newKey();
    const file = await one({ description: "Third" });
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

describe("POST /small-works/import: a file that was exported", () => {
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

describe("GET /small-works/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/small-works/import/template")
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

  it("has a dropdown on the villa, the contractor and the status, and on no other column", async () => {
    expect(dropdownsOf(await template())).toEqual({
      "Villa Number": ["P-001", "P-002", "P-003"],
      Contractor: ["Hamdy Co", "Mona Co"],
      Status: ["Pending", "Done"],
    });
  });

  it("offers only the active contractors, by the name or phone the import resolves", async () => {
    addContractor({ name: "Off Co", phone: "0100 000 0009", status: "INACTIVE" });
    addContractor({ name: "mona co", phone: "0100 000 0011" });

    const choices = dropdownsOf(await template()).Contractor;

    // The two contractors named Mona Co are told apart by their phones, as the import resolves them; Off Co is not offered.
    expect(choices).toEqual(["0100 000 0002", "0100 000 0011", "Hamdy Co"]);
  });

  it("offers only values the import accepts: a file with every choice, one per row, is good", async () => {
    const choices = dropdownsOf(await template());
    const rows = Array.from({ length: 3 }, (_, at) =>
      row({
        villa: choices["Villa Number"]![at % choices["Villa Number"]!.length],
        startDate: `2026-03-0${at + 1}`,
        endDate: `2026-03-0${at + 2}`,
        description: `Job ${at}`,
        contractor: choices.Contractor![at % choices.Contractor!.length],
        status: choices.Status![at % choices.Status!.length],
      }),
    );
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res)).toEqual([]);
    expect(res.body.data).toMatchObject({ ok: true, total: 3 });
  });

  it("imports a filled-in template with the Lists sheet still in it", async () => {
    const bytes = await filledTemplate(await template(), [
      "P-003",
      "2026-03-04",
      "2026-03-06",
      "Replaced a broken socket",
      "Hamdy Co",
      "Done",
    ]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({
      villaId: villa3.id,
      contractorId: hamdy.id,
      description: "Replaced a broken socket",
    });
  });
});
