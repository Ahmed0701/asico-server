import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";

export type Db = Prisma.TransactionClient;

export type PhaseStatusCount = { elecPhaseId: string; status: string; count: number };

export class DashboardChartsRepository {
  // The active electrical phases, in display order.
  activePhases(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.elecPhase.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  }

  // How many open works each phase has in each status.
  async phaseStatusCounts(db: Db = prisma): Promise<PhaseStatusCount[]> {
    const rows = await db.workItem.groupBy({ by: ["elecPhaseId", "status"], _count: { _all: true } });
    return rows.map((row) => ({ elecPhaseId: row.elecPhaseId, status: row.status, count: row._count._all }));
  }

  // The workers of each day from `from` (a UTC day) on, all villas together. Days without labour are missing.
  async labourByDay(from: Date, db: Db = prisma): Promise<{ day: Date; workers: number }[]> {
    const rows = await db.dailyLabour.groupBy({
      by: ["labourDate"],
      where: { labourDate: { gte: from } },
      _sum: { labourCount: true },
    });
    return rows.map((row) => ({ day: row.labourDate, workers: row._sum.labourCount ?? 0 }));
  }

  // What was paid in each month (by paid date) from `from` (the first day of a month) on, KWD fils.
  async paidByMonth(from: Date, db: Db = prisma): Promise<{ month: string; paid: bigint }[]> {
    return db.$queryRaw<{ month: string; paid: bigint }[]>(
      Prisma.sql`SELECT to_char(date_trunc('month', "paidDate"), 'YYYY-MM') AS "month",
          COALESCE(sum("amountMinor"), 0)::bigint AS "paid"
        FROM "ContractorPayment"
        WHERE "status" = 'PAID' AND "paidDate" >= ${from}::date
        GROUP BY 1`,
    );
  }
}
