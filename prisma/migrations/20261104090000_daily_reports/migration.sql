-- Daily reports: what was done on a villa on one day. Written by hand because Prisma cannot express the CHECK constraints.
--
--   * "DailyReport" belongs to a villa (RESTRICT: a villa with reports cannot be deleted; the application refuses it first
--     with VILLA_HAS_RECORDS, and this foreign key is the backstop). A contractor named on a report cannot be deleted
--     either (RESTRICT). The author is kept as a name in "preparedBy", so "createdById" may become NULL when the user is
--     deleted (SET NULL).
--   * A villa has one report per day: the unique index "DailyReport_villaId_reportDate_key" makes a second one impossible,
--     even if two requests race.
--   * "reportDate" is a calendar day (DATE). "workersCount" is 0 to 100,000. "workDone" is 1 to 5,000 characters, "issues"
--     (when there are any) 1 to 5,000 and "preparedBy" 1 to 100 (CHECKs below; the application trims the text first).
--   * "version" starts at 1 and goes up with every write (the If-Match of the report).
-- Nothing is deleted or changed in an existing table, and nothing is backfilled. The migration runs as one transaction:
-- if anything fails, nothing is changed.

-- 1. The type.
CREATE TYPE "Weather" AS ENUM ('HOT', 'SUNNY', 'WINDY', 'RAINY', 'DUSTY');

-- 2. The table.
CREATE TABLE "DailyReport" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "weather" "Weather" NOT NULL,
    "workersCount" INTEGER NOT NULL,
    "workDone" TEXT NOT NULL,
    "issues" TEXT,
    "preparedBy" TEXT NOT NULL,
    "contractorId" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyReport_villaId_reportDate_key" ON "DailyReport"("villaId", "reportDate");
CREATE INDEX "DailyReport_reportDate_idx" ON "DailyReport"("reportDate");
CREATE INDEX "DailyReport_contractorId_idx" ON "DailyReport"("contractorId");
CREATE INDEX "DailyReport_createdById_idx" ON "DailyReport"("createdById");
-- Serves the search on the work done (pg_trgm comes from the "extras" migration).
CREATE INDEX "DailyReport_workDone_trgm_idx" ON "DailyReport" USING GIN ("workDone" gin_trgm_ops);

ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. The rules.
ALTER TABLE "DailyReport"
  ADD CONSTRAINT "DailyReport_workers_check" CHECK ("workersCount" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "DailyReport_workDone_check" CHECK (char_length("workDone") BETWEEN 1 AND 5000),
  ADD CONSTRAINT "DailyReport_issues_check" CHECK ("issues" IS NULL OR char_length("issues") BETWEEN 1 AND 5000),
  ADD CONSTRAINT "DailyReport_preparedBy_check" CHECK (char_length("preparedBy") BETWEEN 1 AND 100);
