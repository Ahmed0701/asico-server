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

// Who may read and change a villa's budget figures, and what a save may carry. The saving itself is tested on a real
// database (tests/db/villa-finance.db.test.ts).
const app = createApp();
const ID = randomUUID();

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

describe("the villa budget figures", () => {
  it("need villas:read to read and villas:update to save, and a token", async () => {
    const reader = employee("villas:update");
    const writer = employee("villas:read");

    expect((await request(app).get(`/api/v1/villas/${ID}/finance`)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(`/api/v1/villas/${ID}/finance`)
          .set("Authorization", await token(reader))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .put(`/api/v1/villas/${ID}/finance`)
          .set("Authorization", await token(writer))
          .send({ salaryShareBp: 1 })
      ).status,
    ).toBe(403);
  });

  it("lists every villa with villas:read, and refuses a bad sort", async () => {
    const writer = employee("villas:update");
    expect(
      (
        await request(app)
          .get("/api/v1/villa-finance")
          .set("Authorization", await token(writer))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/v1/villa-finance?sort=owner")
          .set("Authorization", await token(admin))
      ).status,
    ).toBe(400);
  });

  it.each([
    ["nothing", {}],
    ["a negative amount", { pettyCashMinor: -1 }],
    ["a negative salary share", { salaryShareBp: -1 }],
    ["a salary share over 100%", { salaryShareBp: 10_001 }],
    ["a fraction of a hundredth of a percent", { salaryShareBp: 12.5 }],
    ["salaries typed by hand (they come from the share now)", { salariesMinor: 1000 }],
    ["a fraction of a fils", { pettyCashMinor: 1.5 }],
    ["an amount as text", { workOrderMinor: "100" }],
    ["too much", { materialsMinor: 1e15 }],
    ["a negative budget", { budgetMinor: -5 }],
    ["an unknown field", { currency: "USD" }],
  ])("refuses %s with 400", async (_case, body) => {
    const res = await request(app)
      .put(`/api/v1/villas/${ID}/finance`)
      .set("Authorization", await token(admin))
      .send(body);

    expect(res.status).toBe(400);
  });
});
