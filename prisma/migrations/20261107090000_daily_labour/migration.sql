-- Daily labour: the workers a contractor had on a villa on one day. Written by hand because Prisma cannot express the
-- CHECK constraints.
--
--   * "DailyLabour" belongs to a villa (RESTRICT: a villa with labour rows cannot be deleted; the application refuses it
--     first with VILLA_HAS_RECORDS, and this foreign key is the backstop) and to a contractor (RESTRICT: a contractor with
--     labour rows cannot be deleted; the application refuses it first with CONTRACTOR_HAS_VILLAS, and this foreign key is the
--     backstop). The contractor is required. "createdById" may become NULL when the user is deleted (SET NULL).
--   * The natural key is (villa, contractor, day): the unique index below is the last word on a duplicate, and the one a
--     concurrent double create runs into (the application maps it to DAILY_LABOUR_EXISTS).
--   * "labourDate" is a calendar day (DATE). "labourCount" is a whole number from 0 to 100,000. "notes" is NULL or 1 to 500
--     characters (CHECKs below; the application trims the text first and stores blank notes as NULL).
--   * "version" starts at 1 and goes up with every write (the If-Match of the row).
-- Nothing is deleted or changed in an existing table, and nothing is backfilled. The migration runs as one transaction:
-- if anything fails, nothing is changed.

-- 1. The table.
CREATE TABLE "DailyLabour" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "labourDate" DATE NOT NULL,
    "contractorId" TEXT NOT NULL,
    "labourCount" INTEGER NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyLabour_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyLabour_villaId_contractorId_labourDate_key" ON "DailyLabour"("villaId", "contractorId", "labourDate");
CREATE INDEX "DailyLabour_villaId_labourDate_idx" ON "DailyLabour"("villaId", "labourDate" DESC);
CREATE INDEX "DailyLabour_labourDate_idx" ON "DailyLabour"("labourDate");
CREATE INDEX "DailyLabour_contractorId_idx" ON "DailyLabour"("contractorId");
CREATE INDEX "DailyLabour_createdById_idx" ON "DailyLabour"("createdById");

ALTER TABLE "DailyLabour" ADD CONSTRAINT "DailyLabour_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyLabour" ADD CONSTRAINT "DailyLabour_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyLabour" ADD CONSTRAINT "DailyLabour_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The rules.
ALTER TABLE "DailyLabour"
  ADD CONSTRAINT "DailyLabour_labourCount_check" CHECK ("labourCount" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "DailyLabour_notes_check" CHECK ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 500);
