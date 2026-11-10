import type { Writable } from "node:stream";

// Nothing larger than this is generated: the request is refused (422) before any file is made.
export const EXPORT_MAX_ROWS = 10_000;

export type ExportFormat = "xlsx" | "pdf";

// How a column's values are shown. A text column stays text in a workbook, so a phone number or a villa
// number keeps its leading zeros and is never turned into a number or a date.
// "decimal" is a number shown with three decimals (a quantity); "integer" is a whole number; "amount" is money in major
// units (dinars, pounds, dollars). It is shown with the decimals of its currency (see `currencyKey`), and with two and
// up to a third when the row has no currency.
export type ColumnKind = "text" | "date" | "datetime" | "boolean" | "integer" | "decimal" | "amount";

// Numbers are aligned to the right and measured as they are, never wrapped.
export const isNumericKind = (kind: ColumnKind): boolean =>
  kind === "integer" || kind === "decimal" || kind === "amount";

// Column widths are not declared: both formats measure the content.
// `currencyKey` (an "amount" column only) is the key of the column of the same row that holds the currency code: a workbook
// shows the amount with that currency's own decimals (three for KWD, two for EGP, none for JPY).
export type ExportColumn = { key: string; title: string; kind: ColumnKind; currencyKey?: string };

export type CellValue = string | number | boolean | Date | null;
export type ExportRow = Record<string, CellValue>;

export type ExportDocument = {
  title: string;
  sheetName: string;
  generatedAt: Date;
  // The filters that were applied, one line each, for the top of a PDF.
  filters: string[];
  // Label and value pairs shown above the table (the contractor header and totals of a summary).
  summary?: [string, string][];
  columns: ExportColumn[];
  // The rows, in chunks, so a large export is never held in memory at once.
  rows: AsyncIterable<ExportRow[]>;
};

export type ExportWriter = (document: ExportDocument, out: Writable) => Promise<{ rows: number }>;

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};
