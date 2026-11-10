import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import { DailyLabourRepository } from "../../../src/modules/daily-labour/repository/daily-labour.repository.js";
import type { DailyLabourSort } from "../../../src/modules/daily-labour/dto/daily-labour.dto.js";

// Prisma.Sql keeps `?` placeholders; the driver numbers them. The lock modes are what keeps the writers from deadlocking
// (shared/constants/locks.ts), and a different mode is a one-word change in a SQL string. These pin the words. What the
// SQL does is run on a real database in tests/db.
function recorder(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const note = (query: Prisma.Sql): void => {
    calls.push({ text: query.sql.replace(/\s+/g, " ").trim(), values: query.values });
  };
  const db = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => (note(query), rows)),
    $executeRaw: vi.fn(async (query: Prisma.Sql) => (note(query), 1)),
  } as unknown as Prisma.TransactionClient;
  return { db, calls };
}

// A client for the list: the first query answers the ids of the page, the second the count, findMany the rows.
function listClient(ids: string[], total: number) {
  const calls: { text: string; values: unknown[] }[] = [];
  const findMany = vi.fn(async () => []);
  const db = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const text = query.sql.replace(/\s+/g, " ").trim();
      calls.push({ text, values: query.values });
      return text.includes("count(*)") ? [{ total }] : ids.map((id) => ({ id }));
    }),
    dailyLabour: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { db, calls, findMany };
}

const repository = new DailyLabourRepository();
const FROM =
  'FROM "DailyLabour" r JOIN "Villa" v ON v."id" = r."villaId" JOIN "Contractor" c ON c."id" = r."contractorId"';

describe("the daily labour's locks", () => {
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

  it("locks the row exclusively, and reads its version", async () => {
    const { db, calls } = recorder([{ version: 3 }]);

    expect(await repository.lockVersion("r1", db)).toBe(3);

    expect(calls).toEqual([
      { text: 'SELECT "version" FROM "DailyLabour" WHERE "id" = ? FOR UPDATE', values: ["r1"] },
    ]);
    expect(await repository.lockVersion("r1", recorder([]).db)).toBeNull();
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

  it("hands the transaction options on, so an import can ask for more time", async () => {
    const { fakePrisma } = await import("../auth/in-memory-auth.repository.js");
    const spy = vi.spyOn(fakePrisma, "$transaction");
    const work = async () => "done";

    expect(await repository.transaction(work, { timeout: 60_000 })).toBe("done");

    expect(spy).toHaveBeenCalledWith(work, { timeout: 60_000 });
    spy.mockRestore();
  });
});

describe("the list's SQL", () => {
  const sortBy = (field: DailyLabourSort["field"], direction: "asc" | "desc"): DailyLabourSort => ({
    field,
    direction,
  });
  const ask = async (filters = {}, sort = sortBy("labourDate", "desc")) => {
    const client = listClient(["r1"], 7);
    const result = await repository.list({ filters, sort, skip: 40, take: 20 }, client.db);
    return { ...client, result };
  };

  it("pages the ids with LIMIT and OFFSET and counts with the same FROM and WHERE", async () => {
    const { calls, result, findMany } = await ask({ villaId: "v1", contractorId: "c1" });

    const [page, count] = calls;
    expect(page?.text).toBe(
      `SELECT r."id" ${FROM} WHERE r."villaId" = ? AND r."contractorId" = ? ORDER BY r."labourDate" DESC, r."id" ASC LIMIT ? OFFSET ?`,
    );
    expect(page?.values).toEqual(["v1", "c1", 20, 40]);
    expect(count?.text).toBe(
      `SELECT count(*)::int AS "total" ${FROM} WHERE r."villaId" = ? AND r."contractorId" = ?`,
    );
    expect(count?.values).toEqual(["v1", "c1"]);
    expect(result.total).toBe(7);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["r1"] } } }));
  });

  it("returns the page in the order of the ids, not the order findMany answers in, and drops a row that is gone", async () => {
    const client = listClient(["r3", "r1", "r2", "r9"], 4);
    // findMany answers in its own order and has no r9: that row was deleted between the two queries.
    client.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }] as never);

    const result = await repository.list(
      { filters: {}, sort: sortBy("labourDate", "desc"), skip: 0, take: 20 },
      client.db,
    );

    expect(result.rows.map((row) => (row as { id: string }).id)).toEqual(["r3", "r1", "r2"]);
    expect(result.total).toBe(4);
  });

  it("has no WHERE without filters, and asks findMany for nothing when the page is empty", async () => {
    const empty = listClient([], 0);

    const result = await repository.list(
      { filters: {}, sort: sortBy("labourDate", "desc"), skip: 0, take: 20 },
      empty.db,
    );

    expect(empty.calls[0]?.text).not.toContain("WHERE");
    expect(result).toEqual({ rows: [], total: 0 });
    expect(empty.findMany).not.toHaveBeenCalled();
  });

  it("filters the day range on a DATE column, both ends included", async () => {
    const { calls } = await ask({
      labourFrom: new Date("2026-03-02T00:00:00.000Z"),
      labourTo: new Date("2026-03-09T00:00:00.000Z"),
    });

    expect(calls[0]?.text).toContain('WHERE r."labourDate" >= ?::date AND r."labourDate" <= ?::date');
    expect(calls[0]?.values).toEqual(["2026-03-02", "2026-03-09", 20, 40]);
  });

  it("searches the villa number, the contractor name and the notes, escaping % _ and a backslash", async () => {
    const { calls } = await ask({ search: "50%_\\x" });

    expect(calls[0]?.text).toContain('(v."villaNumber" ILIKE ? OR c."name" ILIKE ? OR r."notes" ILIKE ?)');
    const pattern = "%50\\%\\_\\\\x%";
    expect(calls[0]?.values).toEqual([pattern, pattern, pattern, 20, 40]);
  });

  it.each([
    ["labourDate", "asc", 'r."labourDate" ASC, r."id" ASC'],
    ["labourDate", "desc", 'r."labourDate" DESC, r."id" ASC'],
    ["villaNumber", "asc", 'v."villaNumber" COLLATE "asico_natural" ASC, r."labourDate" DESC, r."id" ASC'],
    ["villaNumber", "desc", 'v."villaNumber" COLLATE "asico_natural" DESC, r."labourDate" DESC, r."id" ASC'],
    ["contractorName", "asc", 'c."name" ASC, r."labourDate" DESC, r."id" ASC'],
    ["contractorName", "desc", 'c."name" DESC, r."labourDate" DESC, r."id" ASC'],
    ["labourCount", "asc", 'r."labourCount" ASC, r."id" ASC'],
    ["labourCount", "desc", 'r."labourCount" DESC, r."id" ASC'],
    ["createdAt", "asc", 'r."createdAt" ASC, r."id" ASC'],
    ["createdAt", "desc", 'r."createdAt" DESC, r."id" ASC'],
  ] as const)("orders by %s %s as %s, always ending in the id", async (field, direction, order) => {
    const { calls } = await ask({}, sortBy(field, direction));

    expect(calls[0]?.text).toContain(`ORDER BY ${order} LIMIT`);
  });
});

