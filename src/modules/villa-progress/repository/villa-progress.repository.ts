import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { PHASE_DONE_RATIO } from "./progress-rows.js";

export type Db = Prisma.TransactionClient;

export type ProgressRow = {
  villaId: string;
  elecPhaseId: string;
  progress: number;
  completedAt: Date | null;
  version: number;
};

export type PhaseRow = { id: string; name: string; sortOrder: number; status: "ACTIVE" | "INACTIVE" };

export class VillaProgressRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  // LOCK ORDER, FIRST: the villa, shared until the transaction ends. A change of the villa's contractor holds it
  // exclusively, so the two take turns; progress updates of one villa do not wait for each other here (see
  // shared/constants/locks.ts). False: there is no such villa.
  async lockVilla(id: string, db: Db): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" = ${id} FOR SHARE`,
    );
    return rows.length === 1;
  }

  // LOCK ORDER, SECOND: the phase, shared until the transaction ends. Deactivating, renaming or deleting the phase holds
  // it exclusively, so an update never runs against a phase that is changing under it (and the open work it may make
  // never points at a phase that is being deleted). Null: there is no such phase.
  async lockPhase(id: string, db: Db): Promise<PhaseRow | null> {
    const rows = await db.$queryRaw<PhaseRow[]>(
      Prisma.sql`SELECT "id", "name", "sortOrder", "status" FROM "ElecPhase" WHERE "id" = ${id} FOR SHARE`,
    );
    return rows[0] ?? null;
  }

  // LOCK ORDER, THIRD: the progress row, exclusively. A row that is missing (it should always exist) is
  // created at 0 first, so an update never fails for want of it.
  async lockRow(villaId: string, elecPhaseId: string, db: Db): Promise<ProgressRow> {
    const read = async (): Promise<ProgressRow | undefined> =>
      (
        await db.$queryRaw<ProgressRow[]>(
          Prisma.sql`SELECT "villaId", "elecPhaseId", "progress", "completedAt", "version" FROM "VillaPhaseProgress"
            WHERE "villaId" = ${villaId} AND "elecPhaseId" = ${elecPhaseId} FOR UPDATE`,
        )
      )[0];
    const found = await read();
    if (found) {
      return found;
    }
    await db.villaPhaseProgress.createMany({ data: [{ villaId, elecPhaseId }], skipDuplicates: true });
    const created = await read();
    if (!created) {
      throw new Error("the progress row could not be created");
    }
    return created;
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    villaId: string,
    elecPhaseId: string,
    version: number,
    data: { progress: number; completedAt: Date | null },
    db: Db,
  ): Promise<ProgressRow | null> {
    const { count } = await db.villaPhaseProgress.updateMany({
      where: { villaId, elecPhaseId, version },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (count !== 1) {
      return null;
    }
    return db.villaPhaseProgress.findUnique({
      where: { villaId_elecPhaseId: { villaId, elecPhaseId } },
      select: { villaId: true, elecPhaseId: true, progress: true, completedAt: true, version: true },
    });
  }

  // What the villa's done active phases add up to (PHASE_DONE_RATIO: a phase counts once the villa's open work for it is
  // done), and how many active phases there are.
  async totals(villaId: string, db: Db): Promise<{ doneRatio: number; count: number }> {
    const rows = await db.$queryRaw<{ doneRatio: number; count: number }[]>(
      Prisma.sql`SELECT COALESCE(sum(${PHASE_DONE_RATIO}), 0)::int AS "doneRatio", count(ph."id")::int AS "count"
        FROM "ElecPhase" ph
        CROSS JOIN (SELECT ${villaId}::text AS "id") v
        WHERE ph."status" = 'ACTIVE'`,
    );
    return rows[0] ?? { doneRatio: 0, count: 0 };
  }
}
