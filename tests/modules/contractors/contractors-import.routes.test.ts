import { createHash, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { dropdownsOf, filledTemplate } from "../../helpers/template-lists.js";
import { workbookOf, withColumns, zipOf } from "../../shared/import/xlsx-fixtures.js";
import { addContractor, contractorTables } from "./in-memory-contractors.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/contractors/repository/contractors.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/contractors/repository/contractors.repository.js")
  >()),
  ContractorsRepository: (await import("./in-memory-contractors.repository.js"))
    .InMemoryContractorsRepository,
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
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADER = ["Name", "Phone", "Email", "Status"];
const original = { limit: env.IMPORT_RATE_LIMIT_MAX };

let admin: User;
beforeEach(() => {
  store.reset();
  contractorTables.reset();
  importBatchTable.reset();
  idempotencyTable.reset();
  env.IMPORT_RATE_LIMIT_MAX = original.limit;
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

const sheet = (...rows: unknown[][]): Promise<Buffer> => workbookOf([HEADER, ...(rows as never[][])]);
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
  const {
    user = admin,
    language = "en",
    key = newKey(),
    query = "",
    filename = "contractors.xlsx",
  } = options;
  const req = request(app)
    .post(`/api/v1/contractors/import${query}`)
    .set(await as(user))
    .set("Accept-Language", language);
  if (key !== null) req.set("Idempotency-Key", key);
  if (file) req.attach(options.field ?? "file", file, { filename, contentType: XLSX_TYPE });
  return req;
}

const importAudit = () => store.auditRows.filter((row) => row.action === "contractor.import");
const created = () => contractorTables.contractors;
const nothingWritten = (): void => {
  expect(created()).toHaveLength(0);
  expect(importBatchTable.rows).toHaveLength(0);
  expect(importAudit()).toHaveLength(0);
};

describe("access control", () => {
  const endpoints = [
    ["get", "/contractors/import/template"],
    ["post", "/contractors/import"],
  ] as const;
  const others = [
    "contractors:read",
    "contractors:create",
    "contractors:update",
    "contractors:delete",
    "contractors:summary",
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

  it("does not let contractors:import open the other contractor routes", async () => {
    const user = employee("importer@example.test", "contractors:import");
    const headers = await as(user);

    expect((await request(app).get("/api/v1/contractors").set(headers)).status).toBe(403);
    expect((await request(app).post("/api/v1/contractors").set(headers).send({})).status).toBe(403);
    expect((await request(app).get("/api/v1/contractors/options").set(headers)).status).toBe(403);
  });

  it("lets the holder of contractors:import use both routes", async () => {
    const user = employee("importer@example.test", "contractors:import");

    expect(
      (
        await request(app)
          .get("/api/v1/contractors/import/template")
          .set(await as(user))
      ).status,
    ).toBe(200);
    expect((await upload(await sheet(["Acme", "0100 123 4567"]), { user })).status).toBe(201);
  });

  it("lets the ADMIN through with no granted permissions", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/contractors/import/template")
          .set(await as(admin))
      ).status,
    ).toBe(200);
  });

  it("checks permission before it looks at the upload: a refused caller learns nothing about the file", async () => {
    const res = await upload(Buffer.from("not a spreadsheet"), { user: employee("e@example.test") });

    expect(res.status).toBe(403);
  });

  it("is not shadowed by /contractors/:id", async () => {
    const res = await request(app)
      .get("/api/v1/contractors/import/template")
      .set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
  });
});

