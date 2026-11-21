import { prisma } from "../../../core/database/prisma.js";
import { andVillaScope } from "../../../core/scope/villa-scope.js";
import { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

const financeSelect = {
  workOrderMinor: true,
  salaryShareBp: true,
  materialsMinor: true,
  pettyCashMinor: true,
  version: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const;

const villaSelect = {
  id: true,
  villaNumber: true,
  block: true,
  plot: true,
  budgetMinor: true,
  currency: true,
  area: { select: { name: true } },
  finance: { select: financeSelect },
} as const;

export type FinanceRow = Prisma.VillaFinanceGetPayload<{ select: typeof financeSelect }>;
type VillaRow = Prisma.VillaGetPayload<{ select: typeof villaSelect }>;

// A villa's money: its budget, its finance row (null before anything was saved), its variation orders added up, and
// the Department Overhead monthly salaries (all employees), which its salary share is a part of.
export type VillaMoneyRow = VillaRow & {
  variationOrdersMinor: bigint;
  overheadSalariesMinor: bigint;
  // The villa's additional expenses (Department Overhead) added up.
  expensesMinor: bigint;
};

export type FinanceFields = {
  workOrderMinor?: bigint | null;
  salaryShareBp?: number | null;
  materialsMinor?: bigint | null;
  pettyCashMinor?: bigint | null;
};

export class VillaFinanceRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // Null: no such villa.
  async find(villaId: string, db: Db = prisma): Promise<VillaMoneyRow | null> {
    const [villa, vo, overhead, expenses] = await Promise.all([
      db.villa.findUnique({ where: { id: villaId }, select: villaSelect }),
      db.variationOrder.aggregate({ where: { villaId }, _sum: { amountMinor: true } }),
      this.overheadSalaries(db),
      db.overheadExpense.aggregate({ where: { villaId }, _sum: { amountMinor: true } }),
    ]);
    return (
      villa && {
        ...villa,
        variationOrdersMinor: vo._sum.amountMinor ?? 0n,
        overheadSalariesMinor: overhead,
        expensesMinor: expenses._sum.amountMinor ?? 0n,
      }
    );
  }

  // Every villa with its money (the Projects Budgets page: a few thousand rows at most).
  async all(db: Db = prisma): Promise<VillaMoneyRow[]> {
    const [villas, sums, overhead, expenses] = await Promise.all([
      db.villa.findMany({ select: villaSelect }),
      db.variationOrder.groupBy({ by: ["villaId"], _sum: { amountMinor: true } }),
      this.overheadSalaries(db),
      db.overheadExpense.groupBy({ by: ["villaId"], _sum: { amountMinor: true } }),
    ]);
    const byVilla = new Map(sums.map((row) => [row.villaId, row._sum.amountMinor ?? 0n]));
    const expensesByVilla = new Map(expenses.map((row) => [row.villaId, row._sum.amountMinor ?? 0n]));
    return villas.map((villa) => ({
      ...villa,
      variationOrdersMinor: byVilla.get(villa.id) ?? 0n,
      overheadSalariesMinor: overhead,
      expensesMinor: expensesByVilla.get(villa.id) ?? 0n,
    }));
  }

  // The Department Overhead monthly salaries added up (every employee).
  async overheadSalaries(db: Db = prisma): Promise<bigint> {
    const sum = await db.overheadEmployee.aggregate({ _sum: { salaryMinor: true } });
    return sum._sum.salaryMinor ?? 0n;
  }

  // Every villa's salary share added up, in hundredths of a percent, leaving one villa out.
  async sharesOfOthers(villaId: string, db: Db): Promise<number> {
    const sum = await db.villaFinance.aggregate({
      where: { villaId: { not: villaId } },
      _sum: { salaryShareBp: true },
    });
    return sum._sum.salaryShareBp ?? 0;
  }

  // Saves of a salary share take turns (across villas), so two villas cannot together go over 100%.
  async lockShares(db: Db): Promise<void> {
    await db.$queryRaw(
      Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext('VillaFinance.salaryShareBp'))`,
    );
  }

  // Locks the villa (a save of its budget changes it) and the finance row, if there is one, for the rest of the
  // transaction. Two saves of one villa take turns. False: no such villa.
  async lock(villaId: string, db: Db): Promise<boolean> {
    const villa = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId}${andVillaScope("Villa")} FOR UPDATE`,
    );
    if (villa.length === 0) return false;
    await db.$queryRaw(
      Prisma.sql`SELECT "villaId" FROM "VillaFinance" WHERE "villaId" = ${villaId} FOR UPDATE`,
    );
    return true;
  }

  // The villa's budget, in KWD (null clears it and its currency). The villa's version moves on, so a villa form open
  // elsewhere learns the villa changed.
  async saveBudget(villaId: string, budgetMinor: bigint | null, db: Db): Promise<void> {
    await db.villa.update({
      where: { id: villaId },
      data: { budgetMinor, currency: budgetMinor === null ? null : "KWD", version: { increment: 1 } },
    });
  }

  // Makes the row (version 1) or changes it (the next version); the caller holds the locks and checked the version.
  async save(
    villaId: string,
    data: FinanceFields,
    updatedById: string,
    exists: boolean,
    db: Db,
  ): Promise<void> {
    if (exists) {
      await db.villaFinance.update({
        where: { villaId },
        data: { ...data, updatedById, version: { increment: 1 } },
      });
    } else {
      await db.villaFinance.create({ data: { villaId, ...data, updatedById } });
    }
  }
}
