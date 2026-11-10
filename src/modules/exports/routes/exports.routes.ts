import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { exportRateLimiter } from "../../../core/middleware/rateLimit.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { listAreasQuerySchema } from "../../areas/index.js";
import { listAuditLogsQuerySchema } from "../../audit/index.js";
import { listCivilEngineersQuerySchema } from "../../civil-engineers/index.js";
import { contractorSummaryQuerySchema, listContractorsQuerySchema } from "../../contractors/index.js";
import { listDailyLabourQuerySchema } from "../../daily-labour/index.js";
import { listDailyReportsQuerySchema } from "../../daily-reports/index.js";
import { listElectricalEngineersQuerySchema } from "../../electrical-engineers/index.js";
import { listOpenWorksQuerySchema } from "../../open-works/index.js";
import { listSiteReportsQuerySchema } from "../../site-reports/index.js";
import { listSmallWorksQuerySchema } from "../../small-works/index.js";
import { listVillasQuerySchema } from "../../villas/index.js";
import { ExportsController } from "../controller/exports.controller.js";
import { exportQuery } from "../validators/exports.validators.js";

const controller = new ExportsController();

// Authentication first, then the permission, then the rate limit (so only people who may export use up the
// allowance), then validation. Each user, or each IP when there is no user, has their own allowance.
const can = (permission: Permission) => [auth, requirePermission(permission), exportRateLimiter];

// This router is mounted BEFORE the modules' own routers (see routes/index.ts): "/villas/export" has to be
// matched here, or "/villas/:id" would take it and read "export" as an id.
export const exportsRouter = Router();

exportsRouter.get(
  "/villas/export",
  ...can(PERMISSIONS.VILLAS_EXPORT),
  validate(exportQuery(listVillasQuerySchema), "query"),
  controller.villas,
);
exportsRouter.get(
  "/open-works/export",
  ...can(PERMISSIONS.OPEN_WORKS_EXPORT),
  validate(exportQuery(listOpenWorksQuerySchema), "query"),
  controller.openWorks,
);
exportsRouter.get(
  "/daily-reports/export",
  ...can(PERMISSIONS.DAILY_REPORTS_EXPORT),
  validate(exportQuery(listDailyReportsQuerySchema), "query"),
  controller.dailyReports,
);
exportsRouter.get(
  "/small-works/export",
  ...can(PERMISSIONS.SMALL_WORKS_EXPORT),
  validate(exportQuery(listSmallWorksQuerySchema), "query"),
  controller.smallWorks,
);
exportsRouter.get(
  "/site-reports/export",
  ...can(PERMISSIONS.SITE_REPORTS_EXPORT),
  validate(exportQuery(listSiteReportsQuerySchema), "query"),
  controller.siteReports,
);
exportsRouter.get(
  "/daily-labour/export",
  ...can(PERMISSIONS.DAILY_LABOUR_EXPORT),
  validate(exportQuery(listDailyLabourQuerySchema), "query"),
  controller.dailyLabour,
);
exportsRouter.get(
  "/contractors/export",
  ...can(PERMISSIONS.CONTRACTORS_READ),
  validate(exportQuery(listContractorsQuerySchema), "query"),
  controller.contractors,
);
exportsRouter.get(
  "/civil-engineers/export",
  ...can(PERMISSIONS.CIVIL_ENGINEERS_READ),
  validate(exportQuery(listCivilEngineersQuerySchema), "query"),
  controller.civilEngineers,
);
exportsRouter.get(
  "/electrical-engineers/export",
  ...can(PERMISSIONS.ELECTRICAL_ENGINEERS_READ),
  validate(exportQuery(listElectricalEngineersQuerySchema), "query"),
  controller.electricalEngineers,
);
// There is no areas:export permission: whoever may read areas may export them.
exportsRouter.get(
  "/areas/export",
  ...can(PERMISSIONS.AREAS_READ),
  validate(exportQuery(listAreasQuerySchema), "query"),
  controller.areas,
);
exportsRouter.get(
  "/contractors/:id/summary/export",
  ...can(PERMISSIONS.CONTRACTORS_SUMMARY),
  validate(idParams, "params"),
  validate(exportQuery(contractorSummaryQuerySchema), "query"),
  controller.contractorSummary,
);
exportsRouter.get(
  "/audit-logs/export",
  ...can(PERMISSIONS.AUDIT_READ),
  validate(exportQuery(listAuditLogsQuerySchema), "query"),
  controller.auditLogs,
);
