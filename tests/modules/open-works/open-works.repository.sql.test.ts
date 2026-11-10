import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import { OpenWorksRepository } from "../../../src/modules/open-works/repository/open-works.repository.js";
import { VillaProgressRepository } from "../../../src/modules/villa-progress/repository/villa-progress.repository.js";

// Prisma.Sql keeps `?` placeholders; the driver numbers them. The lock modes are what keeps the writers from deadlocking (shared/constants/locks.ts), and a different mode is a one-word
// change in a SQL string. These pin the words. What the SQL does is run on a real database in tests/db.
function recorder(rows: unknown[] = [], affected = 1) {
  const calls: { text: string; values: unknown[] }[] = [];
  const note = (query: Prisma.Sql): void => {
    calls.push({ text: query.sql.replace(/\s+/g, " ").trim(), values: query.values });
  };
  const db = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => (note(query), rows)),
    $executeRaw: vi.fn(async (query: Prisma.Sql) => (note(query), affected)),
  } as unknown as Prisma.TransactionClient;
  return { db, calls };
}

describe("the open works' locks", () => {
  const repository = new OpenWorksRepository();

  it("locks the villa shared, and reads its contractor", async () => {
    const { db, calls } = recorder([{ contractorId: "c1" }]);

    expect(await repository.lockVillaShared("v1", db)).toEqual({ contractorId: "c1" });

    expect(calls).toEqual([
      { text: 'SELECT "contractorId" FROM "Villa" WHERE "id" = ? FOR SHARE', values: ["v1"] },
    ]);
  });

  it("answers null for a villa that is not there", async () => {
    expect(await repository.lockVillaShared("v1", recorder([]).db)).toBeNull();
  });

  it("hands the transaction options on, so an import can ask for more time", async () => {
    const { fakePrisma } = await import("../auth/in-memory-auth.repository.js");
    const spy = vi.spyOn(fakePrisma, "$transaction");
    const work = async () => "done";

    expect(await repository.transaction(work, { timeout: 60_000 })).toBe("done");

    expect(spy).toHaveBeenCalledWith(work, { timeout: 60_000 });
    spy.mockRestore();
  });

  it("locks the villas of an import shared and in the order of their ids, and reads their contractors", async () => {
    const { db, calls } = recorder([
      { id: "v1", contractorId: "c1" },
      { id: "v2", contractorId: null },
    ]);

    const locked = await repository.lockVillasShared(["v1", "v2"], db);

    expect(calls).toEqual([
      {
        text: 'SELECT "id", "contractorId" FROM "Villa" WHERE "id" IN (?,?) ORDER BY "id" FOR SHARE',
        values: ["v1", "v2"],
      },
    ]);
    expect([...locked]).toEqual([
      ["v1", "c1"],
      ["v2", null],
    ]);
  });

  it("leaves a villa that is gone out of the answer, and asks the database nothing for no villas", async () => {
    const { db, calls } = recorder([{ id: "v1", contractorId: "c1" }]);

    expect([...(await repository.lockVillasShared(["v1", "v2"], db))]).toEqual([["v1", "c1"]]);
    expect(await repository.lockVillasShared([], db)).toEqual(new Map());
    expect(calls).toHaveLength(1);
  });

  it("makes the writers of one villa's open works under one phase take turns, with a transaction lock", async () => {
    const { db, calls } = recorder();

    await repository.lockVillaPhase("v1", "p1", db);

    expect(calls).toEqual([
      { text: "SELECT pg_advisory_xact_lock(hashtext(?))", values: ["open-work:v1:p1"] },
    ]);
  });
});

describe("the electrical phases of the import", () => {
  const repository = new OpenWorksRepository();

  it("locks the phases of an import shared and in the order of their ids, and reads their status", async () => {
    const { db, calls } = recorder([
      { id: "p1", status: "ACTIVE" },
      { id: "p2", status: "INACTIVE" },
    ]);

    const locked = await repository.lockElecPhasesShared(["p1", "p2"], db);

    expect(calls).toEqual([
      {
        text: 'SELECT "id", "status"::text AS "status" FROM "ElecPhase" WHERE "id" IN (?,?) ORDER BY "id" FOR SHARE',
        values: ["p1", "p2"],
      },
    ]);
    expect([...locked]).toEqual([
      ["p1", "ACTIVE"],
      ["p2", "INACTIVE"],
    ]);
  });

  it("asks the database nothing for no phases", async () => {
    const { db, calls } = recorder([]);

    expect(await repository.lockElecPhasesShared([], db)).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it("reads every phase in the order the page shows them", async () => {
    const findMany = vi.fn(async () => []);
    const db = { elecPhase: { findMany } } as unknown as Prisma.TransactionClient;

    await repository.importElecPhases(db);

    expect(findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, status: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  });

  it("reads the status of a phase, null when it is not there", async () => {
    const findUnique = vi.fn(async () => null);
    const db = { elecPhase: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.elecPhaseStatus("p9", db)).toBeNull();
    findUnique.mockResolvedValueOnce({ status: "INACTIVE" } as never);
    expect(await repository.elecPhaseStatus("p1", db)).toBe("INACTIVE");
  });
});

describe("the progress update's locks", () => {
  const repository = new VillaProgressRepository();

  it("locks the villa shared", async () => {
    const { db, calls } = recorder([{ id: "v1" }]);

    expect(await repository.lockVilla("v1", db)).toBe(true);
    expect(await repository.lockVilla("v1", recorder([]).db)).toBe(false);

    expect(calls).toEqual([{ text: 'SELECT "id" FROM "Villa" WHERE "id" = ? FOR SHARE', values: ["v1"] }]);
  });

  it("locks the phase shared, and reads it", async () => {
    const phase = { id: "p1", name: "Wall piping", sortOrder: 1, status: "ACTIVE" };
    const { db, calls } = recorder([phase]);

    expect(await repository.lockPhase("p1", db)).toEqual(phase);
    expect(await repository.lockPhase("p1", recorder([]).db)).toBeNull();

    expect(calls).toEqual([
      {
        text: 'SELECT "id", "name", "sortOrder", "status" FROM "ElecPhase" WHERE "id" = ? FOR SHARE',
        values: ["p1"],
      },
    ]);
  });

  it("locks the progress row exclusively", async () => {
    const row = { villaId: "v1", elecPhaseId: "p1", progress: 0, completedAt: null, version: 1 };
    const { db, calls } = recorder([row]);

    expect(await repository.lockRow("v1", "p1", db)).toEqual(row);

    expect(calls[0]?.text).toContain(
      'FROM "VillaPhaseProgress" WHERE "villaId" = ? AND "elecPhaseId" = ? FOR UPDATE',
    );
  });
});
