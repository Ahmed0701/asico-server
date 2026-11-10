import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { permissionTable } from "./in-memory-permissions.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("../users/in-memory-users.repository.js")).InMemoryUsersRepository,
}));
vi.mock("../../../src/modules/permissions/repository/permissions.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/permissions/repository/permissions.repository.js")
  >()),
  PermissionsRepository: (await import("./in-memory-permissions.repository.js"))
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

const codesOf = (user: User): string[] =>
  store.grants
    .filter((grant) => grant.userId === user.id)
    .map((grant) => grant.code)
    .sort();

type Verb = "get" | "put";
const call = (verb: Verb, path: string) => request(app)[verb](`/api/v1${path}`);

describe("access control", () => {
  const endpoints: [Verb, string][] = [
    ["get", "/permissions"],
    ["get", `/users/${ANY_ID}/permissions`],
    ["put", `/users/${ANY_ID}/permissions`],
  ];

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path).send({});

    expect(res.status).toBe(401);
  });

  it.each(endpoints)(
    "%s %s answers 403 to an employee without permissions:assign, in Arabic",
    async (verb, path) => {
      const res = await call(verb, path)
        .set(await as(employee("e@example.test", "users:read", "users:update", "users:create")))
        .set("Accept-Language", "ar")
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)(
    "%s %s lets through the holder of permissions:assign and the ADMIN",
    async (verb, path) => {
      const holder = await call(verb, path)
        .set(await as(employee("e@example.test", "permissions:assign")))
        .send({});
      const root = await call(verb, path)
        .set(await as(admin))
        .send({});

      expect([401, 403]).not.toContain(holder.status);
      expect([401, 403]).not.toContain(root.status);
    },
  );
});

describe("GET /permissions", () => {
  it("lists every code grouped by resource", async () => {
    const res = await call("get", "/permissions").set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.map((group: { resource: string }) => group.resource)).toEqual([
      "areas",
      "audit",
      "civil-engineers",
      "contractors",
      "daily-labour",
      "daily-reports",
      "dashboard",
      "elec-phases",
      "electrical-engineers",
      "maintenance",
      "materials",
      "open-works",
      "permissions",
      "site-reports",
      "small-works",
      "users",
      "villa-documents",
      "villas",
    ]);
    const villas = res.body.data.find((group: { resource: string }) => group.resource === "villas");
    expect(villas.permissions).toEqual([
      "villas:create",
      "villas:delete",
      "villas:detail",
      "villas:export",
      "villas:import",
      "villas:inspection",
      "villas:progress",
      "villas:read",
      "villas:update",
    ]);
    expect(res.body.data.flatMap((group: { permissions: string[] }) => group.permissions).sort()).toEqual(
      [...PERMISSION_CODES].sort(),
    );
  });

  it("reflects what is in the database", async () => {
    permissionTable.codes = ["villas:read", "users:read"];

    const res = await call("get", "/permissions").set(await as(admin));

    expect(res.body.data).toEqual([
      { resource: "users", permissions: ["users:read"] },
      { resource: "villas", permissions: ["villas:read"] },
    ]);
  });
});

describe("GET /users/:id/permissions", () => {
  it("returns the user's codes", async () => {
    const user = employee("e@example.test", "users:read", "villas:read");

    const res = await call("get", `/users/${user.id}/permissions`).set(await as(admin));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ userId: user.id, permissions: ["users:read", "villas:read"] });
  });

  it("returns every code for the ADMIN", async () => {
    const res = await call("get", `/users/${admin.id}/permissions`).set(await as(admin));

    expect(res.body.data.permissions).toEqual([...PERMISSION_CODES]);
  });

  it("returns an empty list for a user with none", async () => {
    const res = await call("get", `/users/${employee("e@example.test").id}/permissions`).set(await as(admin));

    expect(res.body.data.permissions).toEqual([]);
  });

  it("answers 404 for an unknown user and 400 for a malformed id, in Arabic on request", async () => {
    const missing = await call("get", `/users/${ANY_ID}/permissions`)
      .set(await as(admin))
      .set("Accept-Language", "ar");
    const malformed = await call("get", "/users/nope/permissions")
      .set(await as(admin))
      .set("Accept-Language", "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "USER_NOT_FOUND", message: "المستخدم غير موجود" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.details[0].message).toBe("معرّف غير صالح");
  });
});

