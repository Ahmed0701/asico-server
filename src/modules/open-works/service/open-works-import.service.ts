import { z } from "zod";
import {
  IMPORT_TRANSACTION_TIMEOUT_MS,
  ImportBatchRepository,
  ImportRunner,
  type ImportDefinition,
  type ImportOutcome,
} from "../../../core/imports/index.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { COLUMN_TITLES, PRIORITY_LABELS, WORK_STATUS_LABELS } from "../../../shared/export/labels.js";
import {
  buildReferenceIndex,
  buildTemplate,
  partyChoices,
  villaNumberChoices,
  buildVillaLookups,
  checkVillaContractor,
  dateCell,
  enumCell,
  enumSpec,
  integerCell,
  referenceCell,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type RawCell,
  type ReferenceIndex,
  type TemplateSpec,
  type VillaLookups,
} from "../../../shared/import/index.js";
import type { ElecPhaseStatusValue } from "../../elec-phases/dto/elec-phases.dto.js";
import { PRIORITIES, WORK_STATUSES } from "../dto/open-works.dto.js";
import { OpenWorksRepository, villaPhaseKey, type NewOpenWork } from "../repository/open-works.repository.js";
import { startingPair, statusAgreesWithProgress } from "./open-works.service.js";

const MAX_PROGRESS = 100;

const STATUS = enumSpec(WORK_STATUSES, WORK_STATUS_LABELS);
const PRIORITY = enumSpec(PRIORITIES, PRIORITY_LABELS);
const villaNumber = z.string().trim().min(1, { error: "validation.required" });
const contractorText = z.string().trim().min(1, { error: "validation.required" });

// The columns of the file, in the order of the template and of the export. An enum column takes the code or the label, in any case.
export const OPEN_WORK_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.villaNumber,
    kind: "text",
    required: true,
    description: "The villa number, exactly as it is in the system.",
    example: "EX-000",
  },
  {
    header: COLUMN_TITLES.elecPhase,
    kind: "text",
    required: true,
    description:
      "The electrical phase the work is filed under, by its name, exactly as the electrical phases page shows it. Only an active phase.",
    example: "Ceiling Piping",
  },
  {
    header: COLUMN_TITLES.status,
    kind: "text",
    required: false,
    description:
      "Leave it empty to let the progress decide: Not started at 0, In progress from 1 to 99, Done at 100. Not started needs a progress of 0, and Done needs 100.",
    example: WORK_STATUS_LABELS.IN_PROGRESS,
    values: WORK_STATUSES.map((status) => WORK_STATUS_LABELS[status]),
  },
  {
    header: COLUMN_TITLES.priority,
    kind: "text",
    required: false,
    description: "Leave it empty for Medium.",
    example: PRIORITY_LABELS.MEDIUM,
    values: PRIORITIES.map((priority) => PRIORITY_LABELS[priority]),
  },
  {
    header: COLUMN_TITLES.progress,
    kind: "integer",
    required: false,
    description: "A whole number from 0 to 100. Leave it empty for 0 (100 when the status is Done).",
    example: "40",
  },
  {
    header: COLUMN_TITLES.contractor,
    kind: "text",
    required: false,
    description:
      "The villa's own contractor, by name or by phone. Leave it empty for none. Another contractor is refused.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.startDate,
    kind: "date",
    required: false,
    description: "A day written YYYY-MM-DD, or a date cell. Leave it empty if it is not known.",
    example: "2026-01-15",
  },
  {
    header: COLUMN_TITLES.endDate,
    kind: "date",
    required: false,
    description: "A day written YYYY-MM-DD, or a date cell, not before the start date.",
    example: "2026-02-15",
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries them is imported as it is: they are not read.
export const OPEN_WORK_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.location, kind: "text" },
  { header: COLUMN_TITLES.overdue, kind: "text" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Open works",
  plural: "open works",
  fileName: "open-works-import-template.xlsx",
  columns: OPEN_WORK_IMPORT_COLUMNS,
};

