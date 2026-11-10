import type { PageMeta } from "../../../shared/query/pagination.js";

// In the order the database keeps them, which is the order a sort by status uses.
export const WORK_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "DELAYED", "DONE"] as const;
export type WorkStatusValue = (typeof WORK_STATUSES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type PriorityValue = (typeof PRIORITIES)[number];

// "location" is the villa's area, block and plot in natural order; "elecPhaseName" is the name of the item's electrical phase;
// the others are the item's own columns.
export const OPEN_WORK_SORT_FIELDS = [
  "location",
  "elecPhaseName",
  "status",
  "priority",
  "progress",
  "startDate",
  "endDate",
] as const;
export type OpenWorkSortField = (typeof OPEN_WORK_SORT_FIELDS)[number];

export function isOpenWorkSortField(value: string): value is OpenWorkSortField {
  return (OPEN_WORK_SORT_FIELDS as readonly string[]).includes(value);
}

export type OpenWorkSort = { field: OpenWorkSortField; direction: "asc" | "desc" };

// An open work has no title or name of its own. Wherever a person has to be told which one it is (the audit log), it is called by
// its electrical phase and its villa.
export const openWorkName = (phaseName: string, villaNumber: string): string =>
  `${phaseName} - ${villaNumber}`;

export type OpenWorkFilters = {
  villaId?: string | undefined;
  elecPhaseId?: string | undefined;
  status?: WorkStatusValue | undefined;
  priority?: PriorityValue | undefined;
  contractorId?: string | undefined;
  startFrom?: Date | undefined;
  startTo?: Date | undefined;
  endFrom?: Date | undefined;
  endTo?: Date | undefined;
  // True: the end date has passed and the work is not done. False: everything else.
  overdue?: boolean | undefined;
  // True: only the done works (DONE, at 100), the Done Works page. False: only the ones still open.
  done?: boolean | undefined;
  // Matches the villa number, the name of the electrical phase and the contractor's name.
  search?: string | undefined;
};

export type OpenWorkDto = {
  id: string;
  villa: { id: string; villaNumber: string; location: string };
  // The electrical phase the work is filed under. A villa has at most one open work per phase.
  elecPhase: { id: string; name: string };
  status: WorkStatusValue;
  priority: PriorityValue;
  progress: number;
  contractor: { id: string; name: string } | null;
  startDate: string | null;
  endDate: string | null;
  // The end date is before today (APP_TIMEZONE) and the work is not done.
  overdue: boolean;
  // How many days past the end date the work is; 0 when it is not overdue.
  overdueDays: number;
  createdBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type OpenWorkListResult = { items: OpenWorkDto[]; meta: PageMeta };

// What an audit entry records about an item.
export type OpenWorkSnapshot = {
  // How the work is called (see openWorkName), as it was when the entry was written: it names the work in the audit log after
  // the work is deleted.
  name: string;
  villaId: string;
  elecPhaseId: string;
  status: WorkStatusValue;
  priority: PriorityValue;
  progress: number;
  contractorId: string | null;
  startDate: string | null;
  endDate: string | null;
};
