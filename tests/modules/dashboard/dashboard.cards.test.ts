import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { addDailyLabour } from "../daily-labour/in-memory-daily-labour.repository.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { addDailyReport } from "../daily-reports/in-memory-daily-reports.repository.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { addWorkItem } from "../open-works/in-memory-open-works.repository.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { addSiteReport } from "../site-reports/in-memory-site-reports.repository.js";
import { siteReportTables } from "../site-reports/site-report-tables.js";
import { addSmallWork } from "../small-works/in-memory-small-works.repository.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { InMemoryDashboardRepository } from "./in-memory-dashboard.repository.js";
import { DashboardService } from "../../../src/modules/dashboard/service/dashboard.service.js";
import {
  CARD_PERMISSIONS,
  type DashboardCard,
  type DashboardSummaryDto,
} from "../../../src/modules/dashboard/dto/dashboard.dto.js";
import type { DashboardRepository } from "../../../src/modules/dashboard/repository/dashboard.repository.js";

// 2026-10-12 (a Monday) is "today"; the instant within the day is varied where it matters.
const NOW = new Date("2026-10-12T15:37:42.123Z");
const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 12);
const day = (offset: number): Date => new Date(TODAY + offset * DAY);

const ADMIN = { id: "admin-id", role: "ADMIN" } as const;
const KUWAIT = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const service = (now: Date = NOW) =>
  new DashboardService(
    new InMemoryDashboardRepository() as unknown as DashboardRepository,
    () => now,
    KUWAIT,
  );
const adminSummary = async (now: Date = NOW) => {
  const summary = await service(now).summary(ADMIN);
  return {
    openWorks: summary.openWorks!,
    dailyReports: summary.dailyReports!,
    smallWorks: summary.smallWorks!,
    siteReports: summary.siteReports!,
    labour: summary.labour!,
  };
};

let villaId: string;
let contractorId: string;
let engineerId: string;
beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  electricalTables.reset();
  workItemTables.reset();
  dailyReportTables.reset();
  smallWorkTables.reset();
  siteReportTables.reset();
  dailyLabourTables.reset();
  villaId = addVilla({ civilEngineerId: "eng", area: "Area" }).id;
  contractorId = addContractor({ name: "Nile Builders" }).id;
  engineerId = addElectricalEngineer({ name: "Omar Khaled" }).id;
});

describe("open works", () => {
  const item = (status: "NOT_STARTED" | "IN_PROGRESS" | "DELAYED" | "DONE", endDate: Date | null = null) =>
    addWorkItem({ villaId, status, endDate });

  it("counts the items of each status, and the four add up to all of them", async () => {
    item("NOT_STARTED");
    item("NOT_STARTED");
    item("IN_PROGRESS");
    item("DELAYED");
    item("DELAYED");
    item("DELAYED");
    item("DONE");

    const { openWorks } = await adminSummary();

    expect(openWorks.byStatus).toEqual({ NOT_STARTED: 2, IN_PROGRESS: 1, DELAYED: 3, DONE: 1 });
    expect(Object.values(openWorks.byStatus).reduce((sum, n) => sum + n, 0)).toBe(
      workItemTables.items.length,
    );
  });

  it("is overdue when the end date is before today and the item is not done", async () => {
    item("IN_PROGRESS", day(-1));
    item("DELAYED", day(-30));
    item("NOT_STARTED", day(-1));

    expect((await adminSummary()).openWorks.overdue).toBe(3);
  });

  it("an end date of today is not overdue until midnight in Kuwait (21:00 UTC)", async () => {
    item("IN_PROGRESS", day(0));

    expect((await adminSummary(new Date("2026-10-12T20:59:59.999Z"))).openWorks.overdue).toBe(0);
    expect((await adminSummary(new Date("2026-10-12T21:00:00.000Z"))).openWorks.overdue).toBe(1);
  });

  it("lists up to 5 overdue items, the most overdue first, with the days each is late", async () => {
    for (const offset of [-1, -9, -3, -2, -6, -4]) item("IN_PROGRESS", day(offset));
    item("DONE", day(-20));

    const { overdueList } = (await adminSummary()).openWorks;

    expect(overdueList.map((row) => row.overdueDays)).toEqual([9, 6, 4, 3, 2]);
    expect(overdueList[0]).toMatchObject({ endDate: "2026-10-03", contractor: null });
  });

  it("counts every item in total, whatever its status, and the delayed ones apart", async () => {
    item("NOT_STARTED");
    item("IN_PROGRESS");
    item("DELAYED");
    item("DELAYED", day(-3));
    item("DONE");

    const { openWorks } = await adminSummary();

    expect(openWorks.total).toBe(5);
    expect(openWorks.delayed).toBe(2);
    expect(openWorks.delayed).toBe(openWorks.byStatus.DELAYED);
    expect(openWorks.total).toBe(Object.values(openWorks.byStatus).reduce((sum, n) => sum + n, 0));
  });

  it("has a total and a delayed count of 0 when there is no item", async () => {
    expect((await adminSummary()).openWorks).toMatchObject({ total: 0, delayed: 0 });
  });

  it("a done item is never overdue, and an item with no end date is never overdue", async () => {
    item("DONE", day(-40));
    item("IN_PROGRESS", null);
    item("DELAYED", day(5));

    expect((await adminSummary()).openWorks.overdue).toBe(0);
  });
});

