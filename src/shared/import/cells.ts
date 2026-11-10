import type { ZodType } from "zod";
import { calendarDateField } from "../validation/dates.js";
import type { PartyStatusValue } from "../constants/enums.js";
import { decimalWithin, minorUnitsOf } from "../validation/decimal.js";
import { joinKey, normalizePhone, normalizeText } from "./keys.js";
import { isUnreadable, type ImportErrorCode, type RawCell } from "./types.js";

// What a cell validator answers: the value, or the reason the cell is not acceptable. `key` is a translation key;
// the report turns it into the request's language.
export type CellError = { code: ImportErrorCode; key: string };
export type CellResult<T> = { ok: true; value: T } | { ok: false; error: CellError };

const ok = <T>(value: T): CellResult<T> => ({ ok: true, value });
const fail = (code: ImportErrorCode, key: string): CellResult<never> => ({ ok: false, error: { code, key } });

const MESSAGE_KEY = /^[a-z]+\.[A-Za-z0-9]+$/;

// Blank cells are "no value"; every validator below starts here.
function blank(cell: RawCell, required: boolean): CellResult<undefined> | null {
  if (cell === null) {
    return required ? fail("REQUIRED", "validation.required") : ok(undefined);
  }
  return null;
}

// A text cell, checked by the same schema the API uses for the field, so a file and a request accept exactly the
// same values. The schema's messages are translation keys; anything else becomes the generic "invalid value".
// A number, a date or a boolean is refused rather than turned into text: a phone number typed into a General cell
// has already lost its leading zero by the time we see it.
export function textCell<T>(
  cell: RawCell,
  schema: ZodType<T>,
  options: { required: boolean },
): CellResult<T | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  if (typeof cell !== "string") {
    return fail("NOT_TEXT", "import.cellNotText");
  }
  const parsed = schema.safeParse(cell);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const message = parsed.error.issues[0]?.message ?? "";
  const key = MESSAGE_KEY.test(message) ? message : "validation.invalid";
  return fail(key === "validation.required" ? "REQUIRED" : "INVALID_VALUE", key);
}

// A whole number from `min` to `max`, typed as a number or as digits in a text cell. `key` is the message for a value
// that is not one.
export function integerCell(
  cell: RawCell,
  options: { required: boolean; min: number; max: number; key: string },
): CellResult<number | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  const value = typeof cell === "string" && /^\d+$/.test(cell.trim()) ? Number(cell.trim()) : cell;
  return typeof value === "number" && Number.isInteger(value) && value >= options.min && value <= options.max
    ? ok(value)
    : fail("INVALID_VALUE", options.key);
}

// A calendar day for a DATE column: the text YYYY-MM-DD, or a date cell (read as its UTC day). The result is that day at
// 00:00 UTC, which is what the API holds a day as.
export function dateCell(cell: RawCell, options: { required: boolean }): CellResult<Date | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime())
      ? fail("INVALID_VALUE", "validation.calendarDateInvalid")
      : ok(new Date(Date.UTC(cell.getUTCFullYear(), cell.getUTCMonth(), cell.getUTCDate())));
  }
  const parsed = typeof cell === "string" ? calendarDateField.safeParse(cell.trim()) : undefined;
  return parsed?.success ? ok(parsed.data) : fail("INVALID_VALUE", "validation.calendarDateInvalid");
}

// The values an enum column accepts: its codes and its labels, in any case.
export type EnumSpec<V extends string> = { lookup: ReadonlyMap<string, V> };

export function enumSpec<V extends string>(
  values: readonly V[],
  labels: Readonly<Record<V, string>>,
): EnumSpec<V> {
  const lookup = new Map<string, V>();
  for (const value of values) {
    lookup.set(normalizeText(value), value);
    lookup.set(normalizeText(labels[value]), value);
  }
  return { lookup };
}

export function enumCell<V extends string>(
  cell: RawCell,
  spec: EnumSpec<V>,
  options: { required: boolean },
): CellResult<V | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  const value = typeof cell === "string" ? spec.lookup.get(normalizeText(cell)) : undefined;
  return value === undefined ? fail("INVALID_OPTION", "import.optionInvalid") : ok(value);
}

// The records a reference column can point to, found by name (ignoring case and extra spaces). Two records with
// the same name are both kept, so the match can say it is ambiguous instead of picking one.
export type ReferenceIndex = ReadonlyMap<string, readonly string[]>;

export function buildReferenceIndex(records: readonly { id: string; name: string }[]): ReferenceIndex {
  const index = new Map<string, string[]>();
  for (const record of records) {
    const key = normalizeText(record.name);
    index.set(key, [...(index.get(key) ?? []), record.id]);
  }
  return index;
}

export function referenceCell(
  cell: RawCell,
  index: ReferenceIndex,
  options: { required: boolean },
): CellResult<string | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  const ids = typeof cell === "string" ? (index.get(normalizeText(cell)) ?? []) : [];
  if (ids.length === 0) {
    return fail("REFERENCE_NOT_FOUND", "import.referenceNotFound");
  }
  const [only] = ids;
  return ids.length === 1 && only !== undefined
    ? ok(only)
    : fail("AMBIGUOUS_REFERENCE", "import.referenceAmbiguous");
}

// A positive decimal for a DECIMAL column: a number cell, or the text of a number ("12.5"), with at most `scale` decimals
// and at most `max`. The value is never rounded: 0.0004 with three places is an error, not 0. `key` is the message for a
// value that is not acceptable.
export function decimalCell(
  cell: RawCell,
  options: { required: boolean; scale: number; max: number; key: string },
): CellResult<number | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  const value = decimalWithin(cell, options.scale);
  return value !== undefined && value > 0 && value <= options.max
    ? ok(value)
    : fail("INVALID_VALUE", options.key);
}

