-- The Vendors page lists only the villas added to it by hand: "vendorsListedAt" is when a villa was added (null while
-- it is not on the list). The villas that already have a factory assigned are on it from now.

ALTER TABLE "Villa" ADD COLUMN "vendorsListedAt" TIMESTAMP(3);

UPDATE "Villa"
SET "vendorsListedAt" = CURRENT_TIMESTAMP
WHERE "switchgearFactoryId" IS NOT NULL OR "cableFactoryId" IS NOT NULL;
