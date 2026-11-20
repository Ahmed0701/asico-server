-- The department's overhead employees (the Department Overhead page): a name, a role and a monthly salary in KWD fils
-- (never negative), and the four permissions of the page.

CREATE TABLE "OverheadEmployee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "salaryMinor" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverheadEmployee_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OverheadEmployee_salary_check" CHECK ("salaryMinor" >= 0)
);

CREATE INDEX "OverheadEmployee_name_idx" ON "OverheadEmployee"("name");

INSERT INTO "Permission" ("id", "code") VALUES
    (gen_random_uuid()::text, 'overhead:read'),
    (gen_random_uuid()::text, 'overhead:create'),
    (gen_random_uuid()::text, 'overhead:update'),
    (gen_random_uuid()::text, 'overhead:delete')
ON CONFLICT ("code") DO NOTHING;
