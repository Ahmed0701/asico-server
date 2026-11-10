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
import { OpenWorksController } from "../controller/open-works.controller.js";
import { OpenWorksImportController } from "../controller/open-works-import.controller.js";
import {
  createOpenWorkSchema,
  listOpenWorksQuerySchema,
  updateOpenWorkSchema,
} from "../validators/open-works.validators.js";

const controller = new OpenWorksController();
const importController = new OpenWorksImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const openWorksRouter = Router();

// The list serves the whole portfolio and, with ?villaId=, one villa: both are open-works:read.
openWorksRouter.get(
  "/open-works",
  ...can(PERMISSIONS.OPEN_WORKS_READ),
  validate(listOpenWorksQuerySchema, "query"),
  controller.list,
);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.)
openWorksRouter.get(
  "/open-works/import/template",
  ...can(PERMISSIONS.OPEN_WORKS_IMPORT),
  importRateLimiter,
  importController.template,
);
openWorksRouter.post(
  "/open-works/import",
  ...can(PERMISSIONS.OPEN_WORKS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
openWorksRouter.get(
  "/open-works/:id",
  ...can(PERMISSIONS.OPEN_WORKS_READ),
  validate(idParams, "params"),
  controller.get,
);
openWorksRouter.post(
  "/open-works",
  ...can(PERMISSIONS.OPEN_WORKS_CREATE),
  validate(createOpenWorkSchema),
  idempotent(),
  controller.create,
);
openWorksRouter.patch(
  "/open-works/:id",
  ...can(PERMISSIONS.OPEN_WORKS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateOpenWorkSchema),
  controller.update,
);
openWorksRouter.delete(
  "/open-works/:id",
  ...can(PERMISSIONS.OPEN_WORKS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
