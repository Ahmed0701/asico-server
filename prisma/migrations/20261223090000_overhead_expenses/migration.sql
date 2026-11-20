-- Additional expenses (invoices, purchases, transport and others) entered on the Department Overhead page, each for one
-- villa: they add to that villa's costs. The amount is KWD fils, never negative. A villa with expenses is not deleted.

CREATE TABLE "OverheadExpense" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "invoiceNumber" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverheadExpense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OverheadExpense_amount_check" CHECK ("amountMinor" >= 0),
    CONSTRAINT "OverheadExpense_type_check" CHECK ("type" IN ('INVOICE', 'PURCHASE', 'TRANSPORT', 'OTHER'))
);

CREATE INDEX "OverheadExpense_villaId_idx" ON "OverheadExpense"("villaId");
CREATE INDEX "OverheadExpense_expenseDate_idx" ON "OverheadExpense"("expenseDate");

ALTER TABLE "OverheadExpense" ADD CONSTRAINT "OverheadExpense_villaId_fkey"
    FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
