import type { PageMeta } from "../../../shared/query/pagination.js";

export const MAINTENANCE_SORT_FIELDS = ["handoverDate", "villaNumber", "createdAt", "solvedAt"] as const;
export type MaintenanceSortField = (typeof MAINTENANCE_SORT_FIELDS)[number];

export function isMaintenanceSortField(value: string): value is MaintenanceSortField {
  return (MAINTENANCE_SORT_FIELDS as readonly string[]).includes(value);
}

export type MaintenanceSort = { field: MaintenanceSortField; direction: "asc" | "desc" };

// A villa that needs maintenance. The villa number and the location are typed by hand: they are not linked to the
// villas list. `handoverDate` is YYYY-MM-DD. `solved` is true once someone checked it as solved (`solvedAt` is when).
export type MaintenanceDto = {
  id: string;
  villaNumber: string;
  location: string;
  handoverDate: string;
  issue: string;
  solved: boolean;
  solvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MaintenanceListResult = { items: MaintenanceDto[]; meta: PageMeta };
