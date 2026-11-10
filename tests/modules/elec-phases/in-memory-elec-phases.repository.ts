import { randomUUID } from "node:crypto";
import {
  MAX_OPTIONS,
  type ElecPhaseStatusValue,
} from "../../../src/modules/elec-phases/dto/elec-phases.dto.js";
import type {
  Db,
  ElecPhaseRow,
  ElecPhasesRepository,
} from "../../../src/modules/elec-phases/repository/elec-phases.repository.js";
import { transactionLock } from "../auth/in-memory-auth.repository.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { progressTables } from "../villa-progress/progress-tables.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";

export type StoredPhase = {
  id: string;
  name: string;
  sortOrder: number;
  status: ElecPhaseStatusValue;
  progressRatio: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

// Plain-memory stand-in for the ElecPhase table.
export const phaseTables = {
  phases: [] as StoredPhase[],
  // How many records of the tables that come in later slices "use" each phase, by id (the progress rows are counted
  // from progressTables, the open works from workItemTables).
  usage: {} as Record<string, number>,
  // Race switch: simulates another request deleting the row between the service's lookup and its write.
  removeBeforeWrite: false,

  reset(): void {
    this.phases = [];
    this.usage = {};
    this.removeBeforeWrite = false;
    progressTables.reset();
    workItemTables.reset();
  },
};

// The progress rows' table asks which phases exist.
progressTables.phaseIds = () => phaseTables.phases.map((p) => p.id);

export function addPhase(overrides: Partial<StoredPhase> & { name: string }): StoredPhase {
  const now = new Date();
  const phase: StoredPhase = {
    id: randomUUID(),
    sortOrder: phaseTables.phases.length + 1,
    status: "ACTIVE",
    progressRatio: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  phaseTables.phases.push(phase);
  return phase;
}

// The six rows the migration inserts, in order.
export function addStartingPhases(): StoredPhase[] {
  return [
    "Ceiling Piping",
    "MSB Box Fixing",
    "Cut/out Box Fixing",
    "D.B Box Fixing",
    "Wall Piping",
    "Sleeves",
  ].map((name, index) => addPhase({ name, sortOrder: index + 1 }));
}

const prismaError = (code: string): Error => Object.assign(new Error(`Prisma ${code}`), { code });

function toRow(phase: StoredPhase): ElecPhaseRow {
  return {
    id: phase.id,
    name: phase.name,
    sortOrder: phase.sortOrder,
    status: phase.status,
    progressRatio: phase.progressRatio,
    version: phase.version,
    createdAt: phase.createdAt,
    updatedAt: phase.updatedAt,
  };
}

const inDisplayOrder = (): StoredPhase[] =>
  [...phaseTables.phases].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

export class InMemoryElecPhasesRepository implements ElecPhasesRepository {
  // Transactions take turns, as they would behind the order lock (see tests/helpers/serial.ts).
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transactionLock.run(() => this.unlockedTransaction(work));
  }

  private async unlockedTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    const before = structuredClone({
      phases: phaseTables.phases,
      progress: progressTables.rows,
      items: workItemTables.items,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      phaseTables.phases = before.phases;
      progressTables.rows = before.progress;
      workItemTables.items = before.items;
      throw err;
    }
  }

  async list(params: { status?: ElecPhaseStatusValue | undefined; skip: number; take: number }) {
    const matching = inDisplayOrder().filter((p) => !params.status || p.status === params.status);
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toRow),
      total: matching.length,
    };
  }

  async options() {
    return inDisplayOrder()
      .filter((p) => p.status === "ACTIVE")
      .slice(0, MAX_OPTIONS)
      .map((p) => ({ id: p.id, name: p.name, extra: "must not leak" }));
  }

  async findById(id: string): Promise<ElecPhaseRow | null> {
    const phase = phaseTables.phases.find((candidate) => candidate.id === id);
    return phase ? toRow(phase) : null;
  }

  async findByName(name: string): Promise<{ id: string } | null> {
    const phase = phaseTables.phases.find((p) => p.name.toLowerCase() === name.toLowerCase());
    return phase ? { id: phase.id } : null;
  }

  async lockOrder(): Promise<void> {
    // The transaction lock already makes transactions take turns.
  }

  async seedProgressRows(phaseId: string): Promise<void> {
    progressTables.insertMissing(
      progressTables.villaIds().map((villaId) => ({ villaId, elecPhaseId: phaseId })),
    );
  }

  async deleteZeroProgress(phaseId: string): Promise<void> {
    progressTables.rows = progressTables.rows.filter((r) => r.elecPhaseId !== phaseId || r.progress !== 0);
  }

  async create(data: {
    name: string;
    status: ElecPhaseStatusValue;
    progressRatio: number;
  }): Promise<ElecPhaseRow> {
    // The unique index on lower("name"): the check the database makes even when the service's own check missed.
    if (phaseTables.phases.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) {
      throw prismaError("P2002");
    }
    const now = new Date();
    const end = Math.max(0, ...phaseTables.phases.map((p) => p.sortOrder)) + 1;
    return toRow(addPhase({ ...data, sortOrder: end, createdAt: now, updatedAt: now }));
  }

  async lockVersion(id: string): Promise<number | null> {
    return phaseTables.phases.find((candidate) => candidate.id === id)?.version ?? null;
  }

  async lockAll(): Promise<ElecPhaseRow[]> {
    return inDisplayOrder().map(toRow);
  }

  async update(
    id: string,
    version: number,
    data: { name?: string; status?: ElecPhaseStatusValue },
  ): Promise<ElecPhaseRow | null> {
    this.applyRaceOfRemoval(id);
    const phase = phaseTables.phases.find((candidate) => candidate.id === id);
    if (!phase) {
      throw prismaError("P2025");
    }
    if (phase.version !== version) {
      return null;
    }
    if (
      data.name !== undefined &&
      phaseTables.phases.some((p) => p.id !== id && p.name.toLowerCase() === data.name?.toLowerCase())
    ) {
      throw prismaError("P2002");
    }
    Object.assign(phase, data, { updatedAt: new Date(), version: phase.version + 1 });
    return toRow(phase);
  }

  async setSortOrder(id: string, version: number, sortOrder: number): Promise<ElecPhaseRow | null> {
    const phase = phaseTables.phases.find((candidate) => candidate.id === id);
    if (!phase || phase.version !== version) {
      return null;
    }
    Object.assign(phase, { sortOrder, updatedAt: new Date(), version: phase.version + 1 });
    return toRow(phase);
  }

  async delete(id: string, version: number): Promise<boolean> {
    this.applyRaceOfRemoval(id);
    const phase = phaseTables.phases.find((candidate) => candidate.id === id);
    if (!phase) {
      throw prismaError("P2025");
    }
    if (phase.version !== version) {
      return false;
    }
    // onDelete: Restrict on the progress rows: one that is left (above 0) refuses the delete.
    if (progressTables.rows.some((r) => r.elecPhaseId === id)) {
      throw Object.assign(new Error("Prisma P2003"), {
        code: "P2003",
        meta: {
          driverAdapterError: { cause: { constraint: { index: "VillaPhaseProgress_elecPhaseId_fkey" } } },
        },
      });
    }
    phaseTables.phases = phaseTables.phases.filter((candidate) => candidate.id !== id);
    return true;
  }

  async countUsage(id: string): Promise<number> {
    const inProgress = progressTables.rows.filter((r) => r.elecPhaseId === id && r.progress > 0).length;
    return inProgress + workItemTables.count({ elecPhaseId: id }) + (phaseTables.usage[id] ?? 0);
  }

  private applyRaceOfRemoval(id: string): void {
    if (phaseTables.removeBeforeWrite) {
      phaseTables.phases = phaseTables.phases.filter((candidate) => candidate.id !== id);
    }
  }
}
