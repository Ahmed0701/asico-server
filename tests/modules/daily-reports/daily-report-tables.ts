// Plain-memory stand-in for the DailyReport table, shared by the fake of the daily reports, the fake of the contractors and the
// transaction client. It imports no other fake (like work-item-tables.ts), so all of them can use it.
import type { WeatherValue } from "../../../src/modules/daily-reports/dto/daily-reports.dto.js";

export type StoredDailyReport = {
  id: string;
  contractorId: string;
  preparedByEngineerId: string;
  reportDate: Date;
  weather: WeatherValue;
  workersCount: number;
  notes: string | null;
  createdById: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export const dailyReportTables = {
  reports: [] as StoredDailyReport[],

  reset(): void {
    this.reports = [];
  },

  // The shape of the `where` the contractors and the electrical engineers use for their counts.
  count(where: { contractorId?: string; preparedByEngineerId?: string }): number {
    return this.reports.filter(
      (report) =>
        (where.contractorId === undefined || report.contractorId === where.contractorId) &&
        (where.preparedByEngineerId === undefined ||
          report.preparedByEngineerId === where.preparedByEngineerId),
    ).length;
  },
};
