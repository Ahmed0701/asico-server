import type { CellResult } from "./cells.js";
import type { CellIssue, RawCell } from "./types.js";

// Parses the cells of one row: each `take` unwraps a cell validator's answer, or records what is wrong with the
// cell, so a row reports every bad cell at once instead of stopping at the first.
export class RowParser {
  readonly issues: CellIssue[] = [];

  take<T>(column: string, cell: RawCell, result: CellResult<T>): T | undefined {
    if (result.ok) {
      return result.value;
    }
    this.issues.push({ column, code: result.error.code, key: result.error.key, value: cell });
    return undefined;
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}