describe("PUT /users/:id/permissions", () => {
  const put = async (id: string, payload: unknown, headers?: { Authorization: string }, language = "en") =>
    call("put", `/users/${id}/permissions`)
      .set(headers ?? (await as(admin)))
      .set("Accept-Language", language)
      .send(payload as object);

  it("replaces the whole set: adds the new, removes the missing, keeps the rest", async () => {
    const user = employee("e@example.test", "villas:read", "users:read");

    const res = await put(user.id, { permissions: ["users:read", "contractors:read", "audit:read"] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      userId: user.id,
      permissions: ["audit:read", "contractors:read", "users:read"],
    });
    expect(codesOf(user)).toEqual(["audit:read", "contractors:read", "users:read"]);
  });

  it("clears everything with an empty list, and collapses repeated codes", async () => {
    const user = employee("e@example.test", "villas:read");

    const repeated = await put(user.id, { permissions: ["users:read", "users:read"] });
    const cleared = await put(user.id, { permissions: [] });

    expect(repeated.body.data.permissions).toEqual(["users:read"]);
    expect(cleared.body.data.permissions).toEqual([]);
    expect(codesOf(user)).toEqual([]);
  });

  it("only touches the target user", async () => {
    const target = employee("t@example.test", "villas:read");
    const bystander = employee("b@example.test", "villas:read", "users:read");

    await put(target.id, { permissions: [] });

    expect(codesOf(bystander)).toEqual(["users:read", "villas:read"]);
  });

  it("audits the codes before and after in the same transaction", async () => {
    const user = employee("e@example.test", "villas:read");

    await put(user.id, { permissions: ["users:read"] });

    expect(store.auditRows).toHaveLength(1);
    expect(store.auditRows[0]).toMatchObject({
      action: "user.permissions_replaced",
      entity: "User",
      actorId: admin.id,
      entityId: user.id,
      before: { permissions: ["villas:read"] },
      after: { permissions: ["users:read"] },
    });
  });

  it("rejects an unknown code with a translated message, and changes nothing", async () => {
    const user = employee("e@example.test", "villas:read");

    const res = await put(user.id, { permissions: ["users:read", "users:fly"] }, undefined, "ar");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ path: "permissions.1", message: "رمز صلاحية غير معروف" }]);
    expect(codesOf(user)).toEqual(["villas:read"]);
    expect(store.auditRows).toHaveLength(0);
  });

  it.each([
    ["a missing list", {}],
    ["a string instead of a list", { permissions: "users:read" }],
    ["non-string entries", { permissions: [1, null] }],
    ["an unknown field", { permissions: [], role: "ADMIN" }],
    ["no body", undefined],
  ])("rejects %s with 400", async (_label, payload) => {
    const user = employee("e@example.test", "villas:read");

    const res = await put(user.id, payload);

    expect(res.status).toBe(400);
    expect(codesOf(user)).toEqual(["villas:read"]);
  });

  it("answers 404 for an unknown user", async () => {
    expect((await put(ANY_ID, { permissions: [] })).status).toBe(404);
  });

  it("refuses to change the ADMIN's permissions, whoever asks", async () => {
    const holder = await as(employee("e@example.test", "permissions:assign"));

    const byEmployee = await put(admin.id, { permissions: [] }, holder, "ar");
    const byAdmin = await put(admin.id, { permissions: [] });

    expect(byEmployee.status).toBe(403);
    expect(byEmployee.body).toMatchObject({
      code: "ADMIN_PERMISSIONS_IMMUTABLE",
      message: "لا يمكن تغيير صلاحيات المسؤول",
    });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.code).toBe("ADMIN_PERMISSIONS_IMMUTABLE");
    expect(store.grants.filter((grant) => grant.userId === admin.id)).toEqual([]);
  });

  it("stops an employee granting themselves more", async () => {
    const holder = employee("e@example.test", "permissions:assign");

    const res = await put(holder.id, { permissions: PERMISSION_CODES }, await as(holder), "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "CANNOT_MODIFY_OWN_PERMISSIONS",
      message: "لا يمكنك تغيير صلاحياتك الخاصة",
    });
    expect(codesOf(holder)).toEqual(["permissions:assign"]);
  });

  it("lets an employee holding permissions:assign set someone else's permissions", async () => {
    const holder = employee("holder@example.test", "permissions:assign");
    const target = employee("t@example.test");

    const res = await put(target.id, { permissions: ["villas:read"] }, await as(holder));

    expect(res.status).toBe(200);
    expect(codesOf(target)).toEqual(["villas:read"]);
  });

  it("rolls the change back when the audit write fails", async () => {
    const user = employee("e@example.test", "villas:read");
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await put(user.id, { permissions: ["users:read"] });

    expect(res.status).toBe(500);
    expect(codesOf(user)).toEqual(["villas:read"]);
  });

  it("fails with 500 and keeps the old set when a valid code was never seeded", async () => {
    const user = employee("e@example.test", "villas:read");
    permissionTable.codes = permissionTable.codes.filter((code) => code !== "users:read");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await put(user.id, { permissions: ["users:read"] });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(codesOf(user)).toEqual(["villas:read"]);
    expect(store.auditRows).toHaveLength(0);
  });

  it("takes effect on the next request: granting and revoking users:read opens and closes GET /users", async () => {
    const user = employee("e@example.test");
    const header = await as(user);
    expect((await request(app).get("/api/v1/users").set(header)).status).toBe(403);

    await put(user.id, { permissions: ["users:read"] });
    expect((await request(app).get("/api/v1/users").set(header)).status).toBe(200);

    await put(user.id, { permissions: [] });
    expect((await request(app).get("/api/v1/users").set(header)).status).toBe(403);
  });
});
