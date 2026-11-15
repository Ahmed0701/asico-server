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
import { exportQuery } from "../../exports/validators/exports.validators.js";
import { PaymentsController } from "../controller/payments.controller.js";
import { PaymentsTransferController } from "../controller/payments-transfer.controller.js";
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  paymentFileParams,
  updatePaymentSchema,
} from "../validators/payments.validators.js";

const controller = new PaymentsController();
const transfer = new PaymentsTransferController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const paymentsRouter = Router();

// The Excel and PDF files, and the Excel import. Above the routes with an :id, so "export" or "import" is never read as one.
paymentsRouter.get(
  "/payments/export",
  ...can(PERMISSIONS.PAYMENTS_READ),
  validate(exportQuery(listPaymentsQuerySchema), "query"),
  transfer.exportPayments,
);
// The template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a retried upload
// never imports twice.
paymentsRouter.get(
  "/payments/import/template",
  ...can(PERMISSIONS.PAYMENTS_CREATE),
  importRateLimiter,
  transfer.template,
);
paymentsRouter.post(
  "/payments/import",
  ...can(PERMISSIONS.PAYMENTS_CREATE),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  transfer.import,
);

paymentsRouter.get(
  "/payments",
  ...can(PERMISSIONS.PAYMENTS_READ),
  validate(listPaymentsQuerySchema, "query"),
  controller.list,
);
paymentsRouter.get(
  "/payments/:id",
  ...can(PERMISSIONS.PAYMENTS_READ),
  validate(idParams, "params"),
  controller.get,
);
paymentsRouter.post(
  "/payments",
  ...can(PERMISSIONS.PAYMENTS_CREATE),
  validate(createPaymentSchema),
  idempotent(),
  controller.create,
);
// Also marks it paid (or back to pending): `status` in the body.
paymentsRouter.patch(
  "/payments/:id",
  ...can(PERMISSIONS.PAYMENTS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updatePaymentSchema),
  controller.update,
);
paymentsRouter.delete(
  "/payments/:id",
  ...can(PERMISSIONS.PAYMENTS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);

// The receipt and invoice files: a POST adds one or more (multipart, each named "file"), a GET shows one, a DELETE
// removes one.
paymentsRouter.post(
  "/payments/:id/files",
  ...can(PERMISSIONS.PAYMENTS_UPDATE),
  validate(idParams, "params"),
  controller.receiveFiles,
  controller.uploadFiles,
);
paymentsRouter.get(
  "/payments/:id/files/:fileId",
  ...can(PERMISSIONS.PAYMENTS_READ),
  validate(paymentFileParams, "params"),
  controller.file,
);
paymentsRouter.delete(
  "/payments/:id/files/:fileId",
  ...can(PERMISSIONS.PAYMENTS_UPDATE),
  validate(paymentFileParams, "params"),
  controller.removeFile,
);
