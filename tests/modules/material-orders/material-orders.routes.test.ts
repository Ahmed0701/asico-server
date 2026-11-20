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

// The material orders routes before they reach the database: who may call them and what they may carry. The figures are
// tested on a real database (tests/db/material-orders.db.test.ts).
const app = createApp();

let admin: User;
beforeEach(() => {
  store.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const token = async (user: User) => `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`;

describe("material orders", () => {
  it.each([
    ["get", "/material-orders", "materials:read"],
    ["put", `/villas/${randomUUID()}/material-orders/SWITCHGEAR`, "materials:update"],
  ] as const)("%s %s needs %s", async (method, path, code) => {
    const other = store.addUser({ name: "O", email: `o${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(other.id, "villas:read");
    const allowed = store.addUser({ name: "A", email: `a${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(allowed.id, code);
    const send = async (user: User) => {
      const agent = request(app);
      return (
        await agent[method](`/api/v1${path}`)
          .set("Authorization", await token(user))
          .send({ mrDate: null, poDate: null, dueDate: null })
      ).status;
    };
    expect(await send(other)).toBe(403);
    expect(await send(allowed)).not.toBe(403);
  });

  it.each([
    ["an unknown status", "?status=LATE"],
    ["an unknown type", "?type=PIPES"],
    ["an unknown sort", "?sort=mrDate"],
    ["overdue that is not a boolean", "?overdue=yes"],
  ])("refuses a list query with %s", async (_label, search) => {
    const res = await request(app)
      .get(`/api/v1/material-orders${search}`)
      .set("Authorization", await token(admin));
    expect(res.status).toBe(400);
  });

  it.each([
    ["an impossible date", { mrDate: "2026-02-30", poDate: null, dueDate: null }],
    ["a missing field", { mrDate: null, poDate: null }],
    ["an unknown field", { mrDate: null, poDate: null, dueDate: null, notes: "x" }],
  ])("refuses dates with %s", async (_label, body) => {
    const res = await request(app)
      .put(`/api/v1/villas/${randomUUID()}/material-orders/CABLE`)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("refuses a villa id that is not a UUID and a type that is not one", async () => {
    const auth = await token(admin);
    const body = { mrDate: null, poDate: null, dueDate: null };
    expect(
      (
        await request(app)
          .put("/api/v1/villas/V-1/material-orders/CABLE")
          .set("Authorization", auth)
          .send(body)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/v1/villas/${randomUUID()}/material-orders/PIPES`)
          .set("Authorization", auth)
          .send(body)
      ).status,
    ).toBe(400);
  });
});
