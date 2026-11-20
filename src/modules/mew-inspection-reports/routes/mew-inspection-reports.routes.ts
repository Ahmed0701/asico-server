import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { MewInspectionReportsController } from "../controller/mew-inspection-reports.controller.js";
import { reportsQuerySchema, villaReportParams } from "../validators/mew-inspection-reports.validators.js";

const controller = new MewInspectionReportsController();

const can = (permission: Permission) => [auth, requirePermission(permission)];

export const mewInspectionReportsRouter = Router();

// The reports of the villas of one page of the MEW Inspection list, and one report's file: read with villas:read.
mewInspectionReportsRouter.get(
  "/mew-inspection-reports",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(reportsQuerySchema, "query"),
  controller.ofVillas,
);
mewInspectionReportsRouter.get(
  "/villas/:villaId/mew-inspection-report/file",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(villaReportParams, "params"),
  controller.file,
);
// Uploading (or replacing) and removing it is for whoever handles the MEW inspection (villas:inspection).
mewInspectionReportsRouter.post(
  "/villas/:villaId/mew-inspection-report",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(villaReportParams, "params"),
  controller.receive,
  controller.upload,
);
mewInspectionReportsRouter.delete(
  "/villas/:villaId/mew-inspection-report",
  ...can(PERMISSIONS.VILLAS_INSPECTION),
  validate(villaReportParams, "params"),
  controller.remove,
);
