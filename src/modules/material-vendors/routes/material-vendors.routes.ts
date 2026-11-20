import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { MaterialVendorsController } from "../controller/material-vendors.controller.js";
import {
  listVillaVendorsQuerySchema,
  putVillaVendorsSchema,
  villaVendorsParams,
} from "../validators/material-vendors.validators.js";

const controller = new MaterialVendorsController();

export const materialVendorsRouter = Router();

// Each villa's assigned switchgear and cable factories (the Vendors page). Read with materials:read.
materialVendorsRouter.get(
  "/material-vendors",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_READ),
  validate(listVillaVendorsQuerySchema, "query"),
  controller.list,
);

// The villas not on the list yet, to pick one to add. Read with materials:read.
materialVendorsRouter.get(
  "/material-vendors/available",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_READ),
  controller.available,
);

// One villa's assigned factories, on the list or not. Read with materials:read.
materialVendorsRouter.get(
  "/villas/:villaId/vendors",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_READ),
  validate(villaVendorsParams, "params"),
  controller.get,
);

// Adds a villa to the Vendors list, and takes one off it (its assigned factories go too). Need materials:update.
materialVendorsRouter.post(
  "/villas/:villaId/vendors",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_UPDATE),
  validate(villaVendorsParams, "params"),
  controller.add,
);
materialVendorsRouter.delete(
  "/villas/:villaId/vendors",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_UPDATE),
  validate(villaVendorsParams, "params"),
  ifMatch(),
  controller.remove,
);

// Assigns a villa's factories (null takes one off), with the villa's version as If-Match. Needs materials:update.
materialVendorsRouter.put(
  "/villas/:villaId/vendors",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_UPDATE),
  validate(villaVendorsParams, "params"),
  ifMatch(),
  validate(putVillaVendorsSchema),
  controller.assign,
);
