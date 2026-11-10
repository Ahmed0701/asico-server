import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { MaterialsController } from "../controller/materials.controller.js";
import { MaterialsTransferController } from "../controller/materials-transfer.controller.js";
import { importFingerprint, receiveImportFile } from "../../../core/middleware/importUpload.js";
import { importRateLimiter } from "../../../core/middleware/rateLimit.js";
import { importQuerySchema } from "../../../shared/import/index.js";
import { exportQuery } from "../../exports/validators/exports.validators.js";
import {
  createDeliverySchema,
  createFactorySchema,
  createItemSchema,
  listBalanceQuerySchema,
  listItemsQuerySchema,
  updateItemSchema,
  villaRequirementsSchema,
  idParams,
  listDeliveriesQuerySchema,
  listFactoriesQuerySchema,
  updateDeliverySchema,
  updateFactorySchema,
  villaIdParams,
  noteParams,
} from "../validators/materials.validators.js";

const controller = new MaterialsController();
const transfer = new MaterialsTransferController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const materialsRouter = Router();

// The factories list. Read with materials:read; kept up to date with materials:update.
materialsRouter.get(
  "/factories",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(listFactoriesQuerySchema, "query"),
  controller.listFactories,
);
materialsRouter.post(
  "/factories",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(createFactorySchema),
  idempotent(),
  controller.createFactory,
);
materialsRouter.patch(
  "/factories/:id",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateFactorySchema),
  controller.updateFactory,
);
materialsRouter.delete(
  "/factories/:id",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  controller.removeFactory,
);

// The catalog of materials. Read with materials:read; kept up to date with materials:update.
materialsRouter.get(
  "/material-items",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(listItemsQuerySchema, "query"),
  controller.listItems,
);
materialsRouter.post(
  "/material-items",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(createItemSchema),
  idempotent(),
  controller.createItem,
);
materialsRouter.patch(
  "/material-items/:id",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateItemSchema),
  controller.updateItem,
);
materialsRouter.delete(
  "/material-items/:id",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  controller.removeItem,
);

// The balance: what every villa needs against what came.
materialsRouter.get(
  "/material-balance",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(listBalanceQuerySchema, "query"),
  controller.balance,
);
materialsRouter.put(
  "/villas/:id/material-requirements",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(villaIdParams, "params"),
  validate(villaRequirementsSchema),
  controller.setRequirements,
);

// The Excel and PDF files, and the Excel import. Above the routes with an :id, so "export" or "import" is never read as one.
materialsRouter.get(
  "/material-deliveries/export",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(exportQuery(listDeliveriesQuerySchema), "query"),
  transfer.exportDeliveries,
);
materialsRouter.get(
  "/material-balance/export",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(exportQuery(listBalanceQuerySchema), "query"),
  transfer.exportBalance,
);
// The template and the upload share the permission and the rate limit. The Idempotency-Key is required, so a retried upload
// never imports twice.
materialsRouter.get(
  "/material-deliveries/import/template",
  ...can(PERMISSIONS.MATERIALS_CREATE),
  importRateLimiter,
  transfer.template,
);
materialsRouter.post(
  "/material-deliveries/import",
  ...can(PERMISSIONS.MATERIALS_CREATE),
  importRateLimiter,
  validate(importQuerySchema, "query"),
  receiveImportFile,
  idempotent({ required: true, fingerprint: importFingerprint }),
  transfer.import,
);

// The deliveries.
materialsRouter.get(
  "/material-deliveries",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(listDeliveriesQuerySchema, "query"),
  controller.list,
);
materialsRouter.get(
  "/material-deliveries/:id",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(idParams, "params"),
  controller.get,
);
materialsRouter.post(
  "/material-deliveries",
  ...can(PERMISSIONS.MATERIALS_CREATE),
  validate(createDeliverySchema),
  idempotent(),
  controller.create,
);
materialsRouter.patch(
  "/material-deliveries/:id",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateDeliverySchema),
  controller.update,
);
materialsRouter.delete(
  "/material-deliveries/:id",
  ...can(PERMISSIONS.MATERIALS_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);

// The delivery note files: a POST adds one or more (multipart, each named "file"), a GET shows one, a DELETE removes one.
materialsRouter.post(
  "/material-deliveries/:id/notes",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(idParams, "params"),
  controller.receiveNotes,
  controller.uploadNotes,
);
materialsRouter.get(
  "/material-deliveries/:id/notes/:noteId",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(noteParams, "params"),
  controller.note,
);
materialsRouter.delete(
  "/material-deliveries/:id/notes/:noteId",
  ...can(PERMISSIONS.MATERIALS_UPDATE),
  validate(noteParams, "params"),
  controller.removeNote,
);

// What a villa has received.
materialsRouter.get(
  "/villas/:id/materials-summary",
  ...can(PERMISSIONS.MATERIALS_READ),
  validate(villaIdParams, "params"),
  controller.summary,
);
