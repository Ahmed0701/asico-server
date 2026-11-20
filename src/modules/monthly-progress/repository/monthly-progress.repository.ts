import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { WORK_PHASE_PROGRESS } from "../../villa-progress/repository/progress-rows.js";
import type { PhaseRatio, WorkEvent, WorkNow } from "../service/progress-history.js";

export type Db = Prisma.TransactionClient;

export type MonthlyVillaRow = {
  id: string;
  villaNumber: string;
  block: string;
  plot: string;
  createdAt: Date;
  area: { name: string };
  contractor: { id: string; name: string } | null;
  // The villa's Work Order Value (its budget figures), KWD fils; null when not entered.
  finance: { workOrderMinor: bigint | null } | null;
};

type EventRow = {
  entityId: string;
  action: WorkEvent["action"];
  createdAt: Date;
  bVilla: string | null;
  bPhase: string | null;
  bProgress: number | null;
  aVilla: string | null;
  aPhase: string | null;
  aProgress: number | null;
};

const EVENT_ACTIONS = ["open_work.create", "open_work.update", "open_work.delete"] as const;

const paymentSelect = {
  id: true,
  villaId: true,
  ratioTenths: true,
  amountMinor: true,
  workOrderMinor: true,
  paidAt: true,
  contractor: { select: { id: true, name: true } },
  paidBy: { select: { id: true, name: true } },
  manual: true,
  note: true,
} satisfies Prisma.ProgressPaymentSelect;

export type PaymentRow = Prisma.ProgressPaymentGetPayload<{ select: typeof paymentSelect }>;

export type NewPayment = {
  villaId: string;
  contractorId: string | null;
  ratioTenths: number;
  amountMinor: bigint;
  workOrderMinor: bigint;
  paidById: string;
  paidAt?: Date;
  manual?: boolean;
  note?: string | null;
};

// The newest payment of a villa first: the next amount due starts from it.
const LATEST: Prisma.ProgressPaymentOrderByWithRelationInput[] = [{ paidAt: "desc" }, { id: "desc" }];

