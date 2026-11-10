import {
  IMPORT_TRANSACTION_TIMEOUT_MS,
  ImportBatchRepository,
  ImportRunner,
  type ImportDefinition,
  type ImportOutcome,
} from "../../../core/imports/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { PARTY_STATUSES, type PartyStatusValue } from "../../../shared/constants/enums.js";
import { COLUMN_TITLES, PARTY_STATUS_LABELS } from "../../../shared/export/labels.js";
import {
  enumCell,
  enumSpec,
  joinKey,
  normalizePhone,
  normalizeText,
  RowParser,
  textCell,
  type IgnoredColumn,
  type ImportColumn,
} from "../../../shared/import/index.js";
import { contactEmail, name, phone } from "../../../shared/validation/fields.js";
import { ContractorsRepository } from "../repository/contractors.repository.js";

type ContractorRowInput = { name: string; phone: string; email: string | null; status: PartyStatusValue };

// The columns of the file, in the order of the template and of the export. `Status` takes the code or the label, in any case.
const STATUS_LABELS = PARTY_STATUSES.map((status) => PARTY_STATUS_LABELS[status]);
const STATUS = enumSpec(PARTY_STATUSES, PARTY_STATUS_LABELS);

export const CONTRACTOR_IMPORT_COLUMNS = [
  {
    header: COLUMN_TITLES.name,
    kind: "text",
    required: true,
    description: "The contractor's name, up to 100 characters.",
    example: "Example Contracting Co.",
  },
  {
    header: COLUMN_TITLES.phone,
    kind: "text",
    required: true,
    description: "5 to 20 characters: digits, spaces and dashes, with an optional + at the start.",
    example: "0100 123 4567",
  },
  {
    header: COLUMN_TITLES.email,
    kind: "text",
    required: false,
    description: "A contact email address. Leave it empty if there is none.",
    example: "info@example.com",
  },
  {
    header: COLUMN_TITLES.status,
    kind: "text",
    required: false,
    description: "Leave it empty for Active.",
    example: "Active",
    values: STATUS_LABELS,
  },
] as const satisfies readonly ImportColumn[];

// What the export adds after those columns. A file that carries them is imported as it is; they are not read.
export const CONTRACTOR_IGNORED_COLUMNS = [
  { header: COLUMN_TITLES.villaCount, kind: "integer" },
  { header: COLUMN_TITLES.createdAt, kind: "datetime" },
] as const satisfies readonly IgnoredColumn[];

// A contractor is the same contractor when the name and the phone are the same, ignoring case, extra spaces, and the
// spaces and dashes in the phone. (The table has no unique key: this rule is only for imports.)
export const contractorKey = (row: Pick<ContractorRowInput, "name" | "phone">): string =>
  joinKey(normalizeText(row.name), normalizePhone(row.phone));

export function contractorImportDefinition(
  repository: ContractorsRepository,
): ImportDefinition<ContractorRowInput> {
  return {
    entity: "Contractor",
    action: "contractor.import",
    sheetName: "Contractors",
    plural: "contractors",
    fileName: "contractors-import-template.xlsx",
    columns: CONTRACTOR_IMPORT_COLUMNS,
    ignoredColumns: CONTRACTOR_IGNORED_COLUMNS,
    keyColumn: COLUMN_TITLES.name,
    duplicateInFileKey: "import.contractorDuplicateInFile",
    duplicateExistingKey: "import.contractorDuplicateExisting",
    loadLookups: () => Promise.resolve(undefined),

    parseRow: (cells) => {
      const cell = (header: string) => cells[header] ?? null;
      const parser = new RowParser();
      const parsedName = parser.take(
        COLUMN_TITLES.name,
        cell(COLUMN_TITLES.name),
        textCell(cell(COLUMN_TITLES.name), name, { required: true }),
      );
      const parsedPhone = parser.take(
        COLUMN_TITLES.phone,
        cell(COLUMN_TITLES.phone),
        textCell(cell(COLUMN_TITLES.phone), phone, { required: true }),
      );
      const parsedEmail = parser.take(
        COLUMN_TITLES.email,
        cell(COLUMN_TITLES.email),
        textCell(cell(COLUMN_TITLES.email), contactEmail, { required: false }),
      );
      const parsedStatus = parser.take(
        COLUMN_TITLES.status,
        cell(COLUMN_TITLES.status),
        enumCell(cell(COLUMN_TITLES.status), STATUS, { required: false }),
      );
      if (!parser.ok || parsedName === undefined || parsedPhone === undefined) {
        return { value: undefined, issues: parser.issues };
      }
      return {
        value: {
          name: parsedName,
          phone: parsedPhone,
          email: parsedEmail ?? null,
          status: parsedStatus ?? "ACTIVE",
        },
        issues: [],
      };
    },

    keyOf: contractorKey,

    findExisting: async (rows, db) => {
      const names = [...new Set(rows.map((row) => normalizeText(row.name)))];
      const stored = await repository.findByNormalizedNames(names, db);
      return new Set(stored.map(contractorKey));
    },

    insert: (rows, db) => repository.createMany(rows, db),
  };
}

export class ContractorsImportService {
  private readonly definition: ImportDefinition<ContractorRowInput>;

  // The import runs in the contractors repository's transaction, so the module's own tests can roll it back.
  constructor(
    repository = new ContractorsRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
  ) {
    this.definition = contractorImportDefinition(repository);
  }

  template(): Promise<{ fileName: string; bytes: Buffer }> {
    return this.runner.template(this.definition);
  }

  importFile(
    actor: Actor,
    file: { name: string; bytes: Buffer },
    dryRun: boolean,
    ctx: RequestContext,
  ): Promise<ImportOutcome> {
    return this.runner.run(this.definition, { file, dryRun, actor, ctx });
  }
}
