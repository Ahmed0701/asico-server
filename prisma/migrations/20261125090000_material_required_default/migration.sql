-- Every villa needs each catalog material once unless said otherwise, so the balance lists what no delivery brought yet.
ALTER TABLE "MaterialItem" ALTER COLUMN "requiredPerVilla" SET DEFAULT 1;
UPDATE "MaterialItem" SET "requiredPerVilla" = 1 WHERE "requiredPerVilla" = 0;
