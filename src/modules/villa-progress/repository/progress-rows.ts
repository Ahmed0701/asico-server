import { Prisma } from "../../../generated/prisma/client.js";
import { PHASE_SET_LOCK } from "../../../shared/constants/locks.js";

// What the villas and the elec phases need from the progress table, as functions of a transaction. One row exists for
// every villa and every phase, active or not.

type Db = Prisma.TransactionClient;

// Makes creating a villa, creating a phase, reordering and deleting a phase take turns, until the transaction ends. A
// villa created while a phase is being created would otherwise miss the phase's row (and the phase the villa's).
export async function lockPhaseSet(db: Db): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PHASE_SET_LOCK}))`;
}

// A row at 0 for each phase, for a villa that was just created. Call lockPhaseSet first.
export async function insertRowsForVilla(villaId: string, db: Db): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`INSERT INTO "VillaPhaseProgress" ("villaId", "elecPhaseId", "progress", "version", "updatedAt")
      SELECT ${villaId}, ph."id", 0, 1, now() FROM "ElecPhase" ph
      ON CONFLICT DO NOTHING`,
  );
}

// A row at 0 for every phase, for each of several villas that were just created, in one statement. Call lockPhaseSet first.
export async function insertRowsForVillas(villaIds: readonly string[], db: Db): Promise<void> {
  if (villaIds.length === 0) {
    return;
  }
  await db.$executeRaw(
    Prisma.sql`INSERT INTO "VillaPhaseProgress" ("villaId", "elecPhaseId", "progress", "version", "updatedAt")
      SELECT v."id", ph."id", 0, 1, now() FROM "Villa" v CROSS JOIN "ElecPhase" ph
      WHERE v."id" = ANY (${[...villaIds]}::text[])
      ON CONFLICT DO NOTHING`,
  );
}

// A row at 0 for each villa, for a phase that was just created. Call lockPhaseSet first.
export async function insertRowsForPhase(phaseId: string, db: Db): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`INSERT INTO "VillaPhaseProgress" ("villaId", "elecPhaseId", "progress", "version", "updatedAt")
      SELECT v."id", ${phaseId}, 0, 1, now() FROM "Villa" v
      ON CONFLICT DO NOTHING`,
  );
}

// How many villas have got somewhere in this phase (progress above 0): what makes a phase "in use".
export async function countRowsInProgress(phaseId: string, db: Db): Promise<number> {
  return db.villaPhaseProgress.count({ where: { elecPhaseId: phaseId, progress: { gt: 0 } } });
}

// Removes the rows of a phase that are still at 0, so the phase can be deleted. A row above 0 stays, and the foreign
// key then refuses the delete.
export async function deleteRowsAtZero(phaseId: string, db: Db): Promise<void> {
  await db.villaPhaseProgress.deleteMany({ where: { elecPhaseId: phaseId, progress: 0 } });
}

// The progress of phase `ph` on villa `v`, for SQL that names them so: the average progress of the villa's open works
// filed under the phase (any source, any status), or 0 when it has none. The phase progress rows do not count. The
// TypeScript twin is phaseProgressOf.
export const PHASE_PROGRESS = Prisma.sql`COALESCE(
  (SELECT avg(wi."progress") FROM "WorkItem" wi WHERE wi."villaId" = v."id" AND wi."elecPhaseId" = ph."id"),
  0
)`;

// What active phase `ph` adds to villa `v`'s overall progress: its whole progress ratio once the villa's open work for it
// is done (PHASE_PROGRESS at 100), and 0 before that. The TypeScript twin is doneRatioOf.
export const PHASE_DONE_RATIO = Prisma.sql`(CASE WHEN ${PHASE_PROGRESS} >= 100 THEN ph."progressRatio" ELSE 0 END)`;
