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
import { COLUMN_TITLES, SMALL_WORK_STATUS_LABELS } from "../../../shared/export/labels.js";
import {
  buildPartyIndex,
  buildTemplate,
  partyCell,
  partyChoices,
  villaNumberChoices,
  buildVillaIndex,
  dateCell,
  enumCell,
  enumSpec,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type PartyIndex,
  type RawCell,
  type TemplateSpec,
  type VillaIndex,
} from "../../../shared/import/index.js";
import { isWithinYears } from "../../../shared/utils/day.js";
import { MAX_DESCRIPTION_LENGTH, MAX_YEARS_AWAY, SMALL_WORK_STATUSES } from "../dto/small-works.dto.js";
import {
  SmallWorksRepository,
  type ImportVillaRef,
  type NewSmallWork,
} from "../repository/small-works.repository.js";
import { description } from "../validators/small-works.validators.js";

const STATUS = enumSpec(SMALL_WORK_STATUSES, SMALL_WORK_STATUS_LABELS);
const villaNumber = z.string().trim().min(1, { error: "validation.required" });

// The columns of the file, in the order of the template. The description is checked by the same schema as the API, so a
// file accepts exactly the length a request does (500); the reader's default cell limit is only a safety net above it. The contractor is any ACTIVE contractor, by name or by phone (the villa's own or not). The status takes the code or
// the label, in any case.
export const SMALL_WORK_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.villaNumber,
    kind: "text",
    required: true,
    description: "The villa number, exactly as it is in the system.",
    example: "EX-000",
  },
  {
    header: COLUMN_TITLES.startDate,
    kind: "date",
    required: true,
    description: `The first day of the work, written YYYY-MM-DD, or a date cell. Within ${MAX_YEARS_AWAY} years of today.`,
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.endDate,
    kind: "date",
    required: true,
    description: `The last day of the work, written YYYY-MM-DD, or a date cell: the same day as the start or later. The work is overdue when this day is over. Within ${MAX_YEARS_AWAY} years of today.`,
    example: "2026-01-20",
  },
  {
    header: COLUMN_TITLES.description,
    kind: "text",
    required: true,
    description: `What was done, up to ${MAX_DESCRIPTION_LENGTH} characters.`,
    example: "Replaced a broken socket in the hall",
  },
  {
    header: COLUMN_TITLES.contractor,
    kind: "text",
    required: true,
    description:
      "The contractor who does the work, by name or by phone. Any active contractor: it does not have to be the villa's own.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.status,
    kind: "text",
    required: false,
    description: "Leave it empty for Pending.",
    example: SMALL_WORK_STATUS_LABELS.PENDING,
    values: SMALL_WORK_STATUSES.map((value) => SMALL_WORK_STATUS_LABELS[value]),
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries it is imported as it is: it is not read.
export const SMALL_WORK_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.location, kind: "text" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Small works",
  plural: "small works",
  fileName: "small-works-import-template.xlsx",
  columns: SMALL_WORK_IMPORT_COLUMNS,
};

// A row that passed every check.
export type SmallWorkRowInput = Omit<NewSmallWork, "createdById">;

// What a row is checked against: the villas by number, the contractors by name and by phone, and the instant the bound around
// today is counted from.
export type SmallWorkLookups = {
  villas: VillaIndex<ImportVillaRef>;
  contractors: PartyIndex;
  now: Date;
};

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

