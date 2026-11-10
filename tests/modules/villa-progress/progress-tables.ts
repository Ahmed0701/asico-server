// Plain-memory stand-in for the VillaPhaseProgress table, shared by the fakes of the villas, the elec phases and the
// progress update. It imports no other fake: the villas and the phases tell it what exists (the same way the areas'
// fake counts villas), so the fakes can all use it without importing one another.

export type StoredProgress = {
  villaId: string;
  elecPhaseId: string;
  progress: number;
  completedAt: Date | null;
  version: number;
  updatedAt: Date;
};

export const progressTables = {
  rows: [] as StoredProgress[],
  // Set by the villas' fake and the phases' fake: the ids of the villas and the phases that exist.
  villaIds: (() => []) as () => string[],
  phaseIds: (() => []) as () => string[],

  reset(): void {
    this.rows = [];
  },

  find(villaId: string, elecPhaseId: string): StoredProgress | undefined {
    return this.rows.find((row) => row.villaId === villaId && row.elecPhaseId === elecPhaseId);
  },

  // INSERT ... ON CONFLICT DO NOTHING: a row at 0 for each pair that has none.
  insertMissing(pairs: { villaId: string; elecPhaseId: string }[]): void {
    for (const { villaId, elecPhaseId } of pairs) {
      if (!this.find(villaId, elecPhaseId)) {
        this.rows.push({
          villaId,
          elecPhaseId,
          progress: 0,
          completedAt: null,
          version: 1,
          updatedAt: new Date(),
        });
      }
    }
  },
};
