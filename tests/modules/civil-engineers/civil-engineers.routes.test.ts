import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, addVillaFor, engineerTables } from "./in-memory-civil-engineers.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock(
  "../../../src/modules/civil-engineers/repository/civil-engineers.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/civil-engineers/repository/civil-engineers.repository.js")
    >()),
    CivilEngineersRepository: (await import("./in-memory-civil-engineers.repository.js"))
      .InMemoryCivilEngineersRepository,
  }),
);

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  engineerTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
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
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1/civil-engineers${path}`);

const asAdmin = async (verb: Verb, path: string, language = "en", body?: unknown) => {
  const req = call(verb, path)
    .set(await as(admin))
    .set("Accept-Language", language);
  return body === undefined ? req : req.send(body as object);
};

const names = (res: request.Response): string[] => res.body.data.map((item: { name: string }) => item.name);
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "", "civil-engineers:read"],
    ["get", "/options", "civil-engineers:read"],
    ["get", `/${MISSING_ID}`, "civil-engineers:read"],
    ["post", "", "civil-engineers:create"],
    ["patch", `/${MISSING_ID}`, "civil-engineers:update"],
    ["delete", `/${MISSING_ID}`, "civil-engineers:delete"],
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
    "%s %s is not opened by the other civil-engineers permissions",
    async (verb, path, needed) => {
      const others = [
        "civil-engineers:read",
        "civil-engineers:create",
        "civil-engineers:update",
        "civil-engineers:delete",
      ]
        .filter((code) => code !== needed)
        .concat("contractors:read", "villas:read");

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

describe("GET /civil-engineers", () => {
  let bob: ReturnType<typeof addEngineer>;
  beforeEach(() => {
    const at = (iso: string) => new Date(iso);
    addEngineer({ name: "Alice Nour", phone: "0100 111 2222", createdAt: at("2026-01-05T00:00:00Z") });
    bob = addEngineer({ name: "Bob Adel", phone: "+20 101 333 4444", createdAt: at("2026-01-03T00:00:00Z") });
    addEngineer({ name: "Carol Samir", phone: "0102-555-6666", createdAt: at("2026-01-04T00:00:00Z") });
    const dina = addEngineer({
      name: "Dina Fouad",
      phone: "0103 777 8888",
      createdAt: at("2026-01-02T00:00:00Z"),
    });
    addEngineer({ name: "Eman Zaki", phone: "0104 999 0000", createdAt: at("2026-01-01T00:00:00Z") });
    addVillaFor(bob.id, 2);
    addVillaFor(dina.id, 1);
  });

  it("returns the engineers by name, with villaCount and the shared pagination meta", async () => {
    const res = await asAdmin("get", "");

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Alice Nour", "Bob Adel", "Carol Samir", "Dina Fouad", "Eman Zaki"]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    expect(res.body.data.map((item: { villaCount: number }) => item.villaCount)).toEqual([0, 2, 0, 1, 0]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["createdAt", "email", "id", "name", "phone", "villaCount", "status", "updatedAt", "version"].sort(),
    );
    expect(res.body.data[0].createdAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("pages with limit and page", async () => {
    const second = await asAdmin("get", "?limit=2&page=2");

    expect(names(second)).toEqual(["Carol Samir", "Dina Fouad"]);
    expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(names(await asAdmin("get", "?limit=2&page=3"))).toEqual(["Eman Zaki"]);
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

  it("searches name or phone, case-insensitively and trimmed", async () => {
    expect(names(await asAdmin("get", "?search=ALICE"))).toEqual(["Alice Nour"]);
    expect(names(await asAdmin("get", "?search=nour"))).toEqual(["Alice Nour"]);
    expect(names(await asAdmin("get", "?search=%20%20bob%20"))).toEqual(["Bob Adel"]);
    expect(names(await asAdmin("get", "?search=0102"))).toEqual(["Carol Samir"]);
    expect(names(await asAdmin("get", "?search=%2B20"))).toEqual(["Bob Adel"]);
    const none = await asAdmin("get", "?search=zzz");
    expect(none.body.data).toEqual([]);
    expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("rejects a search longer than 100 characters", async () => {
    expect((await asAdmin("get", `?search=${"x".repeat(101)}`, "ar")).status).toBe(400);
    expect((await asAdmin("get", `?search=${"x".repeat(100)}`)).status).toBe(200);
  });

  it.each([
    ["name", ["Alice Nour", "Bob Adel", "Carol Samir", "Dina Fouad", "Eman Zaki"]],
    ["name:asc", ["Alice Nour", "Bob Adel", "Carol Samir", "Dina Fouad", "Eman Zaki"]],
    ["name:desc", ["Eman Zaki", "Dina Fouad", "Carol Samir", "Bob Adel", "Alice Nour"]],
    ["createdAt", ["Eman Zaki", "Dina Fouad", "Bob Adel", "Carol Samir", "Alice Nour"]],
    ["createdAt:asc", ["Eman Zaki", "Dina Fouad", "Bob Adel", "Carol Samir", "Alice Nour"]],
    ["createdAt:desc", ["Alice Nour", "Carol Samir", "Bob Adel", "Dina Fouad", "Eman Zaki"]],
  ])("sorts by %s", async (sort, expected) => {
    expect(names(await asAdmin("get", `?sort=${sort}`))).toEqual(expected);
  });

  it("combines search, sort and paging", async () => {
    const res = await asAdmin("get", "?search=a&sort=name:desc&limit=2");

    expect(names(res)).toEqual(["Eman Zaki", "Dina Fouad"]);
    expect(res.body.meta.total).toBe(5);
  });

  it.each(["phone", "id:asc", "villaCount", "name:up", "name:asc:x", ":asc"])(
    "rejects sort=%j with 400 and a translated message",
    async (sort) => {
      const res = await asAdmin("get", `?sort=${encodeURIComponent(sort)}`, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("sort");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    },
  );

  it("ignores query parameters it does not know", async () => {
    expect((await asAdmin("get", "?foo=bar")).status).toBe(200);
  });
});

describe("GET /civil-engineers/options", () => {
  it("is not mistaken for an id, and is empty when there are no engineers", async () => {
    const res = await asAdmin("get", "/options");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns only id and name, sorted by name, with every engineer", async () => {
    const zed = addEngineer({ name: "Zed" });
    const amy = addEngineer({ name: "Amy" });
    const mid = addEngineer({ name: "Mid" });

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toEqual([
      { id: amy.id, name: "Amy" },
      { id: mid.id, name: "Mid" },
      { id: zed.id, name: "Zed" },
    ]);
    expect(res.body).not.toHaveProperty("meta");
    expect(JSON.stringify(res.body)).not.toMatch(/phone|must not leak/);
  });

  it("returns at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++) {
      addEngineer({ name: `Engineer ${String(i).padStart(4, "0")}` });
    }

    const res = await asAdmin("get", "/options");

    expect(res.body.data).toHaveLength(1000);
    expect(res.body.data[0].name).toBe("Engineer 0000");
    expect(res.body.data[999].name).toBe("Engineer 0999");
  });
});

describe("GET /civil-engineers/:id", () => {
  it("returns the engineer in the same shape as the list", async () => {
    const eng = addEngineer({ name: "Mona Hassan", phone: "0100 123 4567" });
    addVillaFor(eng.id, 3);

    const res = await asAdmin("get", `/${eng.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: eng.id,
      name: "Mona Hassan",
      phone: "0100 123 4567",
      villaCount: 3,
    });
  });

  it("answers 404 CIVIL_ENGINEER_NOT_FOUND in Arabic on request", async () => {
    const res = await asAdmin("get", `/${MISSING_ID}`, "ar");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "CIVIL_ENGINEER_NOT_FOUND", message: "المهندس المدني غير موجود" });
  });

  it("answers 400 for something that is not an id", async () => {
    const res = await asAdmin("get", "/not-a-uuid", "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("POST /civil-engineers", () => {
  const body = { name: "Mona Hassan", phone: "0100 123 4567" };

  it("creates the engineer with villaCount 0, trimming the input", async () => {
    const res = await asAdmin("post", "", "en", { name: "  Mona Hassan  ", phone: "  +20 100-123 4567 " });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Mona Hassan", phone: "+20 100-123 4567", villaCount: 0 });
    expect(res.body.data.createdAt).toMatch(/Z$/);
    expect(engineerTables.engineers).toHaveLength(1);
    expect(engineerTables.engineers[0]).toMatchObject({ name: "Mona Hassan", phone: "+20 100-123 4567" });
  });

  it("allows two engineers with the same name", async () => {
    const first = await asAdmin("post", "", "en", body);
    const second = await asAdmin("post", "", "en", body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.id).not.toBe(second.body.data.id);
    expect(engineerTables.engineers).toHaveLength(2);
  });

  it("writes an audit row in the same transaction", async () => {
    const res = await asAdmin("post", "", "en", body);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "civil_engineer.create",
      entity: "CivilEngineer",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: { name: "Mona Hassan", phone: "0100 123 4567" },
      requestId: expect.any(String),
    });
    expect(auditRows()[0]).not.toHaveProperty("before");
  });

  it("rolls the engineer back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("post", "", "en", body);

    expect(res.status).toBe(500);
    expect(engineerTables.engineers).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("lets an employee with civil-engineers:create add one", async () => {
    const res = await call("post", "")
      .set(await as(employee("e@example.test", "civil-engineers:create")))
      .send(body);

    expect(res.status).toBe(201);
    expect(auditRows()[0]).toMatchObject({ actorId: expect.not.stringMatching(admin.id) });
  });

  it.each([
    ["no body", {}],
    ["a missing name", { phone: "0100 123 4567" }],
    ["a missing phone", { name: "Mona" }],
    ["a blank name", { name: "   ", phone: "0100 123 4567" }],
    ["a 101-character name", { name: "x".repeat(101), phone: "0100 123 4567" }],
    ["a phone that is too short", { name: "Mona", phone: "1234" }],
    ["a phone that is too long", { name: "Mona", phone: "1".repeat(21) }],
    ["a phone with letters", { name: "Mona", phone: "0100 abc 4567" }],
    ["a phone with two plus signs", { name: "Mona", phone: "++201001234567" }],
    ["a phone with a plus in the middle", { name: "Mona", phone: "0100+1234567" }],
    ["a phone that is only spaces", { name: "Mona", phone: "          " }],
    ["a phone that is not a string", { name: "Mona", phone: 1001234567 }],
    ["an unknown field", { ...body, villaCount: 5 }],
    ["an id", { ...body, id: MISSING_ID }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await asAdmin("post", "", "en", payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(engineerTables.engineers).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("explains each problem in Arabic, once per field", async () => {
    const res = await asAdmin("post", "", "ar", { name: " ", phone: "12" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("فشل التحقق");
    expect(res.body.details).toEqual([
      { path: "name", message: "الاسم مطلوب" },
      {
        path: "phone",
        message:
          "أدخل رقم هاتف صالحًا: من 5 إلى 20 حرفًا، أرقام مع علامة + اختيارية في البداية ومسافات أو شرطات",
      },
    ]);
  });

  it("says a missing field is required, in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { name: "Mona" });

    expect(res.body.details).toEqual([{ path: "phone", message: "هذا الحقل مطلوب" }]);
  });
});

describe("PATCH /civil-engineers/:id", () => {
  it("updates the name, the phone, or both, and audits before and after", async () => {
    const eng = addEngineer({ name: "Old Name", phone: "0100 111 2222" });

    const both = await asAdmin("patch", `/${eng.id}`, "en", { name: " New Name ", phone: "0100 999 8888" });
    const nameOnly = await asAdmin("patch", `/${eng.id}`, "en", { name: "Newer Name" });
    const phoneOnly = await asAdmin("patch", `/${eng.id}`, "en", { phone: "0100 000 1111" });

    expect(both.body.data).toMatchObject({ name: "New Name", phone: "0100 999 8888" });
    expect(nameOnly.body.data).toMatchObject({ name: "Newer Name", phone: "0100 999 8888" });
    expect(phoneOnly.body.data).toMatchObject({ name: "Newer Name", phone: "0100 000 1111" });
    expect(auditRows()).toHaveLength(3);
    expect(auditRows()[0]).toMatchObject({
      action: "civil_engineer.update",
      entity: "CivilEngineer",
      actorId: admin.id,
      entityId: eng.id,
      before: { name: "Old Name", phone: "0100 111 2222" },
      after: { name: "New Name", phone: "0100 999 8888" },
    });
  });

  it("returns villaCount with the updated engineer", async () => {
    const eng = addEngineer({ name: "Busy" });
    addVillaFor(eng.id, 4);

    const res = await asAdmin("patch", `/${eng.id}`, "en", { name: "Still Busy" });

    expect(res.body.data.villaCount).toBe(4);
  });

  it.each([
    ["an empty body", {}],
    ["an unknown field", { name: "N", villaCount: 9 }],
    ["an id", { id: MISSING_ID }],
    ["a blank name", { name: " " }],
    ["a bad phone", { phone: "abc" }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const eng = addEngineer({ name: "Keep", phone: "0100 111 2222" });

    const res = await asAdmin("patch", `/${eng.id}`, "en", payload);

    expect(res.status).toBe(400);
    expect(engineerTables.engineers[0]).toMatchObject({ name: "Keep", phone: "0100 111 2222" });
    expect(auditRows()).toHaveLength(0);
  });

  it("explains an empty update in Arabic", async () => {
    const eng = addEngineer({ name: "Keep" });

    const res = await asAdmin("patch", `/${eng.id}`, "ar", {});

    expect(res.body.details[0].message).toBe("يجب تقديم حقل واحد على الأقل للتحديث");
  });

  it("answers 404 for an unknown engineer, and 400 for a malformed id", async () => {
    expect((await asAdmin("patch", `/${MISSING_ID}`, "en", { name: "N" })).status).toBe(404);
    expect((await asAdmin("patch", "/nope", "en", { name: "N" })).status).toBe(400);
  });

  it("answers 404 when the engineer is deleted by someone else mid-request (P2025)", async () => {
    const eng = addEngineer({ name: "Gone Soon" });
    engineerTables.removeBeforeWrite = true;

    const res = await asAdmin("patch", `/${eng.id}`, "ar", { name: "Too Late" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "CIVIL_ENGINEER_NOT_FOUND", message: "المهندس المدني غير موجود" });
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the change back when the audit write fails", async () => {
    const eng = addEngineer({ name: "Keep", phone: "0100 111 2222" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("patch", `/${eng.id}`, "en", { name: "Changed" });

    expect(res.status).toBe(500);
    expect(engineerTables.engineers[0]).toMatchObject({ name: "Keep", phone: "0100 111 2222" });
  });

  it("lets only the holder of civil-engineers:update change an engineer", async () => {
    const eng = addEngineer({ name: "Target" });

    const denied = await call("patch", `/${eng.id}`)
      .set(await as(employee("r@example.test", "civil-engineers:read", "civil-engineers:create")))
      .send({ name: "X" });
    const allowed = await call("patch", `/${eng.id}`)
      .set(await as(employee("u@example.test", "civil-engineers:update")))
      .send({ name: "Y" });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });
});

describe("DELETE /civil-engineers/:id", () => {
  it("deletes with 204 and no body, and audits the deleted values", async () => {
    const eng = addEngineer({ name: "Mona Hassan", phone: "0100 123 4567" });

    const res = await asAdmin("delete", `/${eng.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(engineerTables.engineers).toHaveLength(0);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "civil_engineer.delete",
      entity: "CivilEngineer",
      actorId: admin.id,
      entityId: eng.id,
      before: { name: "Mona Hassan", phone: "0100 123 4567" },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("is blocked with 409 CIVIL_ENGINEER_HAS_VILLAS while a villa references it, in Arabic on request", async () => {
    const eng = addEngineer({ name: "Busy" });
    addVillaFor(eng.id);

    const res = await asAdmin("delete", `/${eng.id}`, "ar");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "CIVIL_ENGINEER_HAS_VILLAS",
      message: "هذا المهندس المدني مرتبط بفلل ولا يمكن حذفه",
    });
    expect(engineerTables.engineers).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("only blocks the engineer that has villas", async () => {
    const busy = addEngineer({ name: "Busy" });
    const free = addEngineer({ name: "Free" });
    addVillaFor(busy.id);

    expect((await asAdmin("delete", `/${free.id}`)).status).toBe(204);
    expect((await asAdmin("delete", `/${busy.id}`)).status).toBe(409);
    expect(engineerTables.engineers.map((e) => e.name)).toEqual(["Busy"]);
  });

  it("answers 404 for an unknown engineer, and 400 for a malformed id", async () => {
    expect((await asAdmin("delete", `/${MISSING_ID}`, "ar")).body.code).toBe("CIVIL_ENGINEER_NOT_FOUND");
    expect((await asAdmin("delete", "/nope")).status).toBe(400);
  });

  it("answers 409 when a villa is linked after the check but before the delete (foreign key, P2003)", async () => {
    const eng = addEngineer({ name: "Race" });
    engineerTables.linkVillaBeforeDelete = true;

    const res = await asAdmin("delete", `/${eng.id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CIVIL_ENGINEER_HAS_VILLAS");
    expect(engineerTables.engineers).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 when another request deletes it first (P2025)", async () => {
    const eng = addEngineer({ name: "Raced Away" });
    engineerTables.removeBeforeWrite = true;

    const res = await asAdmin("delete", `/${eng.id}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CIVIL_ENGINEER_NOT_FOUND");
    expect(auditRows()).toHaveLength(0);
  });

  it("rolls the delete back when the audit write fails", async () => {
    const eng = addEngineer({ name: "Keep Me" });
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await asAdmin("delete", `/${eng.id}`);

    expect(res.status).toBe(500);
    expect(engineerTables.engineers).toHaveLength(1);
  });

  it("lets only the holder of civil-engineers:delete delete", async () => {
    const eng = addEngineer({ name: "Target" });

    const denied = await call("delete", `/${eng.id}`).set(
      await as(employee("u@example.test", "civil-engineers:update", "civil-engineers:read")),
    );
    const allowed = await call("delete", `/${eng.id}`).set(
      await as(employee("d@example.test", "civil-engineers:delete")),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
  });
});

describe("audit trail", () => {
  it("records create, update and delete in order, each with the actor and a request id", async () => {
    const created = await asAdmin("post", "", "en", { name: "Mona", phone: "0100 123 4567" });
    const id = created.body.data.id as string;
    await asAdmin("patch", `/${id}`, "en", { phone: "0100 999 8888" });
    await asAdmin("delete", `/${id}`);

    expect(auditRows().map((row) => row["action"])).toEqual([
      "civil_engineer.create",
      "civil_engineer.update",
      "civil_engineer.delete",
    ]);
    for (const row of auditRows()) {
      expect(row).toMatchObject({ actorId: admin.id, entity: "CivilEngineer", entityId: id });
      expect(row["requestId"]).toEqual(expect.any(String));
    }
  });
});

describe("email and status", () => {
  const body = { name: "Mona Hassan", phone: "0100 123 4567" };
  const detailsOf = (res: request.Response): { path: string; message: string }[] => res.body.details;

  it("create: with neither, the email is null and the status ACTIVE; the response and the row say so", async () => {
    const res = await asAdmin("post", "", "en", body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: null, status: "ACTIVE" });
    expect(engineerTables.engineers[0]).toMatchObject({ email: null, status: "ACTIVE" });
    expect(auditRows()[0]).toMatchObject({ after: { email: null, status: "ACTIVE" } });
  });

  it("create: trims and lowercases the email, keeps the status, and audits both", async () => {
    const res = await asAdmin("post", "", "en", {
      ...body,
      email: "  Mona.Hassan@Example.TEST ",
      status: "INACTIVE",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: "mona.hassan@example.test", status: "INACTIVE" });
    expect(engineerTables.engineers[0]).toMatchObject({
      email: "mona.hassan@example.test",
      status: "INACTIVE",
    });
    expect(auditRows()[0]).toMatchObject({
      action: "civil_engineer.create",
      after: {
        name: "Mona Hassan",
        phone: "0100 123 4567",
        email: "mona.hassan@example.test",
        status: "INACTIVE",
      },
    });
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["null", null],
  ])("create: a %s email means none", async (_label, email) => {
    const res = await asAdmin("post", "", "en", { ...body, email });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBeNull();
    expect(engineerTables.engineers[0]?.email).toBeNull();
  });

  it("create: two records may share an email", async () => {
    const first = await asAdmin("post", "", "en", { ...body, email: "shared@example.test" });
    const second = await asAdmin("post", "", "en", { ...body, email: "SHARED@example.test" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(engineerTables.engineers.map((r) => r.email)).toEqual([
      "shared@example.test",
      "shared@example.test",
    ]);
  });

  it.each([
    { label: "no @", email: "not-an-email" },
    { label: "no domain suffix", email: "a@b" },
    { label: "two @", email: "two@@example.test" },
    { label: "a space", email: "spaces in@example.test" },
    { label: "over 254 characters", email: `${"x".repeat(250)}@e.test` },
  ])(
    "create: refuses an email with $label with 400, creates nothing, and explains it in Arabic",
    async ({ email }) => {
      const res = await asAdmin("post", "", "ar", { ...body, email });

      expect(res.status).toBe(400);
      expect(detailsOf(res)).toHaveLength(1);
      expect(detailsOf(res)[0]).toMatchObject({ path: "email" });
      expect(engineerTables.engineers).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("create: says why in each language", async () => {
    const en = await asAdmin("post", "", "en", { ...body, email: "nope" });
    const ar = await asAdmin("post", "", "ar", { ...body, email: "nope" });

    expect(detailsOf(en)[0]?.message).toBe("Enter a valid email address");
    expect(detailsOf(ar)[0]?.message).toBe("أدخل بريدًا إلكترونيًا صالحًا");
  });

  it.each(["active", "PAUSED", "", null, 1])("create: refuses the status %j with 400", async (status) => {
    const res = await asAdmin("post", "", "en", { ...body, status });

    expect(res.status).toBe(400);
    expect(detailsOf(res)[0]).toMatchObject({ path: "status", message: "Status must be ACTIVE or INACTIVE" });
    expect(engineerTables.engineers).toHaveLength(0);
  });

  it("create: says the status is wrong in Arabic", async () => {
    const res = await asAdmin("post", "", "ar", { ...body, status: "PAUSED" });

    expect(detailsOf(res)[0]?.message).toBe("يجب أن تكون الحالة ACTIVE أو INACTIVE");
  });

  it("update: sets the email, changes the status, and audits before and after", async () => {
    const rec = addEngineer({ name: "Keep", phone: "0100 111 2222" });

    const res = await asAdmin("patch", `/${rec.id}`, "en", {
      email: " Keep@Example.test ",
      status: "INACTIVE",
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: "Keep",
      phone: "0100 111 2222",
      email: "keep@example.test",
      status: "INACTIVE",
    });
    expect(auditRows()[0]).toMatchObject({
      action: "civil_engineer.update",
      before: { name: "Keep", phone: "0100 111 2222", email: null, status: "ACTIVE" },
      after: { name: "Keep", phone: "0100 111 2222", email: "keep@example.test", status: "INACTIVE" },
    });
  });

  it.each([
    ["null", null],
    ["blank", "  "],
  ])("update: a %s email clears it and leaves the rest alone", async (_label, email) => {
    const rec = addEngineer({ name: "Keep", email: "old@example.test", status: "INACTIVE" });

    const res = await asAdmin("patch", `/${rec.id}`, "en", { email });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Keep", email: null, status: "INACTIVE" });
    expect(auditRows()[0]).toMatchObject({
      before: { email: "old@example.test", status: "INACTIVE" },
      after: { email: null, status: "INACTIVE" },
    });
  });

  it("update: an email or a status alone is a valid update; a name alone leaves them untouched", async () => {
    const rec = addEngineer({ name: "Keep", email: "keep@example.test", status: "INACTIVE" });

    const nameOnly = await asAdmin("patch", `/${rec.id}`, "en", { name: "Renamed" });
    const statusOnly = await asAdmin("patch", `/${rec.id}`, "en", { status: "ACTIVE" });

    expect(nameOnly.body.data).toMatchObject({
      name: "Renamed",
      email: "keep@example.test",
      status: "INACTIVE",
    });
    expect(statusOnly.body.data).toMatchObject({
      name: "Renamed",
      email: "keep@example.test",
      status: "ACTIVE",
    });
  });

  it("update: refuses a malformed email or an unknown status with 400 and changes nothing", async () => {
    const rec = addEngineer({ name: "Keep", email: "keep@example.test" });

    const badEmail = await asAdmin("patch", `/${rec.id}`, "en", { email: "nope" });
    const badStatus = await asAdmin("patch", `/${rec.id}`, "en", { status: "PAUSED" });

    expect(badEmail.status).toBe(400);
    expect(badStatus.status).toBe(400);
    expect(engineerTables.engineers[0]).toMatchObject({
      email: "keep@example.test",
      status: "ACTIVE",
      version: 1,
    });
    expect(auditRows()).toHaveLength(0);
  });

  it("update: bumps the version, and a stale version is still refused", async () => {
    const rec = addEngineer({ name: "Keep" });

    const first = await asAdmin("patch", `/${rec.id}`, "en", { status: "INACTIVE" });
    const stale = await call("patch", `/${rec.id}`)
      .set(await as(admin))
      .set("If-Match", "1")
      .send({ status: "ACTIVE" });

    expect(first.body.data.version).toBe(2);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect(engineerTables.engineers[0]?.status).toBe("INACTIVE");
  });

  it("get: one record carries its email and status", async () => {
    const rec = addEngineer({ name: "Keep", email: "keep@example.test", status: "INACTIVE" });

    const res = await asAdmin("get", `/${rec.id}`);

    expect(res.body.data).toMatchObject({ email: "keep@example.test", status: "INACTIVE" });
  });

  describe("list", () => {
    beforeEach(() => {
      addEngineer({ name: "Alice Nour", phone: "0100 111 2222", email: "alice@acme.test" });
      addEngineer({ name: "Bob Adel", phone: "0101 333 4444", email: "bob@other.test", status: "INACTIVE" });
      addEngineer({ name: "Carol Samir", phone: "0102 555 6666", status: "INACTIVE" });
      addEngineer({ name: "Dina Fouad", phone: "0103 777 8888", email: "dina@acme.test" });
    });

    it("shows every record by default, active and inactive, with their email and status", async () => {
      const res = await asAdmin("get", "");

      expect(names(res)).toEqual(["Alice Nour", "Bob Adel", "Carol Samir", "Dina Fouad"]);
      expect(res.body.data.map((i: { status: string }) => i.status)).toEqual([
        "ACTIVE",
        "INACTIVE",
        "INACTIVE",
        "ACTIVE",
      ]);
      expect(res.body.data.map((i: { email: string | null }) => i.email)).toEqual([
        "alice@acme.test",
        "bob@other.test",
        null,
        "dina@acme.test",
      ]);
    });

    it("filters by status and counts only the matches in the meta", async () => {
      const inactive = await asAdmin("get", "?status=INACTIVE");
      const active = await asAdmin("get", "?status=ACTIVE");

      expect(names(inactive)).toEqual(["Bob Adel", "Carol Samir"]);
      expect(inactive.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(names(active)).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(active.body.meta.total).toBe(2);
    });

    it("searches the email as well as the name and the phone, case-insensitively", async () => {
      expect(names(await asAdmin("get", "?search=ACME"))).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(names(await asAdmin("get", "?search=bob@other"))).toEqual(["Bob Adel"]);
      expect(names(await asAdmin("get", "?search=nour"))).toEqual(["Alice Nour"]);
      expect(names(await asAdmin("get", "?search=0102"))).toEqual(["Carol Samir"]);
    });

    it("combines the status filter with the search, and with paging", async () => {
      expect(names(await asAdmin("get", "?status=ACTIVE&search=acme"))).toEqual(["Alice Nour", "Dina Fouad"]);
      expect(names(await asAdmin("get", "?status=INACTIVE&search=acme"))).toEqual([]);
      const paged = await asAdmin("get", "?status=INACTIVE&limit=1&page=2");
      expect(names(paged)).toEqual(["Carol Samir"]);
      expect(paged.body.meta).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    });

    it.each(["active", "PAUSED", "OPEN", ""])(
      "rejects status=%j with 400, in Arabic on request",
      async (value) => {
        const res = await asAdmin("get", `?status=${value}`, "ar");

        expect(res.status).toBe(400);
        expect(detailsOf(res)[0]).toMatchObject({
          path: "status",
          message: "يجب أن تكون الحالة ACTIVE أو INACTIVE",
        });
      },
    );
  });

  describe("options", () => {
    it("leaves out the inactive records, and brings one back when it is reactivated", async () => {
      const amy = addEngineer({ name: "Amy" });
      const bea = addEngineer({ name: "Bea", status: "INACTIVE" });
      const cal = addEngineer({ name: "Cal" });

      const before = await asAdmin("get", "/options");
      await asAdmin("patch", `/${bea.id}`, "en", { status: "ACTIVE" });
      await asAdmin("patch", `/${amy.id}`, "en", { status: "INACTIVE" });
      const after = await asAdmin("get", "/options");

      expect(before.body.data).toEqual([
        { id: amy.id, name: "Amy" },
        { id: cal.id, name: "Cal" },
      ]);
      expect(after.body.data).toEqual([
        { id: bea.id, name: "Bea" },
        { id: cal.id, name: "Cal" },
      ]);
      expect(JSON.stringify(before.body)).not.toMatch(/email|status/);
    });

    it("is empty when every record is inactive", async () => {
      addEngineer({ name: "Amy", status: "INACTIVE" });

      expect((await asAdmin("get", "/options")).body.data).toEqual([]);
    });
  });

  it("an inactive record can still be read, updated and deleted", async () => {
    const rec = addEngineer({ name: "Old", status: "INACTIVE" });

    const read = await asAdmin("get", `/${rec.id}`);
    const renamed = await asAdmin("patch", `/${rec.id}`, "en", { name: "Older" });
    const removed = await asAdmin("delete", `/${rec.id}`);

    expect(read.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: "Older", status: "INACTIVE" });
    expect(removed.status).toBe(204);
  });

  it("permissions are unchanged: reading needs read, writing the new fields needs update", async () => {
    const rec = addEngineer({ name: "Keep" });

    const reader = await call("get", `/${rec.id}`).set(
      await as(employee("r@example.test", "civil-engineers:read")),
    );
    const readerPatch = await call("patch", `/${rec.id}`)
      .set(await as(employee("r2@example.test", "civil-engineers:read")))
      .send({ status: "INACTIVE" });
    const updater = await call("patch", `/${rec.id}`)
      .set(await as(employee("u@example.test", "civil-engineers:update")))
      .send({ email: "u@example.test" });

    expect(reader.status).toBe(200);
    expect(reader.body.data).toMatchObject({ email: null, status: "ACTIVE" });
    expect(readerPatch.status).toBe(403);
    expect(updater.status).toBe(200);
  });
});
