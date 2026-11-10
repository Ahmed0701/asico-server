import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { Prisma } from "../../../src/generated/prisma/client.js";
import type { SmallWorkSort } from "../../../src/modules/small-works/dto/small-works.dto.js";
import { SmallWorksRepository } from "../../../src/modules/small-works/repository/small-works.repository.js";

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
    dailySmallWork: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { db, calls, findMany };
}

const repository = new SmallWorksRepository();

describe("the small works' locks", () => {
  it("locks the villa shared, and says whether it is there", async () => {
    const { db, calls } = recorder([{ id: "v1" }]);

    expect(await repository.lockVillaShared("v1", db)).toBe(true);

    expect(calls).toEqual([{ text: 'SELECT "id" FROM "Villa" WHERE "id" = ? FOR SHARE', values: ["v1"] }]);
    expect(await repository.lockVillaShared("v1", recorder([]).db)).toBe(false);
  });

  it("locks the small work row exclusively, and reads its version", async () => {
    const { db, calls } = recorder([{ version: 3 }]);

    expect(await repository.lockVersion("r1", db)).toBe(3);

    expect(calls).toEqual([
      { text: 'SELECT "version" FROM "DailySmallWork" WHERE "id" = ? FOR UPDATE', values: ["r1"] },
    ]);
    expect(await repository.lockVersion("r1", recorder([]).db)).toBeNull();
  });

  it("locks the villas of an import shared and in the order of their ids", async () => {
    const { db, calls } = recorder([{ id: "v1" }, { id: "v2" }]);

    const locked = await repository.lockVillasShared(["v1", "v2"], db);

    expect(calls).toEqual([
      {
        text: 'SELECT "id" FROM "Villa" WHERE "id" IN (?,?) ORDER BY "id" FOR SHARE',
        values: ["v1", "v2"],
      },
    ]);
    expect([...locked]).toEqual(["v1", "v2"]);
  });

  it("leaves a villa that is gone out of the answer, and asks the database nothing for no villas", async () => {
    const { db, calls } = recorder([{ id: "v1" }]);

    expect([...(await repository.lockVillasShared(["v1", "v2"], db))]).toEqual(["v1"]);
    expect(await repository.lockVillasShared([], db)).toEqual(new Set());
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
  const sortBy = (field: SmallWorkSort["field"], direction: "asc" | "desc"): SmallWorkSort => ({
    field,
    direction,
  });
  const ask = async (filters = {}, sort = sortBy("endDate", "desc")) => {
    const client = listClient(["r1"], 7);
    const result = await repository.list({ filters, sort, skip: 40, take: 20 }, client.db);
    return { ...client, result };
  };

  it("pages the ids with LIMIT and OFFSET and counts with the same FROM and WHERE; the enum is cast", async () => {
    const { calls, result, findMany } = await ask({ villaId: "v1", status: "DONE" });

    const [page, count] = calls;
    expect(page?.text).toBe(
      'SELECT r."id" FROM "DailySmallWork" r JOIN "Villa" v ON v."id" = r."villaId" JOIN "Contractor" c ON c."id" = r."contractorId" WHERE r."villaId" = ? AND r."status" = ?::"SmallWorkStatus" ORDER BY r."endDate" DESC, r."id" ASC LIMIT ? OFFSET ?',
    );
    expect(page?.values).toEqual(["v1", "DONE", 20, 40]);
    expect(count?.text).toBe(
      'SELECT count(*)::int AS "total" FROM "DailySmallWork" r JOIN "Villa" v ON v."id" = r."villaId" JOIN "Contractor" c ON c."id" = r."contractorId" WHERE r."villaId" = ? AND r."status" = ?::"SmallWorkStatus"',
    );
    expect(count?.values).toEqual(["v1", "DONE"]);
    expect(result.total).toBe(7);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["r1"] } } }));
  });

  it("returns the page in the order of the ids, not the order findMany answers in, and drops a row that is gone", async () => {
    const client = listClient(["r3", "r1", "r2", "r9"], 4);
    // findMany answers in its own order and has no r9: that row was deleted between the two queries.
    client.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }] as never);

    const result = await repository.list(
      { filters: {}, sort: sortBy("endDate", "desc"), skip: 0, take: 20 },
      client.db,
    );

    expect(result.rows.map((row) => (row as { id: string }).id)).toEqual(["r3", "r1", "r2"]);
    expect(result.total).toBe(4);
  });

  it("has no WHERE without filters, and asks findMany for nothing when the page is empty", async () => {
    const empty = listClient([], 0);

    const result = await repository.list(
      { filters: {}, sort: sortBy("endDate", "desc"), skip: 0, take: 20 },
      empty.db,
    );

    expect(empty.calls[0]?.text).not.toContain("WHERE");
    expect(result).toEqual({ rows: [], total: 0 });
    expect(empty.findMany).not.toHaveBeenCalled();
  });

  it("filters the contractor", async () => {
    const { calls } = await ask({ contractorId: "c1" });

    expect(calls[0]?.text).toContain('WHERE r."contractorId" = ?');
    expect(calls[0]?.values).toEqual(["c1", 20, 40]);
  });

  it("filters each day range on its own DATE column, both ends included", async () => {
    const { calls } = await ask({
      startFrom: new Date("2026-03-02T00:00:00.000Z"),
      startTo: new Date("2026-03-09T00:00:00.000Z"),
      endFrom: new Date("2026-03-10T00:00:00.000Z"),
      endTo: new Date("2026-03-20T00:00:00.000Z"),
    });

    expect(calls[0]?.text).toContain(
      'WHERE r."startDate" >= ?::date AND r."startDate" <= ?::date AND r."endDate" >= ?::date AND r."endDate" <= ?::date',
    );
    expect(calls[0]?.values).toEqual(["2026-03-02", "2026-03-09", "2026-03-10", "2026-03-20", 20, 40]);
  });

  describe("overdue and due soon are two comparisons of the end date with the days of the alert window", () => {
    const alert = { today: "2026-11-05", horizon: "2026-11-06" };
    const late = `(r."status" = 'PENDING' AND r."endDate" < ?::date)`;
    const soon = `(r."status" = 'PENDING' AND r."endDate" >= ?::date AND r."endDate" < ?::date)`;

    it("overdue true: pending and ending before today", async () => {
      const { calls } = await ask({ alert, overdue: true });

      expect(calls[0]?.text).toContain(`WHERE ${late} ORDER BY`);
      expect(calls[0]?.values).toEqual(["2026-11-05", 20, 40]);
    });

    it("overdue false: the negation, so a done work is not overdue", async () => {
      const { calls } = await ask({ alert, overdue: false });

      expect(calls[0]?.text).toContain(`WHERE NOT ${late} ORDER BY`);
    });

    it("due soon true and false: from today up to, not including, the horizon", async () => {
      const yes = await ask({ alert, dueSoon: true });
      const no = await ask({ alert, dueSoon: false });

      expect(yes.calls[0]?.text).toContain(`WHERE ${soon} ORDER BY`);
      expect(yes.calls[0]?.values).toEqual(["2026-11-05", "2026-11-06", 20, 40]);
      expect(no.calls[0]?.text).toContain(`WHERE NOT ${soon} ORDER BY`);
    });

    it("both together are both conditions, and no flag adds none", async () => {
      const both = await ask({ alert, overdue: true, dueSoon: false });
      const none = await ask({ alert });

      expect(both.calls[0]?.text).toContain(`WHERE ${late} AND NOT ${soon} ORDER BY`);
      expect(none.calls[0]?.text).not.toContain("WHERE");
    });
  });

  it("searches the description, the contractor's name and the villa number, escaping % _ and a backslash", async () => {
    const { calls } = await ask({ search: "50%_\\x" });

    expect(calls[0]?.text).toContain(
      '(r."description" ILIKE ? OR c."name" ILIKE ? OR v."villaNumber" ILIKE ?)',
    );
    const pattern = "%50\\%\\_\\\\x%";
    expect(calls[0]?.values).toEqual([pattern, pattern, pattern, 20, 40]);
  });

  it.each([
    ["startDate", "asc", 'r."startDate" ASC, r."id" ASC'],
    ["startDate", "desc", 'r."startDate" DESC, r."id" ASC'],
    ["endDate", "asc", 'r."endDate" ASC, r."id" ASC'],
    ["endDate", "desc", 'r."endDate" DESC, r."id" ASC'],
    ["villaNumber", "asc", 'v."villaNumber" COLLATE "asico_natural" ASC, r."endDate" DESC, r."id" ASC'],
    ["villaNumber", "desc", 'v."villaNumber" COLLATE "asico_natural" DESC, r."endDate" DESC, r."id" ASC'],
    ["contractorName", "asc", 'c."name" ASC, r."endDate" DESC, r."id" ASC'],
    ["contractorName", "desc", 'c."name" DESC, r."endDate" DESC, r."id" ASC'],
    ["status", "asc", 'r."status" ASC, r."id" ASC'],
    ["status", "desc", 'r."status" DESC, r."id" ASC'],
    ["createdAt", "asc", 'r."createdAt" ASC, r."id" ASC'],
    ["createdAt", "desc", 'r."createdAt" DESC, r."id" ASC'],
  ] as const)("orders by %s %s as %s, always ending in the id", async (field, direction, order) => {
    const { calls } = await ask({}, sortBy(field, direction));

    expect(calls[0]?.text).toContain(`ORDER BY ${order} LIMIT`);
  });
});

