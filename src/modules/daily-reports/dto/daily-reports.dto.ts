import type { PageMeta } from "../../../shared/query/pagination.js";

// In the order the database keeps them.
export const WEATHERS = ["HOT", "SUNNY", "WINDY", "RAINY", "DUSTY"] as const;
export type WeatherValue = (typeof WEATHERS)[number];

// The report's date, its contractor's name, the name of the electrical engineer who prepared it, the weather and the time it
// was written.
export const DAILY_REPORT_SORT_FIELDS = [
  "reportDate",
  "contractorName",
  "preparedByName",
  "weather",
  "createdAt",
] as const;
export type DailyReportSortField = (typeof DAILY_REPORT_SORT_FIELDS)[number];

export function isDailyReportSortField(value: string): value is DailyReportSortField {
  return (DAILY_REPORT_SORT_FIELDS as readonly string[]).includes(value);
}

export type DailyReportSort = { field: DailyReportSortField; direction: "asc" | "desc" };

export const MAX_WORKERS = 100_000;
// The longest "notes". The import accepts as many characters per cell (IMPORT_LONG_TEXT_CELL_CHARS).
export const MAX_REPORT_TEXT_LENGTH = 5000;

export type DailyReportFilters = {
  contractorId?: string | undefined;
  preparedByEngineerId?: string | undefined;
  weather?: WeatherValue | undefined;
  reportFrom?: Date | undefined;
  reportTo?: Date | undefined;
  // Matches the notes.
  search?: string | undefined;
};

export type DailyReportDto = {
  id: string;
  // YYYY-MM-DD
  reportDate: string;
  weather: WeatherValue;
  workersCount: number;
  notes: string | null;
  contractor: { id: string; name: string };
  // The electrical engineer who prepared the report.
  preparedBy: { id: string; name: string };
  createdBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DailyReportListResult = { items: DailyReportDto[]; meta: PageMeta };

// What an audit entry records about a report.
export type DailyReportSnapshot = {
  reportDate: string;
  weather: WeatherValue;
  workersCount: number;
  notes: string | null;
  contractorId: string;
  preparedByEngineerId: string;
};
