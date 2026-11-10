import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areaTables } from "../areas/in-memory-areas.repository.js";
import { addAuditRow } from "../audit/in-memory-audit.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/dashboard/repository/dashboard.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/dashboard/repository/dashboard.repository.js")
  >()),
  DashboardRepository: (await import("./in-memory-dashboard.repository.js")).InMemoryDashboardRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const DAY = 86_400_000;
const NOW = new Date("2026-10-12T15:37:42.123Z");
const TODAY = new Date("2026-10-12T00:00:00.000Z");
const at = (ms: number): Date => new Date(TODAY.getTime() + ms);

let admin: User;

beforeEach(() => {
  // Only Date is faked, so the clock the service reads is fixed and nothing else is slowed down.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

afterEach(() => {
  vi.useRealTimers();
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

const get = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language);

const everyOtherPermission = [
  "villas:read",
  "villas:detail",
  "villas:export",
  "open-works:read",
  "open-works:export",
  "contractors:read",
  "contractors:summary",
  "civil-engineers:read",
  "users:read",
  "villa-documents:download",
];

describe("access control", () => {
  const endpoints = ["/dashboard/summary", "/dashboard/recent-activity"];

  it.each(endpoints)("GET %s requires authentication (401)", async (path) => {
    expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
  });

  it.each(endpoints)("GET %s answers 403 to an employee with no permissions, in Arabic", async (path) => {
    const res = await get(path, employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it.each(endpoints)("GET %s lets the ADMIN through with no granted permissions", async (path) => {
    expect((await get(path)).status).toBe(200);
  });

  it.each(endpoints)(
    "GET %s is not opened by any permission other than the dashboard's own",
    async (path) => {
      const res = await get(path, employee("e@example.test", ...everyOtherPermission, "audit:read"));

      expect(res.status).toBe(403);
    },
  );

  it("the summary needs dashboard:read only", async () => {
    const res = await get("/dashboard/summary", employee("e@example.test", "dashboard:read"));

    expect(res.status).toBe(200);
  });

  it("dashboard:read alone cannot open the recent activity (403)", async () => {
    const res = await get("/dashboard/recent-activity", employee("e@example.test", "dashboard:read"), "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it("audit:read alone opens neither the summary nor the recent activity", async () => {
    const user = employee("e@example.test", "audit:read");

    expect((await get("/dashboard/summary", user)).status).toBe(403);
    expect((await get("/dashboard/recent-activity", user)).status).toBe(403);
  });

  it("dashboard:read and audit:read together open both", async () => {
    const user = employee("e@example.test", "dashboard:read", "audit:read");

    expect((await get("/dashboard/summary", user)).status).toBe(200);
    expect((await get("/dashboard/recent-activity", user)).status).toBe(200);
  });

  it("every other permission together, without dashboard:read, opens nothing; without audit:read, only the summary", async () => {
    const withoutDashboard = employee("a@example.test", ...everyOtherPermission, "audit:read");
    const withoutAudit = employee("b@example.test", ...everyOtherPermission, "dashboard:read");

    expect((await get("/dashboard/summary", withoutDashboard)).status).toBe(403);
    expect((await get("/dashboard/recent-activity", withoutDashboard)).status).toBe(403);
    expect((await get("/dashboard/summary", withoutAudit)).status).toBe(200);
    expect((await get("/dashboard/recent-activity", withoutAudit)).status).toBe(403);
  });

  it("checks access before validating the limit", async () => {
    const res = await get("/dashboard/recent-activity?limit=0", employee("e@example.test", "dashboard:read"));

    expect(res.status).toBe(403);
  });

  it("an unknown dashboard path is a plain 404", async () => {
    expect((await get("/dashboard")).status).toBe(404);
    expect((await get("/dashboard/other")).status).toBe(404);
  });
});

describe("GET /dashboard/summary", () => {
  function seed() {
    const c1 = addContractor({ name: "Nile Builders" });
    const c2 = addContractor({ name: "شركة النيل" });
    const make = (overrides: Parameters<typeof addVilla>[0]) =>
      addVilla({ civilEngineerId: "e", ...overrides });
    make({ area: "New Cairo", contractorId: c1.id, targetDate: at(-1) });
    make({ area: "New Cairo", contractorId: c1.id, targetDate: at(0) });
    make({ area: "Sheikh Zayed", contractorId: c2.id, targetDate: at(10 * DAY) });
    make({ area: "القاهرة الجديدة", contractorId: c1.id, targetDate: at(-DAY) });
    make({ area: "6 October", contractorId: c2.id, targetDate: null });
    return { c1, c2 };
  }

  // How an area appears in byArea: its id and city beside the name.
  const where = (area: string) => ({
    areaId: areaTables.areas.find((a) => a.name === area)?.id,
    area,
    city: "Cairo",
  });

  it("returns { data } with every figure", async () => {
    const { c1, c2 } = seed();

    const res = await get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        villas: { total: 5 },
        // No phase exists in this fixture, so no villa has started.
        progress: { average: 0, notStarted: 5, inProgress: 0, done: 0 },
        overdue: { count: 2 },
        upcoming: { count: 2 },
        mewFollowUp: { count: 0 },
        mewInspection: { count: 0 },
        byArea: [
          { ...where("6 October"), total: 1 },
          { ...where("New Cairo"), total: 2 },
          { ...where("Sheikh Zayed"), total: 1 },
          { ...where("القاهرة الجديدة"), total: 1 },
        ].sort((a, b) => b.total - a.total || (a.area < b.area ? -1 : 1)),
        topContractors: [
          { id: c1.id, name: "Nile Builders", total: 3 },
          { id: c2.id, name: "شركة النيل", total: 2 },
        ],
        openWorks: {
          total: 0,
          delayed: 0,
          byStatus: { NOT_STARTED: 0, IN_PROGRESS: 0, DELAYED: 0, DONE: 0 },
          overdue: 0,
          overdueList: [],
        },
        dailyReports: { today: 0, last7Days: 0 },
        smallWorks: { total: 0, pending: 0, dueSoon: 0, overdue: 0, urgent: [] },
        siteReports: { count: 0, averageRating: null },
        labour: { today: 0, last7Days: 0 },
        totalLabour: { total: 0 },
        maintenance: { open: 0, solved: 0 },
        delayedSmallWorks: { overdue: 0, dueSoon: 0 },
        generatedAt: "2026-10-12T15:37:42.123Z",
      },
    });
  });

  it("has exactly the documented fields, all numbers apart from names and the timestamp", async () => {
    seed();

    const { data } = (await get("/dashboard/summary")).body;

    expect(Object.keys(data)).toEqual([
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
    for (const value of [data.villas.total, data.overdue.count, data.upcoming.count]) {
      expect(typeof value).toBe("number");
    }
    expect(new Date(data.generatedAt).toISOString()).toBe(data.generatedAt);
  });

  it("a villa due today is upcoming, one due before today is overdue, and one with no target date is neither", async () => {
    seed();

    const { data } = (await get("/dashboard/summary")).body;

    // Overdue: today - 1 ms and today - 1 day. Upcoming: today and today + 10 days. The fifth has no target date.
    expect(data.overdue.count).toBe(2);
    expect(data.upcoming.count).toBe(2);
  });

  it("the upcoming window is 30 days from the start of today: the last millisecond is in, the 30th day is out", async () => {
    addVilla({ civilEngineerId: "e", targetDate: at(30 * DAY - 1) });
    addVilla({ civilEngineerId: "e", targetDate: at(30 * DAY) });
    addVilla({ civilEngineerId: "e", targetDate: at(60 * DAY) });

    const { data } = (await get("/dashboard/summary")).body;

    expect(data.upcoming.count).toBe(1);
    expect(data.overdue.count).toBe(0);
  });

  it("an empty database answers 200 with zeros and empty lists", async () => {
    const { data } = (await get("/dashboard/summary")).body;

    expect(data).toEqual({
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
      siteReports: { count: 0, averageRating: null },
      labour: { today: 0, last7Days: 0 },
      totalLabour: { total: 0 },
      maintenance: { open: 0, solved: 0 },
      delayedSmallWorks: { overdue: 0, dueSoon: 0 },
      generatedAt: "2026-10-12T15:37:42.123Z",
    });
  });

  it("villas without a contractor are in the total and the areas, but not in topContractors", async () => {
    const { c1 } = seed();
    addVilla({ civilEngineerId: "e", area: "New Cairo", contractorId: null });

    const { data } = (await get("/dashboard/summary")).body;

    expect(data.villas.total).toBe(6);
    expect(data.topContractors.find((row: { id: string }) => row.id === c1.id).total).toBe(3);
    expect(data.topContractors.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(5);
    expect(data.byArea.reduce((sum: number, area: { total: number }) => sum + area.total, 0)).toBe(6);
  });

  it("every area row adds up to the villa total", async () => {
    seed();

    const { data } = (await get("/dashboard/summary")).body;

    expect(data.byArea.reduce((sum: number, area: { total: number }) => sum + area.total, 0)).toBe(
      data.villas.total,
    );
  });

  it("is global: the figures are the same for everyone who may see them, whoever they are", async () => {
    seed();
    const one = employee("one@example.test", "dashboard:read", "villas:read");
    const two = employee("two@example.test", "dashboard:read", "villas:read", "open-works:read");

    const [a, b, c] = [
      await get("/dashboard/summary", one),
      await get("/dashboard/summary", two),
      await get("/dashboard/summary"),
    ];

    const strip = (res: { body: { data: Record<string, unknown> } }) => ({
      ...res.body.data,
      generatedAt: undefined,
      openWorks: undefined,
      topContractors: undefined,
      dailyReports: undefined,
      smallWorks: undefined,
      delayedSmallWorks: undefined,
      siteReports: undefined,
      labour: undefined,
      totalLabour: undefined,
      maintenance: undefined,
    });
    expect(strip(a)).toEqual(strip(b));
    expect(strip(a)).toEqual(strip(c));
  });

  it("follows the data: moving a target date out of the past takes the villa out of the overdue count", async () => {
    seed();
    const before = (await get("/dashboard/summary")).body.data;

    villaTables.villas[0]!.targetDate = at(100 * DAY);
    const after = (await get("/dashboard/summary")).body.data;

    expect(after.overdue.count).toBe(before.overdue.count - 1);
    expect(after.upcoming.count).toBe(before.upcoming.count);
    expect(after.villas.total).toBe(before.villas.total);
  });

  it("follows the data: re-assigning a villa moves it between contractors", async () => {
    const { c1, c2 } = seed();

    villaTables.villas[0]!.contractorId = c2.id;
    const { data } = (await get("/dashboard/summary")).body;

    expect(data.topContractors).toEqual(
      [
        { id: c1.id, name: "Nile Builders", total: 2 },
        { id: c2.id, name: "شركة النيل", total: 3 },
      ].sort((a, b) => b.total - a.total),
    );
  });

  it("follows the clock: the next day, the villa due today is overdue", async () => {
    seed();

    vi.setSystemTime(new Date("2026-10-13T00:00:00.000Z"));
    const { data } = (await get("/dashboard/summary")).body;

    expect(data.overdue.count).toBe(3);
    expect(data.upcoming.count).toBe(1);
    expect(data.generatedAt).toBe("2026-10-13T00:00:00.000Z");
  });

  it("writes no audit row: looking at the dashboard is not an event", async () => {
    seed();
    const before = store.auditRows.length;

    await get("/dashboard/summary");
    await get("/dashboard/recent-activity");

    expect(store.auditRows).toHaveLength(before);
  });

  it("is JSON, with no personal data in it", async () => {
    seed();

    const res = await get("/dashboard/summary");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.stringify(res.body)).not.toMatch(/email|passwordHash|phone/);
  });
});

describe("GET /dashboard/recent-activity", () => {
  let user: User;
  beforeEach(() => {
    user = employee("viewer@example.test", "dashboard:read", "audit:read");
  });
  const minute = (n: number): Date => new Date(Date.UTC(2026, 9, 12, 10, n));

  it("returns the 20 newest audit rows by default, newest first", async () => {
    for (let i = 0; i < 30; i++) addAuditRow({ action: `a.${i}`, entity: "Villa", createdAt: minute(i) });

    const res = await get("/dashboard/recent-activity", user);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(
      Array.from({ length: 20 }, (_, i) => `a.${29 - i}`),
    );
  });

  it("has the audit list item shape and never before or after", async () => {
    const actor = store.addUser({ name: "Mona", email: "mona@example.test", passwordHash: "x" });
    addAuditRow({
      action: "villa.update",
      entity: "Villa",
      entityId: "p1",
      actorId: actor.id,
      createdAt: minute(1),
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
      requestId: "req-1",
      before: { secret: "before-value" },
      after: { secret: "after-value" },
    });
    addAuditRow({ action: "auth.login", entity: "User", createdAt: minute(2) });

    const res = await get("/dashboard/recent-activity", user);

    expect(res.body.data[1]).toEqual({
      id: expect.any(String),
      actor: { id: actor.id, name: "Mona", email: "mona@example.test" },
      action: "villa.update",
      actionLabel: "Updated a villa",
      entity: "Villa",
      entityCode: "Villa",
      entityId: "p1",
      entityName: null,
      entityDetail: null,
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
      requestId: "req-1",
      createdAt: "2026-10-12T10:01:00.000Z",
    });
    expect(res.body.data[0].actor).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/before|after|secret/);
  });

  it("accepts limits from 1 to 50", async () => {
    for (let i = 0; i < 60; i++) addAuditRow({ action: "x", entity: "E", createdAt: minute(i) });

    for (const limit of [1, 5, 20, 49, 50]) {
      const res = await get(`/dashboard/recent-activity?limit=${limit}`, user);
      expect(res.status, `limit=${limit}`).toBe(200);
      expect(res.body.data, `limit=${limit}`).toHaveLength(limit);
    }
  });

  it.each(["0", "51", "100", "1000", "-1", "abc", "1.5", "", "5&limit=6", "1e2"])(
    "limit=%j is 400, never clamped",
    async (value) => {
      const res = await get(`/dashboard/recent-activity?limit=${value}`, user);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(res.body.details[0].path).toBe("limit");
    },
  );

  it("explains a bad limit in the request language", async () => {
    const en = await get("/dashboard/recent-activity?limit=51", user, "en");
    const ar = await get("/dashboard/recent-activity?limit=51", user, "ar");

    expect(en.body.details[0].message).toBe("Limit must be a whole number from 1 to 50");
    expect(ar.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(ar.body.details[0].message).toBe("يجب أن يكون الحد عددًا صحيحًا من 1 إلى 50");
  });

  it("answers an empty list when there is no audit row", async () => {
    const res = await get("/dashboard/recent-activity", user);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("ADMIN, and an employee holding both permissions, see the same rows", async () => {
    for (let i = 0; i < 5; i++) addAuditRow({ action: "x", entity: "E", createdAt: minute(i) });

    const asAdmin = await get("/dashboard/recent-activity");
    const asEmployee = await get("/dashboard/recent-activity", user);

    expect(asAdmin.body).toEqual(asEmployee.body);
  });
});

describe("GET /dashboard/summary: the cards a user may not see are null", () => {
  const CARD_KEYS = [
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
  ];

  it("dashboard:read alone answers 200 with every key present and null, and the time", async () => {
    const res = await get("/dashboard/summary", employee("e@example.test", "dashboard:read"));

    expect(res.status).toBe(200);
    // A null is in the JSON as a null, not a missing key: the frontend can tell "hidden" from "absent".
    expect(res.text).toContain('"topContractors":null');
    expect(res.body.data).toEqual({
      ...Object.fromEntries(CARD_KEYS.map((key) => [key, null])),
      generatedAt: "2026-10-12T15:37:42.123Z",
    });
  });

  it("one resource's read permission fills its card and leaves every other key null", async () => {
    addVilla({ civilEngineerId: "e", area: "New Cairo" });

    const res = await get("/dashboard/summary", employee("e@example.test", "dashboard:read", "villas:read"));

    expect(res.status).toBe(200);
    const filled = CARD_KEYS.filter((key) => res.body.data[key] !== null);
    expect(filled).toEqual([
      "villas",
      "progress",
      "overdue",
      "upcoming",
      "mewFollowUp",
      "mewInspection",
      "byArea",
    ]);
    expect(res.body.data.villas).toEqual({ total: 1 });
    expect(res.body.data.topContractors).toBeNull();
  });

  it("the top contractors appear only with villas:read and contractors:read together", async () => {
    const c = addContractor({ name: "Nile Builders" });
    addVilla({ civilEngineerId: "e", area: "New Cairo", contractorId: c.id });

    const only = await get(
      "/dashboard/summary",
      employee("a@example.test", "dashboard:read", "contractors:read"),
    );
    const both = await get(
      "/dashboard/summary",
      employee("b@example.test", "dashboard:read", "villas:read", "contractors:read"),
    );

    expect(only.body.data.topContractors).toBeNull();
    expect(both.body.data.topContractors).toEqual([{ id: c.id, name: "Nile Builders", total: 1 }]);
  });

  it("the ADMIN sees every card, and nothing is null", async () => {
    const { data } = (await get("/dashboard/summary")).body;

    expect(CARD_KEYS.filter((key) => data[key] === null)).toEqual([]);
  });

  it("the recent activity is untouched by the cards: it still needs audit:read as well", async () => {
    const user = employee("e@example.test", "dashboard:read", "villas:read", "open-works:read");

    expect((await get("/dashboard/recent-activity", user)).status).toBe(403);
  });
});
