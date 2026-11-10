import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  name: true,
  type: true,
  unit: true,
  sortOrder: true,
  requiredPerVilla: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { lines: true } },
} satisfies Prisma.MaterialItemSelect;

type DbRow = Prisma.MaterialItemGetPayload<{ select: typeof select }>;

// A catalog item with its required quantity as a number (it has at most two decimals).
export type ItemRow = Omit<DbRow, "requiredPerVilla"> & { requiredPerVilla: number };

const fromDb = (row: DbRow): ItemRow => ({ ...row, requiredPerVilla: Number(row.requiredPerVilla) });

export type ItemFields = {
  name?: string;
  type?: FactoryTypeValue;
  unit?: string;
  sortOrder?: number;
  requiredPerVilla?: number;
};

export class ItemsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // The whole catalog (it is short), by type, then in the order a delivery note lists them.
  async list(type: FactoryTypeValue | undefined, db: Db = prisma): Promise<ItemRow[]> {
    const rows = await db.materialItem.findMany({
      where: type ? { type } : {},
      select,
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    });
    return rows.map(fromDb);
  }

  async findById(id: string, db: Db = prisma): Promise<ItemRow | null> {
    const row = await db.materialItem.findUnique({ where: { id }, select });
    return row ? fromDb(row) : null;
  }

  // The item of this type that already has this name, ignoring case (raw SQL, so "_" and "%" are read literally).
  async findByName(type: FactoryTypeValue, name: string, db: Db = prisma): Promise<{ id: string } | null> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "MaterialItem" WHERE "type" = ${type}::"FactoryType" AND lower("name") = lower(${name}) LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  // A new item goes after the others of its type unless it says where.
  async create(
    data: {
      name: string;
      type: FactoryTypeValue;
      unit: string;
      sortOrder?: number | undefined;
      requiredPerVilla?: number | undefined;
    },
    db: Db = prisma,
  ): Promise<ItemRow> {
    const sortOrder =
      data.sortOrder ??
      ((await db.materialItem.aggregate({ where: { type: data.type }, _max: { sortOrder: true } }))._max
        .sortOrder ?? 0) + 10;
    const row = await db.materialItem.create({
      data: {
        name: data.name,
        type: data.type,
        unit: data.unit,
        sortOrder,
        requiredPerVilla: data.requiredPerVilla ?? 1,
      },
      select,
    });
    return fromDb(row);
  }

  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "MaterialItem", id);
  }

  async update(id: string, version: number, data: ItemFields, db: Db = prisma): Promise<ItemRow | null> {
    const { count } = await db.materialItem.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? this.findById(id, db) : null;
  }

  // The villas' own quantities of it go with it (ON DELETE CASCADE).
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.materialItem.deleteMany({ where: { id, version } });
    return count === 1;
  }

  countLines(id: string, db: Db = prisma): Promise<number> {
    return db.materialDeliveryLine.count({ where: { itemId: id } });
  }
}
