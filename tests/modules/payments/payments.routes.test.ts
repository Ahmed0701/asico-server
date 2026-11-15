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

// The payments routes before they reach the database: who may call them, and what a request may carry. The queries and
// rules themselves are tested on a real database (tests/db/payments.db.test.ts).
const app = createApp();
const ID = randomUUID();
const ALL = ["payments:read", "payments:create", "payments:update", "payments:delete"];

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
    ["get", "/payments", "payments:read"],
    ["get", "/payments/export?format=xlsx", "payments:read"],
    ["get", `/payments/${ID}`, "payments:read"],
    ["get", `/payments/${ID}/files/${ID}`, "payments:read"],
    ["post", "/payments", "payments:create"],
    ["get", "/payments/import/template", "payments:create"],
    ["post", "/payments/import", "payments:create"],
    ["patch", `/payments/${ID}`, "payments:update"],
    ["post", `/payments/${ID}/files`, "payments:update"],
    ["delete", `/payments/${ID}/files/${ID}`, "payments:update"],
    ["delete", `/payments/${ID}`, "payments:delete"],
  ];

  it.each(endpoints)("%s %s needs %s", async (verb, path, code) => {
    const user = employee(...ALL.filter((one) => one !== code));

    expect((await send(verb, path, user, verb === "post" || verb === "patch" ? {} : undefined)).status).toBe(
      403,
    );
  });

  it("refuses a request without a token with 401", async () => {
    expect((await request(app).get("/api/v1/payments")).status).toBe(401);
  });
});

describe("what a request may carry", () => {
  const good = { contractorId: ID, amountMinor: 1_250_500 };

  it.each([
    ["a negative amount", { ...good, amountMinor: -1 }],
    ["a fraction of a fils", { ...good, amountMinor: 1.5 }],
    ["an amount as text", { ...good, amountMinor: "100" }],
    ["an unknown status", { ...good, status: "LATE" }],
    ["an unknown method", { ...good, method: "CRYPTO" }],
    ["a due date that is not a day", { ...good, dueDate: "15/11/2026" }],
    ["a reference over 100 characters", { ...good, reference: "x".repeat(101) }],
    ["an unknown field", { ...good, overdue: true }],
    ["no contractor", { amountMinor: 100 }],
  ])("refuses %s with 400 on create", async (_case, body) => {
    const res = await send("post", "/payments", admin, body);

    expect(res.status).toBe(400);
  });

  it("refuses an empty edit, and a bad filter or sort on the list", async () => {
    expect((await send("patch", `/payments/${ID}`, admin, {})).status).toBe(400);
    expect((await send("get", "/payments?status=LATE", admin)).status).toBe(400);
    expect((await send("get", "/payments?overdue=yes", admin)).status).toBe(400);
    expect((await send("get", "/payments?sort=notes", admin)).status).toBe(400);
    expect((await send("get", "/payments?contractorId=nope", admin)).status).toBe(400);
  });

  it("asks for an Idempotency-Key on an import", async () => {
    const res = await request(app)
      .post("/api/v1/payments/import")
      .set(await as(admin))
      .attach("file", Buffer.from("PK"), "payments.xlsx");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
