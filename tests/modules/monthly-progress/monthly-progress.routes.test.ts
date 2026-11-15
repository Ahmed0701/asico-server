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

  it.each(["month=2026-13", "month=2026-1", "month=nov", "sort=location", "sort=change:up"])(
    "refuses %s with 400",
    async (query) => {
      expect((await get(`/monthly-progress?${query}`, admin)).status).toBe(400);
    },
  );
});