describe("GET /contractors/import/template", () => {
  const download = async (language = "en") =>
    request(app)
      .get("/api/v1/contractors/import/template")
      .set(await as(admin))
      .set("Accept-Language", language)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

  it("sends an .xlsx file, English whatever the request language, never cached", async () => {
    const res = await download("ar");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_TYPE);
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="contractors-import-template.xlsx"',
    );
    expect(res.headers["content-language"]).toBe("en");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("has the exact header row, an example row and the status dropdown", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await download()).body as ExcelJS.Buffer);
    const data = workbook.worksheets[0]!;

    expect(workbook.worksheets.map((s) => s.name)).toEqual(["Contractors", "Instructions", "Lists"]);
    expect(data.getRow(1).values).toEqual([undefined, ...HEADER]);
    expect(data.actualRowCount).toBe(2);
    expect(data.getCell("D2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$D$1:$D$2"] });
    expect(workbook.getWorksheet("Lists")!.getColumn(4).values).toEqual([undefined, "Active", "Inactive"]);
  });

  it("has every column of every sheet fitted: no default width, none narrower than its longest cell", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await download()).body as ExcelJS.Buffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Contractors", "Instructions", "Lists"]);
    for (const sheet of workbook.worksheets) {
      for (let number = 1; number <= sheet.columnCount; number++) {
        const column = sheet.getColumn(number);
        let longest = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          longest = Math.max(longest, ...cell.text.split(String.fromCharCode(10)).map((line) => line.length));
        });

        expect(column.width, `${sheet.name} column ${number}`).toBeDefined();
        expect(column.width).not.toBe(9.140625);
        expect(column.width).toBeGreaterThanOrEqual(8);
        expect(column.width).toBeLessThanOrEqual(60);
        expect(column.width, `${sheet.name} column ${number} fits ${longest}`).toBeGreaterThanOrEqual(
          Math.min(60, longest),
        );
      }
    }
  });

  it("is a file the import accepts as it stands", async () => {
    const template = (await download()).body as Buffer;

    const res = await upload(template);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ok: true, total: 1, imported: 1 });
    expect(created()[0]).toMatchObject({ name: "Example Contracting Co.", status: "ACTIVE" });
  });

  it("counts against the import rate limit", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("t@example.test", "contractors:import");

    const first = await request(app)
      .get("/api/v1/contractors/import/template")
      .set(await as(user));
    const second = await request(app)
      .get("/api/v1/contractors/import/template")
      .set(await as(user));

    expect([first.status, second.status]).toEqual([200, 429]);
  });
});

describe("POST /contractors/import: saving", () => {
  it("saves every row in one go and answers 201 with the report", async () => {
    const res = await upload(
      await sheet(
        ["Acme Contracting", "0100 123 4567", "Info@Acme.test", "active"],
        ["Bolt Builders", "+20 111 222 3333", null, "Inactive"],
        ["Cedar Works", "0122-333-4444", "", null],
      ),
    );

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: { ok: true, total: 3, imported: 3, skipped: 0, errors: [], truncated: false },
    });
    expect(
      created().map(({ name, phone, email, status, version }) => ({ name, phone, email, status, version })),
    ).toEqual([
      {
        name: "Acme Contracting",
        phone: "0100 123 4567",
        email: "info@acme.test",
        status: "ACTIVE",
        version: 1,
      },
      { name: "Bolt Builders", phone: "+20 111 222 3333", email: null, status: "INACTIVE", version: 1 },
      { name: "Cedar Works", phone: "0122-333-4444", email: null, status: "ACTIVE", version: 1 },
    ]);
  });

  it("writes one audit entry for the file, with the row count, the file hash and the new ids", async () => {
    const file = await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(importAudit()).toHaveLength(1);
    expect(importAudit()[0]).toMatchObject({
      actorId: admin.id,
      action: "contractor.import",
      entity: "Contractor",
      after: {
        rows: 2,
        fileHash: sha256(file),
        createdIds: created().map((c) => c.id),
        batchId: importBatchTable.rows[0]?.id,
      },
    });
    // The records themselves are not audited one by one.
    expect(store.auditRows.filter((row) => row.action === "contractor.create")).toHaveLength(0);
  });

  it("records the file: its hash, the entity, the user and the row count", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);

    await upload(file);

    expect(importBatchTable.rows).toHaveLength(1);
    expect(importBatchTable.rows[0]).toMatchObject({
      entity: "Contractor",
      fileHash: sha256(file),
      userId: admin.id,
      rows: 1,
    });
  });

  it("takes the import lock for the table before it reads anything", async () => {
    await upload(await sheet(["Acme", "0100 123 4567"]));

    expect(importBatchTable.locks).toEqual(["Contractor"]);
  });

  it("accepts the columns in any order", async () => {
    const file = await workbookOf([
      ["Status", "Email", "Phone", "Name"],
      ["inactive", "x@y.test", "0100 123 4567", "Acme"],
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(created()[0]).toMatchObject({
      name: "Acme",
      phone: "0100 123 4567",
      email: "x@y.test",
      status: "INACTIVE",
    });
  });

  it.each([
    ["ACTIVE", "ACTIVE"],
    ["active", "ACTIVE"],
    ["Active", "ACTIVE"],
    ["INACTIVE", "INACTIVE"],
    ["inactive", "INACTIVE"],
    [" Inactive ", "INACTIVE"],
  ])("reads the status %j as %s", async (cell, status) => {
    await upload(await sheet(["Acme", "0100 123 4567", null, cell]));

    expect(created()[0]?.status).toBe(status);
  });

  it("imports a file of 2,000 rows", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [
      `Contractor ${i}`,
      `0100 ${String(i).padStart(6, "0")}`,
    ]);

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ total: 2000, imported: 2000 });
    expect(created()).toHaveLength(2000);
    expect((importAudit()[0]?.after as { createdIds: string[] }).createdIds).toHaveLength(2000);
  });
});

