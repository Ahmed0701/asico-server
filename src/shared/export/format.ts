import { minorUnitsOf } from "../validation/decimal.js";
import { REPORT } from "./labels.js";
import type { CellValue, ColumnKind } from "./types.js";

const two = (value: number): string => String(value).padStart(2, "0");

// YYYY-MM-DD, in UTC.
export function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

// YYYY-MM-DD HH:mm UTC.
export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} ${REPORT.utc}`;
}

// How many decimals a currency has in its minor units (3 for KWD, 2 for EGP and USD, 0 for JPY).
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2
  );
}

// An amount in minor units as exact decimal text without its currency: 125050 becomes "1250.50". BigInt keeps it exact.
export function majorUnitsText(minor: number, digits: number): string {
  const factor = 10n ** BigInt(digits);
  const value = BigInt(minor);
  const fraction = digits === 0 ? "" : `.${String(value % factor).padStart(digits, "0")}`;
  return `${value / factor}${fraction}`;
}

// A budget in minor units as a decimal with its currency: 125050 EGP-piastres become "1250.50 EGP", 1250500 KWD-fils become
// "1250.500 KWD". The number of decimals is the currency's own. No budget is an empty cell.
export function formatMoney(minor: number | null, currency: string | null): string {
  if (minor === null || currency === null) {
    return "";
  }
  return `${majorUnitsText(minor, currencyDigits(currency))} ${currency}`;
}

// The budget as a spreadsheet cell: a real number in major units (dinars, pounds, dollars), so a file can be read back
// exactly. A number is used only when reading its text back gives the same minor units (a double holds 15 digits for sure);
// otherwise the exact text stands in for it, which the import reads the same. No budget is an empty cell.
export function moneyCell(minor: number | null, currency: string | null): number | string | null {
  if (minor === null || currency === null) {
    return null;
  }
  const digits = currencyDigits(currency);
  const text = majorUnitsText(minor, digits);
  const number = Number(text);
  return minorUnitsOf(String(number), digits) === minor ? number : text;
}

// An amount (money in major units) as text with `digits` decimals, the decimals of its currency: 2.5 becomes "2.500" for
// KWD and "2.50" for EGP. With no currency it has two decimals, and a third when there is one: 2.5 becomes "2.50".
export function formatAmount(value: number, digits?: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits ?? 2,
    maximumFractionDigits: digits ?? 3,
  });
}

// The spreadsheet number format of an amount with `digits` decimals: "#,##0.000" for 3, "#,##0" for 0.
export function amountNumberFormat(digits: number): string {
  return digits <= 0 ? "#,##0" : `#,##0.${"0".repeat(digits)}`;
}

// A progress figure (0 to 100, one decimal at most) as text with one decimal: 62.5 becomes "62.5%", 100 becomes "100.0%".
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

// A quantity (three decimals at most, kept as three) as text: 2.5 becomes "2.500", 1234567.891 becomes "1,234,567.891".
export function formatDecimal(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function formatBoolean(value: boolean): string {
  return value ? REPORT.yes : REPORT.no;
}

// A cell as text, for a PDF.
export function formatCell(value: CellValue, kind: ColumnKind): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return kind === "datetime" ? formatDateTime(value) : formatDate(value);
  }
  if (typeof value === "boolean") {
    return formatBoolean(value);
  }
  if (kind === "decimal" && typeof value === "number") {
    return formatDecimal(value);
  }
  return String(value);
}

// A spreadsheet runs text that starts with one of these as a formula. A leading apostrophe makes it plain text. (Text
// that already starts with apostrophes and then one of these gets another, so that unprotectFormula gives it back.)
const FORMULA_START = /^'*[=+\-@\t\r]/;
const PROTECTED = /^'('*[=+\-@\t\r])/;

export function protectFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

// The inverse of protectFormula, for the import: a file that was exported has the apostrophe in front of a text such as
// `+20 100 123 4567`, and the value is the text without it.
export function unprotectFormula(text: string): string {
  return text.replace(PROTECTED, "$1");
}
