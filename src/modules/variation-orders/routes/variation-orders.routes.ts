import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { VariationOrdersController } from "../controller/variation-orders.controller.js";
import {
  createVariationOrderSchema,
  updateVariationOrderSchema,
  variationOrderFileParams,
  villaParams,
} from "../validators/variation-orders.validators.js";

const controller = new VariationOrdersController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing. The variation
// orders are part of the villa: seen with villas:read, changed with villas:update.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const variationOrdersRouter = Router();

variationOrdersRouter.get(
  "/villas/:villaId/variation-orders",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(villaParams, "params"),
  controller.list,
);
variationOrdersRouter.post(
  "/villas/:villaId/variation-orders",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(villaParams, "params"),
  validate(createVariationOrderSchema),
  idempotent(),
  controller.create,
);
// Also marks it paid (or back to pending): `status` in the body.
variationOrdersRouter.patch(
  "/variation-orders/:id",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateVariationOrderSchema),
  controller.update,
);
variationOrdersRouter.delete(
  "/variation-orders/:id",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);

// The PDF files: a POST adds one or more (multipart, each named "file"), a GET shows one, a DELETE removes one.
variationOrdersRouter.post(
  "/variation-orders/:id/files",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(idParams, "params"),
  controller.receiveFiles,
  controller.uploadFiles,
);
variationOrdersRouter.get(
  "/variation-orders/:id/files/:fileId",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(variationOrderFileParams, "params"),
  controller.file,
);
variationOrdersRouter.delete(
  "/variation-orders/:id/files/:fileId",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(variationOrderFileParams, "params"),
  controller.removeFile,
);
