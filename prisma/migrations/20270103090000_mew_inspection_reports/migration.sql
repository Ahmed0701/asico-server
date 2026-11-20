-- The MEW inspection report of a villa: one PDF uploaded from the MEW Inspection list (a new upload replaces it), kept in
-- the villa's folder. It goes with the villa; a deleted user leaves it without its uploader.

CREATE TABLE "MewInspectionReport" (
    "villaId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MewInspectionReport_pkey" PRIMARY KEY ("villaId")
);

CREATE UNIQUE INDEX "MewInspectionReport_key_key" ON "MewInspectionReport"("key");
CREATE INDEX "MewInspectionReport_uploadedById_idx" ON "MewInspectionReport"("uploadedById");

ALTER TABLE "MewInspectionReport" ADD CONSTRAINT "MewInspectionReport_villaId_fkey"
    FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MewInspectionReport" ADD CONSTRAINT "MewInspectionReport_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
