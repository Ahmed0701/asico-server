import type { Request, Response } from "express";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { NotificationsService } from "../service/notifications.service.js";
import type { ListNotificationsQuery } from "../validators/notifications.validators.js";

export class NotificationsController {
  constructor(private readonly service = new NotificationsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(
      actorOf(req),
      req.validated.query as ListNotificationsQuery,
    );
    res.status(200).json({ data: items, meta });
  };

  markRead = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    res.status(200).json({ data: await this.service.markRead(actorOf(req), id, contextOf(req)) });
  };

  markAllRead = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.markAllRead(actorOf(req)) });
  };
}
