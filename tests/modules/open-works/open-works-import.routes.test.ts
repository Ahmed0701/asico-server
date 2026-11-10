import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addStartingPhases,
  phaseTables,
  type StoredPhase,
} from "../elec-phases/in-memory-elec-phases.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, zipOf } from "../../shared/import/xlsx-fixtures.js";
import {
  addWorkItem,
  InMemoryOpenWorksRepository,
  openWorkRaces,
  workItemTables,
} from "./in-memory-open-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/open-works/repository/open-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/open-works/repository/open-works.repository.js")
  >()),
  OpenWorksRepository: (await import("./in-memory-open-works.repository.js")).InMemoryOpenWorksRepository,
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
  "phase",
  "status",
  "priority",
  "progress",
  "contractor",
  "startDate",
  "endDate",
] as const;
type Header = (typeof KEYS)[number];
const TITLE: Record<Header, string> = {
  villa: "Villa Number",
  phase: "Electrical Phase",
  status: "Status",
  priority: "Priority",
  progress: "Progress",
  contractor: "Contractor",
  startDate: "Start Date",
  endDate: "End Date",
};
const HEADER: string[] = KEYS.map((key) => TITLE[key]);
const ARABIC = /[؀-ۿ]/;
const original = { limit: env.IMPORT_RATE_LIMIT_MAX };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

let admin: User;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;
let villa1: StoredVilla;
let villa2: StoredVilla;
let villa3: StoredVilla;
let phases: StoredPhase[];

