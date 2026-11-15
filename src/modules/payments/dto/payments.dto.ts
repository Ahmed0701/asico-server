import type { PageMeta } from "../../../shared/query/pagination.js";

export const PAYMENT_STATUSES = ["PENDING", "PAID"] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["CASH", "CHEQUE", "BANK_TRANSFER"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_SORT_FIELDS = ["createdAt", "dueDate", "paidDate", "amount", "villaNumber"] as const;
export type PaymentSortField = (typeof PAYMENT_SORT_FIELDS)[number];

export function isPaymentSortField(value: string): value is PaymentSortField {
  return (PAYMENT_SORT_FIELDS as readonly string[]).includes(value);
}

export type PaymentSort = { field: PaymentSortField; direction: "asc" | "desc" };

// Receipts and invoices of one payment, at most.
export const MAX_PAYMENT_FILES = 10;

export type PaymentFileDto = {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedAt: string;
};

// A payment to a contractor. `amountMinor` is KWD fils (1 KWD = 1000). Dates are YYYY-MM-DD. `overdue` is true for a
// PENDING payment whose due date is before today (APP_TIMEZONE); such a payment is reminded once a day.
export type PaymentDto = {
  id: string;
  contractor: { id: string; name: string };
  villa: { id: string; villaNumber: string; location: string } | null;
  amountMinor: number;
  status: PaymentStatusValue;
  dueDate: string | null;
  paidDate: string | null;
  method: PaymentMethodValue | null;
  reference: string | null;
  notes: string | null;
  overdue: boolean;
  files: PaymentFileDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

// The amounts of every payment the filters match (not only this page): what is still to pay, of which overdue, and paid.
export type PaymentTotalsDto = {
  pendingMinor: number;
  overdueMinor: number;
  paidMinor: number;
};

export type PaymentListResult = { items: PaymentDto[]; meta: PageMeta; totals: PaymentTotalsDto };