describe("the import's queries", () => {
  it("reads the villas and contractors it checks the file against, and the keys already stored", async () => {
    const villas = [{ id: "v1", villaNumber: "P-1", contractorId: null }];
    const db = {
      villa: { findMany: vi.fn(async () => villas) },
      contractor: { findMany: vi.fn(async () => []) },
      dailyLabour: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.importVillas(db)).toBe(villas);
    await repository.importContractors(db);
    await repository.existingKeys(["v1"], db);

    expect(db.villa.findMany).toHaveBeenCalledWith({
      select: { id: true, villaNumber: true, contractorId: true },
    });
    expect(db.contractor.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, phone: true, status: true },
    });
    expect(db.dailyLabour.findMany).toHaveBeenCalledWith({
      where: { villaId: { in: ["v1"] } },
      select: { villaId: true, contractorId: true, labourDate: true },
    });
  });

  it("saves the rows in one createMany and returns the ids it made", async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const db = { dailyLabour: { createMany } } as unknown as Prisma.TransactionClient;
    const row = {
      villaId: "v1",
      labourDate: new Date("2026-03-04T00:00:00.000Z"),
      contractorId: "c1",
      labourCount: 3,
      notes: null,
      createdById: "u1",
    };

    const ids = await repository.createMany([row, { ...row, villaId: "v2" }], db);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = createMany.mock.calls[0] as unknown as [{ data: { id: string; villaId: string }[] }];
    expect(data.map((entry) => entry.id)).toEqual(ids);
    expect(data.map((entry) => entry.villaId)).toEqual(["v1", "v2"]);
  });
});

describe("the writes", () => {
  it("changes a row only at its version, bumping it, and answers null when the version moved", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = { dailyLabour: { updateMany, findUnique: vi.fn() } } as unknown as Prisma.TransactionClient;

    expect(await repository.update("r1", 4, { labourCount: 2 }, db)).toBeNull();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "r1", version: 4 },
      data: { labourCount: 2, version: { increment: 1 }, updatedAt: expect.any(Date) },
    });
  });

  it("deletes a row only at its version", async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = { dailyLabour: { deleteMany } } as unknown as Prisma.TransactionClient;

    expect(await repository.delete("r1", 4, db)).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "r1", version: 4 } });
    deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await repository.delete("r1", 4, db)).toBe(false);
  });
});
