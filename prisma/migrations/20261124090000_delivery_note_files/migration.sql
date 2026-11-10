-- A delivery can have several delivery note files: they move from columns of the delivery to a table of their own.
CREATE TABLE "MaterialDeliveryNote" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialDeliveryNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MaterialDeliveryNote_deliveryId_idx" ON "MaterialDeliveryNote"("deliveryId");
ALTER TABLE "MaterialDeliveryNote" ADD CONSTRAINT "MaterialDeliveryNote_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MaterialDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The note each delivery already has becomes its first file (the file on disk stays where it is).
INSERT INTO "MaterialDeliveryNote" ("id", "deliveryId", "key", "name", "mime", "size", "uploadedAt")
SELECT gen_random_uuid()::text, "id", "noteKey", "noteName", "noteMime", "noteSize", "noteUploadedAt"
FROM "MaterialDelivery" WHERE "noteKey" IS NOT NULL;

ALTER TABLE "MaterialDelivery" DROP CONSTRAINT "MaterialDelivery_note_check";
ALTER TABLE "MaterialDelivery" DROP COLUMN "noteKey",
DROP COLUMN "noteName",
DROP COLUMN "noteMime",
DROP COLUMN "noteSize",
DROP COLUMN "noteUploadedAt";
