import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import { DailyReportsRepository } from "../../../src/modules/daily-reports/repository/daily-reports.repository.js";
import type { DailyReportSort } from "../../../src/modules/daily-reports/dto/daily-reports.dto.js";

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
    dailyReport: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { db, calls, findMany };
}

const repository = new DailyReportsRepository();

describe("the daily reports' locks", () => {
  it("locks the report row exclusively, and reads its version", async () => {
    const { db, calls } = recorder([{ version: 3 }]);

    expect(await repository.lockVersion("r1", db)).toBe(3);

    expect(calls).toEqual([
      { text: 'SELECT "version" FROM "DailyReport" WHERE "id" = ? FOR UPDATE', values: ["r1"] },
    ]);
    expect(await repository.lockVersion("r1", recorder([]).db)).toBeNull();
  });

  it("takes no villa lock at all: a report belongs to no villa", () => {
    expect((repository as unknown as Record<string, unknown>).lockVillaShared).toBeUndefined();
    expect((repository as unknown as Record<string, unknown>).lockVillasShared).toBeUndefined();
  });

  it("locks the contractors of an import shared and in the order of their ids, and reads their status", async () => {
    const { db, calls } = recorder([
      { id: "c1", status: "ACTIVE" },
      { id: "c2", status: "INACTIVE" },
    ]);

    const locked = await repository.lockContractorsShared(["c1", "c2"], db);

    expect(calls).toEqual([
      {
        text: 'SELECT "id", "status"::text AS "status" FROM "Contractor" WHERE "id" IN (?,?) ORDER BY "id" FOR SHARE',
        values: ["c1", "c2"],
      },
    ]);
    expect([...locked]).toEqual([
      ["c1", "ACTIVE"],
      ["c2", "INACTIVE"],
    ]);
  });

  it("locks the electrical engineers of an import the same way", async () => {
    const { db, calls } = recorder([{ id: "e1", status: "ACTIVE" }]);

    expect([...(await repository.lockEngineersShared(["e1"], db))]).toEqual([["e1", "ACTIVE"]]);

    expect(calls[0]?.text).toBe(
      'SELECT "id", "status"::text AS "status" FROM "ElectricalEngineer" WHERE "id" IN (?) ORDER BY "id" FOR SHARE',
    );
  });

  it("leaves a record that is gone out of the answer, and asks the database nothing for no ids", async () => {
    const { db, calls } = recorder([{ id: "c1", status: "ACTIVE" }]);

    expect([...(await repository.lockContractorsShared(["c1", "c2"], db))]).toEqual([["c1", "ACTIVE"]]);
    expect(await repository.lockContractorsShared([], db)).toEqual(new Map());
    expect(await repository.lockEngineersShared([], db)).toEqual(new Map());
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
  const sortBy = (field: DailyReportSort["field"], direction: "asc" | "desc"): DailyReportSort => ({
    field,
    direction,
  });
  const ask = async (filters = {}, sort = sortBy("reportDate", "desc")) => {
    const client = listClient(["r1"], 7);
    const result = await repository.list({ filters, sort, skip: 40, take: 20 }, client.db);
    return { ...client, result };
  };

  it("pages the ids with LIMIT and OFFSET and counts with the same FROM and WHERE", async () => {
    const { calls, result, findMany } = await ask({ contractorId: "c1", weather: "HOT" });

    const [page, count] = calls;
    expect(page?.text).toBe(
      `SELECT r."id" FROM "DailyReport" r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId" WHERE r."contractorId" = ? AND r."weather" = ?::"Weather" ORDER BY r."reportDate" DESC, r."id" ASC LIMIT ? OFFSET ?`,
    );
    expect(page?.values).toEqual(["c1", "HOT", 20, 40]);
    expect(count?.text).toBe(
      `SELECT count(*)::int AS "total" FROM "DailyReport" r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId" WHERE r."contractorId" = ? AND r."weather" = ?::"Weather"`,
    );
    expect(count?.values).toEqual(["c1", "HOT"]);
    expect(result.total).toBe(7);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["r1"] } } }));
  });

  it("returns the page in the order of the ids, not the order findMany answers in, and drops a report that is gone", async () => {
    const client = listClient(["r3", "r1", "r2", "r9"], 4);
    // findMany answers in its own order and has no r9: that report was deleted between the two queries.
    client.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }] as never);

    const result = await repository.list(
      { filters: {}, sort: sortBy("reportDate", "desc"), skip: 0, take: 20 },
      client.db,
    );

    expect(result.rows.map((row) => (row as { id: string }).id)).toEqual(["r3", "r1", "r2"]);
    expect(result.total).toBe(4);
  });

  it("has no WHERE without filters, and asks findMany for nothing when the page is empty", async () => {
    const empty = listClient([], 0);

    const result = await repository.list(
      { filters: {}, sort: sortBy("reportDate", "desc"), skip: 0, take: 20 },
      empty.db,
    );

    expect(empty.calls[0]?.text).not.toContain("WHERE");
    expect(result).toEqual({ rows: [], total: 0 });
    expect(empty.findMany).not.toHaveBeenCalled();
  });

  it("filters contractor, engineer and day range on DATE columns, both ends included", async () => {
    const { calls } = await ask({
      contractorId: "c1",
      preparedByEngineerId: "e1",
      reportFrom: new Date("2026-03-02T00:00:00.000Z"),
      reportTo: new Date("2026-03-09T00:00:00.000Z"),
    });

    expect(calls[0]?.text).toContain(
      'WHERE r."contractorId" = ? AND r."preparedByEngineerId" = ? AND r."reportDate" >= ?::date AND r."reportDate" <= ?::date',
    );
    expect(calls[0]?.values).toEqual(["c1", "e1", "2026-03-02", "2026-03-09", 20, 40]);
  });

  it("searches the notes only, escaping % _ and a backslash, in a materialized CTE the trigram index serves", async () => {
    const { calls } = await ask({ search: "50%_\\x" });

    const where = 'WHERE r."notes" ILIKE ?';
    expect(calls[0]?.text).toBe(
      `WITH r AS MATERIALIZED (SELECT r.* FROM "DailyReport" r ${where}) SELECT r."id" FROM r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId" ORDER BY r."reportDate" DESC, r."id" ASC LIMIT ? OFFSET ?`,
    );
    expect(calls[0]?.text).not.toContain("workDone");
    expect(calls[0]?.text).not.toContain("issues");
    const pattern = "%50\\%\\_\\\\x%";
    expect(calls[0]?.values).toEqual([pattern, 20, 40]);
    expect(calls[1]?.text).toBe(
      `WITH r AS MATERIALIZED (SELECT r.* FROM "DailyReport" r ${where}) SELECT count(*)::int AS "total" FROM r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId"`,
    );
    expect(calls[1]?.values).toEqual([pattern]);
  });

  it("does not materialise anything when there is no search", async () => {
    const { calls } = await ask({});

    expect(calls[0]?.text).not.toContain("MATERIALIZED");
    expect(calls[0]?.text).toContain(
      'FROM "DailyReport" r JOIN "Contractor" c ON c."id" = r."contractorId" JOIN "ElectricalEngineer" e ON e."id" = r."preparedByEngineerId"',
    );
  });

  it.each([
    ["reportDate", "asc", 'r."reportDate" ASC, r."id" ASC'],
    ["reportDate", "desc", 'r."reportDate" DESC, r."id" ASC'],
    ["contractorName", "asc", 'c."name" COLLATE "asico_natural" ASC, r."reportDate" DESC, r."id" ASC'],
    ["contractorName", "desc", 'c."name" COLLATE "asico_natural" DESC, r."reportDate" DESC, r."id" ASC'],
    ["preparedByName", "asc", 'e."name" COLLATE "asico_natural" ASC, r."reportDate" DESC, r."id" ASC'],
    ["preparedByName", "desc", 'e."name" COLLATE "asico_natural" DESC, r."reportDate" DESC, r."id" ASC'],
    ["weather", "asc", 'r."weather" ASC, r."reportDate" DESC, r."id" ASC'],
    ["weather", "desc", 'r."weather" DESC, r."reportDate" DESC, r."id" ASC'],
    ["createdAt", "asc", 'r."createdAt" ASC, r."id" ASC'],
    ["createdAt", "desc", 'r."createdAt" DESC, r."id" ASC'],
  ] as const)("orders by %s %s as %s, always ending in the id", async (field, direction, order) => {
    const { calls } = await ask({}, sortBy(field, direction));

    expect(calls[0]?.text).toContain(`ORDER BY ${order} LIMIT`);
  });
});

