import { Router } from "express";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { discardUpload, uploadFingerprint } from "../idempotency.js";
import { VillaDocumentsController } from "../controller/villa-documents.controller.js";
import {
  fileLinkBody,
  fileLinkQuery,
  fileParams,
  villaParams,
} from "../validators/villa-documents.validators.js";

const controller = new VillaDocumentsController();

// Authentication first, then the permission, then the parameters, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const villaDocumentsRouter = Router();

// The checks that need no body come before the upload is read.
villaDocumentsRouter.post(
  "/villas/:villaId/documents",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_UPLOAD),
  validate(villaParams, "params"),
  controller.guardUpload,
  controller.receive,
  // After the file is received: the request hash covers its content, and a repeat removes the copy it just made.
  idempotent({ fingerprint: uploadFingerprint, discard: discardUpload }),
  controller.upload,
);
villaDocumentsRouter.get(
  "/villas/:villaId/documents",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DOWNLOAD),
  validate(villaParams, "params"),
  controller.listByVilla,
);
villaDocumentsRouter.get(
  "/villa-documents/:id/download",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DOWNLOAD),
  validate(fileParams, "params"),
  controller.download,
);
// A signed link to one document (to download or to view it), made only for a caller who may download it.
villaDocumentsRouter.post(
  "/villa-documents/:id/link",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DOWNLOAD),
  validate(fileParams, "params"),
  validate(fileLinkBody),
  controller.link,
);
// Opened by the browser itself, so no Authorization header: the signed token in the query is the access check.
villaDocumentsRouter.get(
  "/villa-documents/:id/file",
  validate(fileParams, "params"),
  validate(fileLinkQuery, "query"),
  controller.file,
);
villaDocumentsRouter.delete(
  "/villa-documents/:id",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DELETE),
  validate(fileParams, "params"),
  controller.remove,
);
