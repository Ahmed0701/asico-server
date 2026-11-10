-- The maintenance villas: typed by hand (not linked to the villas), open until someone checks them as solved.
CREATE TABLE "MaintenanceVilla" (
    "id" TEXT NOT NULL,
    "villaNumber" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "handoverDate" DATE NOT NULL,
    "issue" TEXT NOT NULL,
    "solvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceVilla_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaintenanceVilla_solvedAt_idx" ON "MaintenanceVilla"("solvedAt");

-- Its permissions, so they can be granted at once (the seed adds the same rows).
INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'maintenance:read'),
    (gen_random_uuid()::text, 'maintenance:create'),
    (gen_random_uuid()::text, 'maintenance:update'),
    (gen_random_uuid()::text, 'maintenance:delete')
ON CONFLICT ("code") DO NOTHING;
