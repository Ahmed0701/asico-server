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

// The monthly progress route before it reaches the database: who may call it and what the query may carry. The figures
// are tested on a real database (tests/db/monthly-progress.db.test.ts).
const app = createApp();

let admin: User;
beforeEach(() => {
  store.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const token = async (user: User) => `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`;

const get = async (path: string, user: User) =>
  request(app)
    .get(`/api/v1${path}`)
    .set("Authorization", `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`)
    .set("Accept-Language", "en");

describe("GET /monthly-progress", () => {
  it("needs villas:read", async () => {
    const user = store.addUser({ name: "E", email: `e${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(user.id, "villas:update");

    expect((await get("/monthly-progress", user)).status).toBe(403);
    expect((await request(app).get("/api/v1/monthly-progress")).status).toBe(401);
  });

  it.each(["sort=location", "sort=change", "sort=due:up", "owed=yes", "contractorId=abc"])(
    "refuses %s with 400",
    async (query) => {
      expect((await get(`/monthly-progress?${query}`, admin)).status).toBe(400);
    },
  );
});

describe("progress payments", () => {
  it.each([
    ["get", `/villas/${randomUUID()}/progress-payments`, "payments:read"],
    ["get", `/villas/${randomUUID()}/progress-payments/export`, "payments:read"],
    ["post", `/villas/${randomUUID()}/progress-payments`, "payments:create"],
    ["post", `/villas/${randomUUID()}/progress-payments/manual`, "payments:create"],
    ["get", "/progress-payments/import/template", "payments:create"],
    ["delete", `/progress-payments/${randomUUID()}`, "payments:delete"],
  ] as const)("%s %s needs %s", async (method, path, code) => {
    const other = store.addUser({ name: "O", email: `o${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(other.id, "villas:read", "villas:update");
    const allowed = store.addUser({ name: "A", email: `a${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(allowed.id, code);
    const send = async (user: typeof admin) => {
      const agent = request(app);
      return (await agent[method](`/api/v1${path}`).set("Authorization", await token(user))).status;
    };
    expect(await send(other)).toBe(403);
    expect(await send(allowed)).not.toBe(403);
  });

  it.each([
    ["no date", { ratio: 10, amountMinor: 1000 }],
    ["an impossible date", { paidOn: "2026-02-30", ratio: 10, amountMinor: 1000 }],
    ["a ratio of 0", { paidOn: "2026-01-01", ratio: 0, amountMinor: 1000 }],
    ["a ratio over 100", { paidOn: "2026-01-01", ratio: 100.5, amountMinor: 1000 }],
    ["two decimals", { paidOn: "2026-01-01", ratio: 10.25, amountMinor: 1000 }],
    ["a negative amount", { paidOn: "2026-01-01", ratio: 10, amountMinor: -1 }],
    ["fils that are not whole", { paidOn: "2026-01-01", ratio: 10, amountMinor: 1.5 }],
    ["an unknown field", { paidOn: "2026-01-01", ratio: 10, amountMinor: 1000, method: "CASH" }],
  ])("refuses a manual payment with %s", async (_label, body) => {
    const res = await request(app)
      .post(`/api/v1/villas/${randomUUID()}/progress-payments/manual`)
      .set("Authorization", await token(admin))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("refuses ids that are not UUIDs", async () => {
    const auth = await token(admin);
    expect(
      (await request(app).post("/api/v1/villas/V-1/progress-payments").set("Authorization", auth)).status,
    ).toBe(400);
    expect(
      (await request(app).get("/api/v1/villas/V-1/progress-payments").set("Authorization", auth)).status,
    ).toBe(400);
    expect(
      (await request(app).get("/api/v1/villas/V-1/progress-payments/export").set("Authorization", auth))
        .status,
    ).toBe(400);
    expect(
      (await request(app).delete("/api/v1/progress-payments/abc").set("Authorization", auth)).status,
    ).toBe(400);
  });
});
