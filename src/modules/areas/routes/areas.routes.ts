import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { AreasController } from "../controller/areas.controller.js";
import { createAreaSchema, listAreasQuerySchema, updateAreaSchema } from "../validators/areas.validators.js";

const controller = new AreasController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const areasRouter = Router();

areasRouter.get(
  "/areas",
  ...can(PERMISSIONS.AREAS_READ),
  validate(listAreasQuerySchema, "query"),
  controller.list,
);
// Must stay above "/areas/:id", otherwise "options" would be read as an id.
areasRouter.get("/areas/options", ...can(PERMISSIONS.AREAS_READ), controller.options);
areasRouter.get("/areas/:id", ...can(PERMISSIONS.AREAS_READ), validate(idParams, "params"), controller.get);
areasRouter.post(
  "/areas",
  ...can(PERMISSIONS.AREAS_CREATE),
  validate(createAreaSchema),
  idempotent(),
  controller.create,
);
areasRouter.patch(
  "/areas/:id",
  ...can(PERMISSIONS.AREAS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateAreaSchema),
  controller.update,
);
areasRouter.delete(
  "/areas/:id",
  ...can(PERMISSIONS.AREAS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
