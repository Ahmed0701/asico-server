import type { PageMeta } from "../../../shared/query/pagination.js";

export const MONTHLY_PROGRESS_SORT_FIELDS = ["villaNumber", "previous", "current", "change"] as const;
export type MonthlyProgressSortField = (typeof MONTHLY_PROGRESS_SORT_FIELDS)[number];

export function isMonthlyProgressSortField(value: string): value is MonthlyProgressSortField {
  return (MONTHLY_PROGRESS_SORT_FIELDS as readonly string[]).includes(value);
}

export type MonthlyProgressSort = { field: MonthlyProgressSortField; direction: "asc" | "desc" };

// One villa: its overall progress (0 to 100) at the end of the month before (null: the villa did not exist yet) and at
// the end of the month asked for (now, for the current month), and the difference.
export type MonthlyProgressItemDto = {
  villa: { id: string; villaNumber: string; location: string };
  contractor: { id: string; name: string } | null;
  previousProgress: number | null;
  currentProgress: number;
  change: number;
};

// Across every villa the filters match (not only this page). The averages are over the villas in each column.
export type MonthlyProgressSummaryDto = {
  // YYYY-MM: the month asked for, and the one before.
  month: string;
  previousMonth: string;
  // Whether `month` is the current month (APP_TIMEZONE): its figures are as of now.
  isCurrentMonth: boolean;
  villaCount: number;
  averagePrevious: number;
  averageCurrent: number;
  averageChange: number;
  // How many villas moved forward in the month, and how many did not move.
  improvedCount: number;
  unchangedCount: number;
};

export type MonthlyProgressResult = {
  items: MonthlyProgressItemDto[];
  meta: PageMeta;
  summary: MonthlyProgressSummaryDto;
};
