-- Villas: a Project becomes a Villa, a ProjectFile becomes a VillaDocument, and everything the villa platform no longer
-- uses is dropped. Written by hand because the tables are renamed in place (so ids, and with them the audit trail, keep
-- pointing at the same records) and because Prisma cannot express the data moves.
--
-- Dropped for good:
--   * the rows of "ProjectFile" (the existing test PDFs; the files on disk are removed separately),
--   * the table "ProjectActivity" (the four activities per project) and "ProjectFile"."activityId",
--   * the table "ProjectContractor" (a villa has ONE contractor, "Villa"."contractorId"),
--   * the columns "status", "checklistCompleted" and "materialRequested" of "Project", and the enum "ProjectStatus".
-- Renamed: "projectNumber" -> "villaNumber", "plotNumber" -> "plot", "notifiedAt" -> "startDate",
--          "expectedReceiptDate" -> "targetDate", "ProjectFile"."projectId" -> "villaId", and every index, constraint
--          and foreign key of the two tables to the name Prisma expects.
-- The "AuditLog" table and its append-only trigger are not touched: old entries keep the entity "Project"/"ProjectFile".
-- The migration runs as one transaction: if anything fails, nothing is changed.

-- 1. The existing documents go (all of them are test files).
DELETE FROM "ProjectFile";

-- 2. The contractor moves onto the villa. Today a project has at most one link; if one ever had several, the one
--    assigned first is kept (ties by id), so the result never depends on the order rows happen to be read in.
ALTER TABLE "Project" ADD COLUMN "contractorId" TEXT;

UPDATE "Project" AS p
SET "contractorId" = (
    SELECT pc."contractorId"
    FROM "ProjectContractor" AS pc
    WHERE pc."projectId" = p."id"
    ORDER BY pc."assignedAt" ASC, pc."contractorId" ASC
    LIMIT 1
);

-- 3. Drop what is no longer used. Dropping a column drops the indexes and foreign keys built on it.
ALTER TABLE "ProjectFile" DROP COLUMN "activityId";
DROP TABLE "ProjectActivity";
DROP TABLE "ProjectContractor";
ALTER TABLE "Project" DROP COLUMN "status",
DROP COLUMN "checklistCompleted",
DROP COLUMN "materialRequested";
DROP TYPE "ProjectStatus";

-- 4. Rename the tables and columns.
ALTER TABLE "Project" RENAME TO "Villa";
ALTER TABLE "ProjectFile" RENAME TO "VillaDocument";
ALTER TABLE "Villa" RENAME COLUMN "projectNumber" TO "villaNumber";
ALTER TABLE "Villa" RENAME COLUMN "plotNumber" TO "plot";
ALTER TABLE "Villa" RENAME COLUMN "notifiedAt" TO "startDate";
ALTER TABLE "Villa" RENAME COLUMN "expectedReceiptDate" TO "targetDate";
ALTER TABLE "VillaDocument" RENAME COLUMN "projectId" TO "villaId";

-- 5. Rename the primary keys (this renames their indexes too), the other indexes and the foreign keys.
ALTER TABLE "Villa" RENAME CONSTRAINT "Project_pkey" TO "Villa_pkey";
ALTER TABLE "VillaDocument" RENAME CONSTRAINT "ProjectFile_pkey" TO "VillaDocument_pkey";

ALTER INDEX "Project_projectNumber_key" RENAME TO "Villa_villaNumber_key";
ALTER INDEX "Project_areaId_block_plotNumber_key" RENAME TO "Villa_areaId_block_plot_key";
ALTER INDEX "Project_areaId_idx" RENAME TO "Villa_areaId_idx";
ALTER INDEX "Project_civilEngineerId_idx" RENAME TO "Villa_civilEngineerId_idx";
ALTER INDEX "Project_projectNumber_trgm_idx" RENAME TO "Villa_villaNumber_trgm_idx";
ALTER INDEX "Project_plotNumber_trgm_idx" RENAME TO "Villa_plot_trgm_idx";
ALTER INDEX "Project_block_trgm_idx" RENAME TO "Villa_block_trgm_idx";
ALTER INDEX "ProjectFile_storageKey_key" RENAME TO "VillaDocument_storageKey_key";
ALTER INDEX "ProjectFile_projectId_idx" RENAME TO "VillaDocument_villaId_idx";

ALTER TABLE "Villa" RENAME CONSTRAINT "Project_areaId_fkey" TO "Villa_areaId_fkey";
ALTER TABLE "Villa" RENAME CONSTRAINT "Project_civilEngineerId_fkey" TO "Villa_civilEngineerId_fkey";
ALTER TABLE "Villa" RENAME CONSTRAINT "Project_createdById_fkey" TO "Villa_createdById_fkey";
ALTER TABLE "VillaDocument" RENAME CONSTRAINT "ProjectFile_projectId_fkey" TO "VillaDocument_villaId_fkey";
ALTER TABLE "VillaDocument" RENAME CONSTRAINT "ProjectFile_uploadedById_fkey" TO "VillaDocument_uploadedById_fkey";

-- 6. The contractor link: a contractor with villas cannot be deleted.
CREATE INDEX "Villa_contractorId_idx" ON "Villa"("contractorId");
ALTER TABLE "Villa" ADD CONSTRAINT "Villa_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Permissions. The rows are renamed in place, so anything already granted keeps working; wall piping goes (its
--    grants go with it), and the open-works codes stay for the open-works module that comes back later.
UPDATE "Permission" SET "code" = 'villas:' || substr("code", 10) WHERE "code" LIKE 'projects:%';
UPDATE "Permission" SET "code" = 'villa-documents:' || substr("code", 15) WHERE "code" LIKE 'project-files:%';
DELETE FROM "Permission" WHERE "code" LIKE 'wall-piping:%';
