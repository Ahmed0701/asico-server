-- Open works: the work items of a villa, typed in by people or created from the progress of a phase. Written by hand
-- because Prisma cannot express the CHECK constraints, the partial unique index or the backfill.
--
--   * "WorkItem" belongs to a villa (CASCADE: the items go with the villa; the application refuses to delete a villa that
--     has MANUAL items, so only the automatic ones are ever removed that way). A phase cannot be deleted while an item
--     points at it, and neither can a contractor (RESTRICT).
--   * "source" is MANUAL (typed in) or PHASE (created from the progress of "elecPhaseId", and kept in step with it by the
--     application). A PHASE item always has a phase ("WorkItem_phase_source_check").
--   * A villa has at most one PHASE item per phase: the partial unique index "WorkItem_villa_phase_auto_key" makes a
--     duplicate impossible even if two requests race.
--   * "progress" is 0 to 100. DONE is exactly 100, and NOT_STARTED is exactly 0 ("WorkItem_status_check"); IN_PROGRESS and
--     DELAYED are anything in between or at 0. "endDate" is not before "startDate".
--   * "createdById" is NULL when the system made the item (the backfill below), and when the user is deleted later (SET NULL).
--   * "version" starts at 1 and goes up with every write (the If-Match of the item).
--   * Every phase progress above 0 that exists today gets its PHASE item, made by the system, with an audit entry
--     (actor NULL). Its start date is the UTC day of the progress row's last change, and its contractor is the villa's.
-- Nothing is deleted or changed in an existing table. The "AuditLog" table gets rows appended; its append-only trigger is
-- not touched. The migration runs as one transaction: if anything fails, nothing is changed.

-- 1. The types.
CREATE TYPE "WorkPhase" AS ENUM ('FOUNDATION', 'STRUCTURE', 'MEP', 'FINISHING', 'EXTERNAL');
CREATE TYPE "WorkStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DELAYED', 'DONE');
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "WorkItemSource" AS ENUM ('MANUAL', 'PHASE');

-- 2. The table.
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "phase" "WorkPhase" NOT NULL,
    "elecPhaseId" TEXT,
    "status" "WorkStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "progress" SMALLINT NOT NULL DEFAULT 0,
    "contractorId" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "source" "WorkItemSource" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkItem_villaId_status_idx" ON "WorkItem"("villaId", "status");
CREATE INDEX "WorkItem_status_idx" ON "WorkItem"("status");
CREATE INDEX "WorkItem_endDate_idx" ON "WorkItem"("endDate");
CREATE INDEX "WorkItem_contractorId_idx" ON "WorkItem"("contractorId");
CREATE INDEX "WorkItem_elecPhaseId_idx" ON "WorkItem"("elecPhaseId");
CREATE INDEX "WorkItem_createdById_idx" ON "WorkItem"("createdById");
-- Serves the search on the title (pg_trgm comes from the "extras" migration).
CREATE INDEX "WorkItem_title_trgm_idx" ON "WorkItem" USING GIN ("title" gin_trgm_ops);
CREATE UNIQUE INDEX "WorkItem_villa_phase_auto_key" ON "WorkItem"("villaId", "elecPhaseId") WHERE "source" = 'PHASE';

ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_elecPhaseId_fkey" FOREIGN KEY ("elecPhaseId") REFERENCES "ElecPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. The rules.
ALTER TABLE "WorkItem"
  ADD CONSTRAINT "WorkItem_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
  ADD CONSTRAINT "WorkItem_dates_check" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate"),
  ADD CONSTRAINT "WorkItem_phase_source_check" CHECK ("source" <> 'PHASE' OR "elecPhaseId" IS NOT NULL),
  ADD CONSTRAINT "WorkItem_status_check" CHECK (
    (("status" = 'DONE') = ("progress" = 100)) AND ("status" <> 'NOT_STARTED' OR "progress" = 0)
  );

-- 4. An item for every phase progress above 0 that exists now, and one audit entry for each (made by the system).
WITH created AS (
  INSERT INTO "WorkItem" (
    "id", "villaId", "title", "phase", "elecPhaseId", "status", "priority", "progress", "contractorId", "startDate",
    "source", "version", "createdById", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid()::text, p."villaId", ph."name", 'MEP', p."elecPhaseId",
    CASE WHEN p."progress" = 100 THEN 'DONE'::"WorkStatus" ELSE 'IN_PROGRESS'::"WorkStatus" END,
    'MEDIUM', p."progress", v."contractorId", p."updatedAt"::date,
    'PHASE', 1, NULL, now(), now()
  FROM "VillaPhaseProgress" p
  JOIN "Villa" v ON v."id" = p."villaId"
  JOIN "ElecPhase" ph ON ph."id" = p."elecPhaseId"
  WHERE p."progress" > 0
  RETURNING "id", "villaId", "elecPhaseId", "title", "status", "progress"
)
INSERT INTO "AuditLog" ("id", "actorId", "action", "entity", "entityId", "before", "after")
SELECT
  gen_random_uuid()::text, NULL, 'open_work.auto_sync', 'WorkItem', c."id", NULL,
  jsonb_build_object(
    'villaId', c."villaId", 'elecPhaseId', c."elecPhaseId", 'title', c."title",
    'status', c."status", 'progress', c."progress"
  )
FROM created c;
