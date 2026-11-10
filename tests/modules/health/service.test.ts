import { describe, expect, it } from "vitest";
import { HealthService } from "../../../src/modules/health/service/health.service.js";

const repositoryReturning = (ok: boolean) => ({ ping: async () => ok });

describe("HealthService", () => {
  it("returns ok when the database answers", async () => {
    const service = new HealthService(repositoryReturning(true));
    await expect(service.getStatus()).resolves.toEqual({ status: "ok" });
  });

  it("returns degraded when the database does not answer", async () => {
    const service = new HealthService(repositoryReturning(false));
    await expect(service.getStatus()).resolves.toEqual({ status: "degraded" });
  });
});
