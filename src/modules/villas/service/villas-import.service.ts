import { audit, withMeta } from "../../../core/audit/audit.js";
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
import { currencyDigits } from "../../../shared/export/format.js";
import { COLUMN_TITLES } from "../../../shared/export/labels.js";
import {
  areaCell,
  areaChoices,
  buildAreaIndex,
  buildPartyIndex,
  buildTemplate,
  dateCell,
  joinKey,
  minorUnitsCell,
  normalizeText,
  partyCell,
  partyChoices,
  RowParser,
  textCell,
  textOrNumberCell,
  type AreaIndex,
  type IgnoredColumn,
  type ImportColumn,
  type PartyIndex,
  type RawCell,
  type TemplateSpec,
} from "../../../shared/import/index.js";
import { uniqueViolationConstraint } from "../../../shared/utils/index.js";
import { DEFAULT_CURRENCY } from "../dto/villas.dto.js";
import { toSnapshot } from "../mapper/villas.mapper.js";
import { VillasRepository, type NewVilla } from "../repository/villas.repository.js";
import {
  CURRENCY_CODES,
  villaCurrencyField,
  villaOwnerNameField,
  villaTextField,
} from "../validators/villas.validators.js";

// The columns of the file, in the order of the template. The names are the ones the villa list and the export use for the
// same things. Villa number, area, block, plot and civil engineer are required, as they are when a villa is created.
export const VILLA_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.villaNumber,
    kind: "text",
    required: true,
    description: "The villa's number, up to 50 characters. Two villas cannot share a number, in any case.",
    example: "V-001",
  },
  {
    header: COLUMN_TITLES.ownerName,
    kind: "text",
    required: false,
    description: "The owner, up to 120 characters. Leave it empty if there is none.",
    example: "Karim Fawzy",
  },
  {
    header: COLUMN_TITLES.area,
    kind: "text",
    required: true,
    description:
      "The name of an existing area. If two areas have the same name, write the name and the city: Name, City.",
    example: "New Cairo",
  },
  {
    header: COLUMN_TITLES.block,
    kind: "text",
    required: true,
    description: "The block, up to 50 characters.",
    example: "B2",
  },
  {
    header: COLUMN_TITLES.plot,
    kind: "text",
    required: true,
    description: "The plot, up to 50 characters. Two villas cannot share an area, a block and a plot.",
    example: "14",
  },
  {
    header: COLUMN_TITLES.contractor,
    kind: "text",
    required: false,
    description: "An existing, active contractor, by name or by phone. Leave it empty if there is none yet.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.electricalEngineer,
    kind: "text",
    required: false,
    description:
      "An existing, active electrical engineer, by name or by phone. Leave it empty if there is none.",
    example: "Eng. Hamdy Salah",
  },
  {
    header: COLUMN_TITLES.civilEngineer,
    kind: "text",
    required: true,
    description: "An existing, active civil engineer, by name or by phone.",
    example: "Eng. Mona Adel",
  },
  {
    header: COLUMN_TITLES.startDate,
    kind: "date",
    required: false,
    description:
      "The day work starts, written YYYY-MM-DD, or a date cell. Leave it empty if it is not known.",
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.targetDate,
    kind: "date",
    required: false,
    description:
      "The day the villa is due, written YYYY-MM-DD, or a date cell. It cannot be before the start date.",
    example: "2026-09-30",
  },
  {
    header: COLUMN_TITLES.budget,
    kind: "amount",
    required: false,
    description:
      "The budget, in the currency of the Currency column (KWD when there is none), as a number with at most as many decimals as that currency has: three for KWD (for example 1250000.500), two for EGP or USD, none for JPY. Leave it empty if there is none.",
    example: "1250000.500",
  },
  {
    header: COLUMN_TITLES.currency,
    kind: "text",
    required: false,
    optionalHeader: true,
    description:
      "The budget's currency, as a three-letter code (KWD, USD, EUR). Leave it empty for KWD, or leave the whole column out. It can only be given together with a budget.",
    example: "KWD",
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries them is imported as it is: they are not read.
export const VILLA_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.progress, kind: "text" },
  { header: COLUMN_TITLES.createdAt, kind: "datetime" },
] as const satisfies readonly IgnoredColumn[];

