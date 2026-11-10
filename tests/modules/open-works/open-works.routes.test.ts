import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addPhase,
  addStartingPhases,
  phaseTables,
  type StoredPhase,
} from "../elec-phases/in-memory-elec-phases.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addWorkItem, openWorkRaces, workItemTables } from "./in-memory-open-works.repository.js";

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
vi.mock("../../../src/modules/open-works/repository/open-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/open-works/repository/open-works.repository.js")
  >()),
  OpenWorksRepository: (await import("./in-memory-open-works.repository.js")).InMemoryOpenWorksRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();
const KEY = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

let admin: User;
let villa: StoredVilla;
let bare: StoredVilla;
let phases: StoredPhase[];
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  idempotencyTable.reset();
  openWorkRaces.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  phases = addStartingPhases();
  villa = addVilla({ villaNumber: "P-001", contractorId: nile.id, block: "B1", plot: "1" });
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
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  if (options.key !== undefined) req.set("Idempotency-Key", options.key);
  return options.body === undefined ? req : req.send(options.body as object);
};

const body = (extra: Record<string, unknown> = {}) => ({
  villaId: villa.id,
  elecPhaseId: phases[4]!.id,
  ...extra,
});
const create = (extra: Record<string, unknown> = {}, options: Options = {}) =>
  send("post", "/open-works", { body: body(extra), ...options });
const made = async (extra: Record<string, unknown> = {}) => (await create(extra)).body.data;
const phaseItem = (over: Record<string, unknown> = {}) =>
  addWorkItem({
    villaId: villa.id,
    elecPhaseId: phases[0]!.id,
    status: "IN_PROGRESS",
    progress: 40,
    contractorId: nile.id,
    ...over,
  });
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("access control", () => {
  const ROUTES: [Verb, string, string][] = [
    ["get", "/open-works", "open-works:read"],
    ["get", `/open-works/${MISSING_ID}`, "open-works:read"],
    ["post", "/open-works", "open-works:create"],
    ["patch", `/open-works/${MISSING_ID}`, "open-works:update"],
    ["delete", `/open-works/${MISSING_ID}`, "open-works:delete"],
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
    "%s %s needs exactly %s, and no other open-works permission opens it",
    async (verb, path, code) => {
      const others = [
        "open-works:read",
        "open-works:create",
        "open-works:update",
        "open-works:delete",
        "open-works:export",
      ]
        .filter((other) => other !== code)
        .concat("villas:read", "villas:update", "villas:progress", "dashboard:read");

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
    const res = await send("patch", "/open-works/not-a-uuid", {
      user: employee("e@example.test"),
      body: { x: 1 },
    });

    expect(res.status).toBe(403);
  });

  it("lets an admin do everything without any grant", async () => {
    const item = await made();

    expect((await send("get", "/open-works")).status).toBe(200);
    expect((await send("patch", `/open-works/${item.id}`, { body: { priority: "HIGH" } })).status).toBe(200);
    expect((await send("delete", `/open-works/${item.id}`)).status).toBe(204);
  });
});

