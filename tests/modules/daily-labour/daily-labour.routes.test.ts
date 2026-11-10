import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addDailyLabour, dailyLabourRaces, dailyLabourTables } from "./in-memory-daily-labour.repository.js";

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
vi.mock("../../../src/modules/daily-labour/repository/daily-labour.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/daily-labour/repository/daily-labour.repository.js")
  >()),
  DailyLabourRepository: (await import("./in-memory-daily-labour.repository.js"))
    .InMemoryDailyLabourRepository,
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
let other: StoredVilla;
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  idempotencyTable.reset();
  dailyLabourRaces.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  villa = addVilla({ villaNumber: "P-001", contractorId: nile.id, block: "B1", plot: "1" });
  bare = addVilla({ villaNumber: "P-002", block: "B1", plot: "2" });
  other = addVilla({ villaNumber: "P-003", contractorId: delta.id, block: "B1", plot: "3" });
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
  labourDate: "2026-03-04",
  contractorId: nile.id,
  labourCount: 25,
  ...extra,
});
const create = (extra: Record<string, unknown> = {}, options: Options = {}) =>
  send("post", "/daily-labour", { body: body(extra), ...options });
const made = async (extra: Record<string, unknown> = {}) => (await create(extra)).body.data;
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("access control", () => {
  const ROUTES: [Verb, string, string][] = [
    ["get", "/daily-labour", "daily-labour:read"],
    ["get", `/daily-labour/${MISSING_ID}`, "daily-labour:read"],
    ["post", "/daily-labour", "daily-labour:create"],
    ["patch", `/daily-labour/${MISSING_ID}`, "daily-labour:update"],
    ["delete", `/daily-labour/${MISSING_ID}`, "daily-labour:delete"],
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
    "%s %s needs exactly %s, and no other daily-labour permission opens it",
    async (verb, path, code) => {
      const others = [
        "daily-labour:read",
        "daily-labour:create",
        "daily-labour:update",
        "daily-labour:delete",
        "daily-labour:export",
        "daily-labour:import",
      ]
        .filter((other) => other !== code)
        .concat("daily-reports:read", "open-works:update", "villas:read", "villas:update", "dashboard:read");

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
    const res = await send("patch", "/daily-labour/not-a-uuid", {
      user: employee("e@example.test"),
      body: { x: 1 },
    });

    expect(res.status).toBe(403);
  });

  it("lets an admin do everything without any grant", async () => {
    const row = await made();

    expect((await send("get", "/daily-labour")).status).toBe(200);
    expect((await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 3 } })).status).toBe(200);
    expect((await send("delete", `/daily-labour/${row.id}`)).status).toBe(204);
  });
});

