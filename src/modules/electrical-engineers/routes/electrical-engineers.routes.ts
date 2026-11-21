import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { ElectricalEngineersController } from "../controller/electrical-engineers.controller.js";
import {
  createElectricalEngineerSchema,
  listElectricalEngineersQuerySchema,
  updateElectricalEngineerSchema,
  transferVillasSchema,
} from "../validators/electrical-engineers.validators.js";

const controller = new ElectricalEngineersController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const electricalEngineersRouter = Router();

electricalEngineersRouter.get(
  "/electrical-engineers",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_READ),
  validate(listElectricalEngineersQuerySchema, "query"),
  controller.list,
);
// Must stay above "/electrical-engineers/:id", otherwise "options" would be read as an id.
electricalEngineersRouter.get(
  "/electrical-engineers/options",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_READ),
  controller.options,
);
// The users the engineer form can link (for whoever may create or change engineers). Above "/:id" too.
electricalEngineersRouter.get(
  "/electrical-engineers/user-options",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_UPDATE),
  controller.userOptions,
);
electricalEngineersRouter.get(
  "/electrical-engineers/:id",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_READ),
  validate(idParams, "params"),
  controller.get,
);
electricalEngineersRouter.post(
  "/electrical-engineers",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_CREATE),
  validate(createElectricalEngineerSchema),
  idempotent(),
  controller.create,
);
electricalEngineersRouter.patch(
  "/electrical-engineers/:id",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateElectricalEngineerSchema),
  controller.update,
);
electricalEngineersRouter.delete(
  "/electrical-engineers/:id",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);

// Moves every villa of the engineer to another one (villas:update), so the engineer can then be deleted.
electricalEngineersRouter.post(
  "/electrical-engineers/:id/transfer-villas",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(idParams, "params"),
  validate(transferVillasSchema, "body"),
  controller.transferVillas,
);
