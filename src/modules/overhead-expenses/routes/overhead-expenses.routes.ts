import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { OverheadExpensesController } from "../controller/overhead-expenses.controller.js";
import {
  createOverheadExpenseSchema,
  expenseFileParams,
  listOverheadExpensesQuerySchema,
  updateOverheadExpenseSchema,
} from "../validators/overhead-expenses.validators.js";

const controller = new OverheadExpensesController();

// The additional expenses are part of the Department Overhead: behind its permissions (overhead:*). Authentication
// first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const overheadExpensesRouter = Router();

overheadExpensesRouter.get(
  "/overhead-expenses",
  ...can(PERMISSIONS.OVERHEAD_READ),
  validate(listOverheadExpensesQuerySchema, "query"),
  controller.list,
);
overheadExpensesRouter.get(
  "/overhead-expenses/:id",
  ...can(PERMISSIONS.OVERHEAD_READ),
  validate(idParams, "params"),
  controller.get,
);
overheadExpensesRouter.post(
  "/overhead-expenses",
  ...can(PERMISSIONS.OVERHEAD_CREATE),
  validate(createOverheadExpenseSchema),
  idempotent(),
  controller.create,
);
overheadExpensesRouter.patch(
  "/overhead-expenses/:id",
  ...can(PERMISSIONS.OVERHEAD_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateOverheadExpenseSchema),
  controller.update,
);
overheadExpensesRouter.delete(
  "/overhead-expenses/:id",
  ...can(PERMISSIONS.OVERHEAD_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);

// The invoice files: a POST adds one or more (multipart, each named "file"), a GET shows one, a DELETE removes one.
overheadExpensesRouter.post(
  "/overhead-expenses/:id/files",
  ...can(PERMISSIONS.OVERHEAD_UPDATE),
  validate(idParams, "params"),
  controller.receiveFiles,
  controller.uploadFiles,
);
overheadExpensesRouter.get(
  "/overhead-expenses/:id/files/:fileId",
  ...can(PERMISSIONS.OVERHEAD_READ),
  validate(expenseFileParams, "params"),
  controller.file,
);
overheadExpensesRouter.delete(
  "/overhead-expenses/:id/files/:fileId",
  ...can(PERMISSIONS.OVERHEAD_UPDATE),
  validate(expenseFileParams, "params"),
  controller.removeFile,
);
