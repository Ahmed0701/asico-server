import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Must run before the app (and its limiters) are imported, so the limits are small enough to hit. The refresh allowance is
// given a value of its own, different from the sign-in one, to show each endpoint reads its own.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_MAX = "2";
  process.env.REFRESH_RATE_LIMIT_MAX = "4";
  process.env.REFRESH_RATE_LIMIT_WINDOW_MS = "123000";
  process.env.TRUST_PROXY = "1";
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

// With one proxy in front, the client address is the one the proxy forwarded: each test is a client of its own.
let clients = 0;
const newClient = (): string => `198.51.100.${++clients}`;
const refresh = (ip: string) => request(app).post("/api/v1/auth/refresh").set("X-Forwarded-For", ip);
const login = (ip: string) => request(app).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({});

describe("the refresh limiter", () => {
  it("is configured from REFRESH_RATE_LIMIT_MAX and REFRESH_RATE_LIMIT_WINDOW_MS, apart from the auth ones", () => {
    expect(env.REFRESH_RATE_LIMIT_MAX).toBe(4);
    expect(env.REFRESH_RATE_LIMIT_WINDOW_MS).toBe(123_000);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(2);
  });

  it("answers its own limit and window in the headers", async () => {
    const res = await refresh(newClient());

    expect(res.headers["ratelimit-policy"]).toContain("q=4");
    expect(res.headers["ratelimit-policy"]).toContain("w=123");
  });

  it("lets 4 requests through (a missing cookie is a plain 401) and refuses the 5th with 429, in the request language", async () => {
    const ip = newClient();
    for (let i = 0; i < 4; i++) {
      expect((await refresh(ip)).status).toBe(401);
    }

    const blocked = await refresh(ip).set("Accept-Language", "ar");

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "عدد الطلبات كبير جدًا" });
  });

  it("counts every request, valid or not, and sets no cookie when it refuses", async () => {
    const ip = newClient();
    for (let i = 0; i < 4; i++) await refresh(ip).set("Cookie", "refresh_token=not-a-token");

    const blocked = await refresh(ip).set("Cookie", "refresh_token=not-a-token");

    expect(blocked.status).toBe(429);
    expect(blocked.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps a counter of its own: the sign-in endpoints stay open while refresh is refused", async () => {
    const ip = newClient();
    for (let i = 0; i < 4; i++) await refresh(ip);
    expect((await refresh(ip)).status).toBe(429);

    expect((await login(ip)).status).toBe(400);
  });

  it("is not used up by the sign-in endpoints: refresh stays open while they are refused", async () => {
    const ip = newClient();
    for (let i = 0; i < 2; i++) {
      expect((await login(ip)).status).toBe(400);
    }
    expect((await login(ip)).status).toBe(429);

    expect((await refresh(ip)).status).toBe(401);
  });

  it("counts per client address: another client has its own allowance", async () => {
    const first = newClient();
    for (let i = 0; i < 4; i++) await refresh(first);
    expect((await refresh(first)).status).toBe(429);

    expect((await refresh(newClient())).status).toBe(401);
  });

  it("does not limit logout or the authenticated routes by the refresh allowance", async () => {
    const ip = newClient();
    for (let i = 0; i < 6; i++) {
      expect((await request(app).post("/api/v1/auth/logout").set("X-Forwarded-For", ip)).status).toBe(204);
      expect((await request(app).get("/api/v1/me").set("X-Forwarded-For", ip)).status).toBe(401);
    }
  });
});
