-- Owner notes take the owner name from their villa (always the current one), so the note keeps no copy of it.
ALTER TABLE "OwnerNote" DROP COLUMN "ownerName";
