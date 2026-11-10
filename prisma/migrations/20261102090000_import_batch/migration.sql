-- Imports: one row per spreadsheet file that was imported, so the same file imported twice is refused. Written by hand
-- because Prisma cannot express the CHECK constraint.
--
--   * "entity" is what the file was imported into ("Contractor"); "fileHash" is the SHA-256 of the file's bytes. The pair is
--     unique, which is the rule itself: a second import of the same file, even two at the same moment, cannot both be saved.
--   * "rows" is how many records the file created.
--   * The user is deleted later without deleting the row (SET NULL).
--   * Dry runs and failed imports are not recorded: only a file whose records were saved leaves a row.
-- Only a table is added; nothing is changed or deleted, and the "AuditLog" table is not touched.
-- The migration runs as one transaction: if anything fails, nothing is changed.

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "userId" TEXT,
    "rows" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportBatch_entity_fileHash_key" ON "ImportBatch"("entity", "fileHash");

CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_rows_check" CHECK ("rows" >= 0);
