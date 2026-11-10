import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: { $queryRaw: queryRaw } }));

import { createApp } from "../../../src/app.js";

describe("health routes", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("GET /api/v1/health returns 200 when the database is up", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const response = await request(createApp()).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("GET /api/v1/health returns 503 when the database is down", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const response = await request(createApp()).get("/api/v1/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "degraded" });
  });
});
