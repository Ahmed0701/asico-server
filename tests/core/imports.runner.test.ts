import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/core/errors/AppError.js";
import type { Db } from "../../src/core/imports/repository.js";
import { ImportRunner, type ImportDefinition } from "../../src/core/imports/runner.js";
import type { RequestContext } from "../../src/core/middleware/requestContext.js";
import {
  buildReferenceIndex,
  enumCell,
  enumSpec,
  joinKey,
  normalizeText,
  referenceCell,
  RowParser,
  textCell,
  type ImportColumn,
} from "../../src/shared/import/index.js";
import { name } from "../../src/shared/validation/fields.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

const record = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/core/audit/audit.js")>()),
  audit: { record },
}));

// A made-up table, to show the framework is not about contractors: a unit has a name, a kind (an enum) and an area
// (a reference to another table, by name).
type Unit = { name: string; kind: "SMALL" | "LARGE"; areaId: string | undefined };
type Lookups = { areas: ReturnType<typeof buildReferenceIndex> };

const KIND = enumSpec(["SMALL", "LARGE"] as const, { SMALL: "Small", LARGE: "Large" });
const columns: ImportColumn[] = [
  { header: "name", kind: "text", required: true, description: "", example: "" },
  { header: "kind", kind: "text", required: true, description: "", example: "", values: ["Small", "Large"] },
  { header: "area", kind: "text", required: false, description: "", example: "" },
];
const AREAS = [
  { id: "a-1", name: "New Cairo" },
  { id: "a-2", name: "Zayed" },
  { id: "a-3", name: "Maadi" },
  { id: "a-4", name: "maadi" },
];

const tx = { tx: true } as unknown as Db;
const readDb = { readDb: true } as unknown as Db;
const stored = new Set<string>();
const inserted: Unit[][] = [];
const calls: string[] = [];
const loadLookups = vi.fn();
const findExisting = vi.fn();
const insert = vi.fn();

const unitKey = (row: Unit): string => joinKey(normalizeText(row.name));

function definition(): ImportDefinition<Unit, Lookups> {
  return {
    entity: "Unit",
    action: "unit.import",
    sheetName: "Units",
    plural: "units",
    fileName: "units.xlsx",
    columns,
    keyColumn: "name",
    duplicateInFileKey: "import.contractorDuplicateInFile",
    duplicateExistingKey: "import.contractorDuplicateExisting",
    loadLookups,
    parseRow: (cells, lookups) => {
      const cell = (header: string) => cells[header] ?? null;
      const parser = new RowParser();
      const unitName = parser.take("name", cell("name"), textCell(cell("name"), name, { required: true }));
      const kind = parser.take("kind", cell("kind"), enumCell(cell("kind"), KIND, { required: true }));
      const areaId = parser.take(
        "area",
        cell("area"),
        referenceCell(cell("area"), lookups.areas, { required: false }),
      );
      if (!parser.ok || unitName === undefined || kind === undefined) {
        return { value: undefined, issues: parser.issues };
      }
      return { value: { name: unitName, kind, areaId }, issues: [] };
    },
    keyOf: unitKey,
    findExisting,
    insert,
  };
}

const batches = {
  lock: vi.fn(),
  isImported: vi.fn(),
  create: vi.fn(),
};
const transaction = vi.fn();
const runner = () => new ImportRunner(batches as never, transaction as never, readDb);

const ctx = (locale: "en" | "ar" = "en"): RequestContext => ({ locale, ip: "1.2.3.4", requestId: "req-1" });
const actor = { id: "user-1", role: "EMPLOYEE" as const };
const file = async (...rows: unknown[][]) => ({
  name: "units.xlsx",
  bytes: await workbookOf([["name", "kind", "area"], ...(rows as never[][])]),
});
const run = async (
  input: Awaited<ReturnType<typeof file>>,
  options: { dryRun?: boolean; locale?: "en" | "ar" } = {},
) =>
  runner().run(definition(), {
    file: input,
    dryRun: options.dryRun ?? false,
    actor,
    ctx: ctx(options.locale),
  });

beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  inserted.length = 0;
  calls.length = 0;
  loadLookups.mockImplementation(async (db: Db) => {
    calls.push(db === tx ? "lookups:tx" : "lookups:read");
    return { areas: buildReferenceIndex(AREAS) };
  });
  findExisting.mockImplementation(
    async (rows: Unit[]) => new Set(rows.map(unitKey).filter((k) => stored.has(k))),
  );
  insert.mockImplementation(async (rows: Unit[]) => {
    calls.push("insert");
    inserted.push(rows);
    return rows.map((_, i) => `new-${i + 1}`);
  });
  batches.lock.mockImplementation(async () => void calls.push("lock"));
  batches.isImported.mockImplementation(async () => {
    calls.push("isImported");
    return false;
  });
  batches.create.mockImplementation(async () => {
    calls.push("batch");
    return { id: "batch-1" };
  });
  record.mockImplementation(async () => void calls.push("audit"));
  transaction.mockImplementation((work: (db: Db) => Promise<unknown>) => work(tx));
});

