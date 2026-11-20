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

// Who may see and change the additional expenses (the Department Overhead's permissions), and what a write may carry.
// The writing itself, and the files, are tested on a real database (tests/db/overhead-expenses.db.test.ts).
const app = createApp();
const ID = randomUUID();
const FILE_ID = randomUUID();
const BASE = "/api/v1/overhead-expenses";

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

const valid = {
  villaId: randomUUID(),
  type: "INVOICE",
  description: "Cable trays",
  amountMinor: 1000,
  expenseDate: "2026-11-10",
};

describe("the additional expenses", () => {
  it("need a token", async () => {
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).post(BASE).send(valid)).status).toBe(401);
  });

  it.each([
    ["get", BASE, "overhead:read"],
    ["get", `${BASE}/${ID}`, "overhead:read"],
    ["get", `${BASE}/${ID}/files/${FILE_ID}`, "overhead:read"],
    ["post", BASE, "overhead:create"],
    ["patch", `${BASE}/${ID}`, "overhead:update"],
    ["delete", `${BASE}/${ID}`, "overhead:delete"],
    ["post", `${BASE}/${ID}/files`, "overhead:update"],
    ["delete", `${BASE}/${ID}/files/${FILE_ID}`, "overhead:update"],
  ] as const)("%s %s needs %s, and the villas' permissions do not give it", async (method, path, code) => {
    const send = async (user: User) => {
      const agent = request(app);
      return (await agent[method](path).set("Authorization", await token(user))).status;
    };
    expect(await send(employee("villas:read", "villas:update", "villas:delete"))).toBe(403);
    expect(await send(employee(code))).not.toBe(403);
  });

  it("refuses a bad sort, type or villa filter", async () => {
    const auth = await token(admin);
    expect((await request(app).get(`${BASE}?sort=description`).set("Authorization", auth)).status).toBe(400);
    expect((await request(app).get(`${BASE}?type=FOOD`).set("Authorization", auth)).status).toBe(400);
    expect((await request(app).get(`${BASE}?villaId=abc`).set("Authorization", auth)).status).toBe(400);
  });

  it.each([
    ["nothing", {}],
    ["no villa", { ...valid, villaId: undefined }],
    ["a villa that is not a UUID", { ...valid, villaId: "V-1" }],
    ["a type not in the list", { ...valid, type: "FOOD" }],
    ["a type in lower case", { ...valid, type: "invoice" }],
    ["an empty description", { ...valid, description: "  " }],
    ["a description that is too long", { ...valid, description: "x".repeat(501) }],
    ["a negative amount", { ...valid, amountMinor: -1 }],
    ["a fraction of a fils", { ...valid, amountMinor: 1.5 }],
    ["an amount as text", { ...valid, amountMinor: "1000" }],
    ["too much", { ...valid, amountMinor: 1e15 }],
    ["no date", { ...valid, expenseDate: undefined }],
    ["an impossible date", { ...valid, expenseDate: "2026-02-30" }],
    ["a date with a time", { ...valid, expenseDate: "2026-11-10T10:00:00Z" }],
    ["an invoice number that is too long", { ...valid, invoiceNumber: "x".repeat(61) }],
    ["an unknown field", { ...valid, files: [] }],
  ])("refuses to add an expense with %s", async (_, body) => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ["nothing", {}],
    ["a negative amount", { amountMinor: -1 }],
    ["a type not in the list", { type: "Food" }],
    ["an unknown field", { version: 3 }],
  ])("refuses a change with %s", async (_, body) => {
    const res = await request(app)
      .patch(`${BASE}/${ID}`)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("refuses ids that are not UUIDs and an upload with no file", async () => {
    const auth = await token(admin);
    expect((await request(app).get(`${BASE}/abc`).set("Authorization", auth)).status).toBe(400);
    expect((await request(app).get(`${BASE}/${ID}/files/abc`).set("Authorization", auth)).status).toBe(400);
    const empty = await request(app).post(`${BASE}/${ID}/files`).set("Authorization", auth);
    expect(empty.status).toBe(400);
  });
});
