import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: { $queryRaw: queryRaw } }));

import { HealthRepository } from "../../../src/modules/health/repository/health.repository.js";

describe("HealthRepository.ping", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("runs SELECT 1 and returns true when the database is up", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    await expect(new HealthRepository().ping()).resolves.toBe(true);

    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join("").trim()).toBe("SELECT 1");
  });

  it("returns false instead of throwing when the database is down", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(new HealthRepository().ping()).resolves.toBe(false);
  });
});
