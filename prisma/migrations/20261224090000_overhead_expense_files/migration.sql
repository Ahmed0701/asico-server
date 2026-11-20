-- The invoice files of an additional expense: PDFs or photos (JPEG, PNG), kept in the uploads folder under "key". They
-- go with their expense.

CREATE TABLE "OverheadExpenseFile" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverheadExpenseFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OverheadExpenseFile_expenseId_idx" ON "OverheadExpenseFile"("expenseId");

ALTER TABLE "OverheadExpenseFile" ADD CONSTRAINT "OverheadExpenseFile_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "OverheadExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
