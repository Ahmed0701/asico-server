import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { MaintenanceSort } from "../dto/maintenance.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  villaNumber: true,
  location: true,
  handoverDate: true,
  issue: true,
  solvedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaintenanceVillaSelect;

export type MaintenanceRow = Prisma.MaintenanceVillaGetPayload<{ select: typeof select }>;

export type MaintenanceFields = {
  villaNumber?: string;
  location?: string;
  handoverDate?: Date;
  issue?: string;
  solvedAt?: Date | null;
};

type ListParams = {
  search?: string | undefined;
  solved?: boolean | undefined;
  sort: MaintenanceSort;
  skip: number;
  take: number;
};

// The search looks in the villa number, the location and the issue.
function whereOf(search: string | undefined, solved: boolean | undefined): Prisma.MaintenanceVillaWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(solved !== undefined && { solvedAt: solved ? { not: null } : null }),
    ...(term && {
      OR: [
        { villaNumber: { contains: term, mode: "insensitive" } },
        { location: { contains: term, mode: "insensitive" } },
        { issue: { contains: term, mode: "insensitive" } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows that share a value.
function orderByOf({ field, direction }: MaintenanceSort): Prisma.MaintenanceVillaOrderByWithRelationInput[] {
  switch (field) {
    case "villaNumber":
      return [{ villaNumber: direction }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: direction }, { id: "asc" }];
    case "solvedAt":
      return [{ solvedAt: { sort: direction, nulls: "last" } }, { id: "asc" }];
    default:
      return [{ handoverDate: direction }, { villaNumber: "asc" }, { id: "asc" }];
  }
}

export class MaintenanceRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { search, solved, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: MaintenanceRow[]; total: number }> {
    const where = whereOf(search, solved);
    const [rows, total] = await Promise.all([
      db.maintenanceVilla.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.maintenanceVilla.count({ where }),
    ]);
    return { rows, total };
  }

  findById(id: string, db: Db = prisma): Promise<MaintenanceRow | null> {
    return db.maintenanceVilla.findUnique({ where: { id }, select });
  }

  create(
    data: { villaNumber: string; location: string; handoverDate: Date; issue: string },
    db: Db = prisma,
  ): Promise<MaintenanceRow> {
    return db.maintenanceVilla.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "MaintenanceVilla", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: MaintenanceFields,
    db: Db = prisma,
  ): Promise<MaintenanceRow | null> {
    const { count } = await db.maintenanceVilla.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.maintenanceVilla.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.maintenanceVilla.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
