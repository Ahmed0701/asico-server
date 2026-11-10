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
import { COLUMN_TITLES, WEATHER_LABELS } from "../../../shared/export/labels.js";
import {
  buildPartyIndex,
  buildTemplate,
  partyCell,
  partyChoices,
  dateCell,
  enumCell,
  enumSpec,
  IMPORT_LONG_TEXT_CELL_CHARS,
  integerCell,
  joinKey,
  RowParser,
  textCell,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type PartyIndex,
  type RawCell,
  type TemplateSpec,
} from "../../../shared/import/index.js";
import { toDay } from "../../../shared/utils/day.js";
import { uniqueViolationConstraint } from "../../../shared/utils/index.js";
import { MAX_WORKERS, WEATHERS } from "../dto/daily-reports.dto.js";
import { DailyReportsRepository, type NewDailyReport } from "../repository/daily-reports.repository.js";
import { notes } from "../validators/daily-reports.validators.js";
import { isTooFarAhead } from "./daily-reports.service.js";

const WEATHER = enumSpec(WEATHERS, WEATHER_LABELS);

// The columns of the file, in the order of the template. The weather takes the code or the label, in any case. The notes take as
// many characters as the API does, so a report that was exported can be imported again. The contractor and the electrical
// engineer are any ACTIVE ones, by name or by phone (a report belongs to no villa).
export const DAILY_REPORT_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.reportDate,
    kind: "date",
    required: true,
    description:
      "The day of the report, written YYYY-MM-DD, or a date cell. A contractor has one report per day. Tomorrow is the latest day allowed.",
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.contractor,
    kind: "text",
    required: true,
    description: "The contractor the report is about, by name or by phone. Only an active contractor.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.electricalEngineer,
    kind: "text",
    required: true,
    description:
      "The electrical engineer who prepared the report, by name or by phone. Only an active engineer.",
    example: "Example Engineer",
  },
  {
    header: COLUMN_TITLES.weather,
    kind: "text",
    required: true,
    description: "The weather that day.",
    example: WEATHER_LABELS.SUNNY,
    values: WEATHERS.map((value) => WEATHER_LABELS[value]),
  },
  {
    header: COLUMN_TITLES.workersCount,
    kind: "integer",
    required: true,
    description: "How many workers were on site: a whole number from 0 to 100,000.",
    example: "25",
  },
  {
    header: COLUMN_TITLES.notes,
    kind: "text",
    required: false,
    description:
      "Anything worth noting about that day, up to 5,000 characters. Leave it empty if there is nothing.",
    example: "Cement delivery was late",
    maxChars: IMPORT_LONG_TEXT_CELL_CHARS,
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns: nothing. The workbook of the export is the import template with the data in it.
export const DAILY_REPORT_IGNORED_COLUMNS = [] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Daily reports",
  plural: "daily reports",
  fileName: "daily-reports-import-template.xlsx",
  columns: DAILY_REPORT_IMPORT_COLUMNS,
};

// A row that passed every check.
export type DailyReportRowInput = Omit<NewDailyReport, "createdById">;

// What a row is checked against: the contractors and the electrical engineers, by name and by phone, and the instant "tomorrow"
// is counted from.
export type DailyReportLookups = { contractors: PartyIndex; engineers: PartyIndex; now: Date };

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

export function parseDailyReportRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: DailyReportLookups,
): { value: DailyReportRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <T>(header: string, result: CellResult<T>): T | undefined =>
    parser.take(header, cell(header), result);

  const reportDate = take(
    COLUMN_TITLES.reportDate,
    dateCell(cell(COLUMN_TITLES.reportDate), { required: true }),
  );
  const contractorId = take(
    COLUMN_TITLES.contractor,
    partyCell(cell(COLUMN_TITLES.contractor), lookups.contractors, {
      required: true,
      notFoundKey: "import.contractorNotFound",
      inactiveKey: "errors.reportContractorInactive",
    }),
  );
  const preparedByEngineerId = take(
    COLUMN_TITLES.electricalEngineer,
    partyCell(cell(COLUMN_TITLES.electricalEngineer), lookups.engineers, {
      required: true,
      notFoundKey: "import.electricalEngineerNotFound",
      inactiveKey: "errors.reportEngineerInactive",
    }),
  );
  const weather = take(
    COLUMN_TITLES.weather,
    enumCell(cell(COLUMN_TITLES.weather), WEATHER, { required: true }),
  );
  const workersCount = take(
    COLUMN_TITLES.workersCount,
    integerCell(cell(COLUMN_TITLES.workersCount), {
      required: true,
      min: 0,
      max: MAX_WORKERS,
      key: "validation.workersCountInvalid",
    }),
  );
  const note = take(COLUMN_TITLES.notes, textCell(cell(COLUMN_TITLES.notes), notes, { required: false }));

  if (reportDate !== undefined && isTooFarAhead(reportDate, lookups.now)) {
    parser.issues.push({
      column: COLUMN_TITLES.reportDate,
      code: "INVALID_VALUE",
      key: "validation.reportDateFuture",
      value: cell(COLUMN_TITLES.reportDate),
    });
  }

  if (
    !parser.ok ||
    reportDate === undefined ||
    contractorId === undefined ||
    preparedByEngineerId === undefined ||
    weather === undefined ||
    workersCount === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      contractorId,
      preparedByEngineerId,
      reportDate,
      weather,
      workersCount,
      notes: note ?? null,
    },
    issues: [],
  };
}

