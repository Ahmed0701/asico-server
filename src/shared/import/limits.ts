// What an import file may hold. The limits are fixed (not settings): the messages that name them, and the template's
// instructions, say the same numbers.
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_COLUMNS = 30;
export const IMPORT_MAX_CELL_CHARS = 2000;
// A template's dropdown lists at most this many choices. A column with more lists the first ones and only warns about another
// value (it can be typed), because a list that left a valid value out would refuse it.
export const IMPORT_MAX_LIST_VALUES = 20_000;
// What a column that declares itself long text (`maxChars` on its ImportColumn) may hold: the length of the API's own
// text fields, so a record that was exported can be imported again.
export const IMPORT_LONG_TEXT_CELL_CHARS = 5000;
// A report lists at most this many errors, and says when it has left some out.
export const IMPORT_MAX_ERRORS = 200;
// Blank rows between the records are allowed, but nothing is read below this row.
export const IMPORT_MAX_ROW_NUMBER = 10_000;

// An .xlsx is a ZIP. These bound what it may unpack to, whatever its compressed size, so a ZIP bomb is refused
// before any part of it is parsed.
export const ZIP_MAX_ENTRIES = 200;
export const ZIP_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export const XLSX_EXTENSION = ".xlsx";
