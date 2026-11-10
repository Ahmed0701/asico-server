import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildTemplate,
  IMPORT_LONG_TEXT_CELL_CHARS,
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  matchHeader,
  readXlsx,
  type ImportColumn,
} from "../../../src/shared/import/index.js";

const columns: ImportColumn[] = [
  { header: "name", kind: "text", required: true, description: "The name.", example: "Example Co." },
  { header: "phone", kind: "text", required: true, description: "The phone.", example: "0100 123 4567" },
  {
    header: "status",
    kind: "text",
    required: false,
    description: "Leave empty for Active.",
    example: "Active",
    values: ["Active", "Inactive"],
  },
  {
    header: "area",
    kind: "text",
    required: true,
    description: "The area.",
    example: "New Cairo",
    values: ["New Cairo", "Sheikh Zayed", "October"],
  },
];
const spec = { sheetName: "Contractors", plural: "contractors", columns };

async function load(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildTemplate(spec)) as unknown as ExcelJS.Buffer);
  return workbook;
}

describe("buildTemplate: column widths", () => {
  const widths = (sheet: ExcelJS.Worksheet) => sheet.columns.map((column) => column.width);

  it("fits every column of every sheet to its longest cell, header included, within 8..60", async () => {
    const workbook = await load();

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
        expect(column.width).toBeGreaterThanOrEqual(Math.min(60, longest));
      }
    }
  });

  it("allows for the longest dropdown choice and the example, not just the header", async () => {
    const [name, phone, status, area] = widths((await load()).worksheets[0]!);

    expect(name).toBeGreaterThanOrEqual("Example Co.".length + 2);
    expect(phone).toBeGreaterThanOrEqual("0100 123 4567".length + 2);
    expect(status).toBeGreaterThanOrEqual("Inactive".length + 2);
    expect(area).toBeGreaterThanOrEqual("Sheikh Zayed".length + 2);
  });

  it("wraps only a cell wider than 60, and keeps the column at 60", async () => {
    const long = "word ".repeat(30).trim();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildTemplate({
        ...spec,
        columns: [{ header: "name", kind: "text", required: true, description: long, example: "Acme" }],
      })) as unknown as ExcelJS.Buffer,
    );
    const instructions = workbook.getWorksheet("Instructions")!;
    const description = instructions.getRow(instructions.rowCount).getCell(3);

    expect(instructions.getColumn(3).width).toBe(60);
    expect(description.alignment?.wrapText).toBe(true);
    expect(instructions.getRow(1).getCell(1).alignment?.wrapText).toBeFalsy();
  });

  it("keeps the design: frozen header row, bold white header on the fill, text format, dropdowns", async () => {
    const sheet = (await load()).worksheets[0]!;

    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getRow(1).getCell(1).font).toMatchObject({ bold: true });
    expect(sheet.getCell("A2").numFmt).toBe("@");
    expect(sheet.getCell("C2").dataValidation).toMatchObject({ type: "list" });
  });
});

