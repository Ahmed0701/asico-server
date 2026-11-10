import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { UsersController } from "../controller/users.controller.js";
import { createUserSchema, listUsersQuerySchema, updateUserSchema } from "../validators/users.validators.js";

const controller = new UsersController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Parameters<typeof requirePermission>[0]) => [auth, requirePermission(permission)];

export const usersRouter = Router();

usersRouter.get(
  "/users",
  ...can(PERMISSIONS.USERS_READ),
  validate(listUsersQuerySchema, "query"),
  controller.list,
);
usersRouter.get("/users/:id", ...can(PERMISSIONS.USERS_READ), validate(idParams, "params"), controller.get);
usersRouter.post(
  "/users",
  ...can(PERMISSIONS.USERS_CREATE),
  validate(createUserSchema),
  idempotent(),
  controller.create,
);
usersRouter.patch(
  "/users/:id",
  ...can(PERMISSIONS.USERS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateUserSchema),
  controller.update,
);
// Starts a password reset for another user: a link by email, their sessions signed out. Only the ADMIN may do it to
// the ADMIN account (the service checks).
usersRouter.post(
  "/users/:id/reset-password",
  ...can(PERMISSIONS.USERS_UPDATE),
  validate(idParams, "params"),
  idempotent(),
  controller.resetPassword,
);
usersRouter.patch(
  "/users/:id/activate",
  ...can(PERMISSIONS.USERS_DEACTIVATE),
  validate(idParams, "params"),
  ifMatch(),
  controller.activate,
);
usersRouter.patch(
  "/users/:id/deactivate",
  ...can(PERMISSIONS.USERS_DEACTIVATE),
  validate(idParams, "params"),
  ifMatch(),
  controller.deactivate,
);
// There is deliberately no DELETE /users/:id: users are deactivated, never deleted.
// Deleting a user for good: an ADMIN holds this, and it can be granted (see UsersService.remove for who can be deleted).
usersRouter.delete(
  "/users/:id",
  ...can(PERMISSIONS.USERS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
