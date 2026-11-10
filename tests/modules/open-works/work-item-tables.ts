import { randomUUID } from "node:crypto";
import type { ProgressChangeHook } from "../../../src/modules/villa-progress/service/villa-progress.service.js";
import { phaseProgressOf } from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";
// Plain-memory stand-in for the WorkItem table, shared by the fakes of the open works, the villas, the elec phases and
// the transaction client. It imports no other fake (like progress-tables.ts), so all of them can use it.
import type { PriorityValue, WorkStatusValue } from "../../../src/modules/open-works/dto/open-works.dto.js";

export type StoredWorkItem = {
  id: string;
  villaId: string;
  elecPhaseId: string;
  status: WorkStatusValue;
  priority: PriorityValue;
  progress: number;
  contractorId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  // Every open work is MANUAL now; the column stays in the table (rows of the removed automatic works were deleted).
  source: "MANUAL" | "PHASE";
  version: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const workItemTables = {
  items: [] as StoredWorkItem[],

  reset(): void {
    this.items = [];
  },

  // The shape of the `where` the villas and the elec phases use for their counts.
  count(where: { villaId?: string; elecPhaseId?: string; source?: string }): number {
    return this.items.filter(
      (item) =>
        (where.villaId === undefined || item.villaId === where.villaId) &&
        (where.elecPhaseId === undefined || item.elecPhaseId === where.elecPhaseId) &&
        (where.source === undefined || item.source === where.source),
    ).length;
  },
};

// A villa's progress in one phase, read from its open works filed under the phase: the twin of PHASE_PROGRESS.
export function openWorkProgressOf(villaId: string, elecPhaseId: string): number {
  return phaseProgressOf(
    workItemTables.items
      .filter((item) => item.villaId === villaId && item.elecPhaseId === elecPhaseId)
      .map((item) => item.progress),
  );
}

// Sets the villa's open work under a phase (a villa has at most one) to this progress, adding it the first time, as a
// person does on the open works page. Villa progress is read from the open works, so a test that wants a villa at some
// progress calls this.
export function setPhaseOpenWork(villaId: string, elecPhaseId: string, progress: number): void {
  const item = workItemTables.items.find(
    (candidate) => candidate.villaId === villaId && candidate.elecPhaseId === elecPhaseId,
  );
  const status = progress <= 0 ? "NOT_STARTED" : progress >= 100 ? "DONE" : "IN_PROGRESS";
  if (item) {
    Object.assign(item, { progress, status, updatedAt: new Date(), version: item.version + 1 });
    return;
  }
  const now = new Date();
  workItemTables.items.push({
    id: randomUUID(),
    villaId,
    elecPhaseId,
    status,
    priority: "MEDIUM",
    progress,
    contractorId: null,
    startDate: null,
    endDate: null,
    source: "MANUAL",
    version: 1,
    createdById: null,
    createdAt: now,
    updatedAt: now,
  });
}

// A test convenience, not what the app does: registered as a progress hook, a PATCH of a phase's progress also sets the
// villa's open work under the phase to the same value, as if a person did both. The app has no such sync: the phase
// progress does not reach the open works (tests/modules/villa-progress shows a PATCH alone leaves the villa as it was).
export const mirrorProgressToOpenWorks: ProgressChangeHook = async (_tx, change) => {
  setPhaseOpenWork(change.villaId, change.phase.id, change.after.progress);
};
