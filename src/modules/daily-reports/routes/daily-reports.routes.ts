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
import { DailyReportsController } from "../controller/daily-reports.controller.js";
import { DailyReportsImportController } from "../controller/daily-reports-import.controller.js";
import {
  createDailyReportSchema,
  listDailyReportsQuerySchema,
  updateDailyReportSchema,
} from "../validators/daily-reports.validators.js";

const controller = new DailyReportsController();
const importController = new DailyReportsImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const dailyReportsRouter = Router();

// The list serves the whole portfolio and, with ?villaId=, one villa: both are daily-reports:read.
dailyReportsRouter.get(
  "/daily-reports",
  ...can(PERMISSIONS.DAILY_REPORTS_READ),
  validate(listDailyReportsQuerySchema, "query"),
  controller.list,
);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.)
dailyReportsRouter.get(
  "/daily-reports/import/template",
  ...can(PERMISSIONS.DAILY_REPORTS_IMPORT),
  importRateLimiter,
  importController.template,
);
dailyReportsRouter.post(
  "/daily-reports/import",
  ...can(PERMISSIONS.DAILY_REPORTS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
dailyReportsRouter.get(
  "/daily-reports/:id",
  ...can(PERMISSIONS.DAILY_REPORTS_READ),
  validate(idParams, "params"),
  controller.get,
);
dailyReportsRouter.post(
  "/daily-reports",
  ...can(PERMISSIONS.DAILY_REPORTS_CREATE),
  validate(createDailyReportSchema),
  idempotent(),
  controller.create,
);
dailyReportsRouter.patch(
  "/daily-reports/:id",
  ...can(PERMISSIONS.DAILY_REPORTS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateDailyReportSchema),
  controller.update,
);
dailyReportsRouter.delete(
  "/daily-reports/:id",
  ...can(PERMISSIONS.DAILY_REPORTS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
