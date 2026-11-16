import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";

// The permissions each chart needs, on top of dashboard:read (an ADMIN holds them all). A chart the viewer may not see is
// not read at all and answers null.
export const CHART_PERMISSIONS = {
  progressTrend: [PERMISSIONS.VILLAS_READ],
  phaseStatus: [PERMISSIONS.OPEN_WORKS_READ],
  labourByDay: [PERMISSIONS.DAILY_LABOUR_READ],
  paymentsByMonth: [PERMISSIONS.PAYMENTS_READ],
} as const satisfies Record<string, readonly Permission[]>;

export type DashboardChart = keyof typeof CHART_PERMISSIONS;

// How far back the charts look.
export const TREND_MONTHS = 6;
export const LABOUR_DAYS = 14;

// One month of the villas' overall progress: at its end (now, for the current month), the average over the villas there
// were then (one decimal), how many were done (100), and how many there were.
export type ProgressTrendPointDto = {
  month: string;
  average: number;
  done: number;
  villas: number;
};

// One active electrical phase: how many open works it has in each status.
export type PhaseStatusRowDto = {
  elecPhaseId: string;
  name: string;
  notStarted: number;
  inProgress: number;
  delayed: number;
  done: number;
};

// One UTC day (YYYY-MM-DD) and the workers on the daily labour of that day, all villas together.
export type LabourDayDto = { day: string; workers: number };

// One month (YYYY-MM) and what was paid to contractors in it (by paid date), KWD fils.
export type PaymentMonthDto = { month: string; paidMinor: number };

export type DashboardChartsDto = {
  progressTrend: ProgressTrendPointDto[] | null;
  phaseStatus: PhaseStatusRowDto[] | null;
  labourByDay: LabourDayDto[] | null;
  paymentsByMonth: PaymentMonthDto[] | null;
  generatedAt: string;
};
