import { Router } from "express";
import { ifMatch } from "../../../core/concurrency/version.js";
import { idempotent } from "../../../core/idempotency/index.js";
import { auth } from "../../../core/middleware/auth.js";
import { requirePermission } from "../../../core/middleware/requirePermission.js";
import { validate } from "../../../core/middleware/validate.js";
import { PERMISSIONS, type Permission } from "../../../shared/constants/permissions.js";
import { idParams } from "../../../shared/validation/fields.js";
import { OwnerNotesController } from "../controller/owner-notes.controller.js";
import {
  createOwnerNoteSchema,
  listOwnerNotesQuerySchema,
  updateOwnerNoteSchema,
} from "../validators/owner-notes.validators.js";

const controller = new OwnerNotesController();

// Authentication first, then the permission, then validation, so a caller without access learns nothing.
const can = (permission: Permission) => [auth, requirePermission(permission)];

export const ownerNotesRouter = Router();

ownerNotesRouter.get(
  "/owner-notes",
  ...can(PERMISSIONS.OWNER_NOTES_READ),
  validate(listOwnerNotesQuerySchema, "query"),
  controller.list,
);
ownerNotesRouter.get(
  "/owner-notes/:id",
  ...can(PERMISSIONS.OWNER_NOTES_READ),
  validate(idParams, "params"),
  controller.get,
);
ownerNotesRouter.post(
  "/owner-notes",
  ...can(PERMISSIONS.OWNER_NOTES_CREATE),
  validate(createOwnerNoteSchema),
  idempotent(),
  controller.create,
);
// Also checks it as done (or not): `done` in the body. A done note gets no more reminders.
ownerNotesRouter.patch(
  "/owner-notes/:id",
  ...can(PERMISSIONS.OWNER_NOTES_UPDATE),
  validate(idParams, "params"),
  ifMatch(),
  validate(updateOwnerNoteSchema),
  controller.update,
);
ownerNotesRouter.delete(
  "/owner-notes/:id",
  ...can(PERMISSIONS.OWNER_NOTES_DELETE),
  validate(idParams, "params"),
  ifMatch(),
  controller.remove,
);
