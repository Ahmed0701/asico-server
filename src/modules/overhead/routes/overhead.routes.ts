import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { OverheadController } from "../controller/overhead.controller.js";
import {
  createOverheadSchema,
  listOverheadQuerySchema,
  updateOverheadSchema,
} from "../validators/overhead.validators.js";

const controller = new OverheadController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing. Salaries
// are behind their own permissions (overhead:*), not the villas'.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const overheadRouter = Router();

overheadRouter.get(
  "/overhead-employees",
  ...can(PERMISSIONS.OVERHEAD_READ),
  validate(listOverheadQuerySchema, "query"),
  controller.list,
);
overheadRouter.get(
  "/overhead-employees/:id",
  ...can(PERMISSIONS.OVERHEAD_READ),
  validate(idParams, "params"),
  controller.get,
);
overheadRouter.post(
  "/overhead-employees",
  ...can(PERMISSIONS.OVERHEAD_CREATE),
  validate(createOverheadSchema),
  idempotent(),
  controller.create,
);
overheadRouter.patch(
  "/overhead-employees/:id",
  ...can(PERMISSIONS.OVERHEAD_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateOverheadSchema),
  controller.update,
);
overheadRouter.delete(
  "/overhead-employees/:id",
  ...can(PERMISSIONS.OVERHEAD_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
