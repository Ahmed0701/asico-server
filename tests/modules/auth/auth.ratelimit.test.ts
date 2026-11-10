import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Must run before the app (and its limiters) are imported, so the limit is small enough to hit.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_MAX = "3";
});

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("./in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("./in-memory-auth.repository.js")).InMemoryAuthRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";

const app = createApp();

describe("auth rate limits", () => {
  it("is configured from AUTH_RATE_LIMIT_MAX", () => {
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(3);
  });

  // Invalid bodies keep the requests cheap; the limiter counts them like any other request.
  // Each route gets its own counter, so earlier routes being exhausted must not affect later ones.
  it.each([
    ["/api/v1/auth/signup", "POST"],
    ["/api/v1/auth/login", "POST"],
    ["/api/v1/auth/forgot-password", "POST"],
    ["/api/v1/auth/reset-password", "POST"],
  ])("limits %s to 3 requests per window, with its own counter", async (path) => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(400);
    }

    const blocked = await request(app).post(path).set("Accept-Language", "ar").send({});

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "عدد الطلبات كبير جدًا" });
    expect(blocked.headers["ratelimit"] ?? blocked.headers["ratelimit-policy"]).toBeDefined();
  });

  it("does not apply the strict limit to refresh, logout or the authenticated routes", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await request(app).post("/api/v1/auth/refresh")).status).toBe(401);
      expect((await request(app).post("/api/v1/auth/logout")).status).toBe(204);
      expect((await request(app).get("/api/v1/me")).status).toBe(401);
    }
  });
});
