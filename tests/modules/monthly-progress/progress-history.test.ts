import { describe, expect, it } from "vitest";
import { shiftMonth } from "../../../src/modules/monthly-progress/service/monthly-progress.service.js";
import {
  eventsByWork,
  villaProgressFromWorks,
  worksAt,
  type WorkEvent,
  type WorkNow,
} from "../../../src/modules/monthly-progress/service/progress-history.js";

// Rebuilding a villa's overall progress at a past instant from the audit log of its open works.

const at = (iso: string) => new Date(iso);
const snap = (villaId: string, elecPhaseId: string, progress: number) => ({ villaId, elecPhaseId, progress });
const event = (
  entityId: string,
  action: WorkEvent["action"],
  iso: string,
  before: unknown,
  after: unknown,
): WorkEvent => ({ entityId, action, createdAt: at(iso), before, after });
const phases = [
  { id: "A", progressRatio: 40 },
  { id: "B", progressRatio: 60 },
];

describe("worksAt", () => {
  it("takes the latest create or edit up to the instant, and leaves out works deleted or not created yet", () => {
    const works: WorkNow[] = [
      { id: "w1", villaId: "v1", elecPhaseId: "A", progress: 100, createdAt: at("2026-10-05") },
    ];
    const events = eventsByWork([
      event("w1", "open_work.create", "2026-10-05", null, snap("v1", "A", 10)),
      event("w1", "open_work.update", "2026-10-20", snap("v1", "A", 10), snap("v1", "A", 50)),
      event("w1", "open_work.update", "2026-11-10", snap("v1", "A", 50), snap("v1", "A", 100)),
      // A work created and deleted again.
      event("w2", "open_work.create", "2026-10-02", null, snap("v1", "B", 100)),
      event("w2", "open_work.delete", "2026-10-25", snap("v1", "B", 100), null),
    ]);

    expect(worksAt(at("2026-10-01"), works, events)).toEqual([]);
    expect(worksAt(at("2026-10-21"), works, events)).toEqual([snap("v1", "A", 50), snap("v1", "B", 100)]);
    expect(worksAt(at("2026-11-01"), works, events)).toEqual([snap("v1", "A", 50)]);
    expect(worksAt(at("2026-11-15"), works, events)).toEqual([snap("v1", "A", 100)]);
  });

  it("gives an imported work (no audited create) the values before its first edit, or its values now", () => {
    const works: WorkNow[] = [
      { id: "imp", villaId: "v1", elecPhaseId: "A", progress: 80, createdAt: at("2026-09-01") },
      { id: "still", villaId: "v2", elecPhaseId: "B", progress: 30, createdAt: at("2026-09-01") },
      { id: "late", villaId: "v3", elecPhaseId: "B", progress: 30, createdAt: at("2026-12-01") },
    ];
    const events = eventsByWork([
      event("imp", "open_work.update", "2026-11-03", snap("v1", "A", 20), snap("v1", "A", 80)),
    ]);

    expect(worksAt(at("2026-10-31"), works, events)).toEqual([snap("v1", "A", 20), snap("v2", "B", 30)]);
  });

  it("ignores a snapshot without the work's values", () => {
    const events = eventsByWork([event("x", "open_work.create", "2026-10-01", null, { name: "old" })]);

    expect(worksAt(at("2026-11-01"), [], events)).toEqual([]);
  });
});

describe("villaProgressFromWorks", () => {
  it("adds the ratios of the active phases whose works average 100, never more than 100", () => {
    const progress = villaProgressFromWorks(
      [
        snap("v1", "A", 100),
        snap("v1", "B", 99),
        snap("v2", "A", 100),
        snap("v2", "B", 100),
        snap("v3", "Z", 100),
      ],
      phases,
    );

    expect(progress.get("v1")).toBe(40);
    expect(progress.get("v2")).toBe(100);
    // A phase that is not active counts for nothing.
    expect(progress.get("v3") ?? 0).toBe(0);
    expect(
      villaProgressFromWorks(
        [snap("v4", "A", 100), snap("v4", "A", 100)],
        [{ id: "A", progressRatio: 150 }],
      ).get("v4"),
    ).toBe(100);
  });

  it("averages two works under one phase", () => {
    expect(villaProgressFromWorks([snap("v1", "A", 100), snap("v1", "A", 50)], phases).get("v1")).toBe(0);
  });
});

describe("shiftMonth", () => {
  it("moves across years", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-11", -1)).toBe("2026-10");
  });
});
