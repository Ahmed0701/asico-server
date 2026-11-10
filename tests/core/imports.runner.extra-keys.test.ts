import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/core/imports/repository.js";
import { ImportRunner, type ImportDefinition } from "../../src/core/imports/runner.js";
import type { RequestContext } from "../../src/core/middleware/requestContext.js";
import type { CellIssue, RawCell } from "../../src/shared/import/index.js";
import { workbookOf } from "../shared/import/xlsx-fixtures.js";

// A table can have a second rule that makes two rows one record (a villa has its number and its place). Each rule is
// checked on its own and reported on its own column, and a definition with none runs as it always did (the keyed and
// unkeyed definitions of the other importers are pinned in imports.runner.keyed.test.ts).
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

type Row = { number: string; place: string };

const storedNumbers = vi.fn();
const storedPlaces = vi.fn();
const insert = vi.fn();

const text = (cells: Readonly<Record<string, RawCell>>, column: string): string | undefined => {
  const cell = cells[column];
  return typeof cell === "string" && cell.trim() !== "" ? cell.trim() : undefined;
};

function definition(withExtra: boolean): ImportDefinition<Row, undefined> {
  return {
    entity: "Thing",
    action: "thing.import",
    sheetName: "Things",
    plural: "things",
    fileName: "things.xlsx",
    columns: [
      { header: "number", kind: "text", required: true, description: "", example: "" },
      { header: "place", kind: "text", required: true, description: "", example: "" },
    ],
    keyColumn: "number",
    duplicateInFileKey: "import.villaDuplicateInFile",
    duplicateExistingKey: "import.villaDuplicateExisting",
    loadLookups: async () => undefined,
    parseRow: (cells) => {
      const number = text(cells, "number");
      const place = text(cells, "place");
      if (number !== undefined && place !== undefined) {
        return { value: { number, place }, issues: [] };
      }
      const issues: CellIssue[] = [];
      for (const [column, value] of [
        ["number", number],
        ["place", place],
      ] as const) {
        if (value === undefined) {
          issues.push({
            column,
            code: "REQUIRED",
            key: "validation.required",
            value: cells[column] ?? null,
          });
        }
      }
      return { value: undefined, issues };
    },
    keyOf: (row) => row.number.toLowerCase(),
    findExisting: async (rows, db) => storedNumbers(rows, db),
    insert: async (rows, db) => insert(rows, db),
    ...(withExtra && {
      extraKeys: [
        {
          keyColumn: "place",
          duplicateInFileKey: "import.plotDuplicateInFile",
          duplicateExistingKey: "import.plotDuplicateExisting",
          keyOf: (row: Row) => row.place.toLowerCase(),
          findExisting: async (rows: readonly Row[], db: Db) => storedPlaces(rows, db),
        },
      ],
    }),
  };
}

const run = async (withExtra: boolean, rows: unknown[][], dryRun = false) =>
  runner().run(definition(withExtra), {
    file: { name: "f.xlsx", bytes: await workbookOf([["number", "place"], ...(rows as never[][])]) },
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
  storedNumbers.mockResolvedValue(new Set());
  storedPlaces.mockResolvedValue(new Set());
  insert.mockImplementation(async (rows: Row[]) => rows.map((_, n) => `t-${n}`));
});

