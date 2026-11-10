import { beforeEach, describe, expect, it, vi } from "vitest";
import { addArea, areaTables } from "../areas/in-memory-areas.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { addPhase, phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { progressTables } from "../villa-progress/progress-tables.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addAuditRow } from "../audit/in-memory-audit.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { InMemoryDashboardRepository } from "./in-memory-dashboard.repository.js";
import {
  DashboardService,
  dayRange,
  startOfUtcDay,
} from "../../../src/modules/dashboard/service/dashboard.service.js";
import type {
  AreaCountRow,
  ContractorCountRow,
  DashboardRepository,
  ProgressCounterRow,
  VillaCounterRow,
} from "../../../src/modules/dashboard/repository/dashboard.repository.js";
import { toSummaryDto } from "../../../src/modules/dashboard/mapper/dashboard.mapper.js";
import type { DashboardSummaryDto } from "../../../src/modules/dashboard/dto/dashboard.dto.js";
import { setPhaseOpenWork } from "../open-works/work-item-tables.js";

// 2026-10-12 is the "today" of these tests; the instant within the day is varied where it matters.
const NOW = new Date("2026-10-12T15:37:42.123Z");
const TODAY = new Date("2026-10-12T00:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number): Date => new Date(TODAY.getTime() + ms);

const ADMIN = { id: "admin-id", role: "ADMIN" } as const;

// An ADMIN sees every card, so every key is a figure here (the permission cuts are tested in the section that follows).
type Full = { [K in keyof DashboardSummaryDto]: NonNullable<DashboardSummaryDto[K]> };
function full(summary: DashboardSummaryDto): Full {
  for (const [key, value] of Object.entries(summary)) {
    if (value === null) throw new Error(`the ADMIN's summary has no ${key}`);
  }
  return summary as Full;
}

const service = (now: Date = NOW) => {
  const real = new DashboardService(
    new InMemoryDashboardRepository() as unknown as DashboardRepository,
    () => now,
  );
  return {
    summary: async (): Promise<Full> => full(await real.summary(ADMIN)),
    recentActivity: real.recentActivity.bind(real),
  };
};

beforeEach(() => {
  store.reset();
  villaTables.reset();
  phaseTables.reset();
  contractorTables.reset();
});

type Seed = Parameters<typeof addVilla>[0];
const villa = (overrides: Seed = {}) => addVilla({ civilEngineerId: "eng", area: "Area", ...overrides });

describe("an empty database", () => {
  it("returns zeros and empty lists, never null or NaN", async () => {
    const summary = await service().summary();

    expect(summary).toEqual({
      villas: { total: 0 },
      progress: { average: 0, notStarted: 0, inProgress: 0, done: 0 },
      overdue: { count: 0 },
      upcoming: { count: 0 },
      mewFollowUp: { count: 0 },
      mewInspection: { count: 0 },
      byArea: [],
      topContractors: [],
      openWorks: {
        total: 0,
        delayed: 0,
        byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 0, DONE: 0 },
        overdue: 0,
        overdueList: [],
      },
      dailyReports: { today: 0, last7Days: 0 },
      smallWorks: { total: 0, pending: 0, dueSoon: 0, overdue: 0, urgent: [] },
      // No report: a zero count and no average (not 0, which would read as a bad rating).
      siteReports: { count: 0, averageRating: null },
      labour: { today: 0, last7Days: 0 },
      totalLabour: { total: 0 },
      maintenance: { open: 0, solved: 0 },
      delayedSmallWorks: { overdue: 0, dueSoon: 0 },
      generatedAt: NOW.toISOString(),
    });
  });

  it("has no recent activity", async () => {
    expect(await service().recentActivity()).toEqual([]);
  });
});

describe("the counts", () => {
  it("counts every villa in the total", async () => {
    for (let i = 0; i < 6; i++) villa();

    expect((await service().summary()).villas).toEqual({ total: 6 });
  });
});

