import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { auth } from "../../../core/middleware/auth.js";
import { denyEngineerScope } from "../../../core/middleware/denyEngineerScope.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { VillaFinanceController } from "../controller/villa-finance.controller.js";
import {
  listVillaFinanceQuerySchema,
  putVillaFinanceSchema,
  villaParams,
} from "../validators/villa-finance.validators.js";

const controller = new VillaFinanceController();

// Authentication first, then the permission, then validation. The villa's money is part of the villa: seen with
// villas:read, changed with villas:update. A user linked to an electrical engineer never sees it.
const can = (permission: Permission) => [auth, requirePermission(permission), denyEngineerScope];

export const villaFinanceRouter = Router();

// Every villa with its budget figures: the Projects Budgets page.
villaFinanceRouter.get(
  "/villa-finance",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(listVillaFinanceQuerySchema, "query"),
  controller.list,
);
villaFinanceRouter.get(
  "/villas/:villaId/finance",
  ...can(PERMISSIONS.VILLAS_READ),
  validate(villaParams, "params"),
  controller.get,
);
villaFinanceRouter.put(
  "/villas/:villaId/finance",
  ...can(PERMISSIONS.VILLAS_UPDATE),
  validate(villaParams, "params"),
  ifMatch(),
  validate(putVillaFinanceSchema),
  controller.put,
);
