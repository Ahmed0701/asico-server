import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { ExpenseSort, ExpenseType } from "../dto/overhead-expenses.dto.js";

export type Db = Prisma.TransactionClient;

const fileSelect = { id: true, key: true, name: true, mime: true, size: true, uploadedAt: true } as const;

const select = {
  id: true,
  type: true,
  description: true,
  amountMinor: true,
  expenseDate: true,
  invoiceNumber: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  villa: { select: { id: true, villaNumber: true } },
  files: { select: fileSelect, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.OverheadExpenseSelect;

export type ExpenseRow = Prisma.OverheadExpenseGetPayload<{ select: typeof select }>;
export type ExpenseFileRow = Prisma.OverheadExpenseFileGetPayload<{ select: typeof fileSelect }>;
export type NewExpenseFile = Omit<ExpenseFileRow, "id">;

export type ExpenseFields = {
  villaId?: string;
  type?: ExpenseType;
  description?: string;
  amountMinor?: bigint;
  expenseDate?: Date;
  invoiceNumber?: string | null;
};

export type ExpenseFilters = {
  search?: string | undefined;
  villaId?: string | undefined;
  type?: ExpenseType | undefined;
};

function whereOf({ search, villaId, type }: ExpenseFilters): Prisma.OverheadExpenseWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(villaId && { villaId }),
    ...(type && { type }),
    ...(term && {
      OR: [
        { description: { contains: term, mode: "insensitive" } },
        { invoiceNumber: { contains: term, mode: "insensitive" } },
        { villa: { villaNumber: { contains: term, mode: "insensitive" } } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows.
function orderByOf({ field, direction }: ExpenseSort): Prisma.OverheadExpenseOrderByWithRelationInput[] {
  if (field === "amount") return [{ amountMinor: direction }, { id: "asc" }];
  if (field === "villaNumber")
    return [{ villa: { villaNumber: direction } }, { expenseDate: "desc" }, { id: "asc" }];
  if (field === "createdAt") return [{ createdAt: direction }, { id: "asc" }];
  return [{ expenseDate: direction }, { createdAt: direction }, { id: "asc" }];
}

export class OverheadExpensesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    params: ExpenseFilters & { sort: ExpenseSort; skip: number; take: number },
    db: Db = prisma,
  ): Promise<{ rows: ExpenseRow[]; total: number; amount: bigint }> {
    const where = whereOf(params);
    const [rows, total, sum] = await Promise.all([
      db.overheadExpense.findMany({
        where,
        select,
        orderBy: orderByOf(params.sort),
        skip: params.skip,
        take: params.take,
      }),
      db.overheadExpense.count({ where }),
      db.overheadExpense.aggregate({ where, _sum: { amountMinor: true } }),
    ]);
    return { rows, total, amount: sum._sum.amountMinor ?? 0n };
  }

  findById(id: string, db: Db = prisma): Promise<ExpenseRow | null> {
    return db.overheadExpense.findUnique({ where: { id }, select });
  }

  async villaExists(villaId: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.count({ where: { id: villaId } })) > 0;
  }

  create(
    data: Required<Omit<ExpenseFields, "invoiceNumber">> & { invoiceNumber: string | null },
    db: Db,
  ): Promise<ExpenseRow> {
    return db.overheadExpense.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "OverheadExpense", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps it. Null: it was not.
  async update(id: string, version: number, data: ExpenseFields, db: Db): Promise<ExpenseRow | null> {
    const { count } = await db.overheadExpense.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.overheadExpense.findUnique({ where: { id }, select }) : null;
  }

  // The files go with it (cascade).
  async delete(id: string, version: number, db: Db): Promise<boolean> {
    const { count } = await db.overheadExpense.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async addFiles(expenseId: string, files: readonly NewExpenseFile[], db: Db): Promise<void> {
    await db.overheadExpenseFile.createMany({ data: files.map((file) => ({ ...file, expenseId })) });
  }

  countFiles(expenseId: string, db: Db): Promise<number> {
    return db.overheadExpenseFile.count({ where: { expenseId } });
  }

  findFile(expenseId: string, fileId: string, db: Db = prisma): Promise<ExpenseFileRow | null> {
    return db.overheadExpenseFile.findFirst({ where: { id: fileId, expenseId }, select: fileSelect });
  }

  async deleteFile(fileId: string, db: Db): Promise<void> {
    await db.overheadExpenseFile.delete({ where: { id: fileId } });
  }
}

// How many additional expenses a villa has: a villa with any is not deleted.
export function countOverheadExpensesOfVilla(villaId: string, db: Db): Promise<number> {
  return db.overheadExpense.count({ where: { villaId } });
}
