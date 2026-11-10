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
import { COLUMN_TITLES, SITE_REPORT_TYPE_LABELS } from "../../../shared/export/labels.js";
import {
  buildTemplate,
  wholeNumberChoices,
  villaNumberChoices,
  buildVillaIndex,
  dateCell,
  enumCell,
  enumSpec,
  IMPORT_LONG_TEXT_CELL_CHARS,
  integerCell,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type RawCell,
  type TemplateSpec,
  type VillaIndex,
} from "../../../shared/import/index.js";
import { isTooFarAhead } from "../../../shared/utils/day.js";
import {
  MAX_INSPECTOR_LENGTH,
  MAX_RATING,
  MAX_TITLE_LENGTH,
  MIN_RATING,
  SITE_REPORT_TYPES,
} from "../dto/site-reports.dto.js";
import {
  SiteReportsRepository,
  type ImportVillaRef,
  type NewSiteReport,
} from "../repository/site-reports.repository.js";
import { findings, inspector, recommendations, title } from "../validators/site-reports.validators.js";

const TYPE = enumSpec(SITE_REPORT_TYPES, SITE_REPORT_TYPE_LABELS);
const villaNumber = z.string().trim().min(1, { error: "validation.required" });

// The columns of the file, in the order of the template. The type takes the code or the label, in any case. The texts are
// checked by the same schemas as the API, so a file accepts exactly the lengths a request does (150, 100 and 5,000); the
// two long texts take as many characters per cell, so a report that was exported can be imported again.
export const SITE_REPORT_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.villaNumber,
    kind: "text",
    required: true,
    description: "The villa number, exactly as it is in the system.",
    example: "EX-000",
  },
  {
    header: COLUMN_TITLES.title,
    kind: "text",
    required: true,
    description: `What the visit was about, up to ${MAX_TITLE_LENGTH} characters.`,
    example: "Electrical first fix check",
  },
  {
    header: COLUMN_TITLES.visitDate,
    kind: "date",
    required: true,
    description:
      "The day of the visit, written YYYY-MM-DD, or a date cell. Tomorrow is the latest day allowed.",
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.inspector,
    kind: "text",
    required: true,
    description: `Who made the visit, up to ${MAX_INSPECTOR_LENGTH} characters.`,
    example: "Eng. Hamdy",
  },
  {
    header: COLUMN_TITLES.type,
    kind: "text",
    required: true,
    description: "The kind of visit.",
    example: SITE_REPORT_TYPE_LABELS.INSPECTION,
    values: SITE_REPORT_TYPES.map((value) => SITE_REPORT_TYPE_LABELS[value]),
  },
  {
    header: COLUMN_TITLES.rating,
    kind: "integer",
    required: true,
    description: `The rating of the visit: a whole number from ${MIN_RATING} to ${MAX_RATING}.`,
    example: "4",
  },
  {
    header: COLUMN_TITLES.findings,
    kind: "text",
    required: true,
    description: "What was found, up to 5,000 characters.",
    example: "Conduits are fixed and the boxes are at the right height",
    maxChars: IMPORT_LONG_TEXT_CELL_CHARS,
  },
  {
    header: COLUMN_TITLES.recommendations,
    kind: "text",
    required: false,
    description: "What should be done, up to 5,000 characters. Leave it empty if there is nothing to add.",
    example: "Seal the open sleeves before plastering",
    maxChars: IMPORT_LONG_TEXT_CELL_CHARS,
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries it is imported as it is: it is not read.
export const SITE_REPORT_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.location, kind: "text" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Site reports",
  plural: "site reports",
  fileName: "site-reports-import-template.xlsx",
  columns: SITE_REPORT_IMPORT_COLUMNS,
};

// A row that passed every check.
export type SiteReportRowInput = Omit<NewSiteReport, "createdById">;

// What a row is checked against: the villas by number, and the instant "tomorrow" is counted from.
export type SiteReportLookups = { villas: VillaIndex<ImportVillaRef>; now: Date };

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

