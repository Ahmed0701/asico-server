import { IMPORT_MAX_ERRORS } from "./limits.js";
import { isUnreadable, type CellIssue, type ImportReport, type RawCell } from "./types.js";

const MAX_VALUE_CHARS = 200;

// The cell as the report shows it: what was typed, shortened if it is long. Empty and unreadable cells have no value.
export function describeCell(cell: RawCell): string | null {
  if (cell === null || isUnreadable(cell)) {
    return null;
  }
  const text = cell instanceof Date ? cell.toISOString() : String(cell);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

type LocatedIssue = CellIssue & { row: number };

// Gathers the problems found in a file. The report lists them by row, then by the column's place in the template,
// at most IMPORT_MAX_ERRORS of them.
export class IssueCollector {
  private readonly issues: LocatedIssue[] = [];
  private readonly order: ReadonlyMap<string, number>;

  constructor(columnOrder: readonly string[]) {
    this.order = new Map(columnOrder.map((column, index) => [column, index]));
  }

  add(row: number, issue: CellIssue): void {
    this.issues.push({ ...issue, row });
  }

  get count(): number {
    return this.issues.length;
  }

  toReport(
    counts: { total: number; imported: number; skipped: number },
    translate: (key: string) => string,
  ): ImportReport {
    const sorted = [...this.issues].sort(
      (a, b) => a.row - b.row || (this.order.get(a.column) ?? 0) - (this.order.get(b.column) ?? 0),
    );
    return {
      ok: sorted.length === 0,
      total: counts.total,
      imported: counts.imported,
      skipped: counts.skipped,
      errors: sorted.slice(0, IMPORT_MAX_ERRORS).map((issue) => ({
        row: issue.row,
        column: issue.column,
        code: issue.code,
        message: translate(issue.key),
        value: describeCell(issue.value),
      })),
      truncated: sorted.length > IMPORT_MAX_ERRORS,
    };
  }
}
