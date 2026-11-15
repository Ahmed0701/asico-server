-- Owner notes: an owner's note about a villa, open until someone checks it as done. While open, the hourly job reminds
-- the admins and the users who may read owner notes once a day (a notification per note and day).
--
--   * The note belongs to a villa (RESTRICT: a villa with notes is not deleted, like one with open works).
--   * A notification is now about exactly one of: a small work, an open work, or an owner note. The CHECK constraint is
--     replaced to count the new column; existing rows have one of the first two, so they pass it.
--   * A reminder's situation is the note, the kind and the day it was raised for (endDate): one per note and day.
-- The new enum value is not used in this migration, so it can be added in the same transaction.

CREATE TABLE "OwnerNote" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnerNote_villaId_idx" ON "OwnerNote"("villaId");
CREATE INDEX "OwnerNote_doneAt_idx" ON "OwnerNote"("doneAt");

ALTER TABLE "OwnerNote" ADD CONSTRAINT "OwnerNote_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TYPE "NotificationKind" ADD VALUE 'OWNER_NOTE_REMINDER';

ALTER TABLE "Notification" ADD COLUMN "ownerNoteId" TEXT;

ALTER TABLE "Notification" DROP CONSTRAINT "Notification_subject_check";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_subject_check" CHECK (num_nonnulls("smallWorkId", "workItemId", "ownerNoteId") = 1);

CREATE UNIQUE INDEX "Notification_ownerNoteId_kind_endDate_key" ON "Notification"("ownerNoteId", "kind", "endDate");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ownerNoteId_fkey" FOREIGN KEY ("ownerNoteId") REFERENCES "OwnerNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its permissions, so they can be granted at once (the seed adds the same rows).
INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'owner-notes:read'),
    (gen_random_uuid()::text, 'owner-notes:create'),
    (gen_random_uuid()::text, 'owner-notes:update'),
    (gen_random_uuid()::text, 'owner-notes:delete')
ON CONFLICT ("code") DO NOTHING;
