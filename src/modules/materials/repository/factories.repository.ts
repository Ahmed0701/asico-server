import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  name: true,
  type: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { deliveries: true } },
} satisfies Prisma.FactorySelect;

export type FactoryRow = Prisma.FactoryGetPayload<{ select: typeof select }>;

export class FactoriesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // Every factory (the list is short), by type and name.
  list(type: FactoryTypeValue | undefined, db: Db = prisma): Promise<FactoryRow[]> {
    return db.factory.findMany({
      where: type ? { type } : {},
      select,
      orderBy: [{ type: "asc" }, { name: "asc" }, { id: "asc" }],
    });
  }

  findById(id: string, db: Db = prisma): Promise<FactoryRow | null> {
    return db.factory.findUnique({ where: { id }, select });
  }

  // The factory of this type that already has this name, ignoring case. Raw SQL: Prisma's case-insensitive match is an
  // ILIKE, which would read "_" and "%" in a name as wildcards.
  async findByName(type: FactoryTypeValue, name: string, db: Db = prisma): Promise<{ id: string } | null> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Factory" WHERE "type" = ${type}::"FactoryType" AND lower("name") = lower(${name}) LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  create(data: { name: string; type: FactoryTypeValue }, db: Db = prisma): Promise<FactoryRow> {
    return db.factory.create({ data, select });
  }

  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "Factory", id);
  }

  // Compare-and-set on the version. Null: the row was not at `version` any more.
  async update(
    id: string,
    version: number,
    data: { name?: string; type?: FactoryTypeValue },
    db: Db = prisma,
  ): Promise<FactoryRow | null> {
    const { count } = await db.factory.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.factory.findUnique({ where: { id }, select }) : null;
  }

  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.factory.deleteMany({ where: { id, version } });
    return count === 1;
  }

  countDeliveries(id: string, db: Db = prisma): Promise<number> {
    return db.materialDelivery.count({ where: { factoryId: id } });
  }
}
