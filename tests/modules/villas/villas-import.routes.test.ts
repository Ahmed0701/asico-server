import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addArea, areaTables, type StoredArea } from "../areas/in-memory-areas.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { addPhase, phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { progressTables } from "../villa-progress/progress-tables.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { workbookOf } from "../../shared/import/xlsx-fixtures.js";
import {
  addVilla,
  InMemoryVillasRepository,
  NUMBER_CONSTRAINT,
  PLOT_CONSTRAINT,
  uniqueError,
  villaTables,
} from "./in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("./in-memory-villas.repository.js")).InMemoryVillasRepository,
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
import { villaCurrencyField } from "../../../src/modules/villas/validators/villas.validators.js";
import { env } from "../../../src/core/config/env.js";
import { IMPORT_TRANSACTION_TIMEOUT_MS } from "../../../src/core/imports/index.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADER = [
  "Villa Number",
  "Owner Name",
  "Area",
  "Block",
  "Plot",
  "Contractor",
  "Electrical Engineer",
  "Civil Engineer",
  "Start Date",
  "Target Date",
  "Budget",
] as const;
type Header = (typeof HEADER)[number];
const ARABIC = /[؀-ۿ]/;
const original = { limit: env.IMPORT_RATE_LIMIT_MAX };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

let admin: User;
let cairo: StoredArea;
let palmGiza: StoredArea;
let palmAlex: StoredArea;
let zayed: StoredArea;
let mona: ReturnType<typeof addEngineer>;
let karim: ReturnType<typeof addEngineer>;
let hamdy: ReturnType<typeof addElectricalEngineer>;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;
let phases: ReturnType<typeof addPhase>[];

beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  engineerTables.reset();
  electricalTables.reset();
  phaseTables.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  cairo = addArea({ name: "New Cairo", city: "Cairo" });
  palmGiza = addArea({ name: "Palm Hills", city: "Giza" });
  palmAlex = addArea({ name: "Palm Hills", city: "Alexandria" });
  zayed = addArea({ name: "Sheikh Zayed", city: "Giza" });
  mona = addEngineer({ name: "Mona Adel", phone: "0100 111 2222" });
  karim = addEngineer({ name: "Karim Sami", phone: "0100 333 4444" });
  hamdy = addElectricalEngineer({ name: "Hamdy Salah", phone: "0111 555 6666" });
  nile = addContractor({ name: "Nile Builders", phone: "0122 777 8888" });
  delta = addContractor({ name: "Delta Works", phone: "0155 999 0000" });
  // Two active phases and one that is switched off: a villa gets a progress row for each of the three.
  phases = [
    addPhase({ name: "Wiring" }),
    addPhase({ name: "Finishing" }),
    addPhase({ name: "Retired", status: "INACTIVE" }),
  ];
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
  HEADER.map((header) => cells[header] ?? null);
const sheet = (...rows: ExcelJS.CellValue[][]): Promise<Buffer> => workbookOf([[...HEADER], ...rows]);
// A row that is good on its own; the cells given replace its own.
const good = (cells: Partial<Record<Header, ExcelJS.CellValue>> = {}): ExcelJS.CellValue[] =>
  row({
    "Villa Number": "V-001",
    Area: "New Cairo",
    Block: "B1",
    Plot: "1",
    "Civil Engineer": "Mona Adel",
    ...cells,
  });
const one = (cells: Partial<Record<Header, ExcelJS.CellValue>> = {}): Promise<Buffer> => sheet(good(cells));
const newKey = (): string => `key-${randomUUID()}`;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

