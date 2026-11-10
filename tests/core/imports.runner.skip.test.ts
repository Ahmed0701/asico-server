import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/core/imports/repository.js";
import { ImportRunner, type ImportDefinition } from "../../src/core/imports/runner.js";
import type { RequestContext } from "../../src/core/middleware/requestContext.js";
import type { RawCell } from "../../src/shared/import/index.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

// A file that was exported has columns the import only reads past (ignored columns), and may have rows the import
// leaves out on purpose (skipped rows): neither is an error, and the report says how many rows were left out.
const record = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/core/audit/audit.js")>()),
  audit: { record },
}));

const tx = { tx: true } as unknown as Db;
const ctx: RequestContext = { locale: "en", ip: "1.2.3.4", requestId: "req-1" };
const actor = { id: "user-1", role: "EMPLOYEE" as const };
const batches = { lock: vi.fn(), isImported: vi.fn(), create: vi.fn() };
const runner = () =>
  new ImportRunner(batches as never, (async (work: (db: Db) => unknown) => work(tx)) as never, tx);

type Row = { name: string };
const insert = vi.fn();
const seenCells = vi.fn();

const definition: ImportDefinition<Row, undefined, false> = {
  entity: "Thing",
  action: "thing.import",
  sheetName: "Things",
  plural: "things",
  fileName: "things.xlsx",
  columns: [
    { header: "Name", kind: "text", required: true, description: "", example: "" },
    { header: "Currency", kind: "text", required: false, optionalHeader: true, description: "", example: "" },
  ],
  ignoredColumns: [
    { header: "Source", kind: "text" },
    { header: "Created (UTC)", kind: "datetime" },
  ],
  loadLookups: async () => undefined,
  parseRow: (cells) => {
    seenCells(cells);
    if (cells["Source"] === "Auto") {
      return { value: undefined, issues: [], skip: true };
    }
    // A row that is skipped is not looked at any further, even if the parser had found problems or made a value.
    if (cells["Source"] === "Odd") {
      return {
        value: { name: "never saved" },
        issues: [{ column: "Name", code: "INVALID_VALUE", key: "validation.invalid", value: "?" }],
        skip: true,
      };
    }
    const name = cells["Name"];
    if (typeof name !== "string" || name.trim() === "") {
      return {
        value: undefined,
        issues: [{ column: "Name", code: "REQUIRED", key: "validation.required", value: name ?? null }],
      };
    }
    return { value: { name: name.trim() }, issues: [] };
  },
  insert: async (rows, db) => insert(rows, db),
};

const run = async (rows: RawCell[][], header: string[] = ["Name", "Source"], dryRun = false) =>
  runner().run(definition, {
    file: { name: "f.xlsx", bytes: await workbookOf([header, ...(rows as never[][])]) },
    dryRun,
    actor,
    ctx,
  });

beforeEach(() => {
  vi.clearAllMocks();
  batches.lock.mockResolvedValue(undefined);
  batches.isImported.mockResolvedValue(false);
  batches.create.mockResolvedValue({ id: "batch-1" });
  record.mockResolvedValue(undefined);
  insert.mockImplementation(async (rows: Row[]) => rows.map((_, n) => `t-${n}`));
});

describe("ignored columns", () => {
  it("lets a file have them, in any place, and gives parseRow their cells under their headers", async () => {
    const outcome = await run([["2026-03-04 05:06 UTC", "Manual", "A"]], ["Created (UTC)", "Source", "Name"]);

    expect(outcome.status).toBe(201);
    expect(seenCells).toHaveBeenCalledWith({
      Name: "A",
      Currency: null,
      Source: "Manual",
      "Created (UTC)": "2026-03-04 05:06 UTC",
    });
  });

  it("gives parseRow null for an ignored column the file does not have", async () => {
    await run([["A"]], ["Name"]);

    expect(seenCells).toHaveBeenCalledWith({
      Name: "A",
      Currency: null,
      Source: null,
      "Created (UTC)": null,
    });
  });

  it("gives parseRow the cells of an optional column that the file has, and null when it does not", async () => {
    await run([["A", "USD"]], ["Name", "Currency"]);
    await run([["B"]], ["Name"]);

    expect(seenCells).toHaveBeenNthCalledWith(1, {
      Name: "A",
      Currency: "USD",
      Source: null,
      "Created (UTC)": null,
    });
    expect(seenCells).toHaveBeenNthCalledWith(2, {
      Name: "B",
      Currency: null,
      Source: null,
      "Created (UTC)": null,
    });
  });

  it("still refuses a column that is in neither list, and names it", async () => {
    await expect(run([["A", "x"]], ["Name", "Region"])).rejects.toMatchObject({
      code: "IMPORT_HEADER_MISMATCH",
      details: [{ path: "Region" }],
    });
    expect(insert).not.toHaveBeenCalled();
    expect(batches.create).not.toHaveBeenCalled();
  });

  it("refuses an ignored column that is there twice", async () => {
    await expect(run([["A", "x", "y"]], ["Name", "Source", "Source"])).rejects.toMatchObject({
      code: "IMPORT_HEADER_MISMATCH",
    });
  });
});