describe("the writes", () => {
  const row = {
    villaId: "v1",
    contractorId: "c1",
    startDate: new Date("2026-03-04T00:00:00.000Z"),
    endDate: new Date("2026-03-06T00:00:00.000Z"),
    description: "Work",
    status: "PENDING" as const,
    createdById: "u1",
  };

  it("writes the row as it is given", async () => {
    const create = vi.fn(async () => ({}));
    const db = { dailySmallWork: { create } } as unknown as Prisma.TransactionClient;

    await repository.create(row, db);

    expect(create).toHaveBeenCalledTimes(1);
    const [{ data }] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toEqual(row);
    expect("qty" in data || "unit" in data).toBe(false);
  });

  it("compares and sets on the version, bumps it, and changes only what is in the patch", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => ({ id: "r1" }));
    const db = { dailySmallWork: { updateMany, findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.update("r1", 4, { description: "Changed" }, db)).toEqual({ id: "r1" });

    const [{ where, data }] = updateMany.mock.calls[0] as unknown as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: "r1", version: 4 });
    expect(data).toMatchObject({ description: "Changed", version: { increment: 1 } });
    expect("status" in data).toBe(false);
  });

  it("answers null when the version moved, and false from delete", async () => {
    const db = {
      dailySmallWork: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.update("r1", 4, { description: "Changed" }, db)).toBeNull();
    expect(await repository.delete("r1", 4, db)).toBe(false);
    expect(db.dailySmallWork.deleteMany).toHaveBeenCalledWith({ where: { id: "r1", version: 4 } });
  });
});

