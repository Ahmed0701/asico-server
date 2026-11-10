-- Ready for inspection is removed from the application: the MEW follow-up, inspection and passed lists took its place.
-- Its columns go, with what was stored in them (who marked a villa ready, and when). The audit log keeps its entries.

ALTER TABLE "Villa" DROP CONSTRAINT IF EXISTS "Villa_ready_check";
ALTER TABLE "Villa" DROP CONSTRAINT IF EXISTS "Villa_readyForInspectionById_fkey";
DROP INDEX IF EXISTS "Villa_readyForInspectionById_idx";
ALTER TABLE "Villa" DROP COLUMN "readyForInspectionAt",
DROP COLUMN "readyForInspectionById";
