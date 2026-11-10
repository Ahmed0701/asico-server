import ExcelJS from "exceljs";
import { expect } from "vitest";
import { IMPORT_MAX_ROWS } from "../../src/shared/import/index.js";

const LAST_ROW = IMPORT_MAX_ROWS + 1;

// The dropdowns of an import template: for each column of the data sheet that has one, the choices it offers, read from the
// hidden Lists sheet that its rule points at. A rule must name exactly the whole list of its own column, hold from row 2 to
// the last row the importer reads (and not beyond), stop a value that is not in the list, and carry a prompt.
export function dropdownsOf(workbook: ExcelJS.Workbook): Record<string, string[]> {
  const data = workbook.worksheets[0]!;
  const lists = workbook.getWorksheet("Lists")!;
  expect(lists.state).toBe("hidden");
  expect(workbook.worksheets.at(-1)).toBe(lists);
  const found: Record<string, string[]> = {};
  for (let column = 1; column <= data.columnCount; column++) {
    const header = data.getCell(1, column).text;
    const rule = data.getCell(2, column).dataValidation;
    expect(data.getCell(1, column).dataValidation, `${header}: no rule on the header`).toBeFalsy();
    expect(
      data.getCell(LAST_ROW + 1, column).dataValidation,
      `${header}: no rule below the last row`,
    ).toBeFalsy();
    if (!rule) {
      expect(
        lists.getColumn(column).values.filter((value) => value !== undefined),
        `${header}: no list`,
      ).toEqual([]);
      continue;
    }
    const choices = (lists.getColumn(column).values as (string | undefined)[]).filter(
      (value): value is string => value !== undefined,
    );
    const letter = data.getColumn(column).letter;
    expect(rule, header).toMatchObject({
      type: "list",
      formulae: [`Lists!$${letter}$1:$${letter}$${choices.length}`],
      showInputMessage: true,
      promptTitle: header,
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: header,
    });
    expect(data.getCell(LAST_ROW, column).dataValidation, `${header}: the last row`).toEqual(rule);
    found[header] = choices;
  }
  return found;
}

// The template with row 2 (the example) replaced by these cells, written out again as it is, Lists sheet and all.
export async function filledTemplate(
  workbook: ExcelJS.Workbook,
  cells: readonly (string | number)[],
): Promise<Buffer> {
  const data = workbook.worksheets[0]!;
  cells.forEach((value, at) => {
    data.getCell(2, at + 1).value = value === "" ? null : value;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