export function parseSmallWorkRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: SmallWorkLookups,
): { value: SmallWorkRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <T>(header: string, result: CellResult<T>): T | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    COLUMN_TITLES.villaNumber,
    textOrNumberCell(cell(COLUMN_TITLES.villaNumber), villaNumber, { required: true }),
  );
  const startDate = take(
    COLUMN_TITLES.startDate,
    dateCell(cell(COLUMN_TITLES.startDate), { required: true }),
  );
  const endDate = take(COLUMN_TITLES.endDate, dateCell(cell(COLUMN_TITLES.endDate), { required: true }));
  const text = take(
    COLUMN_TITLES.description,
    textCell(cell(COLUMN_TITLES.description), description, { required: true }),
  );
  const contractorId = take(
    COLUMN_TITLES.contractor,
    partyCell(cell(COLUMN_TITLES.contractor), lookups.contractors, {
      required: true,
      notFoundKey: "import.contractorNotFound",
      inactiveKey: "errors.smallWorkContractorInactive",
    }),
  );
  const status = take(
    COLUMN_TITLES.status,
    enumCell(cell(COLUMN_TITLES.status), STATUS, { required: false }),
  );

  const villa = resolveVilla(
    parser.issues,
    lookups.villas,
    COLUMN_TITLES.villaNumber,
    villaText,
    cell(COLUMN_TITLES.villaNumber),
  );

  for (const [header, day] of [
    [COLUMN_TITLES.startDate, startDate],
    [COLUMN_TITLES.endDate, endDate],
  ] as const) {
    if (day !== undefined && !isWithinYears(day, lookups.now, MAX_YEARS_AWAY)) {
      parser.issues.push({
        column: header,
        code: "INVALID_VALUE",
        key: "validation.plannedDateOutOfRange",
        value: cell(header),
      });
    }
  }
  // The pair is checked once both are valid dates; the issue is on the end date.
  if (startDate !== undefined && endDate !== undefined && endDate.getTime() < startDate.getTime()) {
    parser.issues.push({
      column: COLUMN_TITLES.endDate,
      code: "INVALID_VALUE",
      key: "errors.smallWorkDateRange",
      value: cell(COLUMN_TITLES.endDate),
    });
  }

  if (
    !parser.ok ||
    villa === undefined ||
    startDate === undefined ||
    endDate === undefined ||
    contractorId === undefined ||
    text === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      contractorId,
      startDate,
      endDate,
      description: text,
      status: status ?? "PENDING",
    },
    issues: [],
  };
}

export function smallWorksImportDefinition(
  repository: SmallWorksRepository,
  actor: Actor,
  ctx: RequestContext,
  clock: () => Date,
): ImportDefinition<SmallWorkRowInput, SmallWorkLookups, false> {
  return {
    entity: "DailySmallWork",
    action: "small_work.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: SMALL_WORK_IMPORT_COLUMNS,
    ignoredColumns: SMALL_WORK_IGNORED_COLUMNS,

    loadLookups: async (db) => {
      if (!(await repository.userExists(actor.id, db))) {
        throw new AppError(401, t(ctx.locale, "errors.unauthorized"), "UNAUTHORIZED");
      }
      const [villas, contractors] = await Promise.all([
        repository.importVillas(db),
        repository.importContractors(db),
      ]);
      return {
        villas: buildVillaIndex(villas),
        contractors: buildPartyIndex(contractors),
        now: clock(),
      };
    },

    parseRow: parseSmallWorkRow,

    insert: async (rows, db) => {
      // The villas first, shared and in the order of their ids (the lock order of shared/constants/locks.ts), so this
      // takes turns with a delete of a villa. What the rows were checked against must still be true.
      const villaIds = [...new Set(rows.map((row) => row.villaId))].sort();
      const existing = await repository.lockVillasShared(villaIds, db);
      if (rows.some((row) => !existing.has(row.villaId))) {
        throw importDataChanged(ctx);
      }
      // Then the contractors, shared and in the order of their ids: one that was deleted or switched off since the file was
      // checked is a changed file.
      const contractorIds = [...new Set(rows.map((row) => row.contractorId))].sort();
      const statuses = await repository.lockContractorsShared(contractorIds, db);
      if (contractorIds.some((id) => statuses.get(id) !== "ACTIVE")) {
        throw importDataChanged(ctx);
      }
      return repository.createMany(
        rows.map((row) => ({ ...row, createdById: actor.id })),
        db,
      );
    },
  };
}

export class SmallWorksImportService {
  // The import runs in the small works repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new SmallWorksRepository(),
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
    return this.runner.run(smallWorksImportDefinition(this.repository, actor, ctx, this.clock), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }
}
