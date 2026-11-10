import type { LocaleCode } from "../../../shared/constants/enums.js";
import { toDay } from "../../../shared/utils/day.js";
import { deadlineState, type AlertWindow, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { toListItemDto } from "../../audit/index.js";
import { averageProgress } from "../../villa-progress/dto/villa-progress.dto.js";
import type {
  AreaCountsDto,
  ContractorCountsDto,
  DailyFiguresDto,
  DashboardSummaryDto,
  OverdueOpenWorkDto,
  RecentActivityDto,
  UrgentSmallWorkDto,
} from "../dto/dashboard.dto.js";
import type {
  AreaCountRow,
  ContractorCountRow,
  DailyCounterRow,
  LabourCounterRow,
  MaintenanceCounterRow,
  OpenWorkCounterRow,
  OverdueOpenWorkRow,
  ProgressCounterRow,
  SiteReportCounterRow,
  SmallWorkCounterRow,
  UrgentSmallWorkRow,
  VillaCounterRow,
  RecentAuditRow,
} from "../repository/dashboard.repository.js";

const toNumber = (value: bigint | number): number => Number(value);

export function toAreaDto(row: AreaCountRow): AreaCountsDto {
  return { areaId: row.areaId, area: row.area, city: row.city, total: toNumber(row.total) };
}

export function toContractorDto(row: ContractorCountRow): ContractorCountsDto {
  return { id: row.id, name: row.name, total: toNumber(row.total) };
}

// What the service read for one request: a card is null when the user may not see it, and was not read.
export type SummaryParts = {
  villas: { counters: VillaCounterRow; progress: ProgressCounterRow; areas: AreaCountRow[] } | null;
  contractors: ContractorCountRow[] | null;
  openWorks: { counters: OpenWorkCounterRow; overdueList: OverdueOpenWorkRow[] } | null;
  dailyReports: DailyCounterRow | null;
  smallWorks: { counters: SmallWorkCounterRow; urgent: UrgentSmallWorkRow[] } | null;
  delayedSmallWorks: { counters: SmallWorkCounterRow } | null;
  siteReports: SiteReportCounterRow | null;
  labour: LabourCounterRow | null;
  totalLabour: { total: bigint | number } | null;
  maintenance: MaintenanceCounterRow | null;
};

const toDaily = (row: DailyCounterRow): DailyFiguresDto => ({
  today: toNumber(row.today),
  last7Days: toNumber(row.last7Days),
});

// The rows are all pending and end before the window's horizon: overdue when they end before today, else due soon.
function toUrgentDto(
  row: UrgentSmallWorkRow,
  window: AlertWindow,
  policy: DeadlinePolicy,
): UrgentSmallWorkDto {
  const endDate = toDay(row.endDate);
  const state = deadlineState(endDate, true, window, policy);
  return {
    id: row.id,
    villa: { id: row.villaId, villaNumber: row.villaNumber },
    description: row.description,
    contractor: { id: row.contractorId, name: row.contractorName },
    endDate,
    deadlineAt: state.deadlineAt.toISOString(),
    alert: state.overdue ? "overdue" : "dueSoon",
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// `today` is the APP_TIMEZONE day as YYYY-MM-DD; every row ends before it.
function toOverdueOpenWorkDto(row: OverdueOpenWorkRow, today: string): OverdueOpenWorkDto {
  const endDate = toDay(row.endDate);
  return {
    id: row.id,
    villa: { id: row.villaId, villaNumber: row.villaNumber },
    elecPhase: { name: row.phaseName },
    contractor: row.contractorName === null ? null : { name: row.contractorName },
    endDate,
    overdueDays: Math.round(
      (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${endDate}T00:00:00.000Z`)) / DAY_MS,
    ),
  };
}

export function toSummaryDto(
  parts: SummaryParts,
  generatedAt: Date,
  deadline: { window: AlertWindow; policy: DeadlinePolicy },
): DashboardSummaryDto {
  const { villas, openWorks, siteReports } = parts;
  return {
    villas: villas && { total: toNumber(villas.counters.total) },
    progress: villas && {
      // The mean of the villas' overall progress.
      average: averageProgress(toNumber(villas.progress.progressSum), toNumber(villas.counters.total)),
      notStarted: toNumber(villas.progress.notStarted),
      inProgress: toNumber(villas.progress.inProgress),
      done: toNumber(villas.progress.done),
    },
    overdue: villas && { count: toNumber(villas.counters.overdue) },
    upcoming: villas && { count: toNumber(villas.counters.upcoming) },
    mewFollowUp: villas && { count: toNumber(villas.counters.mewFollowUp) },
    mewInspection: villas && { count: toNumber(villas.counters.mewInspection) },
    byArea: villas && villas.areas.map(toAreaDto),
    topContractors: parts.contractors && parts.contractors.map(toContractorDto),
    openWorks: openWorks && {
      total: toNumber(openWorks.counters.total),
      delayed: toNumber(openWorks.counters.delayed),
      byStatus: {
        NOT_STARTED: toNumber(openWorks.counters.notStarted),
        IN_PROGRESS: toNumber(openWorks.counters.inProgress),
        DELAYED: toNumber(openWorks.counters.delayed),
        DONE: toNumber(openWorks.counters.done),
      },
      overdue: toNumber(openWorks.counters.overdue),
      // The open works and the small works share APP_TIMEZONE's today.
      overdueList: openWorks.overdueList.map((row) => toOverdueOpenWorkDto(row, deadline.window.today)),
    },
    dailyReports: parts.dailyReports && toDaily(parts.dailyReports),
    smallWorks: parts.smallWorks && {
      total: toNumber(parts.smallWorks.counters.total),
      pending: toNumber(parts.smallWorks.counters.pending),
      dueSoon: toNumber(parts.smallWorks.counters.dueSoon),
      overdue: toNumber(parts.smallWorks.counters.overdue),
      urgent: parts.smallWorks.urgent.map((row) => toUrgentDto(row, deadline.window, deadline.policy)),
    },
    siteReports: siteReports && {
      count: toNumber(siteReports.total),
      // One decimal, halves rounding up, by whole-number maths (the helper the progress average uses). No report, no average.
      averageRating:
        toNumber(siteReports.total) === 0
          ? null
          : averageProgress(toNumber(siteReports.ratingSum), toNumber(siteReports.total)),
    },
    labour: parts.labour && toDaily(parts.labour),
    totalLabour: parts.totalLabour && { total: toNumber(parts.totalLabour.total) },
    delayedSmallWorks: parts.delayedSmallWorks && {
      overdue: toNumber(parts.delayedSmallWorks.counters.overdue),
      dueSoon: toNumber(parts.delayedSmallWorks.counters.dueSoon),
    },
    maintenance: parts.maintenance && {
      open: toNumber(parts.maintenance.open),
      solved: toNumber(parts.maintenance.solved),
    },
    generatedAt: generatedAt.toISOString(),
  };
}

// The entity is labelled in the language of the request, and named (with its detail, a user's email) where a name could be found.
export const toRecentActivityDto = (row: RecentAuditRow, locale: LocaleCode = "en"): RecentActivityDto =>
  toListItemDto(row, { locale, entityName: row.entityName, entityDetail: row.entityDetail });
