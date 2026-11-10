-- Hand-written. Things Prisma cannot model, plus the trigram indexes that need pg_trgm first.
-- The GIN indexes are declared in schema.prisma (so `migrate dev` sees no drift) but created here,
-- after the extension, instead of in the generated init migration.

-- Trigram search -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Project_projectNumber_trgm_idx" ON "Project" USING GIN ("projectNumber" gin_trgm_ops);
CREATE INDEX "Project_plotNumber_trgm_idx" ON "Project" USING GIN ("plotNumber" gin_trgm_ops);
CREATE INDEX "Project_area_trgm_idx" ON "Project" USING GIN ("area" gin_trgm_ops);
CREATE INDEX "Project_block_trgm_idx" ON "Project" USING GIN ("block" gin_trgm_ops);
CREATE INDEX "Contractor_name_trgm_idx" ON "Contractor" USING GIN ("name" gin_trgm_ops);

-- Only one ADMIN user can exist ----------------------------------------------
CREATE UNIQUE INDEX "User_single_admin_idx" ON "User" ("role") WHERE "role" = 'ADMIN';

-- A project has exactly four activities, at positions 1 to 4 ------------------
ALTER TABLE "ProjectActivity"
  ADD CONSTRAINT "ProjectActivity_position_check" CHECK ("position" BETWEEN 1 AND 4);

-- AuditLog is append-only ----------------------------------------------------
-- DELETE and TRUNCATE are rejected. UPDATE is rejected too, except the one change
-- `ON DELETE SET NULL` performs when a user is deleted: actorId going from a value to NULL
-- with every other column unchanged.
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL
     AND NEW."actorId" IS NULL
     AND (to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'AuditLog is append-only: % rejected', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "AuditLog_append_only_rows"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();
