import { describe, expect, it } from "vitest";
import {
  columnLetter,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CELL_CHARS,
  IMPORT_LONG_TEXT_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  ImportFileError,
  readXlsx,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  type ImportColumn,
} from "../../../src/shared/import/index.js";
import { fileProblems } from "../../../src/shared/import/errors.js";
import { workbookOf, zipOf } from "./xlsx-fixtures.js";

async function problemOf(work: Promise<unknown>): Promise<ImportFileError> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(ImportFileError);
    return err as ImportFileError;
  }
  throw new Error("expected the file to be refused");
}

const expectRefused = async (work: Promise<unknown>, status: number, code: string) => {
  const problem = await problemOf(work);
  expect({ status: problem.status, code: problem.code }).toEqual({ status, code });
};

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const zeros = (megabytes: number): Buffer => Buffer.alloc(megabytes * 1024 * 1024);

describe("columnLetter", () => {
  it.each([
    [1, "A"],
    [26, "Z"],
    [27, "AA"],
    [30, "AD"],
    [702, "ZZ"],
    [703, "AAA"],
  ])("names column %i %s", (column, letter) => {
    expect(columnLetter(column)).toBe(letter);
  });
});

describe("readXlsx: reading", () => {
  it("returns the header row and the data rows, with the row numbers a person sees", async () => {
    const file = await workbookOf([
      ["name", "phone"],
      ["Acme", "0100 123 4567"],
      ["Bolt", "0111 222 3333"],
    ]);

    expect(await readXlsx(file, "contractors.xlsx")).toEqual({
      headers: ["name", "phone"],
      rows: [
        { row: 2, cells: ["Acme", "0100 123 4567"] },
        { row: 3, cells: ["Bolt", "0111 222 3333"] },
      ],
    });
  });

  it("skips blank rows and treats blank text as an empty cell", async () => {
    const file = await workbookOf([
      ["name", "phone"],
      [],
      ["Acme", "   "],
      [null, null],
      ["Bolt", "0100 123 4567"],
    ]);

    const { rows } = await readXlsx(file, "a.xlsx");

    expect(rows).toEqual([
      { row: 3, cells: ["Acme", null] },
      { row: 5, cells: ["Bolt", "0100 123 4567"] },
    ]);
  });

  it("does not count a row whose only cells are blank text, or blank rich text, as data", async () => {
    const blank = { richText: [{ text: "  " }, { text: "" }] };
    const file = await workbookOf([
      ["name", "phone"],
      [" ", blank],
      ["Acme", blank],
    ]);

    const { rows } = await readXlsx(file, "a.xlsx");

    expect(rows).toEqual([{ row: 3, cells: ["Acme", null] }]);
  });

  it("reads only the first sheet", async () => {
    const file = await workbookOf([["name"], ["Acme"]], {
      sheetName: "First",
      otherSheets: { Second: [["name"], ["Hidden Co."], ["Other Co."]] },
    });

    expect((await readXlsx(file, "a.xlsx")).rows).toEqual([{ row: 2, cells: ["Acme"] }]);
  });

  it("accepts an upper-case extension", async () => {
    const file = await workbookOf([["name"], ["Acme"]]);

    expect((await readXlsx(file, "CONTRACTORS.XLSX")).rows).toHaveLength(1);
  });

  it("keeps numbers, booleans and dates as the types they are, and text exactly as typed", async () => {
    const day = new Date("2026-03-04T00:00:00.000Z");
    const file = await workbookOf([
      ["a", "b", "c", "d"],
      [7, true, day, " =SUM(A1) "],
    ]);

    const [row] = (await readXlsx(file, "a.xlsx")).rows;

    expect(row?.cells).toEqual([7, true, day, " =SUM(A1) "]);
  });

  it("joins rich text and reads a hyperlink's text", async () => {
    const file = await workbookOf([
      ["a", "b"],
      [
        { richText: [{ text: "Acme " }, { text: "Co.", font: { bold: true } }] },
        { text: "Bolt Co.", hyperlink: "https://example.test" },
      ],
    ]);

    expect((await readXlsx(file, "a.xlsx")).rows[0]?.cells).toEqual(["Acme Co.", "Bolt Co."]);
  });

  it("ignores a blank header over an empty column, and marks a blank header over data with an empty string", async () => {
    const file = await workbookOf([
      ["name", null, "phone", null],
      ["Acme", null, "0100 123 4567", "stray"],
    ]);

    const sheet = await readXlsx(file, "a.xlsx");

    expect(sheet.headers).toEqual(["name", null, "phone", ""]);
    expect(sheet.rows[0]?.cells).toEqual(["Acme", null, "0100 123 4567", "stray"]);
  });

  it("trims the spaces around a header", async () => {
    const file = await workbookOf([
      ["  name ", "phone	"],
      ["Acme", "0100 123 4567"],
    ]);

    expect((await readXlsx(file, "a.xlsx")).headers).toEqual(["name", "phone"]);
  });

  it("reads an empty sheet as no headers and no rows", async () => {
    expect(await readXlsx(await workbookOf([]), "a.xlsx")).toEqual({ headers: [], rows: [] });
  });
});

