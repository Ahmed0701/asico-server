-- The progress ratio of an elec phase: how much it counts in a villa's overall progress, 0 to 100.
--
--   * The overall progress becomes the average of the active phases weighted by their ratio. While every active phase
--     is at 0, they all count the same (the plain average), so nothing changes until someone sets a ratio.
--   * The existing phases all get the same ratio (100 split over the active phases, at least 1), so every villa keeps
--     the progress it has today.

ALTER TABLE "ElecPhase" ADD COLUMN "progressRatio" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "ElecPhase"
  ADD CONSTRAINT "ElecPhase_progressRatio_check" CHECK ("progressRatio" BETWEEN 0 AND 100);

UPDATE "ElecPhase"
SET "progressRatio" = GREATEST(1, 100 / GREATEST(1, (SELECT count(*) FROM "ElecPhase" WHERE "status" = 'ACTIVE')));
