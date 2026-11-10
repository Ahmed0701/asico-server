import { z } from "zod";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import {
  IMPORT_TRANSACTION_TIMEOUT_MS,
  ImportBatchRepository,
  ImportRunner,
  type ImportDefinition,
  type ImportOutcome,
} from "../../../core/imports/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { COLUMN_TITLES } from "../../../shared/export/labels.js";
import {
  buildTemplate,
  partyChoices,
  villaNumberChoices,
  buildVillaLookups,
  checkVillaContractor,
  dateCell,
  integerCell,
  joinKey,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type RawCell,
  type TemplateSpec,
  type VillaLookups,
} from "../../../shared/import/index.js";
import { isTooFarAhead, toDay } from "../../../shared/utils/day.js";
import { uniqueViolationConstraint } from "../../../shared/utils/index.js";
import { MAX_LABOUR_COUNT } from "../dto/daily-labour.dto.js";
import { DailyLabourRepository, type NewDailyLabour } from "../repository/daily-labour.repository.js";
import { notes } from "../validators/daily-labour.validators.js";

const villaNumber = z.string().trim().min(1, { error: "validation.required" });
const contractorText = z.string().trim().min(1, { error: "validation.required" });

// The columns of the file, in the order of the template. The notes take as many characters as the API does, so a row that
// was exported can be imported again.
export const DAILY_LABOUR_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.villaNumber,
    kind: "text",
    required: true,
    description: "The villa number, exactly as it is in the system.",
    example: "EX-000",
  },
  {
    header: COLUMN_TITLES.labourDate,
    kind: "date",
    required: true,
    description:
      "The day, written YYYY-MM-DD, or a date cell. A villa has one row per contractor per day. Tomorrow is the latest day allowed.",
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.labourCount,
    kind: "integer",
    required: true,
    description: "How many workers the contractor had on site: a whole number from 0 to 100,000.",
    example: "25",
  },
  {
    header: COLUMN_TITLES.contractor,
    kind: "text",
    required: true,
    description: "The villa's own contractor, by name or by phone. Another contractor is refused.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.notes,
    kind: "text",
    required: false,
    description: "A note on the day, up to 500 characters. Leave it empty if there is none.",
    example: "Half the team worked on the roof",
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries it is imported as it is: it is not read.
export const DAILY_LABOUR_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.location, kind: "text" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Daily labour",
  plural: "daily labour rows",
  fileName: "daily-labour-import-template.xlsx",
  columns: DAILY_LABOUR_IMPORT_COLUMNS,
};

// A row that passed every check. Its `contractorId` is the villa's contractor as the row was checked, which the insert
// makes sure it still is.
export type DailyLabourRowInput = Omit<NewDailyLabour, "createdById">;

// What a row is checked against besides the villas and the contractors: the instant "tomorrow" is counted from.
export type DailyLabourLookups = VillaLookups & { now: Date };

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

export function parseDailyLabourRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: DailyLabourLookups,
): { value: DailyLabourRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <T>(header: string, result: CellResult<T>): T | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    COLUMN_TITLES.villaNumber,
    textOrNumberCell(cell(COLUMN_TITLES.villaNumber), villaNumber, { required: true }),
  );
  const labourDate = take(
    COLUMN_TITLES.labourDate,
    dateCell(cell(COLUMN_TITLES.labourDate), { required: true }),
  );
  const labourCount = take(
    COLUMN_TITLES.labourCount,
    integerCell(cell(COLUMN_TITLES.labourCount), {
      required: true,
      min: 0,
      max: MAX_LABOUR_COUNT,
      key: "validation.labourCountInvalid",
    }),
  );
  const contractorCell = take(
    COLUMN_TITLES.contractor,
    textCell(cell(COLUMN_TITLES.contractor), contractorText, { required: true }),
  );
  const note = take(COLUMN_TITLES.notes, textCell(cell(COLUMN_TITLES.notes), notes, { required: false }));

  const villa = resolveVilla(
    parser.issues,
    lookups.villas,
    COLUMN_TITLES.villaNumber,
    villaText,
    cell(COLUMN_TITLES.villaNumber),
  );

  if (labourDate !== undefined && isTooFarAhead(labourDate, lookups.now)) {
    parser.issues.push({
      column: COLUMN_TITLES.labourDate,
      code: "INVALID_VALUE",
      key: "validation.labourDateFuture",
      value: cell(COLUMN_TITLES.labourDate),
    });
  }

  let contractorId: string | undefined;
  if (villa !== undefined && contractorCell !== undefined) {
    const outcome = checkVillaContractor(contractorCell, villa, lookups, "errors.labourContractorInactive");
    if (outcome.ok) {
      contractorId = outcome.contractorId;
    } else {
      parser.issues.push({
        column: COLUMN_TITLES.contractor,
        code: outcome.code,
        key: outcome.key,
        value: cell(COLUMN_TITLES.contractor),
      });
    }
  }

  if (
    !parser.ok ||
    villa === undefined ||
    labourDate === undefined ||
    labourCount === undefined ||
    contractorId === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      labourDate,
      contractorId,
      labourCount,
      notes: note ?? null,
    },
    issues: [],
  };
}