describe("readXlsx: formulas are never evaluated", () => {
  it("reads a formula cell as the value it last had, whatever the formula says", async () => {
    const file = await workbookOf([
      ["a", "b"],
      [
        { formula: "1+1", result: 99 },
        { formula: 'A1&"x"', result: "kept" },
      ],
    ]);

    expect((await readXlsx(file, "a.xlsx")).rows[0]?.cells).toEqual([99, "kept"]);
  });

  it("marks a formula with no stored value as unreadable", async () => {
    const file = await workbookOf([["a"], [{ formula: "1+1" } as never]]);

    expect((await readXlsx(file, "a.xlsx")).rows[0]?.cells).toEqual([
      { unreadable: "formula-without-value" },
    ]);
  });

  it("marks an error value as unreadable", async () => {
    const file = await workbookOf([["a"], [{ error: "#DIV/0!" } as never]]);

    expect((await readXlsx(file, "a.xlsx")).rows[0]?.cells).toEqual([{ unreadable: "error-value" }]);
  });

  it("keeps text that looks like a formula as plain text", async () => {
    const dangerous = "=cmd|' /C calc'!A0";
    const file = await workbookOf([["a"], [dangerous]]);

    expect((await readXlsx(file, "a.xlsx")).rows[0]?.cells).toEqual([dangerous]);
  });
});

describe("readXlsx: files that are not an import file", () => {
  it.each([
    ["an old .xls name", "contractors.xls"],
    ["a .csv name", "contractors.csv"],
    ["a .xlsm name", "contractors.xlsm"],
    ["a double extension", "contractors.xlsx.exe"],
    ["no extension", "contractors"],
    ["an extension that is only a prefix", "contractors.xlsxx"],
  ])("refuses %s with 415", async (_label, name) => {
    const file = await workbookOf([["name"], ["Acme"]]);

    await expectRefused(readXlsx(file, name), 415, "UNSUPPORTED_FILE_TYPE");
  });

  it.each([
    ["a text file", Buffer.from("name,phone\nAcme,0100 123 4567\n")],
    ["a PNG image", PNG],
    ["a PDF", Buffer.from("%PDF-1.7\n1 0 obj\n")],
    ["an empty file", Buffer.alloc(0)],
    ["three bytes", Buffer.from("PK\x03")],
    ["an old binary .xls", Buffer.from("d0cf11e0a1b11ae1", "hex")],
  ])("refuses %s named .xlsx with 415", async (_label, bytes) => {
    await expectRefused(readXlsx(bytes, "contractors.xlsx"), 415, "UNSUPPORTED_FILE_TYPE");
  });

  it("refuses a ZIP that is not a spreadsheet with 400", async () => {
    const zip = zipOf([{ name: "notes.txt", data: Buffer.from("hello") }]);

    await expectRefused(readXlsx(zip, "contractors.xlsx"), 400, "IMPORT_FILE_UNREADABLE");
  });

  it("refuses an archive that is sound but holds a workbook the library cannot read, with 400", async () => {
    const zip = zipOf([
      { name: "[Content_Types].xml", data: Buffer.from("<<<not xml") },
      { name: "xl/workbook.xml", data: Buffer.from("<<<not xml") },
    ]);

    await expectRefused(readXlsx(zip, "contractors.xlsx"), 400, "IMPORT_FILE_UNREADABLE");
  });

  it("refuses a spreadsheet cut short with 400", async () => {
    const file = await workbookOf([["name"], ["Acme"]]);

    await expectRefused(
      readXlsx(file.subarray(0, file.length >> 1), "contractors.xlsx"),
      400,
      "IMPORT_FILE_UNREADABLE",
    );
  });

  it("refuses a spreadsheet with damaged content with 400", async () => {
    const file = await workbookOf([["name"], ["Acme"]]);
    const damaged = Buffer.from(file);
    for (let at = 60; at < 200; at++) damaged[at] = damaged[at]! ^ 0xff;

    await expectRefused(readXlsx(damaged, "contractors.xlsx"), 400, "IMPORT_FILE_UNREADABLE");
  });
});

