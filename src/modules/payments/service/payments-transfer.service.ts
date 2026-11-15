import { z } from "zod";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { prisma } from "../../../core/database/prisma.js";
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
import { formatDate } from "../../../shared/export/format.js";
import { writePdf } from "../../../shared/export/pdf.js";
import {
  CONTENT_TYPES,
  EXPORT_MAX_ROWS,
  type ExportColumn,
  type ExportDocument,
  type ExportFormat,
  type ExportRow,
  type ExportWriter,
} from "../../../shared/export/types.js";
import { writeXlsx } from "../../../shared/export/xlsx.js";
import {
  buildReferenceIndex,
  buildTemplate,
  buildVillaIndex,
  dateCell,
  decimalCell,
  enumCell,
  enumSpec,
  normalizeText,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  villaNumberChoices,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type RawCell,
  type ReferenceIndex,
  type TemplateSpec,
  type VillaIndex,
} from "../../../shared/import/index.js";
import { MAX_LIMIT } from "../../../shared/query/pagination.js";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type PaymentDto,
  type PaymentMethodValue,
  type PaymentStatusValue,
} from "../dto/payments.dto.js";
import { PaymentsRepository } from "../repository/payments.repository.js";
import { MAX_AMOUNT_MINOR, type ListPaymentsQuery } from "../validators/payments.validators.js";
import { PaymentsService } from "./payments.service.js";

const STATUS_LABELS: Record<PaymentStatusValue, string> = { PENDING: "Pending", PAID: "Paid" };
const METHOD_LABELS: Record<PaymentMethodValue, string> = {
  CASH: "Cash",
  CHEQUE: "Cheque",
  BANK_TRANSFER: "Bank transfer",
};

// The headers of the workbook and of the import: the same words, so an exported file can be imported again.
export const PAYMENT_TITLES = {
  contractor: "Contractor",
  villaNumber: "Villa Number",
  amount: "Amount (KWD)",
  status: "Status",
  dueDate: "Due Date",
  paidDate: "Paid Date",
  method: "Method",
  reference: "Reference",
  notes: "Notes",
  overdue: "Overdue",
  files: "Files",
  createdAt: "Created (UTC)",
} as const;

const T = PAYMENT_TITLES;
const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const toKwd = (minor: number): number => minor / 1000;

const COLUMNS: ExportColumn[] = [
  { key: T.contractor, title: T.contractor, kind: "text" },
  { key: T.villaNumber, title: T.villaNumber, kind: "text" },
  { key: T.amount, title: T.amount, kind: "decimal" },
  { key: T.status, title: T.status, kind: "text" },
  { key: T.dueDate, title: T.dueDate, kind: "date" },
  { key: T.paidDate, title: T.paidDate, kind: "date" },
  { key: T.method, title: T.method, kind: "text" },
  { key: T.reference, title: T.reference, kind: "text" },
  { key: T.notes, title: T.notes, kind: "text" },
  { key: T.overdue, title: T.overdue, kind: "text" },
  { key: T.files, title: T.files, kind: "text" },
  { key: T.createdAt, title: T.createdAt, kind: "datetime" },
];

// The PDF reads like a payments register: the contractor first, without the long notes.
const PDF_COLUMNS: ExportColumn[] = [
  { key: T.contractor, title: T.contractor, kind: "text" },
  { key: T.villaNumber, title: T.villaNumber, kind: "text" },
  { key: T.amount, title: T.amount, kind: "decimal" },
  { key: T.status, title: T.status, kind: "text" },
  { key: T.dueDate, title: T.dueDate, kind: "date" },
  { key: T.paidDate, title: T.paidDate, kind: "date" },
  { key: T.method, title: T.method, kind: "text" },
  { key: T.reference, title: T.reference, kind: "text" },
];

const paymentRow = (item: PaymentDto): ExportRow => ({
  [T.contractor]: item.contractor.name,
  [T.villaNumber]: item.villa?.villaNumber ?? "",
  [T.amount]: toKwd(item.amountMinor),
  [T.status]: STATUS_LABELS[item.status],
  [T.dueDate]: item.dueDate ? asDay(item.dueDate) : null,
  [T.paidDate]: item.paidDate ? asDay(item.paidDate) : null,
  [T.method]: item.method ? METHOD_LABELS[item.method] : "",
  [T.reference]: item.reference ?? "",
  [T.notes]: item.notes ?? "",
  [T.overdue]: item.overdue ? "Yes" : "No",
  [T.files]: item.files.map((file) => file.name).join(", ") || "None",
  [T.createdAt]: new Date(item.createdAt),
});

// The filters, one line each, for the top of the PDF.
function describe(query: Record<string, unknown>, names: Record<string, string>): string[] {
  return Object.entries(names)
    .filter(([key]) => query[key] !== undefined && query[key] !== "")
    .map(([key, label]) => `${label}: ${String(query[key])}`);
}

