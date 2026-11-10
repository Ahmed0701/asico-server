import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { CivilEngineersController } from "../controller/civil-engineers.controller.js";
import {
  createCivilEngineerSchema,
  listCivilEngineersQuerySchema,
  updateCivilEngineerSchema,
} from "../validators/civil-engineers.validators.js";

const controller = new CivilEngineersController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const civilEngineersRouter = Router();

civilEngineersRouter.get(
  "/civil-engineers",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_READ),
  validate(listCivilEngineersQuerySchema, "query"),
  controller.list,
);
// Must stay above "/civil-engineers/:id", otherwise "options" would be read as an id.
civilEngineersRouter.get(
  "/civil-engineers/options",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_READ),
  controller.options,
);
civilEngineersRouter.get(
  "/civil-engineers/:id",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_READ),
  validate(idParams, "params"),
  controller.get,
);
civilEngineersRouter.post(
  "/civil-engineers",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_CREATE),
  validate(createCivilEngineerSchema),
  idempotent(),
  controller.create,
);
civilEngineersRouter.patch(
  "/civil-engineers/:id",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateCivilEngineerSchema),
  controller.update,
);
civilEngineersRouter.delete(
  "/civil-engineers/:id",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
