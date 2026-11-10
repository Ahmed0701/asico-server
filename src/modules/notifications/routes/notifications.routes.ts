import { Router } from "express";
import { auth } from "../../../core/middleware/auth.js";
import { validate } from "../../../core/middleware/validate.js";
import { idParams } from "../../../shared/validation/fields.js";
import { NotificationsController } from "../controller/notifications.controller.js";
import { listNotificationsQuerySchema } from "../validators/notifications.validators.js";

const controller = new NotificationsController();

export const notificationsRouter = Router();

// No permission code: a user always reads and marks their own notifications, and only theirs (the service scopes every query
// by the signed-in user). Marking read twice is harmless, so these need no Idempotency-Key.
notificationsRouter.get(
  "/notifications",
  auth,
  validate(listNotificationsQuerySchema, "query"),
  controller.list,
);
notificationsRouter.post("/notifications/read-all", auth, controller.markAllRead);
notificationsRouter.post("/notifications/:id/read", auth, validate(idParams, "params"), controller.markRead);
