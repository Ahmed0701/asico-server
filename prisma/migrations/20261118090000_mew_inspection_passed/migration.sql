-- MEW inspection passed: a person checks a villa on the MEW inspection list as having passed; it then leaves that list and
-- is on the MEW inspection passed list. A mark like the other MEW ones: when, and by whom. Only columns are added.

ALTER TABLE "Villa" ADD COLUMN "mewInspectionPassedAt" TIMESTAMP(3),
ADD COLUMN "mewInspectionPassedById" TEXT;

CREATE INDEX "Villa_mewInspectionPassedById_idx" ON "Villa"("mewInspectionPassedById");

ALTER TABLE "Villa" ADD CONSTRAINT "Villa_mewInspectionPassedById_fkey" FOREIGN KEY ("mewInspectionPassedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Villa"
  ADD CONSTRAINT "Villa_mew_inspection_passed_check" CHECK ("mewInspectionPassedById" IS NULL OR "mewInspectionPassedAt" IS NOT NULL);