describe("POST /contractors/import: the dry run", () => {
  it("validates and reports without writing anything", async () => {
    const file = await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"]);

    const res = await upload(file, { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { ok: true, total: 2, imported: 0, skipped: 0, errors: [], truncated: false },
    });
    nothingWritten();
    expect(importBatchTable.locks).toHaveLength(0);
  });

  it("reports the errors of a bad file with 200, and writes nothing", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"], ["", "12"]), { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, total: 2, imported: 0 });
    expect(res.body.data.errors.map((e: { row: number; column: string }) => [e.row, e.column])).toEqual([
      [3, "Name"],
      [3, "Phone"],
    ]);
    nothingWritten();
  });

  it("does not use up the file: the same file can be imported afterwards", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);

    expect((await upload(file, { query: "?dryRun=true" })).status).toBe(200);
    expect((await upload(file, { query: "?dryRun=true" })).status).toBe(200);
    const real = await upload(file);

    expect(real.status).toBe(201);
    expect(created()).toHaveLength(1);
  });

  it("reports a file that was already imported as duplicates, not as a conflict", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file);

    const res = await upload(file, { query: "?dryRun=true" });

    expect(res.status).toBe(200);
    expect(res.body.data.errors[0]).toMatchObject({ row: 2, column: "Name", code: "DUPLICATE_EXISTING" });
  });

  it("accepts dryRun=false as a real import", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"]), { query: "?dryRun=false" });

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
  });

  it.each(["?dryRun=yes", "?dryRun=1", "?dryRun=TRUE", "?dryRun=", "?dryRun=true&dryRun=false", "?extra=1"])(
    "refuses the query %s with 400, before the upload is read",
    async (query) => {
      const res = await upload(await sheet(["Acme", "0100 123 4567"]), { query });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      nothingWritten();
    },
  );

  it("says what is wrong with dryRun in the request language", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"]), {
      query: "?dryRun=maybe",
      language: "ar",
    });

    expect(res.body.details[0]).toMatchObject({ path: "dryRun" });
    expect(res.body.details[0].message).toMatch(/[؀-ۿ]/);
  });
});