describe("daily reports", () => {
  // One contractor writes one report a day, so each report here is a contractor's own.
  let writers = 0;
  const report = (offset: number) =>
    addDailyReport({
      contractorId: addContractor({ name: `Writer ${++writers}` }).id,
      preparedByEngineerId: engineerId,
      reportDate: day(offset),
    });

  it("the total labour card adds up the workers of every labour daily report, all dates", async () => {
    report(0).workersCount = 12;
    report(-1).workersCount = 30;
    report(-400).workersCount = 8;

    expect((await service().summary(ADMIN)).totalLabour).toEqual({ total: 50 });
  });

  it("counts the reports written for today", async () => {
    report(0);
    report(0);
    report(-1);

    expect((await adminSummary()).dailyReports.today).toBe(2);
  });

  it("the last 7 days are today and the six days before it: the sixth day back is in, the seventh is out", async () => {
    report(-7);
    report(-6);
    report(-3);
    report(0);

    expect((await adminSummary()).dailyReports.last7Days).toBe(3);
  });

  it("a report dated tomorrow is in neither figure", async () => {
    report(1);
    report(0);

    expect((await adminSummary()).dailyReports).toEqual({ today: 1, last7Days: 1 });
  });

  it("the window moves with the clock, in UTC days", async () => {
    report(-6);

    expect((await adminSummary(new Date("2026-10-12T23:59:59.999Z"))).dailyReports.last7Days).toBe(1);
    expect((await adminSummary(new Date("2026-10-13T00:00:00.000Z"))).dailyReports.last7Days).toBe(0);
  });

  it("counts the reports of every contractor", async () => {
    const other = addContractor({ name: "Delta Works" }).id;
    report(0);
    addDailyReport({ contractorId: other, preparedByEngineerId: engineerId, reportDate: day(0) });

    expect((await adminSummary()).dailyReports.today).toBe(2);
  });
});