beforeEach(() => {
  store.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  workItemTables.reset();
  openWorkRaces.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  nile = addContractor({ name: "Nile Builders", phone: "0100 111 2222" });
  delta = addContractor({ name: "Delta Works", phone: "0111 333 4444" });
  villa1 = addVilla({ id: "villa-c", villaNumber: "P-001", contractorId: nile.id });
  villa2 = addVilla({ id: "villa-b", villaNumber: "P-002", contractorId: delta.id });
  villa3 = addVilla({ id: "villa-a", villaNumber: "P-003", contractorId: null });
  // Ceiling Piping, MSB Box Fixing, Cut/out Box Fixing, D.B Box Fixing, Wall Piping, Sleeves.
  phases = addStartingPhases();
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
const one = (cells: Partial<Record<Header, ExcelJS.CellValue>>): Promise<Buffer> =>
  sheet(row({ villa: "P-001", phase: "Wall Piping", ...cells }));
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const newKey = (): string => `key-${randomUUID()}`;

type UploadOptions = {
  user?: User;
  language?: string;
  key?: string | null;
  query?: string;
  filename?: string;
  field?: string;
};
async function upload(file: Buffer | null, options: UploadOptions = {}) {
  const { user = admin, language = "en", key = newKey(), query = "", filename = "open-works.xlsx" } = options;
  const req = request(app)
    .post(`/api/v1/open-works/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((entry) => entry.action === "open_work.import");
const created = () => workItemTables.items;
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
    ["get", "/open-works/import/template"],
    ["post", "/open-works/import"],
  ] as const;
  const others = [
    "open-works:read",
    "open-works:create",
    "open-works:update",
    "open-works:delete",
    "open-works:export",
    "villas:read",
    "contractors:read",
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

  it("does not let open-works:import open the other open works routes", async () => {
    const headers = await as(employee("importer@example.test", "open-works:import"));

    expect((await request(app).get("/api/v1/open-works").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/open-works").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/open-works/export?format=xlsx").set(headers)).status).toBe(403);
  });

  it("lets the holder of open-works:import use both routes", async () => {
    const user = employee("importer@example.test", "open-works:import");

    expect(
      (
        await request(app)
          .get("/api/v1/open-works/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await one({}), { user })).status).toBe(201);
  });

  it("lets the ADMIN through with no granted permissions", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/open-works/import/template")
          .set(await as(admin))
      ).status,
    ).toBe(200);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /open-works/:id", async () => {
    const res = await request(app)
      .get("/api/v1/open-works/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /open-works/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/open-works/import/template")
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
    expect(res.headers["content-disposition"]).toBe('attachment; filename="open-works-import-template.xlsx"');
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, in order, with the electrical phase and without a source or a location", async () => {
    const workbook = await workbookOfTemplate();
    const data = workbook.worksheets[0]!;

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Open works", "Instructions", "Lists"]);
    expect(data.getRow(1).values).toEqual([undefined, ...HEADER]);
    // The columns the export adds after these are not in the template.
    for (const informational of ["Location", "Source", "Overdue"]) {
      expect(HEADER).not.toContain(informational);
    }
    expect(HEADER).toContain("Electrical Phase");
    expect(HEADER).not.toContain("Title");
    expect(HEADER).not.toContain("Work Phase");
  });

  it("has an example row on a villa that does not exist, so it cannot be imported by mistake", async () => {
    const data = (await workbookOfTemplate()).worksheets[0]!;

    expect(data.actualRowCount).toBe(2);
    expect(data.getRow(2).getCell(1).value).toBe("EX-000");
    expect(data.getRow(2).getCell(2).value).toBe("Ceiling Piping");
    expect(data.getRow(2).getCell(3).value).toBe("In progress");
    expect(data.getRow(2).getCell(4).value).toBe("Medium");
  });

  it("has a dropdown on the electrical phase, the status and the priority, fed by the Lists sheet", async () => {
    const workbook = await workbookOfTemplate();
    const data = workbook.worksheets[0]!;
    const lists = workbook.getWorksheet("Lists")!;

    expect(data.getCell("B2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$B$1:$B$6"] });
    expect(data.getCell("C2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$C$1:$C$4"] });
    expect(data.getCell("D2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$D$1:$D$3"] });
    expect(lists.getColumn(2).values).toEqual([undefined, ...phases.map((phase) => phase.name)]);
    expect(lists.getColumn(3).values).toEqual([undefined, "Not started", "In progress", "Delayed", "Done"]);
    expect(lists.getColumn(4).values).toEqual([undefined, "Low", "Medium", "High"]);
  });

  it("lists only the active electrical phases in the dropdown", async () => {
    phaseTables.phases.find((phase) => phase.id === phases[1]!.id)!.status = "INACTIVE";

    const workbook = await workbookOfTemplate();
    const lists = workbook.getWorksheet("Lists")!;

    expect(lists.getColumn(2).values).toEqual([
      undefined,
      ...phases.filter((phase) => phase.id !== phases[1]!.id).map((phase) => phase.name),
    ]);
  });

  it("explains every column in the Instructions sheet, with the contractor rule", async () => {
    const instructions = (await workbookOfTemplate()).getWorksheet("Instructions")!;
    const text: string[] = [];
    instructions.eachRow((r) => r.eachCell((cell) => text.push(cell.text)));
    const all = text.join(" | ");

    for (const header of HEADER) expect(all).toContain(header);
    expect(all).toContain("villa's own contractor");
    expect(all).toContain("2,000");
  });

  it("is English even when the request asks for Arabic", async () => {
    const workbook = await workbookOfTemplate("ar");

    for (const sheetOf of workbook.worksheets) {
      sheetOf.eachRow((r) => r.eachCell((cell) => expect(cell.text).not.toMatch(ARABIC)));
    }
  });

  it("has every column of every sheet fitted: no default width, none narrower than its longest cell", async () => {
    const workbook = await workbookOfTemplate();

    for (const worksheet of workbook.worksheets) {
      for (let number = 1; number <= worksheet.columnCount; number++) {
        const column = worksheet.getColumn(number);
        let longest = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          longest = Math.max(longest, ...cell.text.split(String.fromCharCode(10)).map((line) => line.length));
        });

        expect(column.width, `${worksheet.name} column ${number}`).toBeDefined();
        expect(column.width).not.toBe(9.140625);
        expect(column.width).toBeGreaterThanOrEqual(8);
        expect(column.width).toBeLessThanOrEqual(60);
        expect(column.width, `${worksheet.name} column ${number} fits ${longest}`).toBeGreaterThanOrEqual(
          Math.min(60, longest),
        );
      }
    }
  });

  it("is read by the import as it stands, and its example row is refused: its villa does not exist", async () => {
    const template = (await download()).body as Buffer;

    const res = await upload(template);

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 1, imported: 0 });
    expect(errorsOf(res)).toEqual([[2, TITLE.villa, "REFERENCE_NOT_FOUND"]]);
    nothingWritten();
  });

  it("would also be refused on its contractor, if a villa EX-000 were there", async () => {
    addVilla({ villaNumber: "EX-000" });
    const template = (await download()).body as Buffer;

    const res = await upload(template);

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REFERENCE_NOT_FOUND"]]);
  });

  it("counts against the import rate limit", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("t@example.test", "open-works:import");

    const first = await request(app)
      .get("/api/v1/open-works/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/open-works/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });
});

describe("POST /open-works/import: saving", () => {
  it("saves every row in one go, as MANUAL items made by the importing user, and answers 201", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-001",
          phase: "Wall Piping",
          status: "In progress",
          priority: "High",
          progress: 40,
          contractor: "Nile Builders",
          startDate: "2026-01-15",
          endDate: "2026-02-15",
        }),
        row({ villa: "P-002", phase: "Sleeves" }),
        row({ villa: "P-003", phase: "sleeves", status: "done" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: { ok: true, total: 3, imported: 3, skipped: 0, errors: [], truncated: false },
    });
    expect(
      created().map((item) => ({
        villaId: item.villaId,
        elecPhaseId: item.elecPhaseId,
        status: item.status,
        priority: item.priority,
        progress: item.progress,
        contractorId: item.contractorId,
        startDate: item.startDate,
        endDate: item.endDate,
        source: item.source,
        version: item.version,
        createdById: item.createdById,
      })),
    ).toEqual([
      {
        villaId: villa1.id,
        elecPhaseId: phases[4]!.id,
        status: "IN_PROGRESS",
        priority: "HIGH",
        progress: 40,
        contractorId: nile.id,
        startDate: day("2026-01-15"),
        endDate: day("2026-02-15"),
        source: "MANUAL",
        version: 1,
        createdById: admin.id,
      },
      {
        villaId: villa2.id,
        elecPhaseId: phases[5]!.id,
        status: "NOT_STARTED",
        priority: "MEDIUM",
        progress: 0,
        contractorId: null,
        startDate: null,
        endDate: null,
        source: "MANUAL",
        version: 1,
        createdById: admin.id,
      },
      {
        villaId: villa3.id,
        elecPhaseId: phases[5]!.id,
        status: "DONE",
        priority: "MEDIUM",
        progress: 100,
        contractorId: null,
        startDate: null,
        endDate: null,
        source: "MANUAL",
        version: 1,
        createdById: admin.id,
      },
    ]);
  });

  it("writes one audit entry for the file, with the row count, the file hash and the new ids", async () => {
    const file = await sheet(
      row({ villa: "P-001", phase: "Wall Piping" }),
      row({ villa: "P-002", phase: "Wall Piping" }),
    );

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      action: "open_work.import",
      entity: "WorkItem",
      after: {
        rows: 2,
        fileHash: sha256(file),
        createdIds: created().map((item) => item.id),
        batchId: importBatchTable.rows[0]?.id,
      },
    });
    // The items themselves are not audited one by one.
    expect(store.auditRows.filter((entry) => entry.action === "open_work.create")).toHaveLength(0);
  });

  it("records the file: its hash, the entity, the user and the row count", async () => {
    const file = await one({});

    await upload(file);

    expect(importBatchTable.rows).toHaveLength(1);
    expect(importBatchTable.rows[0]).toMatchObject({
      entity: "WorkItem",
      fileHash: sha256(file),
      userId: admin.id,
      rows: 1,
    });
  });

  it("takes the import lock for the table before it reads anything", async () => {
    await upload(await one({}));

    expect(importBatchTable.locks).toEqual(["WorkItem"]);
  });

  it("accepts the columns in any order", async () => {
    const file = await workbookOf([
      [
        "End Date",
        "Priority",
        "Villa Number",
        "Electrical Phase",
        "Contractor",
        "Progress",
        "Status",
        "Start Date",
      ],
      ["2026-03-01", "low", "P-002", "Sleeves", "Delta Works", "10", "delayed", "2026-02-01"],
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({
      villaId: villa2.id,
      elecPhaseId: phases[5]!.id,
      priority: "LOW",
      status: "DELAYED",
      progress: 10,
      contractorId: delta.id,
      startDate: day("2026-02-01"),
      endDate: day("2026-03-01"),
    });
  });

  it("does not touch the items that are there, and makes no automatic item", async () => {
    const existing = addWorkItem({ villaId: villa1.id, progress: 10 });

    await upload(await one({ progress: 70 }));

    expect(created()).toHaveLength(2);
    expect(created()[0]).toEqual(existing);
    expect(created().filter((item) => item.source === "PHASE")).toHaveLength(0);
  });

  it("matches the villa number whatever the case and spacing", async () => {
    const res = await upload(await one({ villa: "  p-001 " }));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ villaId: villa1.id });
  });

  it.each([
    ["Wall Piping", 4],
    ["wall piping", 4],
    ["WALL PIPING", 4],
    ["  sleeves ", 5],
    ["Cut/out Box Fixing", 2],
    ["d.b box fixing", 3],
  ])("reads the electrical phase %j as the phase number %i", async (cell, index) => {
    await upload(await one({ phase: cell }));

    expect(created()[0]?.elecPhaseId).toBe(phases[index]!.id);
  });

  it.each([
    ["Not started", "NOT_STARTED"],
    ["NOT_STARTED", "NOT_STARTED"],
    ["in progress", "IN_PROGRESS"],
    ["IN_PROGRESS", "IN_PROGRESS"],
    ["Delayed", "DELAYED"],
  ])("reads the status %j as %s", async (cell, status) => {
    await upload(await one({ status: cell }));

    expect(created()[0]?.status).toBe(status);
  });

  it.each([
    ["Low", "LOW"],
    ["HIGH", "HIGH"],
    ["medium", "MEDIUM"],
  ])("reads the priority %j as %s", async (cell, priority) => {
    await upload(await one({ priority: cell }));

    expect(created()[0]?.priority).toBe(priority);
  });

  it("imports a file of 2,000 rows", async () => {
    // A villa has at most one open work per phase: 400 villas, five phases each.
    for (let i = 0; i < 400; i += 1) addVilla({ villaNumber: `Q-${i}`, contractorId: null });
    const rows = Array.from({ length: 2000 }, (_, i) =>
      row({ villa: `Q-${Math.floor(i / 5)}`, phase: phases[i % 5]!.name }),
    );

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ total: 2000, imported: 2000 });
    expect(created()).toHaveLength(2000);
    expect((importAudit()[0]?.after as { createdIds: string[] }).createdIds).toHaveLength(2000);
  });
});

describe("POST /open-works/import: status and progress", () => {
  it.each([
    [{ status: undefined, progress: undefined }, "NOT_STARTED", 0],
    [{ status: "Not started", progress: undefined }, "NOT_STARTED", 0],
    [{ status: "In progress", progress: undefined }, "IN_PROGRESS", 0],
    [{ status: "Delayed", progress: undefined }, "DELAYED", 0],
    [{ status: "Done", progress: undefined }, "DONE", 100],
    [{ status: undefined, progress: 0 }, "NOT_STARTED", 0],
    [{ status: undefined, progress: 1 }, "IN_PROGRESS", 1],
    [{ status: undefined, progress: 99 }, "IN_PROGRESS", 99],
    [{ status: undefined, progress: 100 }, "DONE", 100],
    [{ status: undefined, progress: "55" }, "IN_PROGRESS", 55],
    [{ status: "Not started", progress: 0 }, "NOT_STARTED", 0],
    [{ status: "Done", progress: 100 }, "DONE", 100],
    [{ status: "In progress", progress: 0 }, "IN_PROGRESS", 0],
    [{ status: "In progress", progress: 99 }, "IN_PROGRESS", 99],
    [{ status: "Delayed", progress: 99 }, "DELAYED", 99],
  ])("takes %j as %s at %s", async (cells, status, progress) => {
    const res = await upload(await one(cells));

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({ status, progress });
  });

  it.each([
    [{ status: "Not started", progress: 10 }],
    [{ status: "Not started", progress: 100 }],
    [{ status: "Done", progress: 0 }],
    [{ status: "Done", progress: 99 }],
    [{ status: "In progress", progress: 100 }],
    [{ status: "Delayed", progress: 100 }],
  ])("refuses %j: the status and the progress do not agree", async (cells) => {
    const res = await upload(await one(cells));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.status,
        code: "INVALID_VALUE",
        message:
          "The status and the progress do not agree: NOT_STARTED is 0, DONE is 100, and IN_PROGRESS and DELAYED are 0 to 99",
        value: cells.status,
      },
    ]);
    nothingWritten();
  });

  it.each([[101], [-1], [40.5], ["abc"], ["40%"], ["4.5"], [true], [1e9]])(
    "refuses the progress %j",
    async (progress) => {
      const res = await upload(await one({ progress }));

      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([[2, TITLE.progress, "INVALID_VALUE"]]);
      expect(res.body.data.errors[0].message).toBe("Progress must be a whole number from 0 to 100");
    },
  );

  it("does not add a disagreement to a status or progress that is already a problem", async () => {
    const res = await upload(await one({ status: "Paused", progress: 50 }));

    expect(errorsOf(res)).toEqual([[2, TITLE.status, "INVALID_OPTION"]]);
  });
});

describe("POST /open-works/import: dates", () => {
  it("reads text days and real date cells alike, as the day at 00:00 UTC", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping", startDate: "2026-01-15", endDate: "2026-02-15" }),
        row({
          villa: "P-001",
          phase: "Ceiling Piping",
          startDate: new Date(Date.UTC(2026, 0, 15)),
          endDate: new Date(Date.UTC(2026, 1, 15)),
        }),
        row({
          villa: "P-001",
          phase: "Sleeves",
          startDate: new Date(Date.UTC(2026, 0, 15, 23, 59)),
          endDate: new Date(Date.UTC(2026, 1, 15, 18, 30)),
        }),
      ),
    );

    expect(res.status).toBe(201);
    for (const item of created()) {
      expect(item.startDate).toEqual(day("2026-01-15"));
      expect(item.endDate).toEqual(day("2026-02-15"));
    }
  });

  it("allows one date alone, and an end on the same day as the start", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping", startDate: "2026-01-15" }),
        row({ villa: "P-001", phase: "Sleeves", endDate: "2026-01-15" }),
        row({
          villa: "P-001",
          phase: "Ceiling Piping",
          startDate: "2026-01-15",
          endDate: "2026-01-15",
        }),
      ),
    );

    expect(res.status).toBe(201);
    expect(created().map((item) => [item.startDate, item.endDate])).toEqual([
      [day("2026-01-15"), null],
      [null, day("2026-01-15")],
      [day("2026-01-15"), day("2026-01-15")],
    ]);
  });

  it.each([
    ["2026-02-30"],
    ["15/01/2026"],
    ["2026-1-5"],
    ["soon"],
    ["2026-01-15T10:00:00Z"],
    [46037],
    [true],
  ])("refuses the start date %j", async (startDate) => {
    const res = await upload(await one({ startDate }));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.startDate, "INVALID_VALUE"]]);
    expect(res.body.data.errors[0].message).toBe("Enter a valid date (YYYY-MM-DD)");
  });

  it("refuses an end date before the start date, on the end date, with the API's message", async () => {
    const res = await upload(await one({ startDate: "2026-02-15", endDate: "2026-02-14" }));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.endDate,
        code: "INVALID_VALUE",
        message: "The end date must not be before the start date",
        value: "2026-02-14",
      },
    ]);
  });

  it("compares a date cell with a text day by the day", async () => {
    const res = await upload(
      await one({ startDate: new Date(Date.UTC(2026, 1, 15, 23, 0)), endDate: "2026-02-15" }),
    );

    expect(res.status).toBe(201);
  });

  it("does not compare the dates of a row whose date is already a problem", async () => {
    const res = await upload(await one({ startDate: "nope", endDate: "2026-02-14" }));

    expect(errorsOf(res)).toEqual([[2, TITLE.startDate, "INVALID_VALUE"]]);
  });
});

describe("POST /open-works/import: the contractor", () => {
  const contractorRow = (contractor: ExcelJS.CellValue, villa = "P-001") =>
    sheet(row({ villa, phase: "Wall Piping", contractor }));

  it.each([
    ["Nile Builders"],
    ["nile builders"],
    ["  NILE   BUILDERS "],
    ["0100 111 2222"],
    ["0100-111-2222"],
    ["01001112222"],
  ])("takes the villa's own contractor by %j", async (cell) => {
    const res = await upload(await contractorRow(cell));

    expect(res.status).toBe(201);
    expect(created()[0]?.contractorId).toBe(nile.id);
  });

  it("leaves the contractor empty when the cell is empty, even though the villa has one", async () => {
    const res = await upload(await contractorRow(null));

    expect(res.status).toBe(201);
    expect(created()[0]?.contractorId).toBeNull();
  });

  it("refuses another contractor, by name or by phone, with CONTRACTOR_NOT_ON_VILLA", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping", contractor: "Delta Works" }),
        row({ villa: "P-001", phase: "Wall Piping", contractor: "0111 333 4444" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.contractor,
        code: "CONTRACTOR_NOT_ON_VILLA",
        message: "This contractor is not the contractor of this villa",
        value: "Delta Works",
      },
      expect.objectContaining({ row: 3, column: TITLE.contractor, code: "CONTRACTOR_NOT_ON_VILLA" }),
    ]);
    nothingWritten();
  });

  it("refuses any contractor on a villa that has none", async () => {
    const res = await upload(await contractorRow("Nile Builders", "P-003"));

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "CONTRACTOR_NOT_ON_VILLA"]]);
  });

  it("answers REFERENCE_NOT_FOUND for a contractor that does not exist", async () => {
    const res = await upload(await contractorRow("Nobody Ltd"));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.contractor,
        code: "REFERENCE_NOT_FOUND",
        message: "No contractor has this name or phone",
        value: "Nobody Ltd",
      },
    ]);
  });

  it("refuses an inactive contractor, even the villa's own", async () => {
    contractorTables.contractors.find((c) => c.id === nile.id)!.status = "INACTIVE";

    const res = await upload(await contractorRow("Nile Builders"));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.contractor,
        code: "INVALID_VALUE",
        message: "This contractor is inactive and cannot be assigned to an open work",
        value: "Nile Builders",
      },
    ]);
  });

  it("says another villa's inactive contractor is not the villa's, before it says inactive", async () => {
    contractorTables.contractors.find((c) => c.id === delta.id)!.status = "INACTIVE";

    const res = await upload(await contractorRow("Delta Works"));

    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "CONTRACTOR_NOT_ON_VILLA"]]);
  });

  it("refuses a phone typed as a number, and says so as for any text column", async () => {
    const res = await upload(await contractorRow(1001112222));

    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "NOT_TEXT"]]);
  });

  it("asks nothing of the contractor when the villa is not found: that is the only error", async () => {
    const res = await upload(await contractorRow("Nobody Ltd", "P-999"));

    expect(errorsOf(res)).toEqual([[2, TITLE.villa, "REFERENCE_NOT_FOUND"]]);
  });

  it("writes the contractor messages in Arabic", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping", contractor: "Delta Works" }),
        row({ villa: "P-001", phase: "Wall Piping", contractor: "Nobody" }),
      ),
      { language: "ar" },
    );

    expect(res.body.data.errors.map((error: ReportError) => error.message)).toEqual([
      "هذا المقاول ليس مقاول هذه الفيلا",
      "لا يوجد مقاول بهذا الاسم أو رقم الهاتف",
    ]);
  });
});

describe("POST /open-works/import: the other cells", () => {
  it("answers REFERENCE_NOT_FOUND for a villa number that no villa has", async () => {
    const res = await upload(await one({ villa: "P-999" }));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.villa,
        code: "REFERENCE_NOT_FOUND",
        message: "No villa has this number",
        value: "P-999",
      },
    ]);
    nothingWritten();
  });

  it("names a missing villa and a missing electrical phase", async () => {
    const res = await upload(await sheet(row({ status: "Done" })));

    expect(errorsOf(res)).toEqual([
      [2, TITLE.villa, "REQUIRED"],
      [2, TITLE.phase, "REQUIRED"],
    ]);
  });

  it("refuses a phase that is not in the system, and one that is switched off", async () => {
    const [unknown, off] = [await upload(await one({ phase: "Plastering" })), null];
    expect(errorsOf(unknown)).toEqual([[2, TITLE.phase, "REFERENCE_NOT_FOUND"]]);
    expect(off).toBeNull();

    phases[4]!.status = "INACTIVE";
    const inactive = await upload(await one({ phase: "Wall Piping" }));
    expect(inactive.status).toBe(422);
    expect(inactive.body.data.errors).toEqual([
      {
        row: 2,
        column: TITLE.phase,
        code: "INVALID_VALUE",
        message: expect.any(String),
        value: "Wall Piping",
      },
    ]);
    nothingWritten();
  });

  it.each([[3], [true]])("refuses the phase %j: no phase has that name", async (phase) => {
    const res = await upload(await one({ phase }));

    expect(errorsOf(res)).toEqual([[2, TITLE.phase, "REFERENCE_NOT_FOUND"]]);
  });

  it.each([["Urgent"], [1]])("refuses the priority %j", async (priority) => {
    const res = await upload(await one({ priority }));

    expect(errorsOf(res)).toEqual([[2, TITLE.priority, "INVALID_OPTION"]]);
  });

  it("reports every problem of every row, by row and then in the order of the columns", async () => {
    const res = await upload(
      await sheet(
        row({
          villa: "P-999",
          phase: "Plastering",
          status: "Gone",
          priority: "Never",
          progress: 101,
          contractor: "Nobody",
          startDate: "later",
          endDate: "soon",
        }),
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-002", phase: "Wall Piping", startDate: "2026-02-02", endDate: "2026-02-01" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.total).toBe(3);
    expect(errorsOf(res)).toEqual([
      [2, TITLE.villa, "REFERENCE_NOT_FOUND"],
      [2, TITLE.phase, "REFERENCE_NOT_FOUND"],
      [2, TITLE.status, "INVALID_OPTION"],
      [2, TITLE.priority, "INVALID_OPTION"],
      [2, TITLE.progress, "INVALID_VALUE"],
      [2, TITLE.startDate, "INVALID_VALUE"],
      [2, TITLE.endDate, "INVALID_VALUE"],
      [4, TITLE.endDate, "INVALID_VALUE"],
    ]);
    nothingWritten();
  });

  it("writes the messages in the request language", async () => {
    const res = await upload(
      await sheet(row({ villa: "P-999", phase: "Plastering", progress: 101, startDate: "soon" })),
      { language: "ar" },
    );

    expect(res.status).toBe(422);
    const messages = res.body.data.errors.map((error: ReportError) => error.message);
    expect(messages).toHaveLength(4);
    for (const message of messages) expect(message).toMatch(ARABIC);
  });

  it("caps the report at 200 errors and says it is cut off", async () => {
    const rows = Array.from({ length: 250 }, () => row({ villa: "P-999", phase: "Wall Piping" }));

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 250, imported: 0, truncated: true });
    expect(res.body.data.errors).toHaveLength(200);
    nothingWritten();
  });
});

describe("POST /open-works/import: the dry run", () => {
  it("validates and reports without writing anything, and without taking a lock", async () => {
    const file = await sheet(
      row({ villa: "P-001", phase: "Wall Piping" }),
      row({ villa: "P-002", phase: "Wall Piping" }),
    );
    let raced = false;
    openWorkRaces.beforeImportLock = () => {
      raced = true;
    };

    const res = await upload(file, { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { ok: true, total: 2, imported: 0, skipped: 0, errors: [], truncated: false },
    });
    nothingWritten();
    expect(importBatchTable.locks).toHaveLength(0);
    expect(raced).toBe(false);
  });

  it("reports the errors of a bad file with 200, and writes nothing", async () => {
    const res = await upload(
      await sheet(row({ villa: "P-001", phase: "Wall Piping" }), row({ villa: "P-999" })),
      { query: "?dryRun=true" },
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, total: 2, imported: 0 });
    expect(errorsOf(res)).toEqual([
      [3, TITLE.villa, "REFERENCE_NOT_FOUND"],
      [3, TITLE.phase, "REQUIRED"],
    ]);
    nothingWritten();
  });

  it("does not use up the file: the same file can be imported afterwards", async () => {
    const file = await one({});

    expect((await upload(file, { query: "?dryRun=true" })).status).toBe(200);
    expect((await upload(file, { query: "?dryRun=true" })).status).toBe(200);
    const real = await upload(file);

    expect(real.status).toBe(201);
    expect(created()).toHaveLength(1);
  });

  it("reports, in a dry run of a file already imported, that the villa has an open work for the phase", async () => {
    const file = await one({});
    await upload(file);

    const res = await upload(file, { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, total: 1, imported: 0 });
    expect(errorsOf(res)).toEqual([[2, "Electrical Phase", "DUPLICATE_EXISTING"]]);
  });

  it("accepts dryRun=false as a real import", async () => {
    const res = await upload(await one({}), { query: "?dryRun=false" });

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
  });

  it.each(["?dryRun=yes", "?dryRun=1", "?dryRun=TRUE", "?dryRun=", "?dryRun=true&dryRun=false", "?extra=1"])(
    "refuses the query %s with 400, before the upload is read",
    async (query) => {
      const res = await upload(await one({}), { query });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      nothingWritten();
    },
  );
});

describe("POST /open-works/import: all or nothing", () => {
  it("saves nothing when one row has a problem, and answers 422 with the report", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-002", phase: "Wall Piping" }),
        row({ villa: "P-003", phase: "Wall Piping", progress: 150 }),
        row({ villa: "P-003", phase: "Wall Piping" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 4, imported: 0, truncated: false });
    expect(errorsOf(res)).toEqual([[4, TITLE.progress, "INVALID_VALUE"]]);
    nothingWritten();
  });

  it("rolls everything back when the file cannot be recorded after the rows were saved", async () => {
    importBatchTable.failCreate = true;

    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-002", phase: "Wall Piping" }),
      ),
    );

    expect(res.status).toBe(500);
    nothingWritten();
  });

  it("gives the Idempotency-Key back after a failure, so a corrected file can use it", async () => {
    const key = newKey();
    const bad = await upload(await one({ villa: "P-999" }), { key });
    expect(bad.status).toBe(422);
    expect(idempotencyTable.rows).toHaveLength(0);

    const good = await upload(await one({}), { key });

    expect(good.status).toBe(201);
    expect(good.headers["idempotent-replayed"]).toBeUndefined();
  });
});

describe("POST /open-works/import: one open work per villa and phase", () => {
  it("refuses the same villa and phase twice in one file, whatever the case or spaces, and saves nothing", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: " p-001 ", phase: "wall piping" }),
        row({ villa: "P-002", phase: "Wall Piping" }),
      ),
    );

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[3, "Electrical Phase", "DUPLICATE_IN_FILE"]]);
    nothingWritten();
  });

  it("refuses a row for a villa and phase that already have an open work", async () => {
    addWorkItem({ villaId: villa1.id, elecPhaseId: phases[4]!.id });

    const res = await upload(await one({}), { language: "ar" });

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([[2, "Electrical Phase", "DUPLICATE_EXISTING"]]);
    expect(res.body.data.errors[0].message).toMatch(ARABIC);
    expect(created()).toHaveLength(1);
  });

  it("reports both a phase problem and every other problem, row by row", async () => {
    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-001", phase: "Wall Piping", progress: 101 }),
        row({ villa: "P-001", phase: "Plastering" }),
      ),
    );

    expect(errorsOf(res)).toEqual([
      [3, TITLE.progress, "INVALID_VALUE"],
      [4, TITLE.phase, "REFERENCE_NOT_FOUND"],
    ]);
  });

  it("answers IMPORT_DATA_CHANGED when the phase is switched off between the check and the insert", async () => {
    openWorkRaces.beforeImportLock = () => {
      phases[4]!.status = "INACTIVE";
    };

    const res = await upload(await one({}));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("answers IMPORT_DATA_CHANGED when the phase is deleted between the check and the insert", async () => {
    openWorkRaces.beforeImportLock = () => {
      const at = phaseTables.phases.findIndex((phase) => phase.id === phases[4]!.id);
      phaseTables.phases.splice(at, 1);
    };

    const res = await upload(await one({}));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });
});

describe("POST /open-works/import: the same file twice", () => {
  it("answers 409 FILE_ALREADY_IMPORTED to a second import of the same file under a new key, and changes nothing", async () => {
    const file = await one({});
    expect((await upload(file)).status).toBe(201);

    const second = await upload(file);

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: "FILE_ALREADY_IMPORTED",
      message: "This file was already imported",
    });
    expect(created()).toHaveLength(1);
    expect(importBatchTable.rows).toHaveLength(1);
    expect(importAudit()).toHaveLength(1);
  });

  it("says so in Arabic", async () => {
    const file = await one({});
    await upload(file);

    const second = await upload(file, { language: "ar" });

    expect(second.body).toMatchObject({
      code: "FILE_ALREADY_IMPORTED",
      message: "تم استيراد هذا الملف من قبل",
    });
  });

  it("recognises the file by its content, not its name, and when another user imports it", async () => {
    const file = await one({});
    await upload(file, { filename: "first.xlsx" });

    expect((await upload(file, { filename: "renamed copy.xlsx" })).status).toBe(409);
    expect((await upload(file, { user: employee("other@example.test", "open-works:import") })).status).toBe(
      409,
    );
  });

  it("does not mistake the file for the contractors' or the villas' file of the same content", async () => {
    importBatchTable.rows.push({
      id: randomUUID(),
      entity: "Contractor",
      fileHash: sha256(await one({})),
      userId: admin.id,
      rows: 1,
      createdAt: new Date(),
    });

    expect((await upload(await one({}))).status).toBe(201);
  });

  it("lets only one of three imports of the same file at once save it", async () => {
    const file = await sheet(
      row({ villa: "P-001", phase: "Wall Piping" }),
      row({ villa: "P-002", phase: "Wall Piping" }),
    );

    const results = await Promise.all([upload(file), upload(file), upload(file)]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    expect(created()).toHaveLength(2);
    expect(importBatchTable.rows).toHaveLength(1);
  });
});

describe("POST /open-works/import: a villa or its contractor changes during the import", () => {
  const changeContractor = (villa: StoredVilla, contractorId: string | null) => () => {
    villaTables.villas.find((candidate) => candidate.id === villa.id)!.contractorId = contractorId;
  };

  it("answers 409 IMPORT_DATA_CHANGED and saves nothing when a villa's contractor changed after the check", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa1, delta.id);

    const res = await upload(await one({ contractor: "Nile Builders" }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "IMPORT_DATA_CHANGED",
      message:
        "A villa or its contractor changed while the file was being imported. Nothing was saved. Upload the file again",
    });
    nothingWritten();
  });

  it("answers 409 when the villa went away after the check", async () => {
    openWorkRaces.beforeImportLock = () => {
      villaTables.villas = villaTables.villas.filter((candidate) => candidate.id !== villa2.id);
    };

    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-002", phase: "Wall Piping" }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_DATA_CHANGED");
    nothingWritten();
  });

  it("saves nothing at all when only the last of many rows is stale", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa2, nile.id);

    const res = await upload(
      await sheet(
        row({ villa: "P-001", phase: "Wall Piping", contractor: "Nile Builders" }),
        row({ villa: "P-003", phase: "Wall Piping" }),
        row({ villa: "P-002", phase: "Wall Piping", contractor: "Delta Works" }),
      ),
    );

    expect(res.status).toBe(409);
    nothingWritten();
  });

  it("answers in Arabic", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa1, delta.id);

    const res = await upload(await one({ contractor: "Nile Builders" }), { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "تغيّرت فيلا أو مقاولها أثناء استيراد الملف. لم يُحفظ أي شيء. أعد رفع الملف",
    );
  });

  it("does not mind a contractor change on a row that names no contractor", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa1, delta.id);

    const res = await upload(await one({}));

    expect(res.status).toBe(201);
    expect(created()[0]?.contractorId).toBeNull();
  });

  it("does not mind a villa that got its first contractor, for a row that names none", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa3, nile.id);

    const res = await upload(await one({ villa: "P-003" }));

    expect(res.status).toBe(201);
  });

  it("gives the Idempotency-Key back, does not use up the file, and refuses the stale row on the next try", async () => {
    const key = newKey();
    const file = await one({ contractor: "Nile Builders" });
    openWorkRaces.beforeImportLock = changeContractor(villa1, delta.id);
    const first = await upload(file, { key });
    expect(first.status).toBe(409);
    expect(idempotencyTable.rows).toHaveLength(0);

    const again = await upload(file, { key });

    expect(again.status).toBe(422);
    expect(errorsOf(again)).toEqual([[2, TITLE.contractor, "CONTRACTOR_NOT_ON_VILLA"]]);
    expect(importBatchTable.rows).toHaveLength(0);
  });

  it("takes effect for a villa that is not in the file only if it is not locked: unrelated villas are left alone", async () => {
    openWorkRaces.beforeImportLock = changeContractor(villa2, nile.id);

    const res = await upload(await one({ contractor: "Nile Builders" }));

    expect(res.status).toBe(201);
  });
});

describe("POST /open-works/import: the Idempotency-Key", () => {
  it("is required: without it the import is refused with 400 and nothing runs", async () => {
    const res = await upload(await one({}), { key: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    nothingWritten();
  });

  it("is required for a dry run as well", async () => {
    const res = await upload(await one({}), { key: null, query: "?dryRun=true" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses a malformed key", async () => {
    const res = await upload(await one({}), { key: "short" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    nothingWritten();
  });

  it("replays the stored answer to a repeated request and does not import again", async () => {
    const key = newKey();
    const file = await sheet(
      row({ villa: "P-001", phase: "Wall Piping" }),
      row({ villa: "P-002", phase: "Wall Piping" }),
    );
    const first = await upload(file, { key });

    const replay = await upload(file, { key });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(created()).toHaveLength(2);
    expect(importBatchTable.rows).toHaveLength(1);
    expect(importAudit()).toHaveLength(1);
  });

  it("replays a dry run too", async () => {
    const key = newKey();
    const file = await one({});
    const first = await upload(file, { key, query: "?dryRun=true" });

    const replay = await upload(file, { key, query: "?dryRun=true" });

    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
  });

  it("answers 422 when the key is reused for a different file, or for the real import after a dry run", async () => {
    const key = newKey();
    await upload(await one({}), { key });
    const other = await upload(await one({ phase: "Sleeves", priority: "High" }), { key });

    const dryKey = newKey();
    const file = await one({ priority: "Low" });
    await upload(file, { key: dryKey, query: "?dryRun=true" });
    const real = await upload(file, { key: dryKey });

    expect([other.status, other.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect([real.status, real.body.code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
    expect(created()).toHaveLength(1);
  });

  it("keeps each user's keys apart", async () => {
    const key = newKey();
    await upload(await one({}), { key });

    const other = await upload(await one({ phase: "Sleeves", priority: "High" }), {
      key,
      user: employee("other@example.test", "open-works:import"),
    });

    expect(other.status).toBe(201);
  });
});

describe("POST /open-works/import: files that cannot be imported", () => {
  const refused = async (file: Buffer | null, options: UploadOptions = {}) => {
    const res = await upload(file, options);
    nothingWritten();
    expect(idempotencyTable.rows).toHaveLength(0);
    return res;
  };

  it("answers 400 NO_FILE_PROVIDED when there is no file, or it is in the wrong field", async () => {
    const none = await refused(null);
    const wrong = await refused(await one({}), { field: "upload" });

    expect(none.status).toBe(400);
    expect(none.body.code).toBe("NO_FILE_PROVIDED");
    expect(wrong.body.code).toBe("NO_FILE_PROVIDED");
  });

  it.each([["open-works.xls"], ["open-works.csv"], ["open-works.xlsx.exe"], ["open-works"]])(
    "answers 415 to a file named %s",
    async (filename) => {
      const res = await refused(await one({}), { filename });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
    },
  );

  it.each([
    ["a text file", Buffer.from("villa,phase\nP-001,Work\n")],
    ["a PDF", Buffer.from("%PDF-1.7 not a spreadsheet")],
    ["an empty file", Buffer.alloc(0)],
  ])("answers 415 to %s named .xlsx", async (_label, bytes) => {
    const res = await refused(bytes);

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 to a ZIP that is not a spreadsheet, and 413 to a file over 5 MB", async () => {
    const zip = await refused(zipOf([{ name: "notes.txt", data: Buffer.from("hello") }]));
    const big = await refused(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(5 * 1024 * 1024)]));

    expect([zip.status, zip.body.code]).toEqual([400, "IMPORT_FILE_UNREADABLE"]);
    expect([big.status, big.body.code]).toEqual([413, "FILE_TOO_LARGE"]);
  });

  it("answers 422 to more than 2,000 data rows, and to a file with a header and no rows", async () => {
    const rows = Array.from({ length: 2001 }, () => row({ villa: "P-001", phase: "Wall Piping" }));

    const tall = await refused(await sheet(...rows));
    const empty = await refused(await workbookOf([[...HEADER]]));

    expect([tall.status, tall.body.code]).toEqual([422, "IMPORT_TOO_MANY_ROWS"]);
    expect([empty.status, empty.body.code]).toEqual([422, "IMPORT_NO_ROWS"]);
  });

  it("reads the stored value of a formula as a plain value, and refuses a formula that has none", async () => {
    const file = await workbookOf([
      [...HEADER],
      row({ villa: "P-001", phase: { formula: '"Wall "&"Piping"', result: "Wall Piping" } }),
      row({ villa: "P-001", phase: "Wall Piping", progress: { formula: "1+1" } }),
    ]);

    const res = await upload(file);

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      { row: 3, column: TITLE.progress, code: "UNREADABLE_CELL", message: expect.any(String), value: null },
    ]);
    nothingWritten();
  });

  it("keeps a contractor name that looks like a formula as the text it is: it is not found, never run", async () => {
    const res = await upload(await one({ contractor: '=HYPERLINK("http://evil.test")' }));

    expect(errorsOf(res)).toEqual([[2, TITLE.contractor, "REFERENCE_NOT_FOUND"]]);
    expect(res.body.data.errors[0].value).toBe('=HYPERLINK("http://evil.test")');
  });

  it("reads only the first sheet", async () => {
    const file = await workbookOf([[...HEADER], row({ villa: "P-001", phase: "Wall Piping" })], {
      otherSheets: {
        Other: [[...HEADER], row({ villa: "P-002", phase: "Sleeves" })],
      },
    });

    const res = await upload(file);

    expect(res.body.data.total).toBe(1);
    expect(created().map((item) => item.villaId)).toEqual([villa1.id]);
  });
});

describe("POST /open-works/import: the header row", () => {
  const mismatch = async (headers: string[], language = "en") =>
    upload(await workbookOf([headers, ["P-001", "Work", "MEP"]]), { language });

  it("lists the columns that are missing, in the order of the template, with 400", async () => {
    const res = await mismatch([
      "Villa Number",
      "Electrical Phase",
      "Status",
      "Priority",
      "Progress",
      "Contractor",
    ]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "IMPORT_HEADER_MISMATCH",
      message: "The header row does not match the template",
    });
    expect(res.body.details).toEqual([
      { path: "Start Date", message: "This column is missing from the header row" },
      { path: "End Date", message: "This column is missing from the header row" },
    ]);
    nothingWritten();
  });

  it("refuses a column that is in neither list, Source among them: every open work is added by hand", async () => {
    const res = await mismatch([...HEADER, "Source", "Title", "Work Phase", "elecPhaseId"]);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "Source", message: "This column is not part of the template" },
      { path: "Title", message: "This column is not part of the template" },
      { path: "Work Phase", message: "This column is not part of the template" },
      { path: "elecPhaseId", message: "This column is not part of the template" },
    ]);
    nothingWritten();
  });

  it("lists a column that appears twice", async () => {
    const res = await mismatch([...HEADER, "Electrical Phase"]);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "Electrical Phase", message: "This column appears more than once in the header row" },
    ]);
  });

  it("matches the names exactly, so a different case is a mismatch", async () => {
    const res = await mismatch([
      "villa number",
      "electrical phase",
      "status",
      "priority",
      "progress",
      "contractor",
      "start date",
      "end date",
    ]);

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(16);
  });

  it("answers in the request language", async () => {
    const res = await mismatch(["Villa Number"], "ar");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("صف العناوين لا يطابق القالب");
    expect(res.body.details[0].message).toBe("هذا العمود غير موجود في صف العناوين");
  });

  it("does not store a refused file's key", async () => {
    const key = newKey();

    expect((await upload(await workbookOf([["Villa Number"], ["P-001"]]), { key })).status).toBe(400);

    expect(idempotencyTable.rows).toHaveLength(0);
  });
});

describe("POST /open-works/import: the rate limit", () => {
  it("answers 429 once a user has used the allowance for the window, in Arabic", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "open-works:import");

    const first = await upload(await one({ progress: 1 }), { user });
    const second = await upload(await one({ phase: "Sleeves", progress: 2 }), { user });
    const third = await upload(await one({ phase: "Ceiling Piping", progress: 3 }), { user, language: "ar" });

    expect([first.status, second.status, third.status]).toEqual([201, 201, 429]);
    expect(third.body).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "عدد الطلبات كبير جدًا" });
    expect(created()).toHaveLength(2);
  });

  it("counts a dry run and a refused file too, and each user separately", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const a = employee("a@example.test", "open-works:import");
    const b = employee("b@example.test", "open-works:import");

    await upload(await one({ progress: 1 }), { user: a, query: "?dryRun=true" });
    await upload(Buffer.from("junk"), { user: a });
    const third = await upload(await one({ progress: 3 }), { user: a });
    const other = await upload(await one({ progress: 4 }), { user: b });

    expect([third.status, other.status]).toEqual([429, 201]);
  });

  it("is not used up by a refusal for missing permission", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("nope@example.test", "open-works:read");

    const refusals = [await upload(await one({}), { user }), await upload(null, { user })];

    expect(refusals.map((res) => res.status)).toEqual([403, 403]);
  });
});

describe("POST /open-works/import: how the rows are written", () => {
  it("runs the import in a transaction that is given the time an import needs", async () => {
    const spy = vi.spyOn(InMemoryOpenWorksRepository.prototype, "transaction");

    const res = await upload(await one({}));

    expect(res.status).toBe(201);
    // The fake takes no options, so the calls are read as the real repository's are made.
    const calls = spy.mock.calls as unknown as [unknown, { timeout?: number }?][];
    expect(calls.some(([, options]) => options?.timeout === IMPORT_TRANSACTION_TIMEOUT_MS)).toBe(true);
    spy.mockRestore();
  });

  it("locks the villas it writes to in the order of their ids, each once", async () => {
    const spy = vi.spyOn(InMemoryOpenWorksRepository.prototype, "lockVillasShared");

    const res = await upload(
      await sheet(
        row({ villa: "P-003", phase: "Wall Piping" }),
        row({ villa: "P-001", phase: "Wall Piping" }),
        row({ villa: "P-003", phase: "Sleeves" }),
        row({ villa: "P-002", phase: "Wall Piping" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual(["villa-a", "villa-b", "villa-c"]);
    spy.mockRestore();
  });
});

describe("POST /open-works/import: a file that was exported", () => {
  const INFORMATIONAL = ["Location", "Overdue"];
  const exported = (...rows: ExcelJS.CellValue[][]): Promise<Buffer> =>
    workbookOf([[...HEADER, ...INFORMATIONAL], ...rows]);
  // A row as the export writes it: the eight importable cells, then the two informational ones.
  const line = (cells: Partial<Record<Header, ExcelJS.CellValue>>): ExcelJS.CellValue[] => [
    ...row(cells),
    "P-001, B1, 7",
    "No",
  ];

  it("imports every row, as an open work added by hand, and does not read the informational columns", async () => {
    const res = await upload(
      await exported(
        line({ villa: "P-001", phase: "Wall Piping", progress: 40 }),
        line({ villa: "P-002", phase: "Sleeves" }),
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ok: true, total: 2, imported: 2, skipped: 0, errors: [] });
    expect(created().map((item) => [item.villaId, item.elecPhaseId, item.source])).toEqual([
      [villa1.id, phases[4]!.id, "MANUAL"],
      [villa2.id, phases[5]!.id, "MANUAL"],
    ]);
  });

  it("takes the columns in any order, the informational ones among them", async () => {
    const shuffled = [...HEADER, ...INFORMATIONAL].reverse();
    const cells = line({ villa: "P-001", phase: "Wall Piping" });
    const bytes = await workbookOf([shuffled, [...cells].reverse()]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created().map((item) => [item.villaId, item.elecPhaseId])).toEqual([[villa1.id, phases[4]!.id]]);
  });

  it("refuses an informational column that is in the file twice, and any column that is not in either list", async () => {
    const twice = await upload(
      await workbookOf([
        [...HEADER, "Overdue", "Overdue"],
        ["P-001", "Wall Piping", null, null, null, null, null, null, "No", "No"],
      ]),
    );
    const unknown = await upload(await workbookOf([[...HEADER, ...INFORMATIONAL, "Notes"], []]));

    expect(twice.status).toBe(400);
    expect(twice.body.details).toEqual([
      { path: "Overdue", message: "This column appears more than once in the header row" },
    ]);
    expect(unknown.status).toBe(400);
    expect(unknown.body.details).toEqual([
      { path: "Notes", message: "This column is not part of the template" },
    ]);
    nothingWritten();
  });
});

describe("GET /open-works/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/open-works/import/template")
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
    addVilla({ id: "villa-nine", villaNumber: "P-9", contractorId: null });
    addVilla({ id: "villa-ten", villaNumber: "P-10", contractorId: null });
  });

  it("has a dropdown on the villa, the electrical phase, the contractor and the two fixed columns, and on no other", async () => {
    expect(dropdownsOf(await template())).toEqual({
      "Villa Number": ["P-001", "P-002", "P-003", "P-9", "P-10"],
      "Electrical Phase": phases.map((phase) => phase.name),
      Status: ["Not started", "In progress", "Delayed", "Done"],
      Priority: ["Low", "Medium", "High"],
      Contractor: ["Delta Works", "Nile Builders"],
    });
  });

  it("offers only values the import accepts: a file with every choice, one per row, has no reference or option error", async () => {
    const choices = dropdownsOf(await template());
    const progress: Record<string, number> = { "Not started": 0, "In progress": 40, Delayed: 40, Done: 100 };
    const rows = Array.from({ length: 5 }, (_, at) => {
      const status = choices.Status![at % choices.Status!.length]!;
      return row({
        villa: choices["Villa Number"]![at % choices["Villa Number"]!.length],
        phase: choices["Electrical Phase"]![at % choices["Electrical Phase"]!.length],
        status,
        priority: choices.Priority![at % choices.Priority!.length],
        progress: progress[status],
        contractor: choices.Contractor![at % choices.Contractor!.length],
      });
    });
    const res = await upload(await sheet(...rows), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    // A contractor is also checked against the villa's own: that is the one error left, and it is the server's to give.
    expect(errorsOf(res).filter(([, , code]) => code !== "CONTRACTOR_NOT_ON_VILLA")).toEqual([]);
    expect(res.body.data.total).toBe(5);
  });

  it("imports a filled-in template with the Lists sheet still in it, choosing a villa and its own contractor", async () => {
    const bytes = await filledTemplate(await template(), ["P-002", "Sleeves", "", "", "", "Delta Works"]);

    const res = await upload(bytes);

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({
      villaId: villa2.id,
      contractorId: delta.id,
    });
  });
});
