import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("./in-memory-users.repository.js")).InMemoryUsersRepository,
}));
vi.mock("../../../src/modules/permissions/repository/permissions.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/permissions/repository/permissions.repository.js")
  >()),
  PermissionsRepository: (await import("../permissions/in-memory-permissions.repository.js"))
    .InMemoryPermissionsRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { PERMISSION_CODES } from "../../../src/shared/constants/permissions.js";

const app = createApp();
const ANY_ID = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  permissionTable.reset();
  admin = store.addUser({
    name: "Root Admin",
    email: "root@example.test",
    passwordHash: "x",
    role: "ADMIN",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, name = "Some Employee", overrides: Partial<User> = {}): User {
  return store.addUser({ name, email, passwordHash: "x", ...overrides });
}

function employeeWith(email: string, ...codes: string[]): User {
  const user = employee(email);
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch";
function call(verb: Verb, path: string) {
  return request(app)[verb](`/api/v1${path}`);
}

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "/users", "users:read"],
    ["get", `/users/${ANY_ID}`, "users:read"],
    ["post", "/users", "users:create"],
    ["patch", `/users/${ANY_ID}`, "users:update"],
    ["post", `/users/${ANY_ID}/reset-password`, "users:update"],
    ["patch", `/users/${ANY_ID}/activate`, "users:deactivate"],
    ["patch", `/users/${ANY_ID}/deactivate`, "users:deactivate"],
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

  it.each(endpoints)("%s %s is not opened by a different permission", async (verb, path) => {
    const res = await call(verb, path)
      .set(await as(employeeWith("e@example.test", "villas:read", "users:delete")))
      .send({});

    expect(res.status).toBe(403);
  });

  it.each(endpoints)("%s %s lets through the employee who holds %s", async (verb, path, code) => {
    const res = await call(verb, path)
      .set(await as(employeeWith("e@example.test", code)))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it.each(endpoints)("%s %s lets the ADMIN through with no granted permissions", async (verb, path) => {
    const res = await call(verb, path)
      .set(await as(admin))
      .send({});

    expect([401, 403]).not.toContain(res.status);
  });

  it("checks access before validating, so a caller without it learns nothing from validation errors", async () => {
    const res = await call("post", "/users")
      .set(await as(employee("e@example.test")))
      .send({ nonsense: true });

    expect(res.status).toBe(403);
  });

  it("stops a deactivated user's still-valid access token immediately", async () => {
    const user = employeeWith("e@example.test", "users:read");
    const header = await as(user);
    expect((await call("get", "/users").set(header)).status).toBe(200);

    user.isActive = false;

    expect((await call("get", "/users").set(header)).status).toBe(401);
  });
});

describe("GET /users", () => {
  const at = (iso: string) => new Date(iso);
  beforeEach(() => {
    employee("alice@example.test", "Alice Smith", { createdAt: at("2026-01-02T00:00:00Z") });
    employee("bob@corp.test", "Bob Jones", { createdAt: at("2026-01-03T00:00:00Z"), isActive: false });
    employee("carol@example.test", "Carol Ng", { createdAt: at("2026-01-04T00:00:00Z") });
    employee("dave@example.test", "Dave Smith", { createdAt: at("2026-01-05T00:00:00Z") });
  });

  const list = async (query: string, headers?: { Authorization: string }, language = "en") =>
    call("get", `/users${query}`)
      .set(headers ?? (await as(admin)))
      .set("Accept-Language", language);
  const emails = (res: request.Response): string[] =>
    res.body.data.map((user: { email: string }) => user.email);

  it("returns the newest first with the shared pagination meta, and no password hashes", async () => {
    const res = await list("");

    expect(res.status).toBe(200);
    expect(emails(res)).toEqual([
      "dave@example.test",
      "carol@example.test",
      "bob@corp.test",
      "alice@example.test",
      "root@example.test",
    ]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "isActive",
      "name",
      "role",
      "version",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("pages with limit and page", async () => {
    const second = await list("?limit=2&page=2");

    expect(emails(second)).toEqual(["bob@corp.test", "alice@example.test"]);
    expect(second.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(emails(await list("?limit=2&page=3"))).toEqual(["root@example.test"]);
    expect(emails(await list("?limit=2&page=4"))).toEqual([]);
  });

  it("accepts a limit of 1000 and rejects 1001 with 400 instead of clamping it", async () => {
    expect((await list("?limit=1000")).status).toBe(200);

    const tooMany = await list("?limit=1001");

    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe("VALIDATION_ERROR");
    expect(tooMany.body.details[0].path).toBe("limit");
  });

  it.each(["0", "-1", "abc", "1.5", ""])("rejects limit=%j with 400, in Arabic on request", async (value) => {
    const res = await list(`?limit=${value}`, undefined, "ar");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("فشل التحقق");
  });

  it.each(["0", "-1", "abc"])("rejects page=%j with 400", async (value) => {
    expect((await list(`?page=${value}`)).status).toBe(400);
  });

  it("filters by role", async () => {
    expect(emails(await list("?role=ADMIN"))).toEqual(["root@example.test"]);
    expect((await list("?role=EMPLOYEE")).body.meta.total).toBe(4);

    const bad = await list("?role=BOSS", undefined, "ar");
    expect(bad.status).toBe(400);
    expect(bad.body.details[0]).toEqual({ path: "role", message: "يجب أن يكون الدور ADMIN أو EMPLOYEE" });
  });

  it("filters by isActive", async () => {
    expect(emails(await list("?isActive=false"))).toEqual(["bob@corp.test"]);
    expect((await list("?isActive=true")).body.meta.total).toBe(4);
    expect((await list("?isActive=maybe")).status).toBe(400);
  });

  it("searches name or email, case-insensitively, trimmed", async () => {
    expect(emails(await list("?search=SMITH"))).toEqual(["dave@example.test", "alice@example.test"]);
    expect(emails(await list("?search=CORP.TEST"))).toEqual(["bob@corp.test"]);
    expect(emails(await list("?search=%20%20alice%20"))).toEqual(["alice@example.test"]);
    const none = await list("?search=zzz");
    expect(none.body.data).toEqual([]);
    expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
    expect((await list(`?search=${"x".repeat(101)}`)).status).toBe(400);
  });

  it("combines filters and paging", async () => {
    const res = await list("?search=smith&isActive=true&role=EMPLOYEE&sort=name:desc&limit=1");

    expect(emails(res)).toEqual(["dave@example.test"]);
    expect(res.body.meta.total).toBe(2);
  });

  it.each([
    ["name:asc", ["alice", "bob", "carol", "dave", "root"]],
    ["name:desc", ["root", "dave", "carol", "bob", "alice"]],
    ["name", ["alice", "bob", "carol", "dave", "root"]],
    ["email:asc", ["alice", "bob", "carol", "dave", "root"]],
    ["email:desc", ["root", "dave", "carol", "bob", "alice"]],
    ["createdAt:asc", ["root", "alice", "bob", "carol", "dave"]],
    ["createdAt:desc", ["dave", "carol", "bob", "alice", "root"]],
  ])("sorts by %s", async (sort, expected) => {
    const res = await list(`?sort=${sort}`);

    expect(emails(res).map((email) => email.split("@")[0])).toEqual(expected);
  });

  it("sorts by role", async () => {
    const asc = await list("?sort=role:asc");
    const desc = await list("?sort=role:desc");

    expect(asc.body.data[0].role).toBe("ADMIN");
    expect(desc.body.data.at(-1).role).toBe("ADMIN");
  });

  it.each(["password", "passwordHash:asc", "name:up", "name:asc:x", "id", ":asc"])(
    "rejects sort=%j with 400 and a translated message",
    async (sort) => {
      const res = await list(`?sort=${encodeURIComponent(sort)}`, undefined, "ar");

      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe("sort");
      expect(res.body.details[0].message).toContain("ترتيب غير صالح");
    },
  );

  it("ignores query parameters it does not know", async () => {
    expect((await list("?foo=bar")).status).toBe(200);
  });
});

describe("GET /users/:id", () => {
  it("returns the user with the granted permission codes", async () => {
    const user = employeeWith("e@example.test", "villas:read", "contractors:read");

    const res = await call("get", `/users/${user.id}`).set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: user.id,
      email: "e@example.test",
      role: "EMPLOYEE",
      permissions: ["contractors:read", "villas:read"],
    });
    expect(res.body.data).not.toHaveProperty("passwordHash");
  });

  it("gives the ADMIN every code", async () => {
    const res = await call("get", `/users/${admin.id}`).set(await as(admin));

    expect(res.body.data.permissions).toEqual([...PERMISSION_CODES]);
  });

  it("answers 404 for an unknown id, in Arabic on request", async () => {
    const res = await call("get", `/users/${ANY_ID}`)
      .set(await as(admin))
      .set("Accept-Language", "ar");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "USER_NOT_FOUND", message: "المستخدم غير موجود" });
  });

  it("answers 400 for something that is not an id", async () => {
    const res = await call("get", "/users/not-a-uuid")
      .set(await as(admin))
      .set("Accept-Language", "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "id", message: "معرّف غير صالح" }]);
  });
});

describe("POST /users", () => {
  const body = { name: "New Person", email: "New.Person@Example.TEST", password: "Correct-Horse-9" };
  const create = async (payload: unknown, headers?: { Authorization: string }, language = "en") =>
    call("post", "/users")
      .set(headers ?? (await as(admin)))
      .set("Accept-Language", language)
      .send(payload as object);

  it("creates an active EMPLOYEE with no permissions by default and never returns the hash", async () => {
    const res = await create(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "New Person",
      email: "new.person@example.test",
      role: "EMPLOYEE",
      isActive: true,
      permissions: [],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2b\$/);

    const stored = store.users.find((user) => user.email === "new.person@example.test");
    expect(stored?.passwordHash).not.toBe(body.password);
    expect(bcrypt.getRounds(stored?.passwordHash ?? "")).toBe(12);
    await expect(bcrypt.compare(body.password, stored?.passwordHash ?? "")).resolves.toBe(true);
    expect(store.grants).toEqual([]);
  });

  it("creates the permission rows when codes are given, collapsing repeats", async () => {
    const res = await create({ ...body, permissions: ["users:read", "villas:read", "users:read"] });

    expect(res.status).toBe(201);
    expect(res.body.data.permissions).toEqual(["users:read", "villas:read"]);
    expect(store.grants.map((grant) => grant.code).sort()).toEqual(["users:read", "villas:read"]);
  });

  it("can create the user inactive", async () => {
    const res = await create({ ...body, isActive: false });

    expect(res.body.data.isActive).toBe(false);
  });

  it("writes an audit row in the same transaction, without secrets", async () => {
    const res = await create({ ...body, permissions: ["villas:read"] });

    expect(store.auditRows).toHaveLength(1);
    expect(store.auditRows[0]).toMatchObject({
      action: "user.create",
      entity: "User",
      actorId: admin.id,
      entityId: res.body.data.id,
      after: {
        email: "new.person@example.test",
        role: "EMPLOYEE",
        isActive: true,
        permissions: ["villas:read"],
      },
    });
    expect(JSON.stringify(store.auditRows)).not.toMatch(new RegExp(`${body.password}|passwordHash|\\$2b\\$`));
  });

  it("answers 409 EMAIL_TAKEN for a duplicate, whatever its case, in Arabic on request", async () => {
    employee("new.person@example.test");

    const res = await create(body, undefined, "ar");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "EMAIL_TAKEN", message: "هذا البريد الإلكتروني مسجّل بالفعل" });
    expect(store.users).toHaveLength(2);
  });

  it("rolls the user and its permissions back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create({ ...body, permissions: ["villas:read"] });

    expect(res.status).toBe(500);
    expect(store.users).toHaveLength(1);
    expect(store.grants).toEqual([]);
  });

  it("fails with 500 and writes nothing when a valid code was never seeded", async () => {
    permissionTable.codes = permissionTable.codes.filter((code) => code !== "villas:read");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await create({ ...body, permissions: ["villas:read"] });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(store.users).toHaveLength(1);
    expect(store.auditRows).toHaveLength(0);
  });

  it.each([
    ["a role", { ...body, role: "ADMIN" }],
    ["an unknown field", { ...body, extra: 1 }],
    ["an empty body", {}],
    ["a bad email", { ...body, email: "nope" }],
    ["a short password", { ...body, password: "short" }],
    ["a blank name", { ...body, name: "  " }],
    ["a non-boolean isActive", { ...body, isActive: "yes" }],
    ["permissions that are not a list", { ...body, permissions: "users:read" }],
  ])("rejects %s with 400 and creates nothing", async (_label, payload) => {
    const res = await create(payload);

    expect(res.status).toBe(400);
    expect(store.users).toHaveLength(1);
  });

  it("rejects an unknown permission code with a translated message at the right index", async () => {
    const res = await create({ ...body, permissions: ["villas:read", "villas:fly"] }, undefined, "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "permissions.1", message: "رمز صلاحية غير معروف" }]);
  });

  it("lets an employee with users:create add a user without permissions", async () => {
    const res = await create(body, await as(employeeWith("e@example.test", "users:create")));

    expect(res.status).toBe(201);
    expect(store.auditRows[0]).toMatchObject({ action: "user.create" });
  });

  it("does not let users:create alone hand out permissions, but users:create plus permissions:assign can", async () => {
    const limited = await as(employeeWith("limited@example.test", "users:create"));
    const trusted = await as(employeeWith("trusted@example.test", "users:create", "permissions:assign"));

    const denied = await create({ ...body, permissions: ["users:create"] }, limited, "ar");
    const allowed = await create({ ...body, permissions: ["users:read"] }, trusted);

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("PERMISSION_ASSIGN_REQUIRED");
    expect(allowed.status).toBe(201);
    expect(store.users.filter((user) => user.email === "new.person@example.test")).toHaveLength(1);
  });
});

