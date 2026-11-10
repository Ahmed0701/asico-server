import ExcelJS from "exceljs";
import { unprotectFormula } from "../export/format.js";
import { fileProblems } from "./errors.js";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  IMPORT_MAX_ROW_NUMBER,
  XLSX_EXTENSION,
} from "./limits.js";
import type { ImportColumn, RawCell } from "./types.js";
import { assertSafeZip, hasZipSignature } from "./zip.js";

export type SheetRow = {
  // The row's number in the sheet, as a person sees it (the header is row 1).
  row: number;
  // One cell per header column.
  cells: RawCell[];
};

export type ParsedSheet = {
  // The header row, one entry per column. An empty header over an empty column is null (ignored); an empty header
  // over a column that holds data is "".
  headers: (string | null)[];
  rows: SheetRow[];
};

// "A", "B", ... "AA": the letter a spreadsheet shows for a 1-based column number.
export function columnLetter(column: number): string {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

function unreadable(kind: "formula-without-value" | "error-value"): RawCell {
  return { unreadable: kind };
}

// A formula's result is the value it last had; the formula itself is never looked at or run. Text is kept as
// typed, apart from blank text, which is an empty cell.
function toRawCell(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() === "" ? null : unprotectFormula(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    return value;
  }
  if ("error" in value) {
    return unreadable("error-value");
  }
  if ("formula" in value || "sharedFormula" in value) {
    const result = (value as { result?: ExcelJS.CellFormulaValue["result"] }).result;
    return result === undefined || result === null ? unreadable("formula-without-value") : toRawCell(result);
  }
  if ("richText" in value) {
    const text = value.richText.map((part) => part.text).join("");
    return text.trim() === "" ? null : unprotectFormula(text);
  }
  if ("hyperlink" in value) {
    // The text shown, which a file may store as rich text although the library types it as a string.
    const shown: unknown = value.text;
    return toRawCell(isRichText(shown) ? shown : String(shown ?? ""));
  }
  return null;
}

function isRichText(value: unknown): value is ExcelJS.CellRichTextValue {
  return typeof value === "object" && value !== null && "richText" in value;
}

function cellLength(cell: RawCell): number {
  return typeof cell === "string" ? cell.length : 0;
}

// Reads the first sheet of an .xlsx file: the header row and the data rows under it. Cells are values only. The
// file is checked before any of it is parsed (name, size, ZIP structure and the size it unpacks to), and the
// sheet is checked against the row, column and cell limits. A cell may hold IMPORT_MAX_CELL_CHARS characters, unless the
// column it sits under (found by its header) says `maxChars` in `columns`.
export async function readXlsx(
  bytes: Buffer,
  originalName: string,
  columns: readonly ImportColumn[] = [],
): Promise<ParsedSheet> {
  const limits = new Map(columns.map((column) => [column.header, column.maxChars] as const));
  if (!originalName.toLowerCase().endsWith(XLSX_EXTENSION) || !hasZipSignature(bytes)) {
    throw fileProblems.unsupportedType();
  }
  if (bytes.length > IMPORT_MAX_BYTES) {
    throw fileProblems.tooLarge();
  }
  assertSafeZip(bytes);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch {
    throw fileProblems.unreadable();
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw fileProblems.unreadable();
  }
  if (sheet.rowCount > IMPORT_MAX_ROW_NUMBER) {
    throw fileProblems.tooManyRows();
  }

  // Row 1 is the header; the cells of every other row are collected by column, then laid out once the width is known.
  const header = new Map<number, string>();
  const data: { row: number; cells: Map<number, RawCell> }[] = [];
  let width = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = new Map<number, RawCell>();
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const raw = cell.type === ExcelJS.ValueType.Merge ? null : toRawCell(cell.value);
      if (raw === null) {
        return;
      }
      if (column > IMPORT_MAX_COLUMNS) {
        throw fileProblems.tooManyColumns();
      }
      // The header row is read first, so a data cell finds the limit of its column.
      const limit =
        (rowNumber > 1 ? limits.get(header.get(column) ?? "") : undefined) ?? IMPORT_MAX_CELL_CHARS;
      if (cellLength(raw) > limit) {
        throw fileProblems.cellTooLong(`${columnLetter(column)}${rowNumber}`, limit);
      }
      width = Math.max(width, column);
      if (rowNumber === 1) {
        header.set(column, typeof raw === "string" ? raw.trim() : headerText(raw));
      } else {
        cells.set(column, raw);
      }
    });
    if (rowNumber > 1 && cells.size > 0) {
      if (data.length >= IMPORT_MAX_ROWS) {
        throw fileProblems.tooManyRows();
      }
      data.push({ row: rowNumber, cells });
    }
  });

  const used = new Set<number>();
  for (const entry of data) {
    for (const column of entry.cells.keys()) {
      used.add(column);
    }
  }
  const headers: (string | null)[] = [];
  for (let column = 1; column <= width; column++) {
    headers.push(header.get(column) ?? (used.has(column) ? "" : null));
  }
  return {
    headers,
    rows: data.map(({ row, cells }) => ({
      row,
      cells: headers.map((_, index) => cells.get(index + 1) ?? null),
    })),
  };
}

function headerText(cell: RawCell): string {
  if (cell instanceof Date) {
    return cell.toISOString();
  }
  return typeof cell === "object" && cell !== null ? "" : String(cell);
}