describe("the import's queries", () => {
  it("reads the contractors and the engineers it checks the file against, and the days already reported", async () => {
    const db = {
      contractor: { findMany: vi.fn(async () => []) },
      electricalEngineer: { findMany: vi.fn(async () => []) },
      dailyReport: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    await repository.importContractors(db);
    await repository.importEngineers(db);
    await repository.existingDays(["c1"], db);

    const party = { select: { id: true, name: true, phone: true, status: true } };
    expect(db.contractor.findMany).toHaveBeenCalledWith(party);
    expect(db.electricalEngineer.findMany).toHaveBeenCalledWith(party);
    expect(db.dailyReport.findMany).toHaveBeenCalledWith({
      where: { contractorId: { in: ["c1"] } },
      select: { contractorId: true, reportDate: true },
    });
  });

  it("saves the rows in one createMany and returns the ids it made", async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const db = { dailyReport: { createMany } } as unknown as Prisma.TransactionClient;
    const row = {
      contractorId: "c1",
      preparedByEngineerId: "e1",
      reportDate: new Date("2026-03-04T00:00:00.000Z"),
      weather: "SUNNY" as const,
      workersCount: 3,
      notes: "Work",
      createdById: "u1",
    };

    const ids = await repository.createMany([row, { ...row, contractorId: "c2" }], db);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = createMany.mock.calls[0] as unknown as [
      { data: { id: string; contractorId: string }[] },
    ];
    expect(data.map((entry) => entry.id)).toEqual(ids);
    expect(data.map((entry) => entry.contractorId)).toEqual(["c1", "c2"]);
  });

  it("reads whether the acting user still exists", async () => {
    const findUnique = vi.fn(async () => ({ id: "u1" }));
    const db = { user: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.userExists("u1", db)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { id: true } });
    findUnique.mockResolvedValueOnce(null as never);
    expect(await repository.userExists("u2", db)).toBe(false);
  });

  it("reads the status of a contractor and of an engineer, null for one that is not there", async () => {
    const db = {
      contractor: { findUnique: vi.fn(async () => ({ status: "INACTIVE" })) },
      electricalEngineer: { findUnique: vi.fn(async () => null) },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.contractorStatus("c1", db)).toBe("INACTIVE");
    expect(await repository.engineerStatus("e1", db)).toBeNull();
  });
});
