import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { formatCell, formatDecimal } from "../../../src/shared/export/format.js";
import { writePdf } from "../../../src/shared/export/pdf.js";
import { isNumericKind } from "../../../src/shared/export/types.js";
import { writeXlsx } from "../../../src/shared/export/xlsx.js";
import { col, document, readPdf, readPlacedText, render } from "./helpers.js";

describe("formatDecimal: always three decimals, with thousands separators", () => {
  it.each([
    [0, "0.000"],
    [0.001, "0.001"],
    [2.5, "2.500"],
    [10, "10.000"],
    [1.005, "1.005"],
    [1234567.891, "1,234,567.891"],
    [999_999_999.999, "999,999,999.999"],
  ])("writes %s as %s", (value, expected) => {
    expect(formatDecimal(value)).toBe(expected);
  });

  it("is what a decimal cell shows in a PDF, and leaves other kinds as they were", () => {
    expect(formatCell(2.5, "decimal")).toBe("2.500");
    expect(formatCell(2.5, "integer")).toBe("2.5");
    expect(formatCell(7, "integer")).toBe("7");
    expect(formatCell(null, "decimal")).toBe("");
    expect(formatCell("n/a", "decimal")).toBe("n/a");
  });
});

describe("isNumericKind", () => {
  it.each([
    ["integer", true],
    ["decimal", true],
    ["text", false],
    ["date", false],
    ["datetime", false],
    ["boolean", false],
  ] as const)("%s: %s", (kind, expected) => {
    expect(isNumericKind(kind)).toBe(expected);
  });
});

const columns = [col("name", "Name", "text"), col("qty", "Quantity", "decimal")];
const rows = [
  { name: "a", qty: 2.5 },
  { name: "b", qty: 0.001 },
  { name: "c", qty: 999_999_999.999 },
  { name: "d", qty: null },
  { name: "e", qty: "=1+1" },
];

describe("a decimal column in a spreadsheet", () => {
  async function sheetOf(): Promise<ExcelJS.Worksheet> {
    const { bytes } = await render(writeXlsx, document(columns, rows));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    return workbook.worksheets[0]!;
  }

  it("is a real number cell in the format with three decimals, holding the exact value", async () => {
    const sheet = await sheetOf();

    for (const [n, expected] of [
      [2, 2.5],
      [3, 0.001],
      [4, 999_999_999.999],
    ] as const) {
      const cell = sheet.getRow(n).getCell(2);
      expect(cell.value).toBe(expected);
      expect(cell.numFmt).toBe("#,##0.000");
    }
  });

  it("leaves an empty value empty, and a text that looks like a formula as protected text", async () => {
    const sheet = await sheetOf();

    expect(sheet.getRow(5).getCell(2).value).toBeNull();
    expect(sheet.getRow(6).getCell(2).value).toBe("'=1+1");
  });

  it("is wide enough for the number as it is shown, with its three decimals and separators", async () => {
    const sheet = await sheetOf();

    // The longest cell as it is shown, plus the padding of two characters: measured as plain text it would be 13 + 2.
    expect(sheet.getColumn(2).width).toBeGreaterThanOrEqual("999,999,999.999".length + 2);
  });
});

describe("a decimal column in a PDF", () => {
  it("is aligned to the right, in the header and in the cells, like any number", async () => {
    const { bytes } = await render(
      writePdf,
      document(
        [col("name", "Name", "text"), col("qty", "Q", "decimal")],
        [
          { name: "a", qty: 999_999_999.999 },
          { name: "b", qty: 2.5 },
        ],
      ),
    );

    const items = (await readPlacedText(bytes))[0] ?? [];
    const x = (text: string): number => items.find((item) => item.text === text)!.x;
    // Right-aligned: the shorter text starts further right, and the header sits at the right edge of the widest cell.
    expect(x("2.500")).toBeGreaterThan(x("999,999,999.999") + 20);
    expect(x("Q")).toBeGreaterThan(x("999,999,999.999") + 20);
  });

  it("shows the number with three decimals", async () => {
    const { bytes } = await render(writePdf, document(columns, rows.slice(0, 3)));

    const text = (await readPdf(bytes)).pages.flat().join(" ");
    expect(text).toContain("2.500");
    expect(text).toContain("0.001");
    expect(text).toContain("999,999,999.999");
  });
});