describe("daily small works", () => {
  // NOW is 2026-10-12 15:37Z = 18:37 in Kuwait: today there is 2026-10-12, and 8 hours on it is already the 13th.
  const work = (
    status: "PENDING" | "DONE",
    endOffset: number,
    overrides: Partial<Parameters<typeof addSmallWork>[0]> = {},
  ) =>
    addSmallWork({
      villaId,
      contractorId,
      status,
      startDate: day(endOffset - 1),
      endDate: day(endOffset),
      ...overrides,
    });

  it("counts every work in total, whatever its status, and the pending ones apart", async () => {
    work("PENDING", 3);
    work("PENDING", 4);
    work("DONE", -1);

    expect((await adminSummary()).smallWorks).toMatchObject({ total: 3, pending: 2 });
  });

  it("counts the pending ones over all time, and leaves out the done ones", async () => {
    work("PENDING", -400);
    work("PENDING", 0);
    work("DONE", 0);

    expect((await adminSummary()).smallWorks).toMatchObject({ pending: 2 });
  });

  it("counts overdue (the end date is before today in Kuwait) and due soon (today, or in the next 8 hours' day)", async () => {
    work("PENDING", -1); // overdue
    work("PENDING", -400); // overdue
    work("PENDING", 0); // ends today: due soon
    work("PENDING", 1); // ends tomorrow, which is where 8 hours from now falls: not due soon yet
    work("PENDING", 2);
    work("DONE", -1);
    work("DONE", 0);

    expect((await adminSummary()).smallWorks).toMatchObject({ pending: 5, overdue: 2, dueSoon: 1 });
  });

  it("moves a work from due soon to overdue exactly at midnight in Kuwait", async () => {
    work("PENDING", 0);
    const counts = async (now: string) => {
      const { dueSoon, overdue } = (await adminSummary(new Date(now))).smallWorks;
      return [dueSoon, overdue];
    };

    // 2026-10-12 ends at 2026-10-12 21:00:00Z.
    expect(await counts("2026-10-12T20:59:59.000Z")).toEqual([1, 0]);
    expect(await counts("2026-10-12T21:00:00.000Z")).toEqual([0, 1]);
    // Eight hours before: 13:00Z.
    expect(await counts("2026-10-12T12:59:59.000Z")).toEqual([0, 0]);
    expect(await counts("2026-10-12T13:00:00.000Z")).toEqual([1, 0]);
  });

  it("lists the most urgent first: the earliest end date, then the oldest row, with what the page shows", async () => {
    const delta = addContractor({ name: "Delta Co" });
    const b = work("PENDING", 0, {
      description: "Paint",
      contractorId: delta.id,
      createdAt: new Date("2026-10-01T10:00:00Z"),
    });
    const a = work("PENDING", -3, { description: "Plaster" });
    work("PENDING", 5); // not due soon
    work("DONE", -9); // done
    const c = work("PENDING", 0, { description: "Tiles", createdAt: new Date("2026-10-01T11:00:00Z") });

    const { urgent } = (await adminSummary()).smallWorks;

    expect(urgent.map((item) => item.id)).toEqual([a.id, b.id, c.id]);
    expect(urgent[0]).toEqual({
      id: a.id,
      villa: { id: villaId, villaNumber: expect.any(String) },
      description: "Plaster",
      contractor: { id: contractorId, name: "Nile Builders" },
      endDate: "2026-10-09",
      deadlineAt: "2026-10-09T21:00:00.000Z",
      alert: "overdue",
    });
    expect(urgent[1]).toMatchObject({ contractor: { name: "Delta Co" }, alert: "dueSoon" });
  });

  it("lists at most 5, and none when nothing is urgent", async () => {
    expect((await adminSummary()).smallWorks.urgent).toEqual([]);
    for (let i = 0; i < 8; i++) work("PENDING", -i);

    const { urgent, overdue } = (await adminSummary()).smallWorks;

    expect(overdue).toBe(7);
    expect(urgent).toHaveLength(5);
    expect(urgent.map((item) => item.endDate)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });
});

describe("site reports", () => {
  const rate = (...ratings: number[]) => ratings.forEach((rating) => addSiteReport({ villaId, rating }));

  it("counts every report, over all time", async () => {
    addSiteReport({ villaId, visitDate: day(-900) });
    addSiteReport({ villaId, visitDate: day(0) });

    expect((await adminSummary()).siteReports.count).toBe(2);
  });

  it("has no average when there is no report (null, not 0)", async () => {
    expect((await adminSummary()).siteReports).toEqual({ count: 0, averageRating: null });
  });

  it.each([
    [[5], 5],
    [[5, 4], 4.5],
    [[1, 1, 2], 1.3],
    [[5, 5, 4], 4.7],
    [[3, 4, 4, 4], 3.8],
    [[1, 2], 1.5],
    [[1, 1], 1],
  ])("the ratings %j average %s, with one decimal", async (ratings, average) => {
    rate(...ratings);

    expect((await adminSummary()).siteReports.averageRating).toBe(average);
  });
});

describe("daily labour", () => {
  const labour = (offset: number, labourCount: number, contractorId = "c1") =>
    addDailyLabour({ villaId, contractorId, labourDate: day(offset), labourCount });

  it("adds up the labourers, not the rows", async () => {
    labour(0, 40, "c1");
    labour(0, 25, "c2");
    labour(-1, 10);

    expect((await adminSummary()).labour).toEqual({ today: 65, last7Days: 75 });
    // The daily labour entries do not feed the total labour card: it adds up the labour daily reports.
    expect((await service().summary(ADMIN)).totalLabour).toEqual({ total: 0 });
  });

  it("the last 7 days are today and the six before it", async () => {
    labour(-7, 1000);
    labour(-6, 7);
    labour(0, 3);

    expect((await adminSummary()).labour.last7Days).toBe(10);
  });

  it("a row dated tomorrow is in neither figure, and a row of 0 adds nothing", async () => {
    labour(1, 500);
    labour(0, 0);

    expect((await adminSummary()).labour).toEqual({ today: 0, last7Days: 0 });
  });
});

describe("what each user may see", () => {
  const KEYS = [
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
    "delayedSmallWorks",
    "siteReports",
    "labour",
    "totalLabour",
    "maintenance",
  ] as const;
  // The keys each card fills.
  const CARD_KEYS: Record<DashboardCard, readonly (typeof KEYS)[number][]> = {
    villas: ["villas", "progress", "overdue", "upcoming", "mewFollowUp", "mewInspection", "byArea"],
    topContractors: ["topContractors"],
    openWorks: ["openWorks"],
    dailyReports: ["dailyReports"],
    smallWorks: ["smallWorks"],
    delayedSmallWorks: ["delayedSmallWorks"],
    siteReports: ["siteReports"],
    labour: ["labour"],
    totalLabour: ["totalLabour"],
    maintenance: ["maintenance"],
  };

  const employee = (...codes: string[]) => {
    const user = store.addUser({
      name: "Some Employee",
      email: `e${store.users.length}@example.test`,
      passwordHash: "x",
    });
    store.grant(user.id, ...codes);
    return { id: user.id, role: "EMPLOYEE" } as const;
  };
  const nullKeys = (summary: DashboardSummaryDto): string[] => KEYS.filter((key) => summary[key] === null);

  it("a card needs every permission listed for it, and the listing is the one the plan agreed", () => {
    expect(CARD_PERMISSIONS).toEqual({
      villas: ["villas:read"],
      topContractors: ["villas:read", "contractors:read"],
      openWorks: ["open-works:read"],
      dailyReports: ["daily-reports:read"],
      smallWorks: ["small-works:read"],
      delayedSmallWorks: ["small-works:read"],
      siteReports: ["site-reports:read"],
      labour: ["daily-labour:read"],
      totalLabour: ["daily-reports:read"],
      maintenance: ["maintenance:read"],
    });
  });

  it("an ADMIN with no grant at all sees every card", async () => {
    expect(nullKeys(await service().summary(ADMIN))).toEqual([]);
  });

  it("an employee with no permission sees no card: every key is null, and only generatedAt is left", async () => {
    const summary = await service().summary(employee());

    expect(summary).toEqual({
      villas: null,
      progress: null,
      overdue: null,
      upcoming: null,
      mewFollowUp: null,
      mewInspection: null,
      byArea: null,
      topContractors: null,
      openWorks: null,
      dailyReports: null,
      smallWorks: null,
      delayedSmallWorks: null,
      siteReports: null,
      labour: null,
      totalLabour: null,
      maintenance: null,
      generatedAt: NOW.toISOString(),
    });
  });

  it("dashboard:read itself opens no card: the endpoint only", async () => {
    expect(nullKeys(await service().summary(employee("dashboard:read")))).toEqual([...KEYS]);
  });

  it.each([
    ["villas:read", ["villas"]],
    ["open-works:read", ["openWorks"]],
    ["daily-reports:read", ["dailyReports", "totalLabour"]],
    ["small-works:read", ["smallWorks", "delayedSmallWorks"]],
    ["site-reports:read", ["siteReports"]],
    ["daily-labour:read", ["labour"]],
  ] as const)("%s opens exactly its card(s)", async (code, cards) => {
    const summary = await service().summary(employee(code));
    const expected = cards.flatMap((card) => CARD_KEYS[card]);

    expect(KEYS.filter((key) => summary[key] !== null)).toEqual(expected);
  });

  it("the top contractors need villas:read AND contractors:read: neither alone is enough", async () => {
    expect((await service().summary(employee("villas:read"))).topContractors).toBeNull();
    expect((await service().summary(employee("contractors:read"))).topContractors).toBeNull();
    expect((await service().summary(employee("villas:read", "contractors:read"))).topContractors).toEqual([]);
  });

  it("contractors:read alone opens no card at all", async () => {
    expect(nullKeys(await service().summary(employee("contractors:read")))).toEqual([...KEYS]);
  });

  it("the write, export and detail permissions of a resource do not open its card", async () => {
    const summary = await service().summary(
      employee(
        "villas:detail",
        "villas:create",
        "villas:export",
        "open-works:update",
        "open-works:export",
        "daily-reports:create",
        "daily-reports:export",
        "small-works:delete",
        "site-reports:import",
        "daily-labour:update",
        "daily-labour:export",
      ),
    );

    expect(nullKeys(summary)).toEqual([...KEYS]);
  });

  it("every permission together opens every card", async () => {
    const all = employee(
      "villas:read",
      "contractors:read",
      "open-works:read",
      "daily-reports:read",
      "small-works:read",
      "site-reports:read",
      "daily-labour:read",
      "maintenance:read",
    );

    expect(nullKeys(await service().summary(all))).toEqual([]);
  });

  it("an empty card the user may see is zeros (or an empty list), never null", async () => {
    const summary = await service().summary(employee("open-works:read", "site-reports:read"));

    expect(summary.openWorks).toEqual({
      total: 0,
      delayed: 0,
      byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 0, DONE: 0 },
      overdue: 0,
      overdueList: [],
    });
    expect(summary.siteReports).toEqual({ count: 0, averageRating: null });
  });

  it("uses the grants of the user who asks, not of another employee", async () => {
    const other = employee("open-works:read", "daily-labour:read");
    const me = employee("small-works:read");

    expect(nullKeys(await service().summary(me)).includes("smallWorks")).toBe(false);
    expect((await service().summary(me)).openWorks).toBeNull();
    expect((await service().summary(other)).smallWorks).toBeNull();
  });

  it("figures a card holds are the same for every user who may see it", async () => {
    addSmallWork({ villaId, contractorId, status: "PENDING" });
    addSiteReport({ villaId, rating: 4 });

    const a = await service().summary(employee("small-works:read"));
    const b = await service().summary(employee("small-works:read", "site-reports:read"));

    expect(a.smallWorks).toMatchObject({ pending: 1 });
    expect(b.smallWorks).toEqual(a.smallWorks);
    expect(a.siteReports).toBeNull();
    expect(b.siteReports).toEqual({ count: 1, averageRating: 4 });
  });

  it("does not read a card the user may not see", async () => {
    const reads = {
      snapshot: vi.fn(async (work: (db: unknown) => Promise<unknown>) => work(undefined)),
      grantedCodes: vi.fn().mockResolvedValue(["open-works:read", "villas:read"]),
      villaCounters: vi
        .fn()
        .mockResolvedValue({ total: 0, overdue: 0, upcoming: 0, mewFollowUp: 0, mewInspection: 0 }),
      progressCounters: vi
        .fn()
        .mockResolvedValue({ progressSum: 0, phaseCount: 0, notStarted: 0, inProgress: 0, done: 0 }),
      areaBreakdown: vi.fn().mockResolvedValue([]),
      topContractors: vi.fn().mockResolvedValue([]),
      openWorkCounters: vi
        .fn()
        .mockResolvedValue({ total: 0, notStarted: 0, inProgress: 0, delayed: 0, done: 0, overdue: 0 }),
      openWorkOverdue: vi.fn().mockResolvedValue([]),
      dailyReportCounters: vi.fn().mockResolvedValue({ today: 0, last7Days: 0 }),
      smallWorkCounters: vi.fn().mockResolvedValue({ pending: 0, dueSoon: 0, overdue: 0 }),
      smallWorkUrgent: vi.fn().mockResolvedValue([]),
      siteReportCounters: vi.fn().mockResolvedValue({ total: 0, ratingSum: 0 }),
      labourCounters: vi.fn().mockResolvedValue({ today: 0, last7Days: 0, total: 0 }),
    };
    const svc = new DashboardService(reads as unknown as DashboardRepository, () => NOW);

    await svc.summary({ id: "u1", role: "EMPLOYEE" });

    expect(reads.villaCounters).toHaveBeenCalledTimes(1);
    expect(reads.progressCounters).toHaveBeenCalledTimes(1);
    expect(reads.areaBreakdown).toHaveBeenCalledTimes(1);
    expect(reads.openWorkCounters).toHaveBeenCalledTimes(1);
    expect(reads.topContractors).not.toHaveBeenCalled();
    expect(reads.dailyReportCounters).not.toHaveBeenCalled();
    expect(reads.smallWorkCounters).not.toHaveBeenCalled();
    expect(reads.smallWorkUrgent).not.toHaveBeenCalled();
    expect(reads.siteReportCounters).not.toHaveBeenCalled();
    expect(reads.labourCounters).not.toHaveBeenCalled();
  });

  it("a user with nothing granted makes no counting query at all", async () => {
    const reads = {
      snapshot: vi.fn(async (work: (db: unknown) => Promise<unknown>) => work(undefined)),
      grantedCodes: vi.fn().mockResolvedValue([]),
      villaCounters: vi.fn(),
      progressCounters: vi.fn(),
      areaBreakdown: vi.fn(),
      topContractors: vi.fn(),
      openWorkCounters: vi.fn(),
      openWorkOverdue: vi.fn(),
      dailyReportCounters: vi.fn(),
      smallWorkCounters: vi.fn(),
      smallWorkUrgent: vi.fn(),
      siteReportCounters: vi.fn(),
      labourCounters: vi.fn(),
    };

    await new DashboardService(reads as unknown as DashboardRepository, () => NOW).summary({
      id: "u1",
      role: "EMPLOYEE",
    });

    for (const [name, spy] of Object.entries(reads)) {
      if (name !== "snapshot" && name !== "grantedCodes") expect(spy, name).not.toHaveBeenCalled();
    }
  });
});
