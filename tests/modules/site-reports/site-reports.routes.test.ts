import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addSiteReport, siteReportRaces, siteReportTables } from "./in-memory-site-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/site-reports/repository/site-reports.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/site-reports/repository/site-reports.repository.js")
  >()),
  SiteReportsRepository: (await import("./in-memory-site-reports.repository.js"))
    .InMemorySiteReportsRepository,
}));

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
let villa: StoredVilla;
let bare: StoredVilla;

beforeEach(() => {
  store.reset();
  villaTables.reset();
  idempotencyTable.reset();
  siteReportRaces.reset();
  siteReportTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa = addVilla({ villaNumber: "P-001", block: "B1", plot: "1" });
  bare = addVilla({ villaNumber: "P-002", block: "B1", plot: "2" });
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
  villaId: villa.id,
  title: "First fix check",
  visitDate: "2026-03-04",
  inspector: "Eng. Hamdy",
  type: "INSPECTION",
  rating: 4,
  findings: "Conduits are fixed",
  ...extra,
});
const create = (extra: Record<string, unknown> = {}, options: Options = {}) =>
  send("post", "/site-reports", { body: body(extra), ...options });
const made = async (extra: Record<string, unknown> = {}) => (await create(extra)).body.data;
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};
const paths = (res: request.Response): string[] =>
  res.body.details.map((detail: { path: string }) => detail.path);