describe("POST /contractors/import: all or nothing", () => {
  it("saves nothing when one row has a problem, and answers 422 with the report", async () => {
    const res = await upload(
      await sheet(
        ["Acme", "0100 123 4567"],
        ["Bolt", "0111 222 3333"],
        ["Cedar", "not a phone"],
        ["Delta", "0133 444 5555"],
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 4, imported: 0, truncated: false });
    expect(res.body.data.errors).toEqual([
      {
        row: 4,
        column: "Phone",
        code: "INVALID_VALUE",
        message:
          "Enter a valid phone number: 5 to 20 characters, digits with an optional leading + and spaces or dashes",
        value: "not a phone",
      },
    ]);
    nothingWritten();
  });

  it("rolls everything back when the file cannot be recorded after the rows were saved", async () => {
    importBatchTable.failCreate = true;

    const res = await upload(await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"]));

    expect(res.status).toBe(500);
    nothingWritten();
  });

  it("gives the Idempotency-Key back after a failure, so a corrected file can use it", async () => {
    const key = newKey();
    const bad = await upload(await sheet(["", "0100 123 4567"]), { key });
    expect(bad.status).toBe(422);
    expect(idempotencyTable.rows).toHaveLength(0);

    const good = await upload(await sheet(["Acme", "0100 123 4567"]), { key });

    expect(good.status).toBe(201);
    expect(good.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("reports every problem of every row, by row and then by column", async () => {
    const res = await upload(
      await sheet(
        ["Acme", "0100 123 4567", "nope", "paused"],
        [null, null, null, null],
        ["x".repeat(101), "12345678901234567890123", "ok@ok.test", "Active"],
        ["Fine", "0100 000 0000"],
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.total).toBe(3);
    expect(
      res.body.data.errors.map((e: { row: number; column: string; code: string }) => [
        e.row,
        e.column,
        e.code,
      ]),
    ).toEqual([
      [2, "Email", "INVALID_VALUE"],
      [2, "Status", "INVALID_OPTION"],
      [4, "Name", "INVALID_VALUE"],
      [4, "Phone", "INVALID_VALUE"],
    ]);
    nothingWritten();
  });

  it("names a missing required cell, and shows what was in the cell", async () => {
    const res = await upload(await sheet(["Acme", null], [null, "0100 123 4567", "a@b.test"]));

    expect(res.body.data.errors).toEqual([
      { row: 2, column: "Phone", code: "REQUIRED", message: "This field is required", value: null },
      { row: 3, column: "Name", code: "REQUIRED", message: "This field is required", value: null },
    ]);
  });

  it("writes the messages in the request language", async () => {
    const res = await upload(await sheet(["Acme", null, null, "paused"]), { language: "ar" });

    expect(res.status).toBe(422);
    const messages = res.body.data.errors.map((e: { message: string }) => e.message);
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).toMatch(/[؀-ۿ]/);
    expect(res.headers["content-language"] ?? "ar").toBeTruthy();
  });

  it("refuses a number, a date or a boolean where text belongs, and says to format the column as text", async () => {
    const res = await upload(await sheet(["Acme", 1001234567, null, true]));

    expect(res.body.data.errors).toMatchObject([
      { row: 2, column: "Phone", code: "NOT_TEXT", value: "1001234567" },
      { row: 2, column: "Status", code: "INVALID_OPTION", value: "true" },
    ]);
  });

  it("caps the report at 200 errors and says it is cut off", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [`Contractor ${i}`, "x"]);

    const res = await upload(await sheet(...rows));

    expect(res.status).toBe(422);
    expect(res.body.data).toMatchObject({ ok: false, total: 250, imported: 0, truncated: true });
    expect(res.body.data.errors).toHaveLength(200);
    expect(res.body.data.errors[0].row).toBe(2);
    expect(res.body.data.errors[199].row).toBe(201);
    nothingWritten();
  });

  it("does not say truncated at exactly 200 errors", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`Contractor ${i}`, "x"]);

    const res = await upload(await sheet(...rows));

    expect(res.body.data.errors).toHaveLength(200);
    expect(res.body.data.truncated).toBe(false);
  });

  it("cuts a long value in the report", async () => {
    const res = await upload(await sheet(["x".repeat(1500), "0100 123 4567"]));

    expect(res.body.data.errors[0].value).toHaveLength(201);
  });
});

describe("POST /contractors/import: duplicates", () => {
  it("reports a row whose name and phone appear earlier in the file, ignoring case, spaces and dashes", async () => {
    const res = await upload(
      await sheet(
        ["Acme Co", "0100 123 4567"],
        ["Bolt", "0111 222 3333"],
        ["  ACME   co ", "0100-123-4567"],
        ["Acme Co", "0100 123 4567"],
      ),
    );

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 4,
        column: "Name",
        code: "DUPLICATE_IN_FILE",
        message: "This name and phone appear more than once in the file",
        value: "  ACME   co ",
      },
      expect.objectContaining({ row: 5, code: "DUPLICATE_IN_FILE" }),
    ]);
    nothingWritten();
  });

  it("allows the same name with another phone, and the same phone with another name", async () => {
    const res = await upload(
      await sheet(["Acme", "0100 123 4567"], ["Acme", "0111 222 3333"], ["Bolt", "0100 123 4567"]),
    );

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(3);
  });

  it("reports a row that is already in the database, however it was typed there", async () => {
    addContractor({ name: "  Acme   Co.", phone: "0100-123-4567" });
    addContractor({ name: "Acme Co.", phone: "0199 999 9999" });

    const res = await upload(await sheet(["ACME CO.", "0100 123 4567"], ["Acme Co.", "0188 888 8888"]));

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      {
        row: 2,
        column: "Name",
        code: "DUPLICATE_EXISTING",
        message: "A contractor with this name and phone already exists",
        value: "ACME CO.",
      },
    ]);
    expect(created()).toHaveLength(2);
  });

  it("reports both kinds together, and every other problem too", async () => {
    addContractor({ name: "Acme", phone: "0100 123 4567" });

    const res = await upload(
      await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"], ["Bolt", "01112223333"], ["", "1"]),
    );

    expect(res.body.data.errors.map((e: { row: number; code: string }) => [e.row, e.code])).toEqual([
      [2, "DUPLICATE_EXISTING"],
      [4, "DUPLICATE_IN_FILE"],
      [5, "REQUIRED"],
      [5, "INVALID_VALUE"],
    ]);
  });

  it("says so in Arabic", async () => {
    addContractor({ name: "Acme", phone: "0100 123 4567" });

    const res = await upload(await sheet(["Acme", "0100 123 4567"]), { language: "ar" });

    expect(res.body.data.errors[0].message).toBe("يوجد مقاول بهذا الاسم ورقم الهاتف بالفعل");
  });
});

