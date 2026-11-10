-- Elec phases. Additive: one new enum, one new table, two indexes and six rows. Nothing existing is touched.
--
-- The steps of the electrical work a villa tracks. A table, not an enum, so the list can grow: `sortOrder` is the
-- display order and only ACTIVE phases count towards a villa's overall progress. Villas will point at these from a
-- later migration.
--
-- The names are unique ignoring case. Prisma cannot declare an index on an expression, so it is written here and is
-- not in schema.prisma ("ElecPhase_name_lower_key"; the model carries a comment saying so).
--
-- The six starting phases are inserted by this migration, so every environment gets exactly the same rows, once. They
-- are ordinary rows from then on: they can be renamed, reordered, deactivated and (while unused) deleted, and nothing
-- puts a deleted one back.

-- CreateEnum
CREATE TYPE "ElecPhaseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "ElecPhase" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "status" "ElecPhaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElecPhase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ElecPhase_sortOrder_idx" ON "ElecPhase"("sortOrder");

-- CreateIndex (SQL only: the name, ignoring case)
CREATE UNIQUE INDEX "ElecPhase_name_lower_key" ON "ElecPhase" (lower("name"));

-- The six starting phases, in display order.
INSERT INTO "ElecPhase" ("id", "name", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, "name", "sortOrder", CURRENT_TIMESTAMP
FROM (VALUES
    ('Ceiling Piping', 1),
    ('MSB Box Fixing', 2),
    ('Cut/out Box Fixing', 3),
    ('D.B Box Fixing', 4),
    ('Wall Piping', 5),
    ('Sleeves', 6)
) AS "phase" ("name", "sortOrder");