export class MonthlyProgressRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout?: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  villas(db: Db = prisma): Promise<MonthlyVillaRow[]> {
    return db.villa.findMany({
      select: {
        id: true,
        villaNumber: true,
        block: true,
        plot: true,
        createdAt: true,
        area: { select: { name: true } },
        contractor: { select: { id: true, name: true } },
        finance: { select: { workOrderMinor: true } },
      },
    });
  }

  activePhases(db: Db = prisma): Promise<PhaseRatio[]> {
    return db.elecPhase.findMany({ where: { status: "ACTIVE" }, select: { id: true, progressRatio: true } });
  }

  // The average progress of each villa's open works under each phase, as they are now: one row a villa and phase.
  async currentPhaseAverages(
    db: Db = prisma,
  ): Promise<{ villaId: string; elecPhaseId: string; progress: number }[]> {
    const rows = await db.$queryRaw<{ villaId: string; elecPhaseId: string; progress: number }[]>(
      Prisma.sql`SELECT wp."villaId", wp."elecPhaseId", wp."progress"::float8 AS "progress" FROM ${WORK_PHASE_PROGRESS()} wp`,
    );
    return rows.map((row) => ({ ...row, progress: Number(row.progress) }));
  }

  works(db: Db = prisma): Promise<WorkNow[]> {
    return db.workItem.findMany({
      select: { id: true, villaId: true, elecPhaseId: true, progress: true, createdAt: true },
    });
  }

  // Every audited create, edit and delete of an open work, oldest first.
  // Only the three values the rebuild needs are read out of each snapshot (in SQL), not the whole JSON: on a large log
  // that is most of the time this page takes.
  async workEvents(db: Db = prisma): Promise<WorkEvent[]> {
    const rows = await db.$queryRaw<EventRow[]>(
      Prisma.sql`SELECT "entityId", "action", "createdAt",
          "before"->>'villaId' AS "bVilla", "before"->>'elecPhaseId' AS "bPhase",
          CASE WHEN jsonb_typeof("before"->'progress') = 'number' THEN ("before"->>'progress')::float8 END AS "bProgress",
          "after"->>'villaId' AS "aVilla", "after"->>'elecPhaseId' AS "aPhase",
          CASE WHEN jsonb_typeof("after"->'progress') = 'number' THEN ("after"->>'progress')::float8 END AS "aProgress"
        FROM "AuditLog"
        WHERE "entity" = 'WorkItem' AND "entityId" IS NOT NULL
          AND "action" IN (${Prisma.join([...EVENT_ACTIONS])})
        ORDER BY "createdAt", "id"`,
    );
    const snapshot = (villaId: string | null, elecPhaseId: string | null, progress: number | null) =>
      villaId !== null && elecPhaseId !== null && progress !== null
        ? { villaId, elecPhaseId, progress }
        : null;
    return rows.map((row) => ({
      entityId: row.entityId,
      action: row.action,
      createdAt: row.createdAt,
      before: snapshot(row.bVilla, row.bPhase, row.bProgress),
      after: snapshot(row.aVilla, row.aPhase, row.aProgress),
    }));
  }

  // The latest payment of every villa that has one.
  async latestPayments(db: Db = prisma): Promise<Map<string, PaymentRow>> {
    const rows = await db.progressPayment.findMany({
      select: paymentSelect,
      distinct: ["villaId"],
      orderBy: [{ villaId: "asc" }, ...LATEST],
    });
    return new Map(rows.map((row) => [row.villaId, row]));
  }

  latestPayment(villaId: string, db: Db = prisma): Promise<PaymentRow | null> {
    return db.progressPayment.findFirst({ where: { villaId }, select: paymentSelect, orderBy: LATEST });
  }

  // Every payment of a villa, the latest first.
  paymentsOfVilla(villaId: string, db: Db = prisma): Promise<PaymentRow[]> {
    return db.progressPayment.findMany({ where: { villaId }, select: paymentSelect, orderBy: LATEST });
  }

  // The villa's number and Work Order Value; null: no such villa.
  async villaForHistory(
    villaId: string,
    db: Db = prisma,
  ): Promise<{ villaNumber: string; workOrderMinor: bigint | null } | null> {
    const villa = await db.villa.findUnique({
      where: { id: villaId },
      select: { villaNumber: true, finance: { select: { workOrderMinor: true } } },
    });
    if (!villa) return null;
    return { villaNumber: villa.villaNumber, workOrderMinor: villa.finance?.workOrderMinor ?? null };
  }

  // The payments just before and just after a day, by date: a payment entered for that day must fit between them.
  async neighbours(
    villaId: string,
    paidAt: Date,
    db: Db,
  ): Promise<{ before: PaymentRow | null; after: PaymentRow | null }> {
    const [before, after] = await Promise.all([
      db.progressPayment.findFirst({
        where: { villaId, paidAt: { lte: paidAt } },
        select: paymentSelect,
        orderBy: LATEST,
      }),
      db.progressPayment.findFirst({
        where: { villaId, paidAt: { gt: paidAt } },
        select: paymentSelect,
        orderBy: [{ paidAt: "asc" }, { id: "asc" }],
      }),
    ]);
    return { before, after };
  }

  // For an import: every villa with its contractor and Work Order Value, and every contractor.
  async importVillas(
    db: Db = prisma,
  ): Promise<
    { id: string; villaNumber: string; contractorId: string | null; workOrderMinor: bigint | null }[]
  > {
    const villas = await db.villa.findMany({
      select: {
        id: true,
        villaNumber: true,
        contractorId: true,
        finance: { select: { workOrderMinor: true } },
      },
      orderBy: { villaNumber: "asc" },
    });
    return villas.map((villa) => ({
      id: villa.id,
      villaNumber: villa.villaNumber,
      contractorId: villa.contractorId,
      workOrderMinor: villa.finance?.workOrderMinor ?? null,
    }));
  }

  async importContractors(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.contractor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  }

  // The payments already stored for these villas: the ratio each paid up to, and when.
  storedRatios(
    villaIds: string[],
    db: Db,
  ): Promise<{ villaId: string; ratioTenths: number; paidAt: Date }[]> {
    return db.progressPayment.findMany({
      where: { villaId: { in: villaIds } },
      select: { villaId: true, ratioTenths: true, paidAt: true },
    });
  }

  async contractorExists(id: string, db: Db): Promise<boolean> {
    return (await db.contractor.count({ where: { id } })) > 0;
  }

  findPayment(id: string, db: Db = prisma): Promise<PaymentRow | null> {
    return db.progressPayment.findUnique({ where: { id }, select: paymentSelect });
  }

  // When one of each villa's open works last changed.
  async lastUpdates(db: Db = prisma): Promise<Map<string, Date>> {
    const rows = await db.workItem.groupBy({ by: ["villaId"], _max: { updatedAt: true } });
    return new Map(rows.flatMap((row) => (row._max.updatedAt ? [[row.villaId, row._max.updatedAt]] : [])));
  }

  // The villa a payment is for: its contractor and Work Order Value. Locked for the rest of the transaction, so two
  // payments of one villa take turns (the second sees the first). Null: no such villa.
  async lockVillaForPayment(
    villaId: string,
    db: Db,
  ): Promise<{ villaNumber: string; contractorId: string | null; workOrderMinor: bigint | null } | null> {
    const locked = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${villaId} FOR UPDATE`,
    );
    if (locked.length === 0) return null;
    const villa = await db.villa.findUnique({
      where: { id: villaId },
      select: { villaNumber: true, contractorId: true, finance: { select: { workOrderMinor: true } } },
    });
    if (!villa) return null;
    return {
      villaNumber: villa.villaNumber,
      contractorId: villa.contractorId,
      workOrderMinor: villa.finance?.workOrderMinor ?? null,
    };
  }

  createPayment(data: NewPayment, db: Db): Promise<PaymentRow> {
    return db.progressPayment.create({ data, select: paymentSelect });
  }

  async deletePayment(id: string, db: Db): Promise<void> {
    await db.progressPayment.delete({ where: { id } });
  }
}

// How many progress payments a villa has: a villa with any is not deleted.
export function countProgressPaymentsOfVilla(villaId: string, db: Db): Promise<number> {
  return db.progressPayment.count({ where: { villaId } });
}
