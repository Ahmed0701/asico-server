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

// The variation order routes before they reach the database: who may call them (villas:read to see, villas:update to
// change), and what a request may carry. The rules themselves are tested on a real database
// (tests/db/variation-orders.db.test.ts).
const app = createApp();
const ID = randomUUID();
const ALL = ["villas:read", "villas:update"];

let admin: User;
beforeEach(() => {
  store.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const as = async (user: User) => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
function employee(...codes: string[]): User {
  const user = store.addUser({
    name: "Some Employee",
    email: `e${randomUUID()}@example.test`,
    passwordHash: "x",
  });
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch" | "delete";
const send = async (verb: Verb, path: string, user: User, body?: object) => {
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", "en");
  return body === undefined ? req : req.send(body);
};

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", `/villas/${ID}/variation-orders`, "villas:read"],
    ["get", `/variation-orders/${ID}/files/${ID}`, "villas:read"],
    ["post", `/villas/${ID}/variation-orders`, "villas:update"],
    ["patch", `/variation-orders/${ID}`, "villas:update"],
    ["delete", `/variation-orders/${ID}`, "villas:update"],
    ["post", `/variation-orders/${ID}/files`, "villas:update"],
    ["delete", `/variation-orders/${ID}/files/${ID}`, "villas:update"],
  ];

  it.each(endpoints)("%s %s needs %s", async (verb, path, code) => {
    const user = employee(...ALL.filter((one) => one !== code));

    expect((await send(verb, path, user, verb === "post" || verb === "patch" ? {} : undefined)).status).toBe(
      403,
    );
  });

  it("refuses a request without a token with 401", async () => {
    expect((await request(app).get(`/api/v1/villas/${ID}/variation-orders`)).status).toBe(401);
  });
});

describe("what a request may carry", () => {
  const good = { voNumber: "VO-1", amountMinor: 1_250_500 };

  it.each([
    ["no VO number", { amountMinor: 100 }],
    ["an empty VO number", { ...good, voNumber: "   " }],
    ["a VO number over 50 characters", { ...good, voNumber: "x".repeat(51) }],
    ["no amount", { voNumber: "VO-1" }],
    ["a negative amount", { ...good, amountMinor: -1 }],
    ["a fraction of a fils", { ...good, amountMinor: 1.5 }],
    ["an amount as text", { ...good, amountMinor: "100" }],
    ["an unknown status", { ...good, status: "LATE" }],
    ["a date that is not a day", { ...good, dateAdded: "15/11/2026" }],
    ["notes over 2000 characters", { ...good, notes: "x".repeat(2001) }],
    ["an unknown field", { ...good, villaId: ID }],
  ])("refuses %s with 400 on create", async (_case, body) => {
    const res = await send("post", `/villas/${ID}/variation-orders`, admin, body);

    expect(res.status).toBe(400);
  });

  it("refuses an empty edit, and an id that is not one", async () => {
    expect((await send("patch", `/variation-orders/${ID}`, admin, {})).status).toBe(400);
    expect((await send("get", "/villas/nope/variation-orders", admin)).status).toBe(400);
    expect((await send("delete", `/variation-orders/${ID}/files/nope`, admin)).status).toBe(400);
  });
});
