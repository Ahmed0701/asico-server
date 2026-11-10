import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { DashboardController } from "../controller/dashboard.controller.js";
import { recentActivityQuerySchema } from "../validators/dashboard.validators.js";

const controller = new DashboardController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const canViewDashboard = [auth, requirePermission(PERMISSIONS.DASHBOARD_READ)];

export const dashboardRouter = Router();

// Global figures, cut to the cards the caller may read (see CARD_PERMISSIONS): dashboard:read opens the endpoint, and a
// card whose permission the caller lacks is null in the answer.
dashboardRouter.get("/dashboard/summary", ...canViewDashboard, controller.summary);

// The recent activity is audit data, so it needs the audit permission as well as the dashboard one:
// dashboard:read alone is not enough, and audit:read alone does not open the dashboard.
dashboardRouter.get(
  "/dashboard/recent-activity",
  ...canViewDashboard,
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate(recentActivityQuerySchema, "query"),
  controller.recentActivity,
);
