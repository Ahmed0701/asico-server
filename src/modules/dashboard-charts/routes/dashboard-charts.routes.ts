import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { DashboardChartsController } from "../controller/dashboard-charts.controller.js";

const controller = new DashboardChartsController();

export const dashboardChartsRouter = Router();

// The dashboard's charts, cut to the ones the caller may read (see CHART_PERMISSIONS): dashboard:read opens the endpoint,
// and a chart whose permission the caller lacks is null in the answer.
dashboardChartsRouter.get(
  "/dashboard/charts",
  auth,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  controller.charts,
);
