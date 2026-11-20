import type { CheckedRow, Db, ImportDefinition } from "../../../core/imports/index.js";
import {
  buildReferenceIndex,
  buildVillaIndex,
  dateCell,
  decimalCell,
  normalizeText,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  type CellIssue,
  type CellResult,
  type ImportColumn,
  type RawCell,
  type ReferenceIndex,
  type TemplateSpec,
  type VillaIndex,
} from "../../../shared/import/index.js";
import { z } from "zod";
import type { MonthlyProgressRepository } from "../repository/monthly-progress.repository.js";

// The headers of the template, in order.
export const PREVIOUS_PAYMENT_TITLES = {
  villaNumber: "Villa Number",
  paidOn: "Paid On",
  ratio: "Paid Up To (%)",
  amount: "Amount (KWD)",
  contractor: "Contractor",
  note: "Note",
} as const;

const T = PREVIOUS_PAYMENT_TITLES;

export const PREVIOUS_PAYMENT_IMPORT_COLUMNS = [
  {
    header: T.villaNumber,
    kind: "text",
    required: true,
    description: "The villa the payment was for, as it is in the system.",
    example: "EX-000",
  },
  {
    header: T.paidOn,
    kind: "date",
    required: true,
    description: "When it was paid, written YYYY-MM-DD, or a date cell. Not after today.",
    example: "2025-06-30",
  },
  {
    header: T.ratio,
    kind: "decimal",
    required: true,
    description:
      "The progress the payment paid up to, 0.1 to 100, one decimal. For each villa it must rise with the date, also against the payments already in the system.",
    example: "40",
  },
  {
    header: T.amount,
    kind: "decimal",
    required: true,
    description: "The amount actually paid in KWD, more than 0, with at most three decimals.",
    example: "4000.000",
  },
  {
    header: T.contractor,
    kind: "text",
    required: false,
    description: "The contractor paid, exactly as in the Contractors list. Empty: the villa's contractor.",
    example: "",
  },
  {
    header: T.note,
    kind: "text",
    required: false,
    description: "A receipt or cheque number, or anything else, at most 2000 characters.",
    example: "Cheque 88",
  },
] as const satisfies readonly ImportColumn[];

export const PREVIOUS_PAYMENT_TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Previous payments",
  plural: "previous payments",
  fileName: "previous-payments-import-template.xlsx",
  columns: PREVIOUS_PAYMENT_IMPORT_COLUMNS,
};

export type ImportVilla = {
  id: string;
  villaNumber: string;
  contractorId: string | null;
  workOrderMinor: bigint | null;
};

export type PreviousPaymentRow = {
  villaId: string;
  contractorId: string | null;
  paidOn: Date;
  ratioTenths: number;
  amountMinor: number;
  workOrderMinor: bigint;
  note: string | null;
};

export type PreviousPaymentLookups = {
  villas: VillaIndex<ImportVilla>;
  contractors: ReferenceIndex;
  // The day of the import (APP_TIMEZONE): no payment is after it.
  today: Date;
};

const villaNumber = z.string().trim().min(1, { error: "validation.required" });
const contractorName = z
  .string()
  .trim()
  .min(1, { error: "validation.required" })
  .max(200, { error: "validation.textLength" });
const note = z.string().trim().max(2000, { error: "validation.paymentNotesLength" });

export function parsePreviousPaymentRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: PreviousPaymentLookups,
): { value: PreviousPaymentRow | undefined; issues: CellIssue[] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <V>(header: string, result: CellResult<V>): V | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    T.villaNumber,
    textOrNumberCell(cell(T.villaNumber), villaNumber, { required: true }),
  );
  const paidOn = take(T.paidOn, dateCell(cell(T.paidOn), { required: true }));
  const ratio = take(
    T.ratio,
    decimalCell(cell(T.ratio), { required: true, scale: 1, max: 100, key: "validation.paidRatioInvalid" }),
  );
  const amount = take(
    T.amount,
    decimalCell(cell(T.amount), {
      required: true,
      scale: 3,
      max: 999_999_999.999,
      key: "validation.paymentAmountInvalid",
    }),
  );
  const contractorText = take(
    T.contractor,
    textCell(cell(T.contractor), contractorName, { required: false }),
  );
  const noteText = take(T.note, textCell(cell(T.note), note, { required: false }));

  if (paidOn !== undefined && paidOn.getTime() > lookups.today.getTime()) {
    parser.issues.push({
      column: T.paidOn,
      code: "INVALID_VALUE",
      key: "import.paidDateInFuture",
      value: cell(T.paidOn),
    });
  }
  const villa = resolveVilla(parser.issues, lookups.villas, T.villaNumber, villaText, cell(T.villaNumber));
  if (villa && villa.workOrderMinor === null) {
    parser.issues.push({
      column: T.villaNumber,
      code: "INVALID_VALUE",
      key: "import.villaWorkOrderMissing",
      value: cell(T.villaNumber),
    });
  }
  let contractorId: string | null | undefined = villa?.contractorId ?? null;
  if (contractorText !== undefined && contractorText.length > 0) {
    const found = lookups.contractors.get(normalizeText(contractorText)) ?? [];
    if (found.length === 1) contractorId = found[0];
    else {
      contractorId = undefined;
      parser.issues.push({
        column: T.contractor,
        code: found.length === 0 ? "REFERENCE_NOT_FOUND" : "AMBIGUOUS_REFERENCE",
        key: found.length === 0 ? "import.contractorNotFound" : "import.referenceAmbiguous",
        value: cell(T.contractor),
      });
    }
  }

  if (
    !parser.ok ||
    !villa ||
    villa.workOrderMinor === null ||
    paidOn === undefined ||
    ratio === undefined ||
    amount === undefined ||
    contractorId === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      contractorId,
      paidOn,
      ratioTenths: Math.round(ratio * 10),
      amountMinor: Math.round(amount * 1000),
      workOrderMinor: villa.workOrderMinor,
      note: noteText && noteText.length > 0 ? noteText : null,
    },
    issues: [],
  };
}