// Columns that older exports carried and the export no longer has (ready for inspection was removed). A file exported
// before that still imports: these are accepted and not read.
const VILLA_RETIRED_COLUMNS = [
  { header: "Ready", kind: "text" },
  { header: "Ready Date", kind: "date" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Villas",
  plural: "villas",
  fileName: "villas-import-template.xlsx",
  columns: VILLA_IMPORT_COLUMNS,
};

// A row that passed every check: what a villa is created from, apart from who creates it.
export type VillaRowInput = Omit<NewVilla, "createdById">;

// What a row is checked against: the areas and the parties, found by what a cell calls them.
export type VillaImportLookups = {
  areas: AreaIndex;
  civilEngineers: PartyIndex;
  electricalEngineers: PartyIndex;
  contractors: PartyIndex;
};

export function parseVillaRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: VillaImportLookups,
): { value: VillaRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();

  const villaNumber = parser.take(
    COLUMN_TITLES.villaNumber,
    cell(COLUMN_TITLES.villaNumber),
    textOrNumberCell(cell(COLUMN_TITLES.villaNumber), villaTextField, { required: true }),
  );
  const ownerName = parser.take(
    COLUMN_TITLES.ownerName,
    cell(COLUMN_TITLES.ownerName),
    textOrNumberCell(cell(COLUMN_TITLES.ownerName), villaOwnerNameField, { required: false }),
  );
  const areaId = parser.take(
    COLUMN_TITLES.area,
    cell(COLUMN_TITLES.area),
    areaCell(cell(COLUMN_TITLES.area), lookups.areas, { required: true }),
  );
  const block = parser.take(
    COLUMN_TITLES.block,
    cell(COLUMN_TITLES.block),
    textOrNumberCell(cell(COLUMN_TITLES.block), villaTextField, { required: true }),
  );
  const plot = parser.take(
    COLUMN_TITLES.plot,
    cell(COLUMN_TITLES.plot),
    textOrNumberCell(cell(COLUMN_TITLES.plot), villaTextField, { required: true }),
  );
  const contractorId = parser.take(
    COLUMN_TITLES.contractor,
    cell(COLUMN_TITLES.contractor),
    partyCell(cell(COLUMN_TITLES.contractor), lookups.contractors, {
      required: false,
      notFoundKey: "import.contractorNotFound",
      inactiveKey: "errors.contractorInactive",
    }),
  );
  const electricalEngineerId = parser.take(
    COLUMN_TITLES.electricalEngineer,
    cell(COLUMN_TITLES.electricalEngineer),
    partyCell(cell(COLUMN_TITLES.electricalEngineer), lookups.electricalEngineers, {
      required: false,
      notFoundKey: "import.electricalEngineerNotFound",
      inactiveKey: "errors.electricalEngineerInactive",
    }),
  );
  const civilEngineerId = parser.take(
    COLUMN_TITLES.civilEngineer,
    cell(COLUMN_TITLES.civilEngineer),
    partyCell(cell(COLUMN_TITLES.civilEngineer), lookups.civilEngineers, {
      required: true,
      notFoundKey: "import.civilEngineerNotFound",
      inactiveKey: "errors.civilEngineerInactive",
    }),
  );
  const startDate = parser.take(
    COLUMN_TITLES.startDate,
    cell(COLUMN_TITLES.startDate),
    dateCell(cell(COLUMN_TITLES.startDate), { required: false }),
  );
  const targetDate = parser.take(
    COLUMN_TITLES.targetDate,
    cell(COLUMN_TITLES.targetDate),
    dateCell(cell(COLUMN_TITLES.targetDate), { required: false }),
  );
  // The budget is in the major units of its currency (dinars, pounds, dollars) and is saved in its minor units (fils, piastres,
  // cents), read with that currency's own number of decimals (three for KWD, the default). A currency that cannot be read leaves the budget unchecked until it is fixed.
  const currency = parser.take(
    COLUMN_TITLES.currency,
    cell(COLUMN_TITLES.currency),
    textCell(cell(COLUMN_TITLES.currency), villaCurrencyField, { required: false }),
  );
  const currencyReadable = currency !== undefined || cell(COLUMN_TITLES.currency) === null;
  const budgetMinor = currencyReadable
    ? parser.take(
        COLUMN_TITLES.budget,
        cell(COLUMN_TITLES.budget),
        minorUnitsCell(cell(COLUMN_TITLES.budget), {
          required: false,
          scale: currencyDigits(currency ?? DEFAULT_CURRENCY),
          key: "import.budgetInvalid",
        }),
      )
    : undefined;
  if (currency !== undefined && cell(COLUMN_TITLES.budget) === null) {
    parser.issues.push({
      column: COLUMN_TITLES.currency,
      code: "INVALID_VALUE",
      key: "validation.currencyWithoutBudget",
      value: cell(COLUMN_TITLES.currency),
    });
  }

  if (startDate !== undefined && targetDate !== undefined && targetDate < startDate) {
    parser.issues.push({
      column: COLUMN_TITLES.targetDate,
      code: "INVALID_VALUE",
      key: "validation.targetBeforeStart",
      value: cell(COLUMN_TITLES.targetDate),
    });
  }

  if (
    !parser.ok ||
    villaNumber === undefined ||
    areaId === undefined ||
    block === undefined ||
    plot === undefined ||
    civilEngineerId === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaNumber,
      ownerName: ownerName ?? null,
      // The import file has no type column; the villa can be given one afterwards.
      villaType: null,
      areaId,
      block,
      plot,
      civilEngineerId,
      electricalEngineerId: electricalEngineerId ?? null,
      contractorId: contractorId ?? null,
      startDate: startDate ?? null,
      targetDate: targetDate ?? null,
      budgetMinor: budgetMinor ?? null,
      currency: budgetMinor === undefined ? null : (currency ?? DEFAULT_CURRENCY),
    },
    issues: [],
  };
}

