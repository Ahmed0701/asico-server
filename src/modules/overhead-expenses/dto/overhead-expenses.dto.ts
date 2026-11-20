import type { PageMeta } from "../../../shared/query/pagination.js";

// What an additional expense is: picked from the list (the page shows each in the reader's language).
export const EXPENSE_TYPES = ["INVOICE", "PURCHASE", "TRANSPORT", "OTHER"] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const EXPENSE_SORT_FIELDS = ["expenseDate", "amount", "villaNumber", "createdAt"] as const;
export type ExpenseSortField = (typeof EXPENSE_SORT_FIELDS)[number];
export type ExpenseSort = { field: ExpenseSortField; direction: "asc" | "desc" };

// At most this many invoice files on one expense.
export const MAX_EXPENSE_FILES = 10;

export type ExpenseFileDto = {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedAt: string;
};

// An additional expense of the department for one villa. `amountMinor` is KWD fils (1 KWD = 1000); `expenseDate` is
// YYYY-MM-DD.
export type OverheadExpenseDto = {
  id: string;
  villa: { id: string; villaNumber: string };
  type: ExpenseType;
  description: string;
  amountMinor: number;
  expenseDate: string;
  invoiceNumber: string | null;
  files: ExpenseFileDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

// Over every expense the filters match (not only this page): how many, and their amounts added up.
export type OverheadExpenseTotalsDto = {
  count: number;
  amountMinor: number;
};

export type OverheadExpenseListResult = {
  items: OverheadExpenseDto[];
  meta: PageMeta;
  totals: OverheadExpenseTotalsDto;
};
