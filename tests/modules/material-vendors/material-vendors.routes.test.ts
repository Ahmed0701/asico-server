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

// Who may see the villa vendors, and what the list takes. The list itself is tested on a real database
// (tests/db/material-vendors.db.test.ts).
const app = createApp();
const URL = "/api/v1/material-vendors";

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

describe("GET /material-vendors", () => {
  it("needs a token and materials:read", async () => {
    expect((await request(app).get(URL)).status).toBe(401);
    const res = await request(app)
      .get(URL)
      .set("Authorization", await token(employee("villas:read", "materials:create")));
    expect(res.status).toBe(403);
  });

  it.each([
    ["a sort of another field", "sort=factory"],
    ["a type not in the list", "missing=PANEL"],
    ["a factory that is not a UUID", "factoryId=gulf"],
    ["a search that is too long", `search=${"x".repeat(101)}`],
    ["an unknown limit", "limit=0"],
  ])("refuses %s", async (_, qs) => {
    const res = await request(app)
      .get(`${URL}?${qs}`)
      .set("Authorization", await token(admin));
    expect(res.status).toBe(400);
  });
});

describe("PUT /villas/:villaId/vendors", () => {
  const PUT = `/api/v1/villas/${randomUUID()}/vendors`;

  it("needs materials:update", async () => {
    const res = await request(app)
      .put(PUT)
      .set("Authorization", await token(employee("materials:read", "villas:update")))
      .send({ cableFactoryId: null });
    expect(res.status).toBe(403);
  });

  it.each([
    ["nothing", {}],
    ["a factory that is not a UUID", { switchgearFactoryId: "gulf" }],
    ["an unknown field", { factoryId: randomUUID() }],
  ])("refuses %s", async (_, body) => {
    const res = await request(app)
      .put(PUT)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("refuses a villa id that is not a UUID", async () => {
    const res = await request(app)
      .put("/api/v1/villas/V-1/vendors")
      .set("Authorization", await token(admin))
      .send({ cableFactoryId: null });
    expect(res.status).toBe(400);
  });
});

describe("adding and taking villas off the Vendors list", () => {
  it.each([
    ["post", "materials:update"],
    ["delete", "materials:update"],
  ] as const)("%s /villas/:villaId/vendors needs %s", async (method, code) => {
    const path = `/api/v1/villas/${randomUUID()}/vendors`;
    const reader = await token(employee("materials:read", "villas:update"));
    expect((await request(app)[method](path).set("Authorization", reader)).status).toBe(403);
    const writer = await token(employee(code));
    expect((await request(app)[method](path).set("Authorization", writer)).status).not.toBe(403);
  });

  it("offers the villas to add with materials:read", async () => {
    const res = await request(app)
      .get("/api/v1/material-vendors/available")
      .set("Authorization", await token(employee("villas:read")));
    expect(res.status).toBe(403);
  });

  it("reads one villa's vendors with materials:read", async () => {
    const res = await request(app)
      .get(`/api/v1/villas/${randomUUID()}/vendors`)
      .set("Authorization", await token(employee("villas:read")));
    expect(res.status).toBe(403);
  });
});
