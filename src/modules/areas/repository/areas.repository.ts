import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import { MAX_OPTIONS, type AreaSort } from "../dto/areas.dto.js";

export type Db = Prisma.TransactionClient;

// The villa count is never stored: it is counted from the villas that point at the area.
const select = {
  id: true,
  name: true,
  city: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { villas: true } },
} satisfies Prisma.AreaSelect;

export type AreaRow = Prisma.AreaGetPayload<{ select: typeof select }>;

type ListParams = { search?: string | undefined; sort: AreaSort; skip: number; take: number };

// The search looks in the name and the city.
function whereOf(search: string | undefined): Prisma.AreaWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return term
    ? {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { city: { contains: term, mode: "insensitive" } },
        ],
      }
    : {};
}

// `id` breaks ties so pages never repeat or skip rows that share a name, a count or a timestamp.
function orderByOf({ field, direction }: AreaSort): Prisma.AreaOrderByWithRelationInput[] {
  switch (field) {
    case "city":
      return [{ city: direction }, { name: "asc" }, { id: "asc" }];
    case "villaCount":
      return [{ villas: { _count: direction } }, { name: "asc" }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: direction }, { id: "asc" }];
    default:
      return [{ name: direction }, { city: "asc" }, { id: "asc" }];
  }
}

export class AreasRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { search, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: AreaRow[]; total: number }> {
    const where = whereOf(search);
    const [rows, total] = await Promise.all([
      db.area.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.area.count({ where }),
    ]);
    return { rows, total };
  }

  // The areas a form can offer: all of them, by name.
  options(db: Db = prisma): Promise<{ id: string; name: string; city: string }[]> {
    return db.area.findMany({
      select: { id: true, name: true, city: true },
      orderBy: [{ name: "asc" }, { city: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  findById(id: string, db: Db = prisma): Promise<AreaRow | null> {
    return db.area.findUnique({ where: { id }, select });
  }

  // The area that already has this name in this city, ignoring case: the same comparison as the unique index on
  // (lower("name"), lower("city")). Raw SQL because Prisma's case-insensitive match is an ILIKE, which would read "_"
  // and "%" in a name as wildcards.
  async findByNameAndCity(name: string, city: string, db: Db = prisma): Promise<{ id: string } | null> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Area" WHERE lower("name") = lower(${name}) AND lower("city") = lower(${city}) LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  create(data: { name: string; city: string }, db: Db = prisma): Promise<AreaRow> {
    return db.area.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such area).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "Area", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: { name?: string; city?: string },
    db: Db = prisma,
  ): Promise<AreaRow | null> {
    const { count } = await db.area.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.area.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.area.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // How many villas are in this area, which is what makes a delete refuse.
  countVillas(id: string, db: Db = prisma): Promise<number> {
    return db.villa.count({ where: { areaId: id } });
  }
}
