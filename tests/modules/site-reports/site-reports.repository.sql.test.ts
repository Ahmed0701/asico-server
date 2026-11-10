import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Prisma } from "../../../src/generated/prisma/client.js";
import type { SiteReportSort } from "../../../src/modules/site-reports/dto/site-reports.dto.js";
import { SiteReportsRepository } from "../../../src/modules/site-reports/repository/site-reports.repository.js";

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
    siteReport: { findMany },
  } as unknown as Prisma.TransactionClient;
  return { db, calls, findMany };
}

const repository = new SiteReportsRepository();

describe("the site reports' locks", () => {
  it("locks the villa shared, and says whether it is there", async () => {
    const { db, calls } = recorder([{ id: "v1" }]);

    expect(await repository.lockVillaShared("v1", db)).toBe(true);

    expect(calls).toEqual([{ text: 'SELECT "id" FROM "Villa" WHERE "id" = ? FOR SHARE', values: ["v1"] }]);
    expect(await repository.lockVillaShared("v1", recorder([]).db)).toBe(false);
  });

  it("locks the site report row exclusively, and reads its version", async () => {
    const { db, calls } = recorder([{ version: 3 }]);

    expect(await repository.lockVersion("r1", db)).toBe(3);

    expect(calls).toEqual([
      { text: 'SELECT "version" FROM "SiteReport" WHERE "id" = ? FOR UPDATE', values: ["r1"] },
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
  const sortBy = (field: SiteReportSort["field"], direction: "asc" | "desc"): SiteReportSort => ({
    field,
    direction,
  });
  const ask = async (filters = {}, sort = sortBy("visitDate", "desc")) => {
    const client = listClient(["r1"], 7);
    const result = await repository.list({ filters, sort, skip: 40, take: 20 }, client.db);
    return { ...client, result };
  };

  it("pages the ids with LIMIT and OFFSET and counts with the same FROM and WHERE; the enum is cast", async () => {
    const { calls, result, findMany } = await ask({ villaId: "v1", type: "SAFETY", rating: 3 });

    const [page, count] = calls;
    expect(page?.text).toBe(
      'SELECT r."id" FROM "SiteReport" r JOIN "Villa" v ON v."id" = r."villaId" WHERE r."villaId" = ? AND r."type" = ?::"SiteReportType" AND r."rating" = ? ORDER BY r."visitDate" DESC, r."id" ASC LIMIT ? OFFSET ?',
    );
    expect(page?.values).toEqual(["v1", "SAFETY", 3, 20, 40]);
    expect(count?.text).toBe(
      'SELECT count(*)::int AS "total" FROM "SiteReport" r JOIN "Villa" v ON v."id" = r."villaId" WHERE r."villaId" = ? AND r."type" = ?::"SiteReportType" AND r."rating" = ?',
    );
    expect(count?.values).toEqual(["v1", "SAFETY", 3]);
    expect(result.total).toBe(7);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["r1"] } } }));
  });

  it("returns the page in the order of the ids, not the order findMany answers in, and drops a row that is gone", async () => {
    const client = listClient(["r3", "r1", "r2", "r9"], 4);
    // findMany answers in its own order and has no r9: that row was deleted between the two queries.
    client.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }] as never);

    const result = await repository.list(
      { filters: {}, sort: sortBy("visitDate", "desc"), skip: 0, take: 20 },
      client.db,
    );

    expect(result.rows.map((row) => (row as { id: string }).id)).toEqual(["r3", "r1", "r2"]);
    expect(result.total).toBe(4);
  });

  it("has no WHERE without filters, and asks findMany for nothing when the page is empty", async () => {
    const empty = listClient([], 0);

    const result = await repository.list(
      { filters: {}, sort: sortBy("visitDate", "desc"), skip: 0, take: 20 },
      empty.db,
    );

    expect(empty.calls[0]?.text).not.toContain("WHERE");
    expect(result).toEqual({ rows: [], total: 0 });
    expect(empty.findMany).not.toHaveBeenCalled();
  });

  it("filters the day range on the DATE column, both ends included", async () => {
    const { calls } = await ask({
      visitFrom: new Date("2026-03-02T00:00:00.000Z"),
      visitTo: new Date("2026-03-09T00:00:00.000Z"),
    });

    expect(calls[0]?.text).toContain('WHERE r."visitDate" >= ?::date AND r."visitDate" <= ?::date');
    expect(calls[0]?.values).toEqual(["2026-03-02", "2026-03-09", 20, 40]);
  });

  it("filters by a rating of 0 as a filter, not as no filter", async () => {
    const { calls } = await ask({ rating: 0 });

    expect(calls[0]?.text).toContain('WHERE r."rating" = ?');
    expect(calls[0]?.values).toEqual([0, 20, 40]);
  });

  it("searches the title, the inspector and the villa number, escaping % _ and a backslash", async () => {
    const { calls } = await ask({ search: "50%_\\x" });

    expect(calls[0]?.text).toContain(
      '(r."title" ILIKE ? OR r."inspector" ILIKE ? OR v."villaNumber" ILIKE ?)',
    );
    expect(calls[0]?.text).not.toContain("findings");
    expect(calls[0]?.text).not.toContain("recommendations");
    const pattern = "%50\\%\\_\\\\x%";
    expect(calls[0]?.values).toEqual([pattern, pattern, pattern, 20, 40]);
  });

  it.each([
    ["visitDate", "asc", 'r."visitDate" ASC, r."id" ASC'],
    ["visitDate", "desc", 'r."visitDate" DESC, r."id" ASC'],
    ["villaNumber", "asc", 'v."villaNumber" COLLATE "asico_natural" ASC, r."visitDate" DESC, r."id" ASC'],
    ["villaNumber", "desc", 'v."villaNumber" COLLATE "asico_natural" DESC, r."visitDate" DESC, r."id" ASC'],
    ["rating", "asc", 'r."rating" ASC, r."id" ASC'],
    ["rating", "desc", 'r."rating" DESC, r."id" ASC'],
    ["type", "asc", 'r."type" ASC, r."id" ASC'],
    ["type", "desc", 'r."type" DESC, r."id" ASC'],
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
    title: "First fix check",
    visitDate: new Date("2026-03-04T00:00:00.000Z"),
    inspector: "Eng. Hamdy",
    type: "INSPECTION" as const,
    rating: 4,
    findings: "All good",
    recommendations: null,
    createdById: "u1",
  };

  it("creates the row as it is, selecting what the DTO needs", async () => {
    const create = vi.fn(async () => ({}));
    const db = { siteReport: { create } } as unknown as Prisma.TransactionClient;

    await repository.create(row, db);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: row }));
  });

  it("compares and sets on the version, bumps it, and changes only what is in the patch", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => ({ id: "r1" }));
    const db = { siteReport: { updateMany, findUnique } } as unknown as Prisma.TransactionClient;

    expect(await repository.update("r1", 4, { rating: 2, recommendations: null }, db)).toEqual({ id: "r1" });

    const [{ where, data }] = updateMany.mock.calls[0] as unknown as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: "r1", version: 4 });
    expect(data).toMatchObject({ rating: 2, recommendations: null, version: { increment: 1 } });
    expect(data.updatedAt).toBeInstanceOf(Date);
    expect("title" in data).toBe(false);
  });

  it("answers null when the version moved, and false from delete", async () => {
    const db = {
      siteReport: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.update("r1", 4, { rating: 1 }, db)).toBeNull();
    expect(await repository.delete("r1", 4, db)).toBe(false);
    expect(db.siteReport.deleteMany).toHaveBeenCalledWith({ where: { id: "r1", version: 4 } });
  });

  it("answers true from delete when the row was at that version", async () => {
    const db = {
      siteReport: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    } as unknown as Prisma.TransactionClient;

    expect(await repository.delete("r1", 4, db)).toBe(true);
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
    const db = { siteReport: { createMany } } as unknown as Prisma.TransactionClient;
    const row = {
      villaId: "v1",
      title: "Visit",
      visitDate: new Date("2026-03-04T00:00:00.000Z"),
      inspector: "Me",
      type: "SAFETY" as const,
      rating: 1,
      findings: "Bad",
      recommendations: "Fix",
      createdById: "u1",
    };

    const ids = await repository.createMany([row, { ...row, villaId: "v2", rating: 5 }], db);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = createMany.mock.calls[0] as unknown as [
      { data: { id: string; villaId: string; rating: number }[] },
    ];
    expect(data.map((entry) => entry.id)).toEqual(ids);
    expect(data.map((entry) => entry.villaId)).toEqual(["v1", "v2"]);
    expect(data.map((entry) => entry.rating)).toEqual([1, 5]);
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