// A villa, a contractor and a day are one row: the table has the same rule as a unique index.
export const dailyLabourKey = (
  row: Pick<DailyLabourRowInput, "villaId" | "contractorId" | "labourDate">,
): string => joinKey(row.villaId, row.contractorId, toDay(row.labourDate));

export function dailyLabourImportDefinition(
  repository: DailyLabourRepository,
  actor: Actor,
  ctx: RequestContext,
  clock: () => Date,
): ImportDefinition<DailyLabourRowInput, DailyLabourLookups> {
  return {
    entity: "DailyLabour",
    action: "daily_labour.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: DAILY_LABOUR_IMPORT_COLUMNS,
    ignoredColumns: DAILY_LABOUR_IGNORED_COLUMNS,
    keyColumn: COLUMN_TITLES.labourDate,
    duplicateInFileKey: "import.dailyLabourDuplicateInFile",
    duplicateExistingKey: "import.dailyLabourDuplicateExisting",

    loadLookups: async (db) => ({
      ...buildVillaLookups(await repository.importVillas(db), await repository.importContractors(db)),
      now: clock(),
    }),

    parseRow: parseDailyLabourRow,

    keyOf: dailyLabourKey,

    findExisting: async (rows, db) => {
      const villaIds = [...new Set(rows.map((row) => row.villaId))];
      const stored = await repository.existingKeys(villaIds, db);
      return new Set(stored.map((row) => dailyLabourKey(row)));
    },

    insert: async (rows, db) => {
      // The villas first, shared and in the order of their ids (the lock order of shared/constants/locks.ts), so this
      // takes turns with a delete of a villa and with a change of its contractor. What the rows were checked against
      // must still be true.
      const villaIds = [...new Set(rows.map((row) => row.villaId))].sort();
      const contractors = await repository.lockVillasShared(villaIds, db);
      for (const row of rows) {
        if (contractors.get(row.villaId) !== row.contractorId) {
          throw importDataChanged(ctx);
        }
      }
      try {
        return await repository.createMany(
          rows.map((row) => ({ ...row, createdById: actor.id })),
          db,
        );
      } catch (err) {
        // A row for one of these keys was saved by someone else since the file was checked. The unique index has the last
        // word: nothing is saved, and the next upload shows the row as a duplicate.
        if (uniqueViolationConstraint(err)?.includes("labourDate")) {
          throw importDataChanged(ctx);
        }
        throw err;
      }
    },
  };
}

export class DailyLabourImportService {
  // The import runs in the daily labour repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new DailyLabourRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [villas, contractors] = await Promise.all([
      this.repository.importVillas(),
      this.repository.importContractors(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [COLUMN_TITLES.villaNumber]: villaNumberChoices(villas),
          [COLUMN_TITLES.contractor]: partyChoices(contractors),
        },
      }),
    };
  }

  importFile(
    actor: Actor,
    file: { name: string; bytes: Buffer },
    dryRun: boolean,
    ctx: RequestContext,
  ): Promise<ImportOutcome> {
    return this.runner.run(dailyLabourImportDefinition(this.repository, actor, ctx, this.clock), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }
}
