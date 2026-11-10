import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/core/errors/errorHandler.js";

// The import limit and the export limit have the same defaults, so they are given different values here to show
// the import limiter reads its own.
vi.mock("../../src/core/config/env.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/core/config/env.js")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      EXPORT_RATE_LIMIT_WINDOW_MS: 111_000,
      EXPORT_RATE_LIMIT_MAX: 7,
      IMPORT_RATE_LIMIT_WINDOW_MS: 222_000,
      IMPORT_RATE_LIMIT_MAX: 2,
    },
  };
});

afterAll(() => vi.doUnmock("../../src/core/config/env.js"));

describe("importRateLimiter", () => {
  it("uses the import window and the import limit, per user", async () => {
    const { importRateLimiter } = await import("../../src/core/middleware/rateLimit.js");
    const app = express();
    app.use((req, _res, next) => {
      req.locale = "en";
      (req as unknown as { user: { id: string } }).user = { id: String(req.headers["x-user"]) };
      next();
    });
    app.get("/x", importRateLimiter, (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    const get = (user: string) => request(app).get("/x").set("X-User", user);

    const first = await get("a");
    expect(first.headers["ratelimit-policy"]).toContain("w=222");
    expect(first.headers["ratelimit-policy"]).toContain("q=2");
    expect((await get("a")).status).toBe(200);
    expect((await get("a")).status).toBe(429);
    expect((await get("b")).status).toBe(200);
  });
});
