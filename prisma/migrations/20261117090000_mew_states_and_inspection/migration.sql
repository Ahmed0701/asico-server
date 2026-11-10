-- MEW: a villa's state with MEW for the AC and for the electricity (NOT_SUBMITTED until someone sets it), and a mark a person
-- sets to put the villa on the MEW inspection list (like the MEW follow-up mark: when, and by whom).
-- Only columns and a type are added; no row changes except the defaults of the two states.

CREATE TYPE "MewState" AS ENUM ('NOT_SUBMITTED', 'RUNNING', 'APPROVED');

ALTER TABLE "Villa" ADD COLUMN "mewAcState" "MewState" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN "mewElecState" "MewState" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN "mewInspectionAt" TIMESTAMP(3),
ADD COLUMN "mewInspectionById" TEXT;

CREATE INDEX "Villa_mewInspectionById_idx" ON "Villa"("mewInspectionById");

ALTER TABLE "Villa" ADD CONSTRAINT "Villa_mewInspectionById_fkey" FOREIGN KEY ("mewInspectionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Villa"
  ADD CONSTRAINT "Villa_mew_inspection_check" CHECK ("mewInspectionById" IS NULL OR "mewInspectionAt" IS NOT NULL);
