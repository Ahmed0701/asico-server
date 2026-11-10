import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import {
  addPhase,
  addStartingPhases,
  InMemoryElecPhasesRepository,
  phaseTables,
} from "./in-memory-elec-phases.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/elec-phases/repository/elec-phases.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/elec-phases/repository/elec-phases.repository.js")
  >()),
  ElecPhasesRepository: (await import("./in-memory-elec-phases.repository.js")).InMemoryElecPhasesRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();
const KEY = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";

let admin: User;
beforeEach(() => {
  store.reset();
  phaseTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
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

type Verb = "get" | "post" | "put" | "patch" | "delete";
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1/elec-phases${path}`);

type Options = { language?: string; body?: unknown; ifMatch?: string; key?: string; user?: User };
const asUser = async (verb: Verb, path: string, options: Options = {}) => {
  const req = call(verb, path)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) {
    req.set("If-Match", options.ifMatch);
  }
  if (options.key !== undefined) {
    req.set("Idempotency-Key", options.key);
  }
  return options.body === undefined ? req : req.send(options.body as object);
};
const asAdmin = (verb: Verb, path: string, language = "en", body?: unknown) =>
  asUser(verb, path, { language, body });

const names = (res: request.Response): string[] => res.body.data.map((item: { name: string }) => item.name);
const stored = (): string[] =>
  [...phaseTables.phases].sort((a, b) => a.sortOrder - b.sortOrder).map((phase) => phase.name);
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "elec-phases:read"],
    ["get", "/options", "elec-phases:read"],
    ["get", `/${MISSING_ID}`, "elec-phases:read"],
    ["post", "", "elec-phases:create"],
    ["put", "/order", "elec-phases:update"],
    ["patch", `/${MISSING_ID}`, "elec-phases:update"],
    ["delete", `/${MISSING_ID}`, "elec-phases:delete"],
  ];

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path).send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it.each(endpoints)(
    "%s %s answers 403 to an employee with no permissions, in Arabic on request",
    async (verb, path) => {
      const res = await call(verb, path)
        .set(await as(employee("e@example.test")))
        .set("Accept-Language", "ar")
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)(
    "%s %s is not opened by the other elec-phases permissions, nor by the engineers' ones",
    async (verb, path, needed) => {
      const others = ["elec-phases:read", "elec-phases:create", "elec-phases:update", "elec-phases:delete"]
        .filter((code) => code !== needed)
        .concat(
          "electrical-engineers:read",
          "electrical-engineers:update",
          "civil-engineers:update",
          "contractors:update",
          "villas:update",
        );

      const res = await call(verb, path)
        .set(await as(employee("e@example.test", ...others)))
        .send({});

      expect(res.status).toBe(403);
    },
  );

  it.each(endpoints)("%s %s lets through the holder of %s", async (verb, path, needed) => {
    const res = await call(verb, path)
      .set(await as(employee("e@example.test", needed)))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it.each(endpoints)("%s %s lets the ADMIN through with no granted permissions", async (verb, path) => {
    const res = await call(verb, path)
      .set(await as(admin))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it("checks access before validating", async () => {
    const res = await call("put", "/order")
      .set(await as(employee("e@example.test")))
      .send({ nonsense: true });

    expect(res.status).toBe(403);
  });

  it("reordering needs :update and nothing else: :create and :delete do not open it", async () => {
    const res = await call("put", "/order")
      .set(await as(employee("e@example.test", "elec-phases:create", "elec-phases:delete")))
      .send({ ids: [] });

    expect(res.status).toBe(403);
  });
});

describe("GET /elec-phases", () => {
  beforeEach(() => {
    addStartingPhases();
  });

  it("returns the phases in display order, with the shared pagination meta and exactly the public fields", async () => {
    const res = await asAdmin("get", "");

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      "Ceiling Piping",
      "MSB Box Fixing",
      "Cut/out Box Fixing",
      "D.B Box Fixing",
      "Wall Piping",
      "Sleeves",
    ]);
    expect(res.body.data.map((p: { sortOrder: number }) => p.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 6, totalPages: 1 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["createdAt", "id", "name", "progressRatio", "sortOrder", "status", "updatedAt", "version"].sort(),
    );
    expect(res.body.data[0]).toMatchObject({ status: "ACTIVE", version: 1 });
  });

  it("lists in display order whatever order the rows were stored in", async () => {
    phaseTables.reset();
    addPhase({ name: "Third", sortOrder: 3 });
    addPhase({ name: "First", sortOrder: 1 });
    addPhase({ name: "Second", sortOrder: 2 });

    expect(names(await asAdmin("get", ""))).toEqual(["First", "Second", "Third"]);
  });

  it("filters by status, inactive ones included", async () => {
    phaseTables.phases[1]!.status = "INACTIVE";
    phaseTables.phases[4]!.status = "INACTIVE";

    const inactive = await asAdmin("get", "?status=INACTIVE");
    const active = await asAdmin("get", "?status=ACTIVE");
    const all = await asAdmin("get", "");

    expect(names(inactive)).toEqual(["MSB Box Fixing", "Wall Piping"]);
    expect(inactive.body.meta.total).toBe(2);
    expect(names(active)).toHaveLength(4);
    expect(all.body.meta.total).toBe(6);
  });

  it.each(["active", "DONE", "", "ACTIVE,INACTIVE"])("rejects status=%j with 400", async (value) => {
    const res = await asAdmin("get", `?status=${value}`, "ar");

    expect(res.status).toBe(400);
    expect(res.body.details[0]).toEqual({
      path: "status",
      message: "يجب أن تكون الحالة ACTIVE أو INACTIVE",
    });
  });

  it("pages with limit and page", async () => {
    const second = await asAdmin("get", "?limit=2&page=2");

    expect(names(second)).toEqual(["Cut/out Box Fixing", "D.B Box Fixing"]);
    expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 6, totalPages: 3 });
    expect(names(await asAdmin("get", "?limit=2&page=4"))).toEqual([]);
  });

  it("accepts a limit of 1000 and rejects 1001 with 400 instead of clamping it, in Arabic", async () => {
    expect((await asAdmin("get", "?limit=1000")).status).toBe(200);

    const res = await asAdmin("get", "?limit=1001", "ar");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(res.body.details[0].path).toBe("limit");
  });

  it.each(["0", "-1", "abc", "1.5", ""])("rejects limit=%j with 400", async (value) => {
    expect((await asAdmin("get", `?limit=${value}`, "ar")).status).toBe(400);
  });

  it.each(["0", "-1", "abc"])("rejects page=%j with 400", async (value) => {
    expect((await asAdmin("get", `?page=${value}`)).status).toBe(400);
  });
});

describe("GET /elec-phases/options", () => {
  it("is not mistaken for an id, and is empty when there are no phases", async () => {
    const res = await asAdmin("get", "/options");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns only the active phases, as id and name, in display order", async () => {
    const [first, second, third] = [
      addPhase({ name: "First", sortOrder: 1 }),
      addPhase({ name: "Second", sortOrder: 2, status: "INACTIVE" }),
      addPhase({ name: "Third", sortOrder: 3 }),
    ];

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toEqual([
      { id: first!.id, name: "First" },
      { id: third!.id, name: "Third" },
    ]);
    expect(res.body.data.some((o: { id: string }) => o.id === second!.id)).toBe(false);
    expect(res.body).not.toHaveProperty("meta");
    expect(JSON.stringify(res.body)).not.toMatch(/status|sortOrder|must not leak/);
  });

  it("returns at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++) {
      addPhase({ name: `Phase ${i}`, sortOrder: i + 1 });
    }

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toHaveLength(1000);
    expect(res.body.data[0].name).toBe("Phase 0");
    expect(res.body.data[999].name).toBe("Phase 999");
  });
});

describe("GET /elec-phases/:id", () => {
  it("returns the phase in the same shape as the list, with its version as the ETag", async () => {
    const phase = addPhase({ name: "Wall Piping", sortOrder: 5, status: "INACTIVE", version: 3 });

    const res = await asAdmin("get", `/${phase.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: phase.id,
      name: "Wall Piping",
      sortOrder: 5,
      status: "INACTIVE",
      version: 3,
    });
    expect(res.headers["etag"]).toBe('"3"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 404 ELEC_PHASE_NOT_FOUND in Arabic on request", async () => {
    const res = await asAdmin("get", `/${MISSING_ID}`, "ar");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "ELEC_PHASE_NOT_FOUND", message: "مرحلة الكهرباء غير موجودة" });
  });

  it("answers 400 for something that is not an id", async () => {
    const res = await asAdmin("get", "/not-a-uuid", "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("POST /elec-phases", () => {
  beforeEach(() => {
    addStartingPhases();
  });

  it("adds the phase at the end, ACTIVE, at version 1, trimming the name", async () => {
    const res = await asAdmin("post", "", "en", { name: "  Conduit Test  " });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Conduit Test",
      sortOrder: 7,
      status: "ACTIVE",
      version: 1,
    });
    expect(res.body.data.createdAt).toMatch(/Z$/);
    expect(stored().at(-1)).toBe("Conduit Test");
    expect(phaseTables.phases).toHaveLength(7);
  });

  it("can add it INACTIVE", async () => {
    const res = await asAdmin("post", "", "en", { name: "Spare", status: "INACTIVE" });

    expect(res.body.data).toMatchObject({ status: "INACTIVE", sortOrder: 7 });
  });

  it("takes a progress ratio, 0 when none is given", async () => {
    const withRatio = await asAdmin("post", "", "en", { name: "Weighted", progressRatio: 25 });
    const without = await asAdmin("post", "", "en", { name: "Plain" });

    expect(withRatio.body.data).toMatchObject({ progressRatio: 25 });
    expect(without.body.data).toMatchObject({ progressRatio: 0 });
  });

  it("goes after the highest order even when earlier phases were deleted, so no two share a place", async () => {
    phaseTables.phases = phaseTables.phases.filter((p) => p.sortOrder !== 6 && p.sortOrder !== 2);

    const res = await asAdmin("post", "", "en", { name: "After Gap" });

    expect(res.body.data.sortOrder).toBe(6);
    expect(new Set(phaseTables.phases.map((p) => p.sortOrder)).size).toBe(phaseTables.phases.length);
  });

  it("is the first phase, at order 1, in an empty table", async () => {
    phaseTables.reset();

    expect((await asAdmin("post", "", "en", { name: "Only" })).body.data.sortOrder).toBe(1);
  });

  it.each(["Wall Piping", "wall piping", "WALL PIPING", "  Wall Piping  "])(
    "refuses the name %j, which a phase already has: 409 ELEC_PHASE_NAME_TAKEN, creating nothing",
    async (name) => {
      const res = await asAdmin("post", "", "ar", { name });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "ELEC_PHASE_NAME_TAKEN",
        message: "توجد مرحلة كهرباء بهذا الاسم بالفعل",
      });
      expect(res.body.details).toEqual([{ path: "name", message: "توجد مرحلة كهرباء بهذا الاسم بالفعل" }]);
      expect(phaseTables.phases).toHaveLength(6);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("accepts a name that only looks like another: a different word is a different phase", async () => {
    expect((await asAdmin("post", "", "en", { name: "Wall Piping 2" })).status).toBe(201);
  });

  it("keeps the unique index as the last word when two requests pick the same name at once", async () => {
    const [a, b] = await Promise.all([
      asAdmin("post", "", "en", { name: "Racing Name" }),
      asAdmin("post", "", "en", { name: "racing name" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((res) => res.status === 409)?.body.code).toBe("ELEC_PHASE_NAME_TAKEN");
    expect(phaseTables.phases.filter((p) => p.name.toLowerCase() === "racing name")).toHaveLength(1);
  });

  it("answers 409 ELEC_PHASE_NAME_TAKEN when the database index refuses a name the check missed", async () => {
    vi.spyOn(InMemoryElecPhasesRepository.prototype, "findByName").mockResolvedValue(null);

    const res = await asAdmin("post", "", "en", { name: "sleeves" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ELEC_PHASE_NAME_TAKEN");
    expect(phaseTables.phases).toHaveLength(6);
  });

  it("writes an audit row in the same transaction", async () => {
    const res = await asAdmin("post", "", "en", { name: "Conduit Test" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "elec_phase.create",
      entity: "ElecPhase",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: { name: "Conduit Test", status: "ACTIVE", sortOrder: 7 },
      requestId: expect.any(String),
    });
    expect(auditRows()[0]).not.toHaveProperty("before");
  });

  it("rolls the phase back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("post", "", "en", { name: "Conduit Test" });

    expect(res.status).toBe(500);
    expect(phaseTables.phases).toHaveLength(6);
    expect(auditRows()).toHaveLength(0);
  });

  it("lets an employee with elec-phases:create add one", async () => {
    const res = await call("post", "")
      .set(await as(employee("e@example.test", "elec-phases:create")))
      .send({ name: "Conduit Test" });

    expect(res.status).toBe(201);
    expect(auditRows()[0]).toMatchObject({ actorId: expect.not.stringMatching(admin.id) });
  });

  it.each([
    ["no body", {}],
    ["a blank name", { name: "   " }],
    ["a 101-character name", { name: "x".repeat(101) }],
    ["a name that is not a string", { name: 5 }],
    ["a lowercase status", { name: "N", status: "active" }],
    ["an unknown status", { name: "N", status: "PAUSED" }],
    ["a sortOrder", { name: "N", sortOrder: 1 }],
    ["a version", { name: "N", version: 9 }],
    ["an id", { name: "N", id: MISSING_ID }],
    ["an unknown field", { name: "N", weight: 3 }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await asAdmin("post", "", "en", payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(phaseTables.phases).toHaveLength(6);
    expect(auditRows()).toHaveLength(0);
  });

  it("explains each problem in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { name: " ", status: "x" });

    expect(res.body.message).toBe("فشل التحقق");
    expect(res.body.details).toEqual([
      { path: "name", message: "الاسم مطلوب" },
      { path: "status", message: "يجب أن تكون الحالة ACTIVE أو INACTIVE" },
    ]);
  });
});

describe("POST /elec-phases with an Idempotency-Key", () => {
  const body = { name: "Conduit Test" };
  const create = (options: Options = {}) => asUser("post", "", { body, key: KEY, ...options });

  it("runs once: the same key and body again replays the first answer and creates nothing", async () => {
    const first = await create();
    const second = await create();

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(phaseTables.phases).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it("without a key, the second identical post is a name conflict, not a second phase", async () => {
    await asUser("post", "", { body });
    const again = await asUser("post", "", { body });

    expect(again.status).toBe(409);
    expect(phaseTables.phases).toHaveLength(1);
  });

  it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
    await create();

    const reused = await create({ body: { name: "Another" } });

    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(phaseTables.phases).toHaveLength(1);
  });

  it("two identical requests at the same moment create one phase", async () => {
    const [a, b] = await Promise.all([create(), create()]);

    expect(phaseTables.phases).toHaveLength(1);
    expect([a.status, b.status].sort()[0]).toBe(201);
  });

  it("does not keep a 409: once the name is free again the same key runs again", async () => {
    const taken = addPhase({ name: "Conduit Test" });
    const refused = await create();
    phaseTables.phases = phaseTables.phases.filter((p) => p.id !== taken.id);
    const retried = await create();

    expect(refused.status).toBe(409);
    expect(retried.status).toBe(201);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("does not keep a 5xx: after the audit write fails the same key runs again", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const failed = await create();
    store.failAuditWith = null;
    const retried = await create();

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(phaseTables.phases).toHaveLength(1);
  });

  it("refuses a malformed key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
    const res = await create({ key: "short" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(phaseTables.phases).toHaveLength(0);
  });
});

describe("PATCH /elec-phases/:id", () => {
  beforeEach(() => {
    addStartingPhases();
  });
  const phaseNamed = (name: string) => phaseTables.phases.find((p) => p.name === name)!;

  it("renames, deactivates, or both, and audits before and after", async () => {
    const phase = phaseNamed("Sleeves");

    const rename = await asAdmin("patch", `/${phase.id}`, "en", { name: " Sleeves & Boxes " });
    const off = await asAdmin("patch", `/${phase.id}`, "en", { status: "INACTIVE" });
    const both = await asAdmin("patch", `/${phase.id}`, "en", { name: "Sleeves", status: "ACTIVE" });

    expect(rename.body.data).toMatchObject({ name: "Sleeves & Boxes", status: "ACTIVE", sortOrder: 6 });
    expect(off.body.data).toMatchObject({ name: "Sleeves & Boxes", status: "INACTIVE" });
    expect(both.body.data).toMatchObject({ name: "Sleeves", status: "ACTIVE", version: 4 });
    expect(auditRows()).toHaveLength(3);
    expect(auditRows()[0]).toMatchObject({
      action: "elec_phase.update",
      entity: "ElecPhase",
      actorId: admin.id,
      entityId: phase.id,
      before: { name: "Sleeves", status: "ACTIVE", sortOrder: 6 },
      after: { name: "Sleeves & Boxes", status: "ACTIVE", sortOrder: 6 },
    });
  });

  it("changes the progress ratio alone, audits it, and refuses one outside 0 to 100 or not whole", async () => {
    const phase = phaseNamed("Sleeves");

    const res = await asAdmin("patch", `/${phase.id}`, "en", { progressRatio: 40 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Sleeves", progressRatio: 40, version: 2 });
    expect(auditRows()[0]).toMatchObject({ before: { progressRatio: 0 }, after: { progressRatio: 40 } });
    for (const bad of [-1, 101, 12.5, "40"]) {
      const refused = await asAdmin("patch", `/${phase.id}`, "en", { progressRatio: bad });
      expect(refused.status, String(bad)).toBe(400);
    }
    expect(phase.progressRatio).toBe(40);
  });

  it("never moves the phase: only a reorder changes its place", async () => {
    const phase = phaseNamed("Wall Piping");

    const res = await asAdmin("patch", `/${phase.id}`, "en", { name: "Wall Conduit", status: "INACTIVE" });

    expect(res.body.data.sortOrder).toBe(5);
    expect(stored()).toEqual([
      "Ceiling Piping",
      "MSB Box Fixing",
      "Cut/out Box Fixing",
      "D.B Box Fixing",
      "Wall Conduit",
      "Sleeves",
    ]);
  });

  it.each(["Sleeves", "sleeves", "SLEEVES", " sleeves "])(
    "refuses the name %j, which another phase has: 409 ELEC_PHASE_NAME_TAKEN, changing nothing",
    async (name) => {
      const phase = phaseNamed("Wall Piping");

      const res = await asAdmin("patch", `/${phase.id}`, "ar", { name });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ELEC_PHASE_NAME_TAKEN");
      expect(res.body.details[0].path).toBe("name");
      expect(phaseTables.phases.find((p) => p.id === phase.id)).toMatchObject({
        name: "Wall Piping",
        version: 1,
      });
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("lets a phase keep its own name, in another case", async () => {
    const phase = phaseNamed("Wall Piping");

    const res = await asAdmin("patch", `/${phase.id}`, "en", { name: "WALL PIPING" });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("WALL PIPING");
  });

  it("lets a phase take the name another one gave up", async () => {
    const wall = phaseNamed("Wall Piping");
    const sleeves = phaseNamed("Sleeves");

    await asAdmin("patch", `/${wall.id}`, "en", { name: "Wall Conduit" });
    const res = await asAdmin("patch", `/${sleeves.id}`, "en", { name: "Wall Piping" });

    expect(res.status).toBe(200);
  });

  it.each([
    ["an empty body", {}],
    ["a sortOrder", { sortOrder: 1 }],
    ["a version in the body", { name: "N", version: 9 }],
    ["an id", { id: MISSING_ID }],
    ["a blank name", { name: " " }],
    ["a bad status", { status: "PAUSED" }],
    ["an unknown field", { name: "N", weight: 3 }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const phase = phaseNamed("Sleeves");

    const res = await asAdmin("patch", `/${phase.id}`, "en", payload);

    expect(res.status).toBe(400);
    expect(phaseTables.phases.find((p) => p.id === phase.id)).toMatchObject({
      name: "Sleeves",
      status: "ACTIVE",
      sortOrder: 6,
      version: 1,
    });
    expect(auditRows()).toHaveLength(0);
  });

  it("explains an empty update in Arabic", async () => {
    const res = await asAdmin("patch", `/${phaseNamed("Sleeves").id}`, "ar", {});

    expect(res.body.details[0].message).toBe("يجب تقديم حقل واحد على الأقل للتحديث");
  });

  it("answers 404 for an unknown phase, and 400 for a malformed id", async () => {
    expect((await asAdmin("patch", `/${MISSING_ID}`, "en", { name: "N" })).status).toBe(404);
    expect((await asAdmin("patch", "/nope", "en", { name: "N" })).status).toBe(400);
  });

  it("answers 404 when the phase is deleted by someone else mid-request (P2025)", async () => {
    const phase = phaseNamed("Sleeves");
    phaseTables.removeBeforeWrite = true;

    const res = await asAdmin("patch", `/${phase.id}`, "ar", { name: "Too Late" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "ELEC_PHASE_NOT_FOUND", message: "مرحلة الكهرباء غير موجودة" });
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the change back when the audit write fails", async () => {
    const phase = phaseNamed("Sleeves");
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("patch", `/${phase.id}`, "en", { name: "Changed" });

    expect(res.status).toBe(500);
    expect(phaseTables.phases.find((p) => p.id === phase.id)).toMatchObject({ name: "Sleeves", version: 1 });
  });

  it("lets only the holder of elec-phases:update change a phase", async () => {
    const phase = phaseNamed("Sleeves");

    const denied = await call("patch", `/${phase.id}`)
      .set(await as(employee("r@example.test", "elec-phases:read", "elec-phases:create")))
      .send({ name: "X" });
    const allowed = await call("patch", `/${phase.id}`)
      .set(await as(employee("u@example.test", "elec-phases:update")))
      .send({ name: "Y" });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it("can deactivate a phase that is in use: that is the way out of the delete block", async () => {
    const phase = phaseNamed("Sleeves");
    phaseTables.usage[phase.id] = 12;

    const res = await asAdmin("patch", `/${phase.id}`, "en", { status: "INACTIVE" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("INACTIVE");
  });
});

describe("versions: PATCH and DELETE with If-Match", () => {
  it("every update adds 1, returns the new version in the body and as the ETag, and refuses a stale If-Match", async () => {
    const phase = addPhase({ name: "Sleeves" });

    const ok = await asUser("patch", `/${phase.id}`, { body: { name: "Sleeves 2" }, ifMatch: "1" });
    const stale = await asUser("patch", `/${phase.id}`, { body: { name: "Other" }, ifMatch: "1" });
    const single = await asAdmin("get", `/${phase.id}`);

    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
    expect(ok.headers["etag"]).toBe('"2"');
    conflict(stale, 2);
    expect(single.body.data).toMatchObject({ name: "Sleeves 2", version: 2 });
    expect(auditRows()).toHaveLength(1);
  });

  it("a stale write is a 409 in Arabic too, and changes nothing", async () => {
    const phase = addPhase({ name: "Sleeves", version: 5 });

    const res = await asUser("patch", `/${phase.id}`, { body: { name: "N" }, ifMatch: "4", language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(res.body.details[0]).toMatchObject({ path: "version", value: 5 });
    expect(phaseTables.phases[0]).toMatchObject({ name: "Sleeves", version: 5 });
  });

  it.each(["3", '"3"', 'W/"3"'])("accepts If-Match %s for version 3", async (header) => {
    const phase = addPhase({ name: "Sleeves", version: 3 });

    expect((await asUser("patch", `/${phase.id}`, { body: { name: "N" }, ifMatch: header })).status).toBe(
      200,
    );
  });

  it.each(["abc", "0", "-1", "1.5", "3,4"])("refuses a malformed If-Match %j with 400", async (header) => {
    const phase = addPhase({ name: "Sleeves" });

    const res = await asUser("patch", `/${phase.id}`, { body: { name: "N" }, ifMatch: header });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IF_MATCH");
    expect(phaseTables.phases[0]?.version).toBe(1);
  });

  it("two simultaneous updates with the same version: one wins, the other is a 409", async () => {
    const phase = addPhase({ name: "Sleeves" });

    const [a, b] = await Promise.all([
      asUser("patch", `/${phase.id}`, { body: { status: "INACTIVE" }, ifMatch: "1" }),
      asUser("patch", `/${phase.id}`, { body: { name: "Renamed" }, ifMatch: "1" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(phaseTables.phases[0]?.version).toBe(2);
    expect(auditRows()).toHaveLength(1);
  });

  it("answers 409, never a silent overwrite, when the row moves between the lock and the write", async () => {
    const phase = addPhase({ name: "Sleeves" });
    vi.spyOn(InMemoryElecPhasesRepository.prototype, "update").mockResolvedValueOnce(null);
    vi.spyOn(InMemoryElecPhasesRepository.prototype, "delete").mockResolvedValueOnce(false);

    conflict(await asAdmin("patch", `/${phase.id}`, "en", { name: "X" }), 1);
    conflict(await asAdmin("delete", `/${phase.id}`), 1);

    expect(phaseTables.phases[0]).toMatchObject({ name: "Sleeves", version: 1 });
    expect(auditRows()).toHaveLength(0);
  });

  it("an unknown id is 404 even with a stale If-Match", async () => {
    expect((await asUser("patch", `/${MISSING_ID}`, { body: { name: "N" }, ifMatch: "7" })).status).toBe(404);
  });

  it("DELETE refuses a stale If-Match and deletes with the right one", async () => {
    const phase = addPhase({ name: "Sleeves", version: 2 });

    const stale = await asUser("delete", `/${phase.id}`, { ifMatch: "1" });
    const gone = await asUser("delete", `/${phase.id}`, { ifMatch: "2" });

    conflict(stale, 2);
    expect(gone.status).toBe(204);
    expect(phaseTables.phases).toHaveLength(0);
  });
});

describe("PUT /elec-phases/order", () => {
  let ids: string[];
  const idOf = (name: string) => phaseTables.phases.find((p) => p.name === name)!.id;
  const reorder = (list: string[], options: Options = {}) =>
    asUser("put", "/order", { body: { ids: list }, ...options });

  beforeEach(() => {
    ids = addStartingPhases().map((p) => p.id);
  });

  it("puts the phases in the order given and answers with all of them, renumbered 1 to 6", async () => {
    const wanted = [5, 4, 3, 2, 1, 0].map((i) => ids[i]!);

    const res = await reorder(wanted);

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      "Sleeves",
      "Wall Piping",
      "D.B Box Fixing",
      "Cut/out Box Fixing",
      "MSB Box Fixing",
      "Ceiling Piping",
    ]);
    expect(res.body.data.map((p: { sortOrder: number }) => p.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.body).not.toHaveProperty("meta");
    expect(stored()).toEqual(names(res));
    expect((await asAdmin("get", "")).body.data.map((p: { id: string }) => p.id)).toEqual(wanted);
  });

  it("moves one phase to the front and shifts the rest down", async () => {
    const res = await reorder([ids[4]!, ids[0]!, ids[1]!, ids[2]!, ids[3]!, ids[5]!]);

    expect(names(res)).toEqual([
      "Wall Piping",
      "Ceiling Piping",
      "MSB Box Fixing",
      "Cut/out Box Fixing",
      "D.B Box Fixing",
      "Sleeves",
    ]);
  });

  it("adds 1 to the version of each phase that moved, and leaves the others alone", async () => {
    const res = await reorder([ids[1]!, ids[0]!, ...ids.slice(2)]);

    expect(res.body.data.map((p: { version: number }) => p.version)).toEqual([2, 2, 1, 1, 1, 1]);
  });

  it("audits one row per phase that moved, with its old and new place, and none for the rest", async () => {
    await reorder([ids[1]!, ids[0]!, ...ids.slice(2)]);

    expect(auditRows()).toHaveLength(2);
    expect(auditRows().map((row) => row["action"])).toEqual(["elec_phase.reorder", "elec_phase.reorder"]);
    expect(auditRows()[0]).toMatchObject({
      entity: "ElecPhase",
      entityId: ids[1],
      actorId: admin.id,
      before: { name: "MSB Box Fixing", status: "ACTIVE", sortOrder: 2 },
      after: { name: "MSB Box Fixing", status: "ACTIVE", sortOrder: 1 },
      requestId: expect.any(String),
    });
    expect(auditRows()[1]).toMatchObject({
      entityId: ids[0],
      before: { sortOrder: 1 },
      after: { sortOrder: 2 },
    });
  });

  it("is a no-op, with no version change and no audit row, when the order is already that one", async () => {
    const res = await reorder(ids);

    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { version: number }) => p.version)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(auditRows()).toHaveLength(0);
  });

  it("closes gaps left by deleted phases", async () => {
    phaseTables.phases = phaseTables.phases.filter((p) => p.sortOrder !== 2 && p.sortOrder !== 3);
    const left = phaseTables.phases.map((p) => p.id);

    const res = await reorder(left);

    expect(res.body.data.map((p: { sortOrder: number }) => p.sortOrder)).toEqual([1, 2, 3, 4]);
  });

  it("keeps inactive phases in the order", async () => {
    phaseTables.phases[2]!.status = "INACTIVE";

    const res = await reorder([...ids].reverse());

    expect(res.body.data[3]).toMatchObject({ name: "Cut/out Box Fixing", status: "INACTIVE", sortOrder: 4 });
  });

  it("changes the order that list and options show", async () => {
    await reorder([...ids].reverse());

    expect((await asAdmin("get", "/options")).body.data[0].name).toBe("Sleeves");
    expect(names(await asAdmin("get", ""))[0]).toBe("Sleeves");
  });

  it.each([
    ["leaves a phase out", (all: string[]) => all.slice(1)],
    ["names a phase that does not exist", (all: string[]) => [...all, randomUUID()]],
    ["swaps a phase for one that does not exist", (all: string[]) => [randomUUID(), ...all.slice(1)]],
  ])("refuses a list that %s: 409 ELEC_PHASES_CHANGED, changing nothing", async (_label, make) => {
    const before = structuredClone(phaseTables.phases);

    const res = await reorder(make(ids), { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "ELEC_PHASES_CHANGED",
      message: "تغيرت قائمة مراحل الكهرباء. أعد تحميلها وحاول مرة أخرى",
    });
    expect(phaseTables.phases).toEqual(before);
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a list that was right when the page loaded but a phase was added since", async () => {
    await asAdmin("post", "", "en", { name: "Added Meanwhile" });

    const res = await reorder([...ids].reverse());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ELEC_PHASES_CHANGED");
    expect(stored().slice(0, 6)).toEqual([
      "Ceiling Piping",
      "MSB Box Fixing",
      "Cut/out Box Fixing",
      "D.B Box Fixing",
      "Wall Piping",
      "Sleeves",
    ]);
  });

  it("refuses a list that still names a phase deleted since the page loaded", async () => {
    await asAdmin("delete", `/${ids[5]}`);

    const res = await reorder([...ids].reverse());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ELEC_PHASES_CHANGED");
  });

  it.each([
    ["no body", undefined],
    ["no ids", {}],
    ["an empty list", { ids: [] }],
    ["ids that are not a list", { ids: "abc" }],
    ["an id that is not an id", { ids: ["nope"] }],
    ["a phase named twice", { ids: [MISSING_ID, MISSING_ID] }],
    ["unknown fields", { ids: [MISSING_ID], mode: "x" }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await asUser("put", "/order", { body });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(auditRows()).toHaveLength(0);
  });

  it("says a repeated phase is invalid in Arabic", async () => {
    const res = await reorder([ids[0]!, ids[0]!], { language: "ar" });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "ids", message: "أرسل معرّف كل مرحلة كهرباء، مرة واحدة فقط" }]);
  });

  it("is not mistaken for a phase called order: there is no phase id 'order'", async () => {
    expect((await asAdmin("get", "/order")).status).toBe(400);
    expect((await asAdmin("patch", "/order", "en", { name: "x" })).status).toBe(400);
  });

  it("rolls every move back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await reorder([...ids].reverse());

    expect(res.status).toBe(500);
    expect(stored()).toEqual([
      "Ceiling Piping",
      "MSB Box Fixing",
      "Cut/out Box Fixing",
      "D.B Box Fixing",
      "Wall Piping",
      "Sleeves",
    ]);
    expect(phaseTables.phases.every((p) => p.version === 1)).toBe(true);
  });

  it("answers 409 VERSION_CONFLICT, writing nothing, when a phase moves between the lock and the write", async () => {
    vi.spyOn(InMemoryElecPhasesRepository.prototype, "setSortOrder").mockResolvedValueOnce(null);

    const res = await reorder([ids[1]!, ids[0]!, ...ids.slice(2)]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(auditRows()).toHaveLength(0);
  });

  it("repeating the same key replays the first answer and moves nothing a second time", async () => {
    const wanted = [...ids].reverse();

    const first = await reorder(wanted, { key: KEY });
    const second = await reorder(wanted, { key: KEY });

    expect(first.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(auditRows()).toHaveLength(6);
    expect(phaseTables.phases.every((p) => p.version === 2)).toBe(true);
  });

  it("refuses a key that comes back with another list: 422 IDEMPOTENCY_KEY_REUSED", async () => {
    await reorder([...ids].reverse(), { key: KEY });

    const reused = await reorder(ids, { key: KEY });

    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("two reorders at once take turns: the second sees the first's result and ends with its own order", async () => {
    const forward = ids;
    const backward = [...ids].reverse();

    const [a, b] = await Promise.all([reorder(backward), reorder(forward)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(new Set(phaseTables.phases.map((p) => p.sortOrder))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(stored().length).toBe(6);
  });

  it("a phase created while the order is being changed never shares a place with another", async () => {
    const [reordered, created] = await Promise.all([
      reorder([...ids].reverse()),
      asAdmin("post", "", "en", { name: "Added Meanwhile" }),
    ]);

    expect(created.status).toBe(201);
    expect([200, 409]).toContain(reordered.status);
    const orders = phaseTables.phases.map((p) => p.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("names are untouched by a reorder", async () => {
    await reorder([...ids].reverse());

    expect(phaseTables.phases.map((p) => p.name).sort()).toEqual(
      [
        "Ceiling Piping",
        "Cut/out Box Fixing",
        "D.B Box Fixing",
        "MSB Box Fixing",
        "Sleeves",
        "Wall Piping",
      ].sort(),
    );
    expect(idOf("Sleeves")).toBe(ids[5]);
  });
});

describe("DELETE /elec-phases/:id", () => {
  it("deletes an unused phase with 204 and no body, and audits the deleted values", async () => {
    const phase = addPhase({ name: "Sleeves", sortOrder: 6 });

    const res = await asAdmin("delete", `/${phase.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(phaseTables.phases).toHaveLength(0);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "elec_phase.delete",
      entity: "ElecPhase",
      actorId: admin.id,
      entityId: phase.id,
      before: { name: "Sleeves", status: "ACTIVE", sortOrder: 6 },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("deletes only the phase asked for, and leaves the others where they are", async () => {
    const [keep, drop, last] = [
      addPhase({ name: "Keep" }),
      addPhase({ name: "Drop" }),
      addPhase({ name: "Last" }),
    ];

    expect((await asAdmin("delete", `/${drop.id}`)).status).toBe(204);
    expect(phaseTables.phases.map((p) => [p.id, p.sortOrder])).toEqual([
      [keep.id, 1],
      [last.id, 3],
    ]);
  });

  it.each([1, 7])(
    "refuses a phase that %i records use: 409 ELEC_PHASE_IN_USE, deleting and auditing nothing",
    async (uses) => {
      const phase = addPhase({ name: "Sleeves" });
      phaseTables.usage[phase.id] = uses;

      const res = await asAdmin("delete", `/${phase.id}`, "ar");

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "ELEC_PHASE_IN_USE",
        message:
          "هذه المرحلة مستخدمة (تقدم الفلل أو الأعمال المفتوحة) ولا يمكن حذفها. قم بتعطيلها بدلاً من ذلك",
      });
      expect(phaseTables.phases).toHaveLength(1);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("deletes the phase once nothing uses it any more", async () => {
    const phase = addPhase({ name: "Sleeves" });
    phaseTables.usage[phase.id] = 2;
    const refused = await asAdmin("delete", `/${phase.id}`);
    phaseTables.usage[phase.id] = 0;

    const deleted = await asAdmin("delete", `/${phase.id}`);

    expect(refused.status).toBe(409);
    expect(deleted.status).toBe(204);
  });

  it("does not put a deleted phase back: the starting phases are ordinary rows", async () => {
    const [first] = addStartingPhases();

    await asAdmin("delete", `/${first!.id}`);

    expect(stored()).not.toContain("Ceiling Piping");
    expect((await asAdmin("get", "")).body.meta.total).toBe(5);
  });

  it("answers 404 for an unknown phase, and 400 for a malformed id", async () => {
    expect((await asAdmin("delete", `/${MISSING_ID}`, "ar")).body.code).toBe("ELEC_PHASE_NOT_FOUND");
    expect((await asAdmin("delete", "/nope")).status).toBe(400);
  });

  it("answers 404 when another request deletes it first (P2025)", async () => {
    const phase = addPhase({ name: "Raced Away" });
    phaseTables.removeBeforeWrite = true;

    const res = await asAdmin("delete", `/${phase.id}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ELEC_PHASE_NOT_FOUND");
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the delete back when the audit write fails", async () => {
    const phase = addPhase({ name: "Keep Me" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("delete", `/${phase.id}`);

    expect(res.status).toBe(500);
    expect(phaseTables.phases).toHaveLength(1);
  });

  it("lets only the holder of elec-phases:delete delete", async () => {
    const phase = addPhase({ name: "Target" });

    const denied = await call("delete", `/${phase.id}`).set(
      await as(employee("u@example.test", "elec-phases:update", "elec-phases:read")),
    );
    const allowed = await call("delete", `/${phase.id}`).set(
      await as(employee("d@example.test", "elec-phases:delete")),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
  });
});

describe("audit trail", () => {
  it("records create, update, reorder and delete in order, each with the actor and a request id", async () => {
    const first = (await asAdmin("post", "", "en", { name: "One" })).body.data.id as string;
    const second = (await asAdmin("post", "", "en", { name: "Two" })).body.data.id as string;
    await asAdmin("patch", `/${first}`, "en", { status: "INACTIVE" });
    await asAdmin("put", "/order", "en", { ids: [second, first] });
    await asAdmin("delete", `/${first}`);

    expect(auditRows().map((row) => row["action"])).toEqual([
      "elec_phase.create",
      "elec_phase.create",
      "elec_phase.update",
      "elec_phase.reorder",
      "elec_phase.reorder",
      "elec_phase.delete",
    ]);
    for (const row of auditRows()) {
      expect(row).toMatchObject({ actorId: admin.id, entity: "ElecPhase" });
      expect(row["requestId"]).toEqual(expect.any(String));
    }
  });
});