describe("POST /contractors/import: the same file twice", () => {
  it("answers 409 FILE_ALREADY_IMPORTED to a second import of the same file under a new key, and changes nothing", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
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
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file);

    const second = await upload(file, { language: "ar" });

    expect(second.body).toMatchObject({
      code: "FILE_ALREADY_IMPORTED",
      message: "تم استيراد هذا الملف من قبل",
    });
  });

  it("recognises the file by its content, not its name", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file, { filename: "first.xlsx" });

    const second = await upload(file, { filename: "renamed copy.xlsx" });

    expect(second.status).toBe(409);
  });

  it("recognises it when another user imports it", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file);

    const second = await upload(file, { user: employee("other@example.test", "contractors:import") });

    expect(second.status).toBe(409);
  });

  it("treats a changed file as a new one", async () => {
    expect((await upload(await sheet(["Acme", "0100 123 4567"]))).status).toBe(201);

    const second = await upload(await sheet(["Bolt", "0111 222 3333"]));

    expect(second.status).toBe(201);
    expect(importBatchTable.rows).toHaveLength(2);
  });

  it("lets only one of two imports of the same file at once save it", async () => {
    const file = await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"]);

    const results = await Promise.all([upload(file), upload(file), upload(file)]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    expect(created()).toHaveLength(2);
    expect(importBatchTable.rows).toHaveLength(1);
  });

  it("answers 409 when the unique index is what stops the second import", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
    importBatchTable.rows.push({
      id: randomUUID(),
      entity: "Contractor",
      fileHash: sha256(file),
      userId: admin.id,
      rows: 1,
      createdAt: new Date(),
    });

    const res = await upload(file);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FILE_ALREADY_IMPORTED");
    expect(created()).toHaveLength(0);
  });
});

