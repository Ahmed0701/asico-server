-- Payments to a villa's contractor for its progress (the Monthly Payments page): the progress paid up to (tenths of a
-- percent, 0 to 1000), the amount (KWD fils) and the Work Order Value it was worked out with. The next amount due starts
-- from the latest payment. A villa with payments is not deleted; a deleted contractor or user leaves them without it.

CREATE TABLE "ProgressPayment" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "contractorId" TEXT,
    "ratioTenths" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "workOrderMinor" BIGINT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidById" TEXT,

    CONSTRAINT "ProgressPayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProgressPayment_ratio_check" CHECK ("ratioTenths" BETWEEN 0 AND 1000),
    CONSTRAINT "ProgressPayment_amount_check" CHECK ("amountMinor" >= 0 AND "workOrderMinor" >= 0)
);

CREATE INDEX "ProgressPayment_villaId_paidAt_idx" ON "ProgressPayment"("villaId", "paidAt");
CREATE INDEX "ProgressPayment_contractorId_idx" ON "ProgressPayment"("contractorId");
CREATE INDEX "ProgressPayment_paidById_idx" ON "ProgressPayment"("paidById");

ALTER TABLE "ProgressPayment" ADD CONSTRAINT "ProgressPayment_villaId_fkey"
    FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProgressPayment" ADD CONSTRAINT "ProgressPayment_contractorId_fkey"
    FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProgressPayment" ADD CONSTRAINT "ProgressPayment_paidById_fkey"
    FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