type UploadOptions = {
  user?: User;
  language?: string;
  key?: string | null;
  query?: string;
  filename?: string;
};
async function upload(file: Buffer | null, options: UploadOptions = {}) {
  const { user = admin, language = "en", key = newKey(), query = "", filename = "villas.xlsx" } = options;
  const req = request(app)
    .post(`/api/v1/villas/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach("file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "villa.import");
const createAudit = () => store.auditRows.filter((entry) => entry.action === "villa.create");
const created = () => villaTables.villas;
const nothingWritten = (): void => {
  expect(created()).toHaveLength(0);
  expect(progressTables.rows).toHaveLength(0);
  expect(importBatchTable.rows).toHaveLength(0);
  expect(importAudit()).toHaveLength(0);
  expect(createAudit()).toHaveLength(0);
};
type ReportError = { row: number; column: string; code: string; message: string; value: unknown };
const errorsOf = (res: request.Response): [number, string, string][] =>
  (res.body.data.errors as ReportError[]).map((error) => [error.row, error.column, error.code]);
const byNumber = (villaNumber: string) => created().find((villa) => villa.villaNumber === villaNumber)!;

// What another request does after the file was checked and before it is saved: the first call of the phase-set lock, which is
// the first thing the save does.
const happensBeforeSave = (action: () => void): void => {
  vi.spyOn(InMemoryVillasRepository.prototype, "lockPhaseSet").mockImplementationOnce(async () => {
    action();
  });
};

describe("access control", () => {
  const endpoints = [
    ["get", "/villas/import/template"],
    ["post", "/villas/import"],
  ] as const;
  const others = [
    "villas:read",
    "villas:detail",
    "villas:create",
    "villas:update",
    "villas:delete",
    "villas:export",
    "villas:progress",
    "villas:inspection",
    "contractors:import",
    "open-works:import",
    "daily-labour:import",
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

  it.each(endpoints)(
    "%s %s is not opened by any other permission, villas:create included",
    async (verb, path) => {
      const res = await call(verb, path).set(await as(employee("e@example.test", ...others)));

      expect(res.status).toBe(403);
    },
  );

  it("does not let villas:import open the other villa routes", async () => {
    const headers = await as(employee("importer@example.test", "villas:import"));

    expect((await request(app).get("/api/v1/villas").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/villas").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/villas/export?format=xlsx").set(headers)).status).toBe(403);
  });

  it("lets the holder of villas:import use both routes", async () => {
    const user = employee("importer@example.test", "villas:import");

    expect(
      (
        await request(app)
          .get("/api/v1/villas/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one(), { user })).status).toBe(201);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /villas/:id", async () => {
    const res = await request(app)
      .get("/api/v1/villas/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /villas/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/villas/import/template")
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
  const textOf = (worksheet: ExcelJS.Worksheet): string => {
    const text: string[] = [];
    worksheet.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    return text.join(" | ");
  };

  it("sends an .xlsx file, English whatever the request language, never cached", async () => {
    const res = await download("ar");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="villas-import-template.xlsx"');
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row of the eleven columns of the sample file, in order, then the optional Currency", async () => {
    const workbook = await workbookOfTemplate();

    expect(workbook.worksheets[0]!.name).toBe("Villas");
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, ...HEADER, "Currency"]);
    expect(HEADER).toHaveLength(11);
  });

  it("has an example row that cannot be imported by mistake: its area and people do not exist", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(1).value).toBe("V-001");
    expect(data.getRow(2).getCell(3).value).toBe("New Cairo");
    // The example budget has the three decimals of the default currency.
    expect(data.getRow(2).getCell(11).value).toBe("1250000.500");
    const example = await upload(
      await workbookOfTemplate()
        .then((w) => w.xlsx.writeBuffer())
        .then(Buffer.from),
      {
        query: "?dryRun=true",
      },
    );
    expect(example.status).toBe(200);
    expect(example.body.data.ok).toBe(false);
  });

  it("says which columns are required: the number, the area, the block, the plot and the civil engineer", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const required: Record<string, string> = {};
    instructions.eachRow((r) => {
      if (HEADER.includes(r.getCell(1).text as never)) required[r.getCell(1).text] = r.getCell(2).text;
    });

    expect(required).toEqual({
      "Villa Number": "Yes",
      "Owner Name": "No",
      Area: "Yes",
      Block: "Yes",
      Plot: "Yes",
      Contractor: "No",
      "Electrical Engineer": "No",
      "Civil Engineer": "Yes",
      "Start Date": "No",
      "Target Date": "No",
      Budget: "No",
    });
  });

  it("explains the area form, the people by name or phone, the dates and the budget in the currency of its column", async () => {
    const all = textOf((await workbookOfTemplate()).getWorksheet("Instructions")!);

    expect(all).toContain("Import villas");
    expect(all).toContain("Name, City");
    expect(all).toContain("by name or by phone");
    expect(all).toContain("YYYY-MM-DD");
    expect(all).not.toContain("Egyptian");
    expect(all).toContain("KWD when there is none");
    expect(all).toContain("three for KWD");
    expect(all).toContain("two for EGP or USD, none for JPY");
    expect(all).toContain("A cell holds up to 2,000 characters.");
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });
});

describe("POST /villas/import: a file shaped like the client's sample", () => {
  // Villa number, block and plot as number cells, a block as text, dates as text and as date cells, a budget as a number and
  // as text, spaces around the values, an Arabic owner, and the cells nobody filled in left empty.
  const sample = () =>
    sheet(
      row({
        "Villa Number": 2235,
        "Owner Name": "Karim Fawzy",
        Area: "New Cairo",
        Block: "4",
        Plot: 30,
        Contractor: "Nile Builders",
        "Electrical Engineer": "Hamdy Salah",
        "Civil Engineer": "Mona Adel",
        "Start Date": "2026-01-15",
        "Target Date": day("2026-09-30"),
        Budget: 1250000.5,
      }),
      row({
        "Villa Number": "  V-2236  ",
        "Owner Name": "  أحمد علي  ",
        Area: " palm  hills , GIZA ",
        Block: " B2 ",
        Plot: "14",
        Contractor: "0122-777-8888",
        "Civil Engineer": "0100 333 4444",
        "Start Date": day("2026-02-01"),
        "Target Date": "2026-12-31",
        Budget: "99.99",
      }),
      row({
        "Villa Number": 2237,
        Area: "Sheikh Zayed",
        Block: 1,
        Plot: 2,
        "Civil Engineer": "karim sami",
      }),
    );

  it("saves every villa with its values: numbers read as text, dates as days, the budget in fils (the default currency is KWD)", async () => {
    const res = await upload(await sample());

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
    expect(byNumber("2235")).toMatchObject({
      ownerName: "Karim Fawzy",
      areaId: cairo.id,
      block: "4",
      plot: "30",
      contractorId: nile.id,
      electricalEngineerId: hamdy.id,
      civilEngineerId: mona.id,
      startDate: day("2026-01-15"),
      targetDate: day("2026-09-30"),
      budgetMinor: 1_250_000_500,
      currency: "KWD",
      createdById: admin.id,
      version: 1,
    });
    expect(byNumber("V-2236")).toMatchObject({
      ownerName: "أحمد علي",
      areaId: palmGiza.id,
      block: "B2",
      plot: "14",
      contractorId: nile.id,
      electricalEngineerId: null,
      civilEngineerId: karim.id,
      startDate: day("2026-02-01"),
      targetDate: day("2026-12-31"),
      budgetMinor: 99_990,
      currency: "KWD",
    });
  });

  it("leaves what the file leaves empty empty: no owner, no contractor, no electrical engineer, no dates, no budget and no currency", async () => {
    await upload(await sample());

    expect(byNumber("2237")).toMatchObject({
      ownerName: null,
      areaId: zayed.id,
      block: "1",
      plot: "2",
      contractorId: null,
      electricalEngineerId: null,
      civilEngineerId: karim.id,
      startDate: null,
      targetDate: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("gives every villa a progress row for every phase, the switched-off one too, at 0", async () => {
    await upload(await sample());

    expect(progressTables.rows).toHaveLength(9);
    for (const villa of created()) {
      const own = progressTables.rows.filter((progress) => progress.villaId === villa.id);
      expect(own.map((progress) => progress.elecPhaseId).sort()).toEqual(
        phases.map((phase) => phase.id).sort(),
      );
      expect(own.every((progress) => progress.progress === 0 && progress.version === 1)).toBe(true);
    }
  });

  it("writes a villa.create entry for each villa, as a villa created by hand would, then one villa.import entry", async () => {
    const file = await sample();

    const res = await upload(file);

    expect(createAudit()).toHaveLength(3);
    // Each entry carries where the request came from and its id, like any other entry.
    for (const entry of [...createAudit(), ...importAudit()]) {
      expect(entry).toMatchObject({ ip: expect.any(String), requestId: res.headers["x-request-id"] });
    }
    expect(createAudit().map((entry) => entry.entityId)).toEqual(created().map((villa) => villa.id));
    expect(createAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "Villa",
      after: {
        villaNumber: "2235",
        ownerName: "Karim Fawzy",
        areaId: cairo.id,
        block: "4",
        plot: "30",
        civilEngineerId: mona.id,
        electricalEngineerId: hamdy.id,
        contractorId: nile.id,
        startDate: "2026-01-15",
        targetDate: "2026-09-30",
        budgetMinor: 1_250_000_500,
        currency: "KWD",
      },
    });
    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      entity: "Villa",
      after: { rows: 3, fileHash: sha256(file), createdIds: created().map((villa) => villa.id) },
    });
    expect(importBatchTable.rows).toMatchObject([{ entity: "Villa", rows: 3, userId: admin.id }]);
  });

  it("is a dry run that saves nothing and says the file is good", async () => {
    const res = await upload(await sample(), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: true,
      total: 3,
      imported: 0,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    nothingWritten();
  });

  it("reports the rows that are missing what is required, whatever else is filled in", async () => {
    const res = await upload(
      await sheet(
        // The area and the civil engineer are empty, as are the contractor and the electrical engineer.
        row({ "Villa Number": 2301, Block: "4", Plot: 30 }),
        // Only the civil engineer is empty.
        row({ "Villa Number": 2302, Area: "New Cairo", Block: "4", Plot: 31, Contractor: "Nile Builders" }),
        // Only the area is empty.
        row({ "Villa Number": 2303, Block: "4", Plot: 32, "Civil Engineer": "Mona Adel" }),
        // The number, the block and the plot are empty.
        row({ Area: "New Cairo", "Civil Engineer": "Mona Adel" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [2, "Area", "REQUIRED"],
      [2, "Civil Engineer", "REQUIRED"],
      [3, "Civil Engineer", "REQUIRED"],
      [4, "Area", "REQUIRED"],
      [5, "Villa Number", "REQUIRED"],
      [5, "Block", "REQUIRED"],
      [5, "Plot", "REQUIRED"],
    ]);
    expect(res.body.data.errors[0].message).toBe("This field is required");
    nothingWritten();
  });

  it("does not ask for the contractor, the electrical engineer, the owner, the dates or the budget", async () => {
    const res = await upload(await one());

    expect(res.status).toBe(201);
    expect(byNumber("V-001")).toMatchObject({
      ownerName: null,
      contractorId: null,
      electricalEngineerId: null,
      startDate: null,
      targetDate: null,
      budgetMinor: null,
      currency: null,
    });
  });

  it("reads a number in the owner column as its digits too", async () => {
    await upload(await one({ "Owner Name": 12345 }));

    expect(byNumber("V-001").ownerName).toBe("12345");
  });

  it("takes the digits of a number cell exactly: 0, a big whole number, 4.0", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": 0, Plot: 1 }),
        good({ "Villa Number": 999_999_999_999_999, Plot: 2 }),
        good({ "Villa Number": 4.0, Plot: 3 }),
      ),
    );

    expect(res.status).toBe(201);
    expect(created().map((villa) => villa.villaNumber)).toEqual(["0", "999999999999999", "4"]);
  });
});

describe("POST /villas/import: numbers where text is expected", () => {
  it.each([
    ["Villa Number", 22.5],
    ["Villa Number", -2235],
    ["Block", 1.5],
    ["Plot", -3],
    ["Plot", 1e16],
    ["Owner Name", 0.5],
  ] as const)(
    "refuses %s = %j as INVALID_VALUE, with the message about whole numbers",
    async (column, value) => {
      const res = await upload(await one({ [column]: value }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, column, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe(
        "A number here must be a whole number, 0 or more, with at most 15 digits. Write anything else as text",
      );
      nothingWritten();
    },
  );

  it("says it in Arabic on request", async () => {
    const res = await upload(await one({ Plot: 2.5 }), { language: "ar" });

    expect(res.body.data.errors[0].message).toMatch(ARABIC);
  });

  it.each(["Area", "Contractor", "Electrical Engineer", "Civil Engineer"] as const)(
    "refuses a number in %s as NOT_TEXT: a phone number typed into a General cell lost its leading zero",
    async (column) => {
      const res = await upload(await one({ [column]: 1001112222 }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, column, "NOT_TEXT"]]);
      nothingWritten();
    },
  );

  it("refuses too long a text, with the same message as a villa created by hand", async () => {
    const res = await upload(await one({ Block: "b".repeat(51), "Owner Name": "o".repeat(121) }));

    expect(errorsOf(res)).toEqual([
      [2, "Owner Name", "INVALID_VALUE"],
      [2, "Block", "INVALID_VALUE"],
    ]);
  });

  it("takes a text of the longest length, the Arabic one included", async () => {
    const res = await upload(await one({ Block: "ب".repeat(50), "Owner Name": "م".repeat(120) }));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ block: "ب".repeat(50), ownerName: "م".repeat(120) });
  });
});

describe("POST /villas/import: the area", () => {
  it("is found by name whatever the case and spaces", async () => {
    await upload(await one({ Area: "  nEW   cairo " }));

    expect(created()[0]!.areaId).toBe(cairo.id);
  });

  it("is ambiguous when two areas have the name, and Name, City names one", async () => {
    const ambiguous = await upload(await one({ Area: "Palm Hills" }));
    const alexandria = await upload(await one({ Area: "Palm Hills, Alexandria" }));

    expect(ambiguous.status).toBe(422);
    expect(errorsOf(ambiguous)).toEqual([[2, "Area", "AMBIGUOUS_REFERENCE"]]);
    expect(ambiguous.body.data.errors[0].message).toBe(
      "More than one area has this name. Write it as Name, City",
    );
    expect(alexandria.status).toBe(201);
    expect(created()[0]!.areaId).toBe(palmAlex.id);
  });

  it("is not found when it does not exist, and nothing is made up", async () => {
    const res = await upload(await sheet(good({ Area: "Nowhere" }), good({ Area: "Palm Hills, Cairo" })));

    expect(errorsOf(res)).toEqual([
      [2, "Area", "REFERENCE_NOT_FOUND"],
      [3, "Area", "REFERENCE_NOT_FOUND"],
    ]);
    expect(res.body.data.errors[0].message).toBe("No area has this name");
    expect(areaTables.areas).toHaveLength(4);
    nothingWritten();
  });
});

describe("POST /villas/import: the contractor and the engineers", () => {
  it("are found by name or by phone, in any case and spacing", async () => {
    await upload(
      await sheet(
        good({
          "Villa Number": "A",
          Plot: "1",
          Contractor: " NILE  builders ",
          "Civil Engineer": "mona adel",
        }),
        good({
          "Villa Number": "B",
          Plot: "2",
          Contractor: "0122 777 8888",
          "Electrical Engineer": "0111-555-6666",
          "Civil Engineer": "0100-111-2222",
        }),
      ),
    );

    expect(byNumber("A")).toMatchObject({ contractorId: nile.id, civilEngineerId: mona.id });
    expect(byNumber("B")).toMatchObject({
      contractorId: nile.id,
      electricalEngineerId: hamdy.id,
      civilEngineerId: mona.id,
    });
  });

  it("are not found when they do not exist, each with its own message", async () => {
    const res = await upload(
      await one({ Contractor: "Nobody", "Electrical Engineer": "0100 000 0000", "Civil Engineer": "Ghost" }),
    );

    expect(errorsOf(res)).toEqual([
      [2, "Contractor", "REFERENCE_NOT_FOUND"],
      [2, "Electrical Engineer", "REFERENCE_NOT_FOUND"],
      [2, "Civil Engineer", "REFERENCE_NOT_FOUND"],
    ]);
    expect((res.body.data.errors as ReportError[]).map((error) => error.message)).toEqual([
      "No contractor has this name or phone",
      "No electrical engineer has this name or phone",
      "No civil engineer has this name or phone",
    ]);
    expect(contractorTables.contractors).toHaveLength(2);
    nothingWritten();
  });

  it("are ambiguous when two share the name, or one's name is another's phone: never a guess", async () => {
    addContractor({ name: "nile builders", phone: "0100 000 0001" });
    addEngineer({ name: "Mona Adel", phone: "0100 000 0002" });
    addElectricalEngineer({ name: "0111 555 6666", phone: "0100 000 0003" });

    const res = await upload(
      await one({
        Contractor: "Nile Builders",
        "Electrical Engineer": "0111 555 6666",
        "Civil Engineer": "Mona Adel",
      }),
    );

    expect(errorsOf(res)).toEqual([
      [2, "Contractor", "AMBIGUOUS_REFERENCE"],
      [2, "Electrical Engineer", "AMBIGUOUS_REFERENCE"],
      [2, "Civil Engineer", "AMBIGUOUS_REFERENCE"],
    ]);
    expect(res.body.data.errors[0].message).toBe(
      "More than one record has this name or phone. Use the phone number instead of the name",
    );
    nothingWritten();
  });

  it("an ambiguous name is settled by the phone", async () => {
    addEngineer({ name: "Mona Adel", phone: "0100 000 0002" });

    const res = await upload(await one({ "Civil Engineer": "0100 111 2222" }));

    expect(res.status).toBe(201);
    expect(created()[0]!.civilEngineerId).toBe(mona.id);
  });

  it("are refused when switched off, with a message that says so", async () => {
    nile.status = "INACTIVE";
    hamdy.status = "INACTIVE";
    mona.status = "INACTIVE";

    const res = await upload(
      await one({
        Contractor: "Nile Builders",
        "Electrical Engineer": "Hamdy Salah",
        "Civil Engineer": "Mona Adel",
      }),
    );

    expect(errorsOf(res)).toEqual([
      [2, "Contractor", "INVALID_VALUE"],
      [2, "Electrical Engineer", "INVALID_VALUE"],
      [2, "Civil Engineer", "INVALID_VALUE"],
    ]);
    expect(res.body.data.errors[2].message).toBe(
      "This civil engineer is inactive and cannot be assigned to a villa",
    );
    nothingWritten();
  });
});

describe("POST /villas/import: the dates and the budget", () => {
  it("takes a day as text or as a date cell, and the day is the same whichever way", async () => {
    await upload(
      await sheet(
        good({ "Villa Number": "T", Plot: "1", "Start Date": "2026-03-01", "Target Date": "2026-03-31" }),
        good({
          "Villa Number": "D",
          Plot: "2",
          "Start Date": day("2026-03-01"),
          "Target Date": day("2026-03-31"),
        }),
        good({ "Villa Number": "S", Plot: "3", "Start Date": "2026-03-01", "Target Date": "2026-03-01" }),
      ),
    );

    for (const number of ["T", "D"]) {
      expect(byNumber(number)).toMatchObject({ startDate: day("2026-03-01"), targetDate: day("2026-03-31") });
    }
    expect(byNumber("S")).toMatchObject({ startDate: day("2026-03-01"), targetDate: day("2026-03-01") });
  });

  it("refuses a day that is not one, and a target before the start, on the Target Date", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Plot: "1", "Start Date": "15/01/2026" }),
        good({ "Villa Number": "B", Plot: "2", "Target Date": "2026-02-30" }),
        good({ "Villa Number": "C", Plot: "3", "Start Date": "2026-05-02", "Target Date": "2026-05-01" }),
        good({
          "Villa Number": "D",
          Plot: "4",
          "Start Date": day("2026-05-02"),
          "Target Date": day("2026-05-01"),
        }),
        good({ "Villa Number": "E", Plot: "5", "Start Date": 46000 }),
      ),
    );

    expect(errorsOf(res)).toEqual([
      [2, "Start Date", "INVALID_VALUE"],
      [3, "Target Date", "INVALID_VALUE"],
      [4, "Target Date", "INVALID_VALUE"],
      [5, "Target Date", "INVALID_VALUE"],
      [6, "Start Date", "INVALID_VALUE"],
    ]);
    expect(res.body.data.errors[2].message).toBe("The target date must not be before the start date");
    nothingWritten();
  });

  it("takes a target with no start, and a start with no target", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Plot: "1", "Target Date": "2026-05-01" }),
        good({ "Villa Number": "B", Plot: "2", "Start Date": "2026-05-01" }),
      ),
    );

    expect(res.status).toBe(201);
  });

  // Without a Currency column the budget is in the default currency, KWD: three decimals, 1000 fils to the dinar.
  it.each([
    [1250000.5, 1_250_000_500],
    [0, 0],
    [0.29, 290],
    [0.001, 1],
    ["1.234", 1234],
    ["1250000.500", 1_250_000_500],
    ["  75 ", 75_000],
    [100, 100_000],
    [9_007_199_254_740, 9_007_199_254_740_000],
    ["9007199254740.991", Number.MAX_SAFE_INTEGER],
  ] as const)("reads the budget %j as %j fils, in KWD", async (budget, minor) => {
    const res = await upload(await one({ Budget: budget }));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ budgetMinor: minor, currency: "KWD" });
  });

  it.each([
    -1,
    "-5",
    0.0001,
    "1.2345",
    "1e3",
    "abc",
    "12 KWD",
    "1,000",
    true,
    90_071_992_547_410,
    "9007199254740.992",
  ])("refuses the budget %j with the message about the decimals of the currency", async (budget) => {
    const res = await upload(await one({ Budget: budget }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, "Budget", "INVALID_VALUE"]]);
    expect(res.body.data.errors[0].message).toContain("The budget must be an amount, 0 or more");
    expect(res.body.data.errors[0].message).toBe(
      "The budget must be an amount, 0 or more, with no more decimals than its currency has (three for KWD, two for EGP or USD, none for JPY, for example 1250.500)",
    );
    nothingWritten();
  });

  it("stores no currency without a budget", async () => {
    await upload(await one());

    expect(created()[0]).toMatchObject({ budgetMinor: null, currency: null });
  });
});

describe("POST /villas/import: one villa number, one plot", () => {
  it("refuses a villa number twice in the file, whatever its case or spaces or whether it is a number, on every later row", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "V-001", Plot: "1" }),
        good({ "Villa Number": " v-001 ", Plot: "2" }),
        good({ "Villa Number": 2235, Plot: "3" }),
        good({ "Villa Number": "2235", Plot: "4" }),
        good({ "Villa Number": "V  001", Plot: "5" }),
        good({ "Villa Number": "V-001", Plot: "6" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [3, "Villa Number", "DUPLICATE_IN_FILE"],
      [5, "Villa Number", "DUPLICATE_IN_FILE"],
      [7, "Villa Number", "DUPLICATE_IN_FILE"],
    ]);
    expect(res.body.data.errors[0]).toMatchObject({
      message: "This villa number appears more than once in the file",
      value: " v-001 ",
    });
    nothingWritten();
  });

  it("refuses a villa number a stored villa has, in any case: stricter than creating a villa by hand", async () => {
    addVilla({ villaNumber: "V-001", areaId: zayed.id, block: "Z", plot: "9" });
    addVilla({ villaNumber: "2235", areaId: zayed.id, block: "Z", plot: "8" });

    const res = await upload(
      await sheet(
        good({ "Villa Number": "v-001", Plot: "1" }),
        good({ "Villa Number": 2235, Plot: "2" }),
        good({ "Villa Number": "V-002", Plot: "3" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [2, "Villa Number", "DUPLICATE_EXISTING"],
      [3, "Villa Number", "DUPLICATE_EXISTING"],
    ]);
    expect(res.body.data.errors[0].message).toBe("A villa with this number already exists");
    expect(created()).toHaveLength(2);
  });

  it("refuses the same area, block and plot twice in the file, on the Plot column, however they are written", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Block: "4", Plot: 30 }),
        good({ "Villa Number": "B", Block: " 4 ", Plot: "30" }),
        good({ "Villa Number": "C", Area: "new cairo", Block: "4", Plot: " 30" }),
        // Another area, another block and another plot are other places.
        good({ "Villa Number": "D", Area: "Sheikh Zayed", Block: "4", Plot: "30" }),
        good({ "Villa Number": "E", Block: "5", Plot: "30" }),
        good({ "Villa Number": "F", Block: "4", Plot: "31" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [3, "Plot", "DUPLICATE_IN_FILE"],
      [4, "Plot", "DUPLICATE_IN_FILE"],
    ]);
    expect(res.body.data.errors[0].message).toBe(
      "This area, block and plot appear more than once in the file",
    );
    expect(res.body.data.errors[0].value).toBe("30");
  });

  it("treats a letter case and an area of the same name in another city as the right places", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Area: "Palm Hills, Giza", Block: "B", Plot: "1" }),
        good({ "Villa Number": "B", Area: "Palm Hills, Alexandria", Block: "B", Plot: "1" }),
        good({ "Villa Number": "C", Area: "Palm Hills, Giza", Block: "b", Plot: "1" }),
      ),
    );

    expect(errorsOf(res)).toEqual([[4, "Plot", "DUPLICATE_IN_FILE"]]);
  });

  it("refuses a place a stored villa stands on, on the Plot column", async () => {
    addVilla({ villaNumber: "OLD", areaId: cairo.id, block: "4", plot: "30" });

    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Block: "4", Plot: 30 }),
        good({ "Villa Number": "B", Block: "4", Plot: 31 }),
        good({ "Villa Number": "C", Area: "Sheikh Zayed", Block: "4", Plot: 30 }),
        good({ "Villa Number": "D", Block: " 4", Plot: "30 " }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [2, "Plot", "DUPLICATE_EXISTING"],
      // D is the same place as A (both spelled differently), which is also stored.
      [5, "Plot", "DUPLICATE_IN_FILE"],
      [5, "Plot", "DUPLICATE_EXISTING"],
    ]);
    expect(res.body.data.errors[0].message).toBe("A villa already stands on this area, block and plot");
    expect(created()).toHaveLength(1);
  });

  it("reports both the number and the place of one row when both are taken, the number first", async () => {
    addVilla({ villaNumber: "V-001", areaId: cairo.id, block: "B1", plot: "1" });

    const res = await upload(await one());

    expect(errorsOf(res)).toEqual([
      [2, "Villa Number", "DUPLICATE_EXISTING"],
      [2, "Plot", "DUPLICATE_EXISTING"],
    ]);
  });

  it("does not ask the places of rows that did not parse: a bad row is reported once", async () => {
    const res = await upload(
      await sheet(
        good({ "Villa Number": "A", Area: "Nowhere" }),
        good({ "Villa Number": "B", Area: "Nowhere" }),
      ),
    );

    expect(errorsOf(res)).toEqual([
      [2, "Area", "REFERENCE_NOT_FOUND"],
      [3, "Area", "REFERENCE_NOT_FOUND"],
    ]);
  });

  it("says the duplicates in Arabic on request", async () => {
    addVilla({ villaNumber: "OLD", areaId: cairo.id, block: "B1", plot: "1" });

    const res = await upload(
      await sheet(good({ "Villa Number": "A" }), good({ "Villa Number": "A", Plot: "2" })),
      {
        language: "ar",
      },
    );

    expect((res.body.data.errors as ReportError[]).map((error) => [error.column, error.message])).toEqual([
      ["Plot", "توجد فيلا بالفعل على هذه المنطقة والمجمع والقطعة"],
      ["Villa Number", "رقم الفيلا هذا مكرر في الملف"],
    ]);
  });

  it("lets the same number and place through when the stored villa is on another place", async () => {
    addVilla({ villaNumber: "OLD", areaId: zayed.id, block: "B1", plot: "1" });

    const res = await upload(await one());

    expect(res.status).toBe(201);
  });

  it("saves nothing when one row of many is bad", async () => {
    const rows = Array.from({ length: 5 }, (_, n) => good({ "Villa Number": `V-${n}`, Plot: String(n) }));
    rows.push(good({ "Villa Number": "V-9", Plot: "9", Budget: -1 }));

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(422);
    nothingWritten();
  });
});

describe("POST /villas/import: errors in Arabic", () => {
  it("says what is wrong in the language of the request", async () => {
    const res = await upload(
      await sheet(good({ Area: "Nowhere" }), good({ "Villa Number": "B", Budget: "x" })),
      {
        language: "ar",
      },
    );

    expect((res.body.data.errors as ReportError[]).map((error) => error.message)).toEqual([
      "لا توجد منطقة بهذا الاسم",
      "يجب أن تكون الميزانية مبلغا من 0 فأكثر وبعدد خانات عشرية لا يزيد على ما تسمح به عملتها (ثلاث خانات للدينار الكويتي، وخانتان للجنيه المصري أو الدولار، وبلا خانات للين، مثال 1250.500)",
    ]);
  });
});

describe("POST /villas/import: the same file twice", () => {
  it("answers 409 FILE_ALREADY_IMPORTED to a second import of the same file under a new key, and changes nothing", async () => {
    const file = await one();
    expect((await upload(file)).status).toBe(201);

    const second = await upload(file);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("FILE_ALREADY_IMPORTED");
    expect(created()).toHaveLength(1);
    expect(progressTables.rows).toHaveLength(3);
    expect(importBatchTable.rows).toHaveLength(1);
    expect(importAudit()).toHaveLength(1);
    expect(createAudit()).toHaveLength(1);
  });

  it("answers the villas already stored, not the file hash, to a changed file with the same numbers", async () => {
    expect((await upload(await one())).status).toBe(201);

    const second = await upload(await one({ "Owner Name": "Someone" }));

    expect(second.status).toBe(422);
    expect(errorsOf(second)).toEqual([
      [2, "Villa Number", "DUPLICATE_EXISTING"],
      [2, "Plot", "DUPLICATE_EXISTING"],
    ]);
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

  it("answers 422 when the Idempotency-Key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({ "Villa Number": "A" }), { key });
    const other = await upload(await one({ "Villa Number": "B", Plot: "2" }), { key });

    const dryKey = newKey();
    const file = await one({ "Villa Number": "C", Plot: "3" });
    await upload(file, { key: dryKey, query: "?dryRun=true" });
    const real = await upload(file, { key: dryKey });

    expect([other.status, other.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect([real.status, real.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect(created()).toHaveLength(1);
  });
});

describe("POST /villas/import: dry run", () => {
  it("reports the row errors with 200, and the same file can be dry-run again", async () => {
    const file = await one({ Budget: -1 });

    const first = await upload(file, { query: "?dryRun=true" });
    const second = await upload(file, { query: "?dryRun=true" });

    expect(first.status).toBe(200);
    expect(first.body.data.ok).toBe(false);
    expect(errorsOf(first)).toEqual([[2, "Budget", "INVALID_VALUE"]]);
    expect(second.status).toBe(200);
    nothingWritten();
  });

  it("reports a duplicate of a stored villa too, and saves nothing", async () => {
    addVilla({ villaNumber: "V-001", areaId: zayed.id, block: "Z", plot: "9" });

    const res = await upload(await one(), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res)).toEqual([[2, "Villa Number", "DUPLICATE_EXISTING"]]);
    expect(importBatchTable.rows).toHaveLength(0);
  });

  it("does not stop the real import of the same file afterwards", async () => {
    const file = await one();
    await upload(file, { query: "?dryRun=true" });

    expect((await upload(file)).status).toBe(201);
  });

  it("does not take the locks of the save: no phase-set lock, no shared locks", async () => {
    const phaseLock = vi.spyOn(InMemoryVillasRepository.prototype, "lockPhaseSet");
    const refLock = vi.spyOn(InMemoryVillasRepository.prototype, "lockRefsShared");

    await upload(await one(), { query: "?dryRun=true" });

    expect(phaseLock).not.toHaveBeenCalled();
    expect(refLock).not.toHaveBeenCalled();
  });
});

describe("POST /villas/import: the save", () => {
  it("runs in a transaction with the import's time allowance", async () => {
    const spy = vi.spyOn(InMemoryVillasRepository.prototype, "transaction");

    await upload(await one());

    expect(IMPORT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: IMPORT_TRANSACTION_TIMEOUT_MS });
  });

  it("takes the locks in the documented order: the phase set, then the areas and the people, then the writes", async () => {
    const phaseLock = vi.spyOn(InMemoryVillasRepository.prototype, "lockPhaseSet");
    const refLock = vi.spyOn(InMemoryVillasRepository.prototype, "lockRefsShared");
    const insert = vi.spyOn(InMemoryVillasRepository.prototype, "createMany");
    const progress = vi.spyOn(InMemoryVillasRepository.prototype, "insertProgressRowsForMany");

    const res = await upload(
      await sheet(good({ "Villa Number": "A", Plot: "1" }), good({ "Villa Number": "B", Plot: "2" })),
    );

    expect(res.status).toBe(201);
    for (const spy of [phaseLock, refLock, insert, progress]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    const order = [phaseLock, refLock, insert, progress].map((spy) => spy.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("locks each area and person of the file once, however many rows use them", async () => {
    const refLock = vi.spyOn(InMemoryVillasRepository.prototype, "lockRefsShared");

    await upload(
      await sheet(
        good({
          "Villa Number": "A",
          Plot: "1",
          Contractor: "Nile Builders",
          "Electrical Engineer": "Hamdy Salah",
        }),
        good({
          "Villa Number": "B",
          Plot: "2",
          Contractor: "Nile Builders",
          "Electrical Engineer": "Hamdy Salah",
        }),
        good({ "Villa Number": "C", Plot: "3", Area: "Sheikh Zayed", "Civil Engineer": "Karim Sami" }),
      ),
    );

    expect(refLock).toHaveBeenCalledWith(
      {
        areaIds: [cairo.id, zayed.id],
        civilEngineerIds: [mona.id, karim.id],
        electricalEngineerIds: [hamdy.id],
        contractorIds: [nile.id],
      },
      expect.anything(),
    );
  });

  it("saves the villas in the order of the file", async () => {
    await upload(
      await sheet(
        good({ "Villa Number": "C", Plot: "1" }),
        good({ "Villa Number": "A", Plot: "2" }),
        good({ "Villa Number": "B", Plot: "3" }),
      ),
    );

    expect(created().map((villa) => villa.villaNumber)).toEqual(["C", "A", "B"]);
  });

  it("answers 500, not the changed-data conflict, when the write fails for another reason", async () => {
    vi.spyOn(InMemoryVillasRepository.prototype, "createMany").mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });

  it("saves nothing when the progress rows cannot be written", async () => {
    vi.spyOn(InMemoryVillasRepository.prototype, "insertProgressRowsForMany").mockRejectedValue(
      new Error("disk full"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });

  it("saves nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    expect(created()).toHaveLength(0);
    expect(progressTables.rows).toHaveLength(0);
    expect(importBatchTable.rows).toHaveLength(0);
  });

  it("saves nothing when the batch record cannot be written", async () => {
    importBatchTable.failCreate = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await upload(await one());

    expect(res.status).toBe(500);
    nothingWritten();
  });
});

describe("POST /villas/import: the data changes during the import", () => {
  const changed = (res: request.Response) => {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    expect(res.body.message).toBe(
      "A villa, an area, an engineer or a contractor changed while the file was being imported. Nothing was saved. Upload the file again",
    );
    // Whatever the other request saved is rolled back with the fake's transaction; none of the file's rows stays.
    expect(created().filter((villa) => villa.villaNumber === "V-001")).toHaveLength(0);
    expect(progressTables.rows).toHaveLength(0);
    expect(importBatchTable.rows).toHaveLength(0);
    expect(importAudit()).toHaveLength(0);
    expect(createAudit()).toHaveLength(0);
  };
  const full = () =>
    one({ Contractor: "Nile Builders", "Electrical Engineer": "Hamdy Salah", "Civil Engineer": "Mona Adel" });

  it("answers 409 IMPORT_DATA_CHANGED when the area was deleted after the check", async () => {
    happensBeforeSave(() => {
      areaTables.areas = areaTables.areas.filter((area) => area.id !== cairo.id);
    });

    changed(await upload(await full()));
  });

  it("answers 409 when the civil engineer was switched off, or deleted, after the check", async () => {
    happensBeforeSave(() => {
      mona.status = "INACTIVE";
    });
    changed(await upload(await full()));

    mona.status = "ACTIVE";
    importBatchTable.reset();
    idempotencyTable.reset();
    happensBeforeSave(() => {
      engineerTables.engineers = engineerTables.engineers.filter((engineer) => engineer.id !== mona.id);
    });
    changed(await upload(await full()));
  });

  it("answers 409 when the electrical engineer was switched off after the check", async () => {
    happensBeforeSave(() => {
      hamdy.status = "INACTIVE";
    });

    changed(await upload(await full()));
  });

  it("answers 409 when the contractor was switched off after the check", async () => {
    happensBeforeSave(() => {
      nile.status = "INACTIVE";
    });

    changed(await upload(await full()));
  });

  it("answers 409 when the contractor was deleted after the check", async () => {
    happensBeforeSave(() => {
      contractorTables.contractors = contractorTables.contractors.filter(
        (contractor) => contractor.id !== nile.id,
      );
    });

    changed(await upload(await full()));
  });

  it("answers 409 when a row far down the file loses its person: every row is looked at", async () => {
    happensBeforeSave(() => {
      delta.status = "INACTIVE";
    });

    const res = await upload(
      await sheet(
        good({ "Villa Number": "V-001", Plot: "1", Contractor: "Nile Builders" }),
        good({ "Villa Number": "V-002", Plot: "2", Contractor: "Nile Builders" }),
        good({ "Villa Number": "V-003", Plot: "3", Contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(created()).toHaveLength(0);
  });

  it("is not thrown by a change to a person or an area the file does not use", async () => {
    happensBeforeSave(() => {
      delta.status = "INACTIVE";
      karim.status = "INACTIVE";
      areaTables.areas = areaTables.areas.filter((area) => area.id !== zayed.id);
    });

    const res = await upload(await full());

    expect(res.status).toBe(201);
  });

  it("answers 409 IMPORT_DATA_CHANGED when someone saved a villa with one of the numbers in the meantime: the unique index has the last word", async () => {
    happensBeforeSave(() => {
      addVilla({ villaNumber: "V-001", areaId: zayed.id, block: "Z", plot: "9" });
    });

    changed(await upload(await full()));
  });

  it("answers 409 IMPORT_DATA_CHANGED when someone saved a villa on one of the places in the meantime", async () => {
    happensBeforeSave(() => {
      addVilla({ villaNumber: "OTHER", areaId: cairo.id, block: "B1", plot: "1" });
    });

    changed(await upload(await full()));
  });

  it.each([NUMBER_CONSTRAINT, PLOT_CONSTRAINT, "Villa_pkey"])(
    "answers 409 IMPORT_DATA_CHANGED, not FILE_ALREADY_IMPORTED, for the unique violation %s",
    async (constraint) => {
      vi.spyOn(InMemoryVillasRepository.prototype, "createMany").mockRejectedValueOnce(
        uniqueError(constraint),
      );

      const res = await upload(await full());

      changed(res);
    },
  );

  it("lets the same file be uploaded again afterwards, and then it is imported", async () => {
    const file = await full();
    happensBeforeSave(() => {
      nile.status = "INACTIVE";
    });
    expect((await upload(file)).status).toBe(409);
    nile.status = "ACTIVE";

    expect((await upload(file)).status).toBe(201);
  });

  it("says it in Arabic on request", async () => {
    happensBeforeSave(() => {
      nile.status = "INACTIVE";
    });

    const res = await upload(await full(), { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "تغيرت فيلا أو منطقة أو مهندس أو مقاول أثناء استيراد الملف. لم يتم حفظ أي شيء. ارفع الملف مرة أخرى",
    );
  });
});

describe("POST /villas/import: the file", () => {
  it("answers 400 NO_FILE_PROVIDED without a file", async () => {
    const res = await upload(null);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 415 to a file that is not .xlsx", async () => {
    const res = await upload(await one(), { filename: "villas.csv" });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 IMPORT_HEADER_MISMATCH when a column is missing, unknown, repeated or spelled differently", async () => {
    const missing = await upload(
      await workbookOf([
        HEADER.slice(0, 10),
        ["V-001", null, "New Cairo", "B1", "1", null, null, "Mona Adel", null, null],
      ]),
    );
    const unknown = await upload(
      await workbookOf([
        [...HEADER, "Region"],
        [...good(), "EGP"],
      ]),
    );
    const repeated = await upload(
      await workbookOf([
        [...HEADER, "Plot"],
        [...good(), "1"],
      ]),
    );
    const spelled = await upload(
      await workbookOf([
        HEADER.map((header) => (header === "Villa Number" ? "Project Number" : header)),
        good(),
      ]),
    );

    for (const res of [missing, unknown, repeated, spelled]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("IMPORT_HEADER_MISMATCH");
    }
    nothingWritten();
  });

  it("takes the columns in any order", async () => {
    const reversed = [...HEADER].reverse();
    const cells = good({ "Owner Name": "Reverse" });
    const res = await upload(await workbookOf([reversed, [...cells].reverse()]));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ villaNumber: "V-001", ownerName: "Reverse", block: "B1" });
  });

  it("ignores blank rows between the villas", async () => {
    const res = await upload(
      await sheet(good({ "Villa Number": "A", Plot: "1" }), [], good({ "Villa Number": "B", Plot: "2" })),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(2);
  });

  it("answers 422 to a header with no rows", async () => {
    const res = await upload(await sheet());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_NO_ROWS");
  });

  it("keeps the default cell limit: a cell of 2,001 characters refuses the whole file", async () => {
    const res = await upload(await one({ "Owner Name": "n".repeat(2001) }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
    expect(res.body.details).toEqual([{ path: "B2", message: "A cell holds more than 2,000 characters" }]);
    nothingWritten();
  });

  it.each(["?dryRun=yes", "?dryRun=1", "?dryRun=TRUE", "?extra=1"])(
    "refuses the query %s with 400",
    async (query) => {
      const res = await upload(await one(), { query });

      expect(res.status).toBe(400);
    },
  );

  it("shares the import allowance of the user", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "villas:import");

    expect((await upload(await one({ "Villa Number": "A" }), { user })).status).toBe(201);
    expect((await upload(await one({ "Villa Number": "B", Plot: "2" }), { user })).status).toBe(201);
    const third = await upload(await one({ "Villa Number": "C", Plot: "3" }), { user });

    expect(third.status).toBe(429);
  });

  it("counts the template against the same allowance", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("template@example.test", "villas:import");

    const first = await request(app)
      .get("/api/v1/villas/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/villas/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });
});

describe("POST /villas/import: big files", () => {
  const rows = (count: number, fix: (n: number) => Partial<Record<Header, ExcelJS.CellValue>> = () => ({})) =>
    Array.from({ length: count }, (_, n) =>
      good({
        "Villa Number": 10_000 + n,
        "Owner Name": `Owner ${n}`,
        Block: `B${n % 40}`,
        Plot: n,
        Contractor: "Nile Builders",
        "Start Date": "2026-01-15",
        "Target Date": "2026-09-30",
        Budget: 1000 + n,
        ...fix(n),
      }),
    );

  it("imports a file of 2,000 villas, with a progress row of each phase and an audit entry for each", async () => {
    const res = await upload(await sheet(...rows(2000)));

    expect(res.status).toBe(201);
    expect(res.body.data.imported).toBe(2000);
    expect(created()).toHaveLength(2000);
    expect(progressTables.rows).toHaveLength(6000);
    expect(createAudit()).toHaveLength(2000);
    expect(importAudit()).toHaveLength(1);
    expect((importAudit()[0]!.after as { createdIds: string[] }).createdIds).toHaveLength(2000);
  }, 120_000);

  it("answers 422 IMPORT_TOO_MANY_ROWS to more than 2,000 data rows", async () => {
    const res = await upload(await sheet(...rows(2001)));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_TOO_MANY_ROWS");
    nothingWritten();
  }, 120_000);

  it("lists at most 200 errors of a bad file and says it is cut short, the count being of every row", async () => {
    const res = await upload(await sheet(...rows(300, () => ({ Budget: -1 }))));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toHaveLength(200);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.total).toBe(300);
    nothingWritten();
  }, 120_000);
});

// The header row of the template, as the file has it.
async function templateHeader(): Promise<ExcelJS.CellValue[]> {
  const res = await request(app)
    .get("/api/v1/villas/import/template")
    .set(await as(admin))
    .buffer(true)
    .parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (chunk: Buffer) => chunks.push(chunk));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as ExcelJS.Buffer);
  return (workbook.worksheets[0]!.getRow(1).values as ExcelJS.CellValue[]).slice(1);
}

describe("POST /villas/import: the Currency column", () => {
  const WITH = [...HEADER, "Currency"];
  const withCurrency = (budget: ExcelJS.CellValue, currency: ExcelJS.CellValue, villaNumber = "V-001") => [
    ...good({ "Villa Number": villaNumber, Budget: budget }),
    currency,
  ];
  const file = (...rows: ExcelJS.CellValue[][]) => workbookOf([WITH, ...rows]);

  it.each([
    [1250000.5, "EGP", 125_000_050, "EGP"],
    [1250000.5, "USD", 125_000_050, "USD"],
    [1234.567, "KWD", 1_234_567, "KWD"],
    [5, "JPY", 5, "JPY"],
    [75, " usd ", 7500, "USD"],
    [0, "kwd", 0, "KWD"],
    [0.29, "EGP", 29, "EGP"],
    [0.001, "KWD", 1, "KWD"],
    [75, null, 75_000, "KWD"],
  ])("reads the budget %j in %j as %j minor units of %s", async (budget, currency, minor, stored) => {
    const res = await upload(await file(withCurrency(budget, currency)));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ budgetMinor: minor, currency: stored });
  });

  it("reads the decimals of the currency in the same row: three for dinars, none for yen, two for pounds", async () => {
    const decimals = await upload(
      await file(
        withCurrency("1.234", "KWD", "V-1"),
        withCurrency("1.234", "EGP", "V-2"),
        withCurrency("1.5", "JPY", "V-3"),
      ),
    );

    expect(decimals.status).toBe(422);
    expect(errorsOf(decimals)).toEqual([
      [3, "Budget", "INVALID_VALUE"],
      [4, "Budget", "INVALID_VALUE"],
    ]);
    nothingWritten();
  });

  it("refuses a currency that does not exist, on the Currency column, and leaves the budget unchecked", async () => {
    const res = await upload(await file(withCurrency("1.234", "ZZZ"), withCurrency(5, "EG", "V-2")));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      [2, "Currency", "INVALID_VALUE"],
      [3, "Currency", "INVALID_VALUE"],
    ]);
    nothingWritten();
  });

  it("refuses a currency with no budget, on the Currency column", async () => {
    const res = await upload(await file(withCurrency(null, "USD")));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, "Currency", "INVALID_VALUE"]]);
    expect(res.body.data.errors[0].message).toBe("A currency can only be set together with a budget");
    nothingWritten();
  });

  it("takes a file without the column as dinars, and with the column empty as dinars (the default currency)", async () => {
    const without = await upload(await one({ Budget: 10 }));
    const empty = await upload(await file([...good({ "Villa Number": "V-2", Plot: "2", Budget: 20 }), null]));

    expect(without.status).toBe(201);
    expect(empty.status).toBe(201);
    expect(created().map((villa) => [villa.villaNumber, villa.budgetMinor, villa.currency])).toEqual([
      ["V-001", 10_000, "KWD"],
      ["V-2", 20_000, "KWD"],
    ]);
  });

  it("is last in the template, which lists it as optional", async () => {
    expect(await templateHeader()).toEqual(WITH);
  });

  it("refuses the Currency column twice", async () => {
    const res = await upload(
      await workbookOf([
        [...WITH, "Currency"],
        [...withCurrency(5, "USD"), "EGP"],
      ]),
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "Currency", message: "This column appears more than once in the header row" },
    ]);
  });
});

describe("POST /villas/import: a file that was exported", () => {
  const INFORMATIONAL = ["Progress", "Ready", "Ready Date", "Created (UTC)"];
  const exportedHeader = [...HEADER, "Currency", ...INFORMATIONAL];
  const line = (budget: ExcelJS.CellValue, currency: ExcelJS.CellValue, villaNumber = "V-001") => [
    ...good({ "Villa Number": villaNumber, Budget: budget }),
    currency,
    "62.5%",
    "No",
    null,
    new Date("2026-03-04T05:06:07.890Z"),
  ];

  it("takes the informational columns and ignores them: the progress and dates are not saved", async () => {
    const res = await upload(await workbookOf([exportedHeader, line(5, "USD")]));

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      ok: true,
      total: 1,
      imported: 1,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    expect(created()[0]).toMatchObject({ villaNumber: "V-001", budgetMinor: 500, currency: "USD" });
    expect(Object.keys(created()[0]!)).not.toContain("readyDate");
  });

  it("does not read what the informational columns hold: any value will do, even an impossible one", async () => {
    const odd = line(5, "USD");
    odd.splice(HEADER.length + 1, INFORMATIONAL.length, "banana", "maybe", "not a date", -1);

    const res = await upload(await workbookOf([exportedHeader, odd]));

    expect(res.status).toBe(201);
  });

  it("reports skipped 0, and refuses a column that is in neither list", async () => {
    const dry = await upload(await workbookOf([exportedHeader, line(5, "USD")]), { query: "?dryRun=true" });
    const unknown = await upload(
      await workbookOf([
        [...exportedHeader, "Region"],
        [...line(5, "USD"), "x"],
      ]),
    );

    expect(dry.body.data).toMatchObject({ total: 1, imported: 0, skipped: 0 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.details).toEqual([
      { path: "Region", message: "This column is not part of the template" },
    ]);
  });

  it("has no informational column in the template", async () => {
    const header = await templateHeader();

    for (const informational of INFORMATIONAL) {
      expect(header).not.toContain(informational);
    }
  });

  it("reads back an owner, a block and a contractor that start with a formula sign, as they were stored", async () => {
    const res = await upload(
      await workbookOf([
        exportedHeader,
        [
          ...good({ "Villa Number": "'+V-9", "Owner Name": "'=Khaled", Block: "'-B" }),
          null,
          "0.0%",
          "No",
          null,
          new Date("2026-03-04T05:06:07.890Z"),
        ],
      ]),
    );

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ villaNumber: "+V-9", ownerName: "=Khaled", block: "-B" });
  });
});

describe("GET /villas/import/template: the dropdowns", () => {
  const download = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/villas/import/template")
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
  const choicesOf = (workbook: ExcelJS.Workbook, column: number): string[] =>
    (workbook.getWorksheet("Lists")!.getColumn(column).values as (string | undefined)[]).filter(
      (value): value is string => value !== undefined,
    );

  beforeEach(() => {
    addArea({ name: "مدينة نصر", city: "القاهرة" });
    addEngineer({ name: "Retired Eng", phone: "0100 000 0003", status: "INACTIVE" });
    addContractor({ name: "Old Co", phone: "0100 000 0001", status: "INACTIVE" });
    // The same name as Delta Works: both are written by phone.
    addContractor({ name: "Delta Works", phone: "0166 000 0002" });
  });

  it("lists the areas, the active engineers and the active contractors, as the villas export writes them", async () => {
    const workbook = await download();

    expect(choicesOf(workbook, 3)).toEqual([
      "New Cairo",
      "Palm Hills, Alexandria",
      "Palm Hills, Giza",
      "Sheikh Zayed",
      "مدينة نصر",
    ]);
    expect(choicesOf(workbook, 6)).toEqual(["0155 999 0000", "0166 000 0002", "Nile Builders"]);
    expect(choicesOf(workbook, 7)).toEqual(["Hamdy Salah"]);
    expect(choicesOf(workbook, 8)).toEqual(["Karim Sami", "Mona Adel"]);
  });

  it("lists every currency the import accepts, and puts a dropdown on the five columns with a list", async () => {
    const workbook = await download();
    const currencies = choicesOf(workbook, 12);
    const data = workbook.getWorksheet("Villas")!;

    expect(currencies).toEqual(expect.arrayContaining(["EGP", "KWD", "USD"]));
    expect(currencies).toEqual([...currencies].sort());
    for (const code of currencies) {
      expect(villaCurrencyField.safeParse(code).success, code).toBe(true);
    }
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const withRule = letters.filter((letter) => data.getCell(`${letter}2`).dataValidation);
    expect(withRule).toEqual(["C", "F", "G", "H", "L"]);
    expect(data.getCell("C2001").dataValidation).toMatchObject({
      type: "list",
      formulae: ["Lists!$C$1:$C$5"],
      errorStyle: "stop",
    });
    expect(data.getCell("C2002").dataValidation).toBeFalsy();
  });

  it("is hidden on a last sheet, and a filled-in template with the Lists sheet still in it imports", async () => {
    const workbook = await download();
    const data = workbook.getWorksheet("Villas")!;
    data.getRow(2).values = ["V-777", "", "Palm Hills, Giza", "B1", "7", "0155 999 0000", "", "Mona Adel"];

    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const res = await upload(bytes);

    expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
      ["Villas", "visible"],
      ["Instructions", "visible"],
      ["Lists", "hidden"],
    ]);
    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ villaNumber: "V-777", areaId: palmGiza.id, contractorId: delta.id });
  });

  it("offers only values the import accepts: a file with every choice, one per row, is good", async () => {
    const workbook = await download();
    const area = choicesOf(workbook, 3);
    const contractor = choicesOf(workbook, 6);
    const electrical = choicesOf(workbook, 7);
    const civil = choicesOf(workbook, 8);
    const rows = Array.from({ length: area.length }, (_, at) =>
      good({
        "Villa Number": `RT-${at}`,
        Area: area[at],
        Plot: String(at),
        Contractor: contractor[at % contractor.length],
        "Electrical Engineer": electrical[at % electrical.length],
        "Civil Engineer": civil[at % civil.length],
      }),
    );
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(errorsOf(res)).toEqual([]);
    expect(res.body.data).toMatchObject({ ok: true, total: area.length });
  });

  it("accepts every currency of the list, given with a budget", async () => {
    const currencies = choicesOf(await download(), 12);
    const header = [...HEADER, "Currency"];
    const rows = currencies.map((code, at) => [
      ...good({ "Villa Number": `CU-${at}`, Plot: String(at), Budget: 1 }),
      code,
    ]);
    const bytes = await workbookOf([header, ...rows]);
    const res = await upload(bytes, { query: "?dryRun=true" });

    expect(errorsOf(res)).toEqual([]);
    expect(res.body.data).toMatchObject({ ok: true, total: currencies.length });
  });

  it("shows no inactive party, and no phone except that of a party whose name is shared", async () => {
    const shown: string[] = [];
    (await download()).getWorksheet("Lists")!.eachRow((r) => r.eachCell((cell) => shown.push(cell.text)));

    for (const hidden of ["Old Co", "0100 000 0001", "Retired Eng", "0100 000 0003"]) {
      expect(shown, hidden).not.toContain(hidden);
    }
    // A phone of a party with a name of its own is not shown: it is a name that is listed.
    for (const phone of ["0122 777 8888", "0111 555 6666", "0100 111 2222"]) {
      expect(shown, phone).not.toContain(phone);
    }
    expect(shown).toContain("0155 999 0000");
  });
});
