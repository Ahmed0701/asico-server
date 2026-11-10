-- Electrical engineers. Additive: one new table and one index, nothing existing is touched.
--
-- Same shape as CivilEngineer (name, phone, a version for If-Match). A villa will point at one of these from a
-- later migration, with a foreign key that blocks deleting an engineer who is still in use.
-- The trigram index serves the search on the name (pg_trgm comes from the "extras" migration).

-- CreateTable
CREATE TABLE "ElectricalEngineer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElectricalEngineer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ElectricalEngineer_name_trgm_idx" ON "ElectricalEngineer" USING GIN ("name" gin_trgm_ops);
