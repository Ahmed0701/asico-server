import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: {} }));

import { ContractorsRepository } from "../../../src/modules/contractors/repository/contractors.repository.js";

describe("ContractorsRepository.findByNormalizedNames", () => {
  it("does not ask the database anything for an empty list of names", async () => {
    const queryRaw = vi.fn();

    await expect(
      new ContractorsRepository().findByNormalizedNames([], { $queryRaw: queryRaw } as never),
    ).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("asks once for a list of names and returns what the database found", async () => {
    const queryRaw = vi.fn(async () => [{ name: "Acme", phone: "0100" }]);

    const found = await new ContractorsRepository().findByNormalizedNames(["acme"], {
      $queryRaw: queryRaw,
    } as never);

    expect(found).toEqual([{ name: "Acme", phone: "0100" }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
