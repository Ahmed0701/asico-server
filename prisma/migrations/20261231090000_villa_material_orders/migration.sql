-- The Material Orders tab: for each villa and factory type (switchgear, cables), the dates of the material request (MR),
-- the purchase order (PO) and when the materials are due. Whether they came is worked out from the balance. Removed
-- with the villa.

CREATE TABLE "VillaMaterialOrder" (
    "villaId" TEXT NOT NULL,
    "type" "FactoryType" NOT NULL,
    "mrDate" DATE,
    "poDate" DATE,
    "dueDate" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VillaMaterialOrder_pkey" PRIMARY KEY ("villaId", "type")
);

ALTER TABLE "VillaMaterialOrder" ADD CONSTRAINT "VillaMaterialOrder_villaId_fkey"
    FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
