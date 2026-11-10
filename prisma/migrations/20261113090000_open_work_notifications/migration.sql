-- Notifications about overdue open works, raised by the same hourly job as the small works.
--
--   * A notification is now about exactly one thing: a small work ("smallWorkId") or an open work ("workItemId"). The CHECK
--     constraint keeps exactly one of the two set; existing rows all have a small work, so they pass it.
--   * An open work's situation is the work, the kind and the endDate, unique like the small works' (a moved endDate is a new
--     situation). Deleted with its open work (CASCADE).
-- Nothing is backfilled. The new enum value is not used in this migration, so it can be added in the same transaction.

ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_WORK_OVERDUE';

ALTER TABLE "Notification" ALTER COLUMN "smallWorkId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "workItemId" TEXT;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_subject_check" CHECK (num_nonnulls("smallWorkId", "workItemId") = 1);

CREATE UNIQUE INDEX "Notification_workItemId_kind_endDate_key" ON "Notification"("workItemId", "kind", "endDate");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
