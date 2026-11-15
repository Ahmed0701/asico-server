import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { MonthlyProgressController } from "../controller/monthly-progress.controller.js";
import { monthlyProgressQuerySchema } from "../validators/monthly-progress.validators.js";

const controller = new MonthlyProgressController();

export const monthlyProgressRouter = Router();

// Each villa's overall progress at the end of the month before and of the month asked for. Read with villas:read.
monthlyProgressRouter.get(
  "/monthly-progress",
  auth,
  requirePermission(PERMISSIONS.VILLAS_READ),
  validate(monthlyProgressQuerySchema, "query"),
  controller.list,
);