describe("buildTemplate", () => {
  it("puts the data sheet first, then the instructions, then a hidden sheet for the dropdown lists", async () => {
    const workbook = await load();

    expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
      ["Contractors", "visible"],
      ["Instructions", "visible"],
      ["Lists", "hidden"],
    ]);
  });

  it("writes the English header row and one example row", async () => {
    const sheet = (await load()).getWorksheet("Contractors")!;

    expect(sheet.getRow(1).values).toEqual([undefined, "name", "phone", "status", "area"]);
    expect(sheet.getRow(2).values).toEqual([
      undefined,
      "Example Co.",
      "0100 123 4567",
      "Active",
      "New Cairo",
    ]);
    expect(sheet.actualRowCount).toBe(2);
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("formats every column as text, so a phone number keeps its leading zero", async () => {
    const sheet = (await load()).getWorksheet("Contractors")!;

    for (let column = 1; column <= columns.length; column++) {
      expect(sheet.getColumn(column).numFmt).toBe("@");
    }
  });

  it("adds a dropdown to each column that has values, for every row the importer reads, and to no other", async () => {
    const sheet = (await load()).getWorksheet("Contractors")!;

    for (const row of [2, 3, 500, IMPORT_MAX_ROWS + 1]) {
      expect(sheet.getCell(row, 3).dataValidation).toMatchObject({
        type: "list",
        allowBlank: true,
        formulae: ["Lists!$C$1:$C$2"],
        showErrorMessage: true,
        errorStyle: "stop",
      });
      // A required column does not allow blanks (the reader leaves the flag out when it is false).
      expect(sheet.getCell(row, 4).dataValidation).toMatchObject({ formulae: ["Lists!$D$1:$D$3"] });
      expect(sheet.getCell(row, 4).dataValidation.allowBlank).toBeFalsy();
    }
    expect(sheet.getCell(IMPORT_MAX_ROWS + 2, 3).dataValidation).toBeFalsy();
    expect(sheet.getCell(2, 1).dataValidation).toBeFalsy();
    expect(sheet.getCell(2, 2).dataValidation).toBeFalsy();
    expect(sheet.getCell(1, 3).dataValidation).toBeFalsy();
  });

  it("keeps the dropdown values on the hidden sheet", async () => {
    const lists = (await load()).getWorksheet("Lists")!;

    expect(lists.getColumn(3).values).toEqual([undefined, "Active", "Inactive"]);
    expect(lists.getColumn(4).values).toEqual([undefined, "New Cairo", "Sheikh Zayed", "October"]);
  });

  it("explains the limits and each column on the Instructions sheet", async () => {
    const sheet = (await load()).getWorksheet("Instructions")!;
    const text: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
    const all = text.join("\n");

    expect(all).toContain("Import contractors");
    expect(all).toContain(`${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows`);
    expect(all).toContain(`${IMPORT_MAX_COLUMNS} columns`);
    expect(all).toContain(`${IMPORT_MAX_CELL_CHARS.toLocaleString("en-US")} characters`);
    expect(all).toContain("5 MB");
    expect(all).toContain("Only the first sheet is read");
    expect(all).toContain("never calculated");
    expect(all).toContain("Row 2 holds an example");
    expect(all).toContain("Leave empty for Active. One of: Active, Inactive.");
    expect(all).toContain("The same file cannot be imported twice");
  });

  it("says that a long-text column takes more only when the spec has one", async () => {
    const instructions = async (extra: ImportColumn[]): Promise<string> => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        (await buildTemplate({ ...spec, columns: [...columns, ...extra] })) as unknown as ExcelJS.Buffer,
      );
      const text: string[] = [];
      workbook
        .getWorksheet("Instructions")!
        .eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
      return text.join(" | ");
    };
    const long: ImportColumn = {
      header: "notes",
      kind: "text",
      required: false,
      description: "Up to 5,000 characters.",
      example: "Text",
      maxChars: IMPORT_LONG_TEXT_CELL_CHARS,
    };

    expect(await instructions([])).not.toContain("a long-text column says how many more");
    expect(await instructions([long])).toContain(
      `A cell holds up to ${IMPORT_MAX_CELL_CHARS.toLocaleString("en-US")} characters (a long-text column says how many more)`,
    );
    expect(await instructions([{ ...long, maxChars: IMPORT_MAX_CELL_CHARS }])).not.toContain(
      "long-text column",
    );
  });

  it("makes a file the importer itself accepts: its header matches and its one row is the example", async () => {
    const sheet = await readXlsx(await buildTemplate(spec), "template.xlsx");

    expect(matchHeader(sheet.headers, columns)).toEqual([0, 1, 2, 3]);
    expect(sheet.rows).toEqual([{ row: 2, cells: ["Example Co.", "0100 123 4567", "Active", "New Cairo"] }]);
  });

  it("leaves out the dropdown for a column whose list is empty", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildTemplate({
        ...spec,
        columns: [{ header: "area", kind: "text", required: true, description: "", example: "", values: [] }],
      })) as unknown as ExcelJS.Buffer,
    );

    expect(workbook.getWorksheet("Contractors")!.getCell(2, 1).dataValidation).toBeFalsy();
  });
});