// Like textCell, for a column whose values are codes people type as numbers (a villa number 2235, a block 4, a plot 30), so a
// spreadsheet stores a number. A number cell is read as the digits it shows, when it is a whole number from 0 up to the largest
// safe integer: 2235 is "2235", never "2235.0" or "2.235e3", and the same text rules apply as to any text. A fraction, a
// negative number, NaN or one with more digits than a spreadsheet keeps exactly is an invalid value. (A leading zero a cell's
// number format only displays is not in the value: write such a code as text.)
export function textOrNumberCell<T>(
  cell: RawCell,
  schema: ZodType<T>,
  options: { required: boolean },
): CellResult<T | undefined> {
  if (typeof cell === "number") {
    return Number.isSafeInteger(cell) && cell >= 0
      ? textCell(String(cell), schema, options)
      : fail("INVALID_VALUE", "import.cellNumberInvalid");
  }
  return textCell(cell, schema, options);
}

// An amount of money written in major units (dinars, pounds), as a number or as the text of one, kept as minor units (fils, piastres): at
// most `scale` decimals, 0 or more, never rounded. `key` is the message for a value that is not one.
export function minorUnitsCell(
  cell: RawCell,
  options: { required: boolean; scale: number; key: string },
): CellResult<number | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  const minor = minorUnitsOf(cell, options.scale);
  return minor === undefined ? fail("INVALID_VALUE", options.key) : ok(minor);
}

// A party (an engineer, a contractor) as a cell refers to it: by name or by phone.
export type PartyRecord = { id: string; name: string; phone: string; status: PartyStatusValue };
export type PartyIndex = {
  byName: ReadonlyMap<string, readonly PartyRecord[]>;
  byPhone: ReadonlyMap<string, readonly PartyRecord[]>;
};

export function buildPartyIndex(records: readonly PartyRecord[]): PartyIndex {
  const byName = new Map<string, PartyRecord[]>();
  const byPhone = new Map<string, PartyRecord[]>();
  for (const record of records) {
    const name = normalizeText(record.name);
    const phone = normalizePhone(record.phone);
    byName.set(name, [...(byName.get(name) ?? []), record]);
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), record]);
  }
  return { byName, byPhone };
}

// The party a cell names, by its name (ignoring case and extra spaces) or its phone (ignoring spaces and dashes). Two
// parties that the text names (two of one name, or one's name and another's phone) are an ambiguous reference, never a
// guess; none is not found; one that is switched off is refused. A number cell is not text: a phone number typed into a
// General cell has already lost its leading zero. `keys` are the messages for each outcome.
export function partyCell(
  cell: RawCell,
  index: PartyIndex,
  options: { required: boolean; notFoundKey: string; inactiveKey: string },
): CellResult<string | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  if (typeof cell !== "string") {
    return fail("NOT_TEXT", "import.cellNotText");
  }
  const named = new Map<string, PartyRecord>();
  for (const record of [
    ...(index.byName.get(normalizeText(cell)) ?? []),
    ...(index.byPhone.get(normalizePhone(cell)) ?? []),
  ]) {
    named.set(record.id, record);
  }
  const [only, ...others] = [...named.values()];
  if (only === undefined) {
    return fail("REFERENCE_NOT_FOUND", options.notFoundKey);
  }
  if (others.length > 0) {
    return fail("AMBIGUOUS_REFERENCE", "import.partyAmbiguous");
  }
  return only.status === "INACTIVE" ? fail("INVALID_VALUE", options.inactiveKey) : ok(only.id);
}

// An area as a cell refers to it: by name, or by name and city when two areas share a name.
export type AreaRecord = { id: string; name: string; city: string };
export type AreaIndex = {
  byName: ReadonlyMap<string, readonly string[]>;
  byNameAndCity: ReadonlyMap<string, readonly string[]>;
};

export function buildAreaIndex(records: readonly AreaRecord[]): AreaIndex {
  const byName = new Map<string, string[]>();
  const byNameAndCity = new Map<string, string[]>();
  for (const record of records) {
    const name = normalizeText(record.name);
    const both = joinKey(name, normalizeText(record.city));
    byName.set(name, [...(byName.get(name) ?? []), record.id]);
    byNameAndCity.set(both, [...(byNameAndCity.get(both) ?? []), record.id]);
  }
  return { byName, byNameAndCity };
}

// The area a cell names: its name, ignoring case and extra spaces; or, when the name alone matches no area, "Name, City"
// (the text after the last comma is the city). A name that two areas share is ambiguous, and so is a name and city that
// two do. A number cell is not text.
export function areaCell(
  cell: RawCell,
  index: AreaIndex,
  options: { required: boolean },
): CellResult<string | undefined> {
  const empty = blank(cell, options.required);
  if (empty) {
    return empty;
  }
  if (isUnreadable(cell)) {
    return fail("UNREADABLE_CELL", "import.cellUnreadable");
  }
  if (typeof cell !== "string") {
    return fail("NOT_TEXT", "import.cellNotText");
  }
  let ids = index.byName.get(normalizeText(cell)) ?? [];
  if (ids.length === 0) {
    const comma = cell.lastIndexOf(",");
    if (comma > 0) {
      ids =
        index.byNameAndCity.get(
          joinKey(normalizeText(cell.slice(0, comma)), normalizeText(cell.slice(comma + 1))),
        ) ?? [];
    }
  }
  const [only] = ids;
  if (only === undefined) {
    return fail("REFERENCE_NOT_FOUND", "import.areaNotFound");
  }
  return ids.length === 1 ? ok(only) : fail("AMBIGUOUS_REFERENCE", "import.areaAmbiguous");
}
