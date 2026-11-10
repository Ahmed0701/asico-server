import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { env } from "../../src/core/config/env.js";

const ORIGIN = "http://localhost:5173";
const original = [...env.CORS_ORIGINS];

afterEach(() => {
  env.CORS_ORIGINS = original;
});

// Messages and labels depend on Accept-Language, so every API response has to say so to caches.
describe("Vary: Accept-Language on every API response", () => {
  const vary = (res: request.Response): string[] =>
    String(res.headers["vary"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase());

  it("is on a successful response", async () => {
    const res = await request(createApp()).get("/api/v1/health");

    expect(vary(res)).toContain("accept-language");
  });

  it("is on a 401, a 404 and a 400", async () => {
    const app = createApp();

    expect(vary(await request(app).get("/api/v1/me"))).toContain("accept-language");
    expect(vary(await request(app).get("/api/v1/does-not-exist"))).toContain("accept-language");
    expect(vary(await request(app).post("/api/v1/auth/login").send({}))).toContain("accept-language");
  });

  it("is on a response to a malformed JSON body, which fails before any route runs", async () => {
    const res = await request(createApp())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{ nope");

    expect(res.status).toBe(400);
    expect(vary(res)).toContain("accept-language");
  });

  it("sits alongside the CORS Vary: Origin, never replacing it", async () => {
    env.CORS_ORIGINS = [ORIGIN];

    const res = await request(createApp()).get("/api/v1/health").set("Origin", ORIGIN);

    expect(vary(res)).toEqual(expect.arrayContaining(["origin", "accept-language"]));
  });

  it("is on the CORS preflight answer too", async () => {
    env.CORS_ORIGINS = [ORIGIN];

    const res = await request(createApp())
      .options("/api/v1/villas")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(vary(res)).toContain("accept-language");
  });

  it("is the same whatever the language asked for", async () => {
    const app = createApp();

    const en = await request(app).get("/api/v1/me").set("Accept-Language", "en");
    const ar = await request(app).get("/api/v1/me").set("Accept-Language", "ar");

    expect(vary(en)).toEqual(vary(ar));
  });
});
