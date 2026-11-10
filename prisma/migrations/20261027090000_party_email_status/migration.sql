-- Email and status for civil engineers, electrical engineers and contractors. Additive: one new enum and two new
-- columns on each of three tables. Nothing is dropped, renamed or rewritten.
--
-- "email" is optional (NULL for every existing row) and has no unique constraint: two records may share an address.
-- Its format is checked by the API, not by the database.
--
-- "status" is ACTIVE or INACTIVE. Every existing row becomes ACTIVE (a constant default is applied without
-- rewriting the table), so nothing changes for anyone until a record is deactivated. INACTIVE records keep working
-- in lists, searches, exports and on the projects that point at them; they are only left out of the options lists
-- that feed forms.

-- CreateEnum
CREATE TYPE "PartyStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "CivilEngineer" ADD COLUMN "email" TEXT,
ADD COLUMN "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "ElectricalEngineer" ADD COLUMN "email" TEXT,
ADD COLUMN "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Contractor" ADD COLUMN "email" TEXT,
ADD COLUMN "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE';
