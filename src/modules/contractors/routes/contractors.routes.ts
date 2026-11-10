import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { importFingerprint, receiveImportFile } from "../../../core/middleware/importUpload.js";
import { importRateLimiter } from "../../../core/middleware/rateLimit.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { importQuerySchema } from "../../../shared/import/index.js";
import { idParams } from "../../../shared/validation/fields.js";
import { ContractorsController } from "../controller/contractors.controller.js";
import { ContractorsImportController } from "../controller/contractors-import.controller.js";
import {
  contractorSummaryQuerySchema,
  createContractorSchema,
  listContractorsQuerySchema,
  updateContractorSchema,
} from "../validators/contractors.validators.js";

const controller = new ContractorsController();
const importController = new ContractorsImportController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const contractorsRouter = Router();

contractorsRouter.get(
  "/contractors",
  ...can(PERMISSIONS.CONTRACTORS_READ),
  validate(listContractorsQuerySchema, "query"),
  controller.list,
);
// Must stay above "/contractors/:id", otherwise "options" would be read as an id.
contractorsRouter.get("/contractors/options", ...can(PERMISSIONS.CONTRACTORS_READ), controller.options);
// Imports: the template and the upload share the permission and the rate limit. The Idempotency-Key is required,
// so a retried upload never imports twice.
contractorsRouter.get(
  "/contractors/import/template",
  ...can(PERMISSIONS.CONTRACTORS_IMPORT),
  importRateLimiter,
  importController.template,
);
contractorsRouter.post(
  "/contractors/import",
  ...can(PERMISSIONS.CONTRACTORS_IMPORT),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  importController.import,
);
// Its own permission: contractors:read does not open it, and contractors:summary does not open the rest.
contractorsRouter.get(
  "/contractors/:id/summary",
  ...can(PERMISSIONS.CONTRACTORS_SUMMARY),
  validate(idParams, "params"),
  validate(contractorSummaryQuerySchema, "query"),
  controller.summary,
);
contractorsRouter.get(
  "/contractors/:id",
  ...can(PERMISSIONS.CONTRACTORS_READ),
  validate(idParams, "params"),
  controller.get,
);
contractorsRouter.post(
  "/contractors",
  ...can(PERMISSIONS.CONTRACTORS_CREATE),
  validate(createContractorSchema),
  idempotent(),
  controller.create,
);
contractorsRouter.patch(
  "/contractors/:id",
  ...can(PERMISSIONS.CONTRACTORS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateContractorSchema),
  controller.update,
);
contractorsRouter.delete(
  "/contractors/:id",
  ...can(PERMISSIONS.CONTRACTORS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