describe("the import's queries", () => {
  it("reads the villas it checks the file against", async () => {
    const villas = [{ id: "v1", villaNumber: "P-1" }];
    const db = { villa: { findMany: vi.fn(async () => villas) } } as unknown as Prisma.TransactionClient;

    expect(await repository.importVillas(db)).toBe(villas);

    expect(db.villa.findMany).toHaveBeenCalledWith({ select: { id: true, villaNumber: true } });
  });

  it("saves the rows in one createMany and returns the ids it made", async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const db = { dailySmallWork: { createMany } } as unknown as Prisma.TransactionClient;
    const row = {
      villaId: "v1",
      contractorId: "c1",
      startDate: new Date("2026-03-04T00:00:00.000Z"),
      endDate: new Date("2026-03-06T00:00:00.000Z"),
      description: "Work",
      status: "PENDING" as const,
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

  it("reads the contractors it checks the file against, with the phone and the status", async () => {
    const contractors = [{ id: "c1", name: "Nile", phone: "0100", status: "ACTIVE" }];
    const db = {
      contractor: { findMany: vi.fn(async () => contractors) },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.importContractors(db)).toBe(contractors);

    expect(db.contractor.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, phone: true, status: true },
    });
  });

  it("reads the status of one contractor, and null for one that is not there", async () => {
    const findUnique = vi.fn(async () => ({ status: "INACTIVE" }));
    const db = { contractor: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.contractorStatus("c1", db)).toBe("INACTIVE");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "c1" }, select: { status: true } });
    findUnique.mockResolvedValueOnce(null as never);
    expect(await repository.contractorStatus("c2", db)).toBeNull();
  });

  it("locks the contractors of an import shared and in the order of their ids, with the status as it is now", async () => {
    const { db, calls } = recorder([
      { id: "c1", status: "ACTIVE" },
      { id: "c2", status: "INACTIVE" },
    ]);

    const locked = await repository.lockContractorsShared(["c1", "c2"], db);

    expect(calls).toEqual([
      {
        text: 'SELECT "id", "status" FROM "Contractor" WHERE "id" IN (?,?) ORDER BY "id" FOR SHARE',
        values: ["c1", "c2"],
      },
    ]);
    expect([...locked]).toEqual([
      ["c1", "ACTIVE"],
      ["c2", "INACTIVE"],
    ]);
    expect(await repository.lockContractorsShared([], db)).toEqual(new Map());
    expect(calls).toHaveLength(1);
  });

  it("asks whether the acting user exists", async () => {
    const findUnique = vi.fn(async () => ({ id: "u1" }));
    const db = { user: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.userExists("u1", db)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { id: true } });
    findUnique.mockResolvedValueOnce(null as never);
    expect(await repository.userExists("u2", db)).toBe(false);
  });
});
