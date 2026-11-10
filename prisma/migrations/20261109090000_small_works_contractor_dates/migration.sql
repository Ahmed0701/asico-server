-- Slice 18, part 1: a small work now has a contractor (instead of the free text "doneBy") and a range of days (instead of the
-- one "workDate"). Written by hand because Prisma cannot express the CHECK constraint, and to backfill existing rows.
--
--   * "contractorId" (FK to "Contractor", RESTRICT: a contractor with small works cannot be deleted; the application refuses it
--     first with CONTRACTOR_HAS_VILLAS, and this foreign key is the backstop). It is NOT NULL.
--   * "startDate" and "endDate" are calendar days (DATE), NOT NULL, with CHECK "endDate" >= "startDate".
--   * Existing rows: startDate = endDate = the old workDate. The contractor is found by the old "doneBy": the contractor whose
--     name equals it ignoring case and surrounding spaces, if exactly one does. A row that cannot be matched (no contractor of
--     that name, or two) is NEVER given a guessed contractor: the migration stops with the count and the values and changes
--     nothing (it runs as one transaction). Fix those rows first (give them the contractor through the API, or delete them).
--   * "workDate" and "doneBy" (and the indexes and the CHECK that used them) are dropped.
-- The bound of 10 years around today and the rule that the range is ordered are checked by the application as well (422 for the
-- order); only the order is a constraint here, because "10 years from today" moves.

-- 1. The new columns, empty.
ALTER TABLE "DailySmallWork"
  ADD COLUMN "contractorId" TEXT,
  ADD COLUMN "startDate" DATE,
  ADD COLUMN "endDate" DATE;

-- 2. The dates of the existing rows.
UPDATE "DailySmallWork" SET "startDate" = "workDate", "endDate" = "workDate";

-- 3. The contractor of the existing rows: an exact match of the old text with the name of ONE contractor.
UPDATE "DailySmallWork" s
SET "contractorId" = c."id"
FROM "Contractor" c
WHERE lower(btrim(c."name", E' \t\r\n')) = lower(btrim(s."doneBy", E' \t\r\n'))
  AND (
    SELECT count(*) FROM "Contractor" k
    WHERE lower(btrim(k."name", E' \t\r\n')) = lower(btrim(s."doneBy", E' \t\r\n'))
  ) = 1;

-- 4. No guessing: stop if any row is left without a contractor.
DO $$
DECLARE
  unmatched integer;
  samples text;
BEGIN
  SELECT count(*), left(string_agg(DISTINCT '"' || "doneBy" || '"', ', '), 800)
    INTO unmatched, samples
    FROM "DailySmallWork"
    WHERE "contractorId" IS NULL;
  IF unmatched > 0 THEN
    RAISE EXCEPTION 'DailySmallWork: % row(s) cannot be matched to exactly one contractor by the old doneBy text (%). Give these small works a contractor or delete them, then run the migration again.', unmatched, samples;
  END IF;
END $$;

-- 5. The rules.
ALTER TABLE "DailySmallWork"
  ALTER COLUMN "contractorId" SET NOT NULL,
  ALTER COLUMN "startDate" SET NOT NULL,
  ALTER COLUMN "endDate" SET NOT NULL;

ALTER TABLE "DailySmallWork"
  ADD CONSTRAINT "DailySmallWork_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DailySmallWork_dates_check" CHECK ("endDate" >= "startDate");

-- 6. The old columns go, with the indexes on workDate and the CHECK on doneBy.
ALTER TABLE "DailySmallWork"
  DROP COLUMN "workDate",
  DROP COLUMN "doneBy";

-- 7. The indexes of the new columns.
CREATE INDEX "DailySmallWork_villaId_endDate_idx" ON "DailySmallWork"("villaId", "endDate" DESC);
CREATE INDEX "DailySmallWork_endDate_idx" ON "DailySmallWork"("endDate");
CREATE INDEX "DailySmallWork_contractorId_idx" ON "DailySmallWork"("contractorId");
