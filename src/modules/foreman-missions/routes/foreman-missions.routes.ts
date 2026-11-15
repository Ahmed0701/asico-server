import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { ForemanMissionsController } from "../controller/foreman-missions.controller.js";
import {
  createForemanMissionSchema,
  listForemanMissionsQuerySchema,
  updateForemanMissionSchema,
} from "../validators/foreman-missions.validators.js";

const controller = new ForemanMissionsController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const foremanMissionsRouter = Router();

foremanMissionsRouter.get(
  "/foreman-missions",
  ...can(PERMISSIONS.FOREMAN_MISSIONS_READ),
  validate(listForemanMissionsQuerySchema, "query"),
  controller.list,
);
foremanMissionsRouter.get(
  "/foreman-missions/:id",
  ...can(PERMISSIONS.FOREMAN_MISSIONS_READ),
  validate(idParams, "params"),
  controller.get,
);
foremanMissionsRouter.post(
  "/foreman-missions",
  ...can(PERMISSIONS.FOREMAN_MISSIONS_CREATE),
  validate(createForemanMissionSchema),
  idempotent(),
  controller.create,
);
// Also checks it as done (or not): `done` in the body. A done note gets no more reminders.
foremanMissionsRouter.patch(
  "/foreman-missions/:id",
  ...can(PERMISSIONS.FOREMAN_MISSIONS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateForemanMissionSchema),
  controller.update,
);
foremanMissionsRouter.delete(
  "/foreman-missions/:id",
  ...can(PERMISSIONS.FOREMAN_MISSIONS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
