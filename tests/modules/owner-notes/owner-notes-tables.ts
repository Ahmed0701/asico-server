import type { OwnerNoteRow } from "../../../src/modules/owner-notes/repository/owner-notes.repository.js";

// The owner notes of the fakes, shared by the owner notes repository and the dashboard's. A row keeps the villa's id; the
// villa's number, owner and location are read from the villa fakes when a row is returned.
export type StoredOwnerNote = Omit<OwnerNoteRow, "villa"> & { villaId: string };

export const ownerNoteTables = {
  rows: [] as StoredOwnerNote[],
  reset(): void {
    this.rows = [];
  },
};
