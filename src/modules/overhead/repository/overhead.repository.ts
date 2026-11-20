import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { OverheadSort } from "../dto/overhead.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  name: true,
  role: true,
  salaryMinor: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OverheadEmployeeSelect;

export type OverheadRow = Prisma.OverheadEmployeeGetPayload<{ select: typeof select }>;

export type OverheadFields = { name?: string; role?: string; salaryMinor?: bigint };

function whereOf(search: string | undefined): Prisma.OverheadEmployeeWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return term
    ? {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { role: { contains: term, mode: "insensitive" } },
        ],
      }
    : {};
}

// `id` breaks ties so pages never repeat or skip rows.
function orderByOf({ field, direction }: OverheadSort): Prisma.OverheadEmployeeOrderByWithRelationInput[] {
  if (field === "salary") return [{ salaryMinor: direction }, { id: "asc" }];
  if (field === "role") return [{ role: direction }, { name: "asc" }, { id: "asc" }];
  if (field === "createdAt") return [{ createdAt: direction }, { id: "asc" }];
  return [{ name: direction }, { id: "asc" }];
}

export class OverheadRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    params: { search?: string | undefined; sort: OverheadSort; skip: number; take: number },
    db: Db = prisma,
  ): Promise<{ rows: OverheadRow[]; total: number; salaries: bigint }> {
    const where = whereOf(params.search);
    const [rows, total, sum] = await Promise.all([
      db.overheadEmployee.findMany({
        where,
        select,
        orderBy: orderByOf(params.sort),
        skip: params.skip,
        take: params.take,
      }),
      db.overheadEmployee.count({ where }),
      db.overheadEmployee.aggregate({ where, _sum: { salaryMinor: true } }),
    ]);
    return { rows, total, salaries: sum._sum.salaryMinor ?? 0n };
  }

  findById(id: string, db: Db = prisma): Promise<OverheadRow | null> {
    return db.overheadEmployee.findUnique({ where: { id }, select });
  }

  create(data: Required<OverheadFields>, db: Db = prisma): Promise<OverheadRow> {
    return db.overheadEmployee.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "OverheadEmployee", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps it. Null: it was not.
  async update(id: string, version: number, data: OverheadFields, db: Db): Promise<OverheadRow | null> {
    const { count } = await db.overheadEmployee.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.overheadEmployee.findUnique({ where: { id }, select }) : null;
  }

  async delete(id: string, version: number, db: Db): Promise<boolean> {
    const { count } = await db.overheadEmployee.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
