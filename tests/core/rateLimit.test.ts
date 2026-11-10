import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { env } from "../../src/core/config/env.js";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import { createRateLimiter, userOrIpKey } from "../../src/core/middleware/rateLimit.js";
import type { Request } from "express";

const fakeRequest = (user: { id: string } | undefined, ip: string | undefined): Request =>
  ({ user, ip }) as unknown as Request;

describe("userOrIpKey", () => {
  it("is the signed-in user when there is one", () => {
    expect(userOrIpKey(fakeRequest({ id: "u1" }, "203.0.113.5"))).toBe("user:u1");
  });

  it("is the client IP when nobody is signed in", () => {
    expect(userOrIpKey(fakeRequest(undefined, "203.0.113.5"))).toBe("ip:203.0.113.5");
  });

  it("treats the addresses in one IPv6 /56 as one client", () => {
    const a = userOrIpKey(fakeRequest(undefined, "2001:db8:1234:5600::1"));
    const b = userOrIpKey(fakeRequest(undefined, "2001:db8:1234:56ff:ffff::2"));

    expect(a).toBe(b);
    expect(a.startsWith("ip:")).toBe(true);
  });

  it("copes with a missing address", () => {
    expect(userOrIpKey(fakeRequest(undefined, undefined))).toMatch(/^ip:/);
  });

  it("two users never share a key, and a user is not an address", () => {
    expect(userOrIpKey(fakeRequest({ id: "u1" }, "203.0.113.5"))).not.toBe(
      userOrIpKey(fakeRequest({ id: "u2" }, "203.0.113.5")),
    );
    expect(userOrIpKey(fakeRequest({ id: "203.0.113.5" }, "x"))).not.toBe(
      userOrIpKey(fakeRequest(undefined, "203.0.113.5")),
    );
  });
});

function appWith(
  limiter: ReturnType<typeof createRateLimiter>,
  asUser: (req: Request) => { id: string } | undefined,
) {
  const app = express();
  app.use((req, _res, next) => {
    req.locale = req.headers["accept-language"] === "ar" ? "ar" : "en";
    const user = asUser(req);
    if (user) (req as unknown as { user: { id: string } }).user = user;
    next();
  });
  app.get("/x", limiter, (_req, res) => void res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("createRateLimiter with a key and a live limit", () => {
  it("counts each key on its own and answers 429 TOO_MANY_REQUESTS past the limit, in the request language", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 2, keyGenerator: userOrIpKey });
    const app = appWith(limiter, (req) => ({ id: String(req.headers["x-user"]) }));
    const get = (user: string, language = "en") =>
      request(app).get("/x").set("X-User", user).set("Accept-Language", language);

    expect((await get("a")).status).toBe(200);
    expect((await get("a")).status).toBe(200);
    const blocked = await get("a", "ar");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(blocked.body.message).toBe("عدد الطلبات كبير جدًا");
    expect((await get("b")).status).toBe(200);
  });

  it("falls back to the IP when there is no user", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1, keyGenerator: userOrIpKey });
    const app = appWith(limiter, () => undefined);

    expect((await request(app).get("/x")).status).toBe(200);
    expect((await request(app).get("/x")).status).toBe(429);
  });

  it("reads the limit again on every request when it is a function", async () => {
    let limit = 1;
    const limiter = createRateLimiter({ windowMs: 60_000, limit: () => limit, keyGenerator: userOrIpKey });
    const app = appWith(limiter, () => ({ id: "same" }));

    expect((await request(app).get("/x")).status).toBe(200);
    expect((await request(app).get("/x")).status).toBe(429);
    limit = 5;
    expect((await request(app).get("/x")).status).toBe(200);
  });

  it("sends the standard rate-limit headers", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 3, keyGenerator: userOrIpKey });
    const app = appWith(limiter, () => ({ id: "h" }));

    const res = await request(app).get("/x");

    expect(res.headers["ratelimit"] ?? res.headers["ratelimit-policy"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("the export limit in the environment", () => {
  it("has a window and a limit that can be configured", () => {
    expect(env.EXPORT_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    expect(env.EXPORT_RATE_LIMIT_MAX).toBeGreaterThan(0);
  });
});

describe("the import limit in the environment", () => {
  it("has a window and a limit that can be configured", () => {
    expect(env.IMPORT_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
    expect(env.IMPORT_RATE_LIMIT_MAX).toBeGreaterThan(0);
  });
});