const tooLarge = (ctx: RequestContext): AppError =>
  new AppError(422, t(ctx.locale, "errors.exportTooLarge"), "EXPORT_TOO_LARGE");

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---- the import: one row per payment ----

const villaNumber = z.string().trim().min(1, { error: "validation.required" });
const name = z
  .string()
  .trim()
  .min(1, { error: "validation.required" })
  .max(200, { error: "validation.textLength" });
const reference = z.string().trim().max(100, { error: "validation.paymentReferenceLength" });
const notes = z.string().trim().max(2000, { error: "validation.paymentNotesLength" });
const STATUS = enumSpec(PAYMENT_STATUSES, STATUS_LABELS);
const METHOD = enumSpec(PAYMENT_METHODS, METHOD_LABELS);

export const PAYMENT_IMPORT_COLUMNS = [
  {
    header: T.contractor,
    kind: "text",
    required: true,
    description: "The contractor, exactly as in the Contractors list.",
    example: "Nile Builders",
  },
  {
    header: T.villaNumber,
    kind: "text",
    required: false,
    description:
      "The villa the payment is for, as it is in the system. Empty: a general payment to the contractor.",
    example: "EX-000",
  },
  {
    header: T.amount,
    kind: "decimal",
    required: true,
    description: "The amount in KWD, 0 or more, with at most three decimals.",
    example: "1250.500",
  },
  {
    header: T.status,
    kind: "text",
    required: false,
    description: "Pending or Paid. Empty: Pending.",
    example: "Pending",
  },
  {
    header: T.dueDate,
    kind: "date",
    required: false,
    description:
      "When it is due, written YYYY-MM-DD, or a date cell. A pending payment past it is reminded daily.",
    example: "2026-12-15",
  },
  {
    header: T.paidDate,
    kind: "date",
    required: false,
    description: "When it was paid (Paid only). Empty for a paid payment: the day of the import.",
    example: "",
  },
  {
    header: T.method,
    kind: "text",
    required: false,
    description: "Cash, Cheque or Bank transfer.",
    example: "Cheque",
  },
  {
    header: T.reference,
    kind: "text",
    required: false,
    description: "The cheque or transfer number, at most 100 characters.",
    example: "CHQ-2041",
  },
  {
    header: T.notes,
    kind: "text",
    required: false,
    description: "Anything else, at most 2000 characters.",
    example: "Second installment",
  },
] as const satisfies readonly ImportColumn[];

// What the workbook adds after those columns. A file that carries them is imported as it is: they are not read.
export const PAYMENT_IGNORED_COLUMNS = [
  { header: T.overdue, kind: "text" },
  { header: T.files, kind: "text" },
  { header: T.createdAt, kind: "datetime" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Payments",
  plural: "payments",
  fileName: "payments-import-template.xlsx",
  columns: PAYMENT_IMPORT_COLUMNS,
};

export type PaymentRowInput = {
  contractorId: string;
  villaId: string | null;
  amountMinor: number;
  status: PaymentStatusValue;
  dueDate: Date | null;
  paidDate: Date | null;
  method: PaymentMethodValue | null;
  reference: string | null;
  notes: string | null;
};

export type PaymentLookups = {
  contractors: ReferenceIndex;
  villas: VillaIndex<{ id: string; villaNumber: string }>;
  // The day of the import (APP_TIMEZONE): the paid date of a Paid row without one.
  today: Date;
};

export function parsePaymentRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: PaymentLookups,
): { value: PaymentRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <V>(header: string, result: CellResult<V>): V | undefined =>
    parser.take(header, cell(header), result);

  const contractorText = take(T.contractor, textCell(cell(T.contractor), name, { required: true }));
  const villaText = take(
    T.villaNumber,
    textOrNumberCell(cell(T.villaNumber), villaNumber, { required: false }),
  );
  const amount = take(
    T.amount,
    decimalCell(cell(T.amount), {
      required: true,
      scale: 3,
      max: MAX_AMOUNT_MINOR / 1000,
      key: "validation.paymentAmountInvalid",
    }),
  );
  const status = take(T.status, enumCell(cell(T.status), STATUS, { required: false })) ?? "PENDING";
  const dueDate = take(T.dueDate, dateCell(cell(T.dueDate), { required: false }));
  const paidDate = take(T.paidDate, dateCell(cell(T.paidDate), { required: false }));
  const method = take(T.method, enumCell(cell(T.method), METHOD, { required: false }));
  const ref = take(T.reference, textCell(cell(T.reference), reference, { required: false }));
  const note = take(T.notes, textCell(cell(T.notes), notes, { required: false }));

  let contractorId: string | undefined;
  if (contractorText !== undefined) {
    const found = lookups.contractors.get(normalizeText(contractorText)) ?? [];
    if (found.length === 1) contractorId = found[0];
    else {
      parser.issues.push({
        column: T.contractor,
        code: found.length === 0 ? "REFERENCE_NOT_FOUND" : "AMBIGUOUS_REFERENCE",
        key: found.length === 0 ? "import.contractorNotFound" : "import.referenceAmbiguous",
        value: cell(T.contractor),
      });
    }
  }
  const villa = resolveVilla(parser.issues, lookups.villas, T.villaNumber, villaText, cell(T.villaNumber));

  if (
    !parser.ok ||
    contractorId === undefined ||
    amount === undefined ||
    (villaText !== undefined && !villa)
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      contractorId,
      villaId: villa?.id ?? null,
      amountMinor: Math.round(amount * 1000),
      status,
      dueDate: dueDate ?? null,
      paidDate: status === "PAID" ? (paidDate ?? lookups.today) : null,
      method: method ?? null,
      reference: ref && ref.length > 0 ? ref : null,
      notes: note && note.length > 0 ? note : null,
    },
    issues: [],
  };
}