describe("skipped rows", () => {
  const rows: RawCell[][] = [
    ["A", "Manual"],
    ["Auto row", "Auto"],
    ["B", "Manual"],
    ["", "Auto"],
  ];

  it("leaves them out, counts them, and imports the others", async () => {
    const outcome = await run(rows);

    expect(outcome.status).toBe(201);
    expect(outcome.report).toMatchObject({ total: 4, imported: 2, skipped: 2, errors: [] });
    expect(insert).toHaveBeenCalledWith([{ name: "A" }, { name: "B" }], tx);
    expect(batches.create).toHaveBeenCalledWith(
      { entity: "Thing", fileHash: expect.any(String), userId: "user-1", rows: 2 },
      tx,
    );
  });

  it("counts them in a dry run, which saves nothing", async () => {
    const outcome = await run(rows, ["Name", "Source"], true);

    expect(outcome.status).toBe(200);
    expect(outcome.report).toMatchObject({ total: 4, imported: 0, skipped: 2, errors: [] });
    expect(insert).not.toHaveBeenCalled();
    expect(batches.create).not.toHaveBeenCalled();
  });

  it("does not make an error of a skipped row that would have had one, and reports the rows that do", async () => {
    const outcome = await run([
      ["", "Auto"],
      ["", "Manual"],
    ]);

    expect(outcome.status).toBe(422);
    expect(outcome.report).toMatchObject({ total: 2, imported: 0, skipped: 1 });
    expect(outcome.report.errors.map((e) => [e.row, e.column, e.code])).toEqual([[3, "Name", "REQUIRED"]]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 201 with nothing imported when every row is skipped, saves nothing, and still records the file", async () => {
    const outcome = await run([
      ["x", "Auto"],
      ["y", "Auto"],
    ]);

    expect(outcome.status).toBe(201);
    expect(outcome.report).toMatchObject({ total: 2, imported: 0, skipped: 2, errors: [] });
    expect(insert).not.toHaveBeenCalled();
    expect(batches.create).toHaveBeenCalledWith(
      { entity: "Thing", fileHash: expect.any(String), userId: "user-1", rows: 0 },
      tx,
    );
    expect(record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "thing.import",
        after: expect.objectContaining({ rows: 0, createdIds: [] }),
      }),
    );
  });

  it("leaves a skipped row out whatever its parse holds: no error from its issues, nothing saved from its value", async () => {
    const outcome = await run([
      ["A", "Manual"],
      ["odd", "Odd"],
    ]);

    expect(outcome.status).toBe(201);
    expect(outcome.report).toMatchObject({ total: 2, imported: 1, skipped: 1, errors: [] });
    expect(insert).toHaveBeenCalledWith([{ name: "A" }], tx);
  });

  it("reports skipped 0 when no row is skipped", async () => {
    const outcome = await run([["A", "Manual"]]);

    expect(outcome.report.skipped).toBe(0);
  });

  it("does not read the same all-skipped file twice", async () => {
    batches.isImported.mockResolvedValue(true);

    await expect(run([["x", "Auto"]])).rejects.toMatchObject({ code: "FILE_ALREADY_IMPORTED" });
    expect(batches.create).not.toHaveBeenCalled();
  });
});