describe("ImportRunner.run: saving", () => {
  it("does the steps in order inside one transaction: lock, already-imported check, lookups, save, batch, audit", async () => {
    const input = await file(["Unit A", "small", "new cairo"], ["Unit B", "LARGE", null]);

    const outcome = await run(input);

    expect(outcome).toEqual({
      status: 201,
      report: { ok: true, total: 2, imported: 2, skipped: 0, errors: [], truncated: false },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["lock", "isImported", "lookups:tx", "insert", "batch", "audit"]);
    expect(batches.lock).toHaveBeenCalledWith("Unit", tx);
    expect(inserted).toEqual([
      [
        { name: "Unit A", kind: "SMALL", areaId: "a-1" },
        { name: "Unit B", kind: "LARGE", areaId: undefined },
      ],
    ]);
  });

  it("records the file and writes one audit entry for it, in the same transaction", async () => {
    const input = await file(["Unit A", "small", null]);

    await run(input);

    expect(batches.create).toHaveBeenCalledWith(
      {
        entity: "Unit",
        fileHash: createHash("sha256").update(input.bytes).digest("hex"),
        userId: "user-1",
        rows: 1,
      },
      tx,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(tx, {
      actorId: "user-1",
      action: "unit.import",
      entity: "Unit",
      after: {
        batchId: "batch-1",
        rows: 1,
        fileHash: createHash("sha256").update(input.bytes).digest("hex"),
        createdIds: ["new-1"],
      },
      ip: "1.2.3.4",
      userAgent: undefined,
      requestId: "req-1",
    });
  });

  it("saves nothing and writes nothing when any row has a problem", async () => {
    const outcome = await run(await file(["Unit A", "small", null], ["", "huge", null]));

    expect(outcome.status).toBe(422);
    expect(outcome.report).toMatchObject({ ok: false, total: 2, imported: 0 });
    expect(insert).not.toHaveBeenCalled();
    expect(batches.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("lets the error out of the transaction when a step fails after the rows were saved", async () => {
    batches.create.mockRejectedValue(new Error("boom"));
    transaction.mockImplementation(async (work: (db: Db) => Promise<unknown>) => work(tx));

    await expect(run(await file(["Unit A", "small", null]))).rejects.toThrow("boom");

    expect(record).not.toHaveBeenCalled();
  });

  it("answers 409 FILE_ALREADY_IMPORTED, before it reads anything else, when the file was imported", async () => {
    batches.isImported.mockImplementation(async () => {
      calls.push("isImported");
      return true;
    });

    const failure = await run(await file(["Unit A", "small", null])).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
    expect(calls).toEqual(["lock", "isImported"]);
  });

  it("answers 409 when the unique index on the file is what stops it", async () => {
    batches.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));

    const failure = await run(await file(["Unit A", "small", null])).catch((err: unknown) => err);

    expect(failure).toMatchObject({ statusCode: 409, code: "FILE_ALREADY_IMPORTED" });
  });

  it("does not hide other database errors as a conflict", async () => {
    insert.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "P1001" }));

    await expect(run(await file(["Unit A", "small", null]))).rejects.toThrow("connection lost");
  });
});