// A row that passed every check. A `contractorId` is the villa's contractor as the row was checked, which the insert makes sure
// it still is; the same for the phase, which was active.
export type OpenWorkRowInput = Omit<NewOpenWork, "createdById">;

// What a row is checked against: the villas and their contractors, and the electrical phases by name (with their status).
export type OpenWorkLookups = VillaLookups & {
  phases: ReferenceIndex;
  phaseStatus: ReadonlyMap<string, ElecPhaseStatusValue>;
};

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

export function parseOpenWorkRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: OpenWorkLookups,
): { value: OpenWorkRowInput | undefined; issues: RowParser["issues"]; skip?: true } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <T>(header: string, result: CellResult<T>): T | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    COLUMN_TITLES.villaNumber,
    textOrNumberCell(cell(COLUMN_TITLES.villaNumber), villaNumber, { required: true }),
  );
  const elecPhaseId = take(
    COLUMN_TITLES.elecPhase,
    referenceCell(cell(COLUMN_TITLES.elecPhase), lookups.phases, { required: true }),
  );
  const status = take(
    COLUMN_TITLES.status,
    enumCell(cell(COLUMN_TITLES.status), STATUS, { required: false }),
  );
  const priority = take(
    COLUMN_TITLES.priority,
    enumCell(cell(COLUMN_TITLES.priority), PRIORITY, { required: false }),
  );
  const progress = take(
    COLUMN_TITLES.progress,
    integerCell(cell(COLUMN_TITLES.progress), {
      required: false,
      min: 0,
      max: MAX_PROGRESS,
      key: "validation.progressInvalid",
    }),
  );
  const contractorCell = take(
    COLUMN_TITLES.contractor,
    textCell(cell(COLUMN_TITLES.contractor), contractorText, { required: false }),
  );
  const startDate = take(
    COLUMN_TITLES.startDate,
    dateCell(cell(COLUMN_TITLES.startDate), { required: false }),
  );
  const endDate = take(COLUMN_TITLES.endDate, dateCell(cell(COLUMN_TITLES.endDate), { required: false }));

  const villa = resolveVilla(
    parser.issues,
    lookups.villas,
    COLUMN_TITLES.villaNumber,
    villaText,
    cell(COLUMN_TITLES.villaNumber),
  );

  // A status and a progress that were both read must agree, by the API's own rule (an omitted one is implied, and one
  // that could not be read counts as omitted, so it cannot make a disagreement).
  const pair = startingPair({ status, progress });
  if (!statusAgreesWithProgress(pair.status, pair.progress)) {
    parser.issues.push({
      column: COLUMN_TITLES.status,
      code: "INVALID_VALUE",
      key: "validation.workStatusProgress",
      value: cell(COLUMN_TITLES.status),
    });
  }

  // A phase that is switched off cannot be given to a work (the API's rule: 409 ELEC_PHASE_INACTIVE).
  if (elecPhaseId !== undefined && lookups.phaseStatus.get(elecPhaseId) === "INACTIVE") {
    parser.issues.push({
      column: COLUMN_TITLES.elecPhase,
      code: "INVALID_VALUE",
      key: "errors.workElecPhaseInactive",
      value: cell(COLUMN_TITLES.elecPhase),
    });
  }

  if (startDate && endDate && endDate < startDate) {
    parser.issues.push({
      column: COLUMN_TITLES.endDate,
      code: "INVALID_VALUE",
      key: "validation.dateRangeInvalid",
      value: cell(COLUMN_TITLES.endDate),
    });
  }

  let contractorId: string | null = null;
  if (villa !== undefined && contractorCell !== undefined) {
    const outcome = checkVillaContractor(contractorCell, villa, lookups, "errors.workContractorInactive");
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

  if (!parser.ok || villa === undefined || elecPhaseId === undefined) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      elecPhaseId,
      status: pair.status,
      priority: priority ?? "MEDIUM",
      progress: pair.progress,
      contractorId,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
    },
    issues: [],
  };
}

