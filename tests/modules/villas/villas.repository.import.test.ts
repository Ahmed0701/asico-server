import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { fakePrisma } from "../auth/in-memory-auth.repository.js";
import type { Prisma } from "../../../src/generated/prisma/client.js";
import { VillasRepository } from "../../../src/modules/villas/repository/villas.repository.js";

// The queries the villa import makes, against a recording client: the in-memory fake replaces this repository in the route
// tests, so this is where the shape of the SQL and of the calls is pinned (the database tests run them for real).
function recordingDb(answers: unknown[][] = []) {
  const queries: { text: string; values: unknown[] }[] = [];
  const queryRaw = vi.fn(async (query: { sql: string; values: unknown[] }) => {
    queries.push({ text: query.sql, values: query.values });
    return answers.shift() ?? [];
  });
  const executed: { text: string; values: unknown[] }[] = [];
  const executeRaw = vi.fn(async (query: { sql: string; values: unknown[] }) => {
    executed.push({ text: query.sql, values: query.values });
    return 0;
  });
  const villa = {
    findMany: vi.fn(async () => [] as unknown[]),
    createMany: vi.fn(async () => ({ count: 0 })),
  };
  const db = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    villa,
    area: { findMany: vi.fn(async () => [{ id: "a", name: "A", city: "C" }]) },
    civilEngineer: { findMany: vi.fn(async () => [{ id: "c", name: "C", phone: "1", status: "ACTIVE" }]) },
    electricalEngineer: {
      findMany: vi.fn(async () => [{ id: "e", name: "E", phone: "2", status: "ACTIVE" }]),
    },
    contractor: { findMany: vi.fn(async () => [{ id: "k", name: "K", phone: "3", status: "INACTIVE" }]) },
  };
  return { db: db as unknown as Prisma.TransactionClient, raw: db, queries, executed };
}

const repository = new VillasRepository();

describe("what the file is checked against", () => {
  it("reads every area with its city, and every party with its phone and its status (the inactive ones too)", async () => {
    const { db, raw } = recordingDb();

    expect(await repository.importAreas(db)).toEqual([{ id: "a", name: "A", city: "C" }]);
    expect(raw.area.findMany).toHaveBeenCalledWith({ select: { id: true, name: true, city: true } });

    const select = { id: true, name: true, phone: true, status: true };
    expect(await repository.importCivilEngineers(db)).toEqual([
      { id: "c", name: "C", phone: "1", status: "ACTIVE" },
    ]);
    expect(raw.civilEngineer.findMany).toHaveBeenCalledWith({ select });
    expect(await repository.importElectricalEngineers(db)).toHaveLength(1);
    expect(raw.electricalEngineer.findMany).toHaveBeenCalledWith({ select });
    expect(await repository.importContractors(db)).toEqual([
      { id: "k", name: "K", phone: "3", status: "INACTIVE" },
    ]);
    expect(raw.contractor.findMany).toHaveBeenCalledWith({ select });
  });

  it("reads the number of every stored villa, and nothing else about them", async () => {
    const { db, raw } = recordingDb();
    raw.villa.findMany.mockResolvedValue([{ villaNumber: "V-1" }, { villaNumber: "V-2" }]);

    expect(await repository.storedVillaNumbers(db)).toEqual(["V-1", "V-2"]);
    expect(raw.villa.findMany).toHaveBeenCalledWith({ select: { villaNumber: true } });
  });

  it("reads the places of the villas of the areas the file uses, and only those", async () => {
    const { db, raw } = recordingDb();
    raw.villa.findMany.mockResolvedValue([{ areaId: "a1", block: "B", plot: "1" }]);

    expect(await repository.storedPlots(["a1", "a2"], db)).toEqual([{ areaId: "a1", block: "B", plot: "1" }]);
    expect(raw.villa.findMany).toHaveBeenCalledWith({
      where: { areaId: { in: ["a1", "a2"] } },
      select: { areaId: true, block: true, plot: true },
    });
  });
});

