-- Site reports: the visits made to a villa (an inspection, a safety round, a progress or quality check). Written by hand
-- because Prisma cannot express the CHECK constraints.
--
--   * "SiteReport" belongs to a villa (RESTRICT: a villa with site reports cannot be deleted; the application refuses it
--     first with VILLA_HAS_RECORDS, and this foreign key is the backstop). The inspector is kept as a name in "inspector",
--     so "createdById" may become NULL when the user is deleted (SET NULL). There is no contractor and no engineer column.
--   * There is NO unique index: two visits on one day may have the same title. The import guards against loading a file
--     twice with its file hash (ImportBatch), not with a key.
--   * "visitDate" is a calendar day (DATE). "rating" is a SMALLINT from 1 to 5. "title" is 1 to 150 characters, "inspector"
--     1 to 100, "findings" 1 to 5,000 and "recommendations" NULL or 1 to 5,000 (CHECKs below; the application trims the
--     text first and stores a blank recommendation as NULL).
--   * "version" starts at 1 and goes up with every write (the If-Match of the row).
-- Nothing is deleted or changed in an existing table, and nothing is backfilled. The migration runs as one transaction:
-- if anything fails, nothing is changed.

-- 1. The type.
CREATE TYPE "SiteReportType" AS ENUM ('INSPECTION', 'SAFETY', 'PROGRESS', 'QUALITY');

-- 2. The table.
CREATE TABLE "SiteReport" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "visitDate" DATE NOT NULL,
    "inspector" TEXT NOT NULL,
    "type" "SiteReportType" NOT NULL,
    "rating" SMALLINT NOT NULL,
    "findings" TEXT NOT NULL,
    "recommendations" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteReport_villaId_visitDate_idx" ON "SiteReport"("villaId", "visitDate" DESC);
CREATE INDEX "SiteReport_visitDate_idx" ON "SiteReport"("visitDate");
CREATE INDEX "SiteReport_createdById_idx" ON "SiteReport"("createdById");
-- Serves the search on the title (pg_trgm comes from the "extras" migration).
CREATE INDEX "SiteReport_title_trgm_idx" ON "SiteReport" USING GIN ("title" gin_trgm_ops);

ALTER TABLE "SiteReport" ADD CONSTRAINT "SiteReport_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SiteReport" ADD CONSTRAINT "SiteReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. The rules.
ALTER TABLE "SiteReport"
  ADD CONSTRAINT "SiteReport_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "SiteReport_title_check" CHECK (char_length("title") BETWEEN 1 AND 150),
  ADD CONSTRAINT "SiteReport_inspector_check" CHECK (char_length("inspector") BETWEEN 1 AND 100),
  ADD CONSTRAINT "SiteReport_findings_check" CHECK (char_length("findings") BETWEEN 1 AND 5000),
  ADD CONSTRAINT "SiteReport_recommendations_check" CHECK ("recommendations" IS NULL OR char_length("recommendations") BETWEEN 1 AND 5000);
