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
import { DailyLabourController } from "../controller/daily-labour.controller.js";
import { DailyLabourImportController } from "../controller/daily-labour-import.controller.js";
import {
  createDailyLabourSchema,
  listDailyLabourQuerySchema,
  updateDailyLabourSchema,
} from "../validators/daily-labour.validators.js";

const controller = new DailyLabourController();
const importController = new DailyLabourImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const dailyLabourRouter = Router();

// The list serves the whole portfolio and, with ?villaId=, one villa: both are daily-labour:read.
dailyLabourRouter.get(
  "/daily-labour",
  ...can(PERMISSIONS.DAILY_LABOUR_READ),
  validate(listDailyLabourQuerySchema, "query"),
  controller.list,
);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.)
dailyLabourRouter.get(
  "/daily-labour/import/template",
  ...can(PERMISSIONS.DAILY_LABOUR_IMPORT),
  importRateLimiter,
  importController.template,
);
dailyLabourRouter.post(
  "/daily-labour/import",
  ...can(PERMISSIONS.DAILY_LABOUR_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
dailyLabourRouter.get(
  "/daily-labour/:id",
  ...can(PERMISSIONS.DAILY_LABOUR_READ),
  validate(idParams, "params"),
  controller.get,
);
dailyLabourRouter.post(
  "/daily-labour",
  ...can(PERMISSIONS.DAILY_LABOUR_CREATE),
  validate(createDailyLabourSchema),
  idempotent(),
  controller.create,
);
dailyLabourRouter.patch(
  "/daily-labour/:id",
  ...can(PERMISSIONS.DAILY_LABOUR_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateDailyLabourSchema),
  controller.update,
);
dailyLabourRouter.delete(
  "/daily-labour/:id",
  ...can(PERMISSIONS.DAILY_LABOUR_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
