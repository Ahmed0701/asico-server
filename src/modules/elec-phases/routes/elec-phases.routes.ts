import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { ElecPhasesController } from "../controller/elec-phases.controller.js";
import {
  createElecPhaseSchema,
  listElecPhasesQuerySchema,
  reorderElecPhasesSchema,
  updateElecPhaseSchema,
} from "../validators/elec-phases.validators.js";

const controller = new ElecPhasesController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const elecPhasesRouter = Router();

elecPhasesRouter.get(
  "/elec-phases",
  ...can(PERMISSIONS.ELEC_PHASES_READ),
  validate(listElecPhasesQuerySchema, "query"),
  controller.list,
);
// Must stay above "/elec-phases/:id", otherwise "options" would be read as an id.
elecPhasesRouter.get("/elec-phases/options", ...can(PERMISSIONS.ELEC_PHASES_READ), controller.options);
elecPhasesRouter.get(
  "/elec-phases/:id",
  ...can(PERMISSIONS.ELEC_PHASES_READ),
  validate(idParams, "params"),
  controller.get,
);
elecPhasesRouter.post(
  "/elec-phases",
  ...can(PERMISSIONS.ELEC_PHASES_CREATE),
  validate(createElecPhaseSchema),
  idempotent(),
  controller.create,
);
// Reordering is an update of the list. There is no PUT /elec-phases/:id, so "order" cannot be read as an id.
elecPhasesRouter.put(
  "/elec-phases/order",
  ...can(PERMISSIONS.ELEC_PHASES_UPDATE),
  validate(reorderElecPhasesSchema),
  idempotent(),
  controller.reorder,
);
elecPhasesRouter.patch(
  "/elec-phases/:id",
  ...can(PERMISSIONS.ELEC_PHASES_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateElecPhaseSchema),
  controller.update,
);
elecPhasesRouter.delete(
  "/elec-phases/:id",
  ...can(PERMISSIONS.ELEC_PHASES_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
