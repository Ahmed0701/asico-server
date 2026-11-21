-- More than one ADMIN: an ADMIN chooses who else is one (PATCH /users/:id/role). The partial unique index that allowed a
-- single ADMIN goes. The service keeps one ADMIN at least: nobody changes their own role, and an ADMIN cannot be
-- deactivated or deleted.

DROP INDEX IF EXISTS "User_single_admin_idx";
