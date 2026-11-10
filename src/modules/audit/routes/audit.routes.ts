import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { AuditController } from "../controller/audit.controller.js";
import { listAuditLogsQuerySchema } from "../validators/audit.validators.js";

const controller = new AuditController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const canRead = [auth, requirePermission(PERMISSIONS.AUDIT_READ)];

export const auditRouter = Router();

auditRouter.get("/audit-logs", ...canRead, validate(listAuditLogsQuerySchema, "query"), controller.list);
// Must stay above "/audit-logs/:id", otherwise "filters" would be read as an id.
auditRouter.get("/audit-logs/filters", ...canRead, controller.filters);
auditRouter.get("/audit-logs/:id", ...canRead, validate(idParams, "params"), controller.get);
// Read-only by design: there is no route to create, change or delete an audit entry.
