-- Variation orders of a villa (the Variation Orders card of the villa page), with their PDF files.
--
--   * A variation order belongs to a villa (RESTRICT: a villa with variation orders is not deleted). Its number is unique
--     in the villa.
--   * The amount is in KWD fils, never negative. The status reuses the payments' PENDING / PAID.
--   * Its files go with it (CASCADE).

CREATE TABLE "VariationOrder" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "voNumber" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "dateAdded" DATE NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariationOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VariationOrder_amount_check" CHECK ("amountMinor" >= 0)
);

CREATE UNIQUE INDEX "VariationOrder_villaId_voNumber_key" ON "VariationOrder"("villaId", "voNumber");

ALTER TABLE "VariationOrder" ADD CONSTRAINT "VariationOrder_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "VariationOrderFile" (
    "id" TEXT NOT NULL,
    "variationOrderId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariationOrderFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VariationOrderFile_variationOrderId_idx" ON "VariationOrderFile"("variationOrderId");

ALTER TABLE "VariationOrderFile" ADD CONSTRAINT "VariationOrderFile_variationOrderId_fkey" FOREIGN KEY ("variationOrderId") REFERENCES "VariationOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
