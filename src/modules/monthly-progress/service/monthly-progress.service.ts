import { audit, withMeta } from "../../../core/audit/audit.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import {
  MONTHLY_PROGRESS_SORT_FIELDS,
  isMonthlyProgressSortField,
  type MonthlyContractorDueDto,
  type MonthlyProgressItemDto,
  type MonthlyProgressResult,
  type MonthlyProgressSort,
  type MonthlyProgressSortField,
  type ProgressPaymentDto,
  type VillaPaymentHistoryDto,
  type VillaPaymentHistoryItemDto,
} from "../dto/monthly-progress.dto.js";
import { MonthlyProgressRepository, type PaymentRow } from "../repository/monthly-progress.repository.js";
import type { ManualPaymentBody, MonthlyProgressQuery } from "../validators/monthly-progress.validators.js";
import { ProgressHistory } from "./progress-history-cache.js";
import {
  PREVIOUS_PAYMENT_TEMPLATE,
  PREVIOUS_PAYMENT_TITLES,
  previousPaymentsImportDefinition,
} from "./previous-payments-import.js";
import {
  IMPORT_TRANSACTION_TIMEOUT_MS,
  ImportBatchRepository,
  ImportRunner,
  type ImportOutcome,
} from "../../../core/imports/index.js";
import { buildTemplate, villaNumberChoices } from "../../../shared/import/index.js";
import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { type DeadlinePolicy, zoneToday } from "../../../shared/utils/deadline.js";
import { formatDate } from "../../../shared/export/format.js";
import {
  CONTENT_TYPES,
  type ExportDocument,
  type ExportRow,
  type ExportWriter,
} from "../../../shared/export/types.js";
import { writeXlsx as writeXlsxFile } from "../../../shared/export/xlsx.js";

// A file ready to send: its name and type, and how to write it.
export type PreparedExport = {
  filename: string;
  contentType: string;
  write: (out: Parameters<ExportWriter>[1]) => Promise<{ rows: number }>;
};

const H = {
  paidAt: "Paid At (UTC)",
  contractor: "Contractor",
  from: "From (%)",
  to: "To (%)",
  covered: "Progress Covered (%)",
  amount: "Amount (KWD)",
  workOrder: "Work Order Value (KWD)",
  paidBy: "Recorded By",
} as const;

const HISTORY_COLUMNS = [
  { key: H.paidAt, title: H.paidAt, kind: "datetime" },
  { key: H.contractor, title: H.contractor, kind: "text" },
  { key: H.from, title: H.from, kind: "decimal" },
  { key: H.to, title: H.to, kind: "decimal" },
  { key: H.covered, title: H.covered, kind: "decimal" },
  { key: H.amount, title: H.amount, kind: "decimal" },
  { key: H.workOrder, title: H.workOrder, kind: "decimal" },
  { key: H.paidBy, title: H.paidBy, kind: "text" },
] as const satisfies ExportDocument["columns"];

const historyRow = (item: VillaPaymentHistoryItemDto): ExportRow => ({
  [H.paidAt]: new Date(item.paidAt),
  [H.contractor]: item.contractor?.name ?? "No contractor",
  [H.from]: item.fromRatio,
  [H.to]: item.ratio,
  [H.covered]: Math.round((item.ratio - item.fromRatio) * 10) / 10,
  [H.amount]: item.amountMinor / 1000,
  [H.workOrder]: item.workOrderMinor / 1000,
  [H.paidBy]: item.paidBy?.name ?? "",
});

const DEFAULT_SORT: MonthlyProgressSort = { field: "villaNumber", direction: "asc" };

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const nothingToPay = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.nothingToPay"), "NOTHING_TO_PAY");
const workOrderMissing = (ctx: RequestContext) =>
  new AppError(422, t(ctx.locale, "errors.workOrderMissing"), "WORK_ORDER_MISSING");
const paymentNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.progressPaymentNotFound"), "PROGRESS_PAYMENT_NOT_FOUND");
const contractorNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.contractorNotFound"), "CONTRACTOR_NOT_FOUND");
const paidDateInFuture = (ctx: RequestContext) =>
  new AppError(422, t(ctx.locale, "errors.paidDateInFuture"), "PAID_DATE_IN_FUTURE");
// The message names the ratios the payment has to fit between.
const ratioMessage = (ctx: RequestContext, from: number, to: number | null): string =>
  to === null
    ? t(ctx.locale, "errors.paidRatioAfter").replace("{{from}}", String(from))
    : t(ctx.locale, "errors.paidRatioBetween")
        .replace("{{from}}", String(from))
        .replace("{{to}}", String(to));
const ratioOutOfOrder = (ctx: RequestContext, from: number, to: number | null) =>
  new AppError(409, ratioMessage(ctx, from, to), "PAID_RATIO_OUT_OF_ORDER");
const notLatest = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.progressPaymentNotLatest"), "PROGRESS_PAYMENT_NOT_LATEST");

// YYYY-MM of the month after / before `month`.
export function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// One decimal, halves up.
const round1 = (value: number): number => Math.round(value * 10) / 10;

// Natural order of villa numbers ("V-2" before "V-10").
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// The unpaid progress times the Work Order Value, rounded to the fils.
export const dueOf = (unpaidProgress: number, workOrderMinor: number | null): number =>
  workOrderMinor === null || unpaidProgress <= 0 ? 0 : Math.round((workOrderMinor * unpaidProgress) / 100);

export function toPaymentDto(row: PaymentRow): ProgressPaymentDto {
  return {
    id: row.id,
    ratio: row.ratioTenths / 10,
    amountMinor: Number(row.amountMinor),
    workOrderMinor: Number(row.workOrderMinor),
    paidAt: row.paidAt.toISOString(),
    contractor: row.contractor,
    paidBy: row.paidBy,
    manual: row.manual,
    note: row.note,
  };
}

function valueOf(
  item: MonthlyProgressItemDto,
  field: Exclude<MonthlyProgressSortField, "villaNumber">,
): number {
  if (field === "current") return item.currentProgress;
  return field === "unpaid" ? item.unpaidProgress : item.dueMinor;
}

function compare(a: MonthlyProgressItemDto, b: MonthlyProgressItemDto, sort: MonthlyProgressSort): number {
  const byNumber = collator.compare(a.villa.villaNumber, b.villa.villaNumber);
  if (sort.field === "villaNumber") return sort.direction === "asc" ? byNumber : -byNumber;
  const diff = (valueOf(a, sort.field) - valueOf(b, sort.field)) * (sort.direction === "asc" ? 1 : -1);
  return diff !== 0 ? diff : byNumber;
}

// Each contractor with something owed, the most first; the villas with no contractor together, last.
function contractorDues(items: readonly MonthlyProgressItemDto[]): MonthlyContractorDueDto[] {
  const byContractor = new Map<string, MonthlyContractorDueDto>();
  for (const item of items) {
    if (item.unpaidProgress <= 0) continue;
    const key = item.contractor?.id ?? "";
    const entry = byContractor.get(key) ?? { contractor: item.contractor, villaCount: 0, dueMinor: 0 };
    entry.villaCount += 1;
    entry.dueMinor += item.dueMinor;
    byContractor.set(key, entry);
  }
  return [...byContractor.values()].sort((a, b) => {
    if (!a.contractor !== !b.contractor) return a.contractor ? -1 : 1;
    return b.dueMinor - a.dueMinor || collator.compare(a.contractor?.name ?? "", b.contractor?.name ?? "");
  });
}

