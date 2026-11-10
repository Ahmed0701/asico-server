import { ImportFileError, type FileProblemDetail } from "./errors.js";
import { columnLetter } from "./xlsx-reader.js";
import type { IgnoredColumn, ImportColumn } from "./types.js";

// Checks the file's header row against the template's columns: the same names, each once, nothing else. The order
// of the columns does not matter. A column marked `optionalHeader` may be missing (its position is -1). `ignored` are the
// columns of an export that the import does not read: they may be there, once each, and are not looked at. Returns, for
// each template column, its 0-based position in the file. A mismatch lists every missing, repeated and unknown column, so
// one upload shows everything to fix.
export function matchHeader(
  headers: readonly (string | null)[],
  columns: readonly ImportColumn[],
  ignored: readonly IgnoredColumn[] = [],
): number[] {
  const positions = new Map<string, number[]>();
  const unknown: FileProblemDetail[] = [];
  headers.forEach((header, index) => {
    if (header === null) {
      return;
    }
    positions.set(header, [...(positions.get(header) ?? []), index]);
  });

  const known = new Set([...columns, ...ignored].map((column) => column.header));
  headers.forEach((header, index) => {
    if (header !== null && !known.has(header)) {
      // A column nobody named is shown by its letter, as the spreadsheet does.
      unknown.push({ path: header === "" ? columnLetter(index + 1) : header, key: "import.columnUnknown" });
    }
  });

  const missing: FileProblemDetail[] = [];
  const repeated: FileProblemDetail[] = [];
  const mapping: number[] = [];
  for (const column of columns) {
    const found = positions.get(column.header) ?? [];
    if (found.length === 0 && column.optionalHeader !== true) {
      missing.push({ path: column.header, key: "import.columnMissing" });
    } else if (found.length > 1) {
      repeated.push({ path: column.header, key: "import.columnDuplicate" });
    }
    mapping.push(found[0] ?? -1);
  }
  for (const column of ignored) {
    if ((positions.get(column.header) ?? []).length > 1) {
      repeated.push({ path: column.header, key: "import.columnDuplicate" });
    }
  }

  const problems = [...missing, ...repeated, ...unknown];
  if (problems.length > 0) {
    throw new ImportFileError(400, "IMPORT_HEADER_MISMATCH", "import.headerMismatch", problems);
  }
  return mapping;
}
