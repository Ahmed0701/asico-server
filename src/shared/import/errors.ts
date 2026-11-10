import { IMPORT_LONG_TEXT_CELL_CHARS, IMPORT_MAX_CELL_CHARS } from "./limits.js";

// A file that cannot be imported at all, as opposed to a row that has a problem. `key` is a translation key;
// `details` names the columns or cells at fault.
export type FileProblemDetail = { path: string; key: string };

export class ImportFileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly key: string,
    readonly details: readonly FileProblemDetail[] = [],
  ) {
    super(code);
    this.name = "ImportFileError";
  }
}

export const fileProblems = {
  unsupportedType: () => new ImportFileError(415, "UNSUPPORTED_FILE_TYPE", "import.unsupportedType"),
  unreadable: () => new ImportFileError(400, "IMPORT_FILE_UNREADABLE", "import.unreadable"),
  tooLarge: () => new ImportFileError(413, "FILE_TOO_LARGE", "errors.fileTooLarge"),
  tooManyRows: () => new ImportFileError(422, "IMPORT_TOO_MANY_ROWS", "import.tooManyRows"),
  tooManyColumns: () => new ImportFileError(422, "IMPORT_TOO_MANY_COLUMNS", "import.tooManyColumns"),
  // The message names the limit of the column: the long-text one when that is what the column allows.
  cellTooLong: (cell: string, limit: number = IMPORT_MAX_CELL_CHARS) => {
    const key = limit === IMPORT_LONG_TEXT_CELL_CHARS ? "import.cellTooLongText" : "import.cellTooLong";
    return new ImportFileError(422, "IMPORT_CELL_TOO_LONG", key, [{ path: cell, key }]);
  },
  noRows: () => new ImportFileError(422, "IMPORT_NO_ROWS", "import.noRows"),
};