describe("lockRefsShared", () => {
  it("locks the areas, then the civil engineers, the electrical engineers and the contractors: one statement each, shared, by id", async () => {
    const { db, queries } = recordingDb([
      [{ id: "a1" }],
      [{ id: "c1", status: "ACTIVE" }],
      [{ id: "e1", status: "INACTIVE" }],
      [{ id: "k1", status: "ACTIVE" }],
    ]);

    const locked = await repository.lockRefsShared(
      { areaIds: ["a1"], civilEngineerIds: ["c1"], electricalEngineerIds: ["e1"], contractorIds: ["k1"] },
      db,
    );

    expect(queries).toHaveLength(4);
    expect(queries.map((query) => /FROM "(\w+)"/.exec(query.text)?.[1])).toEqual([
      "Area",
      "CivilEngineer",
      "ElectricalEngineer",
      "Contractor",
    ]);
    for (const query of queries) {
      expect(query.text).toMatch(/ORDER BY "id" FOR SHARE$/);
    }
    expect(locked.areas).toEqual(new Set(["a1"]));
    expect(locked.civilEngineers).toEqual(new Map([["c1", "ACTIVE"]]));
    expect(locked.electricalEngineers).toEqual(new Map([["e1", "INACTIVE"]]));
    expect(locked.contractors).toEqual(new Map([["k1", "ACTIVE"]]));
  });

  it("asks for the ids in sorted order, whatever the order they come in", async () => {
    const { db, queries } = recordingDb();

    await repository.lockRefsShared(
      {
        areaIds: ["a3", "a1", "a2"],
        civilEngineerIds: ["c2", "c1"],
        electricalEngineerIds: [],
        contractorIds: [],
      },
      db,
    );

    expect(queries[0]!.values).toEqual(["a1", "a2", "a3"]);
    expect(queries[1]!.values).toEqual(["c1", "c2"]);
  });

  it("does not query for a kind the file does not use, and answers it empty", async () => {
    const { db, queries } = recordingDb([[{ id: "a1" }], [{ id: "c1", status: "ACTIVE" }]]);

    const locked = await repository.lockRefsShared(
      { areaIds: ["a1"], civilEngineerIds: ["c1"], electricalEngineerIds: [], contractorIds: [] },
      db,
    );

    expect(queries).toHaveLength(2);
    expect(locked.electricalEngineers.size).toBe(0);
    expect(locked.contractors.size).toBe(0);
  });

  it("does not query at all for an empty file", async () => {
    const { db, queries } = recordingDb();

    const locked = await repository.lockRefsShared(
      { areaIds: [], civilEngineerIds: [], electricalEngineerIds: [], contractorIds: [] },
      db,
    );

    expect(queries).toHaveLength(0);
    expect(locked.areas.size).toBe(0);
  });

  it("leaves out what is gone: an id the query does not return is not in the answer", async () => {
    const { db } = recordingDb([[{ id: "a1" }], [], [], []]);

    const locked = await repository.lockRefsShared(
      {
        areaIds: ["a1", "a2"],
        civilEngineerIds: ["c1"],
        electricalEngineerIds: ["e1"],
        contractorIds: ["k1"],
      },
      db,
    );

    expect(locked.areas).toEqual(new Set(["a1"]));
    expect(locked.civilEngineers.size).toBe(0);
    expect(locked.electricalEngineers.size).toBe(0);
    expect(locked.contractors.size).toBe(0);
  });
});

describe("createMany", () => {
  const row = (villaNumber: string, budgetMinor: number | null) => ({
    villaNumber,
    ownerName: null,
    villaType: null,
    areaId: "a",
    block: "B",
    plot: villaNumber,
    civilEngineerId: "c",
    electricalEngineerId: null,
    contractorId: null,
    createdById: "u",
    startDate: null,
    targetDate: null,
    budgetMinor,
    currency: budgetMinor === null ? null : "EGP",
  });

  it("saves all the rows in one statement, each under an id made here, and answers the ids in the order of the rows", async () => {
    const { db, raw } = recordingDb();

    const ids = await repository.createMany([row("A", 100), row("B", null), row("C", 0)], db);

    expect(raw.villa.createMany).toHaveBeenCalledTimes(1);
    const { data } = (
      raw.villa.createMany.mock.calls[0] as unknown as [{ data: { id: string; villaNumber: string }[] }]
    )[0];
    expect(data.map((saved) => saved.villaNumber)).toEqual(["A", "B", "C"]);
    expect(data.map((saved) => saved.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("gives the budget to the BIGINT column as a bigint, 0 included, and a missing budget as null", async () => {
    const { db, raw } = recordingDb();

    await repository.createMany([row("A", 125_000_050), row("B", null), row("C", 0)], db);

    const { data } = (
      raw.villa.createMany.mock.calls[0] as unknown as [{ data: { budgetMinor: unknown }[] }]
    )[0];
    expect(data.map((saved) => saved.budgetMinor)).toEqual([125_000_050n, null, 0n]);
  });

  it("keeps every other value as it is, and the creator", async () => {
    const { db, raw } = recordingDb();

    await repository.createMany([row("A", 5)], db);

    const { data } = (
      raw.villa.createMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }]
    )[0];
    expect(data[0]).toMatchObject({
      villaNumber: "A",
      ownerName: null,
      villaType: null,
      areaId: "a",
      block: "B",
      plot: "A",
      civilEngineerId: "c",
      electricalEngineerId: null,
      contractorId: null,
      createdById: "u",
      startDate: null,
      targetDate: null,
      currency: "EGP",
    });
  });
});

describe("insertProgressRowsForMany", () => {
  it("makes the rows for every villa it is given, in one statement", async () => {
    const { db, executed } = recordingDb();

    await repository.insertProgressRowsForMany(["v1", "v2", "v3"], db);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.values).toContainEqual(["v1", "v2", "v3"]);
  });

  it("makes none for none", async () => {
    const { db, executed } = recordingDb();

    await repository.insertProgressRowsForMany([], db);

    expect(executed).toHaveLength(0);
  });
});

describe("transaction", () => {
  it("passes the time allowance it is given on to the database, and none when it is given none", async () => {
    const spy = vi.spyOn(fakePrisma, "$transaction");

    await repository.transaction(async () => 1, { timeout: 30_000 });
    await repository.transaction(async () => 2);

    const calls = spy.mock.calls as unknown[][];
    expect(calls[0]?.[1]).toEqual({ timeout: 30_000 });
    expect(calls[1]?.[1]).toBeUndefined();
    spy.mockRestore();
  });
});
