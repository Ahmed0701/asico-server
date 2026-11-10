// Plain-memory stand-in for the SiteReport table, shared by the fake of the site reports, the fake of the villas and the
// transaction client. It imports no other fake (like small-work-tables.ts), so all of them can use it.
import type { SiteReportTypeValue } from "../../../src/modules/site-reports/dto/site-reports.dto.js";

export type StoredSiteReport = {
  id: string;
  villaId: string;
  title: string;
  visitDate: Date;
  inspector: string;
  type: SiteReportTypeValue;
  rating: number;
  findings: string;
  recommendations: string | null;
  createdById: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export const siteReportTables = {
  reports: [] as StoredSiteReport[],

  reset(): void {
    this.reports = [];
  },

  // The shape of the `where` the villas use for their count.
  count(where: { villaId?: string }): number {
    return this.reports.filter((report) => where.villaId === undefined || report.villaId === where.villaId)
      .length;
  },
};
