import type { PageMeta } from "../../../shared/query/pagination.js";

// In the order the database keeps them.
export const SITE_REPORT_TYPES = ["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"] as const;
export type SiteReportTypeValue = (typeof SITE_REPORT_TYPES)[number];

// The day of the visit, its villa's number, the type, the rating and the time it was written.
export const SITE_REPORT_SORT_FIELDS = ["visitDate", "villaNumber", "rating", "type", "createdAt"] as const;
export type SiteReportSortField = (typeof SITE_REPORT_SORT_FIELDS)[number];

export function isSiteReportSortField(value: string): value is SiteReportSortField {
  return (SITE_REPORT_SORT_FIELDS as readonly string[]).includes(value);
}

export type SiteReportSort = { field: SiteReportSortField; direction: "asc" | "desc" };

export const MAX_TITLE_LENGTH = 150;
export const MAX_INSPECTOR_LENGTH = 100;
// The longest "findings" and "recommendations". The import accepts as many characters per cell (IMPORT_LONG_TEXT_CELL_CHARS).
export const MAX_REPORT_TEXT_LENGTH = 5000;
export const MIN_RATING = 1;
export const MAX_RATING = 5;

export type SiteReportFilters = {
  villaId?: string | undefined;
  type?: SiteReportTypeValue | undefined;
  rating?: number | undefined;
  visitFrom?: Date | undefined;
  visitTo?: Date | undefined;
  // Matches the title, the inspector and the villa number.
  search?: string | undefined;
};

export type SiteReportDto = {
  id: string;
  villa: { id: string; villaNumber: string; location: string };
  // YYYY-MM-DD
  visitDate: string;
  title: string;
  inspector: string;
  type: SiteReportTypeValue;
  // 1 to 5
  rating: number;
  findings: string;
  recommendations: string | null;
  createdBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SiteReportListResult = { items: SiteReportDto[]; meta: PageMeta };

// What an audit entry records about a site report.
export type SiteReportSnapshot = {
  villaId: string;
  visitDate: string;
  title: string;
  inspector: string;
  type: SiteReportTypeValue;
  rating: number;
  findings: string;
  recommendations: string | null;
};
