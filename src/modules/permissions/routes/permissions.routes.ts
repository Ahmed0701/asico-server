import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { PermissionsController } from "../controller/permissions.controller.js";
import { replacePermissionsSchema } from "../validators/permissions.validators.js";

const controller = new PermissionsController();
const canAssign = [auth, requirePermission(PERMISSIONS.PERMISSIONS_ASSIGN)];

export const permissionsRouter = Router();

permissionsRouter.get("/permissions", ...canAssign, controller.list);
permissionsRouter.get(
  "/users/:id/permissions",
  ...canAssign,
  validate(idParams, "params"),
  controller.getForUser,
);
permissionsRouter.put(
  "/users/:id/permissions",
  ...canAssign,
  validate(idParams, "params"),
  validate(replacePermissionsSchema),
  controller.replaceForUser,
);
