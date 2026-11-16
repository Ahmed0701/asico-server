import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";

// Who may open the dashboard charts. The figures are tested on a real database (tests/db/dashboard-charts.db.test.ts).
const app = createApp();

beforeEach(() => {
  store.reset();
});

describe("GET /dashboard/charts", () => {
  it("needs a token and dashboard:read", async () => {
    expect((await request(app).get("/api/v1/dashboard/charts")).status).toBe(401);

    const user = store.addUser({ name: "E", email: `e${randomUUID()}@example.test`, passwordHash: "x" });
    store.grant(user.id, "villas:read", "open-works:read", "payments:read");
    const res = await request(app)
      .get("/api/v1/dashboard/charts")
      .set("Authorization", `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`);
    expect(res.status).toBe(403);
  });
});