describe("readXlsx: size limits", () => {
  it("refuses a file over 5 MB with 413, before it is parsed", async () => {
    const big = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(IMPORT_MAX_BYTES)]);

    await expectRefused(readXlsx(big, "contractors.xlsx"), 413, "FILE_TOO_LARGE");
  });

  it("refuses more than 2,000 data rows with 422, and accepts exactly 2,000", async () => {
    const header = ["name"];
    const rows = (count: number) => Array.from({ length: count }, (_, i) => [`Contractor ${i}`]);

    const exact = await readXlsx(await workbookOf([header, ...rows(IMPORT_MAX_ROWS)]), "a.xlsx");
    expect(exact.rows).toHaveLength(IMPORT_MAX_ROWS);

    await expectRefused(
      readXlsx(await workbookOf([header, ...rows(IMPORT_MAX_ROWS + 1)]), "a.xlsx"),
      422,
      "IMPORT_TOO_MANY_ROWS",
    );
  });

  it("refuses a record far below the data, which would make the sheet enormous", async () => {
    // The file stays small, but the sheet is a million rows tall.
    const rows: (string | null)[][] = [["name"], ["Acme"]];
    rows[1_048_575] = ["far away"];
    await expectRefused(readXlsx(await workbookOf(rows), "a.xlsx"), 422, "IMPORT_TOO_MANY_ROWS");
  });

  it("refuses more than 30 columns with 422, and accepts exactly 30", async () => {
    const columns = (count: number) => Array.from({ length: count }, (_, i) => `c${i + 1}`);

    const exact = await readXlsx(
      await workbookOf([columns(IMPORT_MAX_COLUMNS), columns(IMPORT_MAX_COLUMNS)]),
      "a.xlsx",
    );
    expect(exact.headers).toHaveLength(IMPORT_MAX_COLUMNS);

    await expectRefused(
      readXlsx(
        await workbookOf([columns(IMPORT_MAX_COLUMNS + 1), columns(IMPORT_MAX_COLUMNS + 1)]),
        "a.xlsx",
      ),
      422,
      "IMPORT_TOO_MANY_COLUMNS",
    );
  });

  it("refuses a cell over 2,000 characters with 422 and says which cell", async () => {
    const ok = await readXlsx(await workbookOf([["name"], ["x".repeat(IMPORT_MAX_CELL_CHARS)]]), "a.xlsx");
    expect(ok.rows[0]?.cells[0]).toHaveLength(IMPORT_MAX_CELL_CHARS);

    const problem = await problemOf(
      readXlsx(await workbookOf([["name"], ["Acme"], ["x".repeat(IMPORT_MAX_CELL_CHARS + 1)]]), "a.xlsx"),
    );

    expect(problem).toMatchObject({ status: 422, code: "IMPORT_CELL_TOO_LONG" });
    expect(problem.details).toEqual([{ path: "A3", key: "import.cellTooLong" }]);
  });
});

describe("readXlsx: a column with its own cell limit", () => {
  const columns: ImportColumn[] = [
    { header: "title", kind: "text", required: true, description: "", example: "" },
    {
      header: "notes",
      kind: "text",
      required: false,
      description: "",
      example: "",
      maxChars: IMPORT_LONG_TEXT_CELL_CHARS,
    },
  ];
  const long = (length: number): string => "x".repeat(length);

  it("takes up to its own limit in that column and refuses one more, naming the cell and the limit", async () => {
    const ok = await readXlsx(
      await workbookOf([
        ["title", "notes"],
        ["Acme", long(IMPORT_LONG_TEXT_CELL_CHARS)],
      ]),
      "a.xlsx",
      columns,
    );
    expect(ok.rows[0]?.cells[1]).toHaveLength(IMPORT_LONG_TEXT_CELL_CHARS);

    const problem = await problemOf(
      readXlsx(
        await workbookOf([
          ["title", "notes"],
          ["Acme", "ok"],
          ["Bolt", long(IMPORT_LONG_TEXT_CELL_CHARS + 1)],
        ]),
        "a.xlsx",
        columns,
      ),
    );

    expect(problem).toMatchObject({ status: 422, code: "IMPORT_CELL_TOO_LONG" });
    expect(problem.details).toEqual([{ path: "B3", key: "import.cellTooLongText" }]);
  });

  it("names the default limit unless the long-text one is given", () => {
    expect(fileProblems.cellTooLong("C4").details).toEqual([{ path: "C4", key: "import.cellTooLong" }]);
    expect(fileProblems.cellTooLong("C4", IMPORT_MAX_CELL_CHARS).details).toEqual([
      { path: "C4", key: "import.cellTooLong" },
    ]);
    expect(fileProblems.cellTooLong("C4", IMPORT_LONG_TEXT_CELL_CHARS).details).toEqual([
      { path: "C4", key: "import.cellTooLongText" },
    ]);
  });

  it("keeps the default for the other columns, with the 2,000 message", async () => {
    const problem = await problemOf(
      readXlsx(
        await workbookOf([
          ["title", "notes"],
          [long(IMPORT_MAX_CELL_CHARS + 1), "x"],
        ]),
        "a.xlsx",
        columns,
      ),
    );

    expect(problem.details).toEqual([{ path: "A2", key: "import.cellTooLong" }]);
  });

  it("finds the column by its header, wherever it is", async () => {
    const swapped = await readXlsx(
      await workbookOf([
        ["notes", "title"],
        [long(3000), "Acme"],
      ]),
      "a.xlsx",
      columns,
    );
    expect(swapped.rows[0]?.cells[0]).toHaveLength(3000);

    // A header that differs in case is not the same column (the importer refuses the file anyway), so it keeps the default.
    await expectRefused(
      readXlsx(
        await workbookOf([
          ["Notes", "title"],
          ["x".repeat(3000), "Acme"],
        ]),
        "a.xlsx",
        columns,
      ),
      422,
      "IMPORT_CELL_TOO_LONG",
    );
  });

  it("never gives a header cell the long limit: the header row is held to the default", async () => {
    await expectRefused(
      readXlsx(
        await workbookOf([
          [long(IMPORT_MAX_CELL_CHARS + 1), "notes"],
          ["x", "y"],
        ]),
        "a.xlsx",
        columns,
      ),
      422,
      "IMPORT_CELL_TOO_LONG",
    );
  });

  it("holds a column the list does not name, or no list at all, to the default", async () => {
    const file = await workbookOf([
      ["title", "other"],
      ["Acme", long(IMPORT_MAX_CELL_CHARS + 1)],
    ]);

    await expectRefused(readXlsx(file, "a.xlsx", columns), 422, "IMPORT_CELL_TOO_LONG");
    await expectRefused(readXlsx(file, "a.xlsx"), 422, "IMPORT_CELL_TOO_LONG");
  });
});