export function paymentsImportDefinition(
  repository: PaymentsRepository,
  today: Date,
): ImportDefinition<PaymentRowInput, PaymentLookups, false> {
  return {
    entity: "ContractorPayment",
    action: "payment.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: PAYMENT_IMPORT_COLUMNS,
    ignoredColumns: PAYMENT_IGNORED_COLUMNS,
    loadLookups: async (db) => ({
      contractors: buildReferenceIndex(await repository.importContractors(db)),
      villas: buildVillaIndex(await repository.importVillas(db)),
      today,
    }),
    parseRow: parsePaymentRow,
    insert: async (rows, db) => {
      const ids: string[] = [];
      for (const row of rows) {
        const created = await repository.create({ ...row, amountMinor: BigInt(row.amountMinor) }, db);
        ids.push(created.id);
      }
      return ids;
    },
  };
}

export class PaymentsTransferService {
  constructor(
    private readonly payments = new PaymentsService(),
    private readonly repository = new PaymentsRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
    private readonly writers: Record<ExportFormat, ExportWriter> = { xlsx: writeXlsx, pdf: writePdf },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Every payment of the filters, one row each, with the totals above the table.
  async exportPayments(format: ExportFormat, query: ListPaymentsQuery, actor: Actor, ctx: RequestContext) {
    const first = await this.payments.list({ ...query, page: 1, limit: MAX_LIMIT });
    if (first.meta.total > EXPORT_MAX_ROWS) throw tooLarge(ctx);
    const fetch = async (page: number) =>
      (await this.payments.list({ ...query, page, limit: MAX_LIMIT })).items;
    const kwd = (minor: number) => `${(minor / 1000).toFixed(3)} KWD`;
    const summary: [string, string][] = [
      ["Pending", kwd(first.totals.pendingMinor)],
      ["Of which overdue", kwd(first.totals.overdueMinor)],
      ["Paid", kwd(first.totals.paidMinor)],
    ];
    await prisma.$transaction((tx) =>
      audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "export.payments",
          entity: "ContractorPayment",
          after: { format, filters: query, rowCount: first.meta.total },
        }),
      ),
    );
    const generatedAt = this.now();
    const document: ExportDocument = {
      title: "Contractor payments",
      sheetName: "Payments",
      generatedAt,
      filters: describe(query, { search: "Search", status: "Status", overdue: "Overdue only" }),
      columns: format === "pdf" ? PDF_COLUMNS : COLUMNS,
      rows: this.pages(first.items, first.meta.total, fetch),
      summary,
    };
    const writer = this.writers[format];
    return {
      filename: `elecico-payments-${formatDate(generatedAt)}.${format}`,
      contentType: CONTENT_TYPES[format],
      write: (out: Parameters<ExportWriter>[1]) => writer(document, out),
    };
  }

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [contractors, villas] = await Promise.all([
      this.repository.importContractors(),
      this.repository.importVillas(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [T.contractor]: [...new Set(contractors.map((c) => c.name))].sort(),
          [T.villaNumber]: villaNumberChoices(villas),
          [T.status]: PAYMENT_STATUSES.map((value) => STATUS_LABELS[value]),
          [T.method]: PAYMENT_METHODS.map((value) => METHOD_LABELS[value]),
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
    return this.runner.run(paymentsImportDefinition(this.repository, asDay(this.payments.today())), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }

  // The rows, a page at a time; the loop lets the server handle other requests between pages.
  private async *pages(
    first: PaymentDto[],
    total: number,
    fetch: (page: number) => Promise<PaymentDto[]>,
  ): AsyncGenerator<ExportRow[]> {
    yield first.map(paymentRow);
    const pages = Math.ceil(total / MAX_LIMIT);
    for (let page = 2; page <= pages; page++) {
      await nextTick();
      const items = await fetch(page);
      if (items.length === 0) return;
      yield items.map(paymentRow);
    }
  }
}
