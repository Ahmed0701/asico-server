import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addArea, areaTables, InMemoryAreasRepository } from "./in-memory-areas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/areas/repository/areas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/areas/repository/areas.repository.js")>()),
  AreasRepository: (await import("./in-memory-areas.repository.js")).InMemoryAreasRepository,
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
  villaTables.reset();
  areaTables.reset();
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

type Verb = "get" | "post" | "patch" | "delete";
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1/areas${path}`);

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
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

// A few areas, and villas in some of them.
function seed() {
  const newCairo = addArea({ name: "New Cairo", city: "Cairo", createdAt: new Date("2026-01-01T00:00:00Z") });
  const zayed = addArea({ name: "Sheikh Zayed", city: "Giza", createdAt: new Date("2026-01-02T00:00:00Z") });
  const october = addArea({ name: "6 October", city: "Giza", createdAt: new Date("2026-01-03T00:00:00Z") });
  const empty = addArea({ name: "الشروق", city: "Cairo", createdAt: new Date("2026-01-04T00:00:00Z") });
  addVilla({ areaId: newCairo.id });
  addVilla({ areaId: newCairo.id });
  addVilla({ areaId: newCairo.id });
  addVilla({ areaId: zayed.id });
  addVilla({ areaId: october.id });
  addVilla({ areaId: october.id });
  return { newCairo, zayed, october, empty };
}

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "areas:read"],
    ["get", "/options", "areas:read"],
    ["get", `/${MISSING_ID}`, "areas:read"],
    ["post", "", "areas:create"],
    ["patch", `/${MISSING_ID}`, "areas:update"],
    ["delete", `/${MISSING_ID}`, "areas:delete"],
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
    "%s %s is not opened by the other areas permissions, nor by anyone else's",
    async (verb, path, needed) => {
      const others = ["areas:read", "areas:create", "areas:update", "areas:delete"]
        .filter((code) => code !== needed)
        .concat(
          "villas:read",
          "villas:update",
          "villas:export",
          "elec-phases:read",
          "electrical-engineers:update",
          "civil-engineers:update",
          "contractors:update",
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
    const res = await call("post", "")
      .set(await as(employee("e@example.test")))
      .send({ nonsense: true });

    expect(res.status).toBe(403);
  });
});

describe("GET /areas", () => {
  beforeEach(() => {
    seed();
  });

  it("returns the areas by name, with the shared pagination meta, the villa count and exactly the public fields", async () => {
    const res = await asAdmin("get", "");

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["6 October", "New Cairo", "Sheikh Zayed", "الشروق"]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["city", "createdAt", "id", "name", "updatedAt", "version", "villaCount"].sort(),
    );
    expect(res.body.data.map((a: { name: string; villaCount: number }) => [a.name, a.villaCount])).toEqual([
      ["6 October", 2],
      ["New Cairo", 3],
      ["Sheikh Zayed", 1],
      ["الشروق", 0],
    ]);
  });

  it("derives the villa count from the villas: adding one changes the count and not the area", async () => {
    const { empty } = seed();
    const before = areaTables.areas.find((a) => a.id === empty.id);
    const versionBefore = before?.version;

    addVilla({ areaId: empty.id });
    const res = await asAdmin("get", `/${empty.id}`);

    expect(res.body.data.villaCount).toBe(1);
    expect(res.body.data.version).toBe(versionBefore);
    expect(areaTables.areas.find((a) => a.id === empty.id)).not.toHaveProperty("villaCount");
  });

  it.each([
    ["name", ["6 October", "New Cairo", "Sheikh Zayed", "الشروق"]],
    ["name:desc", ["الشروق", "Sheikh Zayed", "New Cairo", "6 October"]],
    ["city", ["New Cairo", "الشروق", "6 October", "Sheikh Zayed"]],
    ["city:desc", ["6 October", "Sheikh Zayed", "New Cairo", "الشروق"]],
    ["villaCount:desc", ["New Cairo", "6 October", "Sheikh Zayed", "الشروق"]],
    ["villaCount", ["الشروق", "Sheikh Zayed", "6 October", "New Cairo"]],
    ["createdAt", ["New Cairo", "Sheikh Zayed", "6 October", "الشروق"]],
    ["createdAt:desc", ["الشروق", "6 October", "Sheikh Zayed", "New Cairo"]],
  ])("sorts by %s", async (sort, expected) => {
    expect(names(await asAdmin("get", `?sort=${encodeURIComponent(sort)}`))).toEqual(expected);
  });

  it("breaks ties by name, then id, so pages never repeat or skip a row", async () => {
    addArea({ name: "Alpha", city: "Cairo" });
    addArea({ name: "Alpha", city: "Aswan" });

    const res = await asAdmin("get", "?sort=villaCount:asc&limit=100");

    expect(res.body.data.slice(0, 3).map((a: { name: string; city: string }) => [a.name, a.city])).toEqual([
      ["Alpha", "Aswan"],
      ["Alpha", "Cairo"],
      ["الشروق", "Cairo"],
    ]);
  });

  it("pages through the list", async () => {
    const first = await asAdmin("get", "?limit=3");
    const second = await asAdmin("get", "?limit=3&page=2");

    expect(first.body.meta).toEqual({ page: 1, limit: 3, total: 4, totalPages: 2 });
    expect(names(first)).toEqual(["6 October", "New Cairo", "Sheikh Zayed"]);
    expect(names(second)).toEqual(["الشروق"]);
  });

  it.each([
    ["cairo", ["New Cairo", "الشروق"]],
    ["CAIRO", ["New Cairo", "الشروق"]],
    ["giza", ["6 October", "Sheikh Zayed"]],
    ["zayed", ["Sheikh Zayed"]],
    ["الشر", ["الشروق"]],
    ["nothing-like-this", []],
  ])("searches the name and the city, ignoring case: ?search=%s", async (search, expected) => {
    expect(names(await asAdmin("get", `?search=${encodeURIComponent(search)}`))).toEqual(expected);
  });

  it("reads % and _ in a search as plain characters", async () => {
    expect(names(await asAdmin("get", "?search=%25"))).toEqual([]);
    expect(names(await asAdmin("get", "?search=_"))).toEqual([]);
  });

  it.each([
    "page=0",
    "page=abc",
    "page=1.5",
    "limit=0",
    "limit=1001",
    "limit=-1",
    "limit=",
    "sort=id",
    "sort=villas",
    "sort=name:up",
    `search=${"x".repeat(101)}`,
    "unknown=1&page=x",
  ])("refuses ?%s with 400 and never clamps", async (query) => {
    const res = await asAdmin("get", `?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("explains a bad sort in Arabic", async () => {
    const res = await asAdmin("get", "?sort=id", "ar");

    expect(res.body.details).toEqual([
      {
        path: "sort",
        message:
          "ترتيب غير صالح. استخدم name أو city أو villaCount أو createdAt، متبوعًا اختياريًا بـ :asc أو :desc",
      },
    ]);
  });

  it("accepts the largest page size", async () => {
    expect((await asAdmin("get", "?limit=1000")).status).toBe(200);
  });
});

