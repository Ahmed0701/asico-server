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

export class MonthlyProgressRepository {
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
}
