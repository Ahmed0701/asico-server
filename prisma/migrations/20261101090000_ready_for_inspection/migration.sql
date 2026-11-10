-- Ready for inspection: a villa can be marked as ready, by a person, and the mark can be undone. Written by hand because
-- Prisma cannot express the CHECK constraint.
--
--   * "readyForInspectionAt" is when the villa was marked; NULL means it is not marked. "readyForInspectionById" is who
--     marked it. The user is deleted later without deleting the villa (SET NULL), so the user can be NULL while the time stays.
--   * A user can only be recorded together with a time ("Villa_ready_check").
--   * Nothing is derived from the progress: no villa is marked by this migration, and none ever becomes ready by itself.
-- Only columns are added to "Villa"; nothing is deleted, no row is changed, and the "AuditLog" table is not touched.
-- The migration runs as one transaction: if anything fails, nothing is changed.

-- 1. The columns and the user link.
ALTER TABLE "Villa" ADD COLUMN "readyForInspectionAt" TIMESTAMP(3),
ADD COLUMN "readyForInspectionById" TEXT;

CREATE INDEX "Villa_readyForInspectionById_idx" ON "Villa"("readyForInspectionById");

ALTER TABLE "Villa" ADD CONSTRAINT "Villa_readyForInspectionById_fkey" FOREIGN KEY ("readyForInspectionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The rule.
ALTER TABLE "Villa"
  ADD CONSTRAINT "Villa_ready_check" CHECK ("readyForInspectionById" IS NULL OR "readyForInspectionAt" IS NOT NULL);