// A contractor and a day are one report: the table has the same rule as a unique index.
export const dailyReportKey = (row: Pick<DailyReportRowInput, "contractorId" | "reportDate">): string =>
  joinKey(row.contractorId, toDay(row.reportDate));

export function dailyReportsImportDefinition(
  repository: DailyReportsRepository,
  actor: Actor,
  ctx: RequestContext,
  clock: () => Date,
): ImportDefinition<DailyReportRowInput, DailyReportLookups> {
  return {
    entity: "DailyReport",
    action: "daily_report.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: DAILY_REPORT_IMPORT_COLUMNS,
    ignoredColumns: DAILY_REPORT_IGNORED_COLUMNS,
    keyColumn: COLUMN_TITLES.reportDate,
    duplicateInFileKey: "import.dailyReportDuplicateInFile",
    duplicateExistingKey: "import.dailyReportDuplicateExisting",

    loadLookups: async (db) => {
      if (!(await repository.userExists(actor.id, db))) {
        throw new AppError(401, t(ctx.locale, "errors.unauthorized"), "UNAUTHORIZED");
      }
      const [contractors, engineers] = await Promise.all([
        repository.importContractors(db),
        repository.importEngineers(db),
      ]);
      return {
        contractors: buildPartyIndex(contractors),
        engineers: buildPartyIndex(engineers),
        now: clock(),
      };
    },

    parseRow: parseDailyReportRow,

    keyOf: dailyReportKey,

    findExisting: async (rows, db) => {
      const contractorIds = [...new Set(rows.map((row) => row.contractorId))];
      const stored = await repository.existingDays(contractorIds, db);
      return new Set(stored.map((report) => dailyReportKey(report)));
    },

    insert: async (rows, db) => {
      // The contractors, then the electrical engineers, shared and in the order of their ids (see shared/constants/locks.ts), so
      // this takes turns with a switch-off or a delete of one of them. What the rows were checked against must still be true:
      // one that was deleted or switched off since the file was checked is a changed file.
      const contractorIds = [...new Set(rows.map((row) => row.contractorId))].sort();
      const contractors = await repository.lockContractorsShared(contractorIds, db);
      const engineerIds = [...new Set(rows.map((row) => row.preparedByEngineerId))].sort();
      const engineers = await repository.lockEngineersShared(engineerIds, db);
      if (
        contractorIds.some((id) => contractors.get(id) !== "ACTIVE") ||
        engineerIds.some((id) => engineers.get(id) !== "ACTIVE")
      ) {
        throw importDataChanged(ctx);
      }
      try {
        return await repository.createMany(
          rows.map((row) => ({ ...row, createdById: actor.id })),
          db,
        );
      } catch (err) {
        // A report for one of these days was saved by someone else since the file was checked. The unique index has the
        // last word: nothing is saved, and the next upload shows the row as a duplicate.
        if (uniqueViolationConstraint(err)?.includes("reportDate")) {
          throw importDataChanged(ctx);
        }
        throw err;
      }
    },
  };
}

export class DailyReportsImportService {
  // The import runs in the daily reports repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new DailyReportsRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // The dropdowns of the contractor and of the electrical engineer list the active ones.
  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [contractors, engineers] = await Promise.all([
      this.repository.importContractors(),
      this.repository.importEngineers(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [COLUMN_TITLES.contractor]: partyChoices(contractors),
          [COLUMN_TITLES.electricalEngineer]: partyChoices(engineers),
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
    return this.runner.run(dailyReportsImportDefinition(this.repository, actor, ctx, this.clock), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }
}
