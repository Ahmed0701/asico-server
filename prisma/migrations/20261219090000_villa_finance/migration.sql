-- The money of a villa besides its budget: the work order value, the salaries, the material values and the petty cash,
-- each in KWD fils (never negative), null until entered. One row a villa; it goes with the villa.

CREATE TABLE "VillaFinance" (
    "villaId" TEXT NOT NULL,
    "workOrderMinor" BIGINT,
    "salariesMinor" BIGINT,
    "materialsMinor" BIGINT,
    "pettyCashMinor" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "VillaFinance_pkey" PRIMARY KEY ("villaId"),
    CONSTRAINT "VillaFinance_amounts_check" CHECK (
        coalesce("workOrderMinor", 0) >= 0 AND coalesce("salariesMinor", 0) >= 0
        AND coalesce("materialsMinor", 0) >= 0 AND coalesce("pettyCashMinor", 0) >= 0
    )
);

CREATE INDEX "VillaFinance_updatedById_idx" ON "VillaFinance"("updatedById");

ALTER TABLE "VillaFinance" ADD CONSTRAINT "VillaFinance_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VillaFinance" ADD CONSTRAINT "VillaFinance_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
