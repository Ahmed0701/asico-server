import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addDailyReport, dailyReportRaces, dailyReportTables } from "./in-memory-daily-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock(
  "../../../src/modules/daily-reports/repository/daily-reports.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/daily-reports/repository/daily-reports.repository.js")
    >()),
    DailyReportsRepository: (await import("./in-memory-daily-reports.repository.js"))
      .InMemoryDailyReportsRepository,
  }),
);

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();
const KEY = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
// The UTC day `offset` days from today, as the service counts days.
const daysFromToday = (offset: number): string =>
  new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let admin: User;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;
let mona: ReturnType<typeof addElectricalEngineer>;
let karim: ReturnType<typeof addElectricalEngineer>;

beforeEach(() => {
  store.reset();
  contractorTables.reset();
  electricalTables.reset();
  idempotencyTable.reset();
  dailyReportRaces.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  mona = addElectricalEngineer({ name: "Mona Hassan" });
  karim = addElectricalEngineer({ name: "Karim Adel" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch" | "delete";
type Options = { language?: string; body?: unknown; ifMatch?: string; key?: string; user?: User };
const send = async (verb: Verb, path: string, options: Options = {}) => {
  const req = request(app)[verb](`/api/v1${path}`);
  req.set(await as(options.user ?? admin)).set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  if (options.key !== undefined) req.set("Idempotency-Key", options.key);
  return options.body === undefined ? req : req.send(options.body as object);
};

const body = (extra: Record<string, unknown> = {}) => ({
  contractorId: nile.id,
  preparedByEngineerId: mona.id,
  reportDate: "2026-03-04",
  weather: "SUNNY",
  workersCount: 25,
  notes: "Poured the slab",
  ...extra,
});
const create = (extra: Record<string, unknown> = {}, options: Options = {}) =>
  send("post", "/daily-reports", { body: body(extra), ...options });
const made = async (extra: Record<string, unknown> = {}) => (await create(extra)).body.data;
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("access control", () => {
  const ROUTES: [Verb, string, string][] = [
    ["get", "/daily-reports", "daily-reports:read"],
    ["get", `/daily-reports/${MISSING_ID}`, "daily-reports:read"],
    ["post", "/daily-reports", "daily-reports:create"],
    ["patch", `/daily-reports/${MISSING_ID}`, "daily-reports:update"],
    ["delete", `/daily-reports/${MISSING_ID}`, "daily-reports:delete"],
  ];

  it.each(ROUTES)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await request(app)[verb](`/api/v1${path}`).send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it.each(ROUTES)(
    "%s %s answers 403 to an employee with no grant, in Arabic on request",
    async (verb, path) => {
      const res = await send(verb, path, { user: employee("e@example.test"), language: "ar", body: {} });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(ROUTES)(
    "%s %s needs exactly %s, and no other daily-reports permission opens it",
    async (verb, path, code) => {
      const others = [
        "daily-reports:read",
        "daily-reports:create",
        "daily-reports:update",
        "daily-reports:delete",
        "daily-reports:export",
        "daily-reports:import",
      ]
        .filter((other) => other !== code)
        .concat(
          "open-works:read",
          "open-works:update",
          "contractors:read",
          "electrical-engineers:read",
          "villas:read",
          "dashboard:read",
        );

      const denied = await send(verb, path, {
        user: employee("a@example.test", ...others),
        body: {},
        ifMatch: '"1"',
      });
      const allowed = await send(verb, path, {
        user: employee("b@example.test", code),
        body: {},
        ifMatch: '"1"',
      });

      expect(denied.status).toBe(403);
      expect(allowed.status).not.toBe(403);
      expect(allowed.status).not.toBe(401);
    },
  );

  it("checks the permission before the id and the body (a caller without it learns nothing)", async () => {
    const res = await send("patch", "/daily-reports/not-a-uuid", {
      user: employee("e@example.test"),
      body: { x: 1 },
    });

    expect(res.status).toBe(403);
  });

  it("lets an admin do everything without any grant", async () => {
    const report = await made();

    expect((await send("get", "/daily-reports")).status).toBe(200);
    expect((await send("patch", `/daily-reports/${report.id}`, { body: { workersCount: 3 } })).status).toBe(
      200,
    );
    expect((await send("delete", `/daily-reports/${report.id}`)).status).toBe(204);
  });
});

describe("POST /daily-reports", () => {
  it("creates a report with its contractor, engineer, creator, ETag and version 1", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      reportDate: "2026-03-04",
      weather: "SUNNY",
      workersCount: 25,
      notes: "Poured the slab",
      contractor: { id: nile.id, name: "Nile Builders" },
      preparedBy: { id: mona.id, name: "Mona Hassan" },
      createdBy: { id: admin.id, name: "Root Admin" },
      version: 1,
    });
    expect(dailyReportTables.reports).toHaveLength(1);
    expect(dailyReportTables.reports[0]?.createdById).toBe(admin.id);
  });

  it("answers exactly the fields of the contract: no villa, no work done, no issues, no preparer text", async () => {
    const res = await create();

    expect(Object.keys(res.body.data).sort()).toEqual([
      "contractor",
      "createdAt",
      "createdBy",
      "id",
      "notes",
      "preparedBy",
      "reportDate",
      "updatedAt",
      "version",
      "weather",
      "workersCount",
    ]);
  });

  it("takes every field it is given, and trims the notes", async () => {
    const res = await create({
      reportDate: "2026-03-05",
      weather: "DUSTY",
      workersCount: 0,
      notes: "  Cable trays  ",
      contractorId: delta.id,
      preparedByEngineerId: karim.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      reportDate: "2026-03-05",
      weather: "DUSTY",
      workersCount: 0,
      notes: "Cable trays",
      contractor: { id: delta.id, name: "Delta Works" },
      preparedBy: { id: karim.id, name: "Karim Adel" },
    });
  });

  it.each([
    ["notes left out", {}],
    ["notes null", { notes: null }],
    ["notes blank", { notes: "   " }],
    ["notes empty", { notes: "" }],
  ])("stores no notes for %s", async (_name, extra) => {
    const res = await create("notes" in extra ? extra : { notes: undefined });

    expect(res.status).toBe(201);
    expect(res.body.data.notes).toBeNull();
    expect(dailyReportTables.reports[0]?.notes).toBeNull();
  });

  it("accepts the longest values: 100,000 workers and 5,000 characters of notes", async () => {
    const res = await create({ workersCount: 100_000, notes: "n".repeat(5000) });

    expect(res.status).toBe(201);
    expect(res.body.data.notes).toHaveLength(5000);
  });

  it("answers 409 DAILY_REPORT_EXISTS for a second report of the same contractor and day, translated", async () => {
    await create();

    const again = await create({ notes: "Other", preparedByEngineerId: karim.id }, { language: "ar" });

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "DAILY_REPORT_EXISTS",
      message: "هذا المقاول لديه تقرير يومي لهذا التاريخ بالفعل",
    });
    expect(dailyReportTables.reports).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it("allows the same day for another contractor, and another day for the same contractor", async () => {
    expect((await create()).status).toBe(201);
    expect((await create({ contractorId: delta.id })).status).toBe(201);
    expect((await create({ reportDate: "2026-03-05" })).status).toBe(201);
    expect(dailyReportTables.reports).toHaveLength(3);
  });

  it("allows one engineer to prepare the reports of several contractors on one day", async () => {
    expect((await create()).status).toBe(201);
    expect((await create({ contractorId: delta.id })).status).toBe(201);
    expect(dailyReportTables.reports.map((report) => report.preparedByEngineerId)).toEqual([
      mona.id,
      mona.id,
    ]);
  });

  it("turns a report saved by someone else in the middle into 409 DAILY_REPORT_EXISTS: the unique index has the last word", async () => {
    dailyReportRaces.beforeWrite = () => {
      addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: karim.id,
        reportDate: day("2026-03-04"),
      });
    };

    const res = await create();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DAILY_REPORT_EXISTS");
    expect(dailyReportTables.reports).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  describe("the contractor", () => {
    it("answers 404 CONTRACTOR_NOT_FOUND for one that does not exist", async () => {
      const res = await create({ contractorId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("turns a contractor deleted in the middle into 404 CONTRACTOR_NOT_FOUND, writing nothing", async () => {
      dailyReportRaces.beforeWrite = () => {
        contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== nile.id);
      };

      const res = await create();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("answers 400 CONTRACTOR_INACTIVE for one that is switched off, translated", async () => {
      nile.status = "INACTIVE";

      const res = await create({}, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على تقرير يومي",
      });
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("needs no villa at all: any active contractor will do, tied to a villa or not", async () => {
      expect((await create({ contractorId: delta.id })).status).toBe(201);
    });
  });

  describe("the electrical engineer", () => {
    it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND for one that does not exist", async () => {
      const res = await create({ preparedByEngineerId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELECTRICAL_ENGINEER_NOT_FOUND");
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("turns an engineer deleted in the middle into 404 ELECTRICAL_ENGINEER_NOT_FOUND, writing nothing", async () => {
      dailyReportRaces.beforeWrite = () => {
        electricalTables.engineers = electricalTables.engineers.filter((e) => e.id !== mona.id);
      };

      const res = await create();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELECTRICAL_ENGINEER_NOT_FOUND");
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("answers 400 ELECTRICAL_ENGINEER_INACTIVE for one that is switched off, translated", async () => {
      mona.status = "INACTIVE";

      const res = await create({}, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "ELECTRICAL_ENGINEER_INACTIVE",
        message: "هذا المهندس الكهربائي غير نشط ولا يمكن إسناد تقرير يومي إليه",
      });
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("checks the contractor before the engineer", async () => {
      nile.status = "INACTIVE";
      mona.status = "INACTIVE";

      expect((await create()).body.code).toBe("CONTRACTOR_INACTIVE");
    });
  });

  describe("the date", () => {
    it("may be today, yesterday, and tomorrow", async () => {
      expect((await create({ reportDate: daysFromToday(0) })).status).toBe(201);
      expect((await create({ reportDate: daysFromToday(-1) })).status).toBe(201);
      expect((await create({ reportDate: daysFromToday(1) })).status).toBe(201);
    });

    it("may not be more than one day past today: 400 on the reportDate, translated", async () => {
      const res = await create({ reportDate: daysFromToday(2) }, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toEqual([
        { path: "reportDate", message: "لا يمكن أن يزيد تاريخ التقرير عن يوم واحد بعد اليوم" },
      ]);
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("may be long ago", async () => {
      expect((await create({ reportDate: "2020-01-01" })).status).toBe(201);
    });
  });

  describe("request validation (400, nothing is written)", () => {
    it.each([
      ["no contractorId", { contractorId: undefined }, "contractorId"],
      ["a null contractorId", { contractorId: null }, "contractorId"],
      ["a contractorId that is not a UUID", { contractorId: "nope" }, "contractorId"],
      ["no preparedByEngineerId", { preparedByEngineerId: undefined }, "preparedByEngineerId"],
      ["a null preparedByEngineerId", { preparedByEngineerId: null }, "preparedByEngineerId"],
      ["a preparedByEngineerId that is not a UUID", { preparedByEngineerId: "x" }, "preparedByEngineerId"],
      ["no reportDate", { reportDate: undefined }, "reportDate"],
      ["a bad reportDate", { reportDate: "2026-13-40" }, "reportDate"],
      ["a reportDate with a time", { reportDate: "2026-03-04T10:00:00Z" }, "reportDate"],
      ["no weather", { weather: undefined }, "weather"],
      ["an unknown weather", { weather: "SNOWY" }, "weather"],
      ["a weather in lower case", { weather: "sunny" }, "weather"],
      ["no workersCount", { workersCount: undefined }, "workersCount"],
      ["a negative workersCount", { workersCount: -1 }, "workersCount"],
      ["a workersCount over 100,000", { workersCount: 100_001 }, "workersCount"],
      ["a fractional workersCount", { workersCount: 2.5 }, "workersCount"],
      ["a workersCount sent as text", { workersCount: "5" }, "workersCount"],
      ["notes over 5,000 characters", { notes: "x".repeat(5001) }, "notes"],
      ["a number as notes", { notes: 5 }, "notes"],
    ])("refuses %s", async (_name, extra, path) => {
      const res = await create(extra);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it.each([
      "id",
      "version",
      "createdById",
      "createdBy",
      "createdAt",
      "villaId",
      "villa",
      "workDone",
      "issues",
      "preparedBy",
    ])("refuses the field %s, which a report no longer has or a client cannot set", async (field) => {
      const res = await create({ [field]: "x" });

      expect(res.status).toBe(400);
      expect(dailyReportTables.reports).toHaveLength(0);
    });

    it("answers in Arabic on request", async () => {
      const res = await create({ notes: "x".repeat(5001) }, { language: "ar" });

      expect(res.body.message).toBe("فشل التحقق");
      expect(res.body.details[0].message).toBe("يجب ألا تزيد الملاحظات عن 5000 حرف");
    });

    it("says what is wrong with each field, in English", async () => {
      const res = await create({ weather: "x", workersCount: -3, notes: "x".repeat(5001) });

      const messages = Object.fromEntries(
        res.body.details.map((d: { path: string; message: string }) => [d.path, d.message]),
      );
      expect(messages).toMatchObject({
        weather: "Weather must be HOT, SUNNY, WINDY, RAINY or DUSTY",
        workersCount: "Workers must be a whole number from 0 to 100,000",
        notes: "Notes must be at most 5,000 characters",
      });
    });
  });

  it("audits the creation with the full snapshot and no before", async () => {
    const res = await create({ notes: "Late cement" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "daily_report.create",
      entity: "DailyReport",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        contractorId: nile.id,
        preparedByEngineerId: mona.id,
        reportDate: "2026-03-04",
        weather: "SUNNY",
        workersCount: 25,
        notes: "Late cement",
      },
    });
    expect(auditRows()[0]?.before).toBeUndefined();
  });

  it("writes nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create();

    expect(res.status).toBe(500);
    expect(dailyReportTables.reports).toHaveLength(0);
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await create({}, { key: KEY });
      const again = await create({}, { key: KEY });

      expect(firstTime.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(dailyReportTables.reports).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await create({}, { key: KEY });

      const reused = await create({ notes: "Other" }, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(dailyReportTables.reports).toHaveLength(1);
    });
  });
});

describe("GET /daily-reports/:id", () => {
  it("answers one report with its ETag", async () => {
    const report = await made({ notes: "Late cement" });

    const res = await send("get", `/daily-reports/${report.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.data).toEqual(report);
  });

  it("answers 404 DAILY_REPORT_NOT_FOUND, translated", async () => {
    const res = await send("get", `/daily-reports/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "DAILY_REPORT_NOT_FOUND", message: "التقرير اليومي غير موجود" });
  });

  it("answers 400 for an id that is not a UUID", async () => {
    const res = await send("get", "/daily-reports/nope");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /daily-reports/:id", () => {
  const patch = (id: string, change: Record<string, unknown>, options: Options = {}) =>
    send("patch", `/daily-reports/${id}`, { body: change, ...options });

  it("changes only the fields sent, bumps the version and answers the new ETag", async () => {
    const report = await made({ notes: "First" });

    const res = await patch(report.id, { workersCount: 40 });

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toMatchObject({
      workersCount: 40,
      notes: "First",
      weather: "SUNNY",
      contractor: { id: nile.id },
      preparedBy: { id: mona.id },
      version: 2,
    });
  });

  it("changes every editable field at once, trimming the notes", async () => {
    const report = await made();

    const res = await patch(report.id, {
      contractorId: delta.id,
      preparedByEngineerId: karim.id,
      reportDate: "2026-03-09",
      weather: "WINDY",
      workersCount: 7,
      notes: "  New notes  ",
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      contractor: { id: delta.id, name: "Delta Works" },
      preparedBy: { id: karim.id, name: "Karim Adel" },
      reportDate: "2026-03-09",
      weather: "WINDY",
      workersCount: 7,
      notes: "New notes",
    });
  });

  it.each([null, "", "   "])("clears the notes when they are sent as %j", async (value) => {
    const report = await made({ notes: "Something" });

    const res = await patch(report.id, { notes: value });

    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBeNull();
  });

  it("refuses to clear the contractor or the engineer: a report always has both", async () => {
    const report = await made();

    expect((await patch(report.id, { contractorId: null })).status).toBe(400);
    expect((await patch(report.id, { preparedByEngineerId: null })).status).toBe(400);
    expect(dailyReportTables.reports[0]?.version).toBe(1);
  });

  it.each(["villaId", "workDone", "issues", "preparedBy", "id", "version", "createdById", "createdAt"])(
    "refuses the field %s, which a report no longer has or a client cannot set",
    async (field) => {
      const report = await made();

      const res = await patch(report.id, { [field]: "x" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(dailyReportTables.reports[0]?.version).toBe(1);
    },
  );

  it("refuses an empty body", async () => {
    const report = await made();

    const res = await patch(report.id, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("is refused with 409 VERSION_CONFLICT when the If-Match is stale, and changes nothing", async () => {
    const report = await made();
    await patch(report.id, { workersCount: 1 });

    const stale = await patch(report.id, { workersCount: 2 }, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(dailyReportTables.reports[0]?.workersCount).toBe(1);
  });

  it("goes through with the current If-Match, or none", async () => {
    const report = await made();

    expect((await patch(report.id, { workersCount: 2 }, { ifMatch: '"1"' })).status).toBe(200);
    expect((await patch(report.id, { workersCount: 3 })).status).toBe(200);
  });

  it("turns a version moved on in the middle into 409 VERSION_CONFLICT", async () => {
    const report = await made();
    dailyReportRaces.beforeWrite = () => {
      dailyReportTables.reports[0]!.version = 5;
    };

    const res = await patch(report.id, { workersCount: 2 }, { ifMatch: '"1"' });

    conflict(res, 5);
  });

  it("answers 404 DAILY_REPORT_NOT_FOUND for a report that does not exist", async () => {
    const res = await patch(MISSING_ID, { workersCount: 2 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DAILY_REPORT_NOT_FOUND");
  });

  describe("the date", () => {
    it("moves to a free day of the same contractor", async () => {
      const report = await made();

      const res = await patch(report.id, { reportDate: "2026-03-10" });

      expect(res.status).toBe(200);
      expect(res.body.data.reportDate).toBe("2026-03-10");
    });

    it("cannot move onto a day the contractor already has: 409 DAILY_REPORT_EXISTS, nothing changes", async () => {
      const report = await made();
      await create({ reportDate: "2026-03-10" });

      const res = await patch(report.id, { reportDate: "2026-03-10" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_REPORT_EXISTS");
      expect(dailyReportTables.reports.find((r) => r.id === report.id)?.version).toBe(1);
    });

    it("may stay the same day when it is sent again", async () => {
      const report = await made();

      expect((await patch(report.id, { reportDate: "2026-03-04", workersCount: 2 })).status).toBe(200);
    });

    it("may not be moved more than one day past today", async () => {
      const report = await made();

      const res = await patch(report.id, { reportDate: daysFromToday(2) });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([expect.objectContaining({ path: "reportDate" })]);
    });

    it("may be moved to tomorrow", async () => {
      const report = await made();

      expect((await patch(report.id, { reportDate: daysFromToday(1) })).status).toBe(200);
    });

    it("leaves a report that is already too far ahead saveable when its date is not touched", async () => {
      const far = addDailyReport({
        contractorId: nile.id,
        preparedByEngineerId: mona.id,
        reportDate: day(daysFromToday(5)),
      });

      expect((await patch(far.id, { workersCount: 3 })).status).toBe(200);
    });
  });

  describe("moving to another contractor", () => {
    it("is checked against the day: the other contractor may already have one", async () => {
      const report = await made();
      await create({ contractorId: delta.id });

      const res = await patch(report.id, { contractorId: delta.id });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_REPORT_EXISTS");
    });

    it("answers 404 for one that does not exist, and 400 for one that is switched off", async () => {
      const report = await made();
      delta.status = "INACTIVE";

      const missing = await patch(report.id, { contractorId: MISSING_ID });
      const inactive = await patch(report.id, { contractorId: delta.id });

      expect([missing.status, missing.body.code]).toEqual([404, "CONTRACTOR_NOT_FOUND"]);
      expect([inactive.status, inactive.body.code]).toEqual([400, "CONTRACTOR_INACTIVE"]);
    });

    it("stays saveable when its own contractor was switched off since: only a change is checked", async () => {
      const report = await made();
      nile.status = "INACTIVE";

      expect((await patch(report.id, { workersCount: 9 })).status).toBe(200);
      expect((await patch(report.id, { contractorId: nile.id, workersCount: 10 })).status).toBe(200);
    });
  });

  describe("changing the engineer", () => {
    it("answers 404 for one that does not exist, and 400 for one that is switched off", async () => {
      const report = await made();
      karim.status = "INACTIVE";

      const missing = await patch(report.id, { preparedByEngineerId: MISSING_ID });
      const inactive = await patch(report.id, { preparedByEngineerId: karim.id }, { language: "ar" });

      expect([missing.status, missing.body.code]).toEqual([404, "ELECTRICAL_ENGINEER_NOT_FOUND"]);
      expect([inactive.status, inactive.body.code]).toEqual([400, "ELECTRICAL_ENGINEER_INACTIVE"]);
    });

    it("stays saveable when its own engineer was switched off since: only a change is checked", async () => {
      const report = await made();
      mona.status = "INACTIVE";

      expect((await patch(report.id, { workersCount: 9 })).status).toBe(200);
      expect((await patch(report.id, { preparedByEngineerId: mona.id, workersCount: 10 })).status).toBe(200);
    });
  });

  it("audits the change with the snapshots before and after", async () => {
    const report = await made();

    await patch(report.id, { workersCount: 40, notes: "Rain", preparedByEngineerId: karim.id });

    const entry = auditRows().find((row) => row.action === "daily_report.update");
    expect(entry).toMatchObject({
      entity: "DailyReport",
      entityId: report.id,
      actorId: admin.id,
      before: {
        workersCount: 25,
        notes: "Poured the slab",
        preparedByEngineerId: mona.id,
        reportDate: "2026-03-04",
      },
      after: { workersCount: 40, notes: "Rain", preparedByEngineerId: karim.id, reportDate: "2026-03-04" },
    });
  });

  it("writes nothing when the audit write fails", async () => {
    const report = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await patch(report.id, { workersCount: 2 });

    expect(res.status).toBe(500);
    expect(dailyReportTables.reports[0]?.workersCount).toBe(25);
    expect(dailyReportTables.reports[0]?.version).toBe(1);
  });
});

describe("DELETE /daily-reports/:id", () => {
  it("removes the report, audits it with its snapshot, and answers 204", async () => {
    const report = await made({ notes: "Late cement" });

    const res = await send("delete", `/daily-reports/${report.id}`);

    expect(res.status).toBe(204);
    expect(dailyReportTables.reports).toHaveLength(0);
    expect(auditRows().find((row) => row.action === "daily_report.delete")).toMatchObject({
      entity: "DailyReport",
      entityId: report.id,
      actorId: admin.id,
      before: { contractorId: nile.id, reportDate: "2026-03-04", notes: "Late cement" },
    });
  });

  it("frees the day: the contractor can report it again", async () => {
    const report = await made();
    await send("delete", `/daily-reports/${report.id}`);

    expect((await create()).status).toBe(201);
  });

  it("is refused with 409 VERSION_CONFLICT when stale, and the report stays", async () => {
    const report = await made();
    await send("patch", `/daily-reports/${report.id}`, { body: { workersCount: 1 } });

    const stale = await send("delete", `/daily-reports/${report.id}`, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(dailyReportTables.reports).toHaveLength(1);
  });

  it("goes with the current If-Match", async () => {
    const report = await made();

    const res = await send("delete", `/daily-reports/${report.id}`, { ifMatch: '"1"' });

    expect(res.status).toBe(204);
  });

  it("answers 404 DAILY_REPORT_NOT_FOUND for a report that does not exist, and for one deleted in the middle", async () => {
    const report = await made();
    dailyReportRaces.beforeWrite = () => {
      dailyReportTables.reports = [];
    };

    const missing = await send("delete", `/daily-reports/${MISSING_ID}`);
    const gone = await send("delete", `/daily-reports/${report.id}`);

    expect(missing.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("DAILY_REPORT_NOT_FOUND");
  });

  it("writes nothing when the audit write fails", async () => {
    const report = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("delete", `/daily-reports/${report.id}`);

    expect(res.status).toBe(500);
    expect(dailyReportTables.reports).toHaveLength(1);
  });
});

describe("GET /daily-reports", () => {
  // a: Nile, Mona, March 1st, hot; b: Delta, Karim, March 3rd, rainy; c: Delta, Mona, March 2nd, sunny.
  const seed = (): { a: { id: string }; b: { id: string }; c: { id: string } } => {
    const a = addDailyReport({
      contractorId: nile.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-01"),
      weather: "HOT",
      workersCount: 30,
      notes: "Water pipe burst",
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    const b = addDailyReport({
      contractorId: delta.id,
      preparedByEngineerId: karim.id,
      reportDate: day("2026-03-03"),
      weather: "RAINY",
      workersCount: 5,
      notes: "Rebar tying",
      createdAt: new Date("2026-03-03T10:00:00Z"),
    });
    const c = addDailyReport({
      contractorId: delta.id,
      preparedByEngineerId: mona.id,
      reportDate: day("2026-03-02"),
      weather: "SUNNY",
      workersCount: 12,
      notes: "Late steel",
      createdAt: new Date("2026-03-02T10:00:00Z"),
    });
    return { a, b, c };
  };
  const ids = (res: request.Response): string[] => res.body.data.map((row: { id: string }) => row.id);

  it("lists newest day first by default, with the page meta", async () => {
    const { a, b, c } = seed();

    const res = await send("get", "/daily-reports");

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([b.id, c.id, a.id]);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 3 });
    expect(res.body.data[0]).toMatchObject({
      contractor: { id: delta.id, name: "Delta Works" },
      preparedBy: { id: karim.id, name: "Karim Adel" },
    });
  });

  it("answers an empty page for nothing", async () => {
    const res = await send("get", "/daily-reports");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  describe("paging", () => {
    it("pages by page and limit, and keeps the total", async () => {
      const { a, b, c } = seed();

      const res = await send("get", "/daily-reports?page=2&limit=2");

      expect(ids(res)).toEqual([a.id]);
      expect(res.body.meta).toMatchObject({ page: 2, limit: 2, total: 3 });
      expect(ids(await send("get", "/daily-reports?page=1&limit=2"))).toEqual([b.id, c.id]);
    });

    it.each(["page=0", "page=abc", "limit=0", "limit=1001", "limit=1.5", "page=100001"])(
      "refuses %s with 400, never clamping it",
      async (query) => {
        const res = await send("get", `/daily-reports?${query}`);

        expect(res.status).toBe(400);
      },
    );
  });

  describe("sorting", () => {
    it.each([
      ["reportDate", ["a", "c", "b"]],
      ["reportDate:desc", ["b", "c", "a"]],
      ["createdAt:asc", ["a", "c", "b"]],
      ["createdAt:desc", ["b", "c", "a"]],
      // Delta Works comes before Nile Builders; a contractor's own reports newest first.
      ["contractorName:asc", ["b", "c", "a"]],
      ["contractorName:desc", ["a", "b", "c"]],
      // Karim Adel before Mona Hassan; an engineer's own reports newest first.
      ["preparedByName:asc", ["b", "c", "a"]],
      ["preparedByName:desc", ["c", "a", "b"]],
      // Database order of the weather: HOT, SUNNY, WINDY, RAINY, DUSTY.
      ["weather:asc", ["a", "c", "b"]],
      ["weather:desc", ["b", "c", "a"]],
    ])("sorts by %s", async (sort, expected) => {
      const rows = seed();

      const res = await send("get", `/daily-reports?sort=${sort}`);

      expect(ids(res)).toEqual(expected.map((key) => rows[key as "a" | "b" | "c"]!.id));
    });

    it("breaks ties by id, so a page never repeats or skips a row", async () => {
      const first = addDailyReport({ contractorId: nile.id, preparedByEngineerId: mona.id });
      const second = addDailyReport({
        contractorId: delta.id,
        preparedByEngineerId: mona.id,
        reportDate: first.reportDate,
      });

      const sorted = [first.id, second.id].sort();
      expect(ids(await send("get", "/daily-reports?sort=reportDate:asc"))).toEqual(sorted);
    });

    it.each(["sort=reportDate:sideways", "sort=", "sort=workDone", "sort=villaNumber", "sort=ReportDate"])(
      "refuses %s with 400",
      async (query) => {
        const res = await send("get", `/daily-reports?${query}`);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
      },
    );

    it("says what sorts exist, in Arabic on request", async () => {
      const res = await send("get", "/daily-reports?sort=nope", { language: "ar" });

      expect(res.body.details[0].message).toContain("preparedByName");
    });
  });

  describe("filters", () => {
    it("filters by contractor", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", `/daily-reports?contractorId=${nile.id}`))).toEqual([a.id]);
      expect(ids(await send("get", `/daily-reports?contractorId=${delta.id}`))).toEqual([b.id, c.id]);
    });

    it("filters by electrical engineer", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", `/daily-reports?preparedByEngineerId=${karim.id}`))).toEqual([b.id]);
      expect(ids(await send("get", `/daily-reports?preparedByEngineerId=${mona.id}`))).toEqual([c.id, a.id]);
    });

    it("filters by weather", async () => {
      const { b } = seed();

      expect(ids(await send("get", "/daily-reports?weather=RAINY"))).toEqual([b.id]);
    });

    it("filters by day range, both ends included", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/daily-reports?reportFrom=2026-03-02&reportTo=2026-03-03"))).toEqual([
        b.id,
        c.id,
      ]);
      expect(ids(await send("get", "/daily-reports?reportFrom=2026-03-03"))).toEqual([b.id]);
      expect(ids(await send("get", "/daily-reports?reportTo=2026-03-01"))).toEqual([a.id]);
    });

    it("accepts a range of one day (from and to the same day)", async () => {
      const { c } = seed();

      const res = await send("get", "/daily-reports?reportFrom=2026-03-02&reportTo=2026-03-02");

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([c.id]);
    });

    it("searches the notes only, ignoring case", async () => {
      const { a, c } = seed();

      expect(ids(await send("get", "/daily-reports?search=PIPE"))).toEqual([a.id]);
      expect(ids(await send("get", "/daily-reports?search=steel"))).toEqual([c.id]);
      // The names of the contractor and of the engineer are not searched.
      expect(ids(await send("get", "/daily-reports?search=mona"))).toEqual([]);
      expect(ids(await send("get", "/daily-reports?search=delta"))).toEqual([]);
    });

    it("combines filters", async () => {
      const { a } = seed();

      const res = await send(
        "get",
        `/daily-reports?contractorId=${nile.id}&preparedByEngineerId=${mona.id}&weather=HOT&search=pipe`,
      );

      expect(ids(res)).toEqual([a.id]);
      expect(res.body.meta.total).toBe(1);
    });

    it("accepts a search of exactly 100 characters", async () => {
      const res = await send("get", `/daily-reports?search=${"x".repeat(100)}`);

      expect(res.status).toBe(200);
    });

    it("refuses the villaId filter that a daily report no longer has, saying so, instead of listing everything", async () => {
      seed();

      const res = await send("get", `/daily-reports?villaId=${randomUUID()}`, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toEqual([
        {
          path: "villaId",
          message:
            "لم يعد التقرير اليومي تابعًا لفيلا. صفِّ حسب contractorId أو preparedByEngineerId بدلاً من ذلك",
        },
      ]);
    });

    it.each([
      "contractorId=x",
      "preparedByEngineerId=x",
      "weather=SNOWY",
      "reportFrom=2026-13-01",
      "reportTo=yesterday",
      "reportFrom=2026-03-05&reportTo=2026-03-01",
      `search=${"x".repeat(101)}`,
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/daily-reports?${query}`);

      expect(res.status).toBe(400);
    });
  });
});
