-- How a villa is built. Nullable: villas saved before the type existed have none until someone sets it.
CREATE TYPE "VillaType" AS ENUM ('ACICO_SYSTEM', 'CONVENTIONAL');

ALTER TABLE "Villa" ADD COLUMN "villaType" "VillaType";