export function openWorksImportDefinition(
  repository: OpenWorksRepository,
  actor: Actor,
  ctx: RequestContext,
): ImportDefinition<OpenWorkRowInput, OpenWorkLookups> {
  return {
    entity: "WorkItem",
    action: "open_work.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: OPEN_WORK_IMPORT_COLUMNS,
    ignoredColumns: OPEN_WORK_IGNORED_COLUMNS,
    // A villa has at most one open work per electrical phase: twice in the file, or one the villa already has, is refused.
    keyColumn: COLUMN_TITLES.elecPhase,
    duplicateInFileKey: "import.openWorkDuplicateInFile",
    duplicateExistingKey: "import.openWorkDuplicateExisting",
    keyOf: (row) => villaPhaseKey(row.villaId, row.elecPhaseId),
    findExisting: (rows, db) => repository.takenVillaPhases([...new Set(rows.map((row) => row.villaId))], db),

    loadLookups: async (db) => {
      const phases = await repository.importElecPhases(db);
      return {
        ...buildVillaLookups(await repository.importVillas(db), await repository.importContractors(db)),
        phases: buildReferenceIndex(phases),
        phaseStatus: new Map(phases.map((phase) => [phase.id, phase.status] as const)),
      };
    },

    parseRow: parseOpenWorkRow,

    insert: async (rows, db) => {
      // The villas first, shared and in the order of their ids (the lock order of shared/constants/locks.ts), so this
      // takes turns with a change of a villa's contractor. What the rows were checked against must still be true.
      const villaIds = [...new Set(rows.map((row) => row.villaId))].sort();
      const contractors = await repository.lockVillasShared(villaIds, db);
      for (const row of rows) {
        if (!contractors.has(row.villaId)) {
          throw importDataChanged(ctx);
        }
        if (row.contractorId !== null && contractors.get(row.villaId) !== row.contractorId) {
          throw importDataChanged(ctx);
        }
      }
      // Then the phases the rows are filed under, shared and in the order of their ids (the lock order: villa, then phase). One
      // that was deleted or switched off since the file was checked is a changed file.
      const phaseIds = [...new Set(rows.map((row) => row.elecPhaseId))].sort();
      const phases = await repository.lockElecPhasesShared(phaseIds, db);
      if (phaseIds.some((id) => phases.get(id) !== "ACTIVE")) {
        throw importDataChanged(ctx);
      }
      // Then each villa and phase, in a fixed order, as one open work at a time takes them: one added since the file was
      // checked makes it a changed file.
      const byPair = new Map(rows.map((row) => [villaPhaseKey(row.villaId, row.elecPhaseId), row] as const));
      const pairs = [...byPair.keys()].sort();
      for (const pair of pairs) {
        const row = byPair.get(pair)!;
        await repository.lockVillaPhase(row.villaId, row.elecPhaseId, db);
      }
      const taken = await repository.takenVillaPhases(villaIds, db);
      if (pairs.some((pair) => taken.has(pair))) {
        throw importDataChanged(ctx);
      }
      return repository.createMany(
        rows.map((row) => ({ ...row, createdById: actor.id })),
        db,
      );
    },
  };
}

export class OpenWorksImportService {
  // The import runs in the open works repository's transaction, so the module's own tests can roll it back.
  constructor(
    private readonly repository = new OpenWorksRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
  ) {}

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [villas, contractors, phases] = await Promise.all([
      this.repository.importVillas(),
      this.repository.importContractors(),
      this.repository.importElecPhases(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [COLUMN_TITLES.villaNumber]: villaNumberChoices(villas),
          // The active phases, in the order of the electrical phases page.
          [COLUMN_TITLES.elecPhase]: phases
            .filter((phase) => phase.status === "ACTIVE")
            .map((phase) => phase.name),
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
    return this.runner.run(openWorksImportDefinition(this.repository, actor, ctx), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }
}