describe("access control", () => {
  const ROUTES: [Verb, string, string][] = [
    ["get", "/site-reports", "site-reports:read"],
    ["get", `/site-reports/${MISSING_ID}`, "site-reports:read"],
    ["post", "/site-reports", "site-reports:create"],
    ["patch", `/site-reports/${MISSING_ID}`, "site-reports:update"],
    ["delete", `/site-reports/${MISSING_ID}`, "site-reports:delete"],
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
    "%s %s needs exactly %s, and no other site-reports permission opens it",
    async (verb, path, code) => {
      const others = [
        "site-reports:read",
        "site-reports:create",
        "site-reports:update",
        "site-reports:delete",
        "site-reports:export",
        "site-reports:import",
      ]
        .filter((other) => other !== code)
        .concat(
          "small-works:read",
          "small-works:update",
          "daily-reports:read",
          "villas:read",
          "villas:update",
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
    const res = await send("patch", "/site-reports/not-a-uuid", {
      user: employee("e@example.test"),
      body: { x: 1 },
    });

    expect(res.status).toBe(403);
  });

  it("lets an admin do everything without any grant", async () => {
    const report = await made();

    expect((await send("get", "/site-reports")).status).toBe(200);
    expect(
      (await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Sara" } })).status,
    ).toBe(200);
    expect((await send("delete", `/site-reports/${report.id}`)).status).toBe(204);
  });
});

describe("POST /site-reports", () => {
  it("creates a site report with its villa, creator, ETag and version 1; recommendations are null when left out", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      villa: { id: villa.id, villaNumber: "P-001", location: "New Cairo . B1 . 1" },
      title: "First fix check",
      visitDate: "2026-03-04",
      inspector: "Eng. Hamdy",
      type: "INSPECTION",
      rating: 4,
      findings: "Conduits are fixed",
      recommendations: null,
      createdBy: { id: admin.id, name: "Root Admin" },
      version: 1,
    });
    expect(siteReportTables.reports).toHaveLength(1);
    expect(siteReportTables.reports[0]?.createdById).toBe(admin.id);
    expect(siteReportTables.reports[0]?.recommendations).toBeNull();
  });

  it("takes recommendations, and trims every text", async () => {
    const res = await create({
      title: "  Safety round  ",
      inspector: "  Karim  ",
      findings: "  Scaffold is loose  ",
      recommendations: "  Tie it down  ",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: "Safety round",
      inspector: "Karim",
      findings: "Scaffold is loose",
      recommendations: "Tie it down",
    });
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["null", null],
  ])("stores %s recommendations as null", async (_name, recommendations) => {
    const res = await create({ recommendations });

    expect(res.status).toBe(201);
    expect(res.body.data.recommendations).toBeNull();
    expect(siteReportTables.reports[0]?.recommendations).toBeNull();
  });

  it.each(["INSPECTION", "SAFETY", "PROGRESS", "QUALITY"])("accepts the type %s", async (type) => {
    const res = await create({ type });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe(type);
  });

  it("has no natural key: the same report twice makes two rows", async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);

    expect(siteReportTables.reports).toHaveLength(2);
  });

  it("accepts the longest texts: 150 characters of title, 100 of inspector, 5,000 of findings and recommendations", async () => {
    const res = await create({
      title: "t".repeat(150),
      inspector: "n".repeat(100),
      findings: "f".repeat(5000),
      recommendations: "r".repeat(5000),
    });

    expect(res.status).toBe(201);
    expect(res.body.data.findings).toHaveLength(5000);
    expect(res.body.data.recommendations).toHaveLength(5000);
  });

  it("answers 404 VILLA_NOT_FOUND for a villa that does not exist", async () => {
    const res = await create({ villaId: MISSING_ID }, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(siteReportTables.reports).toHaveLength(0);
  });

  it("turns a villa deleted in the middle into 404 VILLA_NOT_FOUND, writing nothing", async () => {
    siteReportRaces.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((v) => v.id !== villa.id);
    };

    const res = await create();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(siteReportTables.reports).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 401 when the acting user is gone in the middle, writing nothing", async () => {
    siteReportRaces.beforeWrite = () => {
      store.users.splice(
        store.users.findIndex((user) => user.id === admin.id),
        1,
      );
    };

    const res = await create();

    expect(res.status).toBe(401);
    expect(siteReportTables.reports).toHaveLength(0);
  });

  describe("the date", () => {
    it("may be today, yesterday, and tomorrow", async () => {
      expect((await create({ visitDate: daysFromToday(0) })).status).toBe(201);
      expect((await create({ visitDate: daysFromToday(-1) })).status).toBe(201);
      expect((await create({ visitDate: daysFromToday(1) })).status).toBe(201);
    });

    it("may not be more than one day past today: 400 on the visitDate, translated", async () => {
      const res = await create({ visitDate: daysFromToday(2) }, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toEqual([
        { path: "visitDate", message: "لا يمكن أن يزيد تاريخ الزيارة عن يوم واحد بعد اليوم" },
      ]);
      expect(siteReportTables.reports).toHaveLength(0);
    });

    it("may be long ago", async () => {
      expect((await create({ visitDate: "2020-01-01" })).status).toBe(201);
    });
  });

  describe("the rating (a whole JSON number from 1 to 5)", () => {
    it.each([1, 2, 3, 4, 5])("accepts %s and answers it back unchanged", async (rating) => {
      const res = await create({ rating });

      expect(res.status).toBe(201);
      expect(res.body.data.rating).toBe(rating);
      expect(siteReportTables.reports[0]?.rating).toBe(rating);
    });

    it.each([
      ["zero", 0],
      ["minus zero", -0],
      ["a negative", -1],
      ["one above the top", 6],
      ["far above", 1_000_000],
      ["a fraction", 2.5],
      ["a tiny fraction above 1", 1.0000001],
      ["just below 5 with decimals", 4.9999],
      ["an exponent number", 1e21],
    ])("refuses %s with a 400 on rating, never a 500", async (_name, rating) => {
      const res = await create({ rating });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(paths(res)).toEqual(["rating"]);
      expect(siteReportTables.reports).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it.each([
      ["text", "3"],
      ["null", null],
      ["a boolean", true],
      ["an object", {}],
      ["an array", [3]],
    ])("refuses %s as the rating", async (_name, rating) => {
      const res = await create({ rating });

      expect(res.status).toBe(400);
      expect(paths(res)).toEqual(["rating"]);
    });

    it("refuses a rating left out", async () => {
      const res = await create({ rating: undefined });

      expect(res.status).toBe(400);
      expect(paths(res)).toContain("rating");
    });

    it("says what is wrong, in English and in Arabic", async () => {
      const english = await create({ rating: 0 });
      const arabic = await create({ rating: 6 }, { language: "ar" });

      expect(english.body.details[0].message).toBe("Rating must be a whole number from 1 to 5");
      expect(arabic.body.details[0].message).toBe("يجب أن يكون التقييم عددًا صحيحًا من 1 إلى 5");
    });

    it("gives the same message for a rating that is not a number, and for a title that is too long", async () => {
      const text = await create({ rating: "3" });
      const long = await create({ title: "t".repeat(151) });

      expect(text.body.details[0].message).toBe("Rating must be a whole number from 1 to 5");
      expect(long.body.details[0].message).toBe("Title must be between 1 and 150 characters");
    });
  });

  describe("request validation (400, nothing is written)", () => {
    it.each([
      ["no villaId", { villaId: undefined }, "villaId"],
      ["a villaId that is not a UUID", { villaId: "nope" }, "villaId"],
      ["no title", { title: undefined }, "title"],
      ["a blank title", { title: "   " }, "title"],
      ["a title over 150 characters", { title: "x".repeat(151) }, "title"],
      ["a number as the title", { title: 5 }, "title"],
      ["no visitDate", { visitDate: undefined }, "visitDate"],
      ["a bad visitDate", { visitDate: "2026-13-40" }, "visitDate"],
      ["a visitDate with a time", { visitDate: "2026-03-04T10:00:00Z" }, "visitDate"],
      ["no inspector", { inspector: undefined }, "inspector"],
      ["a blank inspector", { inspector: "  " }, "inspector"],
      ["a null inspector", { inspector: null }, "inspector"],
      ["an inspector over 100 characters", { inspector: "x".repeat(101) }, "inspector"],
      ["no type", { type: undefined }, "type"],
      ["an unknown type", { type: "AUDIT" }, "type"],
      ["a type in lower case", { type: "safety" }, "type"],
      ["a null type", { type: null }, "type"],
      ["no findings", { findings: undefined }, "findings"],
      ["blank findings", { findings: "   " }, "findings"],
      ["null findings", { findings: null }, "findings"],
      ["findings over 5,000 characters", { findings: "x".repeat(5001) }, "findings"],
      ["recommendations over 5,000 characters", { recommendations: "x".repeat(5001) }, "recommendations"],
      ["a number as the recommendations", { recommendations: 5 }, "recommendations"],
    ])("refuses %s", async (_name, extra, path) => {
      const res = await create(extra);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(paths(res)).toContain(path);
      expect(siteReportTables.reports).toHaveLength(0);
    });

    it("counts the 5,001st character after trimming, not before", async () => {
      expect((await create({ findings: `  ${"x".repeat(5000)}  ` })).status).toBe(201);
      expect((await create({ findings: `${"x".repeat(5000)}y` })).status).toBe(400);
    });

    it.each([
      "id",
      "version",
      "createdById",
      "createdBy",
      "villa",
      "createdAt",
      "contractorId",
      "civilEngineerId",
      "electricalEngineerId",
    ])("refuses the field %s that a client cannot set", async (field) => {
      const res = await create({ [field]: "x" });

      expect(res.status).toBe(400);
      expect(siteReportTables.reports).toHaveLength(0);
    });

    it("answers in Arabic on request", async () => {
      const res = await create({ title: "" }, { language: "ar" });

      expect(res.body.message).toBe("فشل التحقق");
      expect(res.body.details[0].message).toBe("يجب أن يكون العنوان بين 1 و150 حرفًا");
    });

    it("says what is wrong with each field, in English", async () => {
      const res = await create({
        type: "x",
        title: "",
        inspector: "x".repeat(101),
        findings: "",
        recommendations: "x".repeat(5001),
        rating: 9,
      });

      const messages = Object.fromEntries(
        res.body.details.map((d: { path: string; message: string }) => [d.path, d.message]),
      );
      expect(messages).toMatchObject({
        type: "Type must be INSPECTION, SAFETY, PROGRESS or QUALITY",
        title: "Title must be between 1 and 150 characters",
        inspector: "Inspector must be between 1 and 100 characters",
        findings: "Findings must be between 1 and 5,000 characters",
        recommendations: "Recommendations must be at most 5,000 characters",
        rating: "Rating must be a whole number from 1 to 5",
      });
    });
  });

  it("audits the creation with the full snapshot and no before", async () => {
    const res = await create({ type: "QUALITY", rating: 2, recommendations: "Redo it" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "site_report.create",
      entity: "SiteReport",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        villaId: villa.id,
        title: "First fix check",
        visitDate: "2026-03-04",
        inspector: "Eng. Hamdy",
        type: "QUALITY",
        rating: 2,
        findings: "Conduits are fixed",
        recommendations: "Redo it",
      },
    });
    expect(auditRows()[0]?.before).toBeUndefined();
  });

  it("writes nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create();

    expect(res.status).toBe(500);
    expect(siteReportTables.reports).toHaveLength(0);
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await create({}, { key: KEY });
      const again = await create({}, { key: KEY });

      expect(firstTime.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(siteReportTables.reports).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await create({}, { key: KEY });

      const reused = await create({ title: "Other" }, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(siteReportTables.reports).toHaveLength(1);
    });
  });
});

