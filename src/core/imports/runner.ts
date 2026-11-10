import { audit, withMeta } from "../audit/audit.js";
import { prisma } from "../database/prisma.js";
import { AppError } from "../errors/AppError.js";
import { isMessageKey, t, type MessageKey } from "../i18n/index.js";
import type { Actor, RequestContext } from "../middleware/requestContext.js";
import { fileHashOf } from "../middleware/importUpload.js";
import { uniqueViolationConstraint } from "../../shared/utils/index.js";
import {
  buildTemplate,
  fileProblems,
  ImportFileError,
  IssueCollector,
  matchHeader,
  readXlsx,
  type CellIssue,
  type IgnoredColumn,
  type ImportColumn,
  type ImportReport,
  type ParsedSheet,
  type RawCell,
  type TemplateSpec,
} from "../../shared/import/index.js";
import { ImportBatchRepository, type Db } from "./repository.js";

// What one import into one table is made of. The framework reads the file, checks the header, finds duplicates,
// saves everything or nothing, and records the file; a definition says what a row means and how it is stored.
// `Keyed` is true (the usual case) for a table with a natural key and false for one without; the runner takes either.
export type ImportDefinition<Row, Lookups = undefined, Keyed extends boolean = true> = ImportBase<
  Row,
  Lookups
> &
  (Keyed extends true ? KeyedImport<Row> : UnkeyedImport);

type ImportBase<Row, Lookups> = {
  // The table name (also the audit entity and the ImportBatch entity), and the audit action.
  entity: string;
  action: string;
  // For the template: the sheet's name, what the records are called, and the file name.
  sheetName: string;
  plural: string;
  fileName: string;
  columns: readonly ImportColumn[];
  // The columns of the matching export that the import does not read: a file may carry them (an exported file is imported as
  // it is), their cells reach `parseRow` under their headers and nothing else looks at them. The template has none.
  ignoredColumns?: readonly IgnoredColumn[];
  // Anything a row needs from the database (the records a reference column points to), loaded once per import.
  loadLookups: (db: Db) => Promise<Lookups>;
  // `cells` is keyed by header. `value` is set only when the row has no issues. `skip` leaves the row out on purpose:
  // it is not checked further, not saved, not an error, and the report counts it.
  parseRow: (
    cells: Readonly<Record<string, RawCell>>,
    lookups: Lookups,
  ) => { value: Row | undefined; issues: CellIssue[]; skip?: true };
  // Saves the rows and returns the new ids.
  insert: (rows: readonly Row[], db: Db) => Promise<string[]>;
};

// One rule that makes two rows the same record: the same key, whether they are in the file twice or the table already has
// one. `keyColumn` is the header duplicates are reported on.
type RowKey<Row> = {
  keyColumn: string;
  duplicateInFileKey: string;
  duplicateExistingKey: string;
  keyOf: (row: Row) => string;
  // Which of these rows' keys are already stored.
  findExisting: (rows: readonly Row[], db: Db) => Promise<ReadonlySet<string>>;
};

// A table with a natural key. A table with a second rule (a villa has its number and its place) lists it in `extraKeys`;
// each key is checked on its own and reported on its own column.
type KeyedImport<Row> = RowKey<Row> & { extraKeys?: readonly RowKey<Row>[] };

// A table without one (the daily small works): the only guard against loading a file twice is the file hash.
type UnkeyedImport = {
  extraKeys?: undefined;
  keyColumn?: undefined;
  duplicateInFileKey?: undefined;
  duplicateExistingKey?: undefined;
  keyOf?: undefined;
  findExisting?: undefined;
};

export type ImportInput = {
  file: { name: string; bytes: Buffer };
  dryRun: boolean;
  actor: Actor;
  ctx: RequestContext;
};

// 200: a dry run (the report says whether the file is good). 201: saved. 422: not saved because of the report's errors.
export type ImportOutcome = { status: 200 | 201 | 422; report: ImportReport };

// An import is one transaction: it can hold many rows, so it gets more time than the default.
export const IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;

type Transaction = <T>(work: (tx: Db) => Promise<T>) => Promise<T>;

const messageOf = (key: string): MessageKey => (isMessageKey(key) ? key : "validation.invalid");

function fileError(err: ImportFileError, ctx: RequestContext): AppError {
  const details = err.details.map((detail) => ({
    path: detail.path,
    message: t(ctx.locale, messageOf(detail.key)),
  }));
  return new AppError(
    err.status,
    t(ctx.locale, messageOf(err.key)),
    err.code,
    details.length > 0 ? details : undefined,
  );
}

const alreadyImported = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.fileAlreadyImported"), "FILE_ALREADY_IMPORTED");

export class ImportRunner {
  constructor(
    private readonly batches = new ImportBatchRepository(),
    private readonly transaction: Transaction = (work) =>
      prisma.$transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    private readonly readDb: Db = prisma,
  ) {}

  template<Row, Lookups>(
    definition: ImportDefinition<Row, Lookups, boolean>,
    lists?: TemplateSpec["lists"],
  ): Promise<{ fileName: string; bytes: Buffer }> {
    return buildTemplate({
      sheetName: definition.sheetName,
      plural: definition.plural,
      columns: definition.columns,
      ...(lists === undefined ? {} : { lists }),
    }).then((bytes) => ({ fileName: definition.fileName, bytes }));
  }

