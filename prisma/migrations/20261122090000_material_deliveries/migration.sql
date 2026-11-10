-- Material deliveries from switchgear and cable factories to the villas, each with its delivery note.
CREATE TYPE "FactoryType" AS ENUM ('SWITCHGEAR', 'CABLE');

CREATE TABLE "Factory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FactoryType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Factory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Factory_type_name_key" ON "Factory"("type", "name");

CREATE TABLE "MaterialDelivery" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "factoryId" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "noteNumber" TEXT,
    "deliveryDate" DATE NOT NULL,
    "noteKey" TEXT,
    "noteName" TEXT,
    "noteMime" TEXT,
    "noteSize" INTEGER,
    "noteUploadedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaterialDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaterialDelivery_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "MaterialDelivery_note_check" CHECK (
        ("noteKey" IS NULL AND "noteName" IS NULL AND "noteMime" IS NULL AND "noteSize" IS NULL AND "noteUploadedAt" IS NULL)
        OR ("noteKey" IS NOT NULL AND "noteName" IS NOT NULL AND "noteMime" IS NOT NULL AND "noteSize" IS NOT NULL AND "noteUploadedAt" IS NOT NULL)
    )
);
CREATE INDEX "MaterialDelivery_villaId_idx" ON "MaterialDelivery"("villaId");
CREATE INDEX "MaterialDelivery_factoryId_idx" ON "MaterialDelivery"("factoryId");
CREATE INDEX "MaterialDelivery_deliveryDate_idx" ON "MaterialDelivery"("deliveryDate");
ALTER TABLE "MaterialDelivery" ADD CONSTRAINT "MaterialDelivery_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialDelivery" ADD CONSTRAINT "MaterialDelivery_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Its permissions, so they can be granted at once (the seed adds the same rows).
INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'materials:read'),
    (gen_random_uuid()::text, 'materials:create'),
    (gen_random_uuid()::text, 'materials:update'),
    (gen_random_uuid()::text, 'materials:delete')
ON CONFLICT ("code") DO NOTHING;
