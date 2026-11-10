// Plain-memory stand-in for the DailyLabour table, shared by the fake of the daily labour, the fake of the villas and the
// transaction client. It imports no other fake (like daily-report-tables.ts), so all of them can use it.

export type StoredDailyLabour = {
  id: string;
  villaId: string;
  labourDate: Date;
  contractorId: string;
  labourCount: number;
  notes: string | null;
  createdById: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export const dailyLabourTables = {
  rows: [] as StoredDailyLabour[],

  reset(): void {
    this.rows = [];
  },

  // The shape of the `where` the villas use for their count.
  count(where: { villaId?: string }): number {
    return this.rows.filter((row) => where.villaId === undefined || row.villaId === where.villaId).length;
  },
};
