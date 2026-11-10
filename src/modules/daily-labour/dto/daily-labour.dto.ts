import type { PageMeta } from "../../../shared/query/pagination.js";

// The day, the villa's number, the contractor's name, the number of workers and the time the row was written.
export const DAILY_LABOUR_SORT_FIELDS = [
  "labourDate",
  "villaNumber",
  "contractorName",
  "labourCount",
  "createdAt",
] as const;
export type DailyLabourSortField = (typeof DAILY_LABOUR_SORT_FIELDS)[number];

export function isDailyLabourSortField(value: string): value is DailyLabourSortField {
  return (DAILY_LABOUR_SORT_FIELDS as readonly string[]).includes(value);
}

export type DailyLabourSort = { field: DailyLabourSortField; direction: "asc" | "desc" };

export const MAX_LABOUR_COUNT = 100_000;
// The longest "notes". The import accepts as many characters per cell (the default cell limit is larger).
export const MAX_LABOUR_NOTES_LENGTH = 500;

export type DailyLabourFilters = {
  villaId?: string | undefined;
  contractorId?: string | undefined;
  labourFrom?: Date | undefined;
  labourTo?: Date | undefined;
  // Matches the villa number, the contractor's name and the notes.
  search?: string | undefined;
};

export type DailyLabourDto = {
  id: string;
  villa: { id: string; villaNumber: string; location: string };
  // YYYY-MM-DD
  labourDate: string;
  contractor: { id: string; name: string };
  labourCount: number;
  notes: string | null;
  createdBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DailyLabourListResult = { items: DailyLabourDto[]; meta: PageMeta };

// What an audit entry records about a labour row.
export type DailyLabourSnapshot = {
  villaId: string;
  labourDate: string;
  contractorId: string;
  labourCount: number;
  notes: string | null;
};
