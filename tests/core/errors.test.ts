import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";

describe("error handling", () => {
  it("answers malformed JSON with 400 and no stack trace", async () => {
    const response = await request(createApp())
      .post("/api/v1/health")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST");
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(response.body)).not.toContain("at ");
  });

  it("answers an oversized body with 413", async () => {
    const response = await request(createApp())
      .post("/api/v1/health")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers unknown routes with a localised 404 and a request id header", async () => {
    const response = await request(createApp()).get("/nope").set("Accept-Language", "ar");

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("غير موجود");
    expect(response.headers["x-request-id"]).toBe(response.body.requestId);
  });

  it("sends no CORS headers to an origin that is not allowlisted", async () => {
    const response = await request(createApp()).get("/api/v1/health").set("Origin", "https://evil.example");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
