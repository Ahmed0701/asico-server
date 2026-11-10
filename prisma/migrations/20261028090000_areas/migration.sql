-- Areas: the place a villa is in becomes a table of its own (a name and a city) instead of free text on every project.
--
-- The projects' "area" text is turned into Area rows first (one row per distinct value, ignoring case and the spaces
-- around it), every project is pointed at its row, and only then is the text column dropped. The cities are not known,
-- so every Area created from existing data gets the city 'Unspecified' and can be corrected with PATCH /areas/:id.
-- The migration runs as one transaction: if anything fails (for example two projects that differed only by the case of
-- their area now share a block and a plot number), nothing is changed.
--
-- The number of villas in an area is never stored; it is counted when asked for.
--
-- Written by hand because of the data copy and because Prisma cannot declare the case-insensitive unique index.

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- An area is identified by its name within its city, ignoring case.
CREATE UNIQUE INDEX "Area_name_city_lower_key" ON "Area" (lower("name"), lower("city"));

-- Backfill: one Area per distinct existing area text. When the same text was written in different cases, the spelling
-- used most often is kept (ties go to the first in plain byte order, so the choice never depends on the collation).
INSERT INTO "Area" ("id", "name", "city", "updatedAt")
SELECT gen_random_uuid()::text, "found"."name", 'Unspecified', now()
FROM (
    SELECT DISTINCT ON (lower(btrim("area"))) btrim("area") AS "name"
    FROM "Project"
    GROUP BY lower(btrim("area")), btrim("area")
    ORDER BY lower(btrim("area")), count(*) DESC, btrim("area") COLLATE "C"
) AS "found";

-- AlterTable: the link is added empty, filled from the text, and only then made required.
ALTER TABLE "Project" ADD COLUMN "areaId" TEXT;

UPDATE "Project"
SET "areaId" = "Area"."id"
FROM "Area"
WHERE lower("Area"."name") = lower(btrim("Project"."area"))
  AND "Area"."city" = 'Unspecified';

ALTER TABLE "Project" ALTER COLUMN "areaId" SET NOT NULL;

-- AddForeignKey: an area that has villas cannot be deleted.
ALTER TABLE "Project" ADD CONSTRAINT "Project_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The old text column goes, with the indexes that were built on it.
DROP INDEX "Project_area_trgm_idx";
DROP INDEX "Project_area_block_plotNumber_key";
ALTER TABLE "Project" DROP COLUMN "area";

-- CreateIndex: a plot is identified by its area, its block and its number.
CREATE UNIQUE INDEX "Project_areaId_block_plotNumber_key" ON "Project"("areaId", "block", "plotNumber");

-- CreateIndex
CREATE INDEX "Project_areaId_idx" ON "Project"("areaId");