describe("POST /open-works", () => {
  it("creates an item by hand: not started, 0, medium, MANUAL, with its villa, creator, ETag and version 1", async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body.data).toMatchObject({
      villa: { id: villa.id, villaNumber: "P-001", location: "New Cairo . B1 . 1" },
      elecPhase: { id: phases[4]!.id, name: phases[4]!.name },
      status: "NOT_STARTED",
      priority: "MEDIUM",
      progress: 0,
      contractor: null,
      startDate: null,
      endDate: null,
      overdue: false,
      createdBy: { id: admin.id, name: "Root Admin" },
      version: 1,
    });
    expect(workItemTables.items).toHaveLength(1);
  });

  it("takes every field it is given", async () => {
    const res = await create({
      elecPhaseId: phases[1]!.id,
      status: "DELAYED",
      priority: "HIGH",
      progress: 30,
      contractorId: nile.id,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      elecPhase: { id: phases[1]!.id, name: phases[1]!.name },
      status: "DELAYED",
      priority: "HIGH",
      progress: 30,
      contractor: { id: nile.id, name: "Nile Builders" },
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
  });

  it.each([
    [{ progress: 0 }, "NOT_STARTED", 0],
    [{ progress: 40 }, "IN_PROGRESS", 40],
    [{ progress: 100 }, "DONE", 100],
    [{ status: "DONE" }, "DONE", 100],
    [{ status: "IN_PROGRESS" }, "IN_PROGRESS", 0],
    [{ status: "DELAYED" }, "DELAYED", 0],
    [{ status: "NOT_STARTED" }, "NOT_STARTED", 0],
  ])("%j starts as %s at %i", async (extra, status, progress) => {
    const res = await create(extra);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status, progress });
  });

  it.each([
    [{ status: "DONE", progress: 50 }],
    [{ status: "IN_PROGRESS", progress: 100 }],
    [{ status: "DELAYED", progress: 100 }],
    [{ status: "NOT_STARTED", progress: 10 }],
  ])("refuses %j with 422 WORK_STATUS_PROGRESS_MISMATCH, translated", async (extra) => {
    const res = await create(extra, { language: "ar" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("WORK_STATUS_PROGRESS_MISMATCH");
    expect(res.body.details[0].path).toBe("status");
    expect(res.body.message).toContain("الحالة والتقدم غير متوافقين");
    expect(workItemTables.items).toHaveLength(0);
  });

  it("answers 404 VILLA_NOT_FOUND for an unknown villa", async () => {
    const res = await create({ villaId: MISSING_ID }, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
  });

  it("refuses a second open work for the same villa and phase with 409 OPEN_WORK_PHASE_TAKEN, translated", async () => {
    await made();

    const res = await create({}, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "OPEN_WORK_PHASE_TAKEN",
      message:
        "هذه الفيلا لديها بالفعل عمل مفتوح لهذه المرحلة الكهربائية. عدّل ذلك العمل بدلًا من إضافة عمل آخر",
    });
    expect(res.body.details[0].path).toBe("elecPhaseId");
    expect(workItemTables.items).toHaveLength(1);
  });

  it("takes the same phase on another villa, and another phase on the same villa", async () => {
    await made();

    expect((await create({ villaId: bare.id })).status).toBe(201);
    expect((await create({ elecPhaseId: phases[1]!.id })).status).toBe(201);
    expect(workItemTables.items).toHaveLength(3);
  });

  it("answers 404 ELEC_PHASE_NOT_FOUND for an unknown phase", async () => {
    const res = await create({ elecPhaseId: MISSING_ID });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ELEC_PHASE_NOT_FOUND");
    expect(workItemTables.items).toHaveLength(0);
  });

  it("answers 409 ELEC_PHASE_INACTIVE, translated, for a phase that is switched off, and writes nothing", async () => {
    phases[4]!.status = "INACTIVE";

    const res = await create({}, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "ELEC_PHASE_INACTIVE",
      message: "هذه المرحلة الكهربائية غير نشطة ولا يمكن إسنادها إلى عمل مفتوح",
    });
    expect(workItemTables.items).toHaveLength(0);
  });

  it("is named after the phase and the villa, since it has no title of its own", async () => {
    const res = await create({ elecPhaseId: phases[5]!.id });

    expect(res.body.data).not.toHaveProperty("title");
    expect(res.body.data).not.toHaveProperty("phase");
    expect(res.body.data.elecPhase.name).toBe("Sleeves");
    expect(auditRows()[0]).toMatchObject({ after: { name: "Sleeves - P-001" } });
  });

  describe("the contractor", () => {
    it("is the villa's one contractor or none: another one is 422 CONTRACTOR_NOT_ON_VILLA, translated", async () => {
      const res = await create({ contractorId: delta.id }, { language: "ar" });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_NOT_ON_VILLA",
        message: "هذا المقاول ليس مقاول هذه الفيلا",
      });
      expect(workItemTables.items).toHaveLength(0);
    });

    it("cannot be set on a villa that has none", async () => {
      const res = await create({ villaId: bare.id, contractorId: nile.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
    });

    it("may be the villa's own", async () => {
      const res = await create({ contractorId: nile.id });

      expect(res.status).toBe(201);
      expect(res.body.data.contractor.id).toBe(nile.id);
    });

    it("may be left out or null, on any villa", async () => {
      expect((await create({ contractorId: null })).status).toBe(201);
      expect((await create({ villaId: bare.id })).status).toBe(201);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for one that does not exist", async () => {
      const res = await create({ contractorId: MISSING_ID });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
    });

    it("answers 400 CONTRACTOR_INACTIVE for the villa's contractor when it is switched off", async () => {
      nile.status = "INACTIVE";

      const res = await create({ contractorId: nile.id }, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "CONTRACTOR_INACTIVE",
        message: "هذا المقاول غير نشط ولا يمكن تعيينه على عمل مفتوح",
      });
    });
  });

  describe("request validation (400, nothing is written)", () => {
    it.each([
      ["no villaId", { villaId: undefined }, "villaId"],
      ["a villaId that is not a UUID", { villaId: "nope" }, "villaId"],
      ["no elecPhaseId", { elecPhaseId: undefined }, "elecPhaseId"],
      ["a null elecPhaseId", { elecPhaseId: null }, "elecPhaseId"],
      ["an unknown status", { status: "STUCK" }, "status"],
      ["an unknown priority", { priority: "URGENT" }, "priority"],
      ["a progress over 100", { progress: 101 }, "progress"],
      ["a negative progress", { progress: -1 }, "progress"],
      ["a fractional progress", { progress: 1.5 }, "progress"],
      ["a progress sent as text", { progress: "5" }, "progress"],
      ["a bad date", { startDate: "2026-13-40" }, "startDate"],
      ["an end before the start", { startDate: "2026-11-10", endDate: "2026-11-09" }, "endDate"],
      ["an elecPhaseId that is not a UUID", { elecPhaseId: "x" }, "elecPhaseId"],
      ["a contractorId that is not a UUID", { contractorId: "x" }, "contractorId"],
    ])("refuses %s", async (_name, extra, path) => {
      const res = await create(extra);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
      expect(workItemTables.items).toHaveLength(0);
    });

    it.each(["id", "source", "version", "createdById", "overdue", "managed", "villa", "title", "phase"])(
      "refuses the field %s that a client cannot set",
      async (field) => {
        const res = await create({ [field]: field === "source" ? "PHASE" : "x" });

        expect(res.status).toBe(400);
        expect(workItemTables.items).toHaveLength(0);
      },
    );

    it("accepts an end equal to the start", async () => {
      expect((await create({ startDate: "2026-11-10", endDate: "2026-11-10" })).status).toBe(201);
    });

    it("answers in Arabic on request", async () => {
      const res = await create({ progress: 101 }, { language: "ar" });

      expect(res.body.message).toBe("فشل التحقق");
      expect(res.body.details[0].path).toBe("progress");
    });
  });

  it("audits the creation with the full snapshot and no before", async () => {
    const res = await create({ contractorId: nile.id, priority: "LOW", startDate: "2026-11-01" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "open_work.create",
      entity: "WorkItem",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        name: `${phases[4]!.name} - P-001`,
        villaId: villa.id,
        elecPhaseId: phases[4]!.id,
        status: "NOT_STARTED",
        priority: "LOW",
        progress: 0,
        contractorId: nile.id,
        startDate: "2026-11-01",
        endDate: null,
      },
    });
    expect(auditRows()[0]?.before).toBeUndefined();
  });

  it("writes nothing when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create();

    expect(res.status).toBe(500);
    expect(workItemTables.items).toHaveLength(0);
  });

  it("turns a villa deleted in the middle into 404 VILLA_NOT_FOUND, writing nothing", async () => {
    openWorkRaces.beforeWrite = () => {
      villaTables.villas = villaTables.villas.filter((v) => v.id !== villa.id);
    };

    const res = await create();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
    expect(workItemTables.items).toHaveLength(0);
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await create({}, { key: KEY });
      const again = await create({}, { key: KEY });

      expect(firstTime.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(workItemTables.items).toHaveLength(1);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await create({}, { key: KEY });

      const reused = await create({ priority: "HIGH" }, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(workItemTables.items).toHaveLength(1);
    });
  });
});

