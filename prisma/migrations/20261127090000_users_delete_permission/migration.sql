-- Deleting users for good: a permission of its own (an ADMIN holds it by role; it can be granted).
INSERT INTO "Permission" ("id", "code") VALUES (gen_random_uuid()::text, 'users:delete')
ON CONFLICT ("code") DO NOTHING;
