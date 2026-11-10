// Plain-memory stand-in for the DailySmallWork table, shared by the fake of the small works, the fake of the villas and the
// transaction client. It imports no other fake (like daily-report-tables.ts), so all of them can use it.
import type { SmallWorkStatusValue } from "../../../src/modules/small-works/dto/small-works.dto.js";

export type StoredSmallWork = {
  id: string;
  villaId: string;
  contractorId: string;
  startDate: Date;
  endDate: Date;
  description: string;
  status: SmallWorkStatusValue;
  createdById: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export const smallWorkTables = {
  works: [] as StoredSmallWork[],

  reset(): void {
    this.works = [];
  },

  // The shape of the `where` the villas use for their count.
  count(where: { villaId?: string; contractorId?: string }): number {
    return this.works.filter(
      (work) =>
        (where.villaId === undefined || work.villaId === where.villaId) &&
        (where.contractorId === undefined || work.contractorId === where.contractorId),
    ).length;
  },
};
