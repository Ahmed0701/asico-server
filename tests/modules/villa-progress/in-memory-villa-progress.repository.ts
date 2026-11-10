import { openWorkProgressOf } from "../open-works/work-item-tables.js";
import { doneRatioOf } from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";
import type {
  Db,
  PhaseRow,
  ProgressRow,
  VillaProgressRepository,
} from "../../../src/modules/villa-progress/repository/villa-progress.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import { progressTables, type StoredProgress } from "./progress-tables.js";

export { progressTables } from "./progress-tables.js";

const foreignKeyError = (constraint: string): Error =>
  Object.assign(new Error("Prisma P2003"), {
    code: "P2003",
    meta: { driverAdapterError: { cause: { constraint: { index: constraint } } } },
  });

export const VILLA_FK = "VillaPhaseProgress_villaId_fkey";
export const PHASE_FK = "VillaPhaseProgress_elecPhaseId_fkey";

const toRow = (row: StoredProgress): ProgressRow => ({
  villaId: row.villaId,
  elecPhaseId: row.elecPhaseId,
  progress: row.progress,
  completedAt: row.completedAt,
  version: row.version,
});

// Plain-memory stand-in for the progress update's queries. Villas and phases are read from the other modules' fakes.
export class InMemoryVillaProgressRepository implements VillaProgressRepository {
  // Transactions take turns, as they would behind the row lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(async () => {
      // The hooks of the open works write items in the same transaction: they are undone with the rows.
      const before = structuredClone({ rows: progressTables.rows, items: workItemTables.items });
      try {
        return await inMemoryTransaction(work);
      } catch (err) {
        progressTables.rows = before.rows;
        workItemTables.items = before.items;
        throw err;
      }
    });
  }

  async lockVilla(id: string): Promise<boolean> {
    return villaTables.villas.some((villa) => villa.id === id);
  }

  async lockPhase(id: string): Promise<PhaseRow | null> {
    const phase = phaseTables.phases.find((candidate) => candidate.id === id);
    return phase
      ? { id: phase.id, name: phase.name, sortOrder: phase.sortOrder, status: phase.status }
      : null;
  }

  // A missing row is created at 0 first, as the real one does; the foreign keys decide whether it can exist.
  async lockRow(villaId: string, elecPhaseId: string): Promise<ProgressRow> {
    const found = progressTables.find(villaId, elecPhaseId);
    if (found) {
      return toRow(found);
    }
    if (!villaTables.villas.some((villa) => villa.id === villaId)) throw foreignKeyError(VILLA_FK);
    if (!phaseTables.phases.some((phase) => phase.id === elecPhaseId)) throw foreignKeyError(PHASE_FK);
    progressTables.insertMissing([{ villaId, elecPhaseId }]);
    return toRow(progressTables.find(villaId, elecPhaseId)!);
  }

  async update(
    villaId: string,
    elecPhaseId: string,
    version: number,
    data: { progress: number; completedAt: Date | null },
  ): Promise<ProgressRow | null> {
    const row = progressTables.find(villaId, elecPhaseId);
    if (!row || row.version !== version) {
      return null;
    }
    // The database's CHECK constraints: 0..100, and completed exactly at 100.
    if (data.progress < 0 || data.progress > 100) {
      throw Object.assign(new Error("CHECK VillaPhaseProgress_progress_check"), { code: "23514" });
    }
    if ((data.progress === 100) !== (data.completedAt !== null)) {
      throw Object.assign(new Error("CHECK VillaPhaseProgress_completed_check"), { code: "23514" });
    }
    Object.assign(row, data, { version: row.version + 1, updatedAt: new Date() });
    return toRow(row);
  }

  async totals(villaId: string): Promise<{ doneRatio: number; count: number }> {
    const active = phaseTables.phases.filter((phase) => phase.status === "ACTIVE");
    return {
      doneRatio: active.reduce(
        (sum, phase) =>
          sum +
          doneRatioOf({
            progress: openWorkProgressOf(villaId, phase.id),
            progressRatio: phase.progressRatio,
          }),
        0,
      ),
      count: active.length,
    };
  }
}
