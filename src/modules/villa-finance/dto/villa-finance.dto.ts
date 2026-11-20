import type { PageMeta } from "../../../shared/query/pagination.js";

// The money of a villa (the Villa Budget card, the Projects Budgets page). Amounts are minor units: KWD fils
// (1 KWD = 1000), null when not entered.
export type VillaFinanceDto = {
  villaId: string;
  // The villa's own budget and its currency.
  budgetMinor: number | null;
  currency: string | null;
  // Every variation order of the villa added up (pending and paid), KWD fils; 0 when it has none.
  variationOrdersMinor: number;
  // The budget plus the variation orders; null when there is neither, or the budget is not in KWD.
  totalBudgetMinor: number | null;
  workOrderMinor: number | null;
  // The villa's share of the Department Overhead monthly salaries, in hundredths of a percent (2500 = 25%); null: none.
  salaryShareBp: number | null;
  // The Department Overhead monthly salaries added up (every employee): what the share is a part of.
  overheadSalariesMinor: number;
  // The villa's salaries: its share of the overhead salaries, rounded to the fils; null without a share.
  salariesMinor: number | null;
  materialsMinor: number | null;
  pettyCashMinor: number | null;
  // The villa's additional expenses (invoices and others, entered on the Department Overhead page) added up; 0 when none.
  expensesMinor: number;
  // The five above added up (the ones not entered count as 0).
  totalCostsMinor: number;
  // The total budget minus the costs; null when there is no total budget. Negative when over budget.
  remainingMinor: number | null;
  // The version of the finance row (0 before anything was saved): what the save's If-Match carries.
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
};

// A villa on the Projects Budgets page: its figures and where it is.
export type VillaFinanceListItemDto = VillaFinanceDto & {
  villa: { id: string; villaNumber: string; location: string };
};

// Over every villa the search matches (not only this page), the KWD ones: what the budgets, variation orders and costs
// add up to, and how many villas are over their total budget.
export type VillaFinanceSummaryDto = {
  villaCount: number;
  budgetMinor: number;
  variationOrdersMinor: number;
  totalBudgetMinor: number;
  totalCostsMinor: number;
  remainingMinor: number;
  overBudgetCount: number;
  // The Department Overhead monthly salaries, and how much of them is given to villas (every villa, not only the
  // search), in hundredths of a percent.
  overheadSalariesMinor: number;
  allocatedShareBp: number;
};

export const VILLA_FINANCE_SORT_FIELDS = ["villaNumber", "totalBudget", "totalCosts", "remaining"] as const;
export type VillaFinanceSortField = (typeof VILLA_FINANCE_SORT_FIELDS)[number];

export type VillaFinanceListResult = {
  items: VillaFinanceListItemDto[];
  meta: PageMeta;
  summary: VillaFinanceSummaryDto;
};
