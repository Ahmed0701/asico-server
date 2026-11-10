-- Slice 19: open works are filed under an electrical phase and lose their title; small works lose their quantity and unit; daily
-- reports belong to a contractor and an electrical engineer instead of a villa. Written by hand because Prisma cannot express
-- the CHECK constraints and the renames, and to backfill existing rows. It runs as ONE transaction: if anything below fails,
-- nothing is changed.
--
-- NO GUESSING. Every backfill is an exact match, and a row that cannot be placed is never given a guessed value. The migration
-- first looks at ALL the tables (step 0) and, if any row cannot be placed, stops with ONE message that lists every such row, and
-- changes nothing. The read-only script `npm run check:slice19` prints the same list without running the migration, so the data
-- can be fixed first.
--
--   OPEN WORKS ("WorkItem")
--     * "title" and "phase" (the enum WorkPhase) are dropped. "elecPhaseId" (FK to "ElecPhase", RESTRICT) becomes NOT NULL for
--       both sources: the one relation that automatic items already had.
--     * An automatic (PHASE) item already has its phase. A manual item that already has one keeps it. A manual item without
--       one takes the electrical phase whose name equals its old work phase text (FOUNDATION, STRUCTURE, MEP, FINISHING,
--       EXTERNAL), ignoring case and surrounding spaces, if exactly one does. Otherwise the migration stops.
--     * The titles of manual items are lost; there is no column to keep them in.
--
--   SMALL WORKS ("DailySmallWork"): "qty" and "unit" (and the CHECK constraints on them) are dropped.
--
--   DAILY REPORTS ("DailyReport")
--     * "villaId" (with its foreign key and the unique index on (villaId, reportDate)) is dropped. "contractorId" becomes NOT NULL:
--       the report's own contractor if it had one, else its villa's contractor. A report with neither stops the migration.
--     * The new unique key is (contractorId, reportDate). Two reports that would collide stop the migration; reports are never
--       merged.
--     * "preparedBy" (text) becomes "preparedByEngineerId" (FK to "ElectricalEngineer", RESTRICT, NOT NULL): the engineer whose
--       name equals the old text, ignoring case and surrounding spaces, if exactly one does. Otherwise the migration stops.
--     * "workDone" is dropped (with its trigram index). "issues" is renamed "notes", with its CHECK constraint and its trigram
--       index; the trigram index on "preparedBy" goes with the column.

-- 0. Look at everything first and stop, with every problem listed, before anything is changed.
DO $$
DECLARE
  problems text := '';
  total integer;
  listed text;
