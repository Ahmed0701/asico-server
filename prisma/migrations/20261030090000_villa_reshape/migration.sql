-- Villa reshape: a villa gets an owner name, an optional electrical engineer and an optional budget; its start and target
-- dates become calendar days; and the database learns the rules that go with them. Written by hand because Prisma cannot
-- express CHECK constraints or collations.
--
--   * "ownerName"            free text, optional.
--   * "electricalEngineerId" optional foreign key, ON DELETE RESTRICT: an engineer with villas cannot be deleted.
--   * "budgetMinor"/"currency" the budget in minor units (BIGINT) and its ISO 4217 code (CHAR(3)). Both set or both null,
--                            never negative, never beyond 2^53-1 (the API sends it as a JSON number).
--   * "startDate"/"targetDate" were timestamps (always the start of a UTC day) and become DATE. "targetDate" may not be
--                            before "startDate".
--   * the ICU collation "asico_natural": numbers inside text sort by value ("2" before "10", "A9" before "A10"). The villa
--                            list uses it to order by area, block and plot.
--   * trigram indexes for the villa search: "Villa"."ownerName" and "CivilEngineer"."name" ("ElectricalEngineer"."name"
--                            already has one).
-- Nothing is deleted, and the "AuditLog" table and its append-only trigger are not touched.
-- The migration runs as one transaction: if anything fails (no ICU, or data that breaks a new rule), nothing is changed.

-- 0. Preflight. Fail loudly, with a reason, before anything is changed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collprovider = 'i') THEN
    RAISE EXCEPTION 'This PostgreSQL has no ICU collations, so the natural sort order (collation asico_natural) cannot be created. Use a PostgreSQL build with ICU (the official postgres images have it).';
  END IF;
  IF EXISTS (SELECT 1 FROM "Villa" WHERE "startDate" IS NOT NULL AND "targetDate" IS NOT NULL AND "targetDate" < "startDate") THEN
    RAISE EXCEPTION 'Some villas have a target date before their start date (% rows). Fix them first, then run this migration again.',
      (SELECT count(*) FROM "Villa" WHERE "startDate" IS NOT NULL AND "targetDate" IS NOT NULL AND "targetDate" < "startDate");
  END IF;
END
$$;

-- 1. The natural sort order.
CREATE COLLATION "asico_natural" (provider = icu, locale = 'en-u-kn-true', deterministic = false);

-- 2. Dates become calendar days. The timestamps are in UTC, so the day is the UTC day.
ALTER TABLE "Villa"
  ALTER COLUMN "startDate" TYPE DATE USING ("startDate"::date),
  ALTER COLUMN "targetDate" TYPE DATE USING ("targetDate"::date);

-- 3. The new columns.
ALTER TABLE "Villa"
  ADD COLUMN "ownerName" TEXT,
  ADD COLUMN "electricalEngineerId" TEXT,
  ADD COLUMN "budgetMinor" BIGINT,
  ADD COLUMN "currency" CHAR(3);

-- 4. The rules.
ALTER TABLE "Villa"
  ADD CONSTRAINT "Villa_dates_check" CHECK ("startDate" IS NULL OR "targetDate" IS NULL OR "targetDate" >= "startDate"),
  ADD CONSTRAINT "Villa_budget_check" CHECK (
    ("budgetMinor" IS NULL) = ("currency" IS NULL)
    AND ("budgetMinor" IS NULL OR ("budgetMinor" >= 0 AND "budgetMinor" <= 9007199254740991))
    AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
  );

-- 5. The electrical engineer link.
CREATE INDEX "Villa_electricalEngineerId_idx" ON "Villa"("electricalEngineerId");
ALTER TABLE "Villa" ADD CONSTRAINT "Villa_electricalEngineerId_fkey" FOREIGN KEY ("electricalEngineerId") REFERENCES "ElectricalEngineer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. The search indexes (case-insensitive "contains" on the owner and the civil engineer).
CREATE INDEX "Villa_ownerName_trgm_idx" ON "Villa" USING GIN ("ownerName" gin_trgm_ops);
CREATE INDEX "CivilEngineer_name_trgm_idx" ON "CivilEngineer" USING GIN ("name" gin_trgm_ops);
