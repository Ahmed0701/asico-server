import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import { requestContext } from "../../src/core/middleware/requestContext.js";
import { validate } from "../../src/core/middleware/validate.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  paginationQuerySchema,
  toPagination,
  type PaginationQuery,
} from "../../src/shared/query/pagination.js";

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get("/items", validate(paginationQuerySchema, "query"), (req, res) => {
    res.json(toPagination(req.validated.query as PaginationQuery));
  });
  app.use(errorHandler);
  return app;
}

describe("pagination limits", () => {
  it("uses a default of 20 and a maximum of 1000", () => {
    expect(DEFAULT_LIMIT).toBe(20);
    expect(MAX_LIMIT).toBe(1000);
  });

  it("applies defaults when nothing is sent", async () => {
    const response = await request(buildApp()).get("/items");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ page: 1, limit: 20, skip: 0, take: 20 });
  });

  it("accepts limit 1000 and computes skip from it", async () => {
    const response = await request(buildApp()).get("/items?page=3&limit=1000");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ page: 3, limit: 1000, skip: 2000, take: 1000 });
  });

  it("rejects limit 1001 with 400 instead of clamping it", async () => {
    const response = await request(buildApp()).get("/items?limit=1001");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.details[0].path).toBe("limit");
  });

  it.each(["0", "-1", "-20", "abc", "", "1.5", "Infinity"])("rejects limit=%j with 400", async (value) => {
    const response = await request(buildApp()).get("/items").query({ limit: value });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it.each(["0", "-1", "abc", "9007199254740993"])("rejects page=%j with 400", async (value) => {
    const response = await request(buildApp()).get("/items").query({ page: value });

    expect(response.status).toBe(400);
  });
});