BEGIN
  -- Open works: manual items with no phase of their own whose old work phase matches no electrical phase by name.
  SELECT coalesce(sum(n), 0), left(string_agg('"' || phase || '" x' || n, ', ' ORDER BY phase), 800)
    INTO total, listed
    FROM (
      SELECT w."phase"::text AS phase, count(*) AS n
      FROM "WorkItem" w
      WHERE w."elecPhaseId" IS NULL
        AND (
          SELECT count(*) FROM "ElecPhase" p
          WHERE lower(btrim(p."name", E' \t\r\n')) = lower(btrim(w."phase"::text, E' \t\r\n'))
        ) <> 1
      GROUP BY w."phase"
    ) g;
  IF total > 0 THEN
    problems := problems || E'\n- WorkItem: ' || total || ' open work(s) have no electrical phase, and their old work phase matches exactly one electrical phase by name in none of them (old value x count: ' || listed || '). Give each an electrical phase (or delete it), or add an electrical phase with that name.';
  END IF;

  -- Daily reports without a contractor (neither their own nor their villa's).
  SELECT count(*), left(string_agg(x."villaNumber" || ' ' || x."reportDate"::text, ', ' ORDER BY x."villaNumber", x."reportDate"), 800)
    INTO total, listed
    FROM (
      SELECT v."villaNumber", d."reportDate"
      FROM "DailyReport" d JOIN "Villa" v ON v."id" = d."villaId"
      WHERE d."contractorId" IS NULL AND v."contractorId" IS NULL
    ) x;
  IF total > 0 THEN
    problems := problems || E'\n- DailyReport: ' || total || ' report(s) have no contractor and their villa has none either (villa number and date: ' || listed || '). Give the villa a contractor, or delete the report.';
  END IF;

  -- Daily reports that would collide on (contractor, date).
  SELECT count(*), left(string_agg(x."label", '; ' ORDER BY x."label"), 800)
    INTO total, listed
    FROM (
      SELECT c."name" || ' on ' || g."reportDate"::text || ' (' || g."villas" || ')' AS "label"
      FROM (
        SELECT coalesce(d."contractorId", v."contractorId") AS "contractorId", d."reportDate",
               string_agg(v."villaNumber", ', ' ORDER BY v."villaNumber") AS "villas"
        FROM "DailyReport" d JOIN "Villa" v ON v."id" = d."villaId"
        WHERE coalesce(d."contractorId", v."contractorId") IS NOT NULL
        GROUP BY 1, 2
        HAVING count(*) > 1
      ) g
      JOIN "Contractor" c ON c."id" = g."contractorId"
    ) x;
  IF total > 0 THEN
    problems := problems || E'\n- DailyReport: ' || total || ' (contractor, date) pair(s) have more than one report (contractor on date (villas): ' || listed || '). Reports are never merged: delete or move the extra ones.';
  END IF;

  -- Daily reports whose "prepared by" text matches no electrical engineer, or more than one, by name.
  SELECT coalesce(sum(n), 0), left(string_agg('"' || prepared || '" x' || n, ', ' ORDER BY prepared), 800)
    INTO total, listed
    FROM (
      SELECT d."preparedBy" AS prepared, count(*) AS n
      FROM "DailyReport" d
      WHERE (
        SELECT count(*) FROM "ElectricalEngineer" e
        WHERE lower(btrim(e."name", E' \t\r\n')) = lower(btrim(d."preparedBy", E' \t\r\n'))
      ) <> 1
      GROUP BY d."preparedBy"
    ) g;
  IF total > 0 THEN
    problems := problems || E'\n- DailyReport: ' || total || ' report(s) were prepared by a name that matches exactly one electrical engineer in none of them (old text x count: ' || listed || '). Add the engineer, or change the report''s text to an engineer''s name.';
  END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION E'Slice 19 stopped, nothing was changed. These rows cannot be placed without guessing:%\nFix them, then run the migration again (npm run check:slice19 lists them without running it).', problems;
  END IF;
END $$;

-- 1. Open works: every item is filed under an electrical phase; no title, no work phase.
UPDATE "WorkItem" w
SET "elecPhaseId" = p."id"
FROM "ElecPhase" p
WHERE w."elecPhaseId" IS NULL
  AND lower(btrim(p."name", E' \t\r\n')) = lower(btrim(w."phase"::text, E' \t\r\n'));

ALTER TABLE "WorkItem" ALTER COLUMN "elecPhaseId" SET NOT NULL;
ALTER TABLE "WorkItem" DROP CONSTRAINT "WorkItem_phase_source_check";
DROP INDEX "WorkItem_title_trgm_idx";
ALTER TABLE "WorkItem" DROP COLUMN "title", DROP COLUMN "phase";
DROP TYPE "WorkPhase";

-- 2. Small works: no quantity, no unit (their CHECK constraints go with them).
ALTER TABLE "DailySmallWork" DROP COLUMN "qty", DROP COLUMN "unit";

-- 3. Daily reports: a contractor and an electrical engineer instead of a villa and a free text.
ALTER TABLE "DailyReport" ADD COLUMN "preparedByEngineerId" TEXT;

UPDATE "DailyReport" d
SET "contractorId" = v."contractorId"
FROM "Villa" v
WHERE v."id" = d."villaId" AND d."contractorId" IS NULL;

UPDATE "DailyReport" d
SET "preparedByEngineerId" = e."id"
FROM "ElectricalEngineer" e
WHERE lower(btrim(e."name", E' \t\r\n')) = lower(btrim(d."preparedBy", E' \t\r\n'));

ALTER TABLE "DailyReport"
  ALTER COLUMN "contractorId" SET NOT NULL,
  ALTER COLUMN "preparedByEngineerId" SET NOT NULL;

-- The villa goes, with its foreign key and the unique index on (villaId, reportDate); so do the text columns, with the CHECK
-- constraints and the trigram indexes on workDone and preparedBy.
ALTER TABLE "DailyReport"
  DROP COLUMN "villaId",
  DROP COLUMN "workDone",
  DROP COLUMN "preparedBy";

-- "issues" is now "notes": same rule, and the trigram index (the search) follows the rename.
ALTER TABLE "DailyReport" RENAME COLUMN "issues" TO "notes";
ALTER TABLE "DailyReport" RENAME CONSTRAINT "DailyReport_issues_check" TO "DailyReport_notes_check";
ALTER INDEX "DailyReport_issues_trgm_idx" RENAME TO "DailyReport_notes_trgm_idx";

ALTER TABLE "DailyReport"
  ADD CONSTRAINT "DailyReport_preparedByEngineerId_fkey" FOREIGN KEY ("preparedByEngineerId") REFERENCES "ElectricalEngineer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One report per contractor per day. Its leading column serves the lookups by contractor, so the old single-column index goes.
DROP INDEX "DailyReport_contractorId_idx";
CREATE UNIQUE INDEX "DailyReport_contractorId_reportDate_key" ON "DailyReport"("contractorId", "reportDate");
CREATE INDEX "DailyReport_preparedByEngineerId_idx" ON "DailyReport"("preparedByEngineerId");
