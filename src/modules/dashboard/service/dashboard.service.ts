import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import type { RequestContext } from "../../../core/middleware/requestContext.js";
import { startOfUtcDay } from "../../../shared/utils/day.js";
import { alertWindow, zoneToday, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { toRecentActivityDto, toSummaryDto } from "../mapper/dashboard.mapper.js";
import {
  CARD_PERMISSIONS,
  LAST_DAYS,
  OVERDUE_OPEN_WORKS,
  RECENT_DEFAULT_LIMIT,
  UPCOMING_DAYS,
  URGENT_SMALL_WORKS,
  type DashboardCard,
  type DashboardSummaryDto,
  type DayRange,
  type RecentActivityDto,
} from "../dto/dashboard.dto.js";
import { DashboardRepository } from "../repository/dashboard.repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The day helper lives in shared/utils/day.ts, where the open works use it too; kept exported from here for its tests.
export { startOfUtcDay };

// Overdue and upcoming are decided against the START of today in UTC, not the current instant: a villa
// whose target date is today is upcoming, never overdue. 30 days are 30 x 24 hours (UTC has no daylight saving).
// The last 7 days are today and the 6 before it.
export function dayRange(now: Date): DayRange {
  const today = startOfUtcDay(now);
  return {
    today,
    until: new Date(today.getTime() + UPCOMING_DAYS * DAY_MS),
    weekStart: new Date(today.getTime() - (LAST_DAYS - 1) * DAY_MS),
  };
}

// Who is asking: the summary is cut to what they may read.
export type DashboardViewer = { id: string; role: "ADMIN" | "EMPLOYEE" };

export class DashboardService {
  // `clock` and `policy` are injectable so the date rules can be tested at exact instants, in any zone.
  constructor(
    private readonly repository = new DashboardRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: DeadlinePolicy = envDeadlinePolicy(),
  ) {}

  // Global totals, cut to the cards the viewer may see: a card needs every permission in CARD_PERMISSIONS (an ADMIN holds
  // them all), and a card the viewer may not see is not read at all and answers null.
  async summary(viewer: DashboardViewer): Promise<DashboardSummaryDto> {
    const now = this.clock();
    const range = dayRange(now);
    // The small works count their deadline in APP_TIMEZONE; every other figure here counts UTC days.
    const window = alertWindow(now, this.policy);
    // The open works are overdue from the day after their end date in APP_TIMEZONE, like the open works list.
    const openWorksToday = zoneToday(now, this.policy.timeZone);
    const parts = await this.repository.snapshot(async (db) => {
      const granted =
        viewer.role === "ADMIN" ? null : new Set(await this.repository.grantedCodes(viewer.id, db));
      const may = (card: DashboardCard): boolean =>
        granted === null || CARD_PERMISSIONS[card].every((code) => granted.has(code));
      const villas = may("villas")
        ? {
            counters: await this.repository.villaCounters(range, db),
            progress: await this.repository.progressCounters(db),
            areas: await this.repository.areaBreakdown(db),
          }
        : null;
      const needSmallWorkFigures = may("smallWorks") || may("delayedSmallWorks");
      const smallWorkCounters = needSmallWorkFigures
        ? await this.repository.smallWorkCounters(window, db)
        : null;
      const labourCounters = may("labour") ? await this.repository.labourCounters(range, db) : null;
      return {
        villas,
        contractors: may("topContractors") ? await this.repository.topContractors(db) : null,
        openWorks: may("openWorks")
          ? {
              counters: await this.repository.openWorkCounters(openWorksToday, db),
              overdueList: await this.repository.openWorkOverdue(openWorksToday, OVERDUE_OPEN_WORKS, db),
            }
          : null,
        dailyReports: may("dailyReports") ? await this.repository.dailyReportCounters(range, db) : null,
        smallWorks:
          may("smallWorks") && smallWorkCounters
            ? {
                counters: smallWorkCounters,
                urgent: await this.repository.smallWorkUrgent(window, URGENT_SMALL_WORKS, db),
              }
            : null,
        delayedSmallWorks:
          may("delayedSmallWorks") && smallWorkCounters ? { counters: smallWorkCounters } : null,
        siteReports: may("siteReports") ? await this.repository.siteReportCounters(db) : null,
        labour: may("labour") && labourCounters ? labourCounters : null,
        // The workers written on the labour daily reports, all dates.
        totalLabour: may("totalLabour") ? await this.repository.dailyReportWorkers(db) : null,
        maintenance: may("maintenance") ? await this.repository.maintenanceCounters(db) : null,
      };
    });
    return toSummaryDto(parts, now, { window, policy: this.policy });
  }

  // In the language of the request: the entity of each row is labelled in it.
  async recentActivity(
    limit: number = RECENT_DEFAULT_LIMIT,
    ctx?: RequestContext,
  ): Promise<RecentActivityDto[]> {
    return (await this.repository.recentAudit(limit)).map((row) => toRecentActivityDto(row, ctx?.locale));
  }
}