describe("GET /site-reports/:id", () => {
  it("answers one site report with its ETag", async () => {
    const report = await made({ recommendations: "Seal it" });

    const res = await send("get", `/site-reports/${report.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.data).toEqual(report);
  });

  it("answers 404 SITE_REPORT_NOT_FOUND, translated", async () => {
    const res = await send("get", `/site-reports/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "SITE_REPORT_NOT_FOUND", message: "تقرير الموقع غير موجود" });
  });

  it("answers the same 404 in English", async () => {
    const res = await send("get", `/site-reports/${MISSING_ID}`);

    expect(res.body).toMatchObject({ code: "SITE_REPORT_NOT_FOUND", message: "Site report not found" });
  });

  it("answers 400 for an id that is not a UUID", async () => {
    const res = await send("get", "/site-reports/nope");

    expect(res.status).toBe(400);
  });
});

describe("PATCH /site-reports/:id", () => {
  it("changes only the fields sent, bumps the version and answers the new ETag", async () => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, { body: { rating: 2, type: "SAFETY" } });

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toMatchObject({
      title: "First fix check",
      visitDate: "2026-03-04",
      inspector: "Eng. Hamdy",
      type: "SAFETY",
      rating: 2,
      findings: "Conduits are fixed",
      recommendations: null,
      version: 2,
    });
  });

  it("changes every editable field at once, trimming the texts", async () => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, {
      body: {
        title: "  Second visit ",
        visitDate: "2026-03-06",
        inspector: " Mona ",
        type: "PROGRESS",
        rating: 5,
        findings: " Better ",
        recommendations: " Keep going ",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      title: "Second visit",
      visitDate: "2026-03-06",
      inspector: "Mona",
      type: "PROGRESS",
      rating: 5,
      findings: "Better",
      recommendations: "Keep going",
    });
  });

  it.each([
    ["null", null],
    ["blank", "   "],
    ["empty", ""],
  ])("clears the recommendations with %s", async (_name, recommendations) => {
    const report = await made({ recommendations: "Seal it" });

    const res = await send("patch", `/site-reports/${report.id}`, { body: { recommendations } });

    expect(res.status).toBe(200);
    expect(res.body.data.recommendations).toBeNull();
    expect(siteReportTables.reports[0]?.recommendations).toBeNull();
  });

  it("leaves the recommendations alone when they are not sent", async () => {
    const report = await made({ recommendations: "Seal it" });

    const res = await send("patch", `/site-reports/${report.id}`, { body: { rating: 1 } });

    expect(res.body.data.recommendations).toBe("Seal it");
  });

  it.each(["title", "inspector", "findings"])("refuses a blank %s: the field is required", async (field) => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, { body: { [field]: "   " } });

    expect(res.status).toBe(400);
    expect(paths(res)).toEqual([field]);
  });

  it("refuses null for every required field", async () => {
    const report = await made();

    for (const field of ["title", "visitDate", "inspector", "type", "rating", "findings"]) {
      const res = await send("patch", `/site-reports/${report.id}`, { body: { [field]: null } });

      expect(res.status, field).toBe(400);
    }
  });

  it.each([
    ["zero", 0],
    ["a negative", -2],
    ["six", 6],
    ["a fraction", 3.5],
    ["text", "3"],
  ])("refuses %s as the rating with a 400, and changes nothing", async (_name, rating) => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, { body: { rating } });

    expect(res.status).toBe(400);
    expect(paths(res)).toEqual(["rating"]);
    expect(siteReportTables.reports[0]?.rating).toBe(4);
    expect(siteReportTables.reports[0]?.version).toBe(1);
  });

  it.each([1, 5])("accepts %s as the rating", async (rating) => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, { body: { rating } });

    expect(res.status).toBe(200);
    expect(res.body.data.rating).toBe(rating);
  });

  it("refuses the villa, which is fixed once the site report exists, and every other field a client cannot set", async () => {
    const report = await made();

    for (const field of [
      "villaId",
      "id",
      "version",
      "createdById",
      "createdBy",
      "villa",
      "contractorId",
      "civilEngineerId",
      "electricalEngineerId",
    ]) {
      const res = await send("patch", `/site-reports/${report.id}`, { body: { [field]: bare.id } });

      expect(res.status, field).toBe(400);
    }
    expect(siteReportTables.reports[0]?.villaId).toBe(villa.id);
  });

  it("refuses a field that is not editable even when editable ones come with it", async () => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, {
      body: { title: "Changed", villaId: bare.id },
    });

    expect(res.status).toBe(400);
    expect(siteReportTables.reports[0]?.title).toBe("First fix check");
    expect(siteReportTables.reports[0]?.villaId).toBe(villa.id);
  });

  it("refuses an empty body", async () => {
    const report = await made();

    const res = await send("patch", `/site-reports/${report.id}`, { body: {} });

    expect(res.status).toBe(400);
  });

  it("is refused with 409 VERSION_CONFLICT when the If-Match is stale, and changes nothing", async () => {
    const report = await made();
    await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Sara" } });

    const stale = await send("patch", `/site-reports/${report.id}`, {
      body: { inspector: "Eng. Omar" },
      ifMatch: '"1"',
    });

    conflict(stale, 2);
    expect(siteReportTables.reports[0]?.inspector).toBe("Eng. Sara");
    expect(auditRows().filter((row) => row.action === "site_report.update")).toHaveLength(1);
  });

  it("goes through with the current If-Match, or none", async () => {
    const report = await made();

    const current = await send("patch", `/site-reports/${report.id}`, {
      body: { inspector: "Eng. Sara" },
      ifMatch: '"1"',
    });
    const none = await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Omar" } });

    expect(current.status).toBe(200);
    expect(none.status).toBe(200);
    expect(none.body.data.version).toBe(3);
  });

  it("turns a version moved on in the middle into 409 VERSION_CONFLICT", async () => {
    const report = await made();
    siteReportRaces.beforeWrite = () => {
      siteReportTables.reports[0]!.version += 1;
    };

    const res = await send("patch", `/site-reports/${report.id}`, {
      body: { inspector: "Eng. Sara" },
      ifMatch: '"1"',
    });

    conflict(res, 2);
    expect(siteReportTables.reports[0]?.inspector).toBe("Eng. Hamdy");
  });

  it("answers 404 SITE_REPORT_NOT_FOUND for a site report that does not exist", async () => {
    const res = await send("patch", `/site-reports/${MISSING_ID}`, { body: { inspector: "Eng. Sara" } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SITE_REPORT_NOT_FOUND");
  });

  it("answers 404 for a site report deleted in the middle", async () => {
    const report = await made();
    siteReportRaces.beforeWrite = () => {
      siteReportTables.reports = [];
    };

    const res = await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Sara" } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SITE_REPORT_NOT_FOUND");
  });

  describe("the date", () => {
    it("moves to another day, even one the villa already has: there is no natural key", async () => {
      const report = await made();
      await made({ visitDate: "2026-03-10" });

      const res = await send("patch", `/site-reports/${report.id}`, { body: { visitDate: "2026-03-10" } });

      expect(res.status).toBe(200);
      expect(res.body.data.visitDate).toBe("2026-03-10");
    });

    it("may stay the same day when it is sent again", async () => {
      const report = await made();

      const res = await send("patch", `/site-reports/${report.id}`, {
        body: { visitDate: "2026-03-04", inspector: "Eng. Sara" },
      });

      expect(res.status).toBe(200);
    });

    it("may not be moved more than one day past today", async () => {
      const report = await made();

      const res = await send("patch", `/site-reports/${report.id}`, {
        body: { visitDate: daysFromToday(2) },
        language: "ar",
      });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "visitDate", message: "لا يمكن أن يزيد تاريخ الزيارة عن يوم واحد بعد اليوم" },
      ]);
      expect(siteReportTables.reports[0]?.version).toBe(1);
    });

    it("may be moved to tomorrow", async () => {
      const report = await made();

      const res = await send("patch", `/site-reports/${report.id}`, {
        body: { visitDate: daysFromToday(1) },
      });

      expect(res.status).toBe(200);
    });

    it("leaves a site report that is already too far ahead saveable when its date is not touched", async () => {
      const ahead = addSiteReport({
        villaId: villa.id,
        visitDate: day(daysFromToday(5)),
        createdById: admin.id,
      });

      const res = await send("patch", `/site-reports/${ahead.id}`, { body: { inspector: "Eng. Sara" } });

      expect(res.status).toBe(200);
    });

    it("leaves it saveable when the same too-far date is sent again", async () => {
      const ahead = addSiteReport({ villaId: villa.id, visitDate: day(daysFromToday(5)) });

      const res = await send("patch", `/site-reports/${ahead.id}`, {
        body: { visitDate: daysFromToday(5), inspector: "Eng. Sara" },
      });

      expect(res.status).toBe(200);
    });
  });

  it("audits the change with the snapshots before and after", async () => {
    const report = await made();

    await send("patch", `/site-reports/${report.id}`, { body: { rating: 1, recommendations: "Redo" } });

    const entry = auditRows().find((row) => row.action === "site_report.update");
    expect(entry).toMatchObject({
      entity: "SiteReport",
      entityId: report.id,
      actorId: admin.id,
      before: { rating: 4, recommendations: null, villaId: villa.id },
      after: { rating: 1, recommendations: "Redo", villaId: villa.id },
    });
  });

  it("writes nothing when the audit write fails", async () => {
    const report = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Sara" } });

    expect(res.status).toBe(500);
    expect(siteReportTables.reports[0]?.inspector).toBe("Eng. Hamdy");
    expect(siteReportTables.reports[0]?.version).toBe(1);
  });
});