  async run<Row, Lookups>(
    definition: ImportDefinition<Row, Lookups, boolean>,
    input: ImportInput,
  ): Promise<ImportOutcome> {
    const { file, dryRun, ctx } = input;
    const sheet = await this.read(file, definition.columns, ctx);
    const mapping = this.header(definition, sheet, ctx);

    if (dryRun) {
      return this.execute(definition, input, sheet, mapping, this.readDb, false);
    }
    try {
      return await this.transaction((tx) => this.execute(definition, input, sheet, mapping, tx, true));
    } catch (err) {
      // The same file saved by an import that finished first: the unique index on (entity, file hash) is the last word.
      if (uniqueViolationConstraint(err) !== undefined) {
        throw alreadyImported(ctx);
      }
      throw err;
    }
  }

  private async read(
    file: ImportInput["file"],
    columns: readonly ImportColumn[],
    ctx: RequestContext,
  ): Promise<ParsedSheet> {
    try {
      return await readXlsx(file.bytes, file.name, columns);
    } catch (err) {
      throw err instanceof ImportFileError ? fileError(err, ctx) : err;
    }
  }

  private header<Row, Lookups>(
    definition: ImportDefinition<Row, Lookups, boolean>,
    sheet: ParsedSheet,
    ctx: RequestContext,
  ): number[] {
    try {
      const mapping = matchHeader(sheet.headers, definition.columns, definition.ignoredColumns);
      if (sheet.rows.length === 0) {
        throw fileProblems.noRows();
      }
      return mapping;
    } catch (err) {
      throw err instanceof ImportFileError ? fileError(err, ctx) : err;
    }
  }

  // Everything from the first row to the last write. `write` is false for a dry run: the same checks run, against
  // the same data, and nothing is saved.
  private async execute<Row, Lookups>(
    definition: ImportDefinition<Row, Lookups, boolean>,
    input: ImportInput,
    sheet: ParsedSheet,
    mapping: readonly number[],
    db: Db,
    write: boolean,
  ): Promise<ImportOutcome> {
    const { actor, ctx, file } = input;
    const fileHash = fileHashOf(file.bytes);
    const translate = (key: string): string => t(ctx.locale, messageOf(key));
    const total = sheet.rows.length;

    if (write) {
      await this.batches.lock(definition.entity, db);
      if (await this.batches.isImported(definition.entity, fileHash, db)) {
        throw alreadyImported(ctx);
      }
    }

    const issues = new IssueCollector(definition.columns.map((column) => column.header));
    const lookups = await definition.loadLookups(db);
    const parsed: { row: number; value: Row; cells: Readonly<Record<string, RawCell>> }[] = [];
    const keyed = definition.keyColumn === undefined ? undefined : definition;
    const ignoredAt = (definition.ignoredColumns ?? []).map(
      (column) => [column.header, sheet.headers.indexOf(column.header)] as const,
    );
    let skipped = 0;
    for (const { row, cells } of sheet.rows) {
      const byHeader: Record<string, RawCell> = {};
      definition.columns.forEach((column, index) => {
        byHeader[column.header] = cells[mapping[index] ?? -1] ?? null;
      });
      for (const [header, at] of ignoredAt) {
        byHeader[header] = at < 0 ? null : (cells[at] ?? null);
      }
      const result = definition.parseRow(byHeader, lookups);
      if (result.skip === true) {
        skipped++;
        continue;
      }
      for (const issue of result.issues) {
        issues.add(row, issue);
      }
      if (result.value !== undefined) {
        parsed.push({ row, value: result.value, cells: byHeader });
      }
    }

    for (const rule of keyed ? [keyed, ...(keyed.extraKeys ?? [])] : []) {
      // The same record twice in the file: the first one stands, every later one is the error.
      const keys = parsed.map((entry) => rule.keyOf(entry.value));
      const seen = new Set<string>();
      parsed.forEach((entry, index) => {
        const key = keys[index] ?? "";
        if (seen.has(key)) {
          issues.add(entry.row, {
            column: rule.keyColumn,
            code: "DUPLICATE_IN_FILE",
            key: rule.duplicateInFileKey,
            value: entry.cells[rule.keyColumn] ?? null,
          });
        }
        seen.add(key);
      });
      const existing = await rule.findExisting(
        parsed.map((entry) => entry.value),
        db,
      );
      parsed.forEach((entry, index) => {
        if (existing.has(keys[index] ?? "")) {
          issues.add(entry.row, {
            column: rule.keyColumn,
            code: "DUPLICATE_EXISTING",
            key: rule.duplicateExistingKey,
            value: entry.cells[rule.keyColumn] ?? null,
          });
        }
      });
    }

    if (issues.count > 0 || !write) {
      return {
        status: write ? 422 : 200,
        report: issues.toReport({ total, imported: 0, skipped }, translate),
      };
    }

    // A file whose rows were all left out saves nothing, but is still recorded: the same file is not read twice.
    const createdIds =
      parsed.length === 0
        ? []
        : await definition.insert(
            parsed.map((entry) => entry.value),
            db,
          );
    const batch = await this.batches.create(
      { entity: definition.entity, fileHash, userId: actor.id, rows: createdIds.length },
      db,
    );
    await audit.record(
      db,
      withMeta(ctx, {
        actorId: actor.id,
        action: definition.action,
        entity: definition.entity,
        after: { batchId: batch.id, rows: createdIds.length, fileHash, createdIds },
      }),
    );
    return {
      status: 201,
      report: issues.toReport({ total, imported: createdIds.length, skipped }, translate),
    };
  }
}
