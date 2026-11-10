import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { importFingerprint, receiveImportFile } from "../../../core/middleware/importUpload.js";
import { importRateLimiter } from "../../../core/middleware/rateLimit.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { importQuerySchema } from "../../../shared/import/index.js";
import { idParams } from "../../../shared/validation/fields.js";
import { VillasController } from "../controller/villas.controller.js";
import { VillasImportController } from "../controller/villas-import.controller.js";
import {
  createVillaSchema,
  listVillasQuerySchema,
  mewStatesSchema,
  updateVillaSchema,
} from "../validators/villas.validators.js";

const controller = new VillasController();
const importController = new VillasImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const villasRouter = Router();

villasRouter.get(
  "/villas",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(listVillasQuerySchema, "query"),
  controller.list,
);
// "options" and "filters" must stay above "/villas/:id", otherwise they would be read as ids.
villasRouter.get("/villas/options", ...can(PERMISSIONS.VILLAS_READ), controller.options);
villasRouter.get("/villas/filters", ...can(PERMISSIONS.VILLAS_READ), controller.filters);
// Import: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.) Both stay
// above "/villas/:id" so "import" is never read as an id.
villasRouter.get(
  "/villas/import/template",
  ...can(PERMISSIONS.VILLAS_IMPORT),
  importRateLimiter,
  importController.template,
);
villasRouter.post(
  "/villas/import",
  ...can(PERMISSIONS.VILLAS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
// A single villa is a different permission from the list: villas:read does not open it.
villasRouter.get(
  "/villas/:id",
  ...can(PERMISSIONS.VILLAS_DETAIL),
  validate(idParams, "params"),
  controller.get,
);
villasRouter.post(
  "/villas",
  ...can(PERMISSIONS.VILLAS_CREATE),
  validate(createVillaSchema),
  idempotent(),
  controller.create,
);
villasRouter.patch(
  "/villas/:id",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateVillaSchema),
  controller.update,
);
// Marking and undoing are separate permissions from update: whoever may edit a villa may not call it ready. They answer with
// the villa (200) and its new ETag, since the villa stays and its version has moved.
// The MEW follow-up mark: put on and taken off by a person with villas:inspection.
villasRouter.post(
  "/villas/:id/mew-follow-up",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.markMewFollowUp,
);
villasRouter.delete(
  "/villas/:id/mew-follow-up",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.undoMewFollowUp,
);
// The MEW inspection mark, and the villa's MEW states (set on the MEW follow-up page), under the same permission.
villasRouter.post(
  "/villas/:id/mew-inspection",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.markMewInspection,
);
villasRouter.delete(
  "/villas/:id/mew-inspection",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.undoMewInspection,
);
villasRouter.post(
  "/villas/:id/mew-inspection-passed",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.markMewInspectionPassed,
);
villasRouter.delete(
  "/villas/:id/mew-inspection-passed",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  ifMatch(),
  idempotent(),
  controller.undoMewInspectionPassed,
);
villasRouter.patch(
  "/villas/:id/mew-states",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(idParams, "params"),
  validate(mewStatesSchema),
  ifMatch(),
  controller.setMewStates,
);
villasRouter.delete(
  "/villas/:id",
  ...can(PERMISSIONS.VILLAS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
