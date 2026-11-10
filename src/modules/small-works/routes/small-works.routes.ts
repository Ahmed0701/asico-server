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
import { SmallWorksController } from "../controller/small-works.controller.js";
import { SmallWorksImportController } from "../controller/small-works-import.controller.js";
import {
  createSmallWorkSchema,
  listSmallWorksQuerySchema,
  updateSmallWorkSchema,
} from "../validators/small-works.validators.js";

const controller = new SmallWorksController();
const importController = new SmallWorksImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const smallWorksRouter = Router();

// The list serves the whole portfolio and, with ?villaId=, one villa: both are small-works:read.
smallWorksRouter.get(
  "/small-works",
  ...can(PERMISSIONS.SMALL_WORKS_READ),
  validate(listSmallWorksQuerySchema, "query"),
  controller.list,
);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.)
smallWorksRouter.get(
  "/small-works/import/template",
  ...can(PERMISSIONS.SMALL_WORKS_IMPORT),
  importRateLimiter,
  importController.template,
);
smallWorksRouter.post(
  "/small-works/import",
  ...can(PERMISSIONS.SMALL_WORKS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
smallWorksRouter.get(
  "/small-works/:id",
  ...can(PERMISSIONS.SMALL_WORKS_READ),
  validate(idParams, "params"),
  controller.get,
);
smallWorksRouter.post(
  "/small-works",
  ...can(PERMISSIONS.SMALL_WORKS_CREATE),
  validate(createSmallWorkSchema),
  idempotent(),
  controller.create,
);
smallWorksRouter.patch(
  "/small-works/:id",
  ...can(PERMISSIONS.SMALL_WORKS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateSmallWorkSchema),
  controller.update,
);
smallWorksRouter.delete(
  "/small-works/:id",
  ...can(PERMISSIONS.SMALL_WORKS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
