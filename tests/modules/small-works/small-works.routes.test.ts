import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addSmallWork, smallWorkRaces, smallWorkTables } from "./in-memory-small-works.repository.js";

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
vi.mock("../../../src/modules/small-works/repository/small-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/small-works/repository/small-works.repository.js")
  >()),
  SmallWorksRepository: (await import("./in-memory-small-works.repository.js")).InMemorySmallWorksRepository,
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
let contractorId: string;

beforeEach(() => {
  store.reset();
  villaTables.reset();
  contractorTables.reset();
  idempotencyTable.reset();
  smallWorkRaces.reset();
  smallWorkTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  villa = addVilla({ villaNumber: "P-001", block: "B1", plot: "1" });
  bare = addVilla({ villaNumber: "P-002", block: "B1", plot: "2" });
  contractorId = addContractor({ name: "Nile Builders" }).id;
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
  contractorId,
  startDate: "2026-03-04",
  endDate: "2026-03-06",
  description: "Replaced a broken socket",
  ...extra,
});
// A row written straight into the fake, for the cases that need a day relative to today or a given creation time.
const seedWork = (extra: Partial<Parameters<typeof addSmallWork>[0]> = {}) =>
  addSmallWork({ villaId: villa.id, contractorId, ...extra });
const create = (extra: Record<string, unknown> = {}, options: Options = {}) =>
  send("post", "/small-works", { body: body(extra), ...options });
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
    ["get", "/small-works", "small-works:read"],
    ["get", `/small-works/${MISSING_ID}`, "small-works:read"],
    ["post", "/small-works", "small-works:create"],
    ["patch", `/small-works/${MISSING_ID}`, "small-works:update"],
    ["delete", `/small-works/${MISSING_ID}`, "small-works:delete"],
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
    "%s %s needs exactly %s, and no other small-works permission opens it",
    async (verb, path, code) => {
      const others = [
        "small-works:read",
        "small-works:create",
        "small-works:update",
        "small-works:delete",
        "small-works:export",
        "small-works:import",
      ]
        .filter((other) => other !== code)
        .concat(
          "daily-reports:read",
          "daily-reports:update",
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
    const res = await send("patch", "/small-works/not-a-uuid", {
      user: employee("e@example.test"),
      body: { x: 1 },
    });

    expect(res.status).toBe(403);
  });

  it("lets an admin do everything without any grant", async () => {
    const work = await made();

    expect((await send("get", "/small-works")).status).toBe(200);
    expect(
      (await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } })).status,
    ).toBe(200);
    expect((await send("delete", `/small-works/${work.id}`)).status).toBe(204);
  });
});

