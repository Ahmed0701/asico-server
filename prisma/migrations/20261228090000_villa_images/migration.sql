-- The site images of a villa (the Site Images section of the villa page): JPEG or PNG photos kept in the villa's folder
-- under "key". The rows go with the villa; a user who uploaded one may be deleted (the image stays, without its uploader).

CREATE TABLE "VillaImage" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VillaImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VillaImage_key_key" ON "VillaImage"("key");
CREATE INDEX "VillaImage_villaId_uploadedAt_idx" ON "VillaImage"("villaId", "uploadedAt");
CREATE INDEX "VillaImage_uploadedById_idx" ON "VillaImage"("uploadedById");

ALTER TABLE "VillaImage" ADD CONSTRAINT "VillaImage_villaId_fkey"
    FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VillaImage" ADD CONSTRAINT "VillaImage_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