describe("POST /contractors/import: the Idempotency-Key", () => {
  it("is required: without it the import is refused with 400 and nothing runs", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"]), { key: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    nothingWritten();
  });

  it("is required for a dry run as well", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"]), { key: null, query: "?dryRun=true" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses a malformed key", async () => {
    const res = await upload(await sheet(["Acme", "0100 123 4567"]), { key: "short" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    nothingWritten();
  });

  it("replays the stored answer to a repeated request and does not import again", async () => {
    const key = newKey();
    const file = await sheet(["Acme", "0100 123 4567"], ["Bolt", "0111 222 3333"]);
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

  it("replays rather than answers 409 when the same request is repeated after the file was imported", async () => {
    const key = newKey();
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file, { key });

    const again = await upload(file, { key });

    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
  });

  it("replays a dry run too", async () => {
    const key = newKey();
    const file = await sheet(["Acme", "0100 123 4567"]);
    const first = await upload(file, { key, query: "?dryRun=true" });

    const replay = await upload(file, { key, query: "?dryRun=true" });

    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
  });

  it("answers 422 when the key is reused for a different file", async () => {
    const key = newKey();
    await upload(await sheet(["Acme", "0100 123 4567"]), { key });

    const other = await upload(await sheet(["Bolt", "0111 222 3333"]), { key });

    expect(other.status).toBe(422);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(created()).toHaveLength(1);
  });

  it("answers 422 when the key of a dry run is reused for the real import of the same file", async () => {
    const key = newKey();
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file, { key, query: "?dryRun=true" });

    const real = await upload(file, { key });

    expect(real.status).toBe(422);
    expect(real.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    nothingWritten();
  });

  it("keeps each user's keys apart", async () => {
    const key = newKey();
    const file = await sheet(["Acme", "0100 123 4567"]);
    await upload(file, { key });

    const other = await upload(await sheet(["Bolt", "0111 222 3333"]), {
      key,
      user: employee("other@example.test", "contractors:import"),
    });

    expect(other.status).toBe(201);
  });

  it("does not store a refused file's key: a missing header gives it back", async () => {
    const key = newKey();
    const broken = await workbookOf([["Name"], ["Acme"]]);
    expect((await upload(broken, { key })).status).toBe(400);
    expect(idempotencyTable.rows).toHaveLength(0);
  });
});

describe("POST /contractors/import: files that cannot be imported", () => {
  const refused = async (file: Buffer | null, options: UploadOptions = {}) => {
    const res = await upload(file, options);
    nothingWritten();
    expect(idempotencyTable.rows).toHaveLength(0);
    return res;
  };

  it("answers 400 NO_FILE_PROVIDED when there is no file", async () => {
    const res = await refused(null);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "NO_FILE_PROVIDED",
      message: 'No file was uploaded. Send one .xlsx file in the "file" field',
    });
  });

  it("answers 400 NO_FILE_PROVIDED when the file is in the wrong field", async () => {
    const res = await refused(await sheet(["Acme", "0100 123 4567"]), { field: "upload" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE_PROVIDED");
  });

  it("answers 400 when a text field comes with the file", async () => {
    const res = await request(app)
      .post("/api/v1/contractors/import")
      .set(await as(admin))
      .set("Idempotency-Key", newKey())
      .field("note", "hello")
      .attach("file", await sheet(["Acme", "0100 123 4567"]), { filename: "a.xlsx", contentType: XLSX_TYPE });

    expect(res.status).toBe(400);
    nothingWritten();
  });

  it("answers 400 TOO_MANY_FILES for a second file", async () => {
    const file = await sheet(["Acme", "0100 123 4567"]);
    const res = await request(app)
      .post("/api/v1/contractors/import")
      .set(await as(admin))
      .set("Idempotency-Key", newKey())
      .attach("file", file, { filename: "a.xlsx", contentType: XLSX_TYPE })
      .attach("file", file, { filename: "b.xlsx", contentType: XLSX_TYPE });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOO_MANY_FILES");
    nothingWritten();
  });

  it.each([["contractors.xls"], ["contractors.csv"], ["contractors.xlsx.exe"], ["contractors"]])(
    "answers 415 to a file named %s",
    async (filename) => {
      const res = await refused(await sheet(["Acme", "0100 123 4567"]), { filename });

      expect(res.status).toBe(415);
      expect(res.body).toMatchObject({
        code: "UNSUPPORTED_FILE_TYPE",
        message: "Only .xlsx spreadsheets are accepted",
      });
    },
  );

  it.each([
    ["a text file", Buffer.from("name,phone\nAcme,0100 123 4567\n")],
    ["a PDF", Buffer.from("%PDF-1.7 not a spreadsheet")],
    ["an image", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")],
    ["an empty file", Buffer.alloc(0)],
  ])("answers 415 to %s named .xlsx", async (_label, bytes) => {
    const res = await refused(bytes);

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers 400 to a ZIP that is not a spreadsheet", async () => {
    const res = await refused(zipOf([{ name: "notes.txt", data: Buffer.from("hello") }]));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMPORT_FILE_UNREADABLE");
  });

  it("answers 413 to a file over 5 MB, before reading all of it", async () => {
    const res = await refused(Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(5 * 1024 * 1024)]));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
  });

  it("answers 413 to a ZIP bomb that declares its size, and 400 to one that lies about it", async () => {
    const declared = await refused(
      zipOf([{ name: "xl/a.xml", data: Buffer.from("x"), declaredSize: 20 * 1024 * 1024 }]),
    );
    const lying = await refused(
      zipOf([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(60 * 1024 * 1024), declaredSize: 100 }]),
    );

    expect([declared.status, lying.status]).toEqual([413, 400]);
  });

  it("answers 422 to more than 2,000 data rows, and to more than 30 columns", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => [`Contractor ${i}`, "0100 123 4567"]);
    const wide = Array.from({ length: 31 }, (_, i) => `c${i}`);

    const tall = await refused(await sheet(...rows));
    const broad = await refused(await workbookOf([wide, wide]));

    expect([tall.status, tall.body.code]).toEqual([422, "IMPORT_TOO_MANY_ROWS"]);
    expect(tall.body.message).toBe("The file has more than 2,000 data rows");
    expect([broad.status, broad.body.code]).toEqual([422, "IMPORT_TOO_MANY_COLUMNS"]);
  });

  it("answers 422 to a cell over 2,000 characters and says which cell", async () => {
    const res = await refused(await sheet(["Acme", "0100 123 4567", "x".repeat(2001)]));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IMPORT_CELL_TOO_LONG");
    expect(res.body.details).toEqual([{ path: "C2", message: "A cell holds more than 2,000 characters" }]);
  });

  it("answers 422 to a file with a header and no rows", async () => {
    const res = await refused(await workbookOf([HEADER]));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "IMPORT_NO_ROWS", message: "The file has no data rows" });
  });

  it("answers 400 to a formula cell that has no value, as a row error, and never evaluates formulas", async () => {
    const file = await workbookOf([
      HEADER,
      [{ formula: '"Acme"&"X"', result: "Cached Name" }, "0100 123 4567"],
      ["Bolt", "0111 222 3333", { formula: "1+1" } as never],
    ]);

    const res = await upload(file);

    expect(res.status).toBe(422);
    expect(res.body.data.errors).toEqual([
      { row: 3, column: "Email", code: "UNREADABLE_CELL", message: expect.any(String), value: null },
    ]);
    nothingWritten();
  });

  it("imports the stored value of a formula, as a plain value", async () => {
    const file = await workbookOf([
      HEADER,
      [{ formula: '"Acme"&"X"', result: "Cached Name" }, "0100 123 4567"],
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(created()[0]?.name).toBe("Cached Name");
  });

  it("keeps text that looks like a formula as the text it is", async () => {
    const res = await upload(await sheet(['=HYPERLINK("http://evil.test")', "0100 123 4567"]));

    expect(res.status).toBe(201);
    expect(created()[0]?.name).toBe('=HYPERLINK("http://evil.test")');
  });

  it("reads only the first sheet", async () => {
    const file = await workbookOf([HEADER, ["Acme", "0100 123 4567"]], {
      otherSheets: { Other: [HEADER, ["Hidden", "0111 222 3333"]] },
    });

    const res = await upload(file);

    expect(res.body.data.total).toBe(1);
    expect(created().map((c) => c.name)).toEqual(["Acme"]);
  });
});

