-- A delivery is no longer one typed material: it has lines, each a material from a catalog and a quantity.

CREATE TABLE "MaterialItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FactoryType" NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "requiredPerVilla" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaterialItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaterialItem_required_check" CHECK ("requiredPerVilla" >= 0)
);
CREATE UNIQUE INDEX "MaterialItem_type_name_key" ON "MaterialItem"("type", "name");

-- The switchgear materials the factories deliver, in the order a delivery note lists them.
INSERT INTO "MaterialItem" ("id", "name", "type", "unit", "sortOrder", "updatedAt") VALUES
    (gen_random_uuid()::text, 'Cut-out Box', 'SWITCHGEAR', 'pcs', 10, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'MSB Box', 'SWITCHGEAR', 'pcs', 20, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'MSB Interior', 'SWITCHGEAR', 'pcs', 30, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'DB Enclosure', 'SWITCHGEAR', 'pcs', 40, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'DB Interior', 'SWITCHGEAR', 'pcs', 50, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'AC Box', 'SWITCHGEAR', 'pcs', 60, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'AC Interior', 'SWITCHGEAR', 'pcs', 70, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'AVA Box', 'SWITCHGEAR', 'pcs', 80, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'Draw Box', 'SWITCHGEAR', 'pcs', 90, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

CREATE TABLE "MaterialDeliveryLine" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "MaterialDeliveryLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaterialDeliveryLine_quantity_check" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "MaterialDeliveryLine_deliveryId_itemId_key" ON "MaterialDeliveryLine"("deliveryId", "itemId");
CREATE INDEX "MaterialDeliveryLine_itemId_idx" ON "MaterialDeliveryLine"("itemId");
ALTER TABLE "MaterialDeliveryLine" ADD CONSTRAINT "MaterialDeliveryLine_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MaterialDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaterialDeliveryLine" ADD CONSTRAINT "MaterialDeliveryLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a villa needs when it differs from the catalog. It goes with the villa and with the item.
CREATE TABLE "VillaMaterialRequirement" (
    "villaId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "VillaMaterialRequirement_pkey" PRIMARY KEY ("villaId", "itemId"),
    CONSTRAINT "VillaMaterialRequirement_quantity_check" CHECK ("quantity" >= 0)
);
CREATE INDEX "VillaMaterialRequirement_itemId_idx" ON "VillaMaterialRequirement"("itemId");
ALTER TABLE "VillaMaterialRequirement" ADD CONSTRAINT "VillaMaterialRequirement_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VillaMaterialRequirement" ADD CONSTRAINT "VillaMaterialRequirement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deliveries recorded before keep what they hold: each typed material becomes a catalog item of its factory's type
-- (unless the catalog has it already), and the delivery gets one line with its quantity.
INSERT INTO "MaterialItem" ("id", "name", "type", "unit", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, d."material", f."type", min(d."unit"), 1000, CURRENT_TIMESTAMP
FROM "MaterialDelivery" d JOIN "Factory" f ON f."id" = d."factoryId"
GROUP BY d."material", f."type"
ON CONFLICT ("type", "name") DO NOTHING;

INSERT INTO "MaterialDeliveryLine" ("id", "deliveryId", "itemId", "quantity")
SELECT gen_random_uuid()::text, d."id", i."id", d."quantity"
FROM "MaterialDelivery" d
JOIN "Factory" f ON f."id" = d."factoryId"
JOIN "MaterialItem" i ON i."type" = f."type" AND i."name" = d."material";

ALTER TABLE "MaterialDelivery" DROP CONSTRAINT "MaterialDelivery_quantity_check";
ALTER TABLE "MaterialDelivery" DROP COLUMN "material",
DROP COLUMN "quantity",
DROP COLUMN "unit";
