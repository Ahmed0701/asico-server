import type { PageMeta } from "../../../shared/query/pagination.js";

export const OVERHEAD_SORT_FIELDS = ["name", "role", "salary", "createdAt"] as const;
export type OverheadSortField = (typeof OVERHEAD_SORT_FIELDS)[number];

// The roles picked from the list (the page shows each in the reader's language).
export const OVERHEAD_ROLES = ["ENGINEER", "FOREMAN", "WORKER", "DRIVER", "OTHER"] as const;
export type OverheadRole = (typeof OVERHEAD_ROLES)[number];

export type OverheadSort = { field: OverheadSortField; direction: "asc" | "desc" };

// An employee of the department's overhead. `salaryMinor` is the monthly salary in KWD fils (1 KWD = 1000).
export type OverheadEmployeeDto = {
  id: string;
  name: string;
  role: OverheadRole;
  salaryMinor: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

// Over every employee the search matches (not only this page): how many, and their monthly salaries added up.
export type OverheadTotalsDto = {
  count: number;
  monthlySalaryMinor: number;
};

export type OverheadListResult = { items: OverheadEmployeeDto[]; meta: PageMeta; totals: OverheadTotalsDto };
