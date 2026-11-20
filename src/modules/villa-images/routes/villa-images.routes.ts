import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { VillaImagesController } from "../controller/villa-images.controller.js";
import { villaImageParams, villaImagesParams } from "../validators/villa-images.validators.js";

const controller = new VillaImagesController();

// The site images of a villa are kept like its documents, behind the same permissions: villa-documents:upload to add,
// villa-documents:download to see, villa-documents:delete to remove.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const villaImagesRouter = Router();

villaImagesRouter.get(
  "/villas/:villaId/images",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DOWNLOAD),
  validate(villaImagesParams, "params"),
  controller.list,
);
// Photos, one or more (multipart, each named "file").
villaImagesRouter.post(
  "/villas/:villaId/images",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_UPLOAD),
  validate(villaImagesParams, "params"),
  controller.receive,
  controller.upload,
);
villaImagesRouter.get(
  "/villa-images/:id/file",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DOWNLOAD),
  validate(villaImageParams, "params"),
  controller.file,
);
villaImagesRouter.delete(
  "/villa-images/:id",
  ...can(PERMISSIONS.VILLA_DOCUMENTS_DELETE),
  validate(villaImageParams, "params"),
  controller.remove,
);
