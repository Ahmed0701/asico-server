import type { ColumnKind } from "../export/types.js";

// The codes of a row error. A client branches on these; the message is for people.
export const IMPORT_ERROR_CODES = [
  "REQUIRED",
  "INVALID_VALUE",
  "NOT_TEXT",
  "INVALID_OPTION",
  "UNREADABLE_CELL",
  "REFERENCE_NOT_FOUND",
  "AMBIGUOUS_REFERENCE",
  "CONTRACTOR_NOT_ON_VILLA",
  "DUPLICATE_IN_FILE",
  "DUPLICATE_EXISTING",
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

// What a cell holds, as the file stores it. A formula cell is read as the value it last had (it is never
// calculated); one with no stored value, and an error value such as #DIV/0!, cannot be read.
export type UnreadableCell = { unreadable: "formula-without-value" | "error-value" };
export type RawCell = string | number | boolean | Date | null | UnreadableCell;

export function isUnreadable(cell: RawCell): cell is UnreadableCell {
  return typeof cell === "object" && cell !== null && !(cell instanceof Date);
}

// A problem with one cell, before it is given a row, a column and a language. `key` is a translation key.
export type CellIssue = { column: string; code: ImportErrorCode; key: string; value: RawCell };

// A problem with one cell, as the report lists it.
export type ImportRowError = {
  row: number;
  column: string;
  code: ImportErrorCode;
  message: string;
  value: string | null;
};

export type ImportReport = {
  ok: boolean;
  // The data rows in the file.
  total: number;
  // The records saved: always 0 for a dry run and for a file with errors.
  imported: number;
  // The rows left out on purpose, not saved and not errors (an exported open work that the system made itself).
  skipped: number;
  errors: ImportRowError[];
  truncated: boolean;
};

// One column of an import file. The template, the header check, the row parser and the export all read this list: the
// export writes these columns first, in this order, with the same headers. A column of an export that the import does not
// read is an IgnoredColumn (below).
export type ImportColumn = {
  // The header text, exactly as it must appear in the file.
  header: string;
  // How the export shows the column's values (a number is a number, a day is a date cell).
  kind: ColumnKind;
  required: boolean;
  // true: the column may be missing from the file altogether, which reads as if every cell of it were empty.
  optionalHeader?: true;
  // What goes in the column, for the template's instructions.
  description: string;
  example: string;
  // The allowed values, for a dropdown (an enum's labels, or the names of the records a reference points to).
  values?: readonly string[];
  // The most characters a cell of this column may hold. Left out: IMPORT_MAX_CELL_CHARS.
  maxChars?: number;
};

// A column of an export that the import does not read. A file may have it (an exported file is imported as it is) and
// its cells are never looked at, apart from the ones a definition's `skipRow` asks for; the template does not have it.
export type IgnoredColumn = { header: string; kind: ColumnKind };
