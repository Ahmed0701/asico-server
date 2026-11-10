import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("./in-memory-users.repository.js")).InMemoryUsersRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();

let admin: User;
beforeEach(() => {
  store.reset();
  permissionTable.reset();
  villaTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

const employee = (email: string, ...codes: string[]): User => {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
};

const remove = async (id: string, by: User = admin, extra: Record<string, string> = {}) => {
  const req = request(app)
    .delete(`/api/v1/users/${id}`)
    .set(await as(by));
  for (const [name, value] of Object.entries(extra)) req.set(name, value);
  return req;
};

const auditActions = () => (store.auditRows as unknown as { action: string }[]).map((row) => row.action);

describe("DELETE /users/:id", () => {
  it("lets an ADMIN delete a user: the user, their permissions and sessions go, and the delete is audited", async () => {
    const user = employee("gone@example.test", "villas:read");

    const res = await remove(user.id);

    expect(res.status).toBe(204);
    expect(store.users.some((u) => u.id === user.id)).toBe(false);
    expect(store.grants.some((g) => g.userId === user.id)).toBe(false);
    expect(auditActions()).toEqual(["user.delete"]);
    expect((store.auditRows as unknown as { before: unknown }[])[0]?.before).toMatchObject({
      email: "gone@example.test",
      role: "EMPLOYEE",
    });
  });

  it("needs users:delete: an employee without it gets 403, one who was granted it may delete", async () => {
    const target = employee("t@example.test");
    const plain = employee("p@example.test", "users:read", "users:update", "users:deactivate");
    const granted = employee("g@example.test", "users:delete");

    expect((await request(app).delete(`/api/v1/users/${target.id}`)).status).toBe(401);
    expect((await remove(target.id, plain)).status).toBe(403);
    expect((await remove(target.id, granted)).status).toBe(204);
  });

  it("never deletes an ADMIN or the caller's own account", async () => {
    const granted = employee("g@example.test", "users:delete");

    const adminRes = await remove(admin.id, granted);
    const selfRes = await remove(granted.id, granted);

    expect(adminRes.status).toBe(403);
    expect(adminRes.body.code).toBe("ADMIN_CANNOT_BE_DELETED");
    expect(selfRes.body.code).toBe("CANNOT_DELETE_SELF");
    expect(store.users).toHaveLength(2);
  });

  it("keeps a user who created a villa: deactivate them instead (409), in Arabic on request", async () => {
    const author = employee("author@example.test");
    addVilla({ createdById: author.id });

    const res = await remove(author.id, admin, { "Accept-Language": "ar" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USER_HAS_RECORDS");
    expect(res.body.message).toContain("عطّل المستخدم");
    expect(store.users.some((u) => u.id === author.id)).toBe(true);
    expect(auditActions()).toEqual([]);
  });

  it("answers 404 for an unknown user and 409 for an old version", async () => {
    const user = employee("v@example.test");

    expect((await remove(randomUUID())).status).toBe(404);
    const stale = await remove(user.id, admin, { "If-Match": String(user.version + 5) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });
});