describe("DELETE /site-reports/:id", () => {
  it("removes the site report, audits it with its snapshot, and answers 204", async () => {
    const report = await made({ rating: 3 });

    const res = await send("delete", `/site-reports/${report.id}`);

    expect(res.status).toBe(204);
    expect(siteReportTables.reports).toHaveLength(0);
    expect(auditRows().find((row) => row.action === "site_report.delete")).toMatchObject({
      entity: "SiteReport",
      entityId: report.id,
      actorId: admin.id,
      before: { villaId: villa.id, visitDate: "2026-03-04", rating: 3 },
    });
  });

  it("is refused with 409 VERSION_CONFLICT when stale, and the site report stays", async () => {
    const report = await made();
    await send("patch", `/site-reports/${report.id}`, { body: { inspector: "Eng. Sara" } });

    const stale = await send("delete", `/site-reports/${report.id}`, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(siteReportTables.reports).toHaveLength(1);
  });

  it("goes with the current If-Match", async () => {
    const report = await made();

    const res = await send("delete", `/site-reports/${report.id}`, { ifMatch: '"1"' });

    expect(res.status).toBe(204);
  });

  it("answers 404 SITE_REPORT_NOT_FOUND for one that does not exist, and for one deleted in the middle", async () => {
    const report = await made();
    siteReportRaces.beforeWrite = () => {
      siteReportTables.reports = [];
    };

    const missing = await send("delete", `/site-reports/${MISSING_ID}`);
    const gone = await send("delete", `/site-reports/${report.id}`);

    expect(missing.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("SITE_REPORT_NOT_FOUND");
  });

  it("writes nothing when the audit write fails", async () => {
    const report = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("delete", `/site-reports/${report.id}`);

    expect(res.status).toBe(500);
    expect(siteReportTables.reports).toHaveLength(1);
  });
});

describe("GET /site-reports", () => {
  const seed = (): Record<string, { id: string }> => {
    const a = addSiteReport({
      villaId: villa.id,
      visitDate: day("2026-03-01"),
      title: "Foundation check",
      inspector: "Hamdy",
      type: "INSPECTION",
      rating: 5,
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    const b = addSiteReport({
      villaId: villa.id,
      visitDate: day("2026-03-03"),
      title: "Scaffold safety round",
      inspector: "Mona",
      type: "SAFETY",
      rating: 2,
      createdAt: new Date("2026-03-03T10:00:00Z"),
    });
    const c = addSiteReport({
      villaId: bare.id,
      visitDate: day("2026-03-02"),
      title: "Tile quality",
      inspector: "Karim",
      type: "QUALITY",
      rating: 3,
      createdAt: new Date("2026-03-02T10:00:00Z"),
    });
    return { a, b, c };
  };
  const ids = (res: request.Response): string[] => res.body.data.map((row: { id: string }) => row.id);

  it("lists newest day first by default, with the page meta", async () => {
    const { a, b, c } = seed();

    const res = await send("get", "/site-reports");

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([b!.id, c!.id, a!.id]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({
      villa: { villaNumber: "P-001" },
      visitDate: "2026-03-03",
      rating: 2,
    });
  });

  it("answers an empty page for nothing", async () => {
    const res = await send("get", "/site-reports");

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  describe("paging", () => {
    it("pages by page and limit, and keeps the total", async () => {
      const { a, b, c } = seed();

      const first = await send("get", "/site-reports?page=1&limit=2");
      const second = await send("get", "/site-reports?page=2&limit=2");

      expect(ids(first)).toEqual([b!.id, c!.id]);
      expect(ids(second)).toEqual([a!.id]);
      expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it.each(["page=0", "page=abc", "limit=0", "limit=1001", "limit=1.5", "page=100001"])(
      "refuses %s with 400, never clamps it",
      async (query) => {
        const res = await send("get", `/site-reports?${query}`);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
      },
    );
  });

  describe("sorting", () => {
    it.each([
      ["visitDate", ["a", "c", "b"]],
      ["visitDate:desc", ["b", "c", "a"]],
      ["rating", ["b", "c", "a"]],
      ["rating:desc", ["a", "c", "b"]],
      ["type", ["a", "b", "c"]],
      ["type:desc", ["c", "b", "a"]],
      ["createdAt:asc", ["a", "c", "b"]],
      ["createdAt:desc", ["b", "c", "a"]],
    ])("sorts by %s", async (sort, expected) => {
      const rows = seed();

      const res = await send("get", `/site-reports?sort=${sort}`);

      expect(ids(res)).toEqual(expected.map((key) => rows[key]!.id));
    });

    it("sorts by villaNumber in natural order, a villa's site reports newest first", async () => {
      const { a, b, c } = seed();
      const ten = addVilla({ villaNumber: "P-010", block: "B1", plot: "10" });
      const nine = addVilla({ villaNumber: "P-9", block: "B1", plot: "9" });
      const d = addSiteReport({ villaId: ten.id, visitDate: day("2026-03-05") });
      const e = addSiteReport({ villaId: nine.id, visitDate: day("2026-03-05") });

      const asc = await send("get", "/site-reports?sort=villaNumber");
      const desc = await send("get", "/site-reports?sort=villaNumber:desc");

      expect(ids(asc)).toEqual([b!.id, a!.id, c!.id, e.id, d.id]);
      expect(ids(desc)).toEqual([d.id, e.id, c!.id, b!.id, a!.id]);
    });

    it("breaks ties by id, so a page never repeats or skips a row", async () => {
      const sameDay = [bare, villa].map((v) =>
        addSiteReport({ villaId: v.id, visitDate: day("2026-04-01") }),
      );

      const res = await send("get", "/site-reports");

      expect(ids(res)).toEqual(sameDay.map((r) => r.id).sort());
    });

    it.each([
      "sort=inspector",
      "sort=visitDate:sideways",
      "sort=",
      "sort=title",
      "sort=VisitDate",
      "sort=xvisitDate",
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/site-reports?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("says what sorts exist, in Arabic on request", async () => {
      const res = await send("get", "/site-reports?sort=nope", { language: "ar" });

      expect(res.body.details[0].message).toContain("visitDate");
    });
  });

  describe("filters", () => {
    it("filters by villa", async () => {
      const { c } = seed();

      expect(ids(await send("get", `/site-reports?villaId=${bare.id}`))).toEqual([c!.id]);
    });

    it("filters by type", async () => {
      const { a, b } = seed();

      expect(ids(await send("get", "/site-reports?type=SAFETY"))).toEqual([b!.id]);
      expect(ids(await send("get", "/site-reports?type=INSPECTION"))).toEqual([a!.id]);
      expect(ids(await send("get", "/site-reports?type=PROGRESS"))).toEqual([]);
    });

    it("filters by an exact rating, not a range", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/site-reports?rating=5"))).toEqual([a!.id]);
      expect(ids(await send("get", "/site-reports?rating=2"))).toEqual([b!.id]);
      expect(ids(await send("get", "/site-reports?rating=3"))).toEqual([c!.id]);
      expect(ids(await send("get", "/site-reports?rating=4"))).toEqual([]);
    });

    it("filters by day range, both ends included", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/site-reports?visitFrom=2026-03-02&visitTo=2026-03-03"))).toEqual([
        b!.id,
        c!.id,
      ]);
      expect(ids(await send("get", "/site-reports?visitFrom=2026-03-03"))).toEqual([b!.id]);
      expect(ids(await send("get", "/site-reports?visitTo=2026-03-01"))).toEqual([a!.id]);
    });

    it("takes one day as both ends of the range", async () => {
      const { b } = seed();

      const res = await send("get", "/site-reports?visitFrom=2026-03-03&visitTo=2026-03-03");

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([b!.id]);
    });

    it("says an upside-down range is wrong on visitTo", async () => {
      const res = await send("get", "/site-reports?visitFrom=2026-03-05&visitTo=2026-03-01");

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "visitTo", message: "The end date must not be before the start date" },
      ]);
    });

    it("ignores spaces around the search", async () => {
      const { a } = seed();

      expect(ids(await send("get", "/site-reports?search=%20%20foundation%20%20"))).toEqual([a!.id]);
    });

    it("searches the title, the inspector and the villa number, ignoring case", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/site-reports?search=SCAFFOLD"))).toEqual([b!.id]);
      expect(ids(await send("get", "/site-reports?search=karim"))).toEqual([c!.id]);
      expect(ids(await send("get", "/site-reports?search=P-002"))).toEqual([c!.id]);
      expect(ids(await send("get", "/site-reports?search=hamdy"))).toEqual([a!.id]);
    });

    it("does not search the findings or the recommendations", async () => {
      addSiteReport({
        villaId: villa.id,
        title: "Visit",
        findings: "Cracked beam",
        recommendations: "Replace the beam",
      });

      expect(ids(await send("get", "/site-reports?search=beam"))).toEqual([]);
    });

    it("combines filters", async () => {
      const { b } = seed();

      const res = await send("get", `/site-reports?villaId=${villa.id}&type=SAFETY&rating=2&search=scaffold`);

      expect(ids(res)).toEqual([b!.id]);
      expect(res.body.meta.total).toBe(1);
    });

    it("accepts a search of exactly 100 characters", async () => {
      const res = await send("get", `/site-reports?search=${"x".repeat(100)}`);

      expect(res.status).toBe(200);
    });

    it("says why a rating of the list query is refused", async () => {
      const res = await send("get", "/site-reports?rating=9");

      expect(res.status).toBe(400);
      expect(res.body.details[0]).toMatchObject({
        path: "rating",
        message: "Rating must be a whole number from 1 to 5",
      });
    });

    it.each([
      "villaId=x",
      "type=AUDIT",
      "type=safety",
      "rating=0",
      "rating=6",
      "rating=2.5",
      "rating=abc",
      "rating=",
      "rating=1&rating=2",
      "rating=11",
      "rating=55",
      "visitFrom=2026-13-01",
      "visitTo=yesterday",
      "visitFrom=2026-03-05&visitTo=2026-03-01",
      `search=${"x".repeat(101)}`,
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/site-reports?${query}`);

      expect(res.status).toBe(400);
    });
  });
});

describe("deleting a villa that has site reports", () => {
  it("is refused with 409 VILLA_HAS_RECORDS, translated; the villa and the site report stay", async () => {
    await made();

    const res = await send("delete", `/villas/${villa.id}`, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "VILLA_HAS_RECORDS",
      message:
        "هذه الفيلا بها أعمال مفتوحة أُضيفت يدويًا أو أعمال صغيرة يومية أو تقارير موقع أو عمالة يومية أو توريدات مواد. احذفها أولاً",
    });
    expect(villaTables.villas.some((v) => v.id === villa.id)).toBe(true);
    expect(siteReportTables.reports).toHaveLength(1);
  });

  it("says so in English too", async () => {
    await made();

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe(
      "This villa has open works that were added by hand, daily small works, site reports, daily labour or material deliveries. Delete them first",
    );
  });

  it("is allowed again once its site reports are deleted, and another villa's site reports do not matter", async () => {
    const report = await made();
    await made({ villaId: bare.id });
    await send("delete", `/site-reports/${report.id}`);

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(204);
    expect(siteReportTables.reports).toHaveLength(1);
  });
});
