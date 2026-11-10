import type { AlertWindow } from "../../../shared/utils/deadline.js";
import type { PageMeta } from "../../../shared/query/pagination.js";

// In the order the database keeps them.
export const SMALL_WORK_STATUSES = ["PENDING", "DONE"] as const;
export type SmallWorkStatusValue = (typeof SMALL_WORK_STATUSES)[number];

// The first and last day of the work, its villa's number, its contractor's name, the status and the time it was written.
export const SMALL_WORK_SORT_FIELDS = [
  "startDate",
  "endDate",
  "villaNumber",
  "contractorName",
  "status",
  "createdAt",
] as const;
export type SmallWorkSortField = (typeof SMALL_WORK_SORT_FIELDS)[number];

export function isSmallWorkSortField(value: string): value is SmallWorkSortField {
  return (SMALL_WORK_SORT_FIELDS as readonly string[]).includes(value);
}

export type SmallWorkSort = { field: SmallWorkSortField; direction: "asc" | "desc" };

export const MAX_DESCRIPTION_LENGTH = 500;
// The planned dates have no "too far ahead" rule, only this sane bound around today.
export const MAX_YEARS_AWAY = 10;

export type SmallWorkFilters = {
  villaId?: string | undefined;
  contractorId?: string | undefined;
  status?: SmallWorkStatusValue | undefined;
  startFrom?: Date | undefined;
  startTo?: Date | undefined;
  endFrom?: Date | undefined;
  endTo?: Date | undefined;
  // true: pending and past the deadline. false: everything else.
  overdue?: boolean | undefined;
  // true: pending, not overdue, and within the alert hours of the deadline. false: everything else.
  dueSoon?: boolean | undefined;
  // The two days the overdue and dueSoon filters compare endDate with (see shared/utils/deadline.ts). Set by the service
  // whenever one of those filters is.
  alert?: AlertWindow | undefined;
  // Matches the description, the contractor's name and the villa number.
  search?: string | undefined;
};

export type SmallWorkDto = {
  id: string;
  villa: { id: string; villaNumber: string; location: string };
  contractor: { id: string; name: string };
  // YYYY-MM-DD
  startDate: string;
  // YYYY-MM-DD: the last day of the work. The deadline is the end of this day in APP_TIMEZONE.
  endDate: string;
  // The instant the work becomes overdue (the start of the day after endDate in APP_TIMEZONE), as an ISO string.
  deadlineAt: string;
  // Derived from the status, the end date and the clock, never stored: the client does not compute them. Both are false for a
  // work that is DONE, and never both true.
  overdue: boolean;
  dueSoon: boolean;
  description: string;
  status: SmallWorkStatusValue;
  createdBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SmallWorkListResult = { items: SmallWorkDto[]; meta: PageMeta };

// What an audit entry records about a small work.
export type SmallWorkSnapshot = {
  villaId: string;
  contractorId: string;
  startDate: string;
  endDate: string;
  description: string;
  status: SmallWorkStatusValue;
};
