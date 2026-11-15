-- When the progress of an open work was last set, and by whom: shown beside each electrical phase on the villa page.
--
--   * Set on create, on import, and on an edit that changes the progress or moves the work to another phase.
--   * The user is SET NULL when deleted.
--   * Existing rows: the latest audited create or edit that set the progress (or moved the phase); otherwise when it was
--     created and by whom.

ALTER TABLE "WorkItem" ADD COLUMN "progressUpdatedAt" TIMESTAMP(3);
ALTER TABLE "WorkItem" ADD COLUMN "progressUpdatedById" TEXT;

CREATE INDEX "WorkItem_progressUpdatedById_idx" ON "WorkItem"("progressUpdatedById");

ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_progressUpdatedById_fkey" FOREIGN KEY ("progressUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "WorkItem" w
SET "progressUpdatedAt" = a."createdAt",
    "progressUpdatedById" = a."actorId"
FROM (
    SELECT DISTINCT ON ("entityId") "entityId", "createdAt", "actorId"
    FROM "AuditLog"
    WHERE "entity" = 'WorkItem'
      AND "action" IN ('open_work.create', 'open_work.update')
      AND (
        "before" IS NULL
        OR ("before"->>'progress') IS DISTINCT FROM ("after"->>'progress')
        OR ("before"->>'elecPhaseId') IS DISTINCT FROM ("after"->>'elecPhaseId')
      )
    ORDER BY "entityId", "createdAt" DESC, "id" DESC
) a
WHERE a."entityId" = w."id"
  AND EXISTS (SELECT 1 FROM "User" u WHERE u."id" = a."actorId");

UPDATE "WorkItem"
SET "progressUpdatedAt" = "createdAt",
    "progressUpdatedById" = "createdById"
WHERE "progressUpdatedAt" IS NULL;