describe("ImportRunner.run: the dry run", () => {
  it("runs the same checks against the read client, without a transaction, a lock, a batch or an audit entry", async () => {
    const outcome = await run(await file(["Unit A", "small", null]), { dryRun: true });

    expect(outcome).toEqual({
      status: 200,
      report: { ok: true, total: 1, imported: 0, skipped: 0, errors: [], truncated: false },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookups:read"]);
    expect(findExisting).toHaveBeenCalledWith(expect.any(Array), readDb);
    expect(insert).not.toHaveBeenCalled();
    expect(batches.lock).not.toHaveBeenCalled();
    expect(batches.isImported).not.toHaveBeenCalled();
    expect(batches.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("reports problems with 200", async () => {
    const outcome = await run(await file(["", "small", null]), { dryRun: true });

    expect(outcome.status).toBe(200);
    expect(outcome.report.ok).toBe(false);
  });
});

describe("ImportRunner.run: references", () => {
  it("finds a record by name, ignoring case and spaces", async () => {
    await run(await file(["Unit A", "small", "  ZAYED "]));

    expect(inserted[0]?.[0]?.areaId).toBe("a-2");
  });

  it("reports a name nothing has as REFERENCE_NOT_FOUND on that cell", async () => {
    const outcome = await run(await file(["Unit A", "small", "Giza"]));

    expect(outcome.report.errors).toEqual([
      {
        row: 2,
        column: "area",
        code: "REFERENCE_NOT_FOUND",
        message: "No record with this name exists",
        value: "Giza",
      },
    ]);
  });

  it("reports a name two records share as AMBIGUOUS_REFERENCE, and does not pick one", async () => {
    const outcome = await run(await file(["Unit A", "small", "Maadi"]));

    expect(outcome.status).toBe(422);
    expect(outcome.report.errors).toEqual([
      {
        row: 2,
        column: "area",
        code: "AMBIGUOUS_REFERENCE",
        message: "More than one record has this name",
        value: "Maadi",
      },
    ]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("says so in Arabic", async () => {
    const outcome = await run(await file(["Unit A", "small", "Maadi"]), { locale: "ar" });

    expect(outcome.report.errors[0]?.message).toBe("يوجد أكثر من سجل بهذا الاسم");
  });

  it("loads the lookups once for the whole file", async () => {
    await run(await file(["A", "small", "Zayed"], ["B", "large", "Zayed"], ["C", "large", "New Cairo"]));

    expect(loadLookups).toHaveBeenCalledTimes(1);
  });
});

describe("ImportRunner.run: duplicates", () => {
  it("reports the later of two rows with the same key, on the key column, and keeps the first", async () => {
    const outcome = await run(
      await file(["Unit A", "small", null], ["unit  a", "large", null], ["Unit B", "small", null]),
    );

    expect(outcome.report.errors).toEqual([
      {
        row: 3,
        column: "name",
        code: "DUPLICATE_IN_FILE",
        message: "This name and phone appear more than once in the file",
        value: "unit  a",
      },
    ]);
  });

  it("reports a row whose key is already stored", async () => {
    stored.add(unitKey({ name: "Unit A", kind: "SMALL", areaId: undefined }));

    const outcome = await run(await file(["UNIT A", "small", null], ["Unit B", "small", null]));

    expect(outcome.report.errors).toMatchObject([{ row: 2, column: "name", code: "DUPLICATE_EXISTING" }]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not look for stored duplicates among rows that failed to parse", async () => {
    await run(await file(["Unit A", "small", null], ["Bad", "huge", null]));

    expect(findExisting).toHaveBeenCalledWith([{ name: "Unit A", kind: "SMALL", areaId: undefined }], tx);
  });
});

describe("ImportRunner.run: files that cannot be imported", () => {
  it("answers with the file's problem, in the request language, before anything touches the database", async () => {
    const failure = await runner()
      .run(definition(), {
        file: { name: "units.csv", bytes: Buffer.from("a,b") },
        dryRun: false,
        actor,
        ctx: ctx("ar"),
      })
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({
      statusCode: 415,
      code: "UNSUPPORTED_FILE_TYPE",
      message: "تُقبل جداول .xlsx فقط",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(loadLookups).not.toHaveBeenCalled();
  });

  it("answers 400 with the columns at fault when the header is wrong", async () => {
    const bytes = await workbookOf([
      ["name", "colour"],
      ["Unit A", "red"],
    ]);

    const failure = await runner()
      .run(definition(), { file: { name: "units.xlsx", bytes }, dryRun: true, actor, ctx: ctx() })
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({ statusCode: 400, code: "IMPORT_HEADER_MISMATCH" });
    expect((failure as AppError).details).toEqual([
      { path: "kind", message: "This column is missing from the header row" },
      { path: "area", message: "This column is missing from the header row" },
      { path: "colour", message: "This column is not part of the template" },
    ]);
  });

  it("answers 422 when there are no data rows", async () => {
    const bytes = await workbookOf([["name", "kind", "area"]]);

    const failure = await runner()
      .run(definition(), { file: { name: "units.xlsx", bytes }, dryRun: false, actor, ctx: ctx() })
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({ statusCode: 422, code: "IMPORT_NO_ROWS" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("ImportRunner.template", () => {
  it("builds the template from the definition's columns", async () => {
    const { fileName, bytes } = await runner().template(definition());

    expect(fileName).toBe("units.xlsx");
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("gives a dropdown to a column it is given a list for, and keeps the ones the columns have", async () => {
    const { bytes } = await runner().template(definition(), { area: ["Maadi", "New Cairo"] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Units")!;

    expect(sheet.getCell(2, 3).dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$C$1:$C$2"] });
    expect(workbook.getWorksheet("Lists")!.getColumn(3).values).toEqual([undefined, "Maadi", "New Cairo"]);
    expect(sheet.getCell(2, 2).dataValidation).toMatchObject({ formulae: ["Lists!$B$1:$B$2"] });
    expect(sheet.getCell(2, 1).dataValidation).toBeFalsy();
  });
});
