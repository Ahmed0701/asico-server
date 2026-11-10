-- Slice 18, part 2: in-app notifications, raised by the hourly small works job.
--
--   * "Notification" is one alert about one SITUATION of a small work: the work, the kind (due soon or overdue) and the endDate
--     it was raised for. The unique index on those three makes the job safe to rerun and to race (the second insert does
--     nothing), and a moved endDate is a new situation. Deleted with its small work (CASCADE). "data" is the text of the alert as
--     it was; "emailedAt" is set when the digest email that lists it was sent (NULL: still to send).
--   * "NotificationRecipient" is the copy one user sees, with that user's own "readAt". Deleted with the notification or the user.
-- Nothing is deleted or changed in an existing table, and nothing is backfilled. The migration runs as one transaction.

CREATE TYPE "NotificationKind" AS ENUM ('SMALL_WORK_DUE_SOON', 'SMALL_WORK_OVERDUE');

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "smallWorkId" TEXT NOT NULL,
    "endDate" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationRecipient" (
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("notificationId", "userId")
);

CREATE UNIQUE INDEX "Notification_smallWorkId_kind_endDate_key" ON "Notification"("smallWorkId", "kind", "endDate");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "NotificationRecipient_userId_createdAt_idx" ON "NotificationRecipient"("userId", "createdAt" DESC);
CREATE INDEX "NotificationRecipient_userId_readAt_idx" ON "NotificationRecipient"("userId", "readAt");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_smallWorkId_fkey" FOREIGN KEY ("smallWorkId") REFERENCES "DailySmallWork"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
