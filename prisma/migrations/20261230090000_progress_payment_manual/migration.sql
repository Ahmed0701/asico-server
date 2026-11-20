-- Payments made before the system, entered by hand on the villa page: marked as manual, with a note (a receipt number,
-- for example). A manual payment can be removed at any time; one recorded by the system only while it is the latest.

ALTER TABLE "ProgressPayment" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProgressPayment" ADD COLUMN "note" TEXT;