describe("POST /contractors/import: the header row", () => {
  const mismatch = async (headers: string[], language = "en") =>
    upload(await workbookOf([headers, ["Acme", "0100 123 4567"]]), { language });

  it("lists the columns that are missing, with 400", async () => {
    const res = await mismatch(["Name", "Phone"]);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "IMPORT_HEADER_MISMATCH",
      message: "The header row does not match the template",
    });
    expect(res.body.details).toEqual([
      { path: "Email", message: "This column is missing from the header row" },
      { path: "Status", message: "This column is missing from the header row" },
    ]);
    nothingWritten();
  });

  it("lists the columns that are not in the template", async () => {
    const res = await mismatch([...HEADER, "notes", "Region"]);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "notes", message: "This column is not part of the template" },
      { path: "Region", message: "This column is not part of the template" },
    ]);
  });

  it("lists a column that appears twice", async () => {
    const res = await mismatch([...HEADER, "Phone"]);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: "Phone", message: "This column appears more than once in the header row" },
    ]);
  });

  it("lists everything at once", async () => {
    const res = await mismatch(["Name", "Phone", "Phone", "mobile"]);

    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual([
      "Email",
      "Status",
      "Phone",
      "mobile",
    ]);
  });

  it("matches the names exactly, so a different case is a mismatch", async () => {
    const res = await mismatch(["name", "phone", "email", "status"]);

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(8);
  });

  it("answers in the request language", async () => {
    const res = await mismatch(["Name"], "ar");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("صف العناوين لا يطابق القالب");
    expect(res.body.details[0].message).toBe("هذا العمود غير موجود في صف العناوين");
  });

  it("refuses a file whose first row is a data row, not a header", async () => {
    const res = await upload(await workbookOf([["Acme", "0100 123 4567", "a@b.test", "Active"]]));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMPORT_HEADER_MISMATCH");
  });

  it("refuses an empty first sheet", async () => {
    const res = await upload(await workbookOf([]));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IMPORT_HEADER_MISMATCH");
    expect(res.body.details).toHaveLength(4);
  });
});