describe("POST /daily-labour", () => {
  it("creates a row with its villa, contractor, creator, ETag and version 1", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      villa: { id: villa.id, villaNumber: "P-001", location: "New Cairo . B1 . 1" },
      labourDate: "2026-03-04",
      contractor: { id: nile.id, name: "Nile Builders" },
      labourCount: 25,
      notes: null,
      createdBy: { id: admin.id, name: "Root Admin" },
      version: 1,
    });
    expect(dailyLabourTables.rows).toHaveLength(1);
    expect(dailyLabourTables.rows[0]?.createdById).toBe(admin.id);
  });

  it("takes the notes, and trims them", async () => {
    const res = await create({ notes: "  Half the team on the roof  " });

    expect(res.status).toBe(201);
    expect(res.body.data.notes).toBe("Half the team on the roof");
  });

  it.each([
    ["notes left out", {}],
    ["notes null", { notes: null }],
    ["notes blank", { notes: "   " }],
    ["notes empty", { notes: "" }],
  ])("stores no notes for %s", async (_name, extra) => {
    const res = await create(extra);

    expect(res.status).toBe(201);
    expect(res.body.data.notes).toBeNull();
    expect(dailyLabourTables.rows[0]?.notes).toBeNull();
  });

  describe("the boundaries", () => {
    it.each([0, 1, 99_999, 100_000])("accepts a labourCount of %i", async (labourCount) => {
      const res = await create({ labourCount });

      expect(res.status).toBe(201);
      expect(res.body.data.labourCount).toBe(labourCount);
    });

    it.each([
      ["-1", -1],
      ["100,001", 100_001],
      ["1.5", 1.5],
      ["the text '5'", "5"],
      ["null", null],
      ["true", true],
    ])("refuses a labourCount of %s", async (_name, labourCount) => {
      const res = await create({ labourCount });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain("labourCount");
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("accepts notes of 500 characters, Arabic ones included, and refuses 501", async () => {
      expect((await create({ notes: "n".repeat(500) })).status).toBe(201);
      expect((await create({ labourDate: "2026-03-05", notes: "ش".repeat(500) })).status).toBe(201);

      const long = await create({ labourDate: "2026-03-06", notes: "n".repeat(501) });

      expect(long.status).toBe(400);
      expect(long.body.details.map((d: { path: string }) => d.path)).toContain("notes");
      expect(dailyLabourTables.rows).toHaveLength(2);
    });

    it("counts 501 characters after the trim: a note of 500 with blanks around is fine", async () => {
      expect((await create({ notes: ` ${"n".repeat(500)} ` })).status).toBe(201);
    });

    it("gives the same message for a count that is not even a number", async () => {
      const res = await create({ labourCount: "twelve" });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "labourCount", message: "Labour count must be a whole number from 0 to 100,000" },
      ]);
    });

    it("says what is wrong, in English and in Arabic", async () => {
      const en = await create({ labourCount: -3, notes: "n".repeat(501) });
      const ar = await create({ labourCount: -3 }, { language: "ar" });

      const messages = Object.fromEntries(
        en.body.details.map((d: { path: string; message: string }) => [d.path, d.message]),
      );
      expect(messages).toMatchObject({
        labourCount: "Labour count must be a whole number from 0 to 100,000",
        notes: "Notes must be at most 500 characters",
      });
      expect(ar.body.message).toBe("فشل التحقق");
      expect(ar.body.details[0].message).toBe("يجب أن يكون عدد العمال عددًا صحيحًا من 0 إلى 100,000");
    });
  });

  describe("the key: one row per villa, contractor and day", () => {
    it("answers 409 DAILY_LABOUR_EXISTS for the same villa, contractor and day, translated", async () => {
      await create();

      const again = await create({ labourCount: 3 }, { language: "ar" });

      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: "DAILY_LABOUR_EXISTS",
        message: "هذه الفيلا لديها سجل عمالة لهذا المقاول في هذا التاريخ بالفعل",
      });
      expect(dailyLabourTables.rows).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers it in English too", async () => {
      await create();

      const again = await create();

      expect(again.body.message).toBe("This villa already has a labour row for this contractor on this date");
    });

    it("allows the same day on another villa (with its own contractor), and another day on the same villa", async () => {
      expect((await create()).status).toBe(201);
      expect((await create({ villaId: other.id, contractorId: delta.id })).status).toBe(201);
      expect((await create({ labourDate: "2026-03-05" })).status).toBe(201);
      expect(dailyLabourTables.rows).toHaveLength(3);
    });

    it("allows the same day for another contractor once the villa moved to it", async () => {
      await create();
      villa.contractorId = delta.id;

      const res = await create({ contractorId: delta.id });

      expect(res.status).toBe(201);
      expect(dailyLabourTables.rows).toHaveLength(2);
    });

    it("turns a row saved by someone else in the middle into 409 DAILY_LABOUR_EXISTS: the unique index has the last word", async () => {
      dailyLabourRaces.beforeWrite = () => {
        addDailyLabour({ villaId: villa.id, contractorId: nile.id, labourDate: day("2026-03-04") });
      };

      const res = await create();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_LABOUR_EXISTS");
      expect(dailyLabourTables.rows).toHaveLength(1);
      expect(auditRows()).toHaveLength(0);
    });

    it("lets one of two creates sent together through and answers the other 409", async () => {
      const [first, second] = await Promise.all([create(), create()]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(dailyLabourTables.rows).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });
  });

  it("answers 404 VILLA_NOT_FOUND for a villa that does not exist", async () => {
    const res = await create({ villaId: MISSING_ID });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(dailyLabourTables.rows).toHaveLength(0);
  });

  it("turns a villa deleted in the middle into 404 VILLA_NOT_FOUND, writing nothing", async () => {
    dailyLabourRaces.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((v) => v.id !== villa.id);
    };

    const res = await create();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(dailyLabourTables.rows).toHaveLength(0);
  });

  describe("the contractor", () => {
    it("is required, and never filled in by the system", async () => {
      const res = await create({ contractorId: undefined });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain("contractorId");
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("cannot be null", async () => {
      const res = await create({ contractorId: null });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain("contractorId");
    });

    it("is the villa's one contractor: another one is 422 CONTRACTOR_NOT_ON_VILLA, translated", async () => {
      const res = await create({ contractorId: delta.id }, { language: "ar" });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_NOT_ON_VILLA",
        message: "هذا المقاول ليس مقاول هذه الفيلا",
      });
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("cannot be set on a villa that has none: such a villa refuses every contractor", async () => {
      const res = await create({ villaId: bare.id, contractorId: nile.id });
      const other = await create({ villaId: bare.id, contractorId: delta.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
      expect(other.status).toBe(422);
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for one that does not exist, before the villa is compared", async () => {
      const res = await create({ contractorId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(res.body.message).toBe("Contractor not found");
    });

    it("answers 400 CONTRACTOR_INACTIVE for the villa's contractor when it is switched off, translated", async () => {
      nile.status = "INACTIVE";

      const res = await create({}, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن إضافة سجل عمالة يومية له",
      });
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("says why in English", async () => {
      nile.status = "INACTIVE";

      const res = await create();

      expect(res.body.message).toBe("This contractor is inactive and cannot be given a daily labour row");
    });

    it("checks 'not on the villa' before 'inactive': an inactive contractor of another villa is 422", async () => {
      delta.status = "INACTIVE";

      const res = await create({ contractorId: delta.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
    });

    it("is checked under the villa's lock: a villa that moved to another contractor in the middle is refused", async () => {
      dailyLabourRaces.beforeWrite = () => {
        villa.contractorId = delta.id;
      };

      const res = await create();

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("turns a contractor deleted in the middle into 404 CONTRACTOR_NOT_FOUND (foreign key)", async () => {
      dailyLabourRaces.beforeWrite = () => {
        contractorTables.contractors = contractorTables.contractors.filter((c) => c.id !== nile.id);
      };

      const res = await create();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
      expect(dailyLabourTables.rows).toHaveLength(0);
    });
  });

  describe("the date", () => {
    it("may be today, yesterday, and tomorrow", async () => {
      expect((await create({ labourDate: daysFromToday(0) })).status).toBe(201);
      expect((await create({ labourDate: daysFromToday(-1) })).status).toBe(201);
      expect((await create({ labourDate: daysFromToday(1) })).status).toBe(201);
    });

    it("may not be more than one day past today: 400 on the labourDate, translated", async () => {
      const res = await create({ labourDate: daysFromToday(2) }, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toEqual([
        { path: "labourDate", message: "لا يمكن أن يزيد تاريخ العمالة عن يوم واحد بعد اليوم" },
      ]);
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it("may be long ago", async () => {
      expect((await create({ labourDate: "2020-01-01" })).status).toBe(201);
    });
  });

  describe("request validation (400, nothing is written)", () => {
    it.each([
      ["no villaId", { villaId: undefined }, "villaId"],
      ["a villaId that is not a UUID", { villaId: "nope" }, "villaId"],
      ["no labourDate", { labourDate: undefined }, "labourDate"],
      ["a bad labourDate", { labourDate: "2026-13-40" }, "labourDate"],
      ["a labourDate with a time", { labourDate: "2026-03-04T10:00:00Z" }, "labourDate"],
      ["no labourCount", { labourCount: undefined }, "labourCount"],
      ["a number as notes", { notes: 5 }, "notes"],
      ["a contractorId that is not a UUID", { contractorId: "x" }, "contractorId"],
    ])("refuses %s", async (_name, extra, path) => {
      const res = await create(extra);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
      expect(dailyLabourTables.rows).toHaveLength(0);
    });

    it.each(["id", "version", "createdById", "createdBy", "villa", "contractor", "createdAt"])(
      "refuses the field %s that a client cannot set",
      async (field) => {
        const res = await create({ [field]: "x" });

        expect(res.status).toBe(400);
        expect(dailyLabourTables.rows).toHaveLength(0);
      },
    );
  });

  it("audits the creation with the full snapshot and no before", async () => {
    const res = await create({ notes: "Roof" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "daily_labour.create",
      entity: "DailyLabour",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        villaId: villa.id,
        labourDate: "2026-03-04",
        contractorId: nile.id,
        labourCount: 25,
        notes: "Roof",
      },
    });
    expect(auditRows()[0]?.before).toBeUndefined();
  });

  it("writes nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create();

    expect(res.status).toBe(500);
    expect(dailyLabourTables.rows).toHaveLength(0);
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await create({}, { key: KEY });
      const again = await create({}, { key: KEY });

      expect(firstTime.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(dailyLabourTables.rows).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await create({}, { key: KEY });

      const reused = await create({ labourCount: 1 }, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(dailyLabourTables.rows).toHaveLength(1);
    });
  });
});

describe("GET /daily-labour/:id", () => {
  it("answers one row with its ETag", async () => {
    const row = await made({ notes: "Roof" });

    const res = await send("get", `/daily-labour/${row.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.data).toEqual(row);
  });

  it("reports the time the row was last changed, not the time it was made", async () => {
    const stored = addDailyLabour({
      villaId: villa.id,
      contractorId: nile.id,
      createdAt: new Date("2026-03-01T10:00:00Z"),
      updatedAt: new Date("2026-03-05T12:30:00Z"),
    });

    const res = await send("get", `/daily-labour/${stored.id}`);

    expect(res.body.data).toMatchObject({
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-05T12:30:00.000Z",
    });
  });

  it("answers 404 DAILY_LABOUR_NOT_FOUND, translated", async () => {
    const res = await send("get", `/daily-labour/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "DAILY_LABOUR_NOT_FOUND",
      message: "سجل العمالة اليومية غير موجود",
    });
  });

  it("answers 404 in English too", async () => {
    const res = await send("get", `/daily-labour/${MISSING_ID}`);

    expect(res.body.message).toBe("Daily labour row not found");
  });

  it("answers 400 for an id that is not a UUID", async () => {
    const res = await send("get", "/daily-labour/nope");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /daily-labour/:id", () => {
  it("changes only the fields sent, bumps the version and answers the new ETag", async () => {
    const row = await made({ notes: "Roof" });

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 40 } });

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toMatchObject({
      labourDate: "2026-03-04",
      contractor: { id: nile.id },
      labourCount: 40,
      notes: "Roof",
      version: 2,
    });
  });

  it("changes every editable field at once, trimming the notes", async () => {
    const row = await made();
    villa.contractorId = delta.id;

    const res = await send("patch", `/daily-labour/${row.id}`, {
      body: { labourDate: "2026-03-06", contractorId: delta.id, labourCount: 7, notes: "  New note " },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      labourDate: "2026-03-06",
      contractor: { id: delta.id },
      labourCount: 7,
      notes: "New note",
    });
  });

  it.each([null, "", "   "])("clears the notes when they are sent as %j", async (value) => {
    const row = await made({ notes: "Roof" });

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { notes: value } });

    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBeNull();
  });

  it.each([
    ["-1", -1],
    ["100,001", 100_001],
    ["1.5", 1.5],
    ["the text '5'", "5"],
  ])("refuses a labourCount of %s", async (_name, labourCount) => {
    const row = await made();

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount } });

    expect(res.status).toBe(400);
    expect(dailyLabourTables.rows[0]?.labourCount).toBe(25);
  });

  it.each([0, 100_000])("accepts a labourCount of %i", async (labourCount) => {
    const row = await made();

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount } });

    expect(res.status).toBe(200);
    expect(res.body.data.labourCount).toBe(labourCount);
  });

  it("refuses notes over 500 characters", async () => {
    const row = await made();

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { notes: "n".repeat(501) } });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain("notes");
  });

  it("refuses the villa, which is fixed once the row exists, and every other field a client cannot set", async () => {
    const row = await made();

    for (const field of ["villaId", "id", "version", "createdById"]) {
      // Next to a field that is allowed, so the refusal is for the field itself and not for an empty change.
      const res = await send("patch", `/daily-labour/${row.id}`, {
        body: { labourCount: 3, [field]: bare.id },
      });
      expect(res.status, field).toBe(400);
    }
    expect(dailyLabourTables.rows[0]?.villaId).toBe(villa.id);
    expect(dailyLabourTables.rows[0]?.labourCount).toBe(row.labourCount);
  });

  it("refuses an empty body", async () => {
    const row = await made();

    const res = await send("patch", `/daily-labour/${row.id}`, { body: {} });

    expect(res.status).toBe(400);
  });

  it("is refused with 409 VERSION_CONFLICT when the If-Match is stale, and changes nothing", async () => {
    const row = await made();
    await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 1 } });

    const stale = await send("patch", `/daily-labour/${row.id}`, {
      body: { labourCount: 2 },
      ifMatch: '"1"',
    });

    conflict(stale, 2);
    expect(dailyLabourTables.rows[0]?.labourCount).toBe(1);
    expect(auditRows().filter((entry) => entry.action === "daily_labour.update")).toHaveLength(1);
  });

  it("goes through with the current If-Match, or none", async () => {
    const row = await made();

    const current = await send("patch", `/daily-labour/${row.id}`, {
      body: { labourCount: 2 },
      ifMatch: '"1"',
    });
    const none = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 3 } });

    expect(current.status).toBe(200);
    expect(none.status).toBe(200);
    expect(none.body.data.version).toBe(3);
  });

  it("turns a version moved on in the middle into 409 VERSION_CONFLICT", async () => {
    const row = await made();
    dailyLabourRaces.beforeWrite = () => {
      dailyLabourTables.rows[0]!.version += 1;
    };

    const res = await send("patch", `/daily-labour/${row.id}`, {
      body: { labourCount: 2 },
      ifMatch: '"1"',
    });

    conflict(res, 2);
    expect(dailyLabourTables.rows[0]?.labourCount).toBe(25);
  });

  it("answers 404 DAILY_LABOUR_NOT_FOUND for a row that does not exist", async () => {
    const res = await send("patch", `/daily-labour/${MISSING_ID}`, { body: { labourCount: 2 } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DAILY_LABOUR_NOT_FOUND");
  });

  describe("the key", () => {
    it("cannot move onto a day the villa and contractor already have: 409 DAILY_LABOUR_EXISTS, nothing changes", async () => {
      const row = await made();
      await made({ labourDate: "2026-03-10" });

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourDate: "2026-03-10" } });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_LABOUR_EXISTS");
      expect(dailyLabourTables.rows.find((r) => r.id === row.id)?.labourDate).toEqual(day("2026-03-04"));
      expect(auditRows().filter((entry) => entry.action === "daily_labour.update")).toHaveLength(0);
    });

    it("cannot change to a contractor that already has the day: 409 DAILY_LABOUR_EXISTS", async () => {
      villa.contractorId = delta.id;
      const mine = addDailyLabour({
        villaId: villa.id,
        contractorId: delta.id,
        labourDate: day("2026-03-04"),
        createdById: admin.id,
      });
      const row = addDailyLabour({
        villaId: villa.id,
        contractorId: nile.id,
        labourDate: day("2026-03-04"),
        createdById: admin.id,
      });

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: delta.id } });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_LABOUR_EXISTS");
      expect(dailyLabourTables.rows.find((r) => r.id === row.id)?.contractorId).toBe(nile.id);
      expect(mine.version).toBe(1);
    });

    it("moves to a free day of the same villa and contractor", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourDate: "2026-03-10" } });

      expect(res.status).toBe(200);
      expect(res.body.data.labourDate).toBe("2026-03-10");
    });

    it("may stay on its own key when it is sent again", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, {
        body: { labourDate: "2026-03-04", contractorId: nile.id, labourCount: 1 },
      });

      expect(res.status).toBe(200);
    });

    it("turns a row saved on the target key in the middle into 409 DAILY_LABOUR_EXISTS", async () => {
      const row = await made();
      dailyLabourRaces.beforeWrite = () => {
        addDailyLabour({ villaId: villa.id, contractorId: nile.id, labourDate: day("2026-03-10") });
      };

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourDate: "2026-03-10" } });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DAILY_LABOUR_EXISTS");
    });
  });

  describe("the date", () => {
    it("may not be moved more than one day past today", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, {
        body: { labourDate: daysFromToday(2) },
        language: "ar",
      });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { path: "labourDate", message: "لا يمكن أن يزيد تاريخ العمالة عن يوم واحد بعد اليوم" },
      ]);
    });

    it("may be moved to tomorrow", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, {
        body: { labourDate: daysFromToday(1) },
      });

      expect(res.status).toBe(200);
    });

    it("leaves a row that is already too far ahead saveable when its date is not touched", async () => {
      const ahead = addDailyLabour({
        villaId: villa.id,
        contractorId: nile.id,
        labourDate: day(daysFromToday(5)),
        createdById: admin.id,
      });

      const res = await send("patch", `/daily-labour/${ahead.id}`, { body: { labourCount: 3 } });
      const same = await send("patch", `/daily-labour/${ahead.id}`, {
        body: { labourDate: daysFromToday(5) },
      });

      expect(res.status).toBe(200);
      expect(same.status).toBe(200);
    });
  });

  describe("the contractor", () => {
    it("is checked when this request changes it: another villa's contractor is 422", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: delta.id } });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
    });

    it("answers 404 for one that does not exist", async () => {
      const row = await made();

      const missing = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: MISSING_ID } });

      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("CONTRACTOR_NOT_FOUND");
    });

    it("answers 400 for a new one that is switched off", async () => {
      const row = await made();
      villa.contractorId = delta.id;
      delta.status = "INACTIVE";

      const inactive = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: delta.id } });

      expect(inactive.status).toBe(400);
      expect(inactive.body.code).toBe("CONTRACTOR_INACTIVE");
    });

    it("cannot be cleared: null is refused", async () => {
      const row = await made();

      const res = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: null } });

      expect(res.status).toBe(400);
      expect(dailyLabourTables.rows[0]?.contractorId).toBe(nile.id);
    });

    it("stays on the row when the villa moves to another contractor, and the row stays saveable", async () => {
      const row = await made();
      villa.contractorId = delta.id;

      const fetched = await send("get", `/daily-labour/${row.id}`);
      const saved = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 9 } });
      const same = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: nile.id } });

      expect(fetched.body.data.contractor.id).toBe(nile.id);
      expect(saved.status).toBe(200);
      expect(saved.body.data.contractor.id).toBe(nile.id);
      expect(same.status).toBe(200);
    });

    it("may be changed to the villa's current contractor after the villa moved", async () => {
      const row = await made();
      villa.contractorId = delta.id;

      const back = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: delta.id } });
      const old = await send("patch", `/daily-labour/${row.id}`, { body: { contractorId: nile.id } });

      expect(back.status).toBe(200);
      expect(back.body.data.contractor.id).toBe(delta.id);
      expect(old.status).toBe(422);
    });

    it("is checked under the villa's lock when the villa moves in the middle", async () => {
      const row = await made();
      dailyLabourRaces.beforeWrite = () => {
        villa.contractorId = delta.id;
      };

      const res = await send("patch", `/daily-labour/${row.id}`, {
        body: { contractorId: nile.id, labourCount: 2 },
      });

      // The contractor is not changed (it is the row's own), so the move of the villa does not matter.
      expect(res.status).toBe(200);
    });
  });

  it("audits the change with the snapshots before and after", async () => {
    const row = await made();

    await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 40, notes: "Rain" } });

    const entry = auditRows().find((candidate) => candidate.action === "daily_labour.update");
    expect(entry).toMatchObject({
      entity: "DailyLabour",
      entityId: row.id,
      actorId: admin.id,
      before: { labourCount: 25, notes: null, labourDate: "2026-03-04", contractorId: nile.id },
      after: { labourCount: 40, notes: "Rain", labourDate: "2026-03-04", contractorId: nile.id },
    });
  });

  it("writes nothing when the audit write fails", async () => {
    const row = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 2 } });

    expect(res.status).toBe(500);
    expect(dailyLabourTables.rows[0]?.labourCount).toBe(25);
    expect(dailyLabourTables.rows[0]?.version).toBe(1);
  });
});

