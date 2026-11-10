import type { AuditLogListItemDto } from "../../audit/index.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";

// Bounds that keep the response small however much data there is.
export const TOP_AREAS = 50;
export const TOP_CONTRACTORS = 10;
// "Upcoming" looks this far ahead of the start of today (UTC).
export const UPCOMING_DAYS = 30;
// "Last 7 days" is today and the six days before it: the window the daily figures add up over.
export const LAST_DAYS = 7;
export const RECENT_DEFAULT_LIMIT = 20;
// How many urgent small works the dashboard lists.
export const URGENT_SMALL_WORKS = 5;
// How many overdue open works the dashboard lists.
export const OVERDUE_OPEN_WORKS = 5;
export const RECENT_MAX_LIMIT = 50;

// The cards of the dashboard and what each one needs. dashboard:read opens the endpoint; a card is worked out only
// for a user who holds EVERY permission listed here (an ADMIN holds them all), and is null in the answer otherwise.
// The villas card is villas, progress, overdue, upcoming, mewFollowUp, mewInspection and byArea: they are figures about
// the villas.
export const CARD_PERMISSIONS = {
  villas: [PERMISSIONS.VILLAS_READ],
  topContractors: [PERMISSIONS.VILLAS_READ, PERMISSIONS.CONTRACTORS_READ],
  openWorks: [PERMISSIONS.OPEN_WORKS_READ],
  dailyReports: [PERMISSIONS.DAILY_REPORTS_READ],
  smallWorks: [PERMISSIONS.SMALL_WORKS_READ],
  delayedSmallWorks: [PERMISSIONS.SMALL_WORKS_READ],
  siteReports: [PERMISSIONS.SITE_REPORTS_READ],
  labour: [PERMISSIONS.DAILY_LABOUR_READ],
  totalLabour: [PERMISSIONS.DAILY_REPORTS_READ],
  maintenance: [PERMISSIONS.MAINTENANCE_READ],
} as const satisfies Record<string, readonly Permission[]>;

export type DashboardCard = keyof typeof CARD_PERMISSIONS;

export type AreaCountsDto = { areaId: string; area: string; city: string; total: number };
export type ContractorCountsDto = { id: string; name: string; total: number };

// A day's figure and the figure over the last 7 days (today included).
export type DailyFiguresDto = { today: number; last7Days: number };

// Pending small works that are overdue or due soon (the same rules as notifications and smallWorks.dueSoon / overdue).
export type DelayedSmallWorksDto = { overdue: number; dueSoon: number };

// An open work past its end date and not done. `endDate` is YYYY-MM-DD; `overdueDays` the whole days since it.
export type OverdueOpenWorkDto = {
  id: string;
  villa: { id: string; villaNumber: string };
  elecPhase: { name: string };
  contractor: { name: string } | null;
  endDate: string;
  overdueDays: number;
};

// A pending small work that is overdue or due soon. `endDate` is YYYY-MM-DD; `deadlineAt` the instant it becomes overdue.
export type UrgentSmallWorkDto = {
  id: string;
  villa: { id: string; villaNumber: string };
  description: string;
  contractor: { id: string; name: string };
  endDate: string;
  deadlineAt: string;
  alert: "overdue" | "dueSoon";
};

// A global overview: the figures are not filtered by who is asking, only by what they may see. Every key is always
// present. A key is null when the user lacks the permission of its card (see CARD_PERMISSIONS), and then its queries are
// not run. A card with nothing to count is NOT null: it holds zeros (and an empty list, and a null average).
// "Today" is the UTC day, like every date in the API: a site on another time zone sees its evening counted under the next day.
export type DashboardSummaryDto = {
  // The villas card (villas:read): villas, progress, overdue, upcoming, mewFollowUp, mewInspection and byArea.
  villas: { total: number } | null;
  // Derived on read from the phase progress. A villa is not started when it is at 0 in every active phase, done when
  // it is at 100 in every one of them (and there is at least one), in progress otherwise. The three add up to the
  // total. `average` is the mean of the villas' overall progress, with one decimal (0 with no villas or phases).
  progress: { average: number; notStarted: number; inProgress: number; done: number } | null;
  // Overdue and upcoming look at the target date of every villa.
  overdue: { count: number } | null;
  upcoming: { count: number } | null;
  // Villas on the MEW follow-up list (put there by a person).
  mewFollowUp: { count: number } | null;
  // Villas on the MEW inspection list that have not passed it yet (the MEW inspection page's list).
  mewInspection: { count: number } | null;
  byArea: AreaCountsDto[] | null;
  // Villas and contractors (villas:read and contractors:read): the busiest contractors by number of villas.
  topContractors: ContractorCountsDto[] | null;
  // Open works (open-works:read). `total` is all of them, whatever the status (it is the sum of byStatus); `delayed` is the ones
  // whose status is DELAYED (the same number as byStatus.DELAYED). Overdue is the open-works list's own rule: an end date
  // before today (APP_TIMEZONE), and not done. `overdueList` is up to 5 of those, the earliest end date first.
  openWorks: {
    total: number;
    delayed: number;
    byStatus: { NOT_STARTED: number; IN_PROGRESS: number; DELAYED: number; DONE: number };
    overdue: number;
    overdueList: OverdueOpenWorkDto[];
  } | null;
  // Daily reports (daily-reports:read): how many were written for today, and for the last 7 days.
  dailyReports: DailyFiguresDto | null;
  // Daily small works (small-works:read): all of them (`total`, whatever the status), the ones still pending, over all time; how
  // many of those are due soon and overdue (see docs/frontend-contract.md); and up to 5 of the most urgent of the latter two,
  // earliest end date first.
  smallWorks: {
    total: number;
    pending: number;
    dueSoon: number;
    overdue: number;
    urgent: UrgentSmallWorkDto[];
  } | null;
  // Site reports (site-reports:read): over all time. The average has one decimal and is null when there is no report.
  siteReports: { count: number; averageRating: number | null } | null;
  // Daily labour (daily-labour:read): the number of labourers, added up over the rows of today and of the last 7 days.
  labour: DailyFiguresDto | null;
  // Total labour (daily-reports:read): the workers count added up over every labour daily report, all time.
  totalLabour: { total: number } | null;
  // Delayed small works (small-works:read): pending works that are overdue or due soon (APP_TIMEZONE and
  // SMALL_WORKS_ALERT_HOURS_BEFORE, same as notifications). Not the open-works DELAYED status.
  delayedSmallWorks: DelayedSmallWorksDto | null;
  // Maintenance villas (maintenance:read): the ones still open, and the ones checked as solved.
  maintenance: { open: number; solved: number } | null;
  generatedAt: string;
};

export type RecentActivityDto = AuditLogListItemDto;

// The day boundaries the counters compare against: target dates before `today` are overdue; dates from
// `today` up to (not including) `until` are upcoming. A villa due today is therefore upcoming. `weekStart` is the first day
// of the last-7-days window, which ends with `today`.
export type DayRange = { today: Date; until: Date; weekStart: Date };