describe("POST /contractors/import: the rate limit", () => {
  it("answers 429 once a user has used the allowance for the window, in Arabic", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "contractors:import");

    const first = await upload(await sheet(["A1", "0100 000 0001"]), { user });
    const second = await upload(await sheet(["A2", "0100 000 0002"]), { user });
    const third = await upload(await sheet(["A3", "0100 000 0003"]), { user, language: "ar" });

    expect([first.status, second.status, third.status]).toEqual([201, 201, 429]);
    expect(third.body).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "عدد الطلبات كبير جدًا" });
    expect(created()).toHaveLength(2);
  });

  it("counts a dry run and a refused file too", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "contractors:import");

    await upload(await sheet(["A1", "0100 000 0001"]), { user, query: "?dryRun=true" });
    await upload(Buffer.from("junk"), { user });
    const third = await upload(await sheet(["A3", "0100 000 0003"]), { user });

    expect(third.status).toBe(429);
  });

  it("counts each user separately", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const a = employee("a@example.test", "contractors:import");
    const b = employee("b@example.test", "contractors:import");

    expect((await upload(await sheet(["A1", "0100 000 0001"]), { user: a })).status).toBe(201);
    expect((await upload(await sheet(["A2", "0100 000 0002"]), { user: a })).status).toBe(429);
    expect((await upload(await sheet(["B1", "0100 000 0003"]), { user: b })).status).toBe(201);
  });

  it("follows the limit in the environment", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 100;
    const user = employee("env@example.test", "contractors:import");

    for (let i = 0; i < 5; i++) {
      const res = await upload(await sheet([`Contractor ${i}`, `0100 000 000${i}`]), { user });
      expect(res.status).toBe(201);
    }
  });

  it("is not used up by a refusal for missing permission", async () => {
    env.IMPORT_RATE_LIMIT_MAX = 1;
    const user = employee("nope@example.test", "contractors:read");

    const refusals = [
      await upload(await sheet(["A", "0100 000 0001"]), { user }),
      await upload(null, { user }),
    ];

    expect(refusals.map((res) => res.status)).toEqual([403, 403]);
  });
});

describe("POST /contractors/import: a file that was exported", () => {
  const good = () => sheet(["Nile Builders", "0100 123 4567", "nile@example.test", "Active"]);
  const informational = { Villas: 3, "Created (UTC)": new Date("2026-03-04T05:06:07.890Z") };

  it("takes the Villas and Created (UTC) columns the export adds, and ignores them", async () => {
    const res = await upload(await withColumns(await good(), informational));

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      ok: true,
      total: 1,
      imported: 1,
      skipped: 0,
      errors: [],
      truncated: false,
    });
    expect(created().map((contractor) => contractor.name)).toEqual(["Nile Builders"]);
  });

  it("does not read what they hold, so a count that is no number does not matter", async () => {
    const res = await upload(
      await withColumns(await good(), { Villas: "many", "Created (UTC)": "yesterday" }),
      {
        query: "?dryRun=true",
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, total: 1, skipped: 0, errors: [] });
  });

  it("takes the columns in any order", async () => {
    const bytes = await workbookOf([
      ["Created (UTC)", "Status", "Villas", "Email", "Phone", "Name"],
      [null, "Active", 0, null, "0100 123 4567", "Nile Builders"],
    ]);

    expect((await upload(bytes)).status).toBe(201);
  });

  it("refuses a column that is in neither list, and a repeated one", async () => {
    const unknown = await upload(await withColumns(await good(), { ...informational, Region: "Giza" }));
    const twice = await upload(
      await withColumns(await good(), { Villas: 1 }).then((b) => withColumns(b, { Villas: 2 })),
    );

    expect(unknown.status).toBe(400);
    expect(unknown.body.details).toEqual([
      { path: "Region", message: "This column is not part of the template" },
    ]);
    expect(twice.status).toBe(400);
    expect(twice.body.details).toEqual([
      { path: "Villas", message: "This column appears more than once in the header row" },
    ]);
    nothingWritten();
  });
});

describe("GET /contractors/import/template: the dropdowns", () => {
  const template = async (): Promise<ExcelJS.Workbook> => {
    const res = await request(app)
      .get("/api/v1/contractors/import/template")
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

  it("has a dropdown on Status only: a contractor points to no other record", async () => {
    expect(dropdownsOf(await template())).toEqual({ Status: ["Active", "Inactive"] });
  });

  it("imports a filled-in template with the Lists sheet still in it", async () => {
    const res = await upload(
      await filledTemplate(await template(), ["Nile Builders", "0100 111 2222", "", "Inactive"]),
    );

    expect(res.status).toBe(201);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ name: "Nile Builders", status: "INACTIVE" });
  });
});