describe("GET /open-works/:id", () => {
  it("answers one item with its ETag", async () => {
    const item = await made({ contractorId: nile.id, endDate: "2099-01-01" });

    const res = await send("get", `/open-works/${item.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.data).toEqual(item);
  });

  it("answers 404 WORK_ITEM_NOT_FOUND, translated, for an unknown one", async () => {
    const res = await send("get", `/open-works/${MISSING_ID}`, { language: "ar" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "WORK_ITEM_NOT_FOUND", message: "العمل المفتوح غير موجود" });
  });

  it("answers 400 for an id that is not a UUID", async () => {
    expect((await send("get", "/open-works/nope")).status).toBe(400);
  });

  it("is overdue when its end date has passed and it is not done, and not otherwise", async () => {
    const late = await made({ elecPhaseId: phases[1]!.id, endDate: "2020-01-01" });
    const done = await made({ elecPhaseId: phases[2]!.id, endDate: "2020-01-01", progress: 100 });
    const future = await made({ elecPhaseId: phases[3]!.id, endDate: "2099-01-01" });
    const open = await made({ elecPhaseId: phases[4]!.id });

    expect(late.overdue).toBe(true);
    expect(done.overdue).toBe(false);
    expect(future.overdue).toBe(false);
    expect(open.overdue).toBe(false);
  });
});

describe("PATCH /open-works/:id", () => {
  const patch = (id: string, input: unknown, options: Options = {}) =>
    send("patch", `/open-works/${id}`, { body: input, ...options });

  it("changes only the fields sent, bumps the version and answers the new ETag", async () => {
    const item = await made({ priority: "LOW", contractorId: nile.id });

    const res = await patch(
      item.id,
      { elecPhaseId: phases[1]!.id, progress: 20, status: "IN_PROGRESS" },
      { ifMatch: '"1"' },
    );

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toMatchObject({
      elecPhase: { id: phases[1]!.id, name: phases[1]!.name },
      progress: 20,
      status: "IN_PROGRESS",
      priority: "LOW",
      version: 2,
    });
    expect(workItemTables.items[0]).toMatchObject({ contractorId: nile.id, elecPhaseId: phases[1]!.id });
  });

  it("works without an If-Match", async () => {
    const item = await made();

    expect((await patch(item.id, { priority: "HIGH" })).status).toBe(200);
  });

  it("answers 409 VERSION_CONFLICT for a stale version and changes nothing", async () => {
    const item = await made();
    await patch(item.id, { priority: "HIGH" });

    const stale = await patch(item.id, { priority: "LOW" }, { ifMatch: '"1"' });

    conflict(stale, 2);
    expect(workItemTables.items[0]?.priority).toBe("HIGH");
    expect(auditRows()).toHaveLength(2);
  });

  it("answers 404 for an unknown item and 400 for an empty body or an unknown field", async () => {
    const item = await made();

    expect((await patch(MISSING_ID, { priority: "HIGH" })).status).toBe(404);
    expect((await patch(item.id, {})).status).toBe(400);
    for (const field of ["villaId", "source", "version", "id", "title", "phase"]) {
      const res = await patch(item.id, { [field]: MISSING_ID });
      expect(res.status, field).toBe(400);
    }
  });

  describe("status and progress stay in agreement", () => {
    it("takes the progress and the status together", async () => {
      const item = await made();

      expect((await patch(item.id, { status: "DONE", progress: 100 })).body.data).toMatchObject({
        status: "DONE",
        progress: 100,
      });
    });

    it.each([
      ["progress 100 alone: it is IN_PROGRESS, which cannot be 100", { progress: 100 }],
      ["status DONE alone: it is at 40", { status: "DONE" }],
      ["status NOT_STARTED alone: it is at 40", { status: "NOT_STARTED" }],
    ])("refuses %s, as the merged state would disagree", async (_why, input) => {
      const item = await made({ progress: 40 });

      const res = await patch(item.id, input);

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("WORK_STATUS_PROGRESS_MISMATCH");
      expect(workItemTables.items[0]).toMatchObject({ status: "IN_PROGRESS", progress: 40, version: 1 });
    });

    it("lets progress fall back to 0 only together with NOT_STARTED, and 100 only with DONE", async () => {
      const item = await made({ progress: 40 });

      expect((await patch(item.id, { progress: 0 })).status).toBe(200);
      expect(workItemTables.items[0]?.status).toBe("IN_PROGRESS");
      expect((await patch(item.id, { status: "NOT_STARTED" })).status).toBe(200);
      expect((await patch(item.id, { progress: 50 })).status).toBe(422);
      expect((await patch(item.id, { status: "IN_PROGRESS", progress: 50 })).status).toBe(200);
    });

    it("lets a done item be reopened with a status and a progress below 100", async () => {
      const item = await made({ progress: 100 });

      const res = await patch(item.id, { status: "DELAYED", progress: 70 });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: "DELAYED", progress: 70 });
    });
  });

  describe("the contractor", () => {
    it("is checked only when the request sets a different one", async () => {
      const item = await made({ contractorId: nile.id });
      // The villa moved to another contractor since.
      villa.contractorId = delta.id;

      expect((await patch(item.id, { priority: "HIGH" })).status).toBe(200);
      expect((await patch(item.id, { contractorId: nile.id })).status).toBe(200);
      const moved = await patch(item.id, { contractorId: delta.id });
      expect(moved.status).toBe(200);
      expect(moved.body.data.contractor.id).toBe(delta.id);
    });

    it("refuses one that is not the villa's with 422 CONTRACTOR_NOT_ON_VILLA, and writes nothing", async () => {
      const item = await made({ contractorId: nile.id });

      const res = await patch(item.id, { contractorId: delta.id });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("CONTRACTOR_NOT_ON_VILLA");
      expect(workItemTables.items[0]).toMatchObject({ contractorId: nile.id, version: 1 });
    });

    it("clears it with null", async () => {
      const item = await made({ contractorId: nile.id });

      const res = await patch(item.id, { contractorId: null });

      expect(res.status).toBe(200);
      expect(res.body.data.contractor).toBeNull();
    });

    it("cannot set one on a villa without a contractor, and refuses a switched-off or unknown one", async () => {
      const item = await made({ villaId: bare.id });
      expect((await patch(item.id, { contractorId: nile.id })).body.code).toBe("CONTRACTOR_NOT_ON_VILLA");

      const own = await made({ contractorId: null });
      nile.status = "INACTIVE";
      expect((await patch(own.id, { contractorId: nile.id })).body.code).toBe("CONTRACTOR_INACTIVE");
      expect((await patch(own.id, { contractorId: MISSING_ID })).body.code).toBe("CONTRACTOR_NOT_FOUND");
    });
  });

  describe("the electrical phase of an item typed in by hand", () => {
    it("can be changed to another active phase, and the audit entry carries both", async () => {
      const item = await made();

      const res = await patch(item.id, { elecPhaseId: phases[1]!.id });

      expect(res.status).toBe(200);
      expect(res.body.data.elecPhase).toEqual({ id: phases[1]!.id, name: phases[1]!.name });
      expect(auditRows().at(-1)).toMatchObject({
        before: { elecPhaseId: phases[4]!.id },
        after: { elecPhaseId: phases[1]!.id },
      });
    });

    it("cannot be changed to an unknown phase (404) or a switched-off one (409), and nothing is written", async () => {
      const item = await made();
      phases[1]!.status = "INACTIVE";

      const unknown = await patch(item.id, { elecPhaseId: MISSING_ID });
      const off = await patch(item.id, { elecPhaseId: phases[1]!.id });

      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("ELEC_PHASE_NOT_FOUND");
      expect(off.status).toBe(409);
      expect(off.body.code).toBe("ELEC_PHASE_INACTIVE");
      expect(workItemTables.items[0]).toMatchObject({ elecPhaseId: phases[4]!.id, version: 1 });
    });

    it("is checked only when the request changes it: a phase switched off since stays on the item", async () => {
      const item = await made();
      phases[4]!.status = "INACTIVE";

      expect((await patch(item.id, { priority: "HIGH" })).status).toBe(200);
      expect((await patch(item.id, { elecPhaseId: phases[4]!.id })).status).toBe(200);
    });

    it("cannot be cleared with null", async () => {
      const item = await made();

      expect((await patch(item.id, { elecPhaseId: null })).status).toBe(400);
    });
  });

  describe("the dates", () => {
    it("are compared with the stored one when only one is sent", async () => {
      const item = await made({ startDate: "2026-11-10", endDate: "2026-11-20" });

      const early = await patch(item.id, { endDate: "2026-11-09" }, { language: "ar" });
      const late = await patch(item.id, { startDate: "2026-11-21" });

      expect(early.status).toBe(400);
      expect(early.body.details[0]).toEqual({
        path: "endDate",
        message: "يجب ألا يكون تاريخ النهاية قبل تاريخ البداية",
      });
      expect(late.status).toBe(400);
      expect(workItemTables.items[0]).toMatchObject({ version: 1 });
    });

    it("can be cleared with null, and a cleared start leaves any end", async () => {
      const item = await made({ startDate: "2026-11-10", endDate: "2026-11-20" });

      const res = await patch(item.id, { startDate: null });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ startDate: null, endDate: "2026-11-20" });
    });
  });

  it("audits the change with the before and the after of the item", async () => {
    const item = await made({ priority: "LOW" });

    await patch(item.id, { priority: "HIGH", progress: 10, status: "IN_PROGRESS" });

    expect(auditRows()).toHaveLength(2);
    expect(auditRows()[1]).toMatchObject({
      action: "open_work.update",
      entity: "WorkItem",
      actorId: admin.id,
      entityId: item.id,
      before: { priority: "LOW", progress: 0, status: "NOT_STARTED" },
      after: { priority: "HIGH", progress: 10, status: "IN_PROGRESS" },
    });
  });

  it("loses a race between the lock and the update with 409, never a silent overwrite", async () => {
    const item = await made();
    const stored = workItemTables.items[0]!;
    openWorkRaces.beforeWrite = () => {
      stored.version += 1;
    };

    const res = await patch(item.id, { priority: "HIGH" }, { ifMatch: '"1"' });

    conflict(res, 2);
    expect(stored.priority).toBe("MEDIUM");
  });

  it("refuses to move an open work onto a phase the villa already has, and keeps its own phase", async () => {
    const first = await made({ elecPhaseId: phases[1]!.id });
    const second = await made({ elecPhaseId: phases[2]!.id });

    const res = await patch(second.id, { elecPhaseId: phases[1]!.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPEN_WORK_PHASE_TAKEN");
    expect((await patch(first.id, { elecPhaseId: phases[1]!.id, priority: "HIGH" })).status).toBe(200);
  });
});

describe("DELETE /open-works/:id", () => {
  const remove = (id: string, options: Options = {}) => send("delete", `/open-works/${id}`, options);

  it("deletes an item typed in by hand with 204 and no body, and audits its snapshot", async () => {
    const item = await made({ contractorId: nile.id, priority: "HIGH" });

    const res = await remove(item.id, { ifMatch: '"1"' });

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(workItemTables.items).toHaveLength(0);
    expect(auditRows().at(-1)).toMatchObject({
      action: "open_work.delete",
      entity: "WorkItem",
      actorId: admin.id,
      entityId: item.id,
      before: {
        name: `${phases[4]!.name} - P-001`,
        elecPhaseId: phases[4]!.id,
        priority: "HIGH",
        contractorId: nile.id,
      },
    });
    expect(auditRows().at(-1)?.after).toBeUndefined();
  });

  it("answers 409 VERSION_CONFLICT for a stale version and keeps the item", async () => {
    const item = await made();
    await send("patch", `/open-works/${item.id}`, { body: { priority: "HIGH" } });

    const res = await remove(item.id, { ifMatch: '"1"' });

    conflict(res, 2);
    expect(workItemTables.items).toHaveLength(1);
  });

  it("answers 404 for an unknown item, and 400 for an id that is not a UUID", async () => {
    expect((await remove(MISSING_ID)).status).toBe(404);
    expect((await remove("nope")).status).toBe(400);
  });

  it("answers 404 when another request deleted it first", async () => {
    const item = await made();
    openWorkRaces.beforeWrite = () => {
      workItemTables.items = [];
    };

    const res = await remove(item.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WORK_ITEM_NOT_FOUND");
  });

  it("keeps the item when the audit write fails", async () => {
    const item = await made();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await remove(item.id);

    expect(res.status).toBe(500);
    expect(workItemTables.items).toHaveLength(1);
  });
});

describe("GET /open-works", () => {
  const list = (query = "", options: Options = {}) => send("get", `/open-works${query}`, options);
  // The items have no title: the tests tell them apart by the name of their phase, one phase per label.
  const phaseNamed = (name: string) => phaseTables.phases.find((p) => p.name === name) ?? addPhase({ name });
  const madeAs = (name: string, extra: Record<string, unknown> = {}) =>
    made({ elecPhaseId: phaseNamed(name).id, ...extra });
  const titles = (res: request.Response): string[] =>
    res.body.data.map((i: { elecPhase: { name: string } }) => i.elecPhase.name);

  it("answers an empty page with its meta when there is nothing", async () => {
    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 1 },
    });
  });

  it("lists by location (area, block, plot, then the phase's own order) by default", async () => {
    const elsewhere = addVilla({ area: "Shorouk", block: "A1", plot: "1" });
    await made({ elecPhaseId: phases[5]!.id });
    await made({ elecPhaseId: phases[1]!.id });
    await made({ villaId: bare.id, elecPhaseId: phases[0]!.id });
    await made({ villaId: elsewhere.id, elecPhaseId: phases[2]!.id });

    const res = await list();

    expect(titles(res)).toEqual([phases[1]!.name, phases[5]!.name, phases[0]!.name, phases[2]!.name]);
    expect(res.body.data[0].villa.location).toBe("New Cairo . B1 . 1");
  });

  describe("paging", () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i += 1) await made({ elecPhaseId: phases[i]!.id });
    });

    it("pages with page and limit, and answers the meta", async () => {
      const res = await list("?page=2&limit=2&sort=elecPhaseName");

      const byName = phases
        .slice(0, 5)
        .map((p) => p.name)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      expect(titles(res)).toEqual(byName.slice(2, 4));
      expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    });

    it("answers an empty page past the end, with the true total", async () => {
      const res = await list("?page=9&limit=2");

      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ total: 5, totalPages: 3 });
    });

    it.each(["page=0", "page=-1", "page=x", "page=1.5", "limit=0", "limit=1001", "limit=x", "limit=-5"])(
      "refuses %s with 400, never clamps it",
      async (query) => {
        const res = await list(`?${query}`);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
      },
    );

    it("accepts the limit of 1000", async () => {
      expect((await list("?limit=1000")).status).toBe(200);
    });
  });

  describe("sorting", () => {
    it("sorts the phase names in natural order, ascending and descending", async () => {
      for (const name of ["A10", "A2", "A9", "a1"]) await madeAs(name);

      expect(titles(await list("?sort=elecPhaseName"))).toEqual(["a1", "A2", "A9", "A10"]);
      expect(titles(await list("?sort=elecPhaseName:desc"))).toEqual(["A10", "A9", "A2", "a1"]);
    });

    it("sorts status and priority in the order of their enums, not alphabetically", async () => {
      await madeAs("d", { status: "DONE", priority: "HIGH" });
      await madeAs("n", { status: "NOT_STARTED", priority: "LOW" });
      await madeAs("l", { status: "DELAYED", priority: "MEDIUM" });
      await madeAs("i", { status: "IN_PROGRESS", priority: "LOW" });

      expect(titles(await list("?sort=status"))).toEqual(["n", "i", "l", "d"]);
      expect(titles(await list("?sort=status:desc"))).toEqual(["d", "l", "i", "n"]);
      expect(titles(await list("?sort=priority:desc"))[0]).toBe("d");
      expect(titles(await list("?sort=priority"))).toHaveLength(4);
    });

    it("sorts by progress", async () => {
      await madeAs("a", { progress: 50 });
      await madeAs("b", { progress: 10 });
      await madeAs("c", { progress: 100 });

      expect(titles(await list("?sort=progress"))).toEqual(["b", "a", "c"]);
      expect(titles(await list("?sort=progress:desc"))).toEqual(["c", "a", "b"]);
    });

    it("puts items without a date last, in either direction", async () => {
      await madeAs("none");
      await madeAs("late", { startDate: "2026-12-01", endDate: "2026-12-31" });
      await madeAs("early", { startDate: "2026-11-01", endDate: "2026-11-30" });

      expect(titles(await list("?sort=startDate"))).toEqual(["early", "late", "none"]);
      expect(titles(await list("?sort=startDate:desc"))).toEqual(["late", "early", "none"]);
      expect(titles(await list("?sort=endDate"))).toEqual(["early", "late", "none"]);
      expect(titles(await list("?sort=endDate:desc"))).toEqual(["late", "early", "none"]);
    });

    it.each([
      "sort=color",
      "sort=elecPhaseName:up",
      "sort=elecPhaseName:asc:x",
      "sort=title",
      "sort=phase",
      "sort=id",
      "sort=createdAt",
      "sort=",
    ])("refuses %s with 400", async (query) => {
      const res = await list(`?${query}`, { language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("filters", () => {
    let manual: { id: string };
    beforeEach(async () => {
      manual = await madeAs("Cable tray", {
        status: "DELAYED",
        priority: "HIGH",
        contractorId: nile.id,
        startDate: "2019-12-05",
        endDate: "2020-01-10",
      });
      await madeAs("Paint", {
        villaId: bare.id,
        startDate: "2026-12-05",
        endDate: "2099-01-01",
      });
      phaseItem({ startDate: day("2026-10-01") });
    });

    it.each([
      ["villaId", () => `villaId=${bare.id}`, ["Paint"]],
      ["elecPhaseId, a manual one", () => `elecPhaseId=${phaseNamed("Paint").id}`, ["Paint"]],
      ["elecPhaseId", () => `elecPhaseId=${phases[0]!.id}`, ["@phase"]],
      ["status", () => "status=DELAYED", ["Cable tray"]],
      ["priority", () => "priority=HIGH", ["Cable tray"]],
      ["contractorId", () => `contractorId=${nile.id}`, ["Cable tray", "@phase"]],
      ["startFrom", () => "startFrom=2026-11-01", ["Paint"]],
      ["startTo", () => "startTo=2026-10-01", ["Cable tray", "@phase"]],
      ["endFrom", () => "endFrom=2099-01-01", ["Paint"]],
      ["endTo", () => "endTo=2020-01-10", ["Cable tray"]],
      ["search, in the phase name", () => "search=CABLE", ["Cable tray"]],
      ["search, in the villa number", () => "search=P-002", ["Paint"]],
      ["search, in the contractor's name", () => "search=nile", ["Cable tray", "@phase"]],
      ["several at once", () => `villaId=${villa.id}&status=DELAYED`, ["Cable tray"]],
    ])("by %s", async (_name, query, expected) => {
      const res = await list(`?${query()}&sort=elecPhaseName`);
      const names = expected.map((name) => (name === "@phase" ? phases[0]!.name : name));

      expect(res.status).toBe(200);
      expect(titles(res).sort()).toEqual([...names].sort());
      expect(res.body.meta.total).toBe(expected.length);
    });

    it("by overdue=true: an end date that has passed on an item that is not done", async () => {
      const res = await list("?overdue=true");

      expect(titles(res)).toEqual(["Cable tray"]);
      expect(res.body.data[0].overdue).toBe(true);
    });

    it("by overdue=false: everything else, including items with no end date", async () => {
      const res = await list("?overdue=false&sort=elecPhaseName");

      expect(titles(res)).toEqual(["Paint", phases[0]!.name].sort());
      expect(res.body.data.every((i: { overdue: boolean }) => !i.overdue)).toBe(true);
    });

    it("does not call a done item overdue", async () => {
      await send("patch", `/open-works/${manual.id}`, { body: { status: "DONE", progress: 100 } });

      expect(titles(await list("?overdue=true"))).toEqual([]);
    });

    it.each([
      "villaId=nope",
      "elecPhaseId=nope",
      "status=STUCK",
      "priority=URGENT",
      "contractorId=nope",
      "overdue=yes",
      "startFrom=2026-13-01",
      "startFrom=2026-11-10&startTo=2026-11-09",
      "endFrom=2026-11-10&endTo=2026-11-09",
      `search=${"x".repeat(101)}`,
    ])("refuses %s with 400", async (query) => {
      const res = await list(`?${query}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("splits the done works (the Done Works page) from the ones still open with done=true and done=false", async () => {
      await made({ elecPhaseId: phases[3]!.id, progress: 100 });
      const all = (await list("?limit=100")).body.data as { status: string }[];

      const done = (await list("?done=true&limit=100")).body.data as { status: string }[];
      const open = (await list("?done=false&limit=100")).body.data as { status: string }[];

      expect(done.length).toBeGreaterThan(0);
      expect(done.every((item) => item.status === "DONE")).toBe(true);
      expect(open.every((item) => item.status !== "DONE")).toBe(true);
      expect(done.length + open.length).toBe(all.length);
      expect((await list("?done=yes")).status).toBe(400);
    });

    it("does not know the retired phase and title filters: an unknown query parameter narrows nothing", async () => {
      const all = await list("?limit=100");
      const withPhase = await list("?phase=MEP&title=Cable");

      expect(withPhase.status).toBe(200);
      expect(withPhase.body.meta.total).toBe(all.body.meta.total);
    });

    it("counts the total over the filter, not the page", async () => {
      const res = await list(`?contractorId=${nile.id}&limit=1`);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    });
  });

  it("answers the shape of an item in the list as in the detail", async () => {
    const item = await made({ contractorId: nile.id });

    const res = await list();

    expect(res.body.data).toEqual([item]);
  });
});
