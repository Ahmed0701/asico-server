import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { MaterialOrdersController } from "../controller/material-orders.controller.js";
import {
  listMaterialOrdersQuerySchema,
  materialOrderParams,
  setMaterialOrderSchema,
} from "../validators/material-orders.validators.js";

const controller = new MaterialOrdersController();

export const materialOrdersRouter = Router();

// The Material Orders tab: each villa's switchgear and cables with their MR, PO and due dates and what came (materials:read).
materialOrdersRouter.get(
  "/material-orders",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_READ),
  validate(listMaterialOrdersQuerySchema, "query"),
  controller.list,
);

// Sets the three dates of a villa's materials of one type (materials:update).
materialOrdersRouter.put(
  "/villas/:villaId/material-orders/:type",
  auth,
  requirePermission(PERMISSIONS.MATERIALS_UPDATE),
  validate(materialOrderParams, "params"),
  validate(setMaterialOrderSchema, "body"),
  controller.set,
);
