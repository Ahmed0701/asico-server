import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { isDatabaseBusy, TRANSACTION_DEFAULTS } from "../../src/core/database/transactions.js";
import { errorHandler } from "../../src/core/errors/errorHandler.js";

// A database too busy to answer in time is a 503 the client may retry, not a 500.

function appThrowing(err: unknown) {
  const app = express();
  app.use((req, _res, next) => {
    req.locale = "en";
    req.requestId = "req-1";
    next();
  });
  app.get("/x", () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe("a busy database", () => {
  it("recognises a transaction that could not start or ran out of time, and an exhausted pool", () => {
    expect(
      isDatabaseBusy({ code: "P2028", message: "Unable to start a transaction in the given time." }),
    ).toBe(true);
    expect(isDatabaseBusy({ code: "P2024" })).toBe(true);
    expect(isDatabaseBusy(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseBusy({ code: "P2002" })).toBe(false);
    expect(isDatabaseBusy(new Error("boom"))).toBe(false);
    expect(isDatabaseBusy(null)).toBe(false);
  });

  it("answers 503 SERVICE_BUSY with Retry-After, and a real failure still 500", async () => {
    const busy = await request(
      appThrowing({ code: "P2028", message: "Unable to start a transaction in the given time." }),
    ).get("/x");
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe("SERVICE_BUSY");
    expect(busy.headers["retry-after"]).toBe("2");

    const broken = await request(appThrowing(new Error("boom"))).get("/x");
    expect(broken.status).toBe(500);
    expect(broken.body.code).toBe("INTERNAL_ERROR");
  });

  it("gives a transaction more room than the library default for a burst of traffic", () => {
    expect(TRANSACTION_DEFAULTS.maxWait).toBeGreaterThan(2_000);
    expect(TRANSACTION_DEFAULTS.timeout).toBeGreaterThan(5_000);
  });
});