describe("readXlsx: ZIP bombs", () => {
  const archive = (...entries: Parameters<typeof zipOf>[0]) => readXlsx(zipOf(entries), "bomb.xlsx");

  it("refuses an entry that declares more than it may unpack to, with 413", async () => {
    await expectRefused(
      archive({ name: "xl/big.xml", data: Buffer.from("x"), declaredSize: ZIP_MAX_ENTRY_BYTES + 1 }),
      413,
      "FILE_TOO_LARGE",
    );
  });

  it("refuses entries that add up to more than the total, with 413", async () => {
    const entry = (n: number) => ({ name: `xl/part${n}.xml`, data: zeros(12) });

    await expectRefused(archive(entry(1), entry(2), entry(3)), 413, "FILE_TOO_LARGE");
  });

  it("refuses an entry that unpacks to more than it declared, without unpacking it all", async () => {
    // 40 MB of zeros compresses to about 40 KB; the archive claims 10 bytes.
    const started = Date.now();

    await expectRefused(
      archive({ name: "xl/worksheets/sheet1.xml", data: zeros(40), declaredSize: 10 }),
      400,
      "IMPORT_FILE_UNREADABLE",
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses an entry that unpacks to less than it declared", async () => {
    await expectRefused(
      archive({ name: "xl/a.xml", data: Buffer.from("tiny"), declaredSize: 5000 }),
      400,
      "IMPORT_FILE_UNREADABLE",
    );
  });

  it("refuses an archive with too many entries, with 400", async () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, n) => ({
      name: `e${n}.xml`,
      data: Buffer.from("x"),
    }));

    await expectRefused(archive(...many), 400, "IMPORT_FILE_UNREADABLE");
  });

  it("refuses an encrypted entry", async () => {
    await expectRefused(
      archive({ name: "xl/a.xml", data: Buffer.from("x"), flags: 1 }),
      400,
      "IMPORT_FILE_UNREADABLE",
    );
  });

  it("refuses a ZIP64 archive", async () => {
    await expectRefused(
      readXlsx(zipOf([{ name: "a.xml", data: Buffer.from("x") }], { zip64: true }), "a.xlsx"),
      400,
      "IMPORT_FILE_UNREADABLE",
    );
  });

  it("refuses an archive with no entries", async () => {
    await expectRefused(readXlsx(zipOf([]), "a.xlsx"), 415, "UNSUPPORTED_FILE_TYPE");
  });

  it("refuses an entry stored with a method other than stored or deflate", async () => {
    const zip = zipOf([{ name: "a.xml", data: Buffer.from("x"), stored: true }]);
    // The method is at offset 10 of the central directory entry; 12 is bzip2.
    const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(12, at + 10);

    await expectRefused(readXlsx(zip, "a.xlsx"), 400, "IMPORT_FILE_UNREADABLE");
  });
});