describe("DELETE /daily-labour/:id", () => {
  it("removes the row, audits it with its snapshot, and answers 204", async () => {
    const row = await made({ notes: "Roof" });

    const res = await send("delete", `/daily-labour/${row.id}`);

    expect(res.status).toBe(204);
    expect(dailyLabourTables.rows).toHaveLength(0);
    expect(auditRows().find((entry) => entry.action === "daily_labour.delete")).toMatchObject({
      entity: "DailyLabour",
      entityId: row.id,
      actorId: admin.id,
      before: { villaId: villa.id, labourDate: "2026-03-04", contractorId: nile.id, notes: "Roof" },
    });
  });

  it("frees the key: the villa can record it again", async () => {
    const row = await made();
    await send("delete", `/daily-labour/${row.id}`);

    expect((await create()).status).toBe(201);
  });

  it("is refused with 409 VERSION_CONFLICT when stale, and the row stays", async () => {
    const row = await made();
    await send("patch", `/daily-labour/${row.id}`, { body: { labourCount: 1 } });

    const stale = await send("delete", `/daily-labour/${row.id}`, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(dailyLabourTables.rows).toHaveLength(1);
  });

  it("goes with the current If-Match", async () => {
    const row = await made();

    const res = await send("delete", `/daily-labour/${row.id}`, { ifMatch: '"1"' });

    expect(res.status).toBe(204);
  });

  it("answers 404 DAILY_LABOUR_NOT_FOUND for a row that does not exist, and for one deleted in the middle", async () => {
    const row = await made();
    dailyLabourRaces.beforeWrite = () => {
      dailyLabourTables.rows = [];
    };

    const missing = await send("delete", `/daily-labour/${MISSING_ID}`);
    const gone = await send("delete", `/daily-labour/${row.id}`);

    expect(missing.status).toBe(404);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("DAILY_LABOUR_NOT_FOUND");
  });

  it("writes nothing when the audit write fails", async () => {
    const row = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await send("delete", `/daily-labour/${row.id}`);

    expect(res.status).toBe(500);
    expect(dailyLabourTables.rows).toHaveLength(1);
  });
});

describe("GET /daily-labour", () => {
  const seed = (): Record<string, { id: string }> => {
    const a = addDailyLabour({
      villaId: villa.id,
      contractorId: nile.id,
      labourDate: day("2026-03-01"),
      labourCount: 30,
      notes: "Excavation crew",
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    const b = addDailyLabour({
      villaId: villa.id,
      contractorId: nile.id,
      labourDate: day("2026-03-03"),
      labourCount: 5,
      createdAt: new Date("2026-03-03T10:00:00Z"),
    });
    const c = addDailyLabour({
      villaId: other.id,
      contractorId: delta.id,
      labourDate: day("2026-03-02"),
      labourCount: 12,
      notes: "Formwork",
      createdAt: new Date("2026-03-02T10:00:00Z"),
    });
    return { a, b, c };
  };
  const ids = (res: request.Response): string[] => res.body.data.map((row: { id: string }) => row.id);

  it("lists newest day first by default, with the page meta", async () => {
    const { a, b, c } = seed();

    const res = await send("get", "/daily-labour");

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([b!.id, c!.id, a!.id]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({
      villa: { villaNumber: "P-001" },
      contractor: { name: "Nile Builders" },
      labourDate: "2026-03-03",
    });
  });

  it("answers an empty page for nothing", async () => {
    const res = await send("get", "/daily-labour");

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  describe("paging", () => {
    it("pages by page and limit, and keeps the total", async () => {
      const { a, b, c } = seed();

      const first = await send("get", "/daily-labour?page=1&limit=2");
      const second = await send("get", "/daily-labour?page=2&limit=2");

      expect(ids(first)).toEqual([b!.id, c!.id]);
      expect(ids(second)).toEqual([a!.id]);
      expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it.each(["page=0", "page=abc", "limit=0", "limit=1001", "limit=1.5", "page=100001"])(
      "refuses %s with 400 and never clamps it",
      async (query) => {
        const res = await send("get", `/daily-labour?${query}`);

        expect(res.status).toBe(400);
      },
    );
  });

  describe("sorting", () => {
    it.each([
      ["labourDate", ["a", "c", "b"]],
      ["labourDate:desc", ["b", "c", "a"]],
      ["labourCount", ["b", "c", "a"]],
      ["labourCount:desc", ["a", "c", "b"]],
      ["createdAt:asc", ["a", "c", "b"]],
      ["createdAt:desc", ["b", "c", "a"]],
      ["contractorName", ["c", "b", "a"]],
      ["contractorName:desc", ["b", "a", "c"]],
    ])("sorts by %s", async (sort, expected) => {
      const rows = seed();

      const res = await send("get", `/daily-labour?sort=${sort}`);

      expect(ids(res)).toEqual(expected.map((key) => rows[key]!.id));
    });

    it("lists by the day of the labour, not by when the row was written, when no sort is asked", async () => {
      // Written in the opposite order of their days.
      const early = addDailyLabour({
        villaId: villa.id,
        contractorId: nile.id,
        labourDate: day("2026-03-01"),
        createdAt: new Date("2026-04-03T10:00:00Z"),
      });
      const late = addDailyLabour({
        villaId: villa.id,
        contractorId: nile.id,
        labourDate: day("2026-03-09"),
        createdAt: new Date("2026-04-01T10:00:00Z"),
      });

      expect(ids(await send("get", "/daily-labour"))).toEqual([late.id, early.id]);
    });

    it("sorts by villaNumber in natural order, a villa's rows newest first", async () => {
      const { a, b, c } = seed();
      const ten = addVilla({ villaNumber: "P-010", contractorId: nile.id, block: "B1", plot: "10" });
      const nine = addVilla({ villaNumber: "P-9", contractorId: nile.id, block: "B1", plot: "9" });
      const d = addDailyLabour({ villaId: ten.id, contractorId: nile.id, labourDate: day("2026-03-05") });
      const e = addDailyLabour({ villaId: nine.id, contractorId: nile.id, labourDate: day("2026-03-05") });

      const asc = await send("get", "/daily-labour?sort=villaNumber");
      const desc = await send("get", "/daily-labour?sort=villaNumber:desc");

      expect(ids(asc)).toEqual([b!.id, a!.id, c!.id, e.id, d.id]);
      expect(ids(desc)).toEqual([d.id, e.id, c!.id, b!.id, a!.id]);
    });

    it("breaks ties by id, so a page never repeats or skips a row", async () => {
      const sameDay = [villa, other].map((v) =>
        addDailyLabour({
          villaId: v.id,
          contractorId: v.contractorId!,
          labourDate: day("2026-04-01"),
        }),
      );

      const res = await send("get", "/daily-labour");

      expect(ids(res)).toEqual(sameDay.map((r) => r.id).sort());
    });

    it.each([
      "sort=weather",
      "sort=labourDate:sideways",
      "sort=",
      "sort=notes",
      "sort=LabourDate",
      "sort=xlabourDate",
      "sort=xlabourDate:asc",
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/daily-labour?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("says what sorts exist, in English by default", async () => {
      const res = await send("get", "/daily-labour?sort=nope");

      expect(res.body.details[0].message).toBe(
        "Invalid sort. Use labourDate, villaNumber, contractorName, labourCount or createdAt, optionally followed by :asc or :desc",
      );
    });

    it("says what sorts exist, in Arabic on request", async () => {
      const res = await send("get", "/daily-labour?sort=nope", { language: "ar" });

      expect(res.body.details[0].message).toContain("contractorName");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    });
  });

  describe("filters", () => {
    it("filters by villa", async () => {
      const { c } = seed();

      expect(ids(await send("get", `/daily-labour?villaId=${other.id}`))).toEqual([c!.id]);
    });

    it("filters by contractor", async () => {
      const { c } = seed();

      expect(ids(await send("get", `/daily-labour?contractorId=${delta.id}`))).toEqual([c!.id]);
      expect(ids(await send("get", `/daily-labour?contractorId=${MISSING_ID}`))).toEqual([]);
    });

    it("filters by day range, both ends included", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/daily-labour?labourFrom=2026-03-02&labourTo=2026-03-03"))).toEqual([
        b!.id,
        c!.id,
      ]);
      expect(ids(await send("get", "/daily-labour?labourFrom=2026-03-03"))).toEqual([b!.id]);
      expect(ids(await send("get", "/daily-labour?labourTo=2026-03-01"))).toEqual([a!.id]);
    });

    it("searches the villa number, the contractor's name and the notes, ignoring case", async () => {
      const { a, b, c } = seed();

      expect(ids(await send("get", "/daily-labour?search=EXCAV"))).toEqual([a!.id]);
      expect(ids(await send("get", "/daily-labour?search=formwork"))).toEqual([c!.id]);
      expect(ids(await send("get", "/daily-labour?search=delta"))).toEqual([c!.id]);
      expect(ids(await send("get", "/daily-labour?search=P-003"))).toEqual([c!.id]);
      expect(ids(await send("get", "/daily-labour?search=nile"))).toEqual([b!.id, a!.id]);
    });

    it("combines filters", async () => {
      const { a } = seed();

      const res = await send("get", `/daily-labour?villaId=${villa.id}&contractorId=${nile.id}&search=excav`);

      expect(ids(res)).toEqual([a!.id]);
      expect(res.body.meta.total).toBe(1);
    });

    it("accepts a search of exactly 100 characters", async () => {
      const res = await send("get", `/daily-labour?search=${"x".repeat(100)}`);

      expect(res.status).toBe(200);
    });

    it.each([
      "villaId=x",
      "contractorId=x",
      "labourFrom=2026-13-01",
      "labourTo=yesterday",
      "labourFrom=2026-03-05&labourTo=2026-03-01",
      `search=${"x".repeat(101)}`,
    ])("refuses %s with 400", async (query) => {
      const res = await send("get", `/daily-labour?${query}`);

      expect(res.status).toBe(400);
    });

    it("takes a range of one day: the same first and last day", async () => {
      const { c } = seed();

      const res = await send("get", "/daily-labour?labourFrom=2026-03-02&labourTo=2026-03-02");

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([c!.id]);
    });

    it("trims the search before it looks", async () => {
      const { c } = seed();

      expect(ids(await send("get", "/daily-labour?search=%20%20Formwork%20%20"))).toEqual([c!.id]);
    });

    it("says why a reversed range is refused", async () => {
      const res = await send("get", "/daily-labour?labourFrom=2026-03-05&labourTo=2026-03-01");

      expect(res.body.details[0].message).toBe("The end date must not be before the start date");
    });

    it("reports a reversed range on labourTo", async () => {
      const res = await send("get", "/daily-labour?labourFrom=2026-03-05&labourTo=2026-03-01");

      expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(["labourTo"]);
    });
  });
});

describe("deleting a villa that has labour rows", () => {
  it("is refused with 409 VILLA_HAS_RECORDS, translated; the villa and the row stay", async () => {
    await made();

    const res = await send("delete", `/villas/${villa.id}`, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "VILLA_HAS_RECORDS",
      message:
        "هذه الفيلا بها أعمال مفتوحة أُضيفت يدويًا أو أعمال صغيرة يومية أو تقارير موقع أو عمالة يومية أو توريدات مواد. احذفها أولاً",
    });
    expect(villaTables.villas.some((v) => v.id === villa.id)).toBe(true);
    expect(dailyLabourTables.rows).toHaveLength(1);
  });

  it("names daily labour in English", async () => {
    await made();

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.body.message).toBe(
      "This villa has open works that were added by hand, daily small works, site reports, daily labour or material deliveries. Delete them first",
    );
  });

  it("is allowed again once its rows are deleted, and another villa's rows do not matter", async () => {
    const row = await made();
    await made({ villaId: other.id, contractorId: delta.id });
    await send("delete", `/daily-labour/${row.id}`);

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(204);
    expect(dailyLabourTables.rows).toHaveLength(1);
  });
});