describe("overdue and upcoming are decided against the START of today in UTC", () => {
  const counts = async (now: Date = NOW) => {
    const { overdue, upcoming } = await service(now).summary();
    return [overdue.count, upcoming.count];
  };

  it("a target date before the start of today is overdue", async () => {
    villa({ targetDate: at(-1) });

    expect(await counts()).toEqual([1, 0]);
  });

  it("a target date at the start of today is upcoming, never overdue", async () => {
    villa({ targetDate: at(0) });

    expect(await counts()).toEqual([0, 1]);
  });

  it("a villa due today stays upcoming however late in the day it is", async () => {
    villa({ targetDate: at(0) });
    villa({ targetDate: at(12 * 3_600_000) });

    for (const hour of ["00:00:00.000", "00:00:00.001", "12:00:00.000", "23:59:59.999"]) {
      expect(await counts(new Date(`2026-10-12T${hour}Z`)), hour).toEqual([0, 2]);
    }
  });

  it("a target date that has passed within today (before now, after midnight) is upcoming, not overdue", async () => {
    villa({ targetDate: new Date("2026-10-12T01:00:00.000Z") });

    expect(await counts(new Date("2026-10-12T20:00:00.000Z"))).toEqual([0, 1]);
  });

  it("the last instant of the window is upcoming and the first one after it is not", async () => {
    villa({ targetDate: at(30 * DAY - 1) });
    villa({ targetDate: at(30 * DAY) });

    expect(await counts()).toEqual([0, 1]);
  });

  it("the overdue range and the upcoming window leave no gap and no overlap", async () => {
    // Two before today, four inside the window, two at or beyond its end.
    const instants = [-2, -1, 0, 1, 29 * DAY, 30 * DAY - 1, 30 * DAY, 30 * DAY + 1];
    for (const ms of instants) villa({ targetDate: at(ms) });

    const [overdue = 0, upcoming = 0] = await counts();

    expect(overdue).toBe(2);
    expect(upcoming).toBe(4);
    expect(overdue + upcoming + instants.filter((ms) => ms >= 30 * DAY).length).toBe(instants.length);
  });

  it("a villa with no target date is in neither", async () => {
    villa({ targetDate: null });

    expect(await counts()).toEqual([0, 0]);
  });

  it("every villa with a target date counts, whatever its start date or contractor", async () => {
    const contractor = addContractor({ name: "C" });
    villa({ targetDate: at(-DAY), startDate: null, contractorId: null });
    villa({ targetDate: at(-DAY), startDate: at(-10 * DAY), contractorId: contractor.id });
    villa({ targetDate: at(DAY), startDate: null, contractorId: contractor.id });

    expect(await counts()).toEqual([2, 1]);
  });

  it("moves with the clock: tomorrow, the villa due today is overdue", async () => {
    villa({ targetDate: at(0) });

    expect(await counts(new Date("2026-10-12T23:59:59.999Z"))).toEqual([0, 1]);
    expect(await counts(new Date("2026-10-13T00:00:00.000Z"))).toEqual([1, 0]);
  });

  it("uses the UTC day, not the server's local day", async () => {
    // 23:30 UTC on the 12th is already the 13th in UTC+2, and still the 12th in UTC-5.
    villa({ targetDate: at(0) });
    const late = new Date("2026-10-12T23:30:00.000Z");

    expect(await counts(late)).toEqual([0, 1]);
    expect(startOfUtcDay(late).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("a villa whose date moves out of the window changes the figures", async () => {
    const p = villa({ targetDate: at(5 * DAY) });
    expect(await counts()).toEqual([0, 1]);

    p.targetDate = at(-5 * DAY);
    expect(await counts()).toEqual([1, 0]);

    p.targetDate = null;
    expect(await counts()).toEqual([0, 0]);
  });
});

describe("by area", () => {
  it("groups by area with the villa count, busiest first", async () => {
    villa({ area: "New Cairo" });
    villa({ area: "New Cairo" });
    villa({ area: "New Cairo" });
    villa({ area: "Sheikh Zayed" });
    villa({ area: "6 October" });
    villa({ area: "6 October" });

    const { byArea } = await service().summary();

    const idOf = (name: string) => areaTables.areas.find((a) => a.name === name)?.id;
    expect(byArea).toEqual([
      { areaId: idOf("New Cairo"), area: "New Cairo", city: "Cairo", total: 3 },
      { areaId: idOf("6 October"), area: "6 October", city: "Cairo", total: 2 },
      { areaId: idOf("Sheikh Zayed"), area: "Sheikh Zayed", city: "Cairo", total: 1 },
    ]);
  });

  it("breaks ties by area name", async () => {
    for (const area of ["Charlie", "Alpha", "Bravo"]) villa({ area });

    expect((await service().summary()).byArea.map((a) => a.area)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("counts per area row: the same name in two cities is two entries, each with its city", async () => {
    const giza = addArea({ name: "Palm Hills", city: "Giza" });
    const cairo = addArea({ name: "Palm Hills", city: "Cairo" });
    villa({ areaId: giza.id });
    villa({ areaId: giza.id });
    villa({ areaId: cairo.id });

    const { byArea } = await service().summary();

    expect(byArea.map((a) => [a.areaId, a.area, a.city, a.total])).toEqual([
      [giza.id, "Palm Hills", "Giza", 2],
      [cairo.id, "Palm Hills", "Cairo", 1],
    ]);
  });

  it("breaks a tie on the name by the city", async () => {
    const giza = addArea({ name: "Palm Hills", city: "Giza" });
    const cairo = addArea({ name: "Palm Hills", city: "Cairo" });
    villa({ areaId: giza.id });
    villa({ areaId: cairo.id });

    expect((await service().summary()).byArea.map((a) => a.city)).toEqual(["Cairo", "Giza"]);
  });

  it("lists an area that has no villas nowhere: only areas with villas are counted", async () => {
    addArea({ name: "Empty" });
    villa({ area: "Busy" });

    expect((await service().summary()).byArea.map((a) => a.area)).toEqual(["Busy"]);
  });

  it("is capped at 50 areas, keeping the busiest", async () => {
    for (let i = 0; i < 60; i++) {
      const copies = i < 5 ? 3 : 1;
      for (let c = 0; c < copies; c++) villa({ area: `Area ${String(i).padStart(2, "0")}` });
    }

    const { byArea, villas } = await service().summary();

    expect(byArea).toHaveLength(50);
    expect(byArea.slice(0, 5).every((a) => a.total === 3)).toBe(true);
    expect(byArea.reduce((sum, a) => sum + a.total, 0)).toBeLessThanOrEqual(villas.total);
    expect(villas.total).toBe(5 * 3 + 55);
  });

  it("all the areas add up to the total when there are no more than 50", async () => {
    for (let i = 0; i < 12; i++) villa({ area: `Area ${i}` });

    const { byArea, villas } = await service().summary();

    expect(byArea.reduce((sum, a) => sum + a.total, 0)).toBe(villas.total);
  });
});

describe("top contractors", () => {
  // A villa has one contractor, so each villa made here counts for exactly one.
  function contractorWith(name: string, villas: number) {
    const contractor = addContractor({ name });
    for (let i = 0; i < villas; i++) villa({ contractorId: contractor.id });
    return contractor;
  }

  it("ranks contractors by their number of villas", async () => {
    const big = contractorWith("Nile Builders", 4);
    const small = contractorWith("Delta Works", 1);

    const { topContractors } = await service().summary();

    expect(topContractors).toEqual([
      { id: big.id, name: "Nile Builders", total: 4 },
      { id: small.id, name: "Delta Works", total: 1 },
    ]);
  });

  it("breaks ties by name", async () => {
    contractorWith("Zeta", 1);
    contractorWith("Alpha", 1);
    contractorWith("Mid", 1);

    expect((await service().summary()).topContractors.map((c) => c.name)).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  it("is capped at 10, keeping the busiest", async () => {
    for (let i = 0; i < 14; i++) contractorWith(`Contractor ${String(i).padStart(2, "0")}`, i + 1);

    const { topContractors } = await service().summary();

    expect(topContractors).toHaveLength(10);
    expect(topContractors.map((c) => c.total)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  });

  it("a villa without a contractor counts for nobody", async () => {
    villa({ contractorId: null });
    contractorWith("A", 2);

    const { topContractors, villas } = await service().summary();

    expect(topContractors.map((c) => c.total)).toEqual([2]);
    expect(villas.total).toBe(3);
  });

  it("a contractor without villas is not listed", async () => {
    addContractor({ name: "Idle" });

    expect((await service().summary()).topContractors).toEqual([]);
  });
});

describe("one consistent summary", () => {
  it("has exactly the documented fields", async () => {
    villa({});

    const summary = await service().summary();

    expect(Object.keys(summary)).toEqual([
      "villas",
      "progress",
      "overdue",
      "upcoming",
      "mewFollowUp",
      "mewInspection",
      "byArea",
      "topContractors",
      "openWorks",
      "dailyReports",
      "smallWorks",
      "siteReports",
      "labour",
      "totalLabour",
      "delayedSmallWorks",
      "maintenance",
      "generatedAt",
    ]);
    expect(Object.keys(summary.villas)).toEqual(["total"]);
  });

  it("stamps generatedAt from the clock, in UTC", async () => {
    expect((await service(new Date("2026-03-04T05:06:07.890Z")).summary()).generatedAt).toBe(
      "2026-03-04T05:06:07.890Z",
    );
  });

  it("a mixed database adds up everywhere", async () => {
    const c1 = addContractor({ name: "One" });
    const c2 = addContractor({ name: "Two" });
    for (let i = 0; i < 40; i++) {
      villa({
        area: `Area ${i % 7}`,
        targetDate: i % 4 === 0 ? null : at((i - 20) * DAY),
        contractorId: i % 2 ? c1.id : c2.id,
      });
    }

    const s = await service().summary();

    expect(s.villas.total).toBe(40);
    expect(s.byArea.reduce((sum, a) => sum + a.total, 0)).toBe(40);
    expect(s.topContractors.reduce((sum, c) => sum + c.total, 0)).toBe(40);
    expect(s.overdue.count + s.upcoming.count).toBeLessThanOrEqual(40);
  });
});

describe("the MEW follow-up count", () => {
  const mark = (v: ReturnType<typeof villa>) => {
    v.mewFollowUpAt = new Date("2026-10-01T08:00:00.000Z");
    v.mewFollowUpById = "someone";
  };

  it("counts the villas someone marked, and nothing else", async () => {
    mark(villa());
    mark(villa());
    villa();

    const summary = await service().summary();

    expect(summary.mewFollowUp).toEqual({ count: 2 });
    expect(summary.villas).toEqual({ total: 3 });
  });

  it("counts a marked villa whose user is gone, and one at 0% in every phase", async () => {
    addPhase({ name: "One" });
    mark(villa());
    const gone = villa();
    gone.mewFollowUpAt = new Date("2026-10-02T08:00:00.000Z");
    gone.mewFollowUpById = null;

    const summary = await service().summary();

    expect(summary.mewFollowUp).toEqual({ count: 2 });
    expect(summary.progress.notStarted).toBe(2);
  });

  it("does not count a villa that is at 100% in every phase until someone marks it", async () => {
    addPhase({ name: "One" });
    addPhase({ name: "Two" });
    const done = villa();
    for (const phase of phaseTables.phases) {
      progressTables.insertMissing([{ villaId: done.id, elecPhaseId: phase.id }]);
      const row = progressTables.find(done.id, phase.id);
      if (row) row.progress = 100;
      setPhaseOpenWork(done.id, phase.id, 100);
    }

    const before = await service().summary();
    mark(done);
    const after = await service().summary();

    expect(before.progress.done).toBe(1);
    expect(before.mewFollowUp).toEqual({ count: 0 });
    expect(after.mewFollowUp).toEqual({ count: 1 });
  });
});

describe("the progress figures", () => {
  // A villa with a row in each phase, at the given progress.
  function villaAt(...values: number[]) {
    const created = villa();
    phaseTables.phases.forEach((phase, index) => {
      progressTables.insertMissing([{ villaId: created.id, elecPhaseId: phase.id }]);
      const row = progressTables.find(created.id, phase.id);
      if (row) row.progress = values[index] ?? 0;
      setPhaseOpenWork(created.id, phase.id, values[index] ?? 0);
    });
    return created;
  }

  // Each phase adds half of a villa's progress once the villa's open work for it is done.
  beforeEach(() => {
    addPhase({ name: "One", progressRatio: 50 });
    addPhase({ name: "Two", progressRatio: 50 });
  });

  it("counts a villa at 0 in every phase as not started, at 100 in every phase as done, anything between as in progress", async () => {
    villaAt(0, 0);
    villaAt(100, 0);
    villaAt(0, 1);
    villaAt(100, 100);

    // The villas are at 0, 50 (One done), 0 (Two at 1, not done) and 100: 150 over 4.
    expect((await service().summary()).progress).toEqual({
      average: 37.5,
      notStarted: 1,
      inProgress: 2,
      done: 1,
    });
  });

  it("the three states add up to the total", async () => {
    for (const values of [
      [0, 0],
      [50, 50],
      [100, 100],
      [100, 99],
      [5, 0],
    ])
      villaAt(...values);

    const { villas, progress } = await service().summary();

    expect(progress.notStarted + progress.inProgress + progress.done).toBe(villas.total);
  });

  it("leaves out an inactive phase from the average and the states, keeping its rows", async () => {
    const [one] = phaseTables.phases;
    villaAt(100, 0);
    expect((await service().summary()).progress).toMatchObject({ average: 50, inProgress: 1, done: 0 });

    if (one) one.status = "INACTIVE";
    expect((await service().summary()).progress).toEqual({
      average: 0,
      notStarted: 1,
      inProgress: 0,
      done: 0,
    });
  });

  it("reads a missing row as 0", async () => {
    villa();

    expect((await service().summary()).progress).toEqual({
      average: 0,
      notStarted: 1,
      inProgress: 0,
      done: 0,
    });
  });

  it("with no active phase, every villa is not started and the average is 0", async () => {
    phaseTables.reset();
    villa();
    villa();

    expect((await service().summary()).progress).toEqual({
      average: 0,
      notStarted: 2,
      inProgress: 0,
      done: 0,
    });
  });
});

describe("the day range", () => {
  it.each([
    ["2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-11-11T00:00:00.000Z"],
    ["2026-10-12T15:37:42.123Z", "2026-10-12T00:00:00.000Z", "2026-11-11T00:00:00.000Z"],
    ["2026-10-12T23:59:59.999Z", "2026-10-12T00:00:00.000Z", "2026-11-11T00:00:00.000Z"],
    ["2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z", "2026-11-12T00:00:00.000Z"],
    ["2028-02-10T08:00:00.000Z", "2028-02-10T00:00:00.000Z", "2028-03-11T00:00:00.000Z"], // leap year
    ["2027-02-10T08:00:00.000Z", "2027-02-10T00:00:00.000Z", "2027-03-12T00:00:00.000Z"],
    ["2026-12-20T08:00:00.000Z", "2026-12-20T00:00:00.000Z", "2027-01-19T00:00:00.000Z"], // year end
    ["2026-03-29T01:30:00.000Z", "2026-03-29T00:00:00.000Z", "2026-04-28T00:00:00.000Z"], // a daylight-saving day elsewhere
  ])("%s: today starts %s, the window ends before %s", (now, today, until) => {
    const range = dayRange(new Date(now));

    expect(range.today.toISOString()).toBe(today);
    expect(range.until.toISOString()).toBe(until);
    expect(range.until.getTime() - range.today.getTime()).toBe(30 * DAY);
  });
});

describe("what the service asks the repository", () => {
  const counters: VillaCounterRow = {
    total: 10n,
    overdue: 1n,
    upcoming: 2n,
    mewFollowUp: 3n,
    mewInspection: 0n,
  };
  const progress: ProgressCounterRow = {
    progressSum: 250n,
    phaseCount: 5n,
    notStarted: 4n,
    inProgress: 5n,
    done: 1n,
  };
  const areas: AreaCountRow[] = [{ areaId: "a1", area: "A", city: "Cairo", total: 2n }];
  const contractors: ContractorCountRow[] = [{ id: "c1", name: "C", total: 3n }];

  function mocked() {
    const db = { marker: "snapshot" };
    const repository = {
      snapshot: vi.fn(async (work: (d: unknown) => Promise<unknown>) => work(db)),
      grantedCodes: vi.fn().mockResolvedValue([]),
      villaCounters: vi.fn().mockResolvedValue(counters),
      progressCounters: vi.fn().mockResolvedValue(progress),
      areaBreakdown: vi.fn().mockResolvedValue(areas),
      topContractors: vi.fn().mockResolvedValue(contractors),
      openWorkCounters: vi.fn().mockResolvedValue({
        total: 10n,
        notStarted: 1n,
        inProgress: 2n,
        delayed: 3n,
        done: 4n,
        overdue: 5n,
      }),
      openWorkOverdue: vi.fn().mockResolvedValue([]),
      dailyReportCounters: vi.fn().mockResolvedValue({ today: 6n, last7Days: 7n }),
      smallWorkCounters: vi.fn().mockResolvedValue({ total: 12n, pending: 8n, dueSoon: 2n, overdue: 1n }),
      smallWorkUrgent: vi.fn().mockResolvedValue([]),
      siteReportCounters: vi.fn().mockResolvedValue({ total: 4n, ratingSum: 15n }),
      labourCounters: vi.fn().mockResolvedValue({ today: 90n, last7Days: 600n, total: 1n }),
      dailyReportWorkers: vi.fn().mockResolvedValue({ total: 9000n }),
      maintenanceCounters: vi.fn().mockResolvedValue({ open: 3n, solved: 1n }),
      recentAudit: vi.fn().mockResolvedValue([]),
    };
    return {
      db,
      repository,
      service: new DashboardService(repository as unknown as DashboardRepository, () => NOW),
    };
  }

  it("reads every section inside one snapshot", async () => {
    const { db, repository, service: svc } = mocked();

    await svc.summary(ADMIN);

    expect(repository.snapshot).toHaveBeenCalledTimes(1);
    expect(repository.villaCounters.mock.calls[0]?.[1]).toBe(db);
    expect(repository.progressCounters.mock.calls[0]?.[0]).toBe(db);
    expect(repository.areaBreakdown.mock.calls[0]?.[0]).toBe(db);
    expect(repository.topContractors.mock.calls[0]?.[0]).toBe(db);
    expect(repository.openWorkCounters.mock.calls[0]?.[1]).toBe(db);
    expect(repository.dailyReportCounters.mock.calls[0]?.[1]).toBe(db);
    expect(repository.smallWorkCounters.mock.calls[0]?.[1]).toBe(db);
    expect(repository.smallWorkUrgent.mock.calls[0]?.[2]).toBe(db);
    expect(repository.siteReportCounters.mock.calls[0]?.[0]).toBe(db);
    expect(repository.labourCounters.mock.calls[0]?.[1]).toBe(db);
  });

  it("an ADMIN needs no permission lookup: the role holds them all", async () => {
    const { repository, service: svc } = mocked();

    await svc.summary(ADMIN);

    expect(repository.grantedCodes).not.toHaveBeenCalled();
  });

  it("an employee's codes are read once, inside the same snapshot", async () => {
    const { db, repository, service: svc } = mocked();
    repository.grantedCodes.mockResolvedValue(["villas:read"]);

    await svc.summary({ id: "user-1", role: "EMPLOYEE" });

    expect(repository.grantedCodes).toHaveBeenCalledTimes(1);
    expect(repository.grantedCodes).toHaveBeenCalledWith("user-1", db);
  });

  it("passes the start of today, the end of the window and the start of the week, from the clock", async () => {
    const { repository, service: svc } = mocked();

    await svc.summary(ADMIN);

    const range = {
      today: TODAY,
      until: new Date(TODAY.getTime() + 30 * DAY),
      weekStart: new Date(TODAY.getTime() - 6 * DAY),
    };
    expect(repository.villaCounters.mock.calls[0]?.[0]).toEqual(range);
    expect(repository.openWorkCounters.mock.calls[0]?.[0]).toEqual(TODAY);
    expect(repository.dailyReportCounters.mock.calls[0]?.[0]).toEqual(range);
    expect(repository.labourCounters.mock.calls[0]?.[0]).toEqual(range);
  });

  it.each([
    ["Asia/Kuwait", 8, { today: "2026-10-12", horizon: "2026-10-13" }],
    ["Asia/Kuwait", 1, { today: "2026-10-12", horizon: "2026-10-12" }],
    ["Pacific/Auckland", 8, { today: "2026-10-13", horizon: "2026-10-13" }],
    ["UTC", 12, { today: "2026-10-12", horizon: "2026-10-13" }],
  ])(
    "counts the small works against the days of the zone and the alert hours: %s, %s hours",
    async (timeZone, hoursBefore, window) => {
      const { repository } = mocked();
      const svc = new DashboardService(repository as unknown as DashboardRepository, () => NOW, {
        timeZone,
        hoursBefore,
      });

      await svc.summary(ADMIN);

      expect(repository.smallWorkCounters.mock.calls[0]?.[0]).toEqual(window);
      expect(repository.smallWorkUrgent.mock.calls[0]?.[0]).toEqual(window);
    },
  );

  it("turns database counts (bigint) into plain numbers", async () => {
    const { service: svc } = mocked();

    const summary = full(await svc.summary(ADMIN));

    expect(summary.villas).toEqual({ total: 10 });
    // The villas' overall progress adds up to 250, over 10 villas.
    expect(summary.progress).toEqual({ average: 25, notStarted: 4, inProgress: 5, done: 1 });
    expect(summary.overdue).toEqual({ count: 1 });
    expect(summary.upcoming).toEqual({ count: 2 });
    expect(summary.mewFollowUp).toEqual({ count: 3 });
    expect(summary.byArea).toEqual([{ areaId: "a1", area: "A", city: "Cairo", total: 2 }]);
    expect(summary.topContractors[0]).toEqual({ id: "c1", name: "C", total: 3 });
    expect(summary.openWorks).toEqual({
      total: 10,
      delayed: 3,
      byStatus: { NOT_STARTED: 1, IN_PROGRESS: 2, DELAYED: 3, DONE: 4 },
      overdue: 5,
      overdueList: [],
    });
    expect(summary.dailyReports).toEqual({ today: 6, last7Days: 7 });
    expect(summary.smallWorks).toEqual({ total: 12, pending: 8, dueSoon: 2, overdue: 1, urgent: [] });
    // 15 over 4 reports is 3.75, shown with one decimal, halves up.
    expect(summary.siteReports).toEqual({ count: 4, averageRating: 3.8 });
    expect(summary.labour).toEqual({ today: 90, last7Days: 600 });
    expect(summary.totalLabour).toEqual({ total: 9000 });
    expect(summary.delayedSmallWorks).toEqual({ overdue: 1, dueSoon: 2 });
    expect(JSON.stringify(summary)).not.toMatch(/\dn\b/);
  });

  it("maps plain numbers as well as bigints", () => {
    const summary = toSummaryDto(
      {
        villas: {
          counters: { total: 7, overdue: 0, upcoming: 3, mewFollowUp: 2, mewInspection: 0 },
          progress: { progressSum: 0, phaseCount: 0, notStarted: 7, inProgress: 0, done: 0 },
          areas: [],
        },
        contractors: [],
        openWorks: null,
        dailyReports: null,
        smallWorks: null,
        delayedSmallWorks: null,
        siteReports: null,
        labour: null,
        totalLabour: null,
        maintenance: null,
      },
      NOW,
      {
        window: { today: "2026-10-12", horizon: "2026-10-12" },
        policy: { timeZone: "Asia/Kuwait", hoursBefore: 8 },
      },
    );

    expect(summary.villas).toEqual({ total: 7 });
    expect(summary.overdue).toEqual({ count: 0 });
    expect(summary.upcoming).toEqual({ count: 3 });
    expect(summary.mewFollowUp).toEqual({ count: 2 });
  });

  it("makes no change to the database: it only reads", async () => {
    const { repository, service: svc } = mocked();

    await svc.summary(ADMIN);
    await svc.recentActivity(5);

    expect(Object.keys(repository).sort()).toEqual([
      "areaBreakdown",
      "dailyReportCounters",
      "dailyReportWorkers",
      "grantedCodes",
      "labourCounters",
      "maintenanceCounters",
      "openWorkCounters",
      "openWorkOverdue",
      "progressCounters",
      "recentAudit",
      "siteReportCounters",
      "smallWorkCounters",
      "smallWorkUrgent",
      "snapshot",
      "topContractors",
      "villaCounters",
    ]);
  });
});

describe("recent activity", () => {
  const user = () =>
    store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  const at2 = (minute: number) => new Date(Date.UTC(2026, 9, 12, 10, minute));

  it("returns the newest rows first, in the audit list item shape, without before and after", async () => {
    const admin = user();
    addAuditRow({
      action: "villa.create",
      entity: "Villa",
      entityId: "p1",
      actorId: admin.id,
      createdAt: at2(1),
      ip: "203.0.113.5",
      userAgent: "ua",
      requestId: "r1",
      before: { a: 1 },
      after: { b: 2 },
    });
    addAuditRow({ action: "auth.login", entity: "User", createdAt: at2(3) });
    addAuditRow({
      action: "villa.update",
      entity: "Villa",
      entityId: "p1",
      actorId: admin.id,
      createdAt: at2(2),
    });

    const rows = await service().recentActivity();

    expect(rows.map((r) => r.action)).toEqual(["auth.login", "villa.update", "villa.create"]);
    expect(rows[2]).toEqual({
      id: expect.any(String),
      actor: { id: admin.id, name: "Root Admin", email: "root@example.test" },
      action: "villa.create",
      actionLabel: "Created a villa",
      entity: "Villa",
      entityCode: "Villa",
      entityId: "p1",
      entityName: null,
      entityDetail: null,
      ip: "203.0.113.5",
      userAgent: "ua",
      requestId: "r1",
      createdAt: "2026-10-12T10:01:00.000Z",
    });
    expect(rows[0]!.actor).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/"before"|"after"/);
  });

  it("names a user entry by the user's name and tells them apart by their email", async () => {
    const admin = user();
    addAuditRow({
      action: "user.update",
      entity: "User",
      entityId: admin.id,
      actorId: admin.id,
      createdAt: at2(1),
    });
    addAuditRow({ action: "villa.update", entity: "Villa", entityId: "p1", createdAt: at2(0) });

    const rows = await service().recentActivity();

    expect(rows[0]).toMatchObject({ entityName: "Root Admin", entityDetail: "root@example.test" });
    expect(rows[1]).toMatchObject({ entityName: null, entityDetail: null });
  });

  it("returns 20 rows by default and as many as asked up to the limit it is given", async () => {
    for (let i = 0; i < 60; i++) addAuditRow({ action: "x", entity: "E", createdAt: at2(i) });

    expect(await service().recentActivity()).toHaveLength(20);
    expect(await service().recentActivity(1)).toHaveLength(1);
    expect(await service().recentActivity(50)).toHaveLength(50);
  });

  it("returns what exists when there are fewer rows than the limit", async () => {
    for (let i = 0; i < 3; i++) addAuditRow({ action: "x", entity: "E", createdAt: at2(i) });

    expect(await service().recentActivity(50)).toHaveLength(3);
  });

  it("orders rows with the same time by id, so the order never changes between calls", async () => {
    const same = at2(5);
    for (const id of ["c", "a", "b"]) addAuditRow({ id, action: "x", entity: "E", createdAt: same });

    expect((await service().recentActivity()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("asks the repository for exactly the limit it was given", async () => {
    const repository = { recentAudit: vi.fn().mockResolvedValue([]) };
    const svc = new DashboardService(repository as unknown as DashboardRepository, () => NOW);

    await svc.recentActivity(7);
    await svc.recentActivity();

    expect(repository.recentAudit.mock.calls.map(([limit]) => limit)).toEqual([7, 20]);
  });
});
