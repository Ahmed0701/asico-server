-- MEW follow up: a person can put a villa on the MEW follow-up list, and take it off again. Works like the
-- ready-for-inspection mark.
--
--   * "mewFollowUpAt" is when the villa was marked; NULL means it is not marked. "mewFollowUpById" is who marked it.
--     The user can be deleted later without deleting the villa (SET NULL), so the user can be NULL while the time stays.
--   * A user can only be recorded together with a time ("Villa_mew_follow_up_check").
-- Only columns are added to "Villa"; no row is changed.

ALTER TABLE "Villa" ADD COLUMN "mewFollowUpAt" TIMESTAMP(3),
ADD COLUMN "mewFollowUpById" TEXT;

CREATE INDEX "Villa_mewFollowUpById_idx" ON "Villa"("mewFollowUpById");

ALTER TABLE "Villa" ADD CONSTRAINT "Villa_mewFollowUpById_fkey" FOREIGN KEY ("mewFollowUpById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Villa"
  ADD CONSTRAINT "Villa_mew_follow_up_check" CHECK ("mewFollowUpById" IS NULL OR "mewFollowUpAt" IS NOT NULL);
