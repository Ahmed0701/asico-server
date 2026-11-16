import { env } from "../../../core/config/env.js";
import { toDay } from "../../../shared/utils/day.js";
import { localDayOf, startOfLocalDay } from "../../../shared/utils/deadline.js";
import { DashboardRepository } from "../../dashboard/repository/dashboard.repository.js";
import type { DashboardViewer } from "../../dashboard/service/dashboard.service.js";
import { MonthlyProgressRepository } from "../../monthly-progress/repository/monthly-progress.repository.js";
import { shiftMonth } from "../../monthly-progress/service/monthly-progress.service.js";
import { ProgressHistory } from "../../monthly-progress/service/progress-history-cache.js";
import {
  CHART_PERMISSIONS,
  LABOUR_DAYS,
  TREND_MONTHS,
  type DashboardChart,
  type DashboardChartsDto,
  type LabourDayDto,
  type PaymentMonthDto,
  type PhaseStatusRowDto,
  type ProgressTrendPointDto,
} from "../dto/dashboard-charts.dto.js";
import { DashboardChartsRepository } from "../repository/dashboard-charts.repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (value: number): number => Math.round(value * 10) / 10;

// The last `count` months, oldest first, ending with `month`.
function monthsUpTo(month: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(month, i - (count - 1)));
}

export class DashboardChartsService {
  constructor(
    private readonly repository = new DashboardChartsRepository(),
    private readonly progress = new MonthlyProgressRepository(),
    private readonly access = new DashboardRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly history = new ProgressHistory(progress),
  ) {}

  async charts(viewer: DashboardViewer): Promise<DashboardChartsDto> {
    const now = this.clock();
    const granted = viewer.role === "ADMIN" ? null : new Set(await this.access.grantedCodes(viewer.id));
    const may = (chart: DashboardChart): boolean =>
      granted === null || CHART_PERMISSIONS[chart].every((code) => granted.has(code));
    const [progressTrend, phaseStatus, labourByDay, paymentsByMonth] = await Promise.all([
      may("progressTrend") ? this.progressTrend(now) : null,
      may("phaseStatus") ? this.phaseStatus() : null,
      may("labourByDay") ? this.labourByDay(now) : null,
      may("paymentsByMonth") ? this.paymentsByMonth(now) : null,
    ]);
    return { progressTrend, phaseStatus, labourByDay, paymentsByMonth, generatedAt: now.toISOString() };
  }

  // The villas' average progress at the end of each of the last months (APP_TIMEZONE), rebuilt from the open works'
  // history like the monthly progress. The current month is as of now and counts every villa there is.
  private async progressTrend(now: Date): Promise<ProgressTrendPointDto[]> {
    const thisMonth = localDayOf(now, env.APP_TIMEZONE).slice(0, 7);
    const months = monthsUpTo(thisMonth, TREND_MONTHS);
    const past = months.slice(0, -1);
    const ends = past.map((month) => startOfLocalDay(`${shiftMonth(month, 1)}-01`, env.APP_TIMEZONE));
    // The past months are rebuilt from the history (cached); the current one is the open works as they are now.
    const [villas, pastProgress, currentProgress] = await Promise.all([
      this.progress.villas(),
      this.history.at(ends),
      this.history.current(),
    ]);
    return months.map((month, i) => {
      const isCurrent = i === months.length - 1;
      const progress = isCurrent ? currentProgress : pastProgress[i]!;
      const end = isCurrent ? now : ends[i]!;
      const present = isCurrent
        ? villas
        : villas.filter((villa) => villa.createdAt.getTime() <= end.getTime());
      const values = present.map((villa) => progress.get(villa.id) ?? 0);
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        month,
        average: values.length === 0 ? 0 : round1(sum / values.length),
        done: values.filter((value) => value >= 100).length,
        villas: values.length,
      };
    });
  }

  private async phaseStatus(): Promise<PhaseStatusRowDto[]> {
    const [phases, counts] = await Promise.all([
      this.repository.activePhases(),
      this.repository.phaseStatusCounts(),
    ]);
    return phases.map((phase) => {
      const of = (status: string) =>
        counts.find((row) => row.elecPhaseId === phase.id && row.status === status)?.count ?? 0;
      return {
        elecPhaseId: phase.id,
        name: phase.name,
        notStarted: of("NOT_STARTED"),
        inProgress: of("IN_PROGRESS"),
        delayed: of("DELAYED"),
        done: of("DONE"),
      };
    });
  }

  // The last LABOUR_DAYS UTC days, oldest first, today included; a day without labour is 0. (The labour cards of the
  // dashboard count UTC days too.)
  private async labourByDay(now: Date): Promise<LabourDayDto[]> {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const from = new Date(today - (LABOUR_DAYS - 1) * DAY_MS);
    const rows = await this.repository.labourByDay(from);
    const byDay = new Map(rows.map((row) => [toDay(row.day), row.workers]));
    return Array.from({ length: LABOUR_DAYS }, (_, i) => {
      const day = toDay(new Date(from.getTime() + i * DAY_MS));
      return { day, workers: byDay.get(day) ?? 0 };
    });
  }

  // The last TREND_MONTHS months (APP_TIMEZONE), oldest first; a month without a payment is 0.
  private async paymentsByMonth(now: Date): Promise<PaymentMonthDto[]> {
    const thisMonth = localDayOf(now, env.APP_TIMEZONE).slice(0, 7);
    const months = monthsUpTo(thisMonth, TREND_MONTHS);
    const rows = await this.repository.paidByMonth(new Date(`${months[0]}-01T00:00:00.000Z`));
    const byMonth = new Map(rows.map((row) => [row.month, Number(row.paid)]));
    return months.map((month) => ({ month, paidMinor: byMonth.get(month) ?? 0 }));
  }
}