export function parseSiteReportRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: SiteReportLookups,
): { value: SiteReportRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <T>(header: string, result: CellResult<T>): T | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    COLUMN_TITLES.villaNumber,
    textOrNumberCell(cell(COLUMN_TITLES.villaNumber), villaNumber, { required: true }),
  );
  const heading = take(COLUMN_TITLES.title, textCell(cell(COLUMN_TITLES.title), title, { required: true }));
  const visitDate = take(
    COLUMN_TITLES.visitDate,
    dateCell(cell(COLUMN_TITLES.visitDate), { required: true }),
  );
  const author = take(
    COLUMN_TITLES.inspector,
    textCell(cell(COLUMN_TITLES.inspector), inspector, { required: true }),
  );
  const type = take(COLUMN_TITLES.type, enumCell(cell(COLUMN_TITLES.type), TYPE, { required: true }));
  const rating = take(
    COLUMN_TITLES.rating,
    integerCell(cell(COLUMN_TITLES.rating), {
      required: true,
      min: MIN_RATING,
      max: MAX_RATING,
      key: "validation.ratingInvalid",
    }),
  );
  const found = take(
    COLUMN_TITLES.findings,
    textCell(cell(COLUMN_TITLES.findings), findings, { required: true }),
  );
  const advice = take(
    COLUMN_TITLES.recommendations,
    textCell(cell(COLUMN_TITLES.recommendations), recommendations, { required: false }),
  );

  const villa = resolveVilla(
    parser.issues,
    lookups.villas,
    COLUMN_TITLES.villaNumber,
    villaText,
    cell(COLUMN_TITLES.villaNumber),
  );

  if (visitDate !== undefined && isTooFarAhead(visitDate, lookups.now)) {
    parser.issues.push({
      column: COLUMN_TITLES.visitDate,
      code: "INVALID_VALUE",
      key: "validation.visitDateFuture",
      value: cell(COLUMN_TITLES.visitDate),
    });
  }

  if (
    !parser.ok ||
    villa === undefined ||
    heading === undefined ||
    visitDate === undefined ||
    author === undefined ||
    type === undefined ||
    rating === undefined ||
    found === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      title: heading,
      visitDate,
      inspector: author,
      type,
      rating,
      findings: found,
      recommendations: advice ?? null,
    },
    issues: [],
  };
}

export function siteReportsImportDefinition(
  repository: SiteReportsRepository,
  actor: Actor,
  ctx: RequestContext,
  clock: () => Date,
): ImportDefinition<SiteReportRowInput, SiteReportLookups, false> {
  return {
    entity: "SiteReport",
    action: "site_report.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: SITE_REPORT_IMPORT_COLUMNS,
    ignoredColumns: SITE_REPORT_IGNORED_COLUMNS,

    loadLookups: async (db) => {
      if (!(await repository.userExists(actor.id, db))) {
        throw new AppError(401, t(ctx.locale, "errors.unauthorized"), "UNAUTHORIZED");
      }
      const villas = await repository.importVillas(db);
      return {
        villas: buildVillaIndex(villas),
        now: clock(),
      };
    },

    parseRow: parseSiteReportRow,

    insert: async (rows, db) => {
      // The villas first, shared and in the order of their ids (the lock order of shared/constants/locks.ts), so this
      // takes turns with a delete of a villa. What the rows were checked against must still be true.
      const villaIds = [...new Set(rows.map((row) => row.villaId))].sort();
      const existing = await repository.lockVillasShared(villaIds, db);
      if (rows.some((row) => !existing.has(row.villaId))) {
        throw importDataChanged(ctx);
      }
      return repository.createMany(
        rows.map((row) => ({ ...row, createdById: actor.id })),
        db,
      );
    },
  };
}

export class SiteReportsImportService {
  // The import runs in the site reports repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new SiteReportsRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const villas = await this.repository.importVillas();
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [COLUMN_TITLES.villaNumber]: villaNumberChoices(villas),
          [COLUMN_TITLES.rating]: wholeNumberChoices(MIN_RATING, MAX_RATING),
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
    return this.runner.run(siteReportsImportDefinition(this.repository, actor, ctx, this.clock), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }
}
