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
import { SiteReportsController } from "../controller/site-reports.controller.js";
import { SiteReportsImportController } from "../controller/site-reports-import.controller.js";
import {
  createSiteReportSchema,
  listSiteReportsQuerySchema,
  updateSiteReportSchema,
} from "../validators/site-reports.validators.js";

const controller = new SiteReportsController();
const importController = new SiteReportsImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const siteReportsRouter = Router();

// The list serves the whole portfolio and, with ?villaId=, one villa: both are site-reports:read.
siteReportsRouter.get(
  "/site-reports",
  ...can(PERMISSIONS.SITE_REPORTS_READ),
  validate(listSiteReportsQuerySchema, "query"),
  controller.list,
);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a
// retried upload never imports twice. (The export is on the exports router, which is mounted before this one.)
siteReportsRouter.get(
  "/site-reports/import/template",
  ...can(PERMISSIONS.SITE_REPORTS_IMPORT),
  importRateLimiter,
  importController.template,
);
siteReportsRouter.post(
  "/site-reports/import",
  ...can(PERMISSIONS.SITE_REPORTS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
siteReportsRouter.get(
  "/site-reports/:id",
  ...can(PERMISSIONS.SITE_REPORTS_READ),
  validate(idParams, "params"),
  controller.get,
);
siteReportsRouter.post(
  "/site-reports",
  ...can(PERMISSIONS.SITE_REPORTS_CREATE),
  validate(createSiteReportSchema),
  idempotent(),
  controller.create,
);
siteReportsRouter.patch(
  "/site-reports/:id",
  ...can(PERMISSIONS.SITE_REPORTS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateSiteReportSchema),
  controller.update,
);
siteReportsRouter.delete(
  "/site-reports/:id",
  ...can(PERMISSIONS.SITE_REPORTS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