describe("POST /small-works", () => {
  it("creates a small work with its villa, creator, ETag and version 1; the status is PENDING when left out", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      villa: { id: villa.id, villaNumber: "P-001", location: "New Cairo . B1 . 1" },
      contractor: { id: contractorId, name: "Nile Builders" },
      startDate: "2026-03-04",
      endDate: "2026-03-06",
      description: "Replaced a broken socket",
      status: "PENDING",
      overdue: true,
      dueSoon: false,
      deadlineAt: "2026-03-06T21:00:00.000Z",
      createdBy: { id: admin.id, name: "Root Admin" },
      version: 1,
    });
    expect(smallWorkTables.works).toHaveLength(1);
    expect(smallWorkTables.works[0]?.createdById).toBe(admin.id);
    expect(smallWorkTables.works[0]?.status).toBe("PENDING");
  });

  it("takes an explicit status, and trims the texts", async () => {
    const res = await create({
      description: "  Painted the gate  ",
      status: "DONE",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      description: "Painted the gate",
      status: "DONE",
      overdue: false,
      dueSoon: false,
    });
  });

  it("has no natural key: the same work twice makes two rows", async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);

    expect(smallWorkTables.works).toHaveLength(2);
  });

  it("accepts the longest text: 500 characters of description", async () => {
    const res = await create({ description: "d".repeat(500) });

    expect(res.status).toBe(201);
  });

  it("answers 404 VILLA_NOT_FOUND for a villa that does not exist", async () => {
    const res = await create({ villaId: MISSING_ID }, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(smallWorkTables.works).toHaveLength(0);
  });

  it("turns a villa deleted in the middle into 404 VILLA_NOT_FOUND, writing nothing", async () => {
    smallWorkRaces.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((v) => v.id !== villa.id);
    };

    const res = await create();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(smallWorkTables.works).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 401 when the acting user is gone in the middle, writing nothing", async () => {
    smallWorkRaces.beforeWrite = () => {
      store.users.splice(
        store.users.findIndex((user) => user.id === admin.id),
        1,
      );
    };

    const res = await create();

    expect(res.status).toBe(401);
    expect(smallWorkTables.works).toHaveLength(0);
  });

  describe("the contractor", () => {
    it("is required: a request without one, or with null or a blank, is a 400 on contractorId", async () => {
      for (const contractorId of [undefined, null, "", "nope"]) {
        const res = await create({ contractorId });

        expect(res.status, String(contractorId)).toBe(400);
        expect(paths(res)).toEqual(["contractorId"]);
      }
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for one that does not exist, translated", async () => {
      const res = await create({ contractorId: MISSING_ID }, { language: "ar" });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "CONTRACTOR_NOT_FOUND", message: "المقاول غير موجود" });
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("answers 400 CONTRACTOR_INACTIVE for an inactive one, translated", async () => {
      const off = addContractor({ name: "Off Co", status: "INACTIVE" });

      const english = await create({ contractorId: off.id });
      const arabic = await create({ contractorId: off.id }, { language: "ar" });

      expect(english.status).toBe(400);
      expect(english.body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "This contractor is inactive and cannot be given a daily small work",
      });
      expect(arabic.body.message).toBe("هذا المقاول غير نشط ولا يمكن إسناد عمل صغير يومي إليه");
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("may be any active contractor, not only the one of the villa", async () => {
      const own = addContractor({ name: "Own Co" });
      villa.contractorId = own.id;

      const res = await create();

      expect(res.status).toBe(201);
      expect(res.body.data.contractor).toEqual({ id: contractorId, name: "Nile Builders" });
    });

    it("turns a contractor deleted in the middle into 404 CONTRACTOR_NOT_FOUND, writing nothing", async () => {
      smallWorkRaces.beforeWrite = () => {
        contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== contractorId);
      };

      const res = await create();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(smallWorkTables.works).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  });

  describe("the dates", () => {
    it("accept a range, and one day (the start is the end)", async () => {
      const range = await create({ startDate: "2026-03-04", endDate: "2026-03-09" });
      const one = await create({ startDate: "2026-03-04", endDate: "2026-03-04" });

      expect(range.status).toBe(201);
      expect(range.body.data).toMatchObject({ startDate: "2026-03-04", endDate: "2026-03-09" });
      expect(one.status).toBe(201);
    });

    it("refuse an end before the start with 422 SMALL_WORK_DATE_RANGE_INVALID, translated", async () => {
      const english = await create({ startDate: "2026-03-05", endDate: "2026-03-04" });
      const arabic = await create({ startDate: "2026-03-05", endDate: "2026-03-04" }, { language: "ar" });

      expect(english.status).toBe(422);
      expect(english.body).toMatchObject({
        code: "SMALL_WORK_DATE_RANGE_INVALID",
        message: "The end date cannot be before the start date",
      });
      expect(arabic.body.message).toBe("لا يمكن أن يكون تاريخ النهاية قبل تاريخ البداية");
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("have no future rule: next year is fine, and so is long ago", async () => {
      expect((await create({ startDate: daysFromToday(30), endDate: daysFromToday(60) })).status).toBe(201);
      expect((await create({ startDate: "2020-01-01", endDate: "2020-01-02" })).status).toBe(201);
    });

    it("are bounded to 10 years around today: a 400 on the date, translated", async () => {
      const far = new Date();
      far.setUTCFullYear(far.getUTCFullYear() + 11);
      const day = far.toISOString().slice(0, 10);

      const res = await create({ startDate: day, endDate: day }, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details[0]).toEqual({
        path: "startDate",
        message: "يجب أن يكون التاريخ ضمن 10 سنوات من اليوم",
      });
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("are required, real days without a time", async () => {
      for (const extra of [
        { startDate: undefined },
        { endDate: undefined },
        { startDate: null },
        { endDate: "2026-13-40" },
        { startDate: "2026-03-04T10:00:00Z" },
      ]) {
        const res = await create(extra);

        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
    });

    it("are told apart: an old workDate is no longer a field", async () => {
      const res = await create({ workDate: "2026-03-04" });

      expect(res.status).toBe(400);
    });
  });

  describe("overdue and due soon", () => {
    // Today in Asia/Kuwait is not always the UTC day, so the days are taken from the server's own rule.
    const kuwaitDay = (offset: number): string =>
      new Date(Date.now() + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

    it("a work ending yesterday and not done is overdue, not due soon", async () => {
      const res = await create({ startDate: kuwaitDay(-3), endDate: kuwaitDay(-1) });

      expect(res.body.data).toMatchObject({ overdue: true, dueSoon: false });
    });

    it("a work that is done is never flagged, but still has its deadline", async () => {
      const res = await create({ startDate: kuwaitDay(-3), endDate: kuwaitDay(-1), status: "DONE" });

      expect(res.body.data).toMatchObject({ overdue: false, dueSoon: false });
      expect(typeof res.body.data.deadlineAt).toBe("string");
    });

    it("a work ending in a week is neither", async () => {
      const res = await create({ startDate: kuwaitDay(0), endDate: kuwaitDay(7) });

      expect(res.body.data).toMatchObject({ overdue: false, dueSoon: false });
    });
  });

  describe("request validation (400, nothing is written)", () => {
    it.each([
      ["no villaId", { villaId: undefined }, "villaId"],
      ["a villaId that is not a UUID", { villaId: "nope" }, "villaId"],
      ["no contractorId", { contractorId: undefined }, "contractorId"],
      ["a contractorId that is not a UUID", { contractorId: "nope" }, "contractorId"],
      ["no startDate", { startDate: undefined }, "startDate"],
      ["a bad startDate", { startDate: "2026-13-40" }, "startDate"],
      ["a startDate with a time", { startDate: "2026-03-04T10:00:00Z" }, "startDate"],
      ["no endDate", { endDate: undefined }, "endDate"],
      ["a bad endDate", { endDate: "2026-13-40" }, "endDate"],
      ["no description", { description: undefined }, "description"],
      ["a blank description", { description: "   " }, "description"],
      ["a description over 500 characters", { description: "x".repeat(501) }, "description"],
      ["a number as the description", { description: 5 }, "description"],
      ["an unknown status", { status: "CANCELLED" }, "status"],
      ["a status in lower case", { status: "done" }, "status"],
      ["a null status", { status: null }, "status"],
    ])("refuses %s", async (_name, extra, path) => {
      const res = await create(extra);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(paths(res)).toContain(path);
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it.each([
      "id",
      "version",
      "createdById",
      "createdBy",
      "villa",
      "createdAt",
      "contractor",
      "overdue",
      "dueSoon",
      "deadlineAt",
      "doneBy",
      "workDate",
      "qty",
      "unit",
    ])("refuses the field %s that a client cannot set", async (field) => {
      const res = await create({ [field]: "x" });

      expect(res.status).toBe(400);
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("answers in Arabic on request", async () => {
      const res = await create({ description: "" }, { language: "ar" });

      expect(res.body.message).toBe("فشل التحقق");
      expect(res.body.details[0].message).toBe("يجب أن يكون الوصف بين 1 و500 حرف");
    });

    it("says what is wrong with each field, in English", async () => {
      const res = await create({
        status: "x",
        description: "",
      });

      const messages = Object.fromEntries(
        res.body.details.map((d: { path: string; message: string }) => [d.path, d.message]),
      );
      expect(messages).toMatchObject({
        status: "Status must be PENDING or DONE",
        description: "Description must be between 1 and 500 characters",
      });
    });
  });

  it("audits the creation with the full snapshot and no before", async () => {
    const res = await create({ status: "DONE" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "small_work.create",
      entity: "DailySmallWork",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        villaId: villa.id,
        contractorId,
        startDate: "2026-03-04",
        endDate: "2026-03-06",
        description: "Replaced a broken socket",
        status: "DONE",
      },
    });
    expect(auditRows()[0]?.before).toBeUndefined();
  });

  it("writes nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create();

    expect(res.status).toBe(500);
    expect(smallWorkTables.works).toHaveLength(0);
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await create({}, { key: KEY });
      const again = await create({}, { key: KEY });

      expect(firstTime.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(smallWorkTables.works).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await create({}, { key: KEY });

      const reused = await create({ description: "Other" }, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(smallWorkTables.works).toHaveLength(1);
    });
  });
});

describe("GET /small-works/:id", () => {
  it("answers one small work with its ETag", async () => {
    const work = await made({ status: "DONE" });

    const res = await send("get", `/small-works/${work.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.data).toEqual(work);
  });

  it("answers 404 SMALL_WORK_NOT_FOUND, translated", async () => {
    const res = await send("get", `/small-works/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "SMALL_WORK_NOT_FOUND",
      message: "العمل الصغير اليومي غير موجود",
    });
  });

  it("answers the same 404 in English", async () => {
    const res = await send("get", `/small-works/${MISSING_ID}`);

    expect(res.body).toMatchObject({ code: "SMALL_WORK_NOT_FOUND", message: "Daily small work not found" });
  });

  it("answers 400 for an id that is not a UUID", async () => {
    const res = await send("get", "/small-works/nope");

    expect(res.status).toBe(400);
  });
});

describe("PATCH /small-works/:id", () => {
  it("changes only the fields sent, bumps the version and answers the new ETag", async () => {
    const work = await made();

    const res = await send("patch", `/small-works/${work.id}`, {
      body: { description: "Fixed", status: "DONE" },
    });

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toMatchObject({
      startDate: "2026-03-04",
      endDate: "2026-03-06",
      contractor: { id: contractorId },
      description: "Fixed",
      status: "DONE",
      version: 2,
    });
  });

  it("changes every editable field at once, trimming the texts", async () => {
    const work = await made();
    const mona = addContractor({ name: "Mona Co" });

    const res = await send("patch", `/small-works/${work.id}`, {
      body: {
        contractorId: mona.id,
        startDate: "2026-03-06",
        endDate: "2026-03-09",
        description: "  New work ",
        status: "DONE",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      contractor: { id: mona.id, name: "Mona Co" },
      startDate: "2026-03-06",
      endDate: "2026-03-09",
      description: "New work",
      status: "DONE",
    });
  });

  it("moves a done work back to pending", async () => {
    const work = await made({ status: "DONE" });

    const res = await send("patch", `/small-works/${work.id}`, { body: { status: "PENDING" } });

    expect(res.body.data.status).toBe("PENDING");
  });

  it.each(["description"])("refuses a blank %s: the field is required", async (field) => {
    const work = await made();

    const res = await send("patch", `/small-works/${work.id}`, { body: { [field]: "   " } });

    expect(res.status).toBe(400);
    expect(paths(res)).toEqual([field]);
  });

  it("refuses null for every field", async () => {
    const work = await made();

    for (const field of ["contractorId", "startDate", "endDate", "description", "status"]) {
      const res = await send("patch", `/small-works/${work.id}`, { body: { [field]: null } });

      expect(res.status, field).toBe(400);
    }
  });

  it("refuses the villa, which is fixed once the small work exists, and every other field a client cannot set", async () => {
    const work = await made();

    for (const field of [
      "villaId",
      "id",
      "version",
      "createdById",
      "createdBy",
      "villa",
      "contractor",
      "doneBy",
      "workDate",
    ]) {
      const res = await send("patch", `/small-works/${work.id}`, { body: { [field]: bare.id } });

      expect(res.status, field).toBe(400);
    }
    expect(smallWorkTables.works[0]?.villaId).toBe(villa.id);
  });

  it("refuses a field that is not editable even when editable ones come with it", async () => {
    const work = await made();

    const res = await send("patch", `/small-works/${work.id}`, {
      body: { description: "Changed", villaId: bare.id },
    });

    expect(res.status).toBe(400);
    expect(smallWorkTables.works[0]?.description).toBe("Replaced a broken socket");
    expect(smallWorkTables.works[0]?.villaId).toBe(villa.id);
  });

  it("refuses an empty body", async () => {
    const work = await made();

    const res = await send("patch", `/small-works/${work.id}`, { body: {} });

    expect(res.status).toBe(400);
  });

  it("is refused with 409 VERSION_CONFLICT when the If-Match is stale, and changes nothing", async () => {
    const work = await made();
    await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } });

    const stale = await send("patch", `/small-works/${work.id}`, {
      body: { description: "Other" },
      ifMatch: '"1"',
    });

    conflict(stale, 2);
    expect(smallWorkTables.works[0]?.description).toBe("Changed");
    expect(auditRows().filter((row) => row.action === "small_work.update")).toHaveLength(1);
  });

  it("goes through with the current If-Match, or none", async () => {
    const work = await made();

    const current = await send("patch", `/small-works/${work.id}`, {
      body: { description: "Changed" },
      ifMatch: '"1"',
    });
    const none = await send("patch", `/small-works/${work.id}`, { body: { description: "Other" } });

    expect(current.status).toBe(200);
    expect(none.status).toBe(200);
    expect(none.body.data.version).toBe(3);
  });

  it("turns a version moved on in the middle into 409 VERSION_CONFLICT", async () => {
    const work = await made();
    smallWorkRaces.beforeWrite = () => {
      smallWorkTables.works[0]!.version += 1;
    };

    const res = await send("patch", `/small-works/${work.id}`, {
      body: { description: "Changed" },
      ifMatch: '"1"',
    });

    conflict(res, 2);
    expect(smallWorkTables.works[0]?.description).toBe("Replaced a broken socket");
  });

  it("answers 404 SMALL_WORK_NOT_FOUND for a small work that does not exist", async () => {
    const res = await send("patch", `/small-works/${MISSING_ID}`, { body: { description: "Changed" } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SMALL_WORK_NOT_FOUND");
  });

  it("answers 404 for a small work deleted in the middle", async () => {
    const work = await made();
    smallWorkRaces.beforeWrite = () => {
      smallWorkTables.works = [];
    };

    const res = await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SMALL_WORK_NOT_FOUND");
  });

  describe("the contractor", () => {
    it("can be changed to another active contractor", async () => {
      const work = await made();
      const mona = addContractor({ name: "Mona Co" });

      const res = await send("patch", `/small-works/${work.id}`, { body: { contractorId: mona.id } });

      expect(res.status).toBe(200);
      expect(res.body.data.contractor).toEqual({ id: mona.id, name: "Mona Co" });
    });

    it("refuses an inactive one with 400 CONTRACTOR_INACTIVE and an unknown one with 404, changing nothing", async () => {
      const work = await made();
      const off = addContractor({ name: "Off Co", status: "INACTIVE" });

      const inactive = await send("patch", `/small-works/${work.id}`, { body: { contractorId: off.id } });
      const missing = await send("patch", `/small-works/${work.id}`, { body: { contractorId: MISSING_ID } });

      expect(inactive.status).toBe(400);
      expect(inactive.body.code).toBe("CONTRACTOR_INACTIVE");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(smallWorkTables.works[0]?.contractorId).toBe(contractorId);
      expect(smallWorkTables.works[0]?.version).toBe(1);
    });

    it("stays saveable when the contractor was switched off later and the request does not move it", async () => {
      const work = await made();
      contractorTables.contractors[0]!.status = "INACTIVE";

      const res = await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } });

      expect(res.status).toBe(200);
    });
  });

  describe("the dates", () => {
    it("move to another day, even one the villa already has: there is no natural key", async () => {
      const work = await made();
      await made({ startDate: "2026-03-10", endDate: "2026-03-12" });

      const res = await send("patch", `/small-works/${work.id}`, {
        body: { startDate: "2026-03-10", endDate: "2026-03-12" },
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ startDate: "2026-03-10", endDate: "2026-03-12" });
    });

    it("check the order against the date that is stored when only one is sent: 422", async () => {
      const work = await made();

      const early = await send("patch", `/small-works/${work.id}`, { body: { endDate: "2026-03-03" } });
      const late = await send("patch", `/small-works/${work.id}`, {
        body: { startDate: "2026-03-07" },
        language: "ar",
      });

      expect(early.status).toBe(422);
      expect(early.body.code).toBe("SMALL_WORK_DATE_RANGE_INVALID");
      expect(late.status).toBe(422);
      expect(late.body.message).toBe("لا يمكن أن يكون تاريخ النهاية قبل تاريخ البداية");
      expect(smallWorkTables.works[0]?.version).toBe(1);
    });

    it("may stay the same when sent again", async () => {
      const work = await made();

      const res = await send("patch", `/small-works/${work.id}`, {
        body: { startDate: "2026-03-04", endDate: "2026-03-06", description: "Changed" },
      });

      expect(res.status).toBe(200);
    });

    it("may be moved to the future, but not past the bound of 10 years", async () => {
      const work = await made();
      const far = new Date();
      far.setUTCFullYear(far.getUTCFullYear() + 11);

      const next = await send("patch", `/small-works/${work.id}`, {
        body: { startDate: "2026-03-04", endDate: daysFromToday(30) },
      });
      const tooFar = await send("patch", `/small-works/${work.id}`, {
        body: { endDate: far.toISOString().slice(0, 10) },
      });

      expect(next.status).toBe(200);
      expect(tooFar.status).toBe(400);
      expect(tooFar.body.details).toEqual([
        { path: "endDate", message: "The date must be within 10 years of today" },
      ]);
    });

    it("leave a small work that is already out of the bound saveable when its dates are not touched", async () => {
      const far = new Date();
      far.setUTCFullYear(far.getUTCFullYear() + 12);
      const ahead = seedWork({ startDate: far, endDate: far, createdById: admin.id });

      const res = await send("patch", `/small-works/${ahead.id}`, { body: { description: "Changed" } });

      expect(res.status).toBe(200);
    });

    it("moving a work back to pending, or its end date, changes the flags the same response carries", async () => {
      const work = await made({ startDate: "2026-03-04", endDate: "2026-03-06", status: "DONE" });
      expect(work).toMatchObject({ overdue: false });

      const pending = await send("patch", `/small-works/${work.id}`, { body: { status: "PENDING" } });
      const later = await send("patch", `/small-works/${work.id}`, { body: { endDate: daysFromToday(30) } });

      expect(pending.body.data).toMatchObject({ overdue: true, dueSoon: false });
      expect(later.body.data).toMatchObject({ overdue: false, dueSoon: false });
    });
  });

  it("audits the change with the snapshots before and after", async () => {
    const work = await made();

    await send("patch", `/small-works/${work.id}`, { body: { description: "Fixed", status: "DONE" } });

    const entry = auditRows().find((row) => row.action === "small_work.update");
    expect(entry).toMatchObject({
      entity: "DailySmallWork",
      entityId: work.id,
      actorId: admin.id,
      before: { description: "Replaced a broken socket", status: "PENDING", villaId: villa.id },
      after: { description: "Fixed", status: "DONE", villaId: villa.id },
    });
  });

  it("writes nothing when the audit write fails", async () => {
    const work = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } });

    expect(res.status).toBe(500);
    expect(smallWorkTables.works[0]?.description).toBe("Replaced a broken socket");
    expect(smallWorkTables.works[0]?.version).toBe(1);
  });
});

describe("DELETE /small-works/:id", () => {
  it("removes the small work, audits it with its snapshot, and answers 204", async () => {
    const work = await made({ description: "Fixed a lamp" });

    const res = await send("delete", `/small-works/${work.id}`);

    expect(res.status).toBe(204);
    expect(smallWorkTables.works).toHaveLength(0);
    expect(auditRows().find((row) => row.action === "small_work.delete")).toMatchObject({
      entity: "DailySmallWork",
      entityId: work.id,
      actorId: admin.id,
      before: {
        villaId: villa.id,
        contractorId,
        startDate: "2026-03-04",
        endDate: "2026-03-06",
        description: "Fixed a lamp",
      },
    });
  });

  it("is refused with 409 VERSION_CONFLICT when stale, and the small work stays", async () => {
    const work = await made();
    await send("patch", `/small-works/${work.id}`, { body: { description: "Changed" } });

    const stale = await send("delete", `/small-works/${work.id}`, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(smallWorkTables.works).toHaveLength(1);
  });

  it("goes with the current If-Match", async () => {
    const work = await made();

    const res = await send("delete", `/small-works/${work.id}`, { ifMatch: '"1"' });

    expect(res.status).toBe(204);
  });

  it("answers 404 SMALL_WORK_NOT_FOUND for one that does not exist, and for one deleted in the middle", async () => {
    const work = await made();
    smallWorkRaces.beforeWrite = () => {
      smallWorkTables.works = [];
    };

    const missing = await send("delete", `/small-works/${MISSING_ID}`);
    const gone = await send("delete", `/small-works/${work.id}`);

    expect(missing.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("SMALL_WORK_NOT_FOUND");
  });

  it("writes nothing when the audit write fails", async () => {
    const work = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("delete", `/small-works/${work.id}`);

    expect(res.status).toBe(500);
    expect(smallWorkTables.works).toHaveLength(1);
  });
});

describe("GET /small-works", () => {
  // endDate: a 2026-03-05, b 2026-03-09, c 2026-03-07 (so newest end date first is b, c, a). Three contractors.
  let mona: { id: string };
  let karim: { id: string };
  const seed = (): Record<string, { id: string }> => {
    mona = addContractor({ name: "Mona Co" });
    karim = addContractor({ name: "Karim Co" });
    const a = addSmallWork({
      villaId: villa.id,
      contractorId,
      startDate: day("2026-03-01"),
      endDate: day("2026-03-05"),
      description: "Replaced a socket",
      status: "DONE",
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    const b = addSmallWork({
      villaId: villa.id,
      contractorId: mona.id,
      startDate: day("2026-03-03"),
      endDate: day("2026-03-09"),
      description: "Painted the gate",
      createdAt: new Date("2026-03-03T10:00:00Z"),
    });
    const c = addSmallWork({
      villaId: bare.id,
      contractorId: karim.id,
      startDate: day("2026-03-02"),
      endDate: day("2026-03-07"),
      description: "Fixed a tap",
      createdAt: new Date("2026-03-02T10:00:00Z"),
    });
    return { a, b, c };
  };
  const ids = (res: request.Response): string[] => res.body.data.map((row: { id: string }) => row.id);

  it("lists the latest end date first by default, with the page meta", async () => {
    const { a, b, c } = seed();

    const res = await send("get", "/small-works");

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([b!.id, c!.id, a!.id]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({
      villa: { villaNumber: "P-001" },
      contractor: { name: "Mona Co" },
      startDate: "2026-03-03",
      endDate: "2026-03-09",
    });
  });

  it("answers an empty page for nothing", async () => {
    const res = await send("get", "/small-works");

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  describe("paging", () => {
    it("pages by page and limit, and keeps the total", async () => {
      const { a, b, c } = seed();

      const first = await send("get", "/small-works?page=1&limit=2");
      const second = await send("get", "/small-works?page=2&limit=2");

      expect(ids(first)).toEqual([b!.id, c!.id]);
      expect(ids(second)).toEqual([a!.id]);
      expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it.each(["page=0", "page=abc", "limit=0", "limit=1001", "limit=1.5", "page=100001"])(
      "refuses %s with 400, never clamps it",
      async (query) => {
        const res = await send("get", `/small-works?${query}`);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
      },
    );
  });

  describe("sorting", () => {
    it.each([
      ["endDate", ["a", "c", "b"]],
      ["endDate:desc", ["b", "c", "a"]],
      ["startDate", ["a", "c", "b"]],
      ["startDate:desc", ["b", "c", "a"]],
      ["contractorName", ["c", "b", "a"].map((key) => ({ a: "a", b: "b", c: "c" })[key]!)],
      ["contractorName:desc", ["a", "b", "c"]],
      ["createdAt:asc", ["a", "c", "b"]],
      ["createdAt:desc", ["b", "c", "a"]],
    ])("sorts by %s", async (sort, expected) => {
      const rows = seed();

      const res = await send("get", `/small-works?sort=${sort}`);

      expect(ids(res)).toEqual(expected.map((key) => rows[key]!.id));
    });

    it("sorts by status in the order of the enum (PENDING, DONE), ties by id", async () => {
      const { a, b, c } = seed();
      const pending = [b!.id, c!.id].sort();

      expect(ids(await send("get", "/small-works?sort=status"))).toEqual([...pending, a!.id]);
      expect(ids(await send("get", "/small-works?sort=status:desc"))).toEqual([a!.id, ...pending]);
    });

    it("sorts by villaNumber in natural order, a villa's small works by the latest end date first", async () => {
      const { a, b, c } = seed();
      const ten = addVilla({ villaNumber: "P-010", block: "B1", plot: "10" });
      const nine = addVilla({ villaNumber: "P-9", block: "B1", plot: "9" });
      const d = addSmallWork({
        villaId: ten.id,
        contractorId,
        startDate: day("2026-03-05"),
        endDate: day("2026-03-05"),
      });
      const e = addSmallWork({
        villaId: nine.id,
        contractorId,
        startDate: day("2026-03-05"),
        endDate: day("2026-03-05"),
      });

      const asc = await send("get", "/small-works?sort=villaNumber");
      const desc = await send("get", "/small-works?sort=villaNumber:desc");

      expect(ids(asc)).toEqual([b!.id, a!.id, c!.id, e.id, d.id]);
      expect(ids(desc)).toEqual([d.id, e.id, c!.id, b!.id, a!.id]);
    });

    it("breaks ties by id, so a page never repeats or skips a row", async () => {
      const sameDay = [bare, villa].map((v) =>
        addSmallWork({
          villaId: v.id,
          contractorId,
          startDate: day("2026-04-01"),
          endDate: day("2026-04-01"),
        }),
      );

      const res = await send("get", "/small-works");

      expect(ids(res)).toEqual(sameDay.map((r) => r.id).sort());
    });

    it.each([
      "sort=qty",
      "sort=unit",
      "sort=endDate:sideways",
      "sort=",
      "sort=description",
      "sort=workDate",
      "sort=doneBy",
      "sort=EndDate",
      "sort=xendDate",
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/small-works?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("says what sorts exist, in Arabic on request", async () => {
      const res = await send("get", "/small-works?sort=nope", { language: "ar" });

      expect(res.body.details[0].message).toContain("endDate");
      expect(res.body.details[0].message).toContain("contractorName");
    });
  });

  describe("filters", () => {
    it("filters by villa", async () => {
      const { c } = seed();

      expect(ids(await send("get", `/small-works?villaId=${bare.id}`))).toEqual([c!.id]);
    });

    it("filters by status", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/small-works?status=DONE"))).toEqual([a!.id]);
      expect(ids(await send("get", "/small-works?status=PENDING"))).toEqual([b!.id, c!.id]);
    });

    it("filters by contractor", async () => {
      const { b } = seed();

      expect(ids(await send("get", `/small-works?contractorId=${mona.id}`))).toEqual([b!.id]);
    });

    it("filters by the range of the start date and by the range of the end date, both ends included", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/small-works?startFrom=2026-03-02&startTo=2026-03-03"))).toEqual([
        b!.id,
        c!.id,
      ]);
      expect(ids(await send("get", "/small-works?startFrom=2026-03-02&startTo=2026-03-02"))).toEqual([c!.id]);
      expect(ids(await send("get", "/small-works?startFrom=2026-03-03"))).toEqual([b!.id]);
      expect(ids(await send("get", "/small-works?startTo=2026-03-01"))).toEqual([a!.id]);
      expect(ids(await send("get", "/small-works?endFrom=2026-03-07&endTo=2026-03-09"))).toEqual([
        b!.id,
        c!.id,
      ]);
      expect(ids(await send("get", "/small-works?endTo=2026-03-05"))).toEqual([a!.id]);
    });

    it("takes one day as both ends of a range", async () => {
      const { b } = seed();

      const res = await send("get", "/small-works?endFrom=2026-03-09&endTo=2026-03-09");

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([b!.id]);
    });

    it("says an upside-down range is wrong on the last field of the range", async () => {
      const start = await send("get", "/small-works?startFrom=2026-03-05&startTo=2026-03-01");
      const end = await send("get", "/small-works?endFrom=2026-03-05&endTo=2026-03-01");

      expect(start.status).toBe(400);
      expect(start.body.details).toEqual([
        { path: "startTo", message: "The end date must not be before the start date" },
      ]);
      expect(end.body.details).toEqual([
        { path: "endTo", message: "The end date must not be before the start date" },
      ]);
    });

    describe("overdue and dueSoon, by the clock", () => {
      // The days are those of the server's rule (Asia/Kuwait, three hours ahead of UTC, the alert starting 8 hours before the end
      // of the day). The test never reads the real time of day: the clock (only Date) is pinned to fixed instants, and every
      // test starts at EVENING, which is on the "due soon" side of the boundary (16:00 in Kuwait and later).
      const EVENING = "2026-03-10T17:00:00.000Z"; // 20:00 on 2026-03-10 in Kuwait
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(EVENING));
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      const kuwaitDay = (offset: number): Date =>
        day(new Date(Date.now() + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10));
      const work = (endOffset: number, status: "PENDING" | "DONE" = "PENDING") =>
        seedWork({ startDate: kuwaitDay(endOffset - 1), endDate: kuwaitDay(endOffset), status });

      it("overdue=true is the pending ones past their end date; false is everything else", async () => {
        const late = work(-2);
        const lateButDone = work(-2, "DONE");
        const open = work(10);

        expect(ids(await send("get", "/small-works?overdue=true"))).toEqual([late.id]);
        expect(ids(await send("get", "/small-works?overdue=false")).sort()).toEqual(
          [lateButDone.id, open.id].sort(),
        );
      });

      it("dueSoon=true is the pending ones that end today (the alert hours reach the end of the day) and not overdue", async () => {
        const today = work(0);
        work(-1);
        work(10);
        work(0, "DONE");

        expect(ids(await send("get", "/small-works?dueSoon=true"))).toEqual([today.id]);
      });

      it("pins the clock: today in Kuwait is 2026-03-10 at the start of every test here", () => {
        expect(kuwaitDay(0)).toEqual(day("2026-03-10"));
        expect(kuwaitDay(-1)).toEqual(day("2026-03-09"));
      });

      // The boundary of "due soon": a work that ends today is due soon from 8 hours before the end of the day, 16:00 in Kuwait
      // (13:00 UTC). A millisecond earlier it is not.
      it.each([
        ["15:59:59.999 in Kuwait", "2026-03-10T12:59:59.999Z", false],
        ["16:00:00.000 in Kuwait", "2026-03-10T13:00:00.000Z", true],
        ["00:00:00.000 in Kuwait", "2026-03-09T21:00:00.000Z", false],
        ["23:59:59.999 in Kuwait", "2026-03-10T20:59:59.999Z", true],
      ])("a work that ends today is due soon at %s: %s", async (_label, instant, expected) => {
        vi.setSystemTime(new Date(instant));
        const today = seedWork({ startDate: day("2026-03-09"), endDate: day("2026-03-10") });
        // Tomorrow's work is never due soon on this day (8 hours before its end is after any of these instants).
        seedWork({ startDate: day("2026-03-10"), endDate: day("2026-03-11") });

        const listed = await send("get", "/small-works?dueSoon=true");
        const row = (await send("get", `/small-works/${today.id}`)).body.data;

        expect(ids(listed)).toEqual(expected ? [today.id] : []);
        expect(row.dueSoon).toBe(expected);
        expect(row.overdue).toBe(false);
      });

      // The boundary of "overdue": it changes at midnight in Kuwait (21:00 UTC), not at midnight UTC.
      it.each([
        ["23:59:59.999 in Kuwait on 03-09", "2026-03-09T20:59:59.999Z", false],
        ["00:00:00.000 in Kuwait on 03-10", "2026-03-09T21:00:00.000Z", true],
        ["00:00:00 UTC on 03-10, already 03:00 in Kuwait", "2026-03-10T00:00:00.000Z", true],
      ])("a work that ended on 2026-03-09 is overdue at %s: %s", async (_label, instant, expected) => {
        vi.setSystemTime(new Date(instant));
        const ended = seedWork({ startDate: day("2026-03-08"), endDate: day("2026-03-09") });

        const listed = await send("get", "/small-works?overdue=true");
        const row = (await send("get", `/small-works/${ended.id}`)).body.data;

        expect(ids(listed)).toEqual(expected ? [ended.id] : []);
        expect(row.overdue).toBe(expected);
      });

      it("both flags together are both conditions: overdue and not due soon", async () => {
        const late = work(-2);
        work(0);

        expect(ids(await send("get", "/small-works?overdue=true&dueSoon=false"))).toEqual([late.id]);
        expect(ids(await send("get", "/small-works?overdue=true&dueSoon=true"))).toEqual([]);
      });

      it("the flags in the list are the ones the filters use", async () => {
        const late = work(-2);
        const today = work(0);
        work(10);

        const res = await send("get", "/small-works");

        const flags = Object.fromEntries(
          res.body.data.map((row: { id: string; overdue: boolean; dueSoon: boolean }) => [
            row.id,
            [row.overdue, row.dueSoon],
          ]),
        );
        expect(flags[late.id]).toEqual([true, false]);
        expect(flags[today.id]).toEqual([false, true]);
        expect(Object.values(flags).filter(([o, d]) => o || d)).toHaveLength(2);
      });

      it.each(["overdue=yes", "overdue=1", "dueSoon=TRUE", "overdue="])(
        "refuses %s with 400",
        async (query) => {
          const res = await send("get", `/small-works?${query}`);

          expect(res.status).toBe(400);
        },
      );
    });

    it("ignores spaces around the search", async () => {
      const { a } = seed();

      expect(ids(await send("get", "/small-works?search=%20%20socket%20%20"))).toEqual([a!.id]);
    });

    it("searches the description, the contractor's name and the villa number, ignoring case", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/small-works?search=SOCKET"))).toEqual([a!.id]);
      expect(ids(await send("get", "/small-works?search=gate"))).toEqual([b!.id]);
      expect(ids(await send("get", "/small-works?search=pcs"))).toEqual([]);
      expect(ids(await send("get", "/small-works?search=karim%20co"))).toEqual([c!.id]);
      expect(ids(await send("get", "/small-works?search=P-002"))).toEqual([c!.id]);
    });

    it("combines filters", async () => {
      const { a } = seed();

      const res = await send("get", `/small-works?villaId=${villa.id}&status=DONE&search=socket`);

      expect(ids(res)).toEqual([a!.id]);
      expect(res.body.meta.total).toBe(1);
    });

    it("accepts a search of exactly 100 characters", async () => {
      const res = await send("get", `/small-works?search=${"x".repeat(100)}`);

      expect(res.status).toBe(200);
    });

    it.each([
      "villaId=x",
      "status=CANCELLED",
      "status=done",
      "contractorId=x",
      "startFrom=2026-13-01",
      "endTo=yesterday",
      "endFrom=2026-03-05&endTo=2026-03-01",
      `search=${"x".repeat(101)}`,
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/small-works?${query}`);

      expect(res.status).toBe(400);
    });
  });
});

describe("deleting a villa that has small works", () => {
  it("is refused with 409 VILLA_HAS_RECORDS, translated; the villa and the small work stay", async () => {
    await made();

    const res = await send("delete", `/villas/${villa.id}`, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "VILLA_HAS_RECORDS",
      message:
        "هذه الفيلا بها أعمال مفتوحة أُضيفت يدويًا أو أعمال صغيرة يومية أو تقارير موقع أو عمالة يومية أو توريدات مواد. احذفها أولاً",
    });
    expect(villaTables.villas.some((v) => v.id === villa.id)).toBe(true);
    expect(smallWorkTables.works).toHaveLength(1);
  });

  it("is allowed again once its small works are deleted, and another villa's small works do not matter", async () => {
    const work = await made();
    await made({ villaId: bare.id });
    await send("delete", `/small-works/${work.id}`);

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(204);
    expect(smallWorkTables.works).toHaveLength(1);
  });
});