describe("PATCH /users/:id", () => {
  const patch = async (id: string, payload: unknown, headers?: { Authorization: string }, language = "en") =>
    call("patch", `/users/${id}`)
      .set(headers ?? (await as(admin)))
      .set("Accept-Language", language)
      .send(payload as object);

  it("updates the name and the normalised email, and audits before and after", async () => {
    const user = employee("old@example.test", "Old Name");

    const res = await patch(user.id, { name: "  New Name ", email: " NEW@Example.test " });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: user.id,
      name: "New Name",
      email: "new@example.test",
      role: "EMPLOYEE",
    });
    expect(res.body.data).not.toHaveProperty("passwordHash");
    expect(store.auditRows[0]).toMatchObject({
      action: "user.update",
      actorId: admin.id,
      entityId: user.id,
      before: { name: "Old Name", email: "old@example.test" },
      after: { name: "New Name", email: "new@example.test" },
    });
  });

  it("updates just one field", async () => {
    const user = employee("keep@example.test", "Old Name");

    const res = await patch(user.id, { name: "Only Name" });

    expect(res.body.data).toMatchObject({ name: "Only Name", email: "keep@example.test" });
  });

  it("answers 409 when the email belongs to another user, but not for the user's own email", async () => {
    const user = employee("a@example.test");
    employee("b@example.test");

    const conflict = await patch(user.id, { email: "b@example.test" }, undefined, "ar");
    const own = await patch(user.id, { email: "a@example.test", name: "Same Email" });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("EMAIL_TAKEN");
    expect(store.users.find((candidate) => candidate.id === user.id)?.email).toBe("a@example.test");
    expect(own.status).toBe(200);
  });

  it.each([
    ["role", { role: "ADMIN" }],
    ["isActive", { isActive: false }],
    ["password", { password: "Another-Pass-1" }],
    ["passwordHash", { passwordHash: "x" }],
    ["an empty body", {}],
    ["a blank name", { name: " " }],
  ])("rejects %s with 400 and changes nothing", async (_label, payload) => {
    const user = employee("a@example.test", "Name");

    const res = await patch(user.id, payload);

    expect(res.status).toBe(400);
    expect(store.users.find((candidate) => candidate.id === user.id)).toMatchObject({
      name: "Name",
      role: "EMPLOYEE",
      isActive: true,
      passwordHash: "x",
    });
  });

  it("explains an empty update in the request's language", async () => {
    const res = await patch(employee("a@example.test").id, {}, undefined, "ar");

    expect(res.body.details[0].message).toBe("يجب تقديم حقل واحد على الأقل للتحديث");
  });

  it("answers 404 for an unknown user", async () => {
    expect((await patch(ANY_ID, { name: "X" })).status).toBe(404);
  });

  it("keeps the ADMIN account out of reach of employees, who hold users:update", async () => {
    const editor = await as(employeeWith("editor@example.test", "users:update"));

    const denied = await patch(admin.id, { email: "mine@example.test" }, editor, "ar");
    const byAdmin = await patch(admin.id, { name: "Root" });

    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: "ADMIN_ACCOUNT_PROTECTED",
      message: "لا يمكن إلا للمسؤول تعديل حساب المسؤول",
    });
    expect(store.users.find((user) => user.id === admin.id)?.email).toBe("root@example.test");
    expect(byAdmin.status).toBe(200);
  });

  it("lets an employee with users:update edit another employee", async () => {
    const target = employee("t@example.test");

    const res = await patch(
      target.id,
      { name: "Edited" },
      await as(employeeWith("editor@example.test", "users:update")),
    );

    expect(res.status).toBe(200);
  });

  it("rolls back when the audit write fails", async () => {
    const user = employee("a@example.test", "Name");
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await patch(user.id, { name: "Changed" });

    expect(res.status).toBe(500);
    expect(store.users.find((candidate) => candidate.id === user.id)?.name).toBe("Name");
  });
});

