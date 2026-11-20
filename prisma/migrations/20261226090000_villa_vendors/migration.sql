-- The factories assigned to supply a villa (the Vendors page): one switchgear factory and one cable factory, both
-- optional. A factory assigned to a villa cannot be deleted (Restrict); the application also keeps each one of its type.

ALTER TABLE "Villa" ADD COLUMN "switchgearFactoryId" TEXT;
ALTER TABLE "Villa" ADD COLUMN "cableFactoryId" TEXT;

CREATE INDEX "Villa_switchgearFactoryId_idx" ON "Villa"("switchgearFactoryId");
CREATE INDEX "Villa_cableFactoryId_idx" ON "Villa"("cableFactoryId");

ALTER TABLE "Villa" ADD CONSTRAINT "Villa_switchgearFactoryId_fkey"
    FOREIGN KEY ("switchgearFactoryId") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Villa" ADD CONSTRAINT "Villa_cableFactoryId_fkey"
    FOREIGN KEY ("cableFactoryId") REFERENCES "Factory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
