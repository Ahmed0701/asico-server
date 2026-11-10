-- Daily small works: the small jobs done on a villa on one day. Written by hand because Prisma cannot express the CHECK
-- constraints.
--
--   * "DailySmallWork" belongs to a villa (RESTRICT: a villa with small works cannot be deleted; the application refuses it
--     first with VILLA_HAS_RECORDS, and this foreign key is the backstop). The author is kept as a name in "doneBy", so
--     "createdById" may become NULL when the user is deleted (SET NULL). There is no contractor column.
--   * There is NO unique index: the same job may be written twice on one day. The import guards against loading a file
--     twice with its file hash (ImportBatch), not with a key.
--   * "workDate" is a calendar day (DATE). "qty" is DECIMAL(12,3): at most 999,999,999.999, three decimals, above zero.
--     "description" is 1 to 500 characters, "unit" 1 to 30 and "doneBy" 1 to 100 (CHECKs below; the application trims the
--     text first).
--   * "version" starts at 1 and goes up with every write (the If-Match of the row).
-- Nothing is deleted or changed in an existing table, and nothing is backfilled. The migration runs as one transaction:
-- if anything fails, nothing is changed.

-- 1. The type.
CREATE TYPE "SmallWorkStatus" AS ENUM ('PENDING', 'DONE');

-- 2. The table.
CREATE TABLE "DailySmallWork" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "doneBy" TEXT NOT NULL,
    "status" "SmallWorkStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySmallWork_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DailySmallWork_villaId_workDate_idx" ON "DailySmallWork"("villaId", "workDate" DESC);
CREATE INDEX "DailySmallWork_workDate_idx" ON "DailySmallWork"("workDate");
CREATE INDEX "DailySmallWork_createdById_idx" ON "DailySmallWork"("createdById");
-- Serves the search on the description (pg_trgm comes from the "extras" migration).
CREATE INDEX "DailySmallWork_description_trgm_idx" ON "DailySmallWork" USING GIN ("description" gin_trgm_ops);

ALTER TABLE "DailySmallWork" ADD CONSTRAINT "DailySmallWork_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailySmallWork" ADD CONSTRAINT "DailySmallWork_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. The rules.
ALTER TABLE "DailySmallWork"
  ADD CONSTRAINT "DailySmallWork_qty_check" CHECK ("qty" > 0),
  ADD CONSTRAINT "DailySmallWork_description_check" CHECK (char_length("description") BETWEEN 1 AND 500),
  ADD CONSTRAINT "DailySmallWork_unit_check" CHECK (char_length("unit") BETWEEN 1 AND 30),
  ADD CONSTRAINT "DailySmallWork_doneBy_check" CHECK (char_length("doneBy") BETWEEN 1 AND 100);