describe("PATCH /users/:id/deactivate and /activate", () => {
  const act = async (
    action: "activate" | "deactivate",
    id: string,
    headers?: { Authorization: string },
    language = "en",
  ) =>
    call("patch", `/users/${id}/${action}`)
      .set(headers ?? (await as(admin)))
      .set("Accept-Language", language);

  function openSession(userId: string): void {
    store.refreshTokens.push({
      id: randomUUID(),
      userId,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      replacedById: null,
      createdAt: new Date(),
    });
  }

  it("deactivates, revokes all of that user's refresh tokens and audits", async () => {
    const user = employee("a@example.test");
    const other = employee("b@example.test");
    openSession(user.id);
    openSession(user.id);
    openSession(other.id);

    const res = await act("deactivate", user.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, isActive: false });
    expect(
      store.refreshTokens.filter((token) => token.userId === user.id).every((token) => token.revokedAt),
    ).toBe(true);
    expect(store.refreshTokens.find((token) => token.userId === other.id)?.revokedAt).toBeNull();
    expect(store.auditRows[0]).toMatchObject({
      action: "user.deactivate",
      actorId: admin.id,
      entityId: user.id,
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  it("locks the user out at once: their access token stops working", async () => {
    const user = employeeWith("a@example.test", "users:read");
    const header = await as(user);

    await act("deactivate", user.id);

    expect((await call("get", "/users").set(header)).status).toBe(401);
  });

  it("refuses to deactivate the ADMIN", async () => {
    const res = await act("deactivate", admin.id, undefined, "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "ADMIN_CANNOT_BE_DEACTIVATED",
      message: "لا يمكن تعطيل حساب المسؤول",
    });
    expect(store.users.find((user) => user.id === admin.id)?.isActive).toBe(true);
  });

  it("refuses to let employees deactivate the ADMIN either", async () => {
    const res = await act(
      "deactivate",
      admin.id,
      await as(employeeWith("e@example.test", "users:deactivate")),
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_CANNOT_BE_DEACTIVATED");
  });

  it("stops users deactivating themselves", async () => {
    const self = employeeWith("self@example.test", "users:deactivate");
    openSession(self.id);

    const res = await act("deactivate", self.id, await as(self), "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "CANNOT_DEACTIVATE_SELF", message: "لا يمكنك تعطيل حسابك الخاص" });
    expect(self.isActive).toBe(true);
    expect(store.refreshTokens[0]?.revokedAt).toBeNull();
  });

  it("lets an employee holding users:deactivate deactivate someone else", async () => {
    const target = employee("t@example.test");

    const res = await act(
      "deactivate",
      target.id,
      await as(employeeWith("e@example.test", "users:deactivate")),
    );

    expect(res.status).toBe(200);
  });

  it("is not opened by users:update alone", async () => {
    const res = await act(
      "deactivate",
      employee("t@example.test").id,
      await as(employeeWith("e@example.test", "users:update")),
    );

    expect(res.status).toBe(403);
  });

  it("activates a deactivated user and audits it", async () => {
    const user = employee("a@example.test", "Name", { isActive: false });

    const res = await act("activate", user.id);

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(store.auditRows[0]).toMatchObject({
      action: "user.activate",
      before: { isActive: false },
      after: { isActive: true },
    });
  });

  it("answers 404 for an unknown user on both actions", async () => {
    expect((await act("activate", ANY_ID)).status).toBe(404);
    expect((await act("deactivate", ANY_ID)).status).toBe(404);
  });

  it("rolls the whole deactivation back when the audit write fails", async () => {
    const user = employee("a@example.test");
    openSession(user.id);
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await act("deactivate", user.id);

    expect(res.status).toBe(500);
    expect(store.users.find((candidate) => candidate.id === user.id)?.isActive).toBe(true);
    expect(store.refreshTokens[0]?.revokedAt).toBeNull();
  });
});

// Deleting users: see users.delete.test.ts.