describe("a definition with a second key", () => {
  it("reports the later row of a repeated place on the place column, with the place's own message and value", async () => {
    const outcome = await run(true, [
      ["N1", "A-1"],
      ["N2", "B-2"],
      ["N3", " a-1 "],
    ]);

    expect(outcome.status).toBe(422);
    expect(outcome.report.errors).toEqual([
      {
        row: 4,
        column: "place",
        code: "DUPLICATE_IN_FILE",
        message: "This area, block and plot appear more than once in the file",
        value: " a-1 ",
      },
    ]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports a stored place on the place column and asks for the stored places once, with the rows that parsed", async () => {
    storedPlaces.mockResolvedValue(new Set(["b-2"]));

    const outcome = await run(true, [
      ["N1", "A-1"],
      ["N2", "B-2"],
      [null, "C-3"],
    ]);

    expect(storedPlaces).toHaveBeenCalledTimes(1);
    expect(storedPlaces).toHaveBeenCalledWith(
      [
        { number: "N1", place: "A-1" },
        { number: "N2", place: "B-2" },
      ],
      tx,
    );
    expect(outcome.report.errors).toEqual([
      {
        row: 3,
        column: "place",
        code: "DUPLICATE_EXISTING",
        message: "A villa already stands on this area, block and plot",
        value: "B-2",
      },
      { row: 4, column: "number", code: "REQUIRED", message: "This field is required", value: null },
    ]);
  });

  it("still checks the first key as before: a repeated or stored number is reported on the number column", async () => {
    storedNumbers.mockResolvedValue(new Set(["n9"]));

    const outcome = await run(true, [
      ["N1", "A-1"],
      ["n1", "B-2"],
      ["N9", "C-3"],
    ]);

    expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
      [3, "number", "DUPLICATE_IN_FILE"],
      [4, "number", "DUPLICATE_EXISTING"],
    ]);
    expect(storedNumbers).toHaveBeenCalledTimes(1);
  });

  it("reports a row that repeats both keys once for each, the number first (the columns' order)", async () => {
    const outcome = await run(true, [
      ["N1", "A-1"],
      ["N1", "A-1"],
    ]);

    expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
      [3, "number", "DUPLICATE_IN_FILE"],
      [3, "place", "DUPLICATE_IN_FILE"],
    ]);
  });

  it("reports both a stored number and a stored place of one row", async () => {
    storedNumbers.mockResolvedValue(new Set(["n1"]));
    storedPlaces.mockResolvedValue(new Set(["a-1"]));

    const outcome = await run(true, [["N1", "A-1"]]);

    expect(outcome.report.errors.map((error) => [error.column, error.code])).toEqual([
      ["number", "DUPLICATE_EXISTING"],
      ["place", "DUPLICATE_EXISTING"],
    ]);
  });

  it("is checked in a dry run as well: 200 with the errors, and nothing saved", async () => {
    const outcome = await run(
      true,
      [
        ["N1", "A-1"],
        ["N2", "A-1"],
      ],
      true,
    );

    expect(outcome.status).toBe(200);
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.errors).toHaveLength(1);
    expect(insert).not.toHaveBeenCalled();
    expect(batches.create).not.toHaveBeenCalled();
  });

  it("saves a good file once, in file order", async () => {
    const outcome = await run(true, [
      ["N1", "A-1"],
      ["N2", "B-2"],
    ]);

    expect(outcome).toMatchObject({ status: 201, report: { ok: true, imported: 2 } });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![0]).toEqual([
      { number: "N1", place: "A-1" },
      { number: "N2", place: "B-2" },
    ]);
  });
});

describe("a definition with several extra keys", () => {
  it("checks every one of them, each on its own: the second extra key reports and asks for the stored ones too", async () => {
    const storedByLetter = vi.fn().mockResolvedValue(new Set(["z"]));
    const several = {
      ...definition(true),
      extraKeys: [
        ...(definition(true).extraKeys ?? []),
        {
          keyColumn: "place",
          duplicateInFileKey: "import.villaDuplicateInFile",
          duplicateExistingKey: "import.villaDuplicateExisting",
          keyOf: (row: Row) => row.place.slice(0, 1).toLowerCase(),
          findExisting: async (rows: readonly Row[], db: Db) => storedByLetter(rows, db),
        },
      ],
    } as ImportDefinition<Row, undefined>;

    const outcome = await runner().run(several, {
      file: {
        name: "f.xlsx",
        bytes: await workbookOf([
          ["number", "place"],
          ["N1", "A-1"],
          ["N2", "A-2"],
          ["N3", "Z-1"],
        ]),
      },
      dryRun: false,
      actor,
      ctx,
    });

    expect(outcome.status).toBe(422);
    expect(outcome.report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
      [3, "place", "DUPLICATE_IN_FILE"],
      [4, "place", "DUPLICATE_EXISTING"],
    ]);
    expect(storedPlaces).toHaveBeenCalledTimes(1);
    expect(storedByLetter).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("a definition without a second key", () => {
  it("does not look at the place: a repeated place is no error, and no stored places are asked for", async () => {
    const outcome = await run(false, [
      ["N1", "A-1"],
      ["N2", "A-1"],
    ]);

    expect(outcome).toMatchObject({ status: 201, report: { imported: 2 } });
    expect(storedPlaces).not.toHaveBeenCalled();
  });

  it("an empty list of extra keys is the same as none", async () => {
    const withEmpty = { ...definition(false), extraKeys: [] } as ImportDefinition<Row, undefined>;
    const outcome = await runner().run(withEmpty, {
      file: {
        name: "f.xlsx",
        bytes: await workbookOf([
          ["number", "place"],
          ["N1", "A-1"],
          ["N2", "A-1"],
        ]),
      },
      dryRun: false,
      actor,
      ctx,
    });

    expect(outcome.status).toBe(201);
  });
});
