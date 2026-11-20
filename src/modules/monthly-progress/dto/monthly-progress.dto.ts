import type { PageMeta } from "../../../shared/query/pagination.js";

export const MONTHLY_PROGRESS_SORT_FIELDS = ["villaNumber", "current", "unpaid", "due"] as const;
export type MonthlyProgressSortField = (typeof MONTHLY_PROGRESS_SORT_FIELDS)[number];

export function isMonthlyProgressSortField(value: string): value is MonthlyProgressSortField {
  return (MONTHLY_PROGRESS_SORT_FIELDS as readonly string[]).includes(value);
}

export type MonthlyProgressSort = { field: MonthlyProgressSortField; direction: "asc" | "desc" };

// A payment to a villa's contractor for its progress. `ratio` is the progress paid up to (0 to 100, one decimal).
export type ProgressPaymentDto = {
  id: string;
  ratio: number;
  amountMinor: number;
  workOrderMinor: number;
  paidAt: string;
  contractor: { id: string; name: string } | null;
  paidBy: { id: string; name: string } | null;
  // Entered by hand (a payment made before the system).
  manual: boolean;
  note: string | null;
};

// One payment in a villa's payment history: also the progress it was paid from (the payment before it's, 0 for the
// first).
export type VillaPaymentHistoryItemDto = ProgressPaymentDto & { fromRatio: number };

// A villa's payments together, and where the villa stands now.
export type VillaPaymentHistorySummaryDto = {
  count: number;
  // KWD fils, every payment together.
  totalPaidMinor: number;
  // The progress paid up to (the latest payment's), 0 without one.
  paidProgress: number;
  currentProgress: number;
  unpaidProgress: number;
  // KWD fils; null when not entered on the Villa Budget.
  workOrderMinor: number | null;
  // What the contractor is owed now, KWD fils.
  dueMinor: number;
};

export type VillaPaymentHistoryDto = {
  villaNumber: string;
  items: VillaPaymentHistoryItemDto[];
  summary: VillaPaymentHistorySummaryDto;
};

// One villa on the Monthly Payments page: its progress now and when its open works last changed, its last payment, and
// what its contractor is owed now: the progress since that payment times the Work Order Value.
export type MonthlyProgressItemDto = {
  villa: { id: string; villaNumber: string; location: string };
  contractor: { id: string; name: string } | null;
  // 0 to 100, one decimal, from the villa's open works as they are now.
  currentProgress: number;
  // When one of its open works last changed; null when it has none.
  lastUpdatedAt: string | null;
  lastPayment: ProgressPaymentDto | null;
  // The progress paid up to (the last payment's), 0 without one.
  paidProgress: number;
  // The progress not paid yet: current minus paid, never below 0.
  unpaidProgress: number;
  // The villa's Work Order Value, KWD fils; null when not entered on its Villa Budget.
  workOrderMinor: number | null;
  // What the contractor is owed now: the unpaid progress times the Work Order Value, KWD fils; 0 without one.
  dueMinor: number;
};

// One contractor: its villas with something owed, and the total.
export type MonthlyContractorDueDto = {
  contractor: { id: string; name: string } | null;
  villaCount: number;
  dueMinor: number;
};

// Across every villa the filters match (not only this page).
export type MonthlyProgressSummaryDto = {
  villaCount: number;
  // Villas with unpaid progress, and what is owed for them all together.
  owedCount: number;
  totalDueMinor: number;
  // Villas with unpaid progress but no Work Order Value: nothing can be worked out for them until it is entered.
  missingWorkOrderCount: number;
  // Each contractor with something owed, the most first (the villas without a contractor together, last).
  contractors: MonthlyContractorDueDto[];
};

export type MonthlyProgressResult = {
  items: MonthlyProgressItemDto[];
  meta: PageMeta;
  summary: MonthlyProgressSummaryDto;
};
