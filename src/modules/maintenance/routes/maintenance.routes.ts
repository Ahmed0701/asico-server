import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { MaintenanceController } from "../controller/maintenance.controller.js";
import {
  createMaintenanceSchema,
  listMaintenanceQuerySchema,
  updateMaintenanceSchema,
} from "../validators/maintenance.validators.js";

const controller = new MaintenanceController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const maintenanceRouter = Router();

maintenanceRouter.get(
  "/maintenance",
  ...can(PERMISSIONS.MAINTENANCE_READ),
  validate(listMaintenanceQuerySchema, "query"),
  controller.list,
);
maintenanceRouter.get(
  "/maintenance/:id",
  ...can(PERMISSIONS.MAINTENANCE_READ),
  validate(idParams, "params"),
  controller.get,
);
maintenanceRouter.post(
  "/maintenance",
  ...can(PERMISSIONS.MAINTENANCE_CREATE),
  validate(createMaintenanceSchema),
  idempotent(),
  controller.create,
);
// Also checks it as solved (or not): `solved` in the body.
maintenanceRouter.patch(
  "/maintenance/:id",
  ...can(PERMISSIONS.MAINTENANCE_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateMaintenanceSchema),
  controller.update,
);
maintenanceRouter.delete(
  "/maintenance/:id",
  ...can(PERMISSIONS.MAINTENANCE_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