// A villa is the same villa when its number is the same, ignoring case and extra spaces. (Creating one by hand compares
// the number exactly: the import is stricter, so a file cannot load "v-001" beside "V-001".)
export const villaNumberKey = (row: Pick<VillaRowInput, "villaNumber">): string =>
  normalizeText(row.villaNumber);

// Two villas cannot stand on the same plot: the same area, block and plot, ignoring case and extra spaces.
export const villaPlotKey = (row: Pick<VillaRowInput, "areaId" | "block" | "plot">): string =>
  joinKey(row.areaId, normalizeText(row.block), normalizeText(row.plot));

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.villaImportDataChanged"), "IMPORT_DATA_CHANGED");

const unique = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
];

export function villaImportDefinition(
  repository: VillasRepository,
  actor: Actor,
  ctx: RequestContext,
): ImportDefinition<VillaRowInput, VillaImportLookups> {
  return {
    entity: "Villa",
    action: "villa.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: VILLA_IMPORT_COLUMNS,
    ignoredColumns: [...VILLA_IGNORED_COLUMNS, ...VILLA_RETIRED_COLUMNS],
    keyColumn: COLUMN_TITLES.villaNumber,
    duplicateInFileKey: "import.villaDuplicateInFile",
    duplicateExistingKey: "import.villaDuplicateExisting",

    loadLookups: async (db) => ({
      areas: buildAreaIndex(await repository.importAreas(db)),
      civilEngineers: buildPartyIndex(await repository.importCivilEngineers(db)),
      electricalEngineers: buildPartyIndex(await repository.importElectricalEngineers(db)),
      contractors: buildPartyIndex(await repository.importContractors(db)),
    }),

    parseRow: parseVillaRow,

    keyOf: villaNumberKey,

    findExisting: async (rows, db) => {
      const wanted = new Set(rows.map(villaNumberKey));
      const stored = (await repository.storedVillaNumbers(db)).map((number) => normalizeText(number));
      return new Set(stored.filter((key) => wanted.has(key)));
    },

    // The place is the second rule: it is reported on the Plot column.
    extraKeys: [
      {
        keyColumn: COLUMN_TITLES.plot,
        duplicateInFileKey: "import.plotDuplicateInFile",
        duplicateExistingKey: "import.plotDuplicateExisting",
        keyOf: villaPlotKey,
        findExisting: async (rows, db) => {
          const wanted = new Set(rows.map(villaPlotKey));
          const stored = await repository.storedPlots(unique(rows.map((row) => row.areaId)), db);
          return new Set(stored.map(villaPlotKey).filter((key) => wanted.has(key)));
        },
      },
    ],

    insert: async (rows, db) => {
      // LOCK ORDER (shared/constants/locks.ts): the phase set first, as for a villa created by hand, so no phase is created
      // or deleted between the villas and their progress rows; then the areas and the parties the rows use, shared. What the
      // rows were checked against must still be true.
      await repository.lockPhaseSet(db);
      const locked = await repository.lockRefsShared(
        {
          areaIds: unique(rows.map((row) => row.areaId)),
          civilEngineerIds: unique(rows.map((row) => row.civilEngineerId)),
          electricalEngineerIds: unique(rows.map((row) => row.electricalEngineerId)),
          contractorIds: unique(rows.map((row) => row.contractorId)),
        },
        db,
      );
      for (const row of rows) {
        const switchedOff =
          locked.civilEngineers.get(row.civilEngineerId) !== "ACTIVE" ||
          (row.electricalEngineerId !== null &&
            locked.electricalEngineers.get(row.electricalEngineerId) !== "ACTIVE") ||
          (row.contractorId !== null && locked.contractors.get(row.contractorId) !== "ACTIVE");
        if (!locked.areas.has(row.areaId) || switchedOff) {
          throw importDataChanged(ctx);
        }
      }

      let ids: string[];
      try {
        ids = await repository.createMany(
          rows.map((row) => ({ ...row, createdById: actor.id })),
          db,
        );
      } catch (err) {
        // A villa with one of these numbers or places was saved by someone else since the file was checked: the unique
        // indexes have the last word. Nothing is saved, and the next upload shows the row as a duplicate.
        if (uniqueViolationConstraint(err) !== undefined) {
          throw importDataChanged(ctx);
        }
        throw err;
      }
      await repository.insertProgressRowsForMany(ids, db);
      // The entries a villa created by hand leaves, one per villa, in the same transaction.
      await audit.recordMany(
        db,
        rows.map((row, index) =>
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.create",
            entity: "Villa",
            entityId: ids[index],
            after: toSnapshot({
              ...row,
              budgetMinor: row.budgetMinor === null ? null : BigInt(row.budgetMinor),
            }),
          }),
        ),
      );
      return ids;
    },
  };
}

export class VillasImportService {
  // The import runs in the villas repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new VillasRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
  ) {}

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [areas, civilEngineers, electricalEngineers, contractors] = await Promise.all([
      this.repository.importAreas(),
      this.repository.importCivilEngineers(),
      this.repository.importElectricalEngineers(),
      this.repository.importContractors(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [COLUMN_TITLES.area]: areaChoices(areas),
          [COLUMN_TITLES.contractor]: partyChoices(contractors),
          [COLUMN_TITLES.electricalEngineer]: partyChoices(electricalEngineers),
          [COLUMN_TITLES.civilEngineer]: partyChoices(civilEngineers),
          [COLUMN_TITLES.currency]: CURRENCY_CODES,
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
    return this.runner.run(villaImportDefinition(this.repository, actor, ctx), { file, dryRun, actor, ctx });
  }
}