describe("GET /areas/options", () => {
  it("returns every area as id, name and city, by name, and nothing else", async () => {
    seed();

    const res = await asAdmin("get", "/options");

    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { name: string }) => o.name)).toEqual([
      "6 October",
      "New Cairo",
      "Sheikh Zayed",
      "الشروق",
    ]);
    for (const option of res.body.data) {
      expect(Object.keys(option).sort()).toEqual(["city", "id", "name"]);
    }
    expect(res.body).not.toHaveProperty("meta");
  });

  it("is not read as an id", async () => {
    expect((await asAdmin("get", "/options")).status).toBe(200);
  });

  it("is an empty list for an empty table", async () => {
    expect((await asAdmin("get", "/options")).body).toEqual({ data: [] });
  });
});

describe("GET /areas/:id", () => {
  it("returns the area in the same shape as the list, with its version as the ETag", async () => {
    const { october } = seed();

    const res = await asAdmin("get", `/${october.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: october.id,
      name: "6 October",
      city: "Giza",
      villaCount: 2,
      version: 1,
    });
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 404 AREA_NOT_FOUND in Arabic on request", async () => {
    const res = await asAdmin("get", `/${MISSING_ID}`, "ar");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "AREA_NOT_FOUND", message: "المنطقة غير موجودة" });
  });

  it("answers 400 for something that is not an id", async () => {
    const res = await asAdmin("get", "/not-a-uuid", "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("POST /areas", () => {
  beforeEach(() => {
    addArea({ name: "New Cairo", city: "Cairo" });
  });

  it("creates the area at version 1 with no villas, trimming both fields", async () => {
    const res = await asAdmin("post", "", "en", { name: "  Palm Hills ", city: " Giza  " });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Palm Hills", city: "Giza", villaCount: 0, version: 1 });
    expect(Object.keys(res.body.data).sort()).toEqual(
      ["city", "createdAt", "id", "name", "updatedAt", "version", "villaCount"].sort(),
    );
    expect(areaTables.areas).toHaveLength(2);
  });

  it.each([
    ["the same", "New Cairo", "Cairo"],
    ["another letter case", "new cairo", "CAIRO"],
    ["upper case", "NEW CAIRO", "cairo"],
    ["with spaces around it", "  New Cairo  ", "  Cairo "],
  ])("answers 409 AREA_TAKEN for the name in use in that city (%s)", async (_label, name, city) => {
    const res = await asAdmin("post", "", "ar", { name, city });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "AREA_TAKEN",
      message: "توجد منطقة بهذا الاسم بالفعل في هذه المدينة",
      details: [{ path: "name", message: "توجد منطقة بهذا الاسم بالفعل في هذه المدينة" }],
    });
    expect(areaTables.areas).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("accepts the same name in another city, and another name in the same city", async () => {
    expect((await asAdmin("post", "", "en", { name: "New Cairo", city: "Giza" })).status).toBe(201);
    expect((await asAdmin("post", "", "en", { name: "Fifth Settlement", city: "Cairo" })).status).toBe(201);
    expect(areaTables.areas).toHaveLength(3);
  });

  it("treats a name that only looks like another as another: _ and % are not wildcards", async () => {
    expect((await asAdmin("post", "", "en", { name: "New_Cairo", city: "Cairo" })).status).toBe(201);
    expect((await asAdmin("post", "", "en", { name: "N%", city: "Cairo" })).status).toBe(201);
  });

  it("keeps the unique index as the last word when two requests pick the same area at once", async () => {
    const [a, b] = await Promise.all([
      asAdmin("post", "", "en", { name: "Racing", city: "Cairo" }),
      asAdmin("post", "", "en", { name: "racing", city: "cairo" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((res) => res.status === 409)?.body.code).toBe("AREA_TAKEN");
    expect(areaTables.areas.filter((x) => x.name.toLowerCase() === "racing")).toHaveLength(1);
  });

  it("answers 409 AREA_TAKEN when the database index refuses an area the check missed", async () => {
    vi.spyOn(InMemoryAreasRepository.prototype, "findByNameAndCity").mockResolvedValue(null);

    const res = await asAdmin("post", "", "en", { name: "new cairo", city: "cairo" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AREA_TAKEN");
    expect(areaTables.areas).toHaveLength(1);
  });

  it("writes an audit row in the same transaction, with the name and city and no count", async () => {
    const res = await asAdmin("post", "", "en", { name: "Palm Hills", city: "Giza" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "area.create",
      entity: "Area",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: { name: "Palm Hills", city: "Giza" },
      requestId: expect.any(String),
    });
    expect(auditRows()[0]).not.toHaveProperty("before");
    expect(JSON.stringify(auditRows())).not.toMatch(/villaCount/);
  });

  it("rolls the area back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("post", "", "en", { name: "Palm Hills", city: "Giza" });

    expect(res.status).toBe(500);
    expect(areaTables.areas).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("lets an employee with areas:create add one", async () => {
    const res = await call("post", "")
      .set(await as(employee("c@example.test", "areas:create")))
      .send({ name: "Palm Hills", city: "Giza" });

    expect(res.status).toBe(201);
  });

  it.each([
    ["no body", {}],
    ["no city", { name: "N" }],
    ["no name", { city: "C" }],
    ["a blank name", { name: "   ", city: "C" }],
    ["a blank city", { name: "N", city: "   " }],
    ["a name over 100 characters", { name: "x".repeat(101), city: "C" }],
    ["a city over 100 characters", { name: "N", city: "x".repeat(101) }],
    ["a non-text name", { name: 5, city: "C" }],
    ["a non-text city", { name: "N", city: ["Cairo"] }],
    ["a villa count", { name: "N", city: "C", villaCount: 3 }],
    ["an id", { name: "N", city: "C", id: MISSING_ID }],
    ["a version", { name: "N", city: "C", version: 9 }],
    ["an unknown field", { name: "N", city: "C", country: "Egypt" }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await asAdmin("post", "", "en", payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(areaTables.areas).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("explains each problem in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { name: " ", city: "x".repeat(101) });

    expect(res.body.message).toBe("فشل التحقق");
    expect(res.body.details).toEqual([
      { path: "name", message: "الاسم مطلوب" },
      { path: "city", message: "يجب ألا تزيد المدينة عن 100 حرف" },
    ]);
  });

  it("explains a missing city in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { name: "N", city: " " });

    expect(res.body.details).toEqual([{ path: "city", message: "المدينة مطلوبة" }]);
  });
});

describe("POST /areas with an Idempotency-Key", () => {
  const body = { name: "Palm Hills", city: "Giza" };
  const create = (options: Options = {}) => asUser("post", "", { body, key: KEY, ...options });

  it("runs once: the same key and body again replays the first answer and creates nothing", async () => {
    const first = await create();
    const second = await create();

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(areaTables.areas).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  it("without a key, the second identical post is a conflict, not a second area", async () => {
    await asUser("post", "", { body });
    const again = await asUser("post", "", { body });

    expect(again.status).toBe(409);
    expect(areaTables.areas).toHaveLength(1);
  });

  it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
    await create();

    const reused = await create({ body: { name: "Another", city: "Giza" } });

    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(areaTables.areas).toHaveLength(1);
  });

  it("two identical requests at the same moment create one area", async () => {
    const [a, b] = await Promise.all([create(), create()]);

    expect(areaTables.areas).toHaveLength(1);
    expect([a.status, b.status].sort()[0]).toBe(201);
  });

  it("does not keep a 5xx: after the audit write fails the same key runs again", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const failed = await create();
    store.failAuditWith = null;
    const retried = await create();

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(areaTables.areas).toHaveLength(1);
  });

  it("refuses a malformed key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
    const res = await create({ key: "short" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(areaTables.areas).toHaveLength(0);
  });
});

describe("PATCH /areas/:id", () => {
  let target: ReturnType<typeof addArea>;
  beforeEach(() => {
    ({ newCairo: target } = seed());
  });

  const patch = (body: unknown, id = target.id, language = "en") =>
    asAdmin("patch", `/${id}`, language, body);

  it("renames, moves to another city, or both, and answers with the new version as the ETag", async () => {
    const renamed = await patch({ name: "  New Cairo City " });
    const moved = await patch({ city: "Giza" });
    const both = await patch({ name: "Fifth Settlement", city: "Cairo" });

    expect(renamed.body.data).toMatchObject({ name: "New Cairo City", city: "Cairo", version: 2 });
    expect(moved.body.data).toMatchObject({ name: "New Cairo City", city: "Giza", version: 3 });
    expect(both.body.data).toMatchObject({ name: "Fifth Settlement", city: "Cairo", version: 4 });
    expect(both.headers["etag"]).toBe('"4"');
  });

  it("answers with the derived villa count and leaves the villas alone", async () => {
    const res = await patch({ name: "Renamed" });

    expect(res.body.data.villaCount).toBe(3);
    expect(villaTables.villas.filter((p) => p.areaId === target.id)).toHaveLength(3);
  });

  it("audits only what the area had before and has now", async () => {
    await patch({ name: "Fifth Settlement", city: "Cairo" });

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "area.update",
      entity: "Area",
      actorId: admin.id,
      entityId: target.id,
      before: { name: "New Cairo", city: "Cairo" },
      after: { name: "Fifth Settlement", city: "Cairo" },
      requestId: expect.any(String),
    });
    expect(JSON.stringify(auditRows())).not.toMatch(/villaCount/);
  });

  it.each([
    ["the name used in the same city", { name: "الشروق" }],
    ["a move to a city where the name is used", { city: "Giza", name: "Sheikh Zayed" }],
  ])("answers 409 AREA_TAKEN for %s", async (_label, body) => {
    const res = await patch(body, target.id, "ar");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "AREA_TAKEN",
      message: "توجد منطقة بهذا الاسم بالفعل في هذه المدينة",
    });
    expect(areaTables.areas.find((a) => a.id === target.id)).toMatchObject({ name: "New Cairo", version: 1 });
    expect(auditRows()).toHaveLength(0);
  });

  it("checks the name against the city the area will be in, using the stored one when only the name is sent", async () => {
    // "6 October" exists in Giza, not in Cairo: renaming the Cairo area to it is fine, moving it to Giza is not.
    expect((await patch({ name: "6 October" })).status).toBe(200);
    const res = await patch({ city: "Giza" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AREA_TAKEN");
  });

  it.each(["New Cairo", "new cairo", "NEW CAIRO", " new cairo "])(
    "lets the area keep its own name when it is sent as %j",
    async (name) => {
      expect((await patch({ name })).status).toBe(200);
    },
  );

  it("lets an area take a name another area gave up", async () => {
    const zayed = areaTables.areas.find((a) => a.name === "Sheikh Zayed")!;
    await asAdmin("patch", `/${zayed.id}`, "en", { city: "Cairo", name: "Zayed Old" });

    expect((await patch({ name: "Sheikh Zayed", city: "Giza" })).status).toBe(200);
  });

  it("answers 409 AREA_TAKEN when the index catches a race", async () => {
    vi.spyOn(InMemoryAreasRepository.prototype, "findByNameAndCity").mockResolvedValue(null);

    const res = await patch({ name: "الشروق" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AREA_TAKEN");
  });

  it.each([
    ["an empty body", {}],
    ["a villa count", { villaCount: 99 }],
    ["an id", { id: MISSING_ID }],
    ["a version in the body", { name: "N", version: 3 }],
    ["an unknown field", { name: "N", country: "x" }],
    ["a blank name", { name: " " }],
    ["a blank city", { city: " " }],
    ["a city over 100 characters", { city: "x".repeat(101) }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const res = await patch(payload);

    expect(res.status).toBe(400);
    expect(areaTables.areas.find((a) => a.id === target.id)).toMatchObject({ name: "New Cairo", version: 1 });
    expect(auditRows()).toHaveLength(0);
  });

  it("explains an empty update in Arabic", async () => {
    const res = await patch({}, target.id, "ar");

    expect(res.body.details).toEqual([{ path: "", message: "يجب تقديم حقل واحد على الأقل للتحديث" }]);
  });

  it("answers 404 for an unknown area, and 400 for a malformed id", async () => {
    expect((await patch({ name: "N" }, MISSING_ID, "ar")).body).toMatchObject({
      code: "AREA_NOT_FOUND",
      message: "المنطقة غير موجودة",
    });
    expect((await patch({ name: "N" }, "nope")).status).toBe(400);
  });

  it("answers 404 when the area is deleted by someone else mid-request (P2025)", async () => {
    areaTables.removeBeforeWrite = true;

    const res = await patch({ name: "Too Late" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("AREA_NOT_FOUND");
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the change back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await patch({ name: "Changed" });

    expect(res.status).toBe(500);
    expect(areaTables.areas.find((a) => a.id === target.id)).toMatchObject({ name: "New Cairo", version: 1 });
  });

  it("lets only the holder of areas:update change an area", async () => {
    const denied = await call("patch", `/${target.id}`)
      .set(await as(employee("r@example.test", "areas:read", "areas:create", "areas:delete")))
      .send({ name: "X" });
    const allowed = await call("patch", `/${target.id}`)
      .set(await as(employee("u@example.test", "areas:update")))
      .send({ name: "Y" });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });
});

describe("versions: PATCH and DELETE with If-Match", () => {
  it("every update adds 1, returns the new version in the body and as the ETag, and refuses a stale If-Match", async () => {
    const area = addArea({ name: "Palm Hills" });

    const ok = await asUser("patch", `/${area.id}`, { body: { name: "Palm Hills 2" }, ifMatch: "1" });
    const stale = await asUser("patch", `/${area.id}`, { body: { name: "Other" }, ifMatch: "1" });
    const single = await asAdmin("get", `/${area.id}`);

    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
    expect(ok.headers["etag"]).toBe('"2"');
    conflict(stale, 2);
    expect(single.body.data).toMatchObject({ name: "Palm Hills 2", version: 2 });
    expect(auditRows()).toHaveLength(1);
  });

  it("a stale write is a 409 in Arabic too, and changes nothing", async () => {
    const area = addArea({ name: "Palm Hills", version: 5 });

    const res = await asUser("patch", `/${area.id}`, { body: { name: "N" }, ifMatch: "4", language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(res.body.details[0]).toMatchObject({ path: "version", value: 5 });
    expect(areaTables.areas[0]).toMatchObject({ name: "Palm Hills", version: 5 });
  });

  it.each(["3", '"3"', 'W/"3"'])("accepts If-Match %s for version 3", async (header) => {
    const area = addArea({ name: "Palm Hills", version: 3 });

    expect((await asUser("patch", `/${area.id}`, { body: { name: "N" }, ifMatch: header })).status).toBe(200);
  });

  it.each(["abc", "0", "-1", "1.5", "3,4"])("refuses a malformed If-Match %j with 400", async (header) => {
    const area = addArea({ name: "Palm Hills" });

    const res = await asUser("patch", `/${area.id}`, { body: { name: "N" }, ifMatch: header });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IF_MATCH");
    expect(areaTables.areas[0]?.version).toBe(1);
  });

  it("two simultaneous updates with the same version: one wins, the other is a 409", async () => {
    const area = addArea({ name: "Palm Hills" });

    const [a, b] = await Promise.all([
      asUser("patch", `/${area.id}`, { body: { city: "Giza" }, ifMatch: "1" }),
      asUser("patch", `/${area.id}`, { body: { name: "Renamed" }, ifMatch: "1" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(areaTables.areas[0]?.version).toBe(2);
    expect(auditRows()).toHaveLength(1);
  });

  it("answers 409, never a silent overwrite, when the row moves between the lock and the write", async () => {
    const area = addArea({ name: "Palm Hills" });
    vi.spyOn(InMemoryAreasRepository.prototype, "update").mockResolvedValueOnce(null);
    vi.spyOn(InMemoryAreasRepository.prototype, "delete").mockResolvedValueOnce(false);

    conflict(await asAdmin("patch", `/${area.id}`, "en", { name: "X" }), 1);
    conflict(await asAdmin("delete", `/${area.id}`), 1);

    expect(areaTables.areas[0]).toMatchObject({ name: "Palm Hills", version: 1 });
    expect(auditRows()).toHaveLength(0);
  });

  it("an unknown id is 404 even with a stale If-Match", async () => {
    expect((await asUser("patch", `/${MISSING_ID}`, { body: { name: "N" }, ifMatch: "7" })).status).toBe(404);
  });

  it("DELETE refuses a stale If-Match and deletes with the right one", async () => {
    const area = addArea({ name: "Palm Hills", version: 2 });

    const stale = await asUser("delete", `/${area.id}`, { ifMatch: "1" });
    const gone = await asUser("delete", `/${area.id}`, { ifMatch: "2" });

    conflict(stale, 2);
    expect(gone.status).toBe(204);
    expect(areaTables.areas).toHaveLength(0);
  });
});

describe("DELETE /areas/:id", () => {
  it("deletes an area with no villas with 204 and no body, and audits the deleted values", async () => {
    const { empty } = seed();

    const res = await asAdmin("delete", `/${empty.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(areaTables.areas.map((a) => a.id)).not.toContain(empty.id);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "area.delete",
      entity: "Area",
      actorId: admin.id,
      entityId: empty.id,
      before: { name: "الشروق", city: "Cairo" },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("deletes only the area asked for", async () => {
    const { empty } = seed();

    await asAdmin("delete", `/${empty.id}`);

    expect(areaTables.areas).toHaveLength(3);
  });

  it.each([1, 3])(
    "refuses an area with %i villas: 409 AREA_HAS_VILLAS, deleting and auditing nothing",
    async (villas) => {
      const area = addArea({ name: "Busy" });
      for (let i = 0; i < villas; i++) addVilla({ areaId: area.id });

      const res = await asAdmin("delete", `/${area.id}`, "ar");

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "AREA_HAS_VILLAS",
        message: "هذه المنطقة بها فلل ولا يمكن حذفها",
      });
      expect(areaTables.areas).toHaveLength(1);
      expect(villaTables.villas).toHaveLength(villas);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("deletes the area once its last villa has gone", async () => {
    const area = addArea({ name: "Busy" });
    const villa = addVilla({ areaId: area.id });
    expect((await asAdmin("delete", `/${area.id}`)).status).toBe(409);

    villaTables.villas = villaTables.villas.filter((p) => p.id !== villa.id);

    expect((await asAdmin("delete", `/${area.id}`)).status).toBe(204);
  });

  it("is refused for the areas of villas in another area too: only its own villas count", async () => {
    const mine = addArea({ name: "Mine" });
    const other = addArea({ name: "Other" });
    addVilla({ areaId: other.id });

    expect((await asAdmin("delete", `/${mine.id}`)).status).toBe(204);
    expect(areaTables.areas.map((a) => a.id)).toEqual([other.id]);
  });

  it("answers 409 AREA_HAS_VILLAS too when a villa arrives after the count and the foreign key refuses", async () => {
    const area = addArea({ name: "Raced" });
    areaTables.villaBeforeWrite = () => {
      addVilla({ areaId: area.id });
    };

    const res = await asAdmin("delete", `/${area.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AREA_HAS_VILLAS");
    expect(areaTables.areas).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 for an unknown area, and 400 for a malformed id", async () => {
    expect((await asAdmin("delete", `/${MISSING_ID}`, "ar")).body.code).toBe("AREA_NOT_FOUND");
    expect((await asAdmin("delete", "/nope")).status).toBe(400);
  });

  it("answers 404 when another request deletes it first (P2025)", async () => {
    const area = addArea({ name: "Raced Away" });
    areaTables.removeBeforeWrite = true;

    const res = await asAdmin("delete", `/${area.id}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("AREA_NOT_FOUND");
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the delete back when the audit write fails", async () => {
    const area = addArea({ name: "Keep Me" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("delete", `/${area.id}`);

    expect(res.status).toBe(500);
    expect(areaTables.areas).toHaveLength(1);
  });

  it("lets only the holder of areas:delete delete", async () => {
    const area = addArea({ name: "Target" });

    const denied = await call("delete", `/${area.id}`).set(
      await as(employee("u@example.test", "areas:update", "areas:read")),
    );
    const allowed = await call("delete", `/${area.id}`).set(
      await as(employee("d@example.test", "areas:delete")),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
  });
});

describe("audit trail", () => {
  it("records create, update and delete in order, each with the actor and a request id", async () => {
    const created = await asAdmin("post", "", "en", { name: "One", city: "Cairo" });
    const id = created.body.data.id as string;
    await asAdmin("patch", `/${id}`, "en", { city: "Giza" });
    await asAdmin("delete", `/${id}`);

    expect(auditRows().map((row) => row["action"])).toEqual(["area.create", "area.update", "area.delete"]);
    for (const row of auditRows()) {
      expect(row).toMatchObject({ actorId: admin.id, entity: "Area", entityId: id });
      expect(row["requestId"]).toEqual(expect.any(String));
    }
  });
});
