// A villa's overall progress at a past instant, rebuilt from the audit log of its open works.
//
// The overall progress is never stored: it is read from the open works (a phase is done once the average progress of the
// villa's open works under it reaches 100, and each done active phase adds its progress ratio, at most 100 in all). So the
// progress at an instant T comes from the open works as they were at T:
//
//   * the latest audited create or edit of a work at or before T gives its villa, phase and progress then (a delete at or
//     before T means it was gone);
//   * a work with no audited event up to T existed at T if it was created by then (an import writes one audit entry for
//     the whole file, not one per work): its values are the "before" of its first later edit or delete, or its values now
//     when it was never changed. A work whose first event after T is its create did not exist yet.
//
// The phases are the active ones now, with their progress ratios now: their history is not kept.

export type WorkNow = {
  id: string;
  villaId: string;
  elecPhaseId: string;
  progress: number;
  createdAt: Date;
};

export type WorkEvent = {
  entityId: string;
  action: "open_work.create" | "open_work.update" | "open_work.delete";
  createdAt: Date;
  before: unknown;
  after: unknown;
};

export type PhaseRatio = { id: string; progressRatio: number };

type WorkState = { villaId: string; elecPhaseId: string; progress: number };

// The work's values in an audit snapshot, or null when the snapshot does not carry them.
function stateOf(snapshot: unknown): WorkState | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const { villaId, elecPhaseId, progress } = snapshot as Record<string, unknown>;
  if (typeof villaId !== "string" || typeof elecPhaseId !== "string" || typeof progress !== "number") {
    return null;
  }
  return { villaId, elecPhaseId, progress };
}

// Groups the events by work, each list in time order (the input is expected in time order).
export function eventsByWork(events: readonly WorkEvent[]): Map<string, WorkEvent[]> {
  const byWork = new Map<string, WorkEvent[]>();
  for (const event of events) {
    const list = byWork.get(event.entityId);
    if (list) list.push(event);
    else byWork.set(event.entityId, [event]);
  }
  return byWork;
}

// Every work that existed at `at`, with its values then.
export function worksAt(
  at: Date,
  works: readonly WorkNow[],
  byWork: ReadonlyMap<string, readonly WorkEvent[]>,
): WorkState[] {
  const current = new Map(works.map((work) => [work.id, work]));
  const ids = new Set([...current.keys(), ...byWork.keys()]);
  const states: WorkState[] = [];
  for (const id of ids) {
    const events = byWork.get(id) ?? [];
    const now = current.get(id);
    let lastBefore: WorkEvent | undefined;
    let firstAfter: WorkEvent | undefined;
    for (const event of events) {
      if (event.createdAt.getTime() <= at.getTime()) lastBefore = event;
      else if (!firstAfter) firstAfter = event;
    }
    let state: WorkState | null = null;
    if (lastBefore) {
      state = lastBefore.action === "open_work.delete" ? null : stateOf(lastBefore.after);
    } else if (firstAfter) {
      // Not created yet when its first event is its create (or, for a work still here, when it was created later).
      const createdLater =
        firstAfter.action === "open_work.create" ||
        (now !== undefined && now.createdAt.getTime() > at.getTime());
      state = createdLater ? null : stateOf(firstAfter.before);
    } else if (now && now.createdAt.getTime() <= at.getTime()) {
      state = { villaId: now.villaId, elecPhaseId: now.elecPhaseId, progress: now.progress };
    }
    if (state) states.push(state);
  }
  return states;
}

// The overall progress of each villa from its works: the progress ratios of the active phases whose works average 100 or
// more, at most 100. A villa with no work is at 0 (absent from the map).
export function villaProgressFromWorks(
  works: readonly WorkState[],
  phases: readonly PhaseRatio[],
): Map<string, number> {
  const ratio = new Map(phases.map((phase) => [phase.id, phase.progressRatio]));
  // villa -> phase -> [sum, count]
  const sums = new Map<string, Map<string, [number, number]>>();
  for (const work of works) {
    if (!ratio.has(work.elecPhaseId)) continue;
    let byPhase = sums.get(work.villaId);
    if (!byPhase) {
      byPhase = new Map();
      sums.set(work.villaId, byPhase);
    }
    const entry = byPhase.get(work.elecPhaseId) ?? [0, 0];
    entry[0] += work.progress;
    entry[1] += 1;
    byPhase.set(work.elecPhaseId, entry);
  }
  const result = new Map<string, number>();
  for (const [villaId, byPhase] of sums) {
    let done = 0;
    for (const [phaseId, [sum, count]] of byPhase) {
      if (sum / count >= 100) done += ratio.get(phaseId) ?? 0;
    }
    result.set(villaId, Math.min(100, done));
  }
  return result;
}
