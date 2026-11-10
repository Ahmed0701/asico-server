import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildVillaIndex,
  findVilla,
  matchHeader,
  readXlsx,
  resolveVilla,
  type IgnoredColumn,
  type ImportColumn,
} from "../../../src/shared/import/index.js";
import { ImportFileError } from "../../../src/shared/import/errors.js";
import { protectFormula, unprotectFormula } from "../../../src/shared/export/format.js";

// What lets a file that was exported be imported: the header check that knows the columns an export adds and the one
// that may be left out, the villa lookup that is exact first and loose second, and the reading of a guarded text.

const column = (header: string, optionalHeader = false): ImportColumn => ({
  header,
  kind: "text",
  required: false,
  description: "",
  example: "",
  ...(optionalHeader && { optionalHeader: true as const }),
});
const ignored: IgnoredColumn[] = [
  { header: "Location", kind: "text" },
  { header: "Created (UTC)", kind: "datetime" },
];
const columns = [column("Name"), column("Phone"), column("Currency", true)];

const problemOf = (headers: (string | null)[]): ImportFileError => {
  try {
    matchHeader(headers, columns, ignored);
  } catch (err) {
    return err as ImportFileError;
  }
  throw new Error("expected a header problem");
};

describe("matchHeader with an optional column and ignored columns", () => {
  it("returns -1 for an optional column that is not in the file", () => {
    expect(matchHeader(["Name", "Phone"], columns, ignored)).toEqual([0, 1, -1]);
  });

  it("returns where an optional column is when the file has it, whatever the order", () => {
    expect(matchHeader(["Currency", "Phone", "Name"], columns, ignored)).toEqual([2, 1, 0]);
  });

  it("lets the file carry the ignored columns, in any place, and does not map them", () => {
    expect(matchHeader(["Created (UTC)", "Name", "Phone", "Currency", "Location"], columns, ignored)).toEqual(
      [1, 2, 3],
    );
    expect(matchHeader(["Name", "Phone", "Location"], columns, ignored)).toEqual([0, 1, -1]);
  });

  it("still lists a required column that is missing", () => {
    expect(problemOf(["Name", "Location"]).details).toEqual([{ path: "Phone", key: "import.columnMissing" }]);
  });

  it("refuses a column that is in neither list, with the others around it accepted", () => {
    expect(problemOf(["Name", "Phone", "Location", "Region"]).details).toEqual([
      { path: "Region", key: "import.columnUnknown" },
    ]);
  });

  it("refuses an ignored column that appears twice, and an optional one that appears twice", () => {
    expect(problemOf(["Name", "Phone", "Location", "Location"]).details).toEqual([
      { path: "Location", key: "import.columnDuplicate" },
    ]);
    expect(problemOf(["Name", "Phone", "Currency", "Currency"]).details).toEqual([
      { path: "Currency", key: "import.columnDuplicate" },
    ]);
  });

  it("matches the names exactly: an ignored column in another case is unknown", () => {
    expect(problemOf(["Name", "Phone", "location"]).details).toEqual([
      { path: "location", key: "import.columnUnknown" },
    ]);
  });

  it("without a list of ignored columns, behaves as it did: an export's extra column is unknown", () => {
    expect(() => matchHeader(["Name", "Phone", "Location"], columns)).toThrow(ImportFileError);
  });
});

describe("findVilla: exactly as stored first, then ignoring case and spaces", () => {
  const villas = [
    { id: "a", villaNumber: "V-1" },
    { id: "b", villaNumber: "v-1" },
    { id: "c", villaNumber: "P 7" },
    { id: "d", villaNumber: "p-8" },
  ];
  const index = buildVillaIndex(villas);

  it("finds the villa written exactly, even when another differs only by case", () => {
    expect(findVilla(index, "V-1")).toMatchObject({ id: "a" });
    expect(findVilla(index, "v-1")).toMatchObject({ id: "b" });
  });

  it("is ambiguous when two villas fit loosely and none is written exactly", () => {
    expect(findVilla(index, "V-1 ")).toBe("ambiguous");
    expect(findVilla(index, " v-1")).toBe("ambiguous");
  });

  it("finds a villa by its number ignoring case and extra spaces when only one fits", () => {
    expect(findVilla(index, "p  7")).toMatchObject({ id: "c" });
    expect(findVilla(index, "P-8")).toMatchObject({ id: "d" });
  });

  it("finds nothing for a number that no villa has", () => {
    expect(findVilla(index, "Z-9")).toBeUndefined();
    expect(findVilla(buildVillaIndex([]), "V-1")).toBeUndefined();
  });

  it("resolveVilla adds the issue of a number that is not found, or ambiguous, and none for a villa", () => {
    const issues: Parameters<typeof resolveVilla>[0] = [];

    expect(resolveVilla(issues, index, "Villa Number", "V-1", "V-1")).toMatchObject({ id: "a" });
    expect(resolveVilla(issues, index, "Villa Number", undefined, null)).toBeUndefined();
    expect(issues).toEqual([]);

    expect(resolveVilla(issues, index, "Villa Number", "Z-9", "Z-9")).toBeUndefined();
    expect(resolveVilla(issues, index, "Villa Number", "V-1 ", "V-1 ")).toBeUndefined();
    expect(issues).toEqual([
      { column: "Villa Number", code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound", value: "Z-9" },
      { column: "Villa Number", code: "AMBIGUOUS_REFERENCE", key: "import.villaAmbiguous", value: "V-1 " },
    ]);
  });
});

describe("a text the export guarded against a formula is read back as it was", () => {
  it.each([
    "+20 100 123 4567",
    "=SUM(A1)",
    "-dash",
    "@mention",
    "'=quoted",
    "'+20",
    "plain",
    "P-001",
    "'plain apostrophe",
    "",
    "''=two",
    "'''+three",
    "'' two",
  ])("gives %j back after the guard and the unguard", (text) => {
    expect(unprotectFormula(protectFormula(text))).toBe(text);
  });

  it("takes the first apostrophe off a guarded text only", () => {
    expect(unprotectFormula("'+20 100")).toBe("+20 100");
    expect(unprotectFormula("''=1")).toBe("'=1");
    expect(unprotectFormula("'''=1")).toBe("''=1");
    expect(unprotectFormula("'abc")).toBe("'abc");
    expect(unprotectFormula("abc")).toBe("abc");
  });

  it("takes an apostrophe off only at the start of the text, never one further in", () => {
    expect(unprotectFormula("a'=b")).toBe("a'=b");
    expect(unprotectFormula("it's '+1")).toBe("it's '+1");
    expect(unprotectFormula(" '=1")).toBe(" '=1");
  });

  it("is done by the reader on a text cell and on a rich text cell, not on a number or a date", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.getCell("A1").value = "Phone";
    sheet.getCell("A2").value = "'+20 100 123 4567";
    sheet.getCell("A3").value = { richText: [{ text: "'=SUM" }, { text: "(A1)" }] };
    sheet.getCell("A4").value = "'plain";
    sheet.getCell("A5").value = 42;
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const read = await readXlsx(bytes, "a.xlsx");

    expect(read.rows.map((row) => row.cells[0])).toEqual(["+20 100 123 4567", "=SUM(A1)", "'plain", 42]);
  });
});
