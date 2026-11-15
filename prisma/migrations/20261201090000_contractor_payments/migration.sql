-- Payments to contractors (the Payments page), with their receipt or invoice files and a daily reminder while a pending
-- payment is past its due date.
--
--   * A payment belongs to a contractor, and to a villa if it is for one (both RESTRICT: they are not deleted while paid).
--   * The amount is in KWD fils, never negative. A PAID payment has its paid date (CHECK).
--   * A notification is now about exactly one of: a small work, an open work, an owner note, a foreman mission or a payment.
--   * A reminder's situation is the payment, the kind and the day it was raised for: one per payment and day.
-- The new enum value is not used in this migration, so it can be added in the same transaction.

CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHEQUE', 'BANK_TRANSFER');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID');

CREATE TABLE "ContractorPayment" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "villaId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" DATE,
    "paidDate" DATE,
    "method" "PaymentMethod",
    "reference" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractorPayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContractorPayment_amount_check" CHECK ("amountMinor" >= 0),
    CONSTRAINT "ContractorPayment_paid_check" CHECK ("status" = 'PENDING' OR "paidDate" IS NOT NULL)
);

CREATE INDEX "ContractorPayment_contractorId_idx" ON "ContractorPayment"("contractorId");
CREATE INDEX "ContractorPayment_villaId_idx" ON "ContractorPayment"("villaId");
CREATE INDEX "ContractorPayment_status_dueDate_idx" ON "ContractorPayment"("status", "dueDate");

ALTER TABLE "ContractorPayment" ADD CONSTRAINT "ContractorPayment_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractorPayment" ADD CONSTRAINT "ContractorPayment_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ContractorPaymentFile" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractorPaymentFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContractorPaymentFile_paymentId_idx" ON "ContractorPaymentFile"("paymentId");

ALTER TABLE "ContractorPaymentFile" ADD CONSTRAINT "ContractorPaymentFile_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ContractorPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "NotificationKind" ADD VALUE 'PAYMENT_OVERDUE';

ALTER TABLE "Notification" ADD COLUMN "paymentId" TEXT;

ALTER TABLE "Notification" DROP CONSTRAINT "Notification_subject_check";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_subject_check"
  CHECK (num_nonnulls("smallWorkId", "workItemId", "ownerNoteId", "foremanMissionId", "paymentId") = 1);

CREATE UNIQUE INDEX "Notification_paymentId_kind_endDate_key" ON "Notification"("paymentId", "kind", "endDate");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ContractorPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its permissions, so they can be granted at once (the seed adds the same rows).
INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'payments:read'),
    (gen_random_uuid()::text, 'payments:create'),
    (gen_random_uuid()::text, 'payments:update'),
    (gen_random_uuid()::text, 'payments:delete')
ON CONFLICT ("code") DO NOTHING;
