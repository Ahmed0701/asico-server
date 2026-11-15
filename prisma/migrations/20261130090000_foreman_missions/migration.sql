-- Foreman missions: a foreman's mission at a villa, open until someone checks it as done. While open, the hourly job reminds
-- the admins and the users who may read foreman missions once a day (a notification per mission and day). Built like the
-- owner notes.
--
--   * The mission belongs to a villa (RESTRICT: a villa with missions is not deleted). Its owner name is the villa's.
--   * A notification is now about exactly one of: a small work, an open work, an owner note or a foreman mission. The CHECK
--     constraint is replaced to count the new column; existing rows have one of the others, so they pass it.
--   * A reminder's situation is the mission, the kind and the day it was raised for (endDate): one per mission and day.
-- The new enum value is not used in this migration, so it can be added in the same transaction.

CREATE TABLE "ForemanMission" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForemanMission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ForemanMission_villaId_idx" ON "ForemanMission"("villaId");
CREATE INDEX "ForemanMission_doneAt_idx" ON "ForemanMission"("doneAt");

ALTER TABLE "ForemanMission" ADD CONSTRAINT "ForemanMission_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TYPE "NotificationKind" ADD VALUE 'FOREMAN_MISSION_REMINDER';

ALTER TABLE "Notification" ADD COLUMN "foremanMissionId" TEXT;

ALTER TABLE "Notification" DROP CONSTRAINT "Notification_subject_check";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_subject_check"
  CHECK (num_nonnulls("smallWorkId", "workItemId", "ownerNoteId", "foremanMissionId") = 1);

CREATE UNIQUE INDEX "Notification_foremanMissionId_kind_endDate_key" ON "Notification"("foremanMissionId", "kind", "endDate");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_foremanMissionId_fkey" FOREIGN KEY ("foremanMissionId") REFERENCES "ForemanMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its permissions, so they can be granted at once (the seed adds the same rows).
INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'foreman-missions:read'),
    (gen_random_uuid()::text, 'foreman-missions:create'),
    (gen_random_uuid()::text, 'foreman-missions:update'),
    (gen_random_uuid()::text, 'foreman-missions:delete')
ON CONFLICT ("code") DO NOTHING;
