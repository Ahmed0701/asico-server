import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: {} }));

import { MAX_OPTIONS } from "../../../src/modules/areas/dto/areas.dto.js";
import { AreasRepository, type Db } from "../../../src/modules/areas/repository/areas.repository.js";

// The route and service tests run against an in-memory fake, so these check the real repository's queries.
function fakeDb() {
  const calls: Record<string, unknown[][]> = {};
  const counts = { updateMany: 1, deleteMany: 1 };
  const record =
    (name: string, result: () => unknown) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(result());
    };
  const db = {
    area: {
      findMany: record("findMany", () => []),
      count: record("count", () => 0),
      findUnique: record("findUnique", () => null),
      create: record("create", () => ({})),
      updateMany: record("updateMany", () => ({ count: counts.updateMany })),
      deleteMany: record("deleteMany", () => ({ count: counts.deleteMany })),
    },
    villa: { count: record("villaCount", () => 4) },
    $queryRaw: record("queryRaw", () => [{ id: "a1" }]),
  };
  return { db: db as unknown as Db, calls, counts };
}

type Query = {
  select?: Record<string, unknown>;
  where?: { OR?: { name: { contains: string } }[] };
  orderBy?: unknown;
  skip?: number;
  take?: number;
};
const first = (calls: Record<string, unknown[][]>, name: string) => (calls[name]?.[0]?.[0] ?? {}) as Query;
const repository = new AreasRepository();
const sort = { field: "name", direction: "asc" } as const;

describe("AreasRepository: the villa count", () => {
  it("is counted from the villas of the area, never read from a column", async () => {
    const { db, calls } = fakeDb();

    await repository.list({ sort, skip: 0, take: 20 }, db);

    expect(first(calls, "findMany").select).toMatchObject({ _count: { select: { villas: true } } });
    expect(first(calls, "findMany").select).not.toHaveProperty("villaCount");
  });

  it("countVillas counts the villas whose areaId is this area", async () => {
    const { db, calls } = fakeDb();

    expect(await repository.countVillas("a1", db)).toBe(4);
    expect(first(calls, "villaCount")).toEqual({ where: { areaId: "a1" } });
  });
});

describe("AreasRepository: search", () => {
  it("looks in the name and the city, ignoring case", async () => {
    const { db, calls } = fakeDb();

    await repository.list({ search: "cairo", sort, skip: 0, take: 20 }, db);

    expect(first(calls, "findMany").where).toEqual({
      OR: [
        { name: { contains: "cairo", mode: "insensitive" } },
        { city: { contains: "cairo", mode: "insensitive" } },
      ],
    });
    expect(first(calls, "count").where).toEqual(first(calls, "findMany").where);
  });

  it("escapes % and _ so they are plain characters", async () => {
    const { db, calls } = fakeDb();

    await repository.list({ search: "50%_off", sort, skip: 0, take: 20 }, db);

    expect(first(calls, "findMany").where?.OR?.[0]?.name.contains).toBe("50\\%\\_off");
  });

  it("has no filter without a search", async () => {
    const { db, calls } = fakeDb();

    await repository.list({ sort, skip: 0, take: 20 }, db);

    expect(first(calls, "findMany").where).toEqual({});
  });
});

describe("AreasRepository: order and paging", () => {
  it.each([
    ["name", "desc", [{ name: "desc" }, { city: "asc" }, { id: "asc" }]],
    ["city", "desc", [{ city: "desc" }, { name: "asc" }, { id: "asc" }]],
    ["villaCount", "desc", [{ villas: { _count: "desc" } }, { name: "asc" }, { id: "asc" }]],
    ["createdAt", "asc", [{ createdAt: "asc" }, { id: "asc" }]],
  ] as const)("sorts by %s %s with id as the last tie-breaker", async (field, direction, orderBy) => {
    const { db, calls } = fakeDb();

    await repository.list({ sort: { field, direction }, skip: 40, take: 20 }, db);

    expect(first(calls, "findMany").orderBy).toEqual(orderBy);
    expect(first(calls, "findMany")).toMatchObject({ skip: 40, take: 20 });
  });
});

describe("AreasRepository: options", () => {
  it("returns id, name and city, by name, capped", async () => {
    const { db, calls } = fakeDb();

    await repository.options(db);

    expect(first(calls, "findMany")).toEqual({
      select: { id: true, name: true, city: true },
      orderBy: [{ name: "asc" }, { city: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  });
});

describe("AreasRepository: writes", () => {
  it("changes a row only while it is at the version that was read, and bumps the version", async () => {
    const { db, calls } = fakeDb();

    await repository.update("a1", 3, { name: "New" }, db);

    expect(first(calls, "updateMany")).toEqual({
      where: { id: "a1", version: 3 },
      data: { name: "New", version: { increment: 1 } },
    });
  });

  it("answers null when the row had moved on", async () => {
    const { db, counts } = fakeDb();
    counts.updateMany = 0;

    expect(await repository.update("a1", 3, { name: "New" }, db)).toBeNull();
  });

  it("deletes a row only while it is at the version that was read", async () => {
    const { db, calls, counts } = fakeDb();

    expect(await repository.delete("a1", 3, db)).toBe(true);
    expect(first(calls, "deleteMany")).toEqual({ where: { id: "a1", version: 3 } });
    counts.deleteMany = 0;
    expect(await repository.delete("a1", 3, db)).toBe(false);
  });
});

describe("AreasRepository: the name lookup", () => {
  it("compares name and city lower-cased, the same as the unique index", async () => {
    const { db, calls } = fakeDb();

    expect(await repository.findByNameAndCity("New Cairo", "Cairo", db)).toEqual({ id: "a1" });

    const query = calls["queryRaw"]?.[0]?.[0] as { strings?: string[]; values?: unknown[]; sql?: string };
    const text = (query.strings ?? [query.sql ?? ""]).join("?");
    expect(text).toContain('lower("name") = lower(');
    expect(text).toContain('lower("city") = lower(');
    expect(query.values).toEqual(["New Cairo", "Cairo"]);
  });
});
