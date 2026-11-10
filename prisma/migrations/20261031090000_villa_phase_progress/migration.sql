-- Phase progress: how far each phase of each villa has got. Written by hand because Prisma cannot express CHECK constraints
-- or the backfill.
--
--   * "VillaPhaseProgress" has one row per (villa, phase), whether or not the phase is active. The primary key is
--     ("villaId", "elecPhaseId"). A villa deleted takes its rows with it (CASCADE); a phase cannot be deleted while a row
--     points at it (RESTRICT), so the phase delete removes the rows that are still at 0 first and refuses when any is above 0.
--   * "progress" is a SMALLINT from 0 to 100. "completedAt" is set exactly when "progress" is 100 (and only then).
--   * "version" starts at 1 and goes up with every write (the If-Match of the progress update).
--   * Every villa x phase that exists today gets a row at 0. From now on the application inserts a row per phase when it
--     creates a villa, and a row per villa when it creates a phase, in the same transaction.
-- The villa's overall progress is never stored: it is the average of the progress of its active phases, worked out when read.
-- Nothing is deleted, and the "AuditLog" table and its append-only trigger are not touched.
-- The migration runs as one transaction: if anything fails, nothing is changed.

-- 1. The table.
CREATE TABLE "VillaPhaseProgress" (
    "villaId" TEXT NOT NULL,
    "elecPhaseId" TEXT NOT NULL,
    "progress" SMALLINT NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VillaPhaseProgress_pkey" PRIMARY KEY ("villaId","elecPhaseId")
);

CREATE INDEX "VillaPhaseProgress_elecPhaseId_idx" ON "VillaPhaseProgress"("elecPhaseId");

ALTER TABLE "VillaPhaseProgress" ADD CONSTRAINT "VillaPhaseProgress_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VillaPhaseProgress" ADD CONSTRAINT "VillaPhaseProgress_elecPhaseId_fkey" FOREIGN KEY ("elecPhaseId") REFERENCES "ElecPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The rules.
ALTER TABLE "VillaPhaseProgress"
  ADD CONSTRAINT "VillaPhaseProgress_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
  ADD CONSTRAINT "VillaPhaseProgress_completed_check" CHECK (("progress" = 100) = ("completedAt" IS NOT NULL));

-- 3. A row at 0 for every villa and every phase that exists now.
INSERT INTO "VillaPhaseProgress" ("villaId", "elecPhaseId", "progress", "version", "updatedAt")
SELECT v."id", ph."id", 0, 1, now()
FROM "Villa" v CROSS JOIN "ElecPhase" ph;