type Placed = { time: number; ratioTenths: number; stored: boolean; entry?: CheckedRow<PreviousPaymentRow> };

/**
 * For each villa, the payments by date (those already stored and the file's together) must pay up to more and more: a
 * row whose ratio is not more than the payment before it, or not less than the one after it, is an error. On the same
 * day a stored payment comes first, and the file's rows go by their ratio.
 */
export async function checkPaymentOrder(
  entries: readonly CheckedRow<PreviousPaymentRow>[],
  stored: (villaIds: string[], db: Db) => Promise<{ villaId: string; ratioTenths: number; paidAt: Date }[]>,
  db: Db,
): Promise<{ row: number; issue: CellIssue }[]> {
  const byVilla = new Map<string, Placed[]>();
  for (const entry of entries) {
    const list = byVilla.get(entry.value.villaId) ?? [];
    list.push({
      time: entry.value.paidOn.getTime(),
      ratioTenths: entry.value.ratioTenths,
      stored: false,
      entry,
    });
    byVilla.set(entry.value.villaId, list);
  }
  for (const payment of await stored([...byVilla.keys()], db)) {
    byVilla
      .get(payment.villaId)
      ?.push({ time: payment.paidAt.getTime(), ratioTenths: payment.ratioTenths, stored: true });
  }
  const out: { row: number; issue: CellIssue }[] = [];
  for (const list of byVilla.values()) {
    list.sort(
      (a, b) => a.time - b.time || Number(b.stored) - Number(a.stored) || a.ratioTenths - b.ratioTenths,
    );
    list.forEach((item, index) => {
      if (!item.entry) return;
      const before = list[index - 1];
      const after = list[index + 1];
      if (
        (before && item.ratioTenths <= before.ratioTenths) ||
        (after && item.ratioTenths >= after.ratioTenths)
      ) {
        out.push({
          row: item.entry.row,
          issue: {
            column: T.ratio,
            code: "INVALID_VALUE",
            key: "import.paidRatioOutOfOrder",
            value: item.entry.cells[T.ratio] ?? null,
          },
        });
      }
    });
  }
  return out;
}

export function previousPaymentsImportDefinition(
  repository: MonthlyProgressRepository,
  today: Date,
  actorId: string,
): ImportDefinition<PreviousPaymentRow, PreviousPaymentLookups, false> {
  return {
    entity: "ProgressPayment",
    action: "progress_payment.import",
    sheetName: PREVIOUS_PAYMENT_TEMPLATE.sheetName,
    plural: PREVIOUS_PAYMENT_TEMPLATE.plural,
    fileName: PREVIOUS_PAYMENT_TEMPLATE.fileName,
    columns: PREVIOUS_PAYMENT_IMPORT_COLUMNS,
    loadLookups: async (db) => ({
      villas: buildVillaIndex(await repository.importVillas(db)),
      contractors: buildReferenceIndex(await repository.importContractors(db)),
      today,
    }),
    parseRow: parsePreviousPaymentRow,
    checkRows: (entries, db) => checkPaymentOrder(entries, (ids, tx) => repository.storedRatios(ids, tx), db),
    insert: async (rows, db) => {
      const ids: string[] = [];
      for (const row of rows) {
        const created = await repository.createPayment(
          {
            villaId: row.villaId,
            contractorId: row.contractorId,
            ratioTenths: row.ratioTenths,
            amountMinor: BigInt(row.amountMinor),
            workOrderMinor: row.workOrderMinor,
            paidById: actorId,
            paidAt: row.paidOn,
            manual: true,
            note: row.note,
          },
          db,
        );
        ids.push(created.id);
      }
      return ids;
    },
  };
}
