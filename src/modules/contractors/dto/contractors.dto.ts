import type { PageMeta } from "../../../shared/query/pagination.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";

export const CONTRACTOR_SORT_FIELDS = ["name", "createdAt"] as const;
export type ContractorSortField = (typeof CONTRACTOR_SORT_FIELDS)[number];

export function isContractorSortField(value: string): value is ContractorSortField {
  return (CONTRACTOR_SORT_FIELDS as readonly string[]).includes(value);
}

export type ContractorSort = { field: ContractorSortField; direction: "asc" | "desc" };

// What the summary's villa list can be sorted by.
export const SUMMARY_SORT_FIELDS = ["villaNumber", "startDate", "targetDate"] as const;
export type SummarySortField = (typeof SUMMARY_SORT_FIELDS)[number];

export function isSummarySortField(value: string): value is SummarySortField {
  return (SUMMARY_SORT_FIELDS as readonly string[]).includes(value);
}

export type SummarySort = { field: SummarySortField; direction: "asc" | "desc" };

// The options list feeds select inputs. It is cut at this many entries so the response stays bounded.
export const MAX_OPTIONS = 1000;

export type ContractorDto = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: PartyStatusValue;
  villaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ContractorOptionDto = { id: string; name: string };

export type ContractorListResult = { items: ContractorDto[]; meta: PageMeta };

export type ContractorVillaDto = {
  id: string;
  villaNumber: string;
  area: string;
  block: string;
  plot: string;
  startDate: string | null;
  targetDate: string | null;
};

// The contractor's work in the other resources, counted through the contractor each record names (a villa's contractor, an open
// work's, a small work's, a daily report's, a labour row's). Each section is null when the viewer may not read that resource
// (open-works:read, small-works:read, daily-reports:read, daily-labour:read; an ADMIN may read all). A contractor with nothing
// has zeros and a null date, never a null section.
export type ContractorOpenWorksDto = {
  total: number;
  byStatus: { NOT_STARTED: number; IN_PROGRESS: number; DELAYED: number; DONE: number };
  // The same as byStatus.DELAYED.
  delayed: number;
  // An end date before today (UTC) and not done: the open works list's own rule.
  overdue: number;
};
export type ContractorSmallWorksDto = {
  total: number;
  pending: number;
  done: number;
  // Pending and past the deadline / within the alert hours of it (shared/utils/deadline.ts: the list's own rules).
  overdue: number;
  dueSoon: number;
};
export type ContractorDailyReportsDto = { count: number; lastReportDate: string | null };
export type ContractorLabourDto = {
  // The number of labour rows, the labourers added up over them, and the latest day.
  entries: number;
  totalLabour: number;
  lastLabourDate: string | null;
};

export type ContractorSummaryDto = {
  contractor: { id: string; name: string; phone: string };
  villaCount: number;
  openWorks: ContractorOpenWorksDto | null;
  smallWorks: ContractorSmallWorksDto | null;
  dailyReports: ContractorDailyReportsDto | null;
  labour: ContractorLabourDto | null;
  villas: ContractorVillaDto[];
};

// Which section needs which permission (an ADMIN holds them all).
export const SUMMARY_SECTION_PERMISSIONS = {
  openWorks: PERMISSIONS.OPEN_WORKS_READ,
  smallWorks: PERMISSIONS.SMALL_WORKS_READ,
  dailyReports: PERMISSIONS.DAILY_REPORTS_READ,
  labour: PERMISSIONS.DAILY_LABOUR_READ,
} as const;
export type SummarySection = keyof typeof SUMMARY_SECTION_PERMISSIONS;

export type ContractorSummaryResult = { summary: ContractorSummaryDto; meta: PageMeta };