export class MonthlyProgressService {
  constructor(
    private readonly repository = new MonthlyProgressRepository(),
    private readonly history = new ProgressHistory(repository),
    private readonly writeXlsx: ExportWriter = writeXlsxFile,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: Pick<DeadlinePolicy, "timeZone"> = envDeadlinePolicy(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
  ) {}

  // The Excel template for payments made before the system, with the villas and the contractors to choose from.
  async importTemplate(): Promise<{ fileName: string; bytes: Buffer }> {
    const [villas, contractors] = await Promise.all([
      this.repository.importVillas(),
      this.repository.importContractors(),
    ]);
    return {
      fileName: PREVIOUS_PAYMENT_TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...PREVIOUS_PAYMENT_TEMPLATE,
        lists: {
          [PREVIOUS_PAYMENT_TITLES.villaNumber]: villaNumberChoices(villas),
          [PREVIOUS_PAYMENT_TITLES.contractor]: [...new Set(contractors.map((c) => c.name))].sort(),
        },
      }),
    };
  }

  // Imports payments made before the system, for any villas, from an Excel file: each is entered like one added by hand.
  importPrevious(
    actor: Actor,
    file: { name: string; bytes: Buffer },
    dryRun: boolean,
    ctx: RequestContext,
  ): Promise<ImportOutcome> {
    const today = zoneToday(this.now(), this.policy.timeZone);
    return this.runner.run(previousPaymentsImportDefinition(this.repository, today, actor.id), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }

  // Every villa with its progress now, its last payment and what its contractor is owed now (the progress since that
  // payment times the Work Order Value); searched, filtered, sorted and paged, with the totals over the filters.
  async list(query: MonthlyProgressQuery): Promise<MonthlyProgressResult> {
    const [villas, current, payments, updates] = await Promise.all([
      this.repository.villas(),
      this.history.current(),
      this.repository.latestPayments(),
      this.repository.lastUpdates(),
    ]);

    const term = query.search?.toLocaleLowerCase();
    const all: MonthlyProgressItemDto[] = [];
    for (const villa of villas) {
      if (query.contractorId && villa.contractor?.id !== query.contractorId) continue;
      const location = locationOf(villa.area.name, villa.block, villa.plot);
      if (
        term &&
        ![villa.villaNumber, location, villa.contractor?.name ?? ""].some((text) =>
          text.toLocaleLowerCase().includes(term),
        )
      ) {
        continue;
      }
      const currentProgress = round1(current.get(villa.id) ?? 0);
      const payment = payments.get(villa.id);
      const paidProgress = payment ? payment.ratioTenths / 10 : 0;
      const unpaidProgress = Math.max(0, round1(currentProgress - paidProgress));
      if (query.owed && unpaidProgress <= 0) continue;
      const workOrder = villa.finance?.workOrderMinor;
      const workOrderMinor = workOrder === null || workOrder === undefined ? null : Number(workOrder);
      all.push({
        villa: { id: villa.id, villaNumber: villa.villaNumber, location },
        contractor: villa.contractor,
        currentProgress,
        lastUpdatedAt: updates.get(villa.id)?.toISOString() ?? null,
        lastPayment: payment ? toPaymentDto(payment) : null,
        paidProgress,
        unpaidProgress,
        workOrderMinor,
        dueMinor: dueOf(unpaidProgress, workOrderMinor),
      });
    }

    const requested = parseSort(query.sort, MONTHLY_PROGRESS_SORT_FIELDS);
    const sort: MonthlyProgressSort =
      requested && isMonthlyProgressSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    all.sort((a, b) => compare(a, b, sort));

    const { page, limit, skip, take } = toPagination(query);
    const owed = all.filter((item) => item.unpaidProgress > 0);
    return {
      items: all.slice(skip, skip + take),
      meta: buildMeta(page, limit, all.length),
      summary: {
        villaCount: all.length,
        owedCount: owed.length,
        totalDueMinor: owed.reduce((sum, item) => sum + item.dueMinor, 0),
        missingWorkOrderCount: owed.filter((item) => item.workOrderMinor === null).length,
        contractors: contractorDues(all),
      },
    };
  }

  // A villa's payments, the latest first, each with the progress it was paid from and up to; and where the villa stands
  // now: its progress, the part not paid yet and what that is worth.
  async villaHistory(villaId: string, ctx: RequestContext): Promise<VillaPaymentHistoryDto> {
    const villa = await this.repository.villaForHistory(villaId);
    if (!villa) throw villaNotFound(ctx);
    const workOrder = villa.workOrderMinor;
    const [rows, current] = await Promise.all([
      this.repository.paymentsOfVilla(villaId),
      this.history.current(),
    ]);
    const items = rows.map((row, index) => ({
      ...toPaymentDto(row),
      fromRatio: (rows[index + 1]?.ratioTenths ?? 0) / 10,
    }));
    const currentProgress = round1(current.get(villaId) ?? 0);
    const paidProgress = items[0]?.ratio ?? 0;
    const unpaidProgress = Math.max(0, round1(currentProgress - paidProgress));
    const workOrderMinor = workOrder === null ? null : Number(workOrder);
    return {
      villaNumber: villa.villaNumber,
      items,
      summary: {
        count: items.length,
        totalPaidMinor: items.reduce((sum, item) => sum + item.amountMinor, 0),
        paidProgress,
        currentProgress,
        unpaidProgress,
        workOrderMinor,
        dueMinor: dueOf(unpaidProgress, workOrderMinor),
      },
    };
  }

  // The villa's payment history as a workbook: one row per payment, the latest first, with where the villa stands now
  // above the table. Audited before the file is made.
  async exportVillaHistory(villaId: string, actor: Actor, ctx: RequestContext): Promise<PreparedExport> {
    const history = await this.villaHistory(villaId, ctx);
    const { summary } = history;
    await this.repository.transaction((tx) =>
      audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "export.progress-payments",
          entity: "Villa",
          entityId: villaId,
          after: { format: "xlsx", villaNumber: history.villaNumber, rowCount: history.items.length },
        }),
      ),
    );
    const generatedAt = this.now();
    const kwd = (minor: number | null) =>
      minor === null ? "Not entered" : `${(minor / 1000).toFixed(3)} KWD`;
    const document: ExportDocument = {
      title: `Payment history, villa ${history.villaNumber}`,
      sheetName: "Payments",
      generatedAt,
      filters: [`Villa Number: ${history.villaNumber}`],
      summary: [
        ["Villa Number", history.villaNumber],
        ["Work Order Value", kwd(summary.workOrderMinor)],
        ["Progress now", `${summary.currentProgress}%`],
        ["Paid up to", `${summary.paidProgress}%`],
        ["Owed now", kwd(summary.dueMinor)],
        ["Payments", String(summary.count)],
        ["Total paid", kwd(summary.totalPaidMinor)],
      ],
      columns: HISTORY_COLUMNS,
      rows: (async function* () {
        yield history.items.map(historyRow);
      })(),
    };
    const safeNumber = history.villaNumber.replace(/[^A-Za-z0-9_-]+/g, "_");
    return {
      filename: `elecico-payment-history-${safeNumber}-${formatDate(generatedAt)}.xlsx`,
      contentType: CONTENT_TYPES.xlsx,
      write: (out) => this.writeXlsx(document, out),
    };
  }

  // Pays the villa's contractor what it is owed now: the progress since the last payment times the Work Order Value.
  // The payment records the progress paid up to, so the next amount due starts from it. The villa is locked, so two
  // payments of it take turns and the second finds nothing left to pay.
  async pay(actor: Actor, villaId: string, ctx: RequestContext): Promise<ProgressPaymentDto> {
    const row = await this.repository.transaction(async (tx) => {
      const villa = await this.repository.lockVillaForPayment(villaId, tx);
      if (!villa) throw villaNotFound(ctx);
      if (villa.workOrderMinor === null) throw workOrderMissing(ctx);
      const current = round1((await this.history.current()).get(villaId) ?? 0);
      const last = await this.repository.latestPayment(villaId, tx);
      const paid = last ? last.ratioTenths / 10 : 0;
      const unpaid = round1(current - paid);
      if (unpaid <= 0) throw nothingToPay(ctx);
      const workOrderMinor = Number(villa.workOrderMinor);
      const created = await this.repository.createPayment(
        {
          villaId,
          contractorId: villa.contractorId,
          ratioTenths: Math.round(current * 10),
          amountMinor: BigInt(dueOf(unpaid, workOrderMinor)),
          workOrderMinor: villa.workOrderMinor,
          paidById: actor.id,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "progress_payment.create",
          entity: "Villa",
          entityId: villaId,
          after: {
            villaNumber: villa.villaNumber,
            fromRatio: paid,
            toRatio: current,
            amountMinor: Number(created.amountMinor),
            workOrderMinor,
            contractor: created.contractor?.name ?? null,
          },
        }),
      );
      return created;
    });
    return toPaymentDto(row);
  }

  // Enters a payment made before the system: its day (not after today), the progress it paid up to and the amount paid.
  // By date it must fit between the villa's payments: more than the one before it, less than the one after it.
  async addManual(
    actor: Actor,
    villaId: string,
    body: ManualPaymentBody,
    ctx: RequestContext,
  ): Promise<ProgressPaymentDto> {
    if (body.paidOn.getTime() > zoneToday(this.now(), this.policy.timeZone).getTime())
      throw paidDateInFuture(ctx);
    const ratioTenths = Math.round(body.ratio * 10);
    const row = await this.repository.transaction(async (tx) => {
      const villa = await this.repository.lockVillaForPayment(villaId, tx);
      if (!villa) throw villaNotFound(ctx);
      if (villa.workOrderMinor === null) throw workOrderMissing(ctx);
      let contractorId = villa.contractorId;
      if (body.contractorId !== undefined) {
        if (body.contractorId !== null && !(await this.repository.contractorExists(body.contractorId, tx))) {
          throw contractorNotFound(ctx);
        }
        contractorId = body.contractorId;
      }
      const { before, after } = await this.repository.neighbours(villaId, body.paidOn, tx);
      const from = before?.ratioTenths ?? 0;
      if (ratioTenths <= from || (after && ratioTenths >= after.ratioTenths)) {
        throw ratioOutOfOrder(ctx, from / 10, after ? after.ratioTenths / 10 : null);
      }
      const created = await this.repository.createPayment(
        {
          villaId,
          contractorId,
          ratioTenths,
          amountMinor: BigInt(body.amountMinor),
          workOrderMinor: villa.workOrderMinor,
          paidById: actor.id,
          paidAt: body.paidOn,
          manual: true,
          note: body.note ?? null,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "progress_payment.create",
          entity: "Villa",
          entityId: villaId,
          after: {
            villaNumber: villa.villaNumber,
            manual: true,
            paidOn: body.paidOn.toISOString().slice(0, 10),
            fromRatio: from / 10,
            toRatio: ratioTenths / 10,
            amountMinor: body.amountMinor,
            contractor: created.contractor?.name ?? null,
            note: body.note ?? null,
          },
        }),
      );
      return created;
    });
    return toPaymentDto(row);
  }

  // Takes back a villa's latest payment (one recorded by mistake); an older one is not, or the amounts after it would be
  // wrong.
  async undo(actor: Actor, id: string, ctx: RequestContext): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const payment = await this.repository.findPayment(id, tx);
      if (!payment) throw paymentNotFound(ctx);
      const villa = await this.repository.lockVillaForPayment(payment.villaId, tx);
      if (!villa) throw paymentNotFound(ctx);
      const latest = await this.repository.latestPayment(payment.villaId, tx);
      // A payment entered by hand may be removed at any time; one the system recorded only while it is the latest.
      if (!payment.manual && latest?.id !== id) throw notLatest(ctx);
      await this.repository.deletePayment(id, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "progress_payment.delete",
          entity: "Villa",
          entityId: payment.villaId,
          before: {
            villaNumber: villa.villaNumber,
            toRatio: payment.ratioTenths / 10,
            amountMinor: Number(payment.amountMinor),
            paidAt: payment.paidAt.toISOString(),
          },
        }),
      );
    });
  }
}
