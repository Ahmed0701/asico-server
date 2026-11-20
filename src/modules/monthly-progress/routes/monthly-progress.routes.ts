import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { importFingerprint, receiveImportFile } from "../../../core/middleware/importUpload.js";
import { exportRateLimiter, importRateLimiter } from "../../../core/middleware/rateLimit.js";
import { importQuerySchema } from "../../../shared/import/index.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { MonthlyProgressController } from "../controller/monthly-progress.controller.js";
import {
  manualPaymentSchema,
  monthlyProgressQuerySchema,
  paymentParams,
  villaPaymentParams,
} from "../validators/monthly-progress.validators.js";

const controller = new MonthlyProgressController();

export const monthlyProgressRouter = Router();

// The Monthly Payments page: each villa's progress now, its last payment and what its contractor is owed now. Read with
// villas:read.
monthlyProgressRouter.get(
  "/monthly-progress",
  auth,
  requirePermission(PERMISSIONS.VILLAS_READ),
  validate(monthlyProgressQuerySchema, "query"),
  controller.list,
);

// A villa's payment history, the latest first, and what is owed now (payments:read).
monthlyProgressRouter.get(
  "/villas/:villaId/progress-payments",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  validate(villaPaymentParams, "params"),
  controller.villaHistory,
);

// The same history as an Excel file (payments:read, with the export rate limit).
monthlyProgressRouter.get(
  "/villas/:villaId/progress-payments/export",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  exportRateLimiter,
  validate(villaPaymentParams, "params"),
  controller.exportVillaHistory,
);

// Pays a villa's contractor what it is owed now (payments:create), and takes back a villa's latest payment
// (payments:delete).
monthlyProgressRouter.post(
  "/villas/:villaId/progress-payments",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  validate(villaPaymentParams, "params"),
  controller.pay,
);
// Payments made before the system, for any villas, from an Excel file: the template and the upload share the permission
// and the rate limit. The Idempotency-Key is required, so a retried upload never imports twice.
monthlyProgressRouter.get(
  "/progress-payments/import/template",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  importRateLimiter,
  controller.importTemplate,
);
monthlyProgressRouter.post(
  "/progress-payments/import",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  controller.importPrevious,
);

// A payment made before the system, entered by hand (payments:create).
monthlyProgressRouter.post(
  "/villas/:villaId/progress-payments/manual",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  validate(villaPaymentParams, "params"),
  validate(manualPaymentSchema, "body"),
  controller.addManual,
);
monthlyProgressRouter.delete(
  "/progress-payments/:id",
  auth,
  requirePermission(PERMISSIONS.PAYMENTS_DELETE),
  validate(paymentParams, "params"),
  controller.undo,
);
