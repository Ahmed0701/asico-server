-- An index of the open works by villa and electrical phase: a villa's progress is read from the average progress of its
-- open works under each phase, grouped by exactly these two columns. Found by the heavy load check (2,000 villas).

CREATE INDEX "WorkItem_villaId_elecPhaseId_idx" ON "WorkItem"("villaId", "elecPhaseId");
