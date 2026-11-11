import type { Writable } from "node:stream";
import ExcelJS from "exceljs";
import {
  amountNumberFormat,
  currencyDigits,
  formatAmount,
  formatBoolean,
  formatCell,
  formatDecimal,
  protectFormula,
} from "./format.js";
import { columnWidth, displayWidth, MAX_COLUMN_CHARACTERS, widestLine } from "./layout.js";
import type {
  CellValue,
  ColumnKind,
  ExportColumn,
  ExportDocument,
  ExportRow,
  ExportWriter,
} from "./types.js";

const HEADER_FILL = "FF1F3A5F";
const HEADER_FONT = "FFFFFFFF";

// ExcelJS takes a width of exactly 9 for "no width given" and writes none, so a column that fits at 9 would open at Excel's own
// default (8.43), a little narrower than its longest cell. A hair more is written as it is.
const EXCELJS_DEFAULT_WIDTH = 9;

// Dates are real date cells, shown as the date or the timestamp in UTC. Text is forced to the text format,
// so a value such as 007 or 0100 123 4567 stays exactly as it is.
const NUMBER_FORMAT: Record<ColumnKind, string> = {
  text: "@",
  date: "yyyy-mm-dd",
  datetime: 'yyyy-mm-dd hh:mm "UTC"',
  boolean: "@",
  integer: "0",
  // Always three decimals, with thousands separators: "0.###" would show a whole number with a dangling point.
  decimal: "#,##0.000",
  // Money: two decimals, and a third when there is one. A row with a currency has the decimals of that currency instead (see
  // amountFormat).
  amount: "#,##0.00#",
};

function toCell(value: CellValue | undefined, kind: ColumnKind): ExcelJS.CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (kind === "date" || kind === "datetime") {
    return value instanceof Date ? value : protectFormula(String(value));
  }
  if (kind === "boolean") {
    return typeof value === "boolean" ? formatBoolean(value) : protectFormula(String(value));
  }
  if (kind === "integer" || kind === "decimal" || kind === "amount") {
    return typeof value === "number" ? value : protectFormula(String(value));
  }
  return protectFormula(String(value));
}

function styleHeader(row: ExcelJS.Row): void {
  row.height = 20;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF9AA5B1" } } };
  });
}

// The decimals an amount cell is shown with: those of the currency in the same row (three for KWD, two for EGP, none for
// JPY). A cell without a currency keeps the format of its column.
function amountDigits(column: ExportColumn, row: ExportRow): number | undefined {
  const currency = column.currencyKey === undefined ? undefined : row[column.currencyKey];
  return column.kind === "amount" && typeof currency === "string" && currency !== ""
    ? currencyDigits(currency)
    : undefined;
}

// What a cell shows, as text, to measure it: a date as its format shows it, the value of a text cell with the
// apostrophe that protects it.
function shown(value: CellValue | undefined, kind: ColumnKind, digits?: number): string {
  const cell = toCell(value, kind);
  if (cell === null) {
    return "";
  }
  if (cell instanceof Date) {
    return formatCell(cell, kind);
  }
  if (kind === "decimal" && typeof cell === "number") {
    return formatDecimal(cell);
  }
  if (kind === "amount" && typeof cell === "number") {
    return formatAmount(cell, digits);
  }
  return String(cell);
}

// Fits the columns of a sheet that is already filled in (the files that are not streamed, such as the import
// templates) by the same rule as an export: as wide as the longest cell, row 1 as the header, within the limits
// of columnWidth. A cell wider than the widest a column goes wraps within it. `extra` is text a column may be
// given later, such as the choices of a dropdown, counted by its 0-based column index.
export function fitSheetColumns(
  sheet: ExcelJS.Worksheet,
  extra: ReadonlyMap<number, readonly string[]> = new Map(),
): void {
  for (let number = 1; number <= sheet.columnCount; number++) {
    const column = sheet.getColumn(number);
    let headerWidth = 0;
    let longest = Math.max(0, ...(extra.get(number - 1) ?? []).map(widestLine));
    column.eachCell({ includeEmpty: false }, (cell, row) => {
      const width = widestLine(cell.text);
      if (row === 1) {
        headerWidth = displayWidth(cell.text);
      } else {
        longest = Math.max(longest, width);
      }
    });
    const size = columnWidth(headerWidth, longest);
    column.width = size.width === EXCELJS_DEFAULT_WIDTH ? size.width + 0.01 : size.width;
    if (size.wraps) {
      column.eachCell({ includeEmpty: false }, (cell) => {
        if (widestLine(cell.text) > MAX_COLUMN_CHARACTERS) {
          cell.alignment = { ...cell.alignment, wrapText: true, vertical: "top" };
        }
      });
    }
  }
}

// One sheet: the optional summary block, then the header row (frozen, with a filter) and the data. A column is
// as wide as its longest value, so the rows are read before the first one is written (the widths are written
// ahead of the rows); an export is capped at EXPORT_MAX_ROWS, which keeps this to a few megabytes. The file
// itself is still written to `out` as it is made.
export const writeXlsx: ExportWriter = async (document: ExportDocument, out: Writable) => {
  const data: { cells: ExcelJS.CellValue[]; digits: (number | undefined)[] }[] = [];
  const longest = document.columns.map(() => 0);
  for await (const chunk of document.rows) {
    for (const source of chunk) {
      const digits = document.columns.map((column) => amountDigits(column, source));
      data.push({
        digits,
        cells: document.columns.map((column, index) => {
          longest[index] = Math.max(
            longest[index] ?? 0,
            widestLine(shown(source[column.key], column.kind, digits[index])),
          );
          return toCell(source[column.key], column.kind);
        }),
      });
    }
  }
  // The summary block sits in the first two columns, so its labels and values count towards their widths.
  const summary = document.summary ?? [];
  for (const pair of summary) {
    pair.forEach((text, index) => {
      if (index < longest.length) {
        longest[index] = Math.max(longest[index] ?? 0, widestLine(protectFormula(text)));
      }
    });
  }
  const sized = document.columns.map((column, index) => ({
    column,
    size: columnWidth(displayWidth(column.title), longest[index] ?? 0),
  }));

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "Elecico";
  workbook.created = document.generatedAt;

  // The summary, a blank row, then the header: the header row is the one that stays in view.
  const headerRowNumber = summary.length === 0 ? 1 : summary.length + 2;
  const sheet = workbook.addWorksheet(document.sheetName, {
    views: [{ state: "frozen", ySplit: headerRowNumber, xSplit: 0 }],
  });
  sheet.columns = sized.map(({ column, size }) => ({
    key: column.key,
    width: size.width,
    // A value wider than the widest a column goes wraps within it.
    style: {
      numFmt: NUMBER_FORMAT[column.kind],
      ...(size.wraps ? { alignment: { wrapText: true, vertical: "top" as const } } : {}),
    },
  }));

  for (const [label, value] of summary) {
    const row = sheet.addRow([protectFormula(label), protectFormula(value)]);
    row.getCell(1).font = { bold: true };
    row.commit();
  }
  if (summary.length > 0) {
    sheet.addRow([]).commit();
  }

  const header = sheet.addRow(document.columns.map((column) => column.title));
  styleHeader(header);
  header.commit();

  for (const { cells, digits } of data) {
    const row = sheet.addRow(cells);
    digits.forEach((count, index) => {
      if (count !== undefined) {
        row.getCell(index + 1).numFmt = amountNumberFormat(count);
      }
    });
    row.commit();
  }

  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + data.length, column: document.columns.length },
  };
  sheet.commit();
  await workbook.commit();
  return { rows: data.length };
};
