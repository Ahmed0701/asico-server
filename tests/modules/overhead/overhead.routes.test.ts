import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

// Who may see and change the department overhead, and what a write may carry. The writing itself is tested on a real
// database (tests/db/overhead.db.test.ts).
const app = createApp();
const ID = randomUUID();
const BASE = "/api/v1/overhead-employees";

let admin: User;
beforeEach(() => {
  store.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const token = async (user: User) => `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`;
function employee(...codes: string[]): User {
  const user = store.addUser({ name: "E", email: `e${randomUUID()}@example.test`, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

describe("the department overhead", () => {
  it("needs a token", async () => {
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).post(BASE).send({ name: "A", role: "B", salaryMinor: 1 })).status).toBe(401);
  });

  it.each([
    ["get", BASE, "overhead:read"],
    ["get", `${BASE}/${ID}`, "overhead:read"],
    ["post", BASE, "overhead:create"],
    ["patch", `${BASE}/${ID}`, "overhead:update"],
    ["delete", `${BASE}/${ID}`, "overhead:delete"],
  ] as const)("%s %s needs %s, and the villas' permissions do not give it", async (method, path, code) => {
    const send = async (user: User) => {
      const agent = request(app);
      return (
        await agent[method](path)
          .set("Authorization", await token(user))
          .send({ name: "A" })
      ).status;
    };
    expect(await send(employee("villas:read", "villas:update", "users:read"))).toBe(403);
    // With the code the request gets past the permission (and fails later, on validation or a missing row).
    expect(await send(employee(code))).not.toBe(403);
  });

  it("refuses a bad sort and a search that is too long", async () => {
    const auth = await token(admin);
    expect((await request(app).get(`${BASE}?sort=villa`).set("Authorization", auth)).status).toBe(400);
    expect(
      (
        await request(app)
          .get(`${BASE}?search=${"x".repeat(101)}`)
          .set("Authorization", auth)
      ).status,
    ).toBe(400);
  });

  it.each([
    ["nothing", {}],
    ["no salary", { name: "Ahmad", role: "ENGINEER" }],
    ["an empty name", { name: "  ", role: "ENGINEER", salaryMinor: 1 }],
    ["a name that is too long", { name: "x".repeat(121), role: "ENGINEER", salaryMinor: 1 }],
    ["an empty role", { name: "Ahmad", role: "", salaryMinor: 1 }],
    ["a role not in the list", { name: "Ahmad", role: "Accountant", salaryMinor: 1 }],
    ["a role in lower case", { name: "Ahmad", role: "engineer", salaryMinor: 1 }],
    ["a negative salary", { name: "Ahmad", role: "ENGINEER", salaryMinor: -1 }],
    ["a fraction of a fils", { name: "Ahmad", role: "ENGINEER", salaryMinor: 1.5 }],
    ["a salary as text", { name: "Ahmad", role: "ENGINEER", salaryMinor: "100" }],
    ["too much", { name: "Ahmad", role: "ENGINEER", salaryMinor: 1e15 }],
    ["an unknown field", { name: "Ahmad", role: "ENGINEER", salaryMinor: 1, villaId: ID }],
  ])("refuses to add an employee with %s", async (_, body) => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ["nothing", {}],
    ["a negative salary", { salaryMinor: -1 }],
    ["a role not in the list", { role: "Manager" }],
    ["an unknown field", { version: 3 }],
  ])("refuses a change with %s", async (_, body) => {
    const res = await request(app)
      .patch(`${BASE}/${ID}`)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("refuses an id that is not a UUID and a malformed If-Match", async () => {
    const auth = await token(admin);
    expect((await request(app).get(`${BASE}/abc`).set("Authorization", auth)).status).toBe(400);
    expect(
      (await request(app).delete(`${BASE}/${ID}`).set("Authorization", auth).set("If-Match", "nope")).status,
    ).toBe(400);
  });
});
