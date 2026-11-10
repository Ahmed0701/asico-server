import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { VillaProgressController } from "../controller/villa-progress.controller.js";
import { updatePhaseProgressSchema, villaPhaseParams } from "../validators/villa-progress.validators.js";

const controller = new VillaProgressController();

export const villaProgressRouter = Router();

// Authentication first, then the permission, then validation, so a caller without access learns nothing. If-Match is the
// version of the progress row (the `version` of the phase in the villa's detail).
villaProgressRouter.patch(
  "/villas/:villaId/phases/:elecPhaseId",
  auth,
  requirePermission(PERMISSIONS.VILLAS_PROGRESS),
  validate(villaPhaseParams, "params"),
  ifMatch(),
  validate(updatePhaseProgressSchema),
  idempotent(),
  controller.update,
);
